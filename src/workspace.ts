import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	unlink,
	type FileHandle,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { promisify } from "node:util";
import {
	OperationError,
	sanitizeDetail,
	type OperationPhase,
} from "./errors.ts";
import {
	migrateSandboxState,
	type Migration,
	writeJsonAtomic,
} from "./migration.ts";
import { type SbxClient, validateSandboxName } from "./sbx/client.ts";

const execFileAsync = promisify(execFile);

export interface GitResult {
	stdout: string;
	stderr: string;
	code: number;
}
export type GitRunner = (
	cwd: string,
	args: readonly string[],
) => Promise<GitResult>;
export type GitInputRunner = (
	cwd: string,
	args: readonly string[],
	stdin: Buffer,
) => Promise<GitResult>;

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<GitResult> {
	try {
		const result = await execFileAsync("git", [...args], {
			cwd,
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0 };
	} catch (cause) {
		const error = cause as { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			code: typeof error.code === "number" ? error.code : 1,
		};
	}
}

async function runGitInput(
	cwd: string,
	args: readonly string[],
	stdin: Buffer,
): Promise<GitResult> {
	return new Promise((resolveResult) => {
		const child = execFile(
			"git",
			[...args],
			{
				cwd,
				encoding: "buffer",
				maxBuffer: MAX_PATCH_BYTES,
			},
			(error, stdout, stderr) => {
				const code = (error as { code?: unknown } | null)?.code;
				resolveResult({
					stdout: Buffer.from(stdout).toString("utf8"),
					stderr: Buffer.from(stderr).toString("utf8"),
					code: typeof code === "number" ? code : error ? 1 : 0,
				});
			},
		);
		child.stdin?.end(stdin);
	});
}

async function probeGit(
	runner: GitRunner,
	cwd: string,
	args: readonly string[],
): Promise<GitResult> {
	return runner(cwd, args);
}

async function git(
	runner: GitRunner,
	cwd: string,
	args: readonly string[],
	phase: OperationPhase,
	operation: string,
	recovery: readonly string[] = [],
	allowFailure = false,
): Promise<string> {
	const result = await probeGit(runner, cwd, args);
	if (!allowFailure && result.code !== 0) {
		throw new OperationError({
			phase,
			operation,
			exitCode: result.code,
			detail: result.stderr,
			recovery,
		});
	}
	return result.stdout.trim();
}

function scrubRemote(remote: string): string {
	try {
		const url = new URL(remote);
		url.username = "";
		url.password = "";
		return url.toString();
	} catch {
		return remote.replace(/^[^@\s]+@(?=[^:]+:)/, "git@");
	}
}

export class UnbornHeadError extends OperationError {
	readonly root: string;

	constructor(root: string, result: GitResult) {
		super({
			phase: "preflight",
			operation: "Git repository has no initial commit",
			exitCode: result.code,
			detail: result.stderr,
			recovery: ['git commit --allow-empty --only -m "Initial commit"'],
		});
		this.name = "UnbornHeadError";
		this.root = root;
	}
}

export interface RepositoryState {
	root: string;
	head: string;
	branch: string;
	identity: string;
	dirty: boolean;
	mainWorktree: boolean;
}

export async function inspectRepository(
	cwd: string,
	runner: GitRunner = runGit,
): Promise<RepositoryState> {
	const recovery = ["git init"];
	const root = await git(
		runner,
		cwd,
		["rev-parse", "--show-toplevel"],
		"preflight",
		"git rev-parse --show-toplevel",
		recovery,
	);
	if (!root) throw new Error("Clone mode requires a Git repository");
	const headResult = await probeGit(runner, root, [
		"rev-parse",
		"--verify",
		"HEAD",
	]);
	if (headResult.code !== 0) {
		const symbolicHead = await probeGit(runner, root, [
			"symbolic-ref",
			"--quiet",
			"HEAD",
		]);
		if (symbolicHead.code === 0) {
			const branchRef = await probeGit(runner, root, [
				"show-ref",
				"--verify",
				"--quiet",
				symbolicHead.stdout.trim(),
			]);
			if (branchRef.code === 1) throw new UnbornHeadError(root, headResult);
		}
		throw new OperationError({
			phase: "preflight",
			operation: "git rev-parse --verify HEAD",
			exitCode: headResult.code,
			detail: headResult.stderr,
		});
	}
	const head = headResult.stdout.trim();
	const branch =
		(await git(
			runner,
			root,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			"preflight",
			"git symbolic-ref HEAD",
			[],
			true,
		)) || "HEAD";
	const gitDirValue = await git(
		runner,
		root,
		["rev-parse", "--git-dir"],
		"preflight",
		"git rev-parse --git-dir",
	);
	const commonDirValue = await git(
		runner,
		root,
		["rev-parse", "--git-common-dir"],
		"preflight",
		"git rev-parse --git-common-dir",
	);
	const absolute = (value: string) =>
		resolve(root, isAbsolute(value) ? value : join(root, value));
	const remote = await git(
		runner,
		root,
		["config", "--get", "remote.origin.url"],
		"preflight",
		"git config remote.origin.url",
		[],
		true,
	);
	const status = await git(
		runner,
		root,
		["status", "--porcelain=v1", "--untracked-files=normal"],
		"preflight",
		"git status",
	);
	return {
		root,
		head,
		branch,
		identity: remote
			? scrubRemote(remote)
			: `local:${createHash("sha256").update(root).digest("hex")}`,
		dirty: status.length > 0,
		mainWorktree: absolute(gitDirValue) === absolute(commonDirValue),
	};
}

export async function createEmptyInitialCommit(
	root: string,
	runner: GitRunner = runGit,
): Promise<void> {
	await git(
		runner,
		root,
		["commit", "--allow-empty", "--only", "-m", "Initial commit"],
		"preflight",
		'git commit --allow-empty --only -m "Initial commit"',
	);
}

export function sandboxName(root: string, fresh = false): string {
	const slug =
		basename(root)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 36) || "repo";
	const suffix = fresh
		? randomBytes(4).toString("hex")
		: createHash("sha256").update(resolve(root)).digest("hex").slice(0, 10);
	return `pi-${slug}-${suffix}`;
}

export interface SandboxImageAttestation {
	status: "pending" | "verified";
	image: string;
	templateStoreId: string;
}

export interface SandboxState {
	version: 1;
	name: string;
	hostBaseCommit: string;
	hostBranch: string;
	hostRepoIdentity: string;
	hostRoot: string;
	workspaceMode: "clone" | "direct";
	createdAt: string;
	imageAttestation?: SandboxImageAttestation;
}

export function statePath(root: string, name: string): string {
	validateSandboxName(name);
	return join(root, ".git", "pi-docker-sandbox", "state", `${name}.json`);
}

export async function removeSandboxState(
	root: string,
	name: string,
	options:
		| { beforeUnlink?: (path: string) => Promise<void> }
		| ((path: string) => Promise<void>) = {},
): Promise<void> {
	const canonicalRoot = await realpath(root);
	const git = join(canonicalRoot, ".git");
	const directory = join(git, "pi-docker-sandbox", "state");
	const path = statePath(canonicalRoot, name);
	const directoryFlags =
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	let parent: FileHandle | undefined;
	try {
		const gitStat = await lstat(git);
		if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
			throw new Error("Sandbox state requires a main-worktree .git directory");
		parent = await open(directory, directoryFlags);
		const [openedParent, currentParent] = await Promise.all([
			parent.stat(),
			lstat(directory),
		]);
		if (
			!openedParent.isDirectory() ||
			currentParent.isSymbolicLink() ||
			!sameIdentity(openedParent, currentParent) ||
			(await realpath(directory)) !== directory
		)
			throw new Error("Sandbox state directory identity changed");
		let original;
		try {
			original = await lstat(path);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
			throw cause;
		}
		if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1)
			throw new Error("Sandbox state file is not a single-link regular file");
		if (typeof options === "function") await options(path);
		else await options.beforeUnlink?.(path);
		const [parentBeforeUnlink, currentParentBeforeUnlink, current] =
			await Promise.all([parent.stat(), lstat(directory), lstat(path)]);
		if (
			!sameIdentity(openedParent, parentBeforeUnlink) ||
			!sameIdentity(openedParent, currentParentBeforeUnlink) ||
			!sameIdentity(original, current) ||
			!current.isFile() ||
			current.isSymbolicLink() ||
			current.nlink !== 1
		)
			throw new Error("Sandbox state path identity changed before removal");
		await unlink(path);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
		throw cause;
	} finally {
		await parent?.close();
	}
}

export async function saveSandboxState(state: SandboxState): Promise<void> {
	await writeJsonAtomic(statePath(state.hostRoot, state.name), state);
}

function shellArg(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function stateRecovery(path: string, name: string, missing = false): string[] {
	return [
		...(missing
			? []
			: [`cp ${shellArg(path)} ${shellArg(`${path}.preserved`)}`]),
		`sbx exec ${shellArg(name)} git status --porcelain=v1`,
		`sbx rm --force ${shellArg(name)}`,
	];
}

export async function loadSandboxStateResult(
	root: string,
	name: string,
): Promise<Migration<SandboxState>> {
	const path = statePath(root, name);
	let migrated: Migration<SandboxState>;
	try {
		migrated = migrateSandboxState(
			JSON.parse(await readFile(path, "utf8")),
			path,
		);
	} catch (cause) {
		const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
		throw new OperationError({
			phase: "preflight",
			operation: `load state for sandbox ${name} from ${path}`,
			detail: `${
				missing
					? "State file does not exist"
					: cause instanceof Error
						? cause.message
						: String(cause)
			}; inspect first because unexported work may be lost by force removal`,
			recovery: stateRecovery(path, name, missing),
			cause,
		});
	}
	if (migrated.value.name !== name || migrated.value.hostRoot !== root)
		throw new OperationError({
			phase: "preflight",
			operation: `load state for sandbox ${name} from ${path}`,
			detail:
				"Sandbox metadata does not match this repository; inspect first because unexported work may be lost by force removal",
			recovery: stateRecovery(path, name),
		});
	return migrated;
}

export async function loadSandboxState(
	root: string,
	name: string,
): Promise<SandboxState> {
	return (await loadSandboxStateResult(root, name)).value;
}

export interface PatchExport {
	path: string;
	bytes: number;
	summary: string[];
}

export const MAX_PATCH_BYTES = 32 * 1024 * 1024;

export function assertPatchSize(bytes: number): void {
	if (bytes > MAX_PATCH_BYTES)
		throw new Error(`Patch exceeds ${MAX_PATCH_BYTES} byte export limit`);
}

type FileIdentity = { dev: number | bigint; ino: number | bigint };
type PatchOpenConstants = Partial<
	Record<
		| "O_RDONLY"
		| "O_DIRECTORY"
		| "O_NOFOLLOW"
		| "O_CREAT"
		| "O_EXCL"
		| "O_WRONLY"
		| "O_NONBLOCK",
		number | undefined
	>
>;

export interface PatchDestinationOptions {
	/** @internal Test-only platform capability injection. */
	constants?: PatchOpenConstants;
	/** @internal Deterministic race injection after the parent is opened. */
	beforeCreate?: (directory: string, path: string) => Promise<void>;
	/** @internal Deterministic race injection after the file is opened. */
	afterCreate?: (directory: string, path: string) => Promise<void>;
}

class PatchClaimError extends Error {
	readonly retainedPath?: string;
	readonly exportDirectory: string;

	constructor(cause: unknown, exportDirectory: string, retainedPath?: string) {
		super("Patch export failed after exclusive file claim", { cause });
		this.name = "PatchClaimError";
		this.exportDirectory = exportDirectory;
		this.retainedPath = retainedPath;
	}
}

interface PreparedPatchFile {
	path: string;
	file: FileHandle;
	parent: FileHandle;
	identity: FileIdentity;
	parentIdentity: FileIdentity;
	validateParent: () => Promise<void>;
	closeParents: () => Promise<void>;
}

interface ValidatedPath {
	handle: FileHandle;
	identity: FileIdentity;
	validate: () => Promise<void>;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function contained(root: string, path: string): boolean {
	const value = relative(root, path);
	return (
		value === "" ||
		(!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`))
	);
}

function destinationFlags(values: PatchOpenConstants = constants): {
	directory: number;
	file: number;
	readFile: number;
} {
	for (const name of [
		"O_RDONLY",
		"O_DIRECTORY",
		"O_NOFOLLOW",
		"O_CREAT",
		"O_EXCL",
		"O_WRONLY",
		"O_NONBLOCK",
	] as const) {
		if (typeof values[name] !== "number")
			throw new Error(
				`Secure patch export is unsupported: ${name} unavailable`,
			);
	}
	return {
		directory: values.O_RDONLY! | values.O_DIRECTORY! | values.O_NOFOLLOW!,
		file:
			values.O_CREAT! | values.O_EXCL! | values.O_WRONLY! | values.O_NOFOLLOW!,
		readFile: values.O_RDONLY! | values.O_NOFOLLOW! | values.O_NONBLOCK!,
	};
}

function patchPathParts(
	configuredDirectory: string,
	filename: string,
): string[] {
	if (
		!configuredDirectory ||
		isAbsolute(configuredDirectory) ||
		/[\x00-\x1f\x7f]/.test(configuredDirectory)
	)
		throw new TypeError("Patch directory must be a control-free relative path");
	const parts = configuredDirectory.split(sep);
	if (parts.some((part) => !part || part === "." || part === ".."))
		throw new TypeError("Patch directory contains an unsafe path component");
	if (
		!filename ||
		filename !== basename(filename) ||
		filename === "." ||
		filename === ".." ||
		/[\x00-\x1f\x7f]/.test(filename)
	)
		throw new TypeError("Patch filename must be a control-free basename");
	return parts;
}

async function openValidatedDirectory(
	path: string,
	flags: number,
	containmentRoot?: string,
): Promise<{
	handle: FileHandle;
	identity: FileIdentity;
	validate: () => Promise<void>;
}> {
	containmentRoot ??= path;
	const pathStat = await lstat(path);
	if (pathStat.isSymbolicLink() || !pathStat.isDirectory())
		throw new Error("Patch export path is not a real directory");
	const canonical = await realpath(path);
	if (!contained(containmentRoot, canonical))
		throw new Error("Patch export path escapes its containment root");
	const handle = await open(path, flags);
	try {
		const identity = await handle.stat();
		if (!identity.isDirectory() || !sameIdentity(identity, pathStat))
			throw new Error("Patch export directory changed while opening");
		const validate = async (): Promise<void> => {
			const [descriptor, current, resolved] = await Promise.all([
				handle.stat(),
				lstat(path),
				realpath(path),
			]);
			if (
				!descriptor.isDirectory() ||
				current.isSymbolicLink() ||
				!current.isDirectory() ||
				!sameIdentity(identity, descriptor) ||
				!sameIdentity(identity, current) ||
				resolved !== canonical ||
				!contained(containmentRoot, resolved)
			)
				throw new Error("Patch export directory changed during use");
		};
		await validate();
		return { handle, identity, validate };
	} catch (cause) {
		await handle.close().catch(() => undefined);
		throw cause;
	}
}

const MAX_GIT_LINK_BYTES = 4096;

type PositionedReader = (
	buffer: Buffer,
	offset: number,
	length: number,
	position: number,
) => Promise<{ bytesRead: number }>;

/** @internal */
export async function readBoundedExact(
	reader: PositionedReader,
	maxBytes: number,
): Promise<Buffer> {
	const buffer = Buffer.alloc(maxBytes + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const { bytesRead } = await reader(
			buffer,
			offset,
			buffer.length - offset,
			offset,
		);
		if (bytesRead === 0) break;
		if (bytesRead < 0 || bytesRead > buffer.length - offset)
			throw new Error("Invalid bounded read result");
		offset += bytesRead;
	}
	if (offset > maxBytes) throw new Error("Bounded file exceeds maximum size");
	return Buffer.from(buffer.subarray(0, offset));
}

async function readValidatedLinkFile(
	path: string,
	flags: number,
): Promise<ValidatedPath & { text: string }> {
	const discovered = await lstat(path);
	if (
		!discovered.isFile() ||
		discovered.isSymbolicLink() ||
		discovered.nlink !== 1
	)
		throw new Error("Git worktree association file is invalid");
	const handle = await open(path, flags);
	try {
		const identity = await handle.stat();
		if (
			!identity.isFile() ||
			identity.nlink !== 1 ||
			identity.size > MAX_GIT_LINK_BYTES ||
			!sameIdentity(identity, discovered)
		)
			throw new Error("Git worktree association file is invalid");
		const reader: PositionedReader = (buffer, offset, length, position) =>
			handle.read(buffer, offset, length, position);
		const initial = await readBoundedExact(reader, MAX_GIT_LINK_BYTES);
		if (initial.length !== identity.size)
			throw new Error("Git worktree association file is invalid");
		const validate = async (): Promise<void> => {
			const [reread, opened, current] = await Promise.all([
				readBoundedExact(reader, MAX_GIT_LINK_BYTES),
				handle.stat(),
				lstat(path),
			]);
			if (
				!reread.equals(initial) ||
				!opened.isFile() ||
				opened.nlink !== 1 ||
				opened.size !== initial.length ||
				!current.isFile() ||
				current.isSymbolicLink() ||
				current.nlink !== 1 ||
				current.size !== initial.length ||
				!sameIdentity(identity, opened) ||
				!sameIdentity(identity, current)
			)
				throw new Error("Git worktree association changed during export");
		};
		await validate();
		return {
			handle,
			identity,
			validate,
			text: initial.toString("utf8"),
		};
	} catch (cause) {
		await handle.close().catch(() => undefined);
		throw cause;
	}
}

async function patchContainmentRoot(
	root: string,
	parts: string[],
	flags: { directory: number; readFile: number },
): Promise<{
	root: string;
	parts: string[];
	directory: Awaited<ReturnType<typeof openValidatedDirectory>>;
	guardians: ValidatedPath[];
}> {
	const canonicalRoot = await realpath(root);
	const repository = await openValidatedDirectory(
		canonicalRoot,
		flags.directory,
	);
	if (parts[0] !== ".git")
		return { root: canonicalRoot, parts, directory: repository, guardians: [] };
	const guardians: ValidatedPath[] = [repository];
	try {
		const [gitDirectory, topLevel] = await Promise.all([
			git(
				runGit,
				canonicalRoot,
				["rev-parse", "--absolute-git-dir"],
				"export-or-preserve",
				"resolve per-worktree Git directory",
			),
			git(
				runGit,
				canonicalRoot,
				["rev-parse", "--show-toplevel"],
				"export-or-preserve",
				"verify worktree root",
			),
		]);
		if ((await realpath(topLevel)) !== canonicalRoot)
			throw new Error("Git worktree root association is invalid");
		const gitEntry = join(canonicalRoot, ".git");
		const entryStat = await lstat(gitEntry);
		const canonicalGitDirectory = await realpath(gitDirectory);
		if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
			if ((await realpath(gitEntry)) !== canonicalGitDirectory)
				throw new Error("Primary Git directory association is invalid");
		} else {
			const gitFile = await readValidatedLinkFile(gitEntry, flags.readFile);
			guardians.push(gitFile);
			const match = gitFile.text.match(/^gitdir: ([^\0\r\n]+)\n?$/);
			if (!match?.[1]) throw new Error("Linked worktree Git file is invalid");
			const referencedGitDirectory = resolve(canonicalRoot, match[1]);
			if ((await realpath(referencedGitDirectory)) !== canonicalGitDirectory)
				throw new Error("Linked worktree Git directory association is invalid");
			const backReference = await readValidatedLinkFile(
				join(canonicalGitDirectory, "gitdir"),
				flags.readFile,
			);
			guardians.push(backReference);
			const referencedEntry = backReference.text.replace(/\n$/, "");
			if (
				!referencedEntry ||
				/[\0\r\n]/.test(referencedEntry) ||
				(await realpath(resolve(canonicalGitDirectory, referencedEntry))) !==
					(await realpath(gitEntry))
			)
				throw new Error("Linked worktree back-reference is invalid");
		}
		const directory = await openValidatedDirectory(
			canonicalGitDirectory,
			flags.directory,
		);
		return {
			root: canonicalGitDirectory,
			parts: parts.slice(1),
			directory,
			guardians,
		};
	} catch (cause) {
		await Promise.all(
			guardians.map((guardian) =>
				guardian.handle.close().catch(() => undefined),
			),
		);
		throw cause;
	}
}

async function preparePatchFile(
	root: string,
	configuredDirectory: string,
	filename: string,
	options: PatchDestinationOptions = {},
): Promise<PreparedPatchFile> {
	const flags = destinationFlags(options.constants);
	const parts = patchPathParts(configuredDirectory, filename);
	const containment = await patchContainmentRoot(root, parts, flags);
	let directory = containment.directory;
	let currentPath = containment.root;
	let file: FileHandle | undefined;
	let path = "";
	let identity: FileIdentity | undefined;
	try {
		const validateGuardians = async (): Promise<void> => {
			await Promise.all(
				containment.guardians.map((guardian) => guardian.validate()),
			);
		};
		for (const part of containment.parts) {
			await validateGuardians();
			await directory.validate();
			const childPath = join(currentPath, part);
			let childStat = await lstat(childPath).catch((cause) => {
				if ((cause as NodeJS.ErrnoException).code === "ENOENT")
					return undefined;
				throw cause;
			});
			if (!childStat) {
				await directory.validate();
				await mkdir(childPath, { mode: 0o700 });
				await directory.validate();
				childStat = await lstat(childPath);
			}
			if (childStat.isSymbolicLink() || !childStat.isDirectory())
				throw new Error("Patch export path component is not a real directory");
			const child = await openValidatedDirectory(
				childPath,
				flags.directory,
				containment.root,
			);
			await directory.validate();
			await directory.handle.close();
			directory = child;
			currentPath = childPath;
		}
		path = join(currentPath, filename);
		await validateGuardians();
		await directory.validate();
		await options.beforeCreate?.(currentPath, path);
		await validateGuardians();
		await directory.validate();
		file = await open(path, flags.file, 0o600);
		const openedStat = await file.stat();
		identity = openedStat;
		await options.afterCreate?.(currentPath, path);
		const current = await lstat(path);
		if (
			!openedStat.isFile() ||
			openedStat.nlink !== 1 ||
			current.isSymbolicLink() ||
			!current.isFile() ||
			!sameIdentity(identity, current)
		)
			throw new Error("Patch file changed during exclusive creation");
		await validateGuardians();
		await directory.validate();
		await file.chmod(0o600);
		return {
			path,
			file,
			parent: directory.handle,
			identity,
			parentIdentity: directory.identity,
			validateParent: async () => {
				await validateGuardians();
				await directory.validate();
			},
			closeParents: async () => {
				await directory.handle.close().catch(() => undefined);
				await Promise.all(
					containment.guardians.map((guardian) =>
						guardian.handle.close().catch(() => undefined),
					),
				);
			},
		};
	} catch (cause) {
		await file?.sync().catch(() => undefined);
		let retainedPath: string | undefined;
		if (file && identity && path) {
			const current = await lstat(path).catch(() => undefined);
			if (current && sameIdentity(identity, current)) retainedPath = path;
		}
		await file?.close().catch(() => undefined);
		await directory.handle.close().catch(() => undefined);
		await Promise.all(
			containment.guardians.map((guardian) =>
				guardian.handle.close().catch(() => undefined),
			),
		);
		if (file) throw new PatchClaimError(cause, currentPath, retainedPath);
		throw cause;
	}
}

export async function preparePatchDestination(
	root: string,
	configuredDirectory: string,
	filename: string,
	options: PatchDestinationOptions = {},
): Promise<string> {
	const prepared = await preparePatchFile(
		root,
		configuredDirectory,
		filename,
		options,
	);
	try {
		await prepared.file.sync();
		await prepared.validateParent();
		await prepared.parent.sync().catch((cause) => {
			if (
				!["EINVAL", "ENOTSUP", "EBADF"].includes(
					(cause as NodeJS.ErrnoException).code ?? "",
				)
			)
				throw cause;
		});
		return prepared.path;
	} finally {
		await prepared.file.close().catch(() => undefined);
		await prepared.closeParents();
	}
}

function safeTimestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function patchFailureDetail(cause: unknown): string {
	const code = (cause as NodeJS.ErrnoException)?.code;
	return typeof code === "string"
		? `${code}: secure patch destination unavailable`
		: cause instanceof Error
			? cause.message
			: String(cause);
}

function patchRecovery(state: SandboxState, cause?: unknown): string[] {
	const artifactRecovery =
		cause instanceof PatchClaimError
			? cause.retainedPath
				? [`ls -l -- ${shellArg(cause.retainedPath)}`]
				: [
						"The export pathname changed; inspect the sandbox and Git worktree manually before retrying.",
					]
			: [];
	return [
		...artifactRecovery,
		`sbx exec ${shellArg(state.name)} git status --porcelain=v1`,
		`sbx exec ${shellArg(state.name)} git diff --cached --binary --full-index ${shellArg(state.hostBaseCommit)} > sandbox.patch`,
	];
}

export interface PatchExportOptions {
	/** @internal Deterministic destination race injection. */
	destination?: PatchDestinationOptions;
}

export async function exportPatch(
	client: SbxClient,
	state: SandboxState,
	directory: string,
	options: PatchExportOptions = {},
): Promise<PatchExport> {
	if (state.workspaceMode !== "clone")
		throw new Error("Patch export is only available in clone mode");
	try {
		await client.exec(state.name, ["git", "add", "-A"], {
			workdir: state.hostRoot,
		});
		const result = client.execBytes
			? await client.execBytes(
					state.name,
					[
						"git",
						"diff",
						"--cached",
						"--binary",
						"--full-index",
						state.hostBaseCommit,
					],
					{
						workdir: state.hostRoot,
						maxBuffer: MAX_PATCH_BYTES + 1,
					},
				)
			: await client.exec(
					state.name,
					[
						"git",
						"diff",
						"--cached",
						"--binary",
						"--full-index",
						state.hostBaseCommit,
					],
					{ workdir: state.hostRoot },
				);
		const patch = Buffer.isBuffer(result.stdout)
			? result.stdout
			: Buffer.from(result.stdout);
		assertPatchSize(patch.length);
		const patchText = patch.toString("utf8");
		if (
			/^diff --git a\/\.git(?:\/| )/m.test(patchText) ||
			/^\+\+\+ b\/\.git(?:\/|$)/m.test(patchText)
		)
			throw new Error("Refusing to export .git content");

		const prepared = await preparePatchFile(
			state.hostRoot,
			directory,
			`${safeTimestamp()}-${state.name}.patch`,
			options.destination,
		);
		let completed = false;
		try {
			try {
				await prepared.validateParent();
				await prepared.file.writeFile(patch);
				await prepared.file.sync();
				const [opened, current] = await Promise.all([
					prepared.file.stat(),
					lstat(prepared.path),
				]);
				if (
					!opened.isFile() ||
					opened.nlink !== 1 ||
					!sameIdentity(prepared.identity, opened) ||
					!sameIdentity(prepared.identity, current)
				)
					throw new Error("Patch file changed during write");
				await prepared.validateParent();
				await prepared.parent.sync().catch((cause) => {
					if (
						!["EINVAL", "ENOTSUP", "EBADF"].includes(
							(cause as NodeJS.ErrnoException).code ?? "",
						)
					)
						throw cause;
				});
				completed = true;
			} catch (cause) {
				const current = await lstat(prepared.path).catch(() => undefined);
				throw new PatchClaimError(
					cause,
					dirname(prepared.path),
					current && sameIdentity(prepared.identity, current)
						? prepared.path
						: undefined,
				);
			}
		} finally {
			if (!completed) await prepared.file.sync().catch(() => undefined);
			await prepared.file.close().catch(() => undefined);
			await prepared.closeParents();
		}
		let summary = ["Summary unavailable; inspect the patch before applying."];
		try {
			const summaryResult = await client.exec(
				state.name,
				["git", "diff", "--cached", "--numstat", state.hostBaseCommit],
				{ workdir: state.hostRoot },
			);
			summary = summaryResult.stdout
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) =>
					line
						.split("\t")
						.map((field) => sanitizeDetail(field))
						.join("\t"),
				);
		} catch {
			// The patch is already durable; summary metadata must not orphan it.
		}
		return { path: prepared.path, bytes: patch.length, summary };
	} catch (cause) {
		if (cause instanceof OperationError) throw cause;
		throw new OperationError({
			phase: "export-or-preserve",
			operation: "export sandbox patch",
			detail: patchFailureDetail(cause),
			recovery: patchRecovery(state, cause),
			cause,
		});
	}
}

export interface StablePatchOptions {
	/** @internal Deterministic race injection before opening the file. */
	beforeOpen?: (path: string) => Promise<void>;
	/** @internal Deterministic race injection after opening the file. */
	afterOpen?: (path: string) => Promise<void>;
}

export async function readStablePatch(
	path: string,
	maxBytes: number,
	options: StablePatchOptions = {},
): Promise<Buffer> {
	if (!path || /[\x00-\x1f\x7f]/.test(path))
		throw new TypeError("Patch path must be non-empty and control-free");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
		throw new TypeError("Patch byte limit must be a non-negative safe integer");
	for (const name of ["O_RDONLY", "O_NOFOLLOW", "O_NONBLOCK"] as const)
		if (typeof constants[name] !== "number")
			throw new Error(`Secure patch input is unsupported: ${name} unavailable`);
	const resolved = resolve(path);
	const discovered = await lstat(resolved);
	if (discovered.size > maxBytes)
		throw new Error(`Patch input exceeds ${maxBytes} byte limit`);
	if (
		discovered.isSymbolicLink() ||
		!discovered.isFile() ||
		discovered.nlink !== 1
	)
		throw new Error("Patch input must be a single-link regular file");
	const canonical = await realpath(resolved);
	await options.beforeOpen?.(resolved);
	const handle = await open(
		resolved,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const identity = await handle.stat();
		if (
			!identity.isFile() ||
			identity.nlink !== 1 ||
			identity.size > maxBytes ||
			!sameIdentity(identity, discovered)
		)
			throw new Error("Patch input changed while opening");
		await options.afterOpen?.(resolved);
		const reader: PositionedReader = (buffer, offset, length, position) =>
			handle.read(buffer, offset, length, position);
		const patch = await readBoundedExact(reader, maxBytes);
		const [opened, current, currentCanonical] = await Promise.all([
			handle.stat(),
			lstat(resolved),
			realpath(resolved),
		]);
		if (
			patch.length !== identity.size ||
			!opened.isFile() ||
			opened.nlink !== 1 ||
			opened.size !== identity.size ||
			current.isSymbolicLink() ||
			!current.isFile() ||
			current.nlink !== 1 ||
			current.size !== identity.size ||
			!sameIdentity(identity, opened) ||
			!sameIdentity(identity, current) ||
			currentCanonical !== canonical
		)
			throw new Error("Patch input changed during read");
		if (patch.length === 0) throw new Error("Patch input is empty");
		return patch;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

function assertApplyRepository(
	repository: RepositoryState,
	state: SandboxState,
): void {
	if (repository.identity !== state.hostRepoIdentity)
		throw new Error("Repository identity changed; refusing to apply patch");
	if (repository.head !== state.hostBaseCommit)
		throw new Error("Host HEAD changed; refusing to apply patch");
	if (repository.dirty)
		throw new Error("Host working tree is dirty; refusing to apply patch");
}

async function gitWithInput(
	runner: GitInputRunner,
	cwd: string,
	args: readonly string[],
	protectedPatch: Buffer,
	hash: string,
	stage: "verification" | "apply",
): Promise<void> {
	const stdin = Buffer.from(protectedPatch);
	let exitCode: number;
	try {
		const result: unknown = await runner(cwd, args, stdin);
		const code = (result as { code?: unknown } | null)?.code;
		exitCode =
			typeof code === "number" && Number.isSafeInteger(code) && code >= 0
				? code
				: 1;
	} catch (cause) {
		throw new OperationError({
			phase: "export-or-preserve",
			operation: stage === "verification" ? "verify patch" : "apply patch",
			exitCode: 1,
			detail:
				stage === "verification"
					? `Patch ${hash} failed Git verification`
					: `Patch ${hash} failed to apply`,
			recovery: ["git status --porcelain=v1"],
			cause,
		});
	}
	if (
		stdin.length !== protectedPatch.length ||
		createHash("sha256").update(stdin).digest("hex") !== hash ||
		!stdin.equals(protectedPatch)
	)
		throw new OperationError({
			phase: "export-or-preserve",
			operation: stage === "verification" ? "verify patch" : "apply patch",
			detail:
				stage === "verification"
					? `Patch ${hash} failed Git verification`
					: `Patch ${hash} failed to apply`,
			recovery: ["git status --porcelain=v1"],
		});
	if (exitCode !== 0)
		throw new OperationError({
			phase: "export-or-preserve",
			operation: stage === "verification" ? "verify patch" : "apply patch",
			exitCode,
			detail:
				stage === "verification"
					? `Patch ${hash} failed Git verification`
					: `Patch ${hash} failed to apply`,
			recovery: ["git status --porcelain=v1"],
		});
}

export async function applyPatch(
	state: SandboxState,
	patchPath: string,
	runner: GitInputRunner = runGitInput,
): Promise<void> {
	let patch: Buffer;
	try {
		patch = await readStablePatch(patchPath, MAX_PATCH_BYTES);
	} catch (cause) {
		throw new OperationError({
			phase: "prepare",
			operation: "read stable patch",
			detail:
				(cause as NodeJS.ErrnoException)?.code ??
				(cause instanceof Error ? cause.message : String(cause)),
			cause,
		});
	}
	const protectedPatch = Buffer.from(patch);
	const hash = createHash("sha256").update(protectedPatch).digest("hex");
	assertApplyRepository(await inspectRepository(state.hostRoot), state);
	await gitWithInput(
		runner,
		state.hostRoot,
		["apply", "--check", "--binary", "-"],
		protectedPatch,
		hash,
		"verification",
	);
	assertApplyRepository(await inspectRepository(state.hostRoot), state);
	await gitWithInput(
		runner,
		state.hostRoot,
		["apply", "--binary", "-"],
		protectedPatch,
		hash,
		"apply",
	);
}
