import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseConfig, type ConfigOverride } from "./config.ts";
import { assertDigestReference } from "./image-lock.ts";
import { assertLocalTemplateAttestation } from "./local-template.ts";
import type {
	SandboxImageAttestation,
	SandboxState,
} from "./state-schema.ts";

export interface Migration<T> {
	value: T;
	warnings: string[];
	sourceVersion: number;
	migrated: boolean;
}

export function migrateConfig(
	value: unknown,
	source: string,
): Migration<ConfigOverride> {
	const parsed = parseConfig(value, source);
	const sourceVersion = parsed.version ?? 2;
	return {
		value: structuredClone(parsed),
		warnings: [],
		sourceVersion,
		migrated: false,
	};
}

function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${path} must contain a state object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new TypeError(`${field} must be a non-empty string`);
	return value;
}

export function migrateSandboxState(
	value: unknown,
	path: string,
): Migration<SandboxState> {
	const input = record(value, path);
	const allowed = new Set([
		"version",
		"name",
		"hostBaseCommit",
		"hostBranch",
		"hostRepoIdentity",
		"hostRoot",
		"workspaceMode",
		"createdAt",
		"imageAttestation",
	]);
	const preserve = `preserve ${path} before recovery`;
	if (input.version !== 1)
		throw new TypeError(
			`${path} has unsupported state version ${String(input.version)}; ${preserve}`,
		);
	const unknown = Object.keys(input).find((key) => !allowed.has(key));
	if (unknown)
		throw new TypeError(
			`${path} has unknown state field ${unknown}; ${preserve}`,
		);
	const workspaceMode = requiredString(
		input.workspaceMode,
		`${path}.workspaceMode`,
	);
	if (workspaceMode !== "clone")
		throw new TypeError(`${path}.workspaceMode is unsupported; ${preserve}`);
	let imageAttestation: SandboxImageAttestation | undefined;
	if (input.imageAttestation !== undefined) {
		const attestation = record(
			input.imageAttestation,
			`${path}.imageAttestation`,
		);
		const nestedAllowed = new Set(["status", "image", "templateStoreId"]);
		const nestedUnknown = Object.keys(attestation).find(
			(key) => !nestedAllowed.has(key),
		);
		if (nestedUnknown)
			throw new TypeError(
				`${path}.imageAttestation has unknown field ${nestedUnknown}; ${preserve}`,
			);
		if (attestation.status !== "pending" && attestation.status !== "verified")
			throw new TypeError(`${path}.imageAttestation.status is unsupported`);
		const image = requiredString(
			attestation.image,
			`${path}.imageAttestation.image`,
		);
		const templateStoreId = attestation.templateStoreId;
		if (templateStoreId === undefined)
			assertDigestReference(image, `${path}.imageAttestation.image`);
		else {
			requiredString(
				templateStoreId,
				`${path}.imageAttestation.templateStoreId`,
			);
			assertLocalTemplateAttestation(image, templateStoreId);
		}
		imageAttestation = {
			status: attestation.status,
			image,
			...(typeof templateStoreId === "string" ? { templateStoreId } : {}),
		};
	}
	return {
		value: {
			version: 1,
			name: requiredString(input.name, `${path}.name`),
			hostBaseCommit: requiredString(
				input.hostBaseCommit,
				`${path}.hostBaseCommit`,
			),
			hostBranch: requiredString(input.hostBranch, `${path}.hostBranch`),
			hostRepoIdentity: requiredString(
				input.hostRepoIdentity,
				`${path}.hostRepoIdentity`,
			),
			hostRoot: requiredString(input.hostRoot, `${path}.hostRoot`),
			workspaceMode,
			createdAt: requiredString(input.createdAt, `${path}.createdAt`),
			...(imageAttestation ? { imageAttestation } : {}),
		},
		warnings: [],
		sourceVersion: 1,
		migrated: false,
	};
}

type FileIdentity = { dev: number | bigint; ino: number | bigint };

/** @internal */
export function sameFileIdentity(
	left: FileIdentity,
	right: FileIdentity,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function atomicWriteFlags(): {
	directory: number;
	temporary: number;
} {
	for (const name of [
		"O_DIRECTORY",
		"O_NOFOLLOW",
		"O_CREAT",
		"O_EXCL",
		"O_WRONLY",
	] as const) {
		if (typeof constants[name] !== "number")
			throw new Error(
				`Atomic state writes are unsupported: ${name} unavailable`,
			);
	}
	return {
		directory:
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		temporary:
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_WRONLY |
			constants.O_NOFOLLOW,
	};
}

export async function writeJsonAtomic(
	path: string,
	value: unknown,
	options: {
		directoryPrepared?: boolean;
		validateDirectory?: () => Promise<void>;
	} = {},
): Promise<void> {
	const flags = atomicWriteFlags();
	const directory = dirname(path);
	const temporary = join(directory, `${basename(path)}.${process.pid}.tmp`);
	if (!options.directoryPrepared)
		await mkdir(directory, { recursive: true, mode: 0o700 });
	await options.validateDirectory?.();
	const directoryHandle = await open(directory, flags.directory);
	let file: Awaited<ReturnType<typeof open>> | undefined;
	let identity: FileIdentity | undefined;
	let created = false;
	try {
		identity = await directoryHandle.stat();
		const openedIdentity = identity;
		const validateDirectory = async (): Promise<void> => {
			await options.validateDirectory?.();
			if (!sameFileIdentity(openedIdentity, await lstat(directory)))
				throw new Error("State directory changed during atomic write");
		};
		await validateDirectory();
		await directoryHandle.chmod(0o700);
		const content = `${JSON.stringify(value, null, 2)}\n`;
		await validateDirectory();
		file = await open(temporary, flags.temporary, 0o600);
		created = true;
		await validateDirectory();
		await file.writeFile(content);
		await file.sync();
		await file.close();
		file = undefined;
		await validateDirectory();
		await rename(temporary, path);
		created = false;
		await validateDirectory();
	} catch (error) {
		await file?.close().catch(() => undefined);
		if (created && identity) {
			const unchanged = await lstat(directory)
				.then((current) => sameFileIdentity(identity!, current))
				.catch(() => false);
			if (unchanged)
				await rm(temporary, { force: true }).catch(() => undefined);
		}
		throw error;
	} finally {
		await directoryHandle.close();
	}
}
