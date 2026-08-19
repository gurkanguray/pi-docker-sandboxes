import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthMode, CredentialService } from "./config.ts";
import { resolveAvailableServices } from "./providers.ts";

export const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;

export interface SyncHostProviderSecretsOptions {
	mode?: AuthMode;
	services?: readonly CredentialService[];
	hostProviderIds?: readonly string[];
	proxyIds?: readonly string[];
	oauthHostIds?: ReadonlySet<string>;
	configured: ReadonlySet<string>;
	noHostAuth?: boolean;
	printApiKey?: (id: string) => Promise<string | undefined>;
	setSecret?: (id: string, key: string) => Promise<void>;
}

export interface SyncHostProviderSecretsResult {
	requested: string[];
	synced: string[];
	warnings: string[];
}

export function isHostSecretValue(value: string): boolean {
	return value.length > 0 && !/[\0\r\n]/.test(value) && value.trim() === value;
}

export function isCopyEligibleOAuthEntry(entry: unknown): entry is Record<
	string,
	unknown
> & {
	type: "oauth";
	access: string;
	refresh: string;
} {
	return (
		!!entry &&
		typeof entry === "object" &&
		!Array.isArray(entry) &&
		(entry as Record<string, unknown>).type === "oauth" &&
		typeof (entry as Record<string, unknown>).access === "string" &&
		typeof (entry as Record<string, unknown>).refresh === "string"
	);
}

export function classifyHostProviders(
	hostProviderIds: readonly string[],
	proxyIds: readonly string[],
	oauthIds: ReadonlySet<string>,
): { requested: string[]; oauth: string[]; unmatched: string[] } {
	const requested: string[] = [];
	const oauth: string[] = [];
	const unmatched: string[] = [];
	const seen = new Set<string>();
	for (const id of hostProviderIds) {
		if (oauthIds.has(id)) {
			oauth.push(id);
			continue;
		}
		const serviceId = id;
		if (!SERVICE_ID.test(serviceId) || seen.has(serviceId)) {
			if (!SERVICE_ID.test(id)) unmatched.push(id);
			continue;
		}
		const resolved = resolveAvailableServices(proxyIds, [serviceId]);
		if (resolved.services.length === 1) {
			seen.add(serviceId);
			requested.push(serviceId);
		} else unmatched.push(id);
	}
	return { requested, oauth, unmatched };
}

function defaultAuthPath(): string {
	return join(homedir(), ".pi", "agent", "auth.json");
}

async function readHostAuthEntry(
	id: string,
	authPath = defaultAuthPath(),
): Promise<Record<string, unknown> | undefined> {
	if (!SERVICE_ID.test(id)) return undefined;
	try {
		const parsed = JSON.parse(await readFile(authPath, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
			return undefined;
		const entry = (parsed as Record<string, unknown>)[id];
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			return undefined;
		return entry as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

export async function listHostOAuthProviderIds(
	hostProviderIds: readonly string[],
	authPath = defaultAuthPath(),
): Promise<Set<string>> {
	const oauthIds = new Set<string>();
	for (const id of hostProviderIds) {
		const entry = await readHostAuthEntry(id, authPath);
		if (isCopyEligibleOAuthEntry(entry)) oauthIds.add(id);
	}
	return oauthIds;
}

export async function printHostApiKey(
	id: string,
	authPath = defaultAuthPath(),
): Promise<string | undefined> {
	const entry = await readHostAuthEntry(id, authPath);
	const key = entry?.key;
	return typeof key === "string" && isHostSecretValue(key) ? key : undefined;
}

export async function listHostProviderIds(
	settingsPath = join(homedir(), ".pi", "agent", "settings.json"),
): Promise<string[]> {
	try {
		const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as {
			enabledModels?: unknown;
			defaultProvider?: unknown;
		};
		const ids = new Set<string>();
		if (typeof parsed.defaultProvider === "string")
			ids.add(parsed.defaultProvider);
		if (Array.isArray(parsed.enabledModels)) {
			for (const entry of parsed.enabledModels) {
				if (typeof entry !== "string") continue;
				const provider = entry.split("/")[0];
				if (provider) ids.add(provider);
			}
		}
		return [...ids];
	} catch {
		return [];
	}
}

export async function syncHostProviderSecrets(
	options: SyncHostProviderSecretsOptions,
): Promise<SyncHostProviderSecretsResult> {
	if (options.mode !== "proxy" || options.noHostAuth)
		return { requested: [], synced: [], warnings: [] };
	const warnings: string[] = [];
	const synced: string[] = [];
	let requested = (options.services ?? []).map((service) => service.id);
	if (options.hostProviderIds && options.proxyIds) {
		const classified = classifyHostProviders(
			options.hostProviderIds,
			options.proxyIds,
			options.oauthHostIds ?? new Set(),
		);
		requested = classified.requested;
		for (const id of classified.unmatched)
			warnings.push(`Host provider ${id} has no sandbox credential service`);
	}
	const printApiKey = options.printApiKey ?? printHostApiKey;
	const setSecret = options.setSecret;
	if (!setSecret) return { requested, synced, warnings };
	const services =
		options.services ??
		resolveAvailableServices(options.proxyIds ?? requested, requested).services;
	const byId = new Map(services.map((service) => [service.id, service]));
	const hostIdsForService = (serviceId: string): string[] => {
		const ids = (options.hostProviderIds ?? []).filter(
			(id) => id === serviceId,
		);
		return ids.length > 0 ? ids : [serviceId];
	};
	for (const id of requested) {
		if (!SERVICE_ID.test(id) || options.configured.has(id) || !byId.has(id))
			continue;
		let key: string | undefined;
		try {
			for (const hostId of hostIdsForService(id))
				if ((key = await printApiKey(hostId)) !== undefined) break;
		} catch {
			warnings.push(`Host credential for ${id} could not be read`);
			continue;
		}
		if (key === undefined) {
			warnings.push(
				`Host Pi has no API key for ${id}. Run: sbx secret set ${id}`,
			);
			continue;
		}
		if (!isHostSecretValue(key)) {
			warnings.push(
				`Host credential for ${id} is not a usable single-line secret`,
			);
			continue;
		}
		try {
			warnings.push(
				`Host credential for ${id} persists in SBX secret storage until explicitly removed`,
			);
			await setSecret(id, key);
			synced.push(id);
		} catch {
			warnings.push(`Could not store host credential for ${id} in sbx`);
		}
	}
	return { requested, synced, warnings };
}
