import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { SessionRetention } from "./config.ts";
import { SbxCommandError, type SbxClient } from "./sbx/client.ts";

const SANDBOX_SESSIONS = "/home/agent/.pi/agent/sessions";
const BACKUP_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const STAGING_OWNER_SUFFIX = ".owner.json";

function isBackupTimestamp(value: string): boolean {
	if (!BACKUP_TIMESTAMP.test(value)) return false;
	const iso = `${value.slice(0, 13)}:${value.slice(14, 16)}:${value.slice(17, 19)}.${value.slice(20, 23)}Z`;
	return !Number.isNaN(Date.parse(iso)) && new Date(iso).toISOString() === iso;
}

export function sessionBackupRoot(
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
): string {
	const repositoryId = createHash("sha256")
		.update(repositoryIdentity)
		.digest("hex")
		.slice(0, 16);
	return join(
		agentDir,
		"docker-sandboxes",
		"sessions",
		repositoryId,
		sandboxName,
	);
}

type DirectoryIdentity = { dev: number | bigint; ino: number | bigint };

function sameIdentity(
	left: DirectoryIdentity,
	right: DirectoryIdentity,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function prepareSessionBackupRoot(
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
	create: boolean,
): Promise<{ root: string; validate: () => Promise<void> } | undefined> {
	const root = sessionBackupRoot(agentDir, repositoryIdentity, sandboxName);
	let canonicalAgentDir: string;
	try {
		canonicalAgentDir = await realpath(agentDir);
	} catch (cause) {
		if (!create && (cause as NodeJS.ErrnoException).code === "ENOENT")
			return undefined;
		throw cause;
	}
	const paths = [
		agentDir,
		join(agentDir, "docker-sandboxes"),
		join(agentDir, "docker-sandboxes", "sessions"),
		dirname(root),
		root,
	];
	const expectedPaths = paths.map((path, index) =>
		index === 0
			? canonicalAgentDir
			: join(canonicalAgentDir, relative(agentDir, path)),
	);
	const identities: DirectoryIdentity[] = [];
	const validate = async (): Promise<void> => {
		for (let index = 0; index < identities.length; index++) {
			const current = await lstat(paths[index]!);
			if (
				!current.isDirectory() ||
				current.isSymbolicLink() ||
				!sameIdentity(identities[index]!, current) ||
				(await realpath(paths[index]!)) !== expectedPaths[index]
			)
				throw new Error(
					"Managed session path ancestors must be stable directories without symbolic links",
				);
		}
	};
	for (let index = 0; index < paths.length; index++) {
		await validate();
		const path = paths[index]!;
		if (index > 0 && create)
			await mkdir(path, { mode: 0o700 }).catch((cause) => {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
			});
		let current;
		try {
			current = await lstat(path);
		} catch (cause) {
			if (!create && (cause as NodeJS.ErrnoException).code === "ENOENT")
				return undefined;
			throw cause;
		}
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			(await realpath(path)) !== expectedPaths[index]
		)
			throw new Error(
				"Managed session path ancestors must be real directories without symbolic links",
			);
		identities.push(current);
	}
	await validate();
	return { root, validate };
}

export interface SessionBackup {
	id: string;
	path: string;
	createdAt: string;
	bytes: number;
}

function backupDate(id: string): Date {
	return new Date(
		`${id.slice(0, 13)}:${id.slice(14, 16)}:${id.slice(17, 19)}.${id.slice(20, 23)}Z`,
	);
}

async function directoryBytes(path: string): Promise<number> {
	let bytes = 0;
	for (const entry of await readdir(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		const metadata = await lstat(child);
		if (metadata.isSymbolicLink()) {
			bytes += metadata.size;
			continue;
		}
		if (metadata.isDirectory()) bytes += await directoryBytes(child);
		else if (metadata.isFile()) bytes += metadata.size;
	}
	return bytes;
}

async function syncParent(path: string): Promise<void> {
	const parent = await open(
		path,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

function processAbsent(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === "ESRCH";
	}
}

export async function reconcileSessionStaging(
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
): Promise<string[]> {
	const prepared = await prepareSessionBackupRoot(
		agentDir,
		repositoryIdentity,
		sandboxName,
		false,
	);
	if (!prepared) return [];
	await prepared.validate();
	const entries = await readdir(prepared.root);
	const removed: string[] = [];
	for (const entry of entries.sort()) {
		if (!entry.startsWith(".partial-") || entry.endsWith(STAGING_OWNER_SUFFIX))
			continue;
		const partial = join(prepared.root, entry);
		const ownerPath = `${partial}${STAGING_OWNER_SUFFIX}`;
		let owner: unknown;
		try {
			const metadata = await lstat(ownerPath);
			if (
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				metadata.nlink !== 1
			)
				continue;
			owner = JSON.parse(await readFile(ownerPath, "utf8"));
		} catch {
			continue;
		}
		const record = owner as Record<string, unknown>;
		const uid =
			typeof process.getuid === "function" ? process.getuid() : undefined;
		if (
			record.schema !== 1 ||
			record.kind !== "pi-dsbx-session-staging" ||
			record.path !== basename(partial) ||
			!Number.isSafeInteger(record.pid) ||
			(uid !== undefined && record.uid !== uid) ||
			!processAbsent(record.pid as number)
		)
			continue;
		await prepared.validate();
		const partialMetadata = await lstat(partial);
		if (!partialMetadata.isDirectory() || partialMetadata.isSymbolicLink())
			continue;
		await rm(partial, { recursive: true });
		await unlink(ownerPath);
		await syncParent(prepared.root);
		removed.push(partial);
	}
	return removed;
}

export async function listSessionBackups(
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
): Promise<SessionBackup[]> {
	const prepared = await prepareSessionBackupRoot(
		agentDir,
		repositoryIdentity,
		sandboxName,
		false,
	);
	if (!prepared) return [];
	await prepared.validate();
	const entries = (await readdir(prepared.root))
		.filter(isBackupTimestamp)
		.sort();
	const backups: SessionBackup[] = [];
	for (const id of entries) {
		const path = join(prepared.root, id);
		const [backup, sessions] = await Promise.all([
			lstat(path),
			lstat(join(path, "sessions")),
		]);
		if (
			backup.isSymbolicLink() ||
			!backup.isDirectory() ||
			sessions.isSymbolicLink() ||
			!sessions.isDirectory()
		)
			throw new Error(`Managed session backup ${id} is invalid`);
		await prepared.validate();
		backups.push({
			id,
			path,
			createdAt: backupDate(id).toISOString(),
			bytes: await directoryBytes(path),
		});
	}
	return backups;
}

export async function deleteSessionBackup(
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
	id: string,
): Promise<void> {
	if (!isBackupTimestamp(id)) throw new TypeError("Invalid session backup id");
	const prepared = await prepareSessionBackupRoot(
		agentDir,
		repositoryIdentity,
		sandboxName,
		false,
	);
	if (!prepared) throw new Error(`Session backup ${id} does not exist`);
	const source = join(prepared.root, id);
	const metadata = await lstat(source);
	if (!metadata.isDirectory() || metadata.isSymbolicLink())
		throw new Error(`Managed session backup ${id} is invalid`);
	const staging = join(
		prepared.root,
		`.deleting-${id}-${randomBytes(4).toString("hex")}`,
	);
	await prepared.validate();
	await rename(source, staging);
	await syncParent(prepared.root);
	await rm(staging, { recursive: true });
	await syncParent(prepared.root);
}

export async function pruneSessionBackups(
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
	retention: SessionRetention,
	now = new Date(),
): Promise<string[]> {
	const backups = await listSessionBackups(
		agentDir,
		repositoryIdentity,
		sandboxName,
	);
	if (backups.length <= 1) return [];
	const latest = backups.at(-1)!;
	const retained = [...backups];
	const removed: string[] = [];
	const remove = (backup: SessionBackup): void => {
		if (backup.id === latest.id || removed.includes(backup.id)) return;
		removed.push(backup.id);
		retained.splice(
			retained.findIndex((entry) => entry.id === backup.id),
			1,
		);
	};
	const cutoff = now.getTime() - retention.maxAgeDays * 86_400_000;
	for (const backup of retained.slice())
		if (backupDate(backup.id).getTime() < cutoff) remove(backup);
	while (retained.length > Math.max(1, retention.maxCount))
		remove(retained[0]!);
	while (
		retained.length > 1 &&
		retained
			.filter((backup) => backup.id !== latest.id)
			.reduce((total, backup) => total + backup.bytes, 0) > retention.maxBytes
	)
		remove(retained[0]!);
	for (const id of removed)
		await deleteSessionBackup(agentDir, repositoryIdentity, sandboxName, id);
	return removed;
}

export async function backupSessions(
	client: SbxClient,
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
	retention?: SessionRetention,
): Promise<string | undefined> {
	try {
		await client.exec(sandboxName, ["test", "-e", SANDBOX_SESSIONS], {
			user: "agent",
		});
	} catch (cause) {
		if (cause instanceof SbxCommandError && cause.exitCode === 1)
			return undefined;
		throw cause;
	}
	await client.exec(sandboxName, ["test", "-d", SANDBOX_SESSIONS], {
		user: "agent",
	});
	const prepared = await prepareSessionBackupRoot(
		agentDir,
		repositoryIdentity,
		sandboxName,
		true,
	);
	const root = prepared!.root;
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const destination = join(root, timestamp);
	await prepared!.validate();
	await chmod(root, 0o700);
	await prepared!.validate();
	const partial = await mkdtemp(join(root, `.partial-${timestamp}-`));
	const ownerPath = `${partial}${STAGING_OWNER_SUFFIX}`;
	await chmod(partial, 0o700);
	await writeFile(
		ownerPath,
		`${JSON.stringify({
			schema: 1,
			kind: "pi-dsbx-session-staging",
			path: basename(partial),
			pid: process.pid,
			...(typeof process.getuid === "function"
				? { uid: process.getuid() }
				: {}),
		})}\n`,
		{ flag: "wx", mode: 0o600 },
	);
	await syncParent(root);
	try {
		await prepared!.validate();
		await client.copyFrom(sandboxName, SANDBOX_SESSIONS, partial);
		await prepared!.validate();
		await chmod(partial, 0o700);
		await prepared!.validate();
		await rename(partial, destination);
		await prepared!.validate();
		await syncParent(root);
		await unlink(ownerPath);
		await syncParent(root);
		if (retention)
			await pruneSessionBackups(
				agentDir,
				repositoryIdentity,
				sandboxName,
				retention,
			);
		return destination;
	} catch (cause) {
		try {
			await prepared!.validate();
			await rm(partial, { recursive: true, force: true });
			await unlink(ownerPath).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
			await syncParent(root);
		} catch (cleanupError) {
			void cleanupError;
		}
		throw cause;
	}
}

export interface SessionRestoreResult {
	backupDirectory: string;
	warnings: string[];
}

export async function restoreSessions(
	client: SbxClient,
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
	backupId?: string,
): Promise<SessionRestoreResult | undefined> {
	const prepared = await prepareSessionBackupRoot(
		agentDir,
		repositoryIdentity,
		sandboxName,
		false,
	);
	if (!prepared) return undefined;
	const root = prepared.root;
	await prepared.validate();
	const entries = await readdir(root);
	await prepared.validate();
	if (backupId !== undefined && !isBackupTimestamp(backupId))
		throw new TypeError("Invalid session backup id");
	const latest = backupId ?? entries.filter(isBackupTimestamp).sort().at(-1);
	if (!latest) return undefined;
	if (!entries.includes(latest))
		throw new Error(`Session backup ${latest} does not exist`);
	const backupDirectory = join(root, latest);
	const sessions = join(backupDirectory, "sessions");
	const selected = await Promise.all(
		(
			[
				[backupDirectory, "backup"],
				[sessions, "sessions"],
			] as const
		).map(async ([path, label]) => {
			const metadata = await lstat(path);
			if (metadata.isSymbolicLink() || !metadata.isDirectory())
				throw new TypeError(
					`Managed session ${label} must be a directory, not a symbolic link`,
				);
			return { path, label, metadata };
		}),
	);
	const validateSelected = async (): Promise<void> => {
		await prepared.validate();
		for (const { path, label, metadata } of selected) {
			const current = await lstat(path);
			if (
				current.isSymbolicLink() ||
				!current.isDirectory() ||
				!sameIdentity(metadata, current)
			)
				throw new TypeError(
					`Managed session ${label} directory identity changed`,
				);
		}
	};
	await validateSelected();
	const token = randomBytes(12).toString("hex");
	const staging = `/home/agent/.pi/agent/.sessions-restore-${token}`;
	const rollback = `/home/agent/.pi/agent/.sessions-rollback-${token}`;
	const marker = `${rollback}.absent`;
	const shell = (
		script: readonly string[],
		...paths: string[]
	): Promise<unknown> =>
		client.exec(
			sandboxName,
			["sh", "-ceu", script.join("\n"), "pi-dsbx-session-restore", ...paths],
			{ user: "root" },
		);
	try {
		await client.copyTo(sandboxName, sessions, staging);
		await validateSelected();
	} catch (cause) {
		try {
			await shell(
				[
					'staged="$1"',
					'rm -rf -- "$staged"',
					'test ! -e "$staged" && test ! -L "$staged"',
				],
				staging,
			);
		} catch (cleanupCause) {
			throw new AggregateError(
				[cause, cleanupCause],
				"Session restore staging failed and cleanup could not complete",
			);
		}
		throw cause;
	}
	try {
		await shell(
			[
				'target="$1"; staged="$2"; rollback="$3"; marker="$4"',
				'test -d "$staged" && test ! -L "$staged"',
				'test ! -e "$rollback" && test ! -L "$rollback" && test ! -e "$marker" && test ! -L "$marker"',
				'if test -e "$target" || test -L "$target"; then test -d "$target" && test ! -L "$target"; mv -- "$target" "$rollback"; else : > "$marker"; fi',
				'mv -- "$staged" "$target"',
			],
			SANDBOX_SESSIONS,
			staging,
			rollback,
			marker,
		);
		await shell(
			['target="$1"', 'test -d "$target" && test ! -L "$target"'],
			SANDBOX_SESSIONS,
		);
		await validateSelected();
	} catch (cause) {
		try {
			await shell(
				[
					'target="$1"; staged="$2"; rollback="$3"; marker="$4"',
					'if test -e "$rollback"; then test -d "$rollback" && test ! -L "$rollback"; rm -rf -- "$target"; mv -- "$rollback" "$target"; test -d "$target" && test ! -L "$target"; elif test -f "$marker" && test ! -L "$marker"; then rm -rf -- "$target"; rm -- "$marker"; test ! -e "$target" && test ! -L "$target"; else test -d "$staged" && test ! -L "$staged"; if test -e "$target" || test -L "$target"; then test -d "$target" && test ! -L "$target"; fi; fi',
					'rm -rf -- "$staged"',
					'test ! -e "$rollback" && test ! -e "$marker"',
				],
				SANDBOX_SESSIONS,
				staging,
				rollback,
				marker,
			);
		} catch (rollbackCause) {
			throw new AggregateError(
				[cause, rollbackCause],
				"Session restore failed and verified rollback could not complete",
			);
		}
		throw cause;
	}
	const warnings: string[] = [];
	try {
		await shell(
			[
				'rollback="$1"; marker="$2"; staged="$3"',
				'rm -rf -- "$rollback" "$marker" "$staged"',
				'test ! -e "$rollback" && test ! -e "$marker" && test ! -e "$staged"',
			],
			rollback,
			marker,
			staging,
		);
	} catch (cause) {
		warnings.push(
			`Session restore succeeded but rollback cleanup requires attention: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	return { backupDirectory, warnings };
}
