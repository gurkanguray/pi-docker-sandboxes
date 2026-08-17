import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertDigestReference } from "./image-lock.ts";

export type SecurityProfile = "hardened" | "development";
export type SyncProfile = "clean" | "mirror" | "custom";
export interface SyncOptions {
	settings: boolean;
	models: boolean;
	packages: boolean;
	skills: boolean;
	prompts: boolean;
	themes: boolean;
	extensions: boolean;
	sessions: "managed" | "sandbox";
}
export interface CredentialService {
	id: string;
	envVar: string;
	domains: string[];
	headerName: string;
	valueFormat: string;
}

export interface DockerSandboxConfig {
	version: 1;
	enabled: boolean;
	profile: SecurityProfile;
	syncProfile: SyncProfile;
	sync: SyncOptions;
	sandbox: {
		name?: string;
		keep: boolean;
		dockerEngine: boolean;
		image?: string;
	};
	providers: string[];
	network: { allow: string[]; deny: string[] };
	export: { onExit: "prompt" | "always" | "never"; directory: string };
}

export const DEFAULT_CONFIG: DockerSandboxConfig = {
	version: 1,
	enabled: true,
	profile: "development",
	syncProfile: "custom",
	sync: {
		settings: true,
		models: true,
		packages: false,
		skills: false,
		prompts: false,
		themes: false,
		extensions: false,
		sessions: "managed",
	},
	sandbox: { keep: false, dockerEngine: true },
	providers: [],
	network: { allow: [], deny: [] },
	export: { onExit: "prompt", directory: ".git/pi-docker-sandbox/patches" },
};

const ROOT_KEYS = new Set([
	"version",
	"enabled",
	"profile",
	"syncProfile",
	"sync",
	"sandbox",
	"providers",
	"network",
	"export",
]);
const SANDBOX_KEYS = new Set(["name", "keep", "dockerEngine", "image"]);
const NETWORK_KEYS = new Set(["allow", "deny"]);
const SYNC_KEYS = new Set([
	"settings",
	"models",
	"packages",
	"skills",
	"prompts",
	"themes",
	"extensions",
	"sessions",
]);
const EXPORT_KEYS = new Set(["onExit", "directory"]);
const PROFILES = new Set<SecurityProfile>(["hardened", "development"]);
const SYNC_PROFILES = new Set<SyncProfile>(["clean", "mirror", "custom"]);

function object(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${path} must be an object`);
	return value as Record<string, unknown>;
}

function rejectUnknown(
	value: Record<string, unknown>,
	allowed: Set<string>,
	path: string,
): void {
	const key = Object.keys(value).find((candidate) => !allowed.has(candidate));
	if (key) throw new TypeError(`Unknown configuration field: ${path}${key}`);
}

function boolean(value: unknown, path: string): boolean {
	if (typeof value !== "boolean")
		throw new TypeError(`${path} must be a boolean`);
	return value;
}

function string(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new TypeError(`${path} must be a non-empty string`);
	if (value.includes("\0") || value.includes("\n") || value.includes("\r"))
		throw new TypeError(`${path} contains forbidden control characters`);
	return value;
}

function strings(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
	return [
		...new Set(value.map((entry, index) => string(entry, `${path}[${index}]`))),
	];
}

export function validateName(name: string): string {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9.+-]{0,62}[A-Za-z0-9]$/.test(name) &&
		!/^[A-Za-z0-9]$/.test(name)
	) {
		throw new TypeError(`Invalid sandbox name: ${JSON.stringify(name)}`);
	}
	return name;
}

export function validateDomain(domain: string, allowWildcard = true): string {
	if (
		domain.includes("://") ||
		domain.includes("@") ||
		domain.includes("/") ||
		/[\s\0]/.test(domain)
	) {
		throw new TypeError(`Invalid network domain: ${JSON.stringify(domain)}`);
	}
	const [host, port] = domain.split(":");
	if (!host || (port !== undefined && !/^\d{1,5}$/.test(port)))
		throw new TypeError(`Invalid network domain: ${JSON.stringify(domain)}`);
	if (port !== undefined && Number(port) > 65535)
		throw new TypeError(`Invalid network port: ${JSON.stringify(port)}`);
	const labels = host.replace(/^\*\./, "").split(".");
	if (
		(!allowWildcard && host.startsWith("*.")) ||
		labels.some(
			(label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
		)
	) {
		throw new TypeError(`Invalid network domain: ${JSON.stringify(domain)}`);
	}
	return domain.toLowerCase();
}

export type ConfigOverride = Partial<
	Omit<DockerSandboxConfig, "sandbox" | "sync" | "network" | "export">
> & {
	sandbox?: Partial<DockerSandboxConfig["sandbox"]>;
	sync?: Partial<DockerSandboxConfig["sync"]>;
	network?: Partial<DockerSandboxConfig["network"]>;
	export?: Partial<DockerSandboxConfig["export"]>;
};

export function parseConfig(value: unknown, source = "config"): ConfigOverride {
	const input = object(value, source);
	rejectUnknown(input, ROOT_KEYS, `${source}.`);
	const output: ConfigOverride = {};
	if (input.version !== undefined) {
		if (input.version !== 1) throw new TypeError(`${source}.version must be 1`);
		output.version = 1;
	}
	if (input.enabled !== undefined)
		output.enabled = boolean(input.enabled, `${source}.enabled`);
	if (input.profile !== undefined) {
		const value = string(input.profile, `${source}.profile`) as SecurityProfile;
		if (!PROFILES.has(value))
			throw new TypeError(`${source}.profile is unsupported`);
		output.profile = value;
	}
	if (input.syncProfile !== undefined) {
		const value = string(
			input.syncProfile,
			`${source}.syncProfile`,
		) as SyncProfile;
		if (!SYNC_PROFILES.has(value))
			throw new TypeError(`${source}.syncProfile is unsupported`);
		output.syncProfile = value;
	}
	if (input.sync !== undefined) {
		const sync = object(input.sync, `${source}.sync`);
		rejectUnknown(sync, SYNC_KEYS, `${source}.sync.`);
		output.sync = {};
		for (const key of [
			"settings",
			"models",
			"packages",
			"skills",
			"prompts",
			"themes",
			"extensions",
		] as const) {
			if (sync[key] !== undefined)
				output.sync[key] = boolean(sync[key], `${source}.sync.${key}`);
		}
		if (sync.sessions !== undefined) {
			const value = string(sync.sessions, `${source}.sync.sessions`);
			if (value !== "managed" && value !== "sandbox")
				throw new TypeError(`${source}.sync.sessions is unsupported`);
			output.sync.sessions = value;
		}
	}
	if (input.providers !== undefined)
		output.providers = strings(input.providers, `${source}.providers`);
	if (input.sandbox !== undefined) {
		const sandbox = object(input.sandbox, `${source}.sandbox`);
		rejectUnknown(sandbox, SANDBOX_KEYS, `${source}.sandbox.`);
		output.sandbox = {};
		if (sandbox.name !== undefined)
			output.sandbox.name = validateName(
				string(sandbox.name, `${source}.sandbox.name`),
			);
		if (sandbox.keep !== undefined)
			output.sandbox.keep = boolean(sandbox.keep, `${source}.sandbox.keep`);
		if (sandbox.dockerEngine !== undefined)
			output.sandbox.dockerEngine = boolean(
				sandbox.dockerEngine,
				`${source}.sandbox.dockerEngine`,
			);
		if (sandbox.image !== undefined)
			output.sandbox.image = assertDigestReference(
				string(sandbox.image, `${source}.sandbox.image`),
				`${source}.sandbox.image`,
			);
	}
	if (input.network !== undefined) {
		const network = object(input.network, `${source}.network`);
		rejectUnknown(network, NETWORK_KEYS, `${source}.network.`);
		output.network = {};
		if (network.allow !== undefined)
			output.network.allow = strings(
				network.allow,
				`${source}.network.allow`,
			).map((domain) => validateDomain(domain));
		if (network.deny !== undefined)
			output.network.deny = strings(network.deny, `${source}.network.deny`).map(
				(domain) => validateDomain(domain),
			);
	}
	if (input.export !== undefined) {
		const exportConfig = object(input.export, `${source}.export`);
		rejectUnknown(exportConfig, EXPORT_KEYS, `${source}.export.`);
		output.export = {};
		if (exportConfig.onExit !== undefined) {
			const value = string(exportConfig.onExit, `${source}.export.onExit`);
			if (value !== "prompt" && value !== "always" && value !== "never")
				throw new TypeError(`${source}.export.onExit is unsupported`);
			output.export.onExit = value;
		}
		if (exportConfig.directory !== undefined) {
			const value = string(
				exportConfig.directory,
				`${source}.export.directory`,
			);
			if (value.split(/[\\/]/).includes(".."))
				throw new TypeError(
					`${source}.export.directory may not traverse parent directories`,
				);
			output.export.directory = value;
		}
	}
	return output;
}

export function mergeConfig(...values: ConfigOverride[]): DockerSandboxConfig {
	return values.reduce<DockerSandboxConfig>(
		(result, value) => ({
			...result,
			...value,
			sandbox: { ...result.sandbox, ...value.sandbox },
			sync: { ...result.sync, ...value.sync },
			network: { ...result.network, ...value.network },
			export: { ...result.export, ...value.export },
		}),
		structuredClone(DEFAULT_CONFIG),
	);
}

export interface LoadedConfig {
	value: DockerSandboxConfig;
	warnings: string[];
}

async function readConfig(
	path: string,
): Promise<{ value: ConfigOverride; warnings: string[] }> {
	try {
		const { migrateConfig } = await import("./migration.ts");
		const migrated = migrateConfig(
			JSON.parse(await readFile(path, "utf8")),
			path,
		);
		return { value: migrated.value, warnings: migrated.warnings };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { value: {}, warnings: [] };
		throw error;
	}
}

export async function loadConfigResult(
	cwd: string,
	options: { home?: string; projectTrusted?: boolean; configDir?: string } = {},
): Promise<LoadedConfig> {
	const home = options.home ?? homedir();
	const global = await readConfig(
		join(home, ".pi", "agent", "docker-sandboxes.json"),
	);
	const project =
		options.projectTrusted === true
			? await readConfig(
					join(cwd, options.configDir ?? ".pi", "docker-sandboxes.json"),
				)
			: { value: {}, warnings: [] };
	return {
		value: mergeConfig(global.value, project.value),
		warnings: [...global.warnings, ...project.warnings],
	};
}

export async function loadConfig(
	cwd: string,
	options: { home?: string; projectTrusted?: boolean; configDir?: string } = {},
): Promise<DockerSandboxConfig> {
	return (await loadConfigResult(cwd, options)).value;
}
