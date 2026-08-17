import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { SbxCommandError, type SbxClient } from "./sbx/client.ts";

const SANDBOX_SESSIONS = "/home/agent/.pi/agent/sessions";
const BACKUP_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

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
): Promise<
	| { root: string; validate: () => Promise<void> }
	| undefined
> {
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

export async function backupSessions(
	client: SbxClient,
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
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
	await chmod(partial, 0o700);
	try {
		await prepared!.validate();
		await client.copyFrom(sandboxName, SANDBOX_SESSIONS, partial);
		await prepared!.validate();
		await chmod(partial, 0o700);
		await prepared!.validate();
		await rename(partial, destination);
		await prepared!.validate();
		return destination;
	} catch (cause) {
		try {
			await prepared!.validate();
			await rm(partial, { recursive: true, force: true });
		} catch (cleanupError) {
			void cleanupError;
		}
		throw cause;
	}
}

export async function restoreSessions(
	client: SbxClient,
	agentDir: string,
	repositoryIdentity: string,
	sandboxName: string,
): Promise<string | undefined> {
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
	const latest = entries.filter(isBackupTimestamp).sort().at(-1);
	if (!latest) return undefined;
	const backupDirectory = join(root, latest);
	const sessions = join(backupDirectory, "sessions");
	const selected = await Promise.all(
		([
			[backupDirectory, "backup"],
			[sessions, "sessions"],
		] as const).map(async ([path, label]) => {
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
	await client.copyTo(sandboxName, sessions, "/home/agent/.pi/agent/");
	await validateSelected();
	return backupDirectory;
}
