import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseConfig, type ConfigOverride } from "./config.ts";
import {
	parseSandboxState,
	parseSandboxStateV2,
	type SandboxStateV2,
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

export interface SandboxMigrationEvidence {
	exists: true;
	inspectedImage: string;
	expectedImage: string;
	runtimeSchema: number;
	packageVersion: string;
	templateStoreId?: string;
	migratedAt?: string;
}

export function migrateSandboxState(
	value: unknown,
	path: string,
	evidence?: SandboxMigrationEvidence,
): Migration<SandboxStateV2> {
	const preserve = `preserve ${path} before recovery`;
	let parsed;
	try {
		parsed = parseSandboxState(value, path);
	} catch (cause) {
		throw new TypeError(
			`${cause instanceof Error ? cause.message : String(cause)}; ${preserve}`,
			{ cause },
		);
	}
	if (parsed.version === 2)
		return {
			value: parsed,
			warnings: [],
			sourceVersion: 2,
			migrated: false,
		};
	if (
		!evidence ||
		evidence.inspectedImage !== evidence.expectedImage ||
		(parsed.imageAttestation &&
			parsed.imageAttestation.image !== evidence.expectedImage)
	)
		throw new TypeError(
			`${path} version 1 requires matching daemon and image evidence; ${preserve}`,
		);
	const migratedAt = evidence.migratedAt ?? new Date().toISOString();
	const migrated = parseSandboxStateV2(
		{
			version: 2,
			phase: "ready",
			name: parsed.name,
			hostBaseCommit: parsed.hostBaseCommit,
			hostBranch: parsed.hostBranch,
			hostRepoIdentity: parsed.hostRepoIdentity,
			hostWorktreeIdentity: parsed.hostRoot,
			hostRoot: parsed.hostRoot,
			workspaceMode: "clone",
			createdAt: parsed.createdAt,
			updatedAt: migratedAt,
			runtimeImage: evidence.expectedImage,
			runtimeSchema: evidence.runtimeSchema,
			packageVersion: evidence.packageVersion,
			imageAttestation: {
				status: "verified",
				image: evidence.expectedImage,
				...(evidence.templateStoreId
					? { templateStoreId: evidence.templateStoreId }
					: {}),
			},
			...(evidence.templateStoreId
				? { templateStoreId: evidence.templateStoreId }
				: {}),
		},
		path,
	);
	return {
		value: migrated,
		warnings: ["Migrated sandbox lifecycle state from version 1 after daemon and image reconciliation"],
		sourceVersion: 1,
		migrated: true,
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
		await directoryHandle.sync();
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
