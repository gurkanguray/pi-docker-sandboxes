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
import { validateSandboxName } from "./sbx/client.ts";

export type SandboxLeaseOperation = "run" | "export" | "apply" | "destroy";

interface LeaseRecord {
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
	processAlive?: (pid: number) => boolean | "uncertain";
}

export interface SandboxLease {
	readonly path: string;
	readonly record: Readonly<LeaseRecord>;
	release(): Promise<void>;
}

export const LEASE_BUSY_EXIT_CODE = 75;
const MAX_LEASE_BYTES = 4096;
const OPERATIONS = new Set<SandboxLeaseOperation>([
	"run",
	"export",
	"apply",
	"destroy",
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

async function syncDirectory(directory: FileHandle): Promise<void> {
	await directory.sync().catch((cause) => {
		if (
			!["EINVAL", "ENOTSUP", "EBADF"].includes(
				(cause as NodeJS.ErrnoException).code ?? "",
			)
		)
			throw cause;
	});
}

async function prepareLeaseDirectory(root: string): Promise<{
	directory: string;
	handle: FileHandle;
	validate: () => Promise<void>;
}> {
	const canonicalRoot = await realpath(root);
	const paths = [
		canonicalRoot,
		join(canonicalRoot, ".git"),
		join(canonicalRoot, ".git", "pi-docker-sandbox"),
		join(canonicalRoot, ".git", "pi-docker-sandbox", "leases"),
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
		if (index >= 2)
			await mkdir(path, { mode: 0o700 }).catch((cause) => {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
			});
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

function defaultProcessAlive(pid: number): boolean | "uncertain" {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
		return "uncertain";
	}
}

async function reclaimIfStale(
	path: string,
	name: string,
	parent: Awaited<ReturnType<typeof prepareLeaseDirectory>>,
	runtime: Required<Pick<SandboxLeaseRuntime, "host" | "processAlive">>,
): Promise<"reclaimed" | "retry"> {
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
		if (record.host !== runtime.host) throw busy(record);
		if (runtime.processAlive(record.pid) !== false) throw busy(record);
		await parent.validate();
		const [opened, current, reread] = await Promise.all([
			handle.stat(),
			lstat(path),
			readBounded(handle),
		]);
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			!current.isFile() ||
			current.isSymbolicLink() ||
			current.nlink !== 1 ||
			!sameIdentity(identity, opened) ||
			!sameIdentity(identity, current) ||
			!contents.equals(reread)
		)
			throw busy();
		await unlink(path).catch((cause) => {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
		});
		await syncDirectory(parent.handle);
		return "reclaimed";
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
		processAlive: runtime.processAlive ?? defaultProcessAlive,
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
	const parent = await prepareLeaseDirectory(root);
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
				await reclaimIfStale(path, name, parent, actual);
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
			await syncDirectory(parent.handle);
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
						await syncDirectory(parent.handle);
					} finally {
						await file.close().catch(() => undefined);
						await parent.handle.close().catch(() => undefined);
					}
				},
			};
		} catch (cause) {
			const identity = await file.stat().catch(() => undefined);
			const current = await lstat(path).catch(() => undefined);
			if (identity && current && sameIdentity(identity, current))
				await unlink(path).catch(() => undefined);
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
