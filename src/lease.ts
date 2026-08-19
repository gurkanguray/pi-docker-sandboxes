import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	realpath,
	unlink,
	type FileHandle,
} from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { LauncherExitCode } from "./exit-codes.ts";
import { validateSandboxName } from "./sbx/client.ts";
import { worktreeMetadataDirectory } from "./workspace.ts";

export type SandboxLeaseOperation =
	| "run"
	| "export"
	| "apply"
	| "destroy"
	| "sessions-restore"
	| "sessions-delete";

export interface LeaseRecord {
	schema: 1;
	sandbox: string;
	operation: SandboxLeaseOperation;
	pid: number;
	host: string;
	startedAt: string;
}

type FileIdentity = { dev: number | bigint; ino: number | bigint };

export interface SandboxLeaseRuntime {
	pid?: number;
	host?: string;
	now?: () => Date;
	processState?: (pid: number) => "present" | "absent" | "unknown";
	/** @internal Test-only durability failure injection. */
	syncDirectory?: (path: string, handle: FileHandle) => Promise<void>;
}

export interface SandboxLease {
	readonly path: string;
	readonly record: Readonly<LeaseRecord>;
	release(): Promise<void>;
}

export const LEASE_BUSY_EXIT_CODE = LauncherExitCode.Busy;
const MAX_LEASE_BYTES = 4096;
const OPERATIONS = new Set<SandboxLeaseOperation>([
	"run",
	"export",
	"apply",
	"destroy",
	"sessions-restore",
	"sessions-delete",
]);

export class SandboxLeaseBusyError extends Error {
	readonly exitCode = LEASE_BUSY_EXIT_CODE;

	constructor(message: string) {
		super(message);
		this.name = "SandboxLeaseBusyError";
	}
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function busy(record?: Partial<LeaseRecord>): SandboxLeaseBusyError {
	return new SandboxLeaseBusyError(
		record?.operation
			? `Sandbox ${record.sandbox ?? "operation"} is busy with ${record.operation} (pid ${record.pid ?? "unknown"} on ${record.host ?? "unknown host"})`
			: "Sandbox is busy because lease ownership is uncertain",
	);
}

function flags(): { directory: number; create: number; read: number } {
	for (const name of [
		"O_RDONLY",
		"O_DIRECTORY",
		"O_NOFOLLOW",
		"O_CREAT",
		"O_EXCL",
		"O_WRONLY",
		"O_NONBLOCK",
	] as const)
		if (typeof constants[name] !== "number")
			throw new Error(`Lifecycle leases are unsupported: ${name} unavailable`);
	return {
		directory:
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		create:
			constants.O_CREAT |
			constants.O_EXCL |
			constants.O_WRONLY |
			constants.O_NOFOLLOW,
		read: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	};
}

type DirectorySync = NonNullable<SandboxLeaseRuntime["syncDirectory"]>;

const syncDirectory: DirectorySync = async (_path, directory) => {
	await directory.sync();
};

async function prepareLeaseDirectory(
	root: string,
	sync: DirectorySync,
): Promise<{
	directory: string;
	handle: FileHandle;
	validate: () => Promise<void>;
}> {
	const canonicalRoot = await realpath(root);
	const gitDirectory = worktreeMetadataDirectory(canonicalRoot);
	const paths = [
		canonicalRoot,
		gitDirectory,
		join(gitDirectory, "pi-docker-sandbox"),
		join(gitDirectory, "pi-docker-sandbox", "leases"),
	];
	const identities: FileIdentity[] = [];
	const validate = async (): Promise<void> => {
		for (let index = 0; index < identities.length; index++) {
			const current = await lstat(paths[index]!);
			if (
				!current.isDirectory() ||
				current.isSymbolicLink() ||
				!sameIdentity(identities[index]!, current) ||
				(await realpath(paths[index]!)) !== paths[index]
			)
				throw new Error("Lifecycle lease directory identity changed");
		}
	};
	for (let index = 0; index < paths.length; index++) {
		await validate();
		const path = paths[index]!;
		if (index >= 2) {
			await mkdir(path, { mode: 0o700 }).catch((cause) => {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
			});
			await validate();
			const parentPath = paths[index - 1]!;
			const parent = await open(parentPath, flags().directory);
			try {
				const opened = await parent.stat();
				if (
					!opened.isDirectory() ||
					!sameIdentity(identities[index - 1]!, opened)
				)
					throw new Error("Lifecycle lease parent changed while syncing");
				await sync(parentPath, parent);
			} finally {
				await parent.close().catch(() => undefined);
			}
		}
		const current = await lstat(path);
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			(await realpath(path)) !== path
		)
			throw new Error("Lifecycle lease directories must not use symlinks");
		identities.push(current);
	}
	await validate();
	const handle = await open(paths.at(-1)!, flags().directory);
	try {
		const opened = await handle.stat();
		if (!opened.isDirectory() || !sameIdentity(identities.at(-1)!, opened))
			throw new Error("Lifecycle lease directory changed while opening");
		return { directory: paths.at(-1)!, handle, validate };
	} catch (cause) {
		await handle.close().catch(() => undefined);
		throw cause;
	}
}

export function sandboxLeasePath(root: string, name: string): string {
	validateSandboxName(name);
	return join(
		worktreeMetadataDirectory(root),
		"pi-docker-sandbox",
		"leases",
		`${name}.json`,
	);
}

function parseRecord(contents: Buffer): LeaseRecord | undefined {
	let value: unknown;
	try {
		value = JSON.parse(contents.toString("utf8"));
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const record = value as Partial<LeaseRecord>;
	if (
		record.schema !== 1 ||
		typeof record.sandbox !== "string" ||
		!OPERATIONS.has(record.operation as SandboxLeaseOperation) ||
		!Number.isSafeInteger(record.pid) ||
		record.pid! <= 0 ||
		typeof record.host !== "string" ||
		!record.host ||
		typeof record.startedAt !== "string" ||
		!Number.isFinite(Date.parse(record.startedAt))
	)
		return;
	return record as LeaseRecord;
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
	const output = Buffer.alloc(MAX_LEASE_BYTES + 1);
	let offset = 0;
	while (offset < output.length) {
		const { bytesRead } = await handle.read(
			output,
			offset,
			output.length - offset,
			offset,
		);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	if (offset > MAX_LEASE_BYTES) throw busy();
	return Buffer.from(output.subarray(0, offset));
}

function localProcessState(pid: number): "present" | "absent" | "unknown" {
	try {
		process.kill(pid, 0);
		return "present";
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "absent";
		if (code === "EPERM") return "present";
		return "unknown";
	}
}

export interface SandboxLeaseInspection {
	status: "absent" | "live" | "abandoned" | "uncertain";
	record?: Readonly<LeaseRecord>;
}

interface OpenLeaseSnapshot {
	path: string;
	parent: FileHandle;
	file: FileHandle;
	identity: FileIdentity;
	bytes: Buffer;
	record: LeaseRecord;
	validate(): Promise<void>;
}

async function openLeaseSnapshot(
	root: string,
	name: string,
): Promise<OpenLeaseSnapshot | undefined> {
	const path = sandboxLeasePath(root, name);
	const directory = join(path, "..");
	let parent: FileHandle;
	try {
		parent = await open(directory, flags().directory);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw cause;
	}
	let file: FileHandle | undefined;
	try {
		const parentIdentity = await parent.stat();
		const discovered = await lstat(path).catch((cause) => {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw cause;
		});
		if (!discovered) {
			await parent.close();
			return undefined;
		}
		if (!discovered.isFile() || discovered.isSymbolicLink() || discovered.nlink !== 1)
			throw busy();
		file = await open(path, flags().read);
		const identity = await file.stat();
		if (!identity.isFile() || identity.nlink !== 1 || !sameIdentity(identity, discovered))
			throw busy();
		const bytes = await readBounded(file);
		const record = parseRecord(bytes);
		if (!record || record.sandbox !== name) throw busy();
		const validate = async (): Promise<void> => {
			const [openedParent, currentParent, opened, current, reread] = await Promise.all([
				parent.stat(),
				lstat(directory),
				file!.stat(),
				lstat(path),
				readBounded(file!),
			]);
			if (
				!openedParent.isDirectory() ||
				currentParent.isSymbolicLink() ||
				!sameIdentity(parentIdentity, openedParent) ||
				!sameIdentity(parentIdentity, currentParent) ||
				!opened.isFile() ||
				opened.nlink !== 1 ||
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.nlink !== 1 ||
				!sameIdentity(identity, opened) ||
				!sameIdentity(identity, current) ||
				!bytes.equals(reread)
			)
				throw busy();
		};
		await validate();
		return { path, parent, file, identity, bytes, record, validate };
	} catch (cause) {
		await file?.close().catch(() => undefined);
		await parent.close().catch(() => undefined);
		throw cause;
	}
}

export async function inspectSandboxLease(
	root: string,
	name: string,
	runtime: Pick<SandboxLeaseRuntime, "host" | "processState"> = {},
): Promise<SandboxLeaseInspection> {
	const snapshot = await openLeaseSnapshot(root, name);
	if (!snapshot) return { status: "absent" };
	try {
		const host = runtime.host ?? hostname();
		if (snapshot.record.host !== host)
			return { status: "uncertain", record: snapshot.record };
		const state = (runtime.processState ?? localProcessState)(snapshot.record.pid);
		return {
			status:
				state === "present"
					? "live"
					: state === "absent"
						? "abandoned"
						: "uncertain",
			record: snapshot.record,
		};
	} finally {
		await snapshot.file.close().catch(() => undefined);
		await snapshot.parent.close().catch(() => undefined);
	}
}

export async function unlockSandboxLease(
	root: string,
	name: string,
	yes: boolean,
	runtime: SandboxLeaseRuntime & { beforeUnlink?: (path: string) => Promise<void> } = {},
): Promise<LeaseRecord> {
	if (!yes) throw new Error("Unlock requires explicit --yes authority");
	const snapshot = await openLeaseSnapshot(root, name);
	if (!snapshot) throw new Error(`No lifecycle lease exists for sandbox ${name}`);
	try {
		if (snapshot.record.host !== (runtime.host ?? hostname()))
			throw new Error("Lease host identity is not local; refusing unlock");
		const state = (runtime.processState ?? localProcessState)(snapshot.record.pid);
		if (state !== "absent")
			throw new Error(
				state === "present"
					? `Recorded lease process ${snapshot.record.pid} is still present`
					: `Recorded lease process ${snapshot.record.pid} absence is uncertain`,
			);
		await runtime.beforeUnlink?.(snapshot.path);
		await snapshot.validate();
		await unlink(snapshot.path);
		await (runtime.syncDirectory ?? syncDirectory)(
			join(snapshot.path, ".."),
			snapshot.parent,
		);
		return snapshot.record;
	} finally {
		await snapshot.file.close().catch(() => undefined);
		await snapshot.parent.close().catch(() => undefined);
	}
}

async function inspectExistingLease(
	path: string,
	name: string,
): Promise<"retry"> {
	let handle: FileHandle;
	try {
		handle = await open(path, flags().read);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "retry";
		throw busy();
	}
	try {
		const identity = await handle.stat();
		if (!identity.isFile() || identity.nlink !== 1) throw busy();
		const contents = await readBounded(handle);
		const record = parseRecord(contents);
		if (!record || record.sandbox !== name) throw busy();
		// Host and PID are diagnostics only. Neither can prove local ownership,
		// so every existing record remains busy until explicit recovery.
		throw busy(record);
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export async function acquireSandboxLease(
	root: string,
	name: string,
	operation: SandboxLeaseOperation,
	runtime: SandboxLeaseRuntime = {},
): Promise<SandboxLease> {
	validateSandboxName(name);
	if (!OPERATIONS.has(operation))
		throw new TypeError(`Invalid lifecycle lease operation: ${operation}`);
	const actual = {
		pid: runtime.pid ?? process.pid,
		host: runtime.host ?? hostname(),
		now: runtime.now ?? (() => new Date()),
		syncDirectory: runtime.syncDirectory ?? syncDirectory,
	};
	if (!Number.isSafeInteger(actual.pid) || actual.pid <= 0 || !actual.host)
		throw new TypeError("Invalid lifecycle lease owner identity");
	const record: LeaseRecord = {
		schema: 1,
		sandbox: name,
		operation,
		pid: actual.pid,
		host: actual.host,
		startedAt: actual.now().toISOString(),
	};
	const parent = await prepareLeaseDirectory(root, actual.syncDirectory);
	const path = join(parent.directory, `${name}.json`);
	for (;;) {
		try {
			await parent.validate();
		} catch (cause) {
			await parent.handle.close().catch(() => undefined);
			throw cause;
		}
		let file: FileHandle;
		try {
			file = await open(path, flags().create, 0o600);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
				await parent.handle.close().catch(() => undefined);
				throw cause;
			}
			try {
				await inspectExistingLease(path, name);
				continue;
			} catch (error) {
				await parent.handle.close().catch(() => undefined);
				throw error;
			}
		}
		try {
			await file.writeFile(`${JSON.stringify(record)}\n`);
			await file.sync();
			await parent.validate();
			const [identity, current] = await Promise.all([file.stat(), lstat(path)]);
			if (
				!identity.isFile() ||
				identity.nlink !== 1 ||
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.nlink !== 1 ||
				!sameIdentity(identity, current)
			)
				throw new Error("Lifecycle lease changed during acquisition");
			await actual.syncDirectory(parent.directory, parent.handle);
			let released = false;
			return {
				path,
				record,
				async release(): Promise<void> {
					if (released) return;
					released = true;
					try {
						await parent.validate();
						const [opened, current] = await Promise.all([
							file.stat(),
							lstat(path).catch((cause) => {
								if ((cause as NodeJS.ErrnoException).code === "ENOENT")
									return undefined;
								throw cause;
							}),
						]);
						if (
							!current ||
							!opened.isFile() ||
							opened.nlink !== 1 ||
							!current.isFile() ||
							current.isSymbolicLink() ||
							current.nlink !== 1 ||
							!sameIdentity(identity, opened) ||
							!sameIdentity(identity, current)
						)
							throw new Error(
								"Lifecycle lease ownership changed before release",
							);
						await unlink(path);
						await actual.syncDirectory(parent.directory, parent.handle);
					} finally {
						await file.close().catch(() => undefined);
						await parent.handle.close().catch(() => undefined);
					}
				},
			};
		} catch (cause) {
			// A post-create failure retains the pathname. Path-based cleanup cannot
			// prove ownership after replacement and must fail closed.
			await file.close().catch(() => undefined);
			await parent.handle.close().catch(() => undefined);
			throw cause;
		}
	}
}

export async function withSandboxLease<T>(
	root: string,
	name: string,
	operation: SandboxLeaseOperation,
	action: (lease: SandboxLease) => Promise<T>,
	runtime?: SandboxLeaseRuntime,
): Promise<T> {
	const lease = await acquireSandboxLease(root, name, operation, runtime);
	try {
		return await action(lease);
	} finally {
		await lease.release();
	}
}
