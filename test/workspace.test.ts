import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { formatError, OperationError } from "../src/errors.ts";
import type { SbxClient } from "../src/sbx/client.ts";
import {
	applyPatch,
	assertPatchSize,
	createEmptyInitialCommit,
	exportPatch,
	inspectRepository,
	MAX_PATCH_BYTES,
	preparePatchDestination,
	readBoundedExact,
	readStablePatch,
	loadSandboxState,
	removeSandboxState,
	sandboxName,
	saveSandboxState,
	statePath,
	UnbornHeadError,
	type GitInputRunner,
	type SandboxState,
} from "../src/workspace.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-git-"));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	await writeFile(join(root, "file.txt"), "before\n");
	await git(root, "add", "file.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

async function sandboxState(root: string): Promise<SandboxState> {
	const repositoryState = await inspectRepository(root);
	const now = new Date().toISOString();
	return {
		version: 2,
		phase: "ready",
		name: sandboxName(root),
		hostBaseCommit: repositoryState.head,
		hostBranch: repositoryState.branch,
		hostRepoIdentity: repositoryState.identity,
		hostWorktreeIdentity: root,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: now,
		updatedAt: now,
		runtimeImage: `example.invalid/runtime@sha256:${"a".repeat(64)}`,
		runtimeSchema: 1,
		packageVersion: "1.0.0",
	};
}

const gitInput: GitInputRunner = (cwd, args, stdin) =>
	new Promise((resolveResult) => {
		const child = execFile(
			"git",
			[...args],
			{ cwd, encoding: "utf8", maxBuffer: MAX_PATCH_BYTES },
			(error, stdout, stderr) =>
				resolveResult({
					stdout,
					stderr,
					code:
						typeof (error as { code?: unknown } | null)?.code === "number"
							? (error as unknown as { code: number }).code
							: error
								? 1
								: 0,
				}),
		);
		child.stdin?.end(stdin);
	});

test("unborn repositories are identified and can receive an explicit empty commit", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-unborn-"));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	await assert.rejects(
		() => inspectRepository(root),
		(error: unknown) => {
			assert.equal(error instanceof UnbornHeadError, true);
			assert.match((error as Error).message, /no initial commit/i);
			assert.deepEqual((error as OperationError).recovery, [
				'git commit --allow-empty --only -m "Initial commit"',
			]);
			return true;
		},
	);
	await createEmptyInitialCommit(root);
	assert.match((await inspectRepository(root)).head, /^[0-9a-f]{40,64}$/);
	assert.equal(await git(root, "rev-list", "--count", "HEAD"), "1");
	assert.equal(await git(root, "show", "--format=", "--name-only", "HEAD"), "");
});

test("empty initial commit never executes repository hooks", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-unborn-hooks-"));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	const marker = join(root, "hook-ran");
	const hook = join(root, ".git", "hooks", "pre-commit");
	await writeFile(hook, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`);
	await chmod(hook, 0o755);
	await createEmptyInitialCommit(root);
	await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("empty initial commit never executes repository signing programs", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-unborn-signing-"));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	const marker = join(root, "signing-program-ran");
	const signingProgram = join(root, "signing-program");
	await writeFile(
		signingProgram,
		`#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`,
	);
	await chmod(signingProgram, 0o755);
	await git(root, "config", "commit.gpgSign", "true");
	await git(root, "config", "gpg.program", signingProgram);
	await createEmptyInitialCommit(root);
	await assert.rejects(lstat(marker), { code: "ENOENT" });
	assert.equal(await git(root, "rev-list", "--count", "HEAD"), "1");
});

test("empty initial commit preserves staged content", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-staged-unborn-"));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	const path = join(root, "staged.bin");
	await writeFile(path, Buffer.from([0, 1, 2, 255]));
	await git(root, "add", "staged.bin");
	const statusBefore = await git(root, "status", "--porcelain=v1");
	const stagedBefore = await git(root, "ls-files", "--stage");
	const bytesBefore = await readFile(path);
	await createEmptyInitialCommit(root);
	assert.equal(await git(root, "rev-list", "--count", "HEAD"), "1");
	assert.equal(await git(root, "show", "--format=", "--name-only", "HEAD"), "");
	assert.equal(await git(root, "status", "--porcelain=v1"), statusBefore);
	assert.equal(await git(root, "ls-files", "--stage"), stagedBefore);
	assert.deepEqual(await readFile(path), bytesBefore);
});

test("repository inspection handles detached HEAD", async () => {
	const root = await repository();
	await git(root, "checkout", "--detach");
	const state = await inspectRepository(root);
	assert.equal(state.branch, "HEAD");
	assert.equal(state.head, await git(root, "rev-parse", "HEAD"));
});

test("failed unborn probes remain structured non-unborn errors", async () => {
	for (const failedOperation of ["symbolic-ref", "show-ref"]) {
		const runner = async (_cwd: string, args: readonly string[]) => {
			const operation = args[0];
			if (operation === "rev-parse" && args[1] === "--show-toplevel")
				return { stdout: "/repo\n", stderr: "", code: 0 };
			if (operation === "rev-parse")
				return { stdout: "", stderr: "missing HEAD", code: 128 };
			if (operation === "symbolic-ref")
				return failedOperation === operation
					? { stdout: "", stderr: "symbolic probe failed", code: 2 }
					: { stdout: "refs/heads/main\n", stderr: "", code: 0 };
			assert.equal(operation, "show-ref");
			return { stdout: "", stderr: "show-ref failed", code: 2 };
		};
		await assert.rejects(
			() => inspectRepository("/repo", runner),
			(error) => {
				assert.equal(error instanceof OperationError, true);
				assert.equal(error instanceof UnbornHeadError, false);
				return true;
			},
		);
	}
});

test("repository inspection and names are deterministic", async () => {
	const root = await repository();
	const state = await inspectRepository(root);
	assert.equal(state.root, await realpath(root));
	assert.equal(state.branch, "main");
	assert.equal(state.dirty, false);
	assert.equal(state.mainWorktree, true);
	assert.equal(sandboxName(root), sandboxName(root));
	assert.notEqual(sandboxName(root, true), sandboxName(root, true));
});

test("repository inspection never executes configured fsmonitor executables", async () => {
	const root = await repository();
	const marker = join(root, "fsmonitor-ran");
	const fsmonitor = join(root, "fsmonitor");
	await writeFile(fsmonitor, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
	await chmod(fsmonitor, 0o755);
	await git(root, "config", "core.fsmonitor", fsmonitor);
	await inspectRepository(root);
	await assert.rejects(lstat(marker), { code: "ENOENT" });
});

test("corrupt HEAD is not classified as unborn", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-corrupt-"));
	await git(root, "init", "-b", "main");
	await writeFile(
		join(root, ".git", "refs", "heads", "main"),
		"not-an-object\n",
	);
	await assert.rejects(
		() => inspectRepository(root),
		(error: unknown) => {
			assert.equal(error instanceof UnbornHeadError, false);
			assert.equal(error instanceof OperationError, true);
			return true;
		},
	);
});

test("repository failures are structured and secret-safe", async () => {
	const secret = "sk-test-1234567890abcdef";
	await assert.rejects(
		() =>
			inspectRepository("/repo", async () => ({
				stdout: "",
				stderr: `fatal: token=${secret}`,
				code: 128,
			})),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.equal(error.phase, "preflight");
			assert.equal(error.operation, "git rev-parse --show-toplevel");
			assert.equal(error.exitCode, 128);
			assert.equal(error.detail, "fatal: token=[redacted]");
			assert.equal(error.message.includes(secret), false);
			return true;
		},
	);
});

test("state writes replace atomically and corrupt state has recovery context", async () => {
	const root = await repository();
	const repositoryState = await inspectRepository(root);
	const name = sandboxName(root);
	const state: SandboxState = {
		version: 2,
		phase: "ready",
		name,
		hostBaseCommit: repositoryState.head,
		hostBranch: repositoryState.branch,
		hostRepoIdentity: repositoryState.identity,
		hostWorktreeIdentity: root,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: "2026-08-12T00:00:00.000Z",
		updatedAt: "2026-08-18T00:00:00.000Z",
		runtimeImage: `example.invalid/runtime@sha256:${"a".repeat(64)}`,
		runtimeSchema: 1,
		packageVersion: "1.0.0",
	};
	await saveSandboxState(state);
	await saveSandboxState({ ...state, hostBranch: "updated" });
	assert.equal((await loadSandboxState(root, name)).hostBranch, "updated");
	await assert.rejects(
		saveSandboxState({
			...state,
			imageAttestation: {
				status: "verified",
				image: `docker.io/pi-docker-sandboxes/pi:local-${"a".repeat(64)}`,
			},
		}),
		/imageAttestation\.image.*immutable/i,
	);
	assert.equal((await loadSandboxState(root, name)).hostBranch, "updated");
	const path = statePath(root, name);
	assert.deepEqual(
		(await readdir(resolve(path, ".."))).filter((entry) =>
			entry.endsWith(".tmp"),
		),
		[],
	);
	await writeFile(path, "{");
	await assert.rejects(
		() => loadSandboxState(root, name),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.match(
				error.message,
				new RegExp(path.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")),
			);
			assert.match(error.message, new RegExp(name));
			assert.match(error.detail ?? "", /unexported work may be lost/i);
			assert.match(error.recovery[0]!, /^cp /);
			assert.match(error.recovery[1]!, /^sbx exec /);
			assert.match(error.recovery[2]!, /^sbx rm --force /);
			assert.equal(
				error.recovery.some((command) => command.startsWith("pi-dsbx ")),
				false,
			);
			return true;
		},
	);
	assert.equal(await readFile(path, "utf8"), "{");
});

test("state writes reject symlinked control directories", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	const outside = await mkdtemp(join(tmpdir(), "pi-dsbx-state-outside-"));
	await symlink(outside, join(root, ".git", "pi-docker-sandbox"));
	await assert.rejects(
		saveSandboxState(state),
		/symlink|containment|directory/i,
	);
	await assert.rejects(lstat(join(outside, "state", `${state.name}.json`)), {
		code: "ENOENT",
	});
});

test("state removal rejects symlink, hardlink, and replacement races", async () => {
	for (const mutation of ["symlink", "hardlink", "replace"] as const) {
		const root = await repository();
		const state = await sandboxState(root);
		await saveSandboxState(state);
		const path = statePath(root, state.name);
		const outside = join(
			await mkdtemp(join(tmpdir(), "pi-dsbx-state-outside-")),
			"outside",
		);
		await writeFile(outside, "outside");
		if (mutation === "symlink") {
			await unlink(path);
			await symlink(outside, path);
		} else if (mutation === "hardlink") {
			await unlink(path);
			await exec("ln", [outside, path]);
		}
		await assert.rejects(
			removeSandboxState(root, state.name, {
				beforeUnlink:
					mutation === "replace"
						? async () => {
								await rename(path, `${path}.old`);
								await writeFile(path, "replacement");
							}
						: undefined,
			}),
			/file|identity/i,
		);
		assert.equal(await readFile(outside, "utf8"), "outside");
		if (mutation === "replace")
			assert.equal(await readFile(path, "utf8"), "replacement");
	}
});

test("state removal deletes only the guarded exact state and tolerates absence", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	await saveSandboxState(state);
	await removeSandboxState(root, state.name);
	await assert.rejects(readFile(statePath(root, state.name)));
	await removeSandboxState(root, state.name);
});

test("missing state recovery inspects before explicit discard", async () => {
	const root = await repository();
	const name = sandboxName(root);
	await assert.rejects(
		() => loadSandboxState(root, name),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.equal(error.recovery.length, 2);
			assert.equal(
				error.recovery.some((command) => /cp |pi-dsbx destroy/.test(command)),
				false,
			);
			assert.match(error.recovery[0]!, /^sbx exec /);
			assert.match(error.recovery[0]!, /'[^']+' git status --porcelain=v1$/);
			assert.match(error.recovery[1]!, /^sbx rm --force '[^']+'$/);
			assert.match(error.detail ?? "", /unexported work may be lost/i);
			return true;
		},
	);
});

test("state recovery quotes hostile repository paths and validates names first", async () => {
	const root = await repository();
	const hostileRoot = `${root} '$(touch pwned)' \`touch pwned\``;
	await exec("mv", [root, hostileRoot]);
	const name = sandboxName(hostileRoot);
	const path = statePath(hostileRoot, name);
	await mkdir(resolve(path, ".."), { recursive: true });
	await writeFile(path, "{");
	await assert.rejects(
		() => loadSandboxState(hostileRoot, name),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			const copy = error.recovery.find((command) => command.startsWith("cp "));
			assert.ok(copy);
			assert.match(copy, /'[^']*'"'"'[^']*'/);
			assert.match(copy, /'\$\(touch pwned\)'/);
			assert.equal(copy.startsWith("cp '"), true);
			assert.match(copy, /`touch pwned`\/\.git/);
			assert.match(error.recovery.join("\n"), new RegExp(`'${name}'`));
			return true;
		},
	);
	await assert.rejects(
		() => loadSandboxState(hostileRoot, "../../arbitrary"),
		/Invalid Docker Sandbox name/,
	);
});

test("patch apply verifies identity, base, and clean host", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	await writeFile(join(root, "file.txt"), "after\n");
	const patch = join(
		await mkdtemp(join(tmpdir(), "pi-dsbx-patch-")),
		"change.patch",
	);
	await writeFile(patch, `${await git(root, "diff", "--binary")}\n`);
	await git(root, "checkout", "--", "file.txt");
	await applyPatch(state, patch);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "after\n");
	await assert.rejects(() => applyPatch(state, patch), /dirty/);
});

test("patch apply checks and applies independent copies of protected bytes", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	await writeFile(join(root, "file.txt"), "original change\n");
	const original = Buffer.from(`${await git(root, "diff", "--binary")}\n`);
	await writeFile(join(root, "file.txt"), "replacement change\n");
	const replacement = Buffer.from(`${await git(root, "diff", "--binary")}\n`);
	await git(root, "checkout", "--", "file.txt");
	const patch = join(root, ".git", "original.patch");
	await writeFile(patch, original);
	const inputs: Buffer[] = [];
	const commands: string[][] = [];
	const runner: GitInputRunner = async (cwd, args, stdin) => {
		inputs.push(stdin);
		commands.push([...args]);
		const result = await gitInput(cwd, args, stdin);
		if (args.includes("--check")) await writeFile(patch, replacement);
		return result;
	};
	await applyPatch(state, patch, runner);
	assert.deepEqual(commands, [
		["apply", "--check", "--binary", "-"],
		["apply", "--binary", "-"],
	]);
	assert.equal(inputs.length, 2);
	assert.notEqual(inputs[0], inputs[1]);
	assert.deepEqual(inputs[0], original);
	assert.deepEqual(inputs[1], original);
	assert.equal(
		await readFile(join(root, "file.txt"), "utf8"),
		"original change\n",
	);
});

test("patch apply fails closed when a runner mutates verification input", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	await writeFile(join(root, "file.txt"), "after\n");
	const original = Buffer.from(`${await git(root, "diff", "--binary")}\n`);
	await git(root, "checkout", "--", "file.txt");
	const patch = join(root, ".git", "mutated.patch");
	await writeFile(patch, original);
	const commands: string[][] = [];
	await assert.rejects(
		() =>
			applyPatch(state, patch, async (_cwd, args, stdin) => {
				commands.push([...args]);
				stdin.fill(0x78);
				return { stdout: "", stderr: "", code: 0 };
			}),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.match(
				error.detail ?? "",
				/^Patch [0-9a-f]{64} failed Git verification$/,
			);
			assert.deepEqual(error.recovery, ["git status --porcelain=v1"]);
			return true;
		},
	);
	assert.deepEqual(commands, [["apply", "--check", "--binary", "-"]]);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "before\n");
});

test("retained mutated verification input cannot affect apply bytes", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	await writeFile(join(root, "file.txt"), "after\n");
	const original = Buffer.from(`${await git(root, "diff", "--binary")}\n`);
	await git(root, "checkout", "--", "file.txt");
	const patch = join(root, ".git", "retained.patch");
	await writeFile(patch, original);
	let retained: Buffer | undefined;
	const inputs: Buffer[] = [];
	await applyPatch(state, patch, async (cwd, args, stdin) => {
		inputs.push(stdin);
		if (args.includes("--check")) retained = stdin;
		else retained?.fill(0x78);
		return gitInput(cwd, args, stdin);
	});
	assert.notEqual(inputs[0], inputs[1]);
	assert.deepEqual(inputs[1], original);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "after\n");
});

test("stable patch reader rejects symlinks, hardlinks, non-regular files, and size overflow", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-stable-patch-"));
	const patch = join(root, "change.patch");
	await writeFile(patch, "patch\n");
	await symlink(patch, join(root, "symlink.patch"));
	await exec("ln", [patch, join(root, "hardlink.patch")]);
	await exec("mkfifo", [join(root, "fifo.patch")]);
	for (const path of [
		join(root, "symlink.patch"),
		join(root, "hardlink.patch"),
		join(root, "fifo.patch"),
	])
		await assert.rejects(() => readStablePatch(path, MAX_PATCH_BYTES));
	await writeFile(join(root, "exact.patch"), Buffer.alloc(MAX_PATCH_BYTES));
	assert.equal(
		(await readStablePatch(join(root, "exact.patch"), MAX_PATCH_BYTES)).length,
		MAX_PATCH_BYTES,
	);
	await writeFile(join(root, "large.patch"), Buffer.alloc(MAX_PATCH_BYTES + 1));
	await assert.rejects(
		() => readStablePatch(join(root, "large.patch"), MAX_PATCH_BYTES),
		/exceeds|maximum|large/i,
	);
});

test("stable patch reader rejects replacement before or after opening", async () => {
	for (const hook of ["beforeOpen", "afterOpen"] as const) {
		const root = await mkdtemp(join(tmpdir(), "pi-dsbx-stable-race-"));
		const patch = join(root, "change.patch");
		await writeFile(patch, "original\n");
		await assert.rejects(() =>
			readStablePatch(patch, MAX_PATCH_BYTES, {
				[hook]: async () => {
					await rename(patch, `${patch}.moved`);
					await writeFile(patch, "replacement\n");
				},
			}),
		);
		await unlink(patch);
	}
});

test("stable patch reader rejects missing, empty, and control-bearing paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-stable-invalid-"));
	const empty = join(root, "empty.patch");
	await writeFile(empty, "");
	await assert.rejects(() => readStablePatch(empty, MAX_PATCH_BYTES), /empty/i);
	await assert.rejects(() => readStablePatch("", MAX_PATCH_BYTES), /path/i);
	await assert.rejects(
		() => readStablePatch(`${root}/bad\n.patch`, MAX_PATCH_BYTES),
		/control/i,
	);
	await assert.rejects(() =>
		readStablePatch(join(root, "missing.patch"), MAX_PATCH_BYTES),
	);
});

test("runner failures expose only controlled patch diagnostics", async () => {
	for (const stage of ["check", "apply"] as const) {
		const root = await repository();
		const state = await sandboxState(root);
		await writeFile(join(root, "file.txt"), "after\n");
		const patchBytes = Buffer.from(`${await git(root, "diff", "--binary")}\n`);
		await git(root, "checkout", "--", "file.txt");
		const patch = join(root, ".git", `${stage}-throw.patch`);
		await writeFile(patch, patchBytes);
		const sentinel = "runner sentinel ordinary text";
		const derived = patchBytes.subarray(0, 24).toString("utf8");
		let calls = 0;
		await assert.rejects(
			() =>
				applyPatch(state, patch, async (cwd, args, stdin) => {
					calls += 1;
					if (stage === "check" || !args.includes("--check"))
						throw new Error(`${sentinel}: ${derived}`);
					return gitInput(cwd, args, stdin);
				}),
			(error: unknown) => {
				assert.ok(error instanceof OperationError);
				const formatted = formatError(error);
				for (const output of [error.message, error.detail, formatted]) {
					assert.equal(output?.includes(sentinel), false);
					assert.equal(output?.includes(derived), false);
				}
				assert.match(
					error.detail ?? "",
					stage === "check"
						? /^Patch [0-9a-f]{64} failed Git verification$/
						: /^Patch [0-9a-f]{64} failed to apply$/,
				);
				assert.deepEqual(error.recovery, ["git status --porcelain=v1"]);
				return true;
			},
		);
		assert.equal(calls, stage === "check" ? 1 : 2);
		assert.equal(await readFile(join(root, "file.txt"), "utf8"), "before\n");
	}
});

test("runner nonzero exits retain safe status without output", async () => {
	for (const stage of ["check", "apply"] as const) {
		const root = await repository();
		const state = await sandboxState(root);
		await writeFile(join(root, "file.txt"), "after\n");
		const bytes = Buffer.from(`${await git(root, "diff", "--binary")}\n`);
		await git(root, "checkout", "--", "file.txt");
		const patch = join(root, ".git", `${stage}-exit.patch`);
		await writeFile(patch, bytes);
		let calls = 0;
		await assert.rejects(
			() =>
				applyPatch(state, patch, async (cwd, args, stdin) => {
					calls += 1;
					if (stage === "check" || !args.includes("--check"))
						return {
							stdout: "patch-derived output",
							stderr: "runner sentinel ordinary text",
							code: 73,
						};
					return gitInput(cwd, args, stdin);
				}),
			(error: unknown) => {
				assert.ok(error instanceof OperationError);
				assert.equal(error.exitCode, 73);
				assert.match(error.message, /\(exit 73\)$/);
				assert.equal(formatError(error).includes("runner sentinel"), false);
				assert.equal(formatError(error).includes("patch-derived"), false);
				assert.match(
					error.detail ?? "",
					stage === "check"
						? /^Patch [0-9a-f]{64} failed Git verification$/
						: /^Patch [0-9a-f]{64} failed to apply$/,
				);
				assert.deepEqual(error.recovery, ["git status --porcelain=v1"]);
				return true;
			},
		);
		assert.equal(calls, stage === "check" ? 1 : 2);
	}
});

test("malformed runner status becomes controlled exit 1", async () => {
	const sentinel = "hostile runner status sentinel";
	const malformed: unknown[] = [
		{ code: sentinel },
		{ code: Number.NaN },
		{ code: Number.POSITIVE_INFINITY },
		{ code: -1 },
		{ code: 1.5 },
		{},
		{ code: { sentinel } },
		new Proxy(
			{},
			{
				get(_target, key) {
					if (key === "code") throw new Error(sentinel);
					return undefined;
				},
			},
		),
	];
	for (const result of malformed) {
		const root = await repository();
		const state = await sandboxState(root);
		await writeFile(join(root, "file.txt"), "after\n");
		const patch = join(root, ".git", "malformed-status.patch");
		await writeFile(patch, `${await git(root, "diff", "--binary")}\n`);
		await git(root, "checkout", "--", "file.txt");
		await assert.rejects(
			() =>
				applyPatch(
					state,
					patch,
					async () =>
						result as ReturnType<GitInputRunner> extends Promise<infer R>
							? R
							: never,
				),
			(error: unknown) => {
				assert.ok(error instanceof OperationError);
				assert.equal(error.exitCode, 1);
				assert.match(error.message, /\(exit 1\)$/);
				assert.match(
					error.detail ?? "",
					/^Patch [0-9a-f]{64} failed Git verification$/,
				);
				assert.equal(formatError(error).includes(sentinel), false);
				assert.deepEqual(error.recovery, ["git status --porcelain=v1"]);
				return true;
			},
		);
	}
});

test("valid runner status zero and seven retain their behavior", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	await writeFile(join(root, "file.txt"), "after\n");
	const patch = join(root, ".git", "valid-status.patch");
	await writeFile(patch, `${await git(root, "diff", "--binary")}\n`);
	await git(root, "checkout", "--", "file.txt");
	await assert.rejects(
		() =>
			applyPatch(state, patch, async () => ({
				stdout: "",
				stderr: "ignored",
				code: 7,
			})),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.equal(error.exitCode, 7);
			return true;
		},
	);
	await applyPatch(state, patch);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "after\n");
});

test("patch check failure is controlled and never invokes apply", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	const patch = join(root, ".git", "invalid.patch");
	await writeFile(patch, "not a diff\n");
	const secret = "sk-test-1234567890abcdef";
	const commands: string[][] = [];
	await assert.rejects(
		() =>
			applyPatch(state, patch, async (_cwd, args) => {
				commands.push([...args]);
				return { stdout: "", stderr: `fatal: token=${secret}`, code: 128 };
			}),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.match(
				error.detail ?? "",
				/^Patch [0-9a-f]{64} failed Git verification$/,
			);
			assert.equal(formatError(error).includes(secret), false);
			return true;
		},
	);
	assert.deepEqual(commands, [["apply", "--check", "--binary", "-"]]);
	assert.equal(await git(root, "status", "--porcelain=v1"), "");
});

test("patch apply rejects initial identity and HEAD drift before invoking git apply", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	const patch = join(root, ".git", "change.patch");
	await writeFile(join(root, "file.txt"), "after\n");
	await writeFile(patch, `${await git(root, "diff", "--binary")}\n`);
	await git(root, "checkout", "--", "file.txt");
	for (const invalid of [
		{ ...state, hostRepoIdentity: "different" },
		{ ...state, hostBaseCommit: "0".repeat(state.hostBaseCommit.length) },
	]) {
		let invoked = false;
		await assert.rejects(
			() =>
				applyPatch(invalid, patch, async () => {
					invoked = true;
					return { stdout: "", stderr: "", code: 0 };
				}),
			/changed/i,
		);
		assert.equal(invoked, false);
	}
});

test("patch apply aborts when host state drifts after check", async () => {
	for (const drift of ["dirty", "head", "identity"] as const) {
		const root = await repository();
		const state = await sandboxState(root);
		await writeFile(join(root, "file.txt"), "after\n");
		const patch = join(root, ".git", `${drift}.patch`);
		await writeFile(patch, `${await git(root, "diff", "--binary")}\n`);
		await git(root, "checkout", "--", "file.txt");
		let calls = 0;
		await assert.rejects(
			() =>
				applyPatch(state, patch, async (cwd, args, stdin) => {
					calls += 1;
					const result = await gitInput(cwd, args, stdin);
					if (args.includes("--check")) {
						if (drift === "dirty")
							await writeFile(join(root, "drift.txt"), "dirty\n");
						else if (drift === "head")
							await git(root, "commit", "--allow-empty", "-m", "drift");
						else
							await git(
								root,
								"remote",
								"add",
								"origin",
								"https://example.com/other.git",
							);
					}
					return result;
				}),
			/changed|dirty/i,
		);
		assert.equal(calls, 1);
		assert.equal(await readFile(join(root, "file.txt"), "utf8"), "before\n");
	}
});

test("real binary patch round trip uses stdin bytes", async () => {
	const root = await repository();
	const state = await sandboxState(root);
	const binary = join(root, "binary.bin");
	await writeFile(binary, Buffer.from([0, 1, 2, 3, 255]));
	await git(root, "add", "binary.bin");
	await git(root, "commit", "-m", "binary base");
	const binaryState = await sandboxState(root);
	const changed = Buffer.from([255, 4, 0, 5, 6, 7]);
	await writeFile(binary, changed);
	const patch = join(root, ".git", "binary.patch");
	await writeFile(
		patch,
		(
			await exec("git", ["diff", "--binary", "--full-index"], {
				cwd: root,
				encoding: "buffer",
			})
		).stdout,
	);
	await git(root, "checkout", "--", "binary.bin");
	await applyPatch(binaryState, patch);
	assert.deepEqual(await readFile(binary), changed);
	assert.notEqual(state.hostBaseCommit, binaryState.hostBaseCommit);
});

test("patch destinations reject escaping paths and symlink components", async () => {
	const root = await repository();
	const outside = await mkdtemp(join(tmpdir(), "pi-dsbx-outside-"));
	await symlink(outside, join(root, "exports"));
	await mkdir(join(root, "safe"));
	await symlink(outside, join(root, "safe", "linked"));
	for (const directory of [
		"exports",
		"safe/linked/patches",
		outside,
		"../outside",
		"safe/../outside",
		"safe\npatches",
	]) {
		await assert.rejects(() =>
			preparePatchDestination(root, directory, "change.patch"),
		);
	}
	assert.deepEqual(await readdir(outside), []);
});

test("patch destinations create private directories and exclusive regular files", async () => {
	const root = await repository();
	const directory = ".git/pi-docker-sandbox/patches";
	const path = await preparePatchDestination(root, directory, "change.patch");
	assert.equal(path, await realpath(join(root, directory, "change.patch")));
	assert.equal((await stat(join(root, directory))).mode & 0o777, 0o700);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal((await lstat(path)).isFile(), true);
	await assert.rejects(() =>
		preparePatchDestination(root, directory, "change.patch"),
	);
	await symlink(join(root, "file.txt"), join(root, directory, "linked.patch"));
	await assert.rejects(() =>
		preparePatchDestination(root, directory, "linked.patch"),
	);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "before\n");
});

test("patch destination detects parent replacement and leaves outside untouched", async () => {
	const root = await repository();
	const outside = await mkdtemp(join(tmpdir(), "pi-dsbx-parent-race-"));
	const original = join(root, "patches");
	const moved = join(root, "patches-moved");
	await mkdir(original);
	await assert.rejects(() =>
		preparePatchDestination(root, "patches", "change.patch", {
			beforeCreate: async () => {
				await rename(original, moved);
				await symlink(outside, original);
			},
		}),
	);
	assert.deepEqual(await readdir(outside), []);
	assert.deepEqual(await readdir(moved), []);
});

test("unsupported patch directory sync fails closed and retains the claimed artifact", async () => {
	const root = await repository();
	const path = join(root, "patches", "unsynced.patch");
	await assert.rejects(
		() =>
			preparePatchDestination(root, "patches", "unsynced.patch", {
				syncDirectory: async () => {
					throw Object.assign(new Error("unsupported directory sync"), {
						code: "EINVAL",
					});
				},
			}),
		/unsupported directory sync/,
	);
	assert.equal((await lstat(path)).isFile(), true);
});

test("failed patch claims are retained rather than removed by pathname", async () => {
	const root = await repository();
	const path = join(root, "patches", "partial.patch");
	await mkdir(join(root, "patches"));
	await assert.rejects(() =>
		preparePatchDestination(root, "patches", "partial.patch", {
			afterCreate: async () => {
				throw new Error("injected post-claim failure");
			},
		}),
	);
	assert.equal((await lstat(path)).isFile(), true);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("patch destination never removes a replacement after final creation", async () => {
	const root = await repository();
	const directory = join(root, "patches");
	const original = join(directory, "change.patch");
	const moved = join(directory, "original.patch");
	await mkdir(directory);
	await assert.rejects(() =>
		preparePatchDestination(root, "patches", "change.patch", {
			afterCreate: async () => {
				await rename(original, moved);
				await writeFile(original, "replacement\n");
			},
		}),
	);
	assert.equal(await readFile(original, "utf8"), "replacement\n");
});

test("patch size limit accepts exact maximum and rejects one byte over", () => {
	assert.doesNotThrow(() => assertPatchSize(MAX_PATCH_BYTES));
	assert.throws(() => assertPatchSize(MAX_PATCH_BYTES + 1), /exceeds.*limit/);
});

test("default export uses each linked worktree gitdir without touching the main worktree", async () => {
	const main = await repository();
	const linked = await mkdtemp(join(tmpdir(), "pi-dsbx-linked-parent-"));
	await git(main, "worktree", "add", "-b", "linked", linked);
	const primaryPath = await preparePatchDestination(
		main,
		".git/pi-docker-sandbox/patches",
		"primary.patch",
	);
	const linkedPath = await preparePatchDestination(
		linked,
		".git/pi-docker-sandbox/patches",
		"linked.patch",
	);
	const primaryGit = await git(main, "rev-parse", "--absolute-git-dir");
	const linkedGit = await git(linked, "rev-parse", "--absolute-git-dir");
	assert.equal(
		primaryPath,
		join(primaryGit, "pi-docker-sandbox/patches/primary.patch"),
	);
	assert.equal(
		linkedPath,
		join(linkedGit, "pi-docker-sandbox/patches/linked.patch"),
	);
	assert.notEqual(linkedGit, primaryGit);
	assert.equal(await readFile(join(main, "file.txt"), "utf8"), "before\n");
});

test("linked worktree rejects gitfiles reassociated with primary or another worktree", async () => {
	const main = await repository();
	const linked = await mkdtemp(join(tmpdir(), "pi-dsbx-linked-parent-"));
	const other = await mkdtemp(join(tmpdir(), "pi-dsbx-linked-other-"));
	await git(main, "worktree", "add", "-b", "linked", linked);
	await git(main, "worktree", "add", "-b", "other", other);
	const primaryGit = await git(main, "rev-parse", "--absolute-git-dir");
	const otherGit = await git(other, "rev-parse", "--absolute-git-dir");
	for (const target of [primaryGit, otherGit]) {
		await writeFile(join(linked, ".git"), `gitdir: ${target}\n`);
		await assert.rejects(() =>
			preparePatchDestination(
				linked,
				".git/pi-docker-sandbox/patches",
				"blocked.patch",
			),
		);
		assert.equal(
			await lstat(join(target, "pi-docker-sandbox/patches/blocked.patch"))
				.then(() => true)
				.catch(() => false),
			false,
		);
	}
});

test("bounded exact reader reconstructs deterministic short reads", async () => {
	const original = Buffer.from("gitdir: /tmp/example\n");
	const reads: number[] = [];
	const reader = async (
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	) => {
		reads.push(position);
		const bytesRead = Math.min(
			(position % 3) + 1,
			length,
			original.length - position,
		);
		if (bytesRead > 0)
			original.copy(buffer, offset, position, position + bytesRead);
		return { bytesRead: Math.max(0, bytesRead) };
	};
	assert.deepEqual(await readBoundedExact(reader, original.length), original);
	assert.deepEqual(
		reads,
		[0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18, 19, 21],
	);
	const changed = Buffer.from(original);
	changed[3] ^= 1;
	let changedOffset = 0;
	const changedReader = async (
		buffer: Buffer,
		offset: number,
		length: number,
		_position: number,
	) => {
		const bytesRead = Math.min(2, length, changed.length - changedOffset);
		if (bytesRead > 0)
			changed.copy(buffer, offset, changedOffset, changedOffset + bytesRead);
		changedOffset += Math.max(0, bytesRead);
		return { bytesRead: Math.max(0, bytesRead) };
	};
	assert.notDeepEqual(
		await readBoundedExact(changedReader, original.length),
		original,
	);
});

test("linked worktree rejects stable guardian truncation and growth", async () => {
	for (const mutation of [Buffer.from("x"), Buffer.alloc(4097, 0x78)]) {
		const main = await repository();
		const linked = await mkdtemp(join(tmpdir(), "pi-dsbx-linked-parent-"));
		await git(
			main,
			"worktree",
			"add",
			"-b",
			`linked-${mutation.length}`,
			linked,
		);
		const linkedGit = await git(linked, "rev-parse", "--absolute-git-dir");
		const guardianPath = join(linked, ".git");
		const original = await readFile(guardianPath);
		await assert.rejects(() =>
			preparePatchDestination(
				linked,
				".git/pi-docker-sandbox/patches",
				"blocked.patch",
				{ beforeCreate: async () => writeFile(guardianPath, mutation) },
			),
		);
		assert.equal(
			await lstat(join(linkedGit, "pi-docker-sandbox/patches/blocked.patch"))
				.then(() => true)
				.catch(() => false),
			false,
		);
		await writeFile(guardianPath, original);
	}
});

test("linked worktree rejects in-place guardian content rewrites", async () => {
	for (const guardian of ["gitfile", "back-reference"] as const) {
		const main = await repository();
		const linked = await mkdtemp(join(tmpdir(), "pi-dsbx-linked-parent-"));
		const other = await mkdtemp(join(tmpdir(), "pi-dsbx-linked-other-"));
		await git(main, "worktree", "add", "-b", `linked-${guardian}`, linked);
		await git(main, "worktree", "add", "-b", `other-${guardian}`, other);
		const linkedGit = await git(linked, "rev-parse", "--absolute-git-dir");
		const guardianPath =
			guardian === "gitfile" ? join(linked, ".git") : join(linkedGit, "gitdir");
		const original = await readFile(guardianPath);
		let mutated =
			guardian === "gitfile"
				? Buffer.from(
						`gitdir: ${await git(other, "rev-parse", "--absolute-git-dir")}\n`,
					)
				: Buffer.from(`${join(other, ".git")}\n`);
		if (mutated.length !== original.length)
			mutated = Buffer.concat([
				mutated.subarray(0, Math.min(mutated.length, original.length)),
				Buffer.alloc(Math.max(0, original.length - mutated.length), 0x20),
			]);
		assert.equal(mutated.length, original.length);
		await assert.rejects(
			() =>
				preparePatchDestination(
					linked,
					".git/pi-docker-sandbox/patches",
					"blocked.patch",
					{
						beforeCreate: async () => {
							await writeFile(guardianPath, mutated);
						},
					},
				),
			(error: unknown) => {
				assert.equal(String(error).includes(mutated.toString("utf8")), false);
				assert.doesNotMatch(String(error), /gitdir:|pi-dsbx-linked-other/);
				return true;
			},
		);
		assert.equal(
			await lstat(join(linkedGit, "pi-docker-sandbox/patches/blocked.patch"))
				.then(() => true)
				.catch(() => false),
			false,
		);
		await writeFile(guardianPath, original);
	}
});

test("linked worktree default rejects symlinks beneath its resolved gitdir", async () => {
	const main = await repository();
	const linked = await mkdtemp(join(tmpdir(), "pi-dsbx-linked-parent-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-dsbx-linked-outside-"));
	await git(main, "worktree", "add", "-b", "linked", linked);
	const linkedGit = await git(linked, "rev-parse", "--absolute-git-dir");
	await symlink(outside, join(linkedGit, "pi-docker-sandbox"));
	await assert.rejects(() =>
		preparePatchDestination(
			linked,
			".git/pi-docker-sandbox/patches",
			"linked.patch",
		),
	);
	assert.deepEqual(await readdir(outside), []);
});

test("patch destination rejects unavailable no-follow support", async () => {
	const root = await repository();
	await assert.rejects(
		() =>
			preparePatchDestination(root, "patches", "change.patch", {
				constants: { ...constants, O_NOFOLLOW: undefined },
			}),
		/O_NOFOLLOW.*unavailable/,
	);
});

test("patch export enforces MAX bytes before destination creation", async () => {
	const root = await repository();
	const repositoryState = await inspectRepository(root);
	const state: SandboxState = {
		version: 1,
		name: sandboxName(root),
		hostBaseCommit: repositoryState.head,
		hostBranch: repositoryState.branch,
		hostRepoIdentity: repositoryState.identity,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: new Date().toISOString(),
	};
	let requestedMaxBuffer = 0;
	const fake = (size: number) =>
		({
			exec: async (_name: string, argv: readonly string[]) => ({
				stdout: argv.includes("--numstat") ? "" : "",
				stderr: "",
				code: 0,
			}),
			execBytes: async (
				_name: string,
				_argv: readonly string[],
				options: { maxBuffer?: number },
			) => {
				requestedMaxBuffer = options.maxBuffer ?? 0;
				return { stdout: Buffer.alloc(size), stderr: "", code: 0 };
			},
		}) as unknown as SbxClient;
	const exact = await exportPatch(
		fake(MAX_PATCH_BYTES),
		state,
		"exact-patches",
	);
	assert.equal(exact.bytes, MAX_PATCH_BYTES);
	assert.equal(requestedMaxBuffer, MAX_PATCH_BYTES + 1);
	await assert.rejects(() =>
		exportPatch(fake(MAX_PATCH_BYTES + 1), state, "oversized-patches"),
	);
	assert.equal(
		await lstat(join(root, "oversized-patches"))
			.then(() => true)
			.catch(() => false),
		false,
	);
});

test("patch export writes exact Buffer bytes through retained handle", async () => {
	const root = await repository();
	const repositoryState = await inspectRepository(root);
	const state: SandboxState = {
		version: 1,
		name: sandboxName(root),
		hostBaseCommit: repositoryState.head,
		hostBranch: repositoryState.branch,
		hostRepoIdentity: repositoryState.identity,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: new Date().toISOString(),
	};
	const patch = Buffer.from([0, 1, 2, 255]);
	const fake = {
		exec: async (_name: string, argv: readonly string[]) => ({
			stdout: argv.includes("--numstat") ? "1\t0\tfile.bin\n" : "",
			stderr: "",
			code: 0,
		}),
		execBytes: async () => ({ stdout: patch, stderr: "", code: 0 }),
	} as unknown as SbxClient;
	const result = await exportPatch(fake, state, "patches");
	assert.deepEqual(await readFile(result.path), patch);
	assert.equal(result.bytes, patch.length);
	assert.equal((await stat(result.path)).mode & 0o777, 0o600);
});

test("changed export pathname recovery uses no untrusted directory command", async () => {
	const root = await repository();
	const repositoryState = await inspectRepository(root);
	const state: SandboxState = {
		version: 1,
		name: sandboxName(root),
		hostBaseCommit: repositoryState.head,
		hostBranch: repositoryState.branch,
		hostRepoIdentity: repositoryState.identity,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: new Date().toISOString(),
	};
	const fake = {
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		execBytes: async () => ({
			stdout: Buffer.from("patch"),
			stderr: "",
			code: 0,
		}),
	} as unknown as SbxClient;
	await assert.rejects(
		() =>
			exportPatch(fake, state, "hostile '$(touch nope)'", {
				destination: {
					afterCreate: async (_directory, path) => {
						await rename(path, `${path}.moved`);
					},
				},
			}),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.equal(
				error.recovery.some((command) => command.startsWith("find ")),
				false,
			);
			assert.match(
				error.recovery.join("\n"),
				/The export pathname changed; inspect the sandbox and Git worktree manually before retrying\./,
			);
			assert.equal(error.recovery.join("\n").includes("touch nope"), false);
			return true;
		},
	);
});

test("patch export detects final replacement and preserves replacement", async () => {
	const root = await repository();
	const repositoryState = await inspectRepository(root);
	const state: SandboxState = {
		version: 1,
		name: sandboxName(root),
		hostBaseCommit: repositoryState.head,
		hostBranch: repositoryState.branch,
		hostRepoIdentity: repositoryState.identity,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: new Date().toISOString(),
	};
	const fake = {
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		execBytes: async () => ({
			stdout: Buffer.from("patch"),
			stderr: "",
			code: 0,
		}),
	} as unknown as SbxClient;
	let replacement = "";
	await assert.rejects(() =>
		exportPatch(fake, state, "patches", {
			destination: {
				afterCreate: async (_directory, path) => {
					await rename(path, `${path}.original`);
					await writeFile(path, "replacement\n");
					replacement = path;
				},
			},
		}),
	);
	assert.equal(await readFile(replacement, "utf8"), "replacement\n");
});

test("numstat failure returns the successful patch with safe fallback summary", async () => {
	const root = await repository();
	const repositoryState = await inspectRepository(root);
	const state: SandboxState = {
		version: 1,
		name: sandboxName(root),
		hostBaseCommit: repositoryState.head,
		hostBranch: repositoryState.branch,
		hostRepoIdentity: repositoryState.identity,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: new Date().toISOString(),
	};
	const fake = {
		exec: async (_name: string, argv: readonly string[]) => {
			if (argv.includes("--numstat")) throw new Error("summary failed");
			return { stdout: "", stderr: "", code: 0 };
		},
		execBytes: async () => ({
			stdout: Buffer.from("diff --git a/file.txt b/file.txt\n"),
			stderr: "",
			code: 0,
		}),
	} as unknown as SbxClient;
	const result = await exportPatch(fake, state, "patches");
	assert.deepEqual(result.summary, [
		"Summary unavailable; inspect the patch before applying.",
	]);
	assert.equal((await lstat(result.path)).isFile(), true);
});

test("patch export uses sandbox-only staging and blocks .git content", async () => {
	const root = await repository();
	const repositoryState = await inspectRepository(root);
	const state: SandboxState = {
		version: 1,
		name: sandboxName(root),
		hostBaseCommit: repositoryState.head,
		hostBranch: repositoryState.branch,
		hostRepoIdentity: repositoryState.identity,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: new Date().toISOString(),
	};
	const calls: string[][] = [];
	const fake = {
		exec: async (_name: string, argv: readonly string[]) => {
			calls.push([...argv]);
			if (argv.includes("--numstat"))
				return { stdout: "1\t0\tfile.txt\n", stderr: "", code: 0 };
			if (argv.includes("--binary"))
				return {
					stdout: "diff --git a/file.txt b/file.txt\n",
					stderr: "",
					code: 0,
				};
			return { stdout: "", stderr: "", code: 0 };
		},
	} as unknown as SbxClient;
	const result = await exportPatch(fake, state, ".pi/docker-sandbox/patches");
	assert.ok(result.bytes > 0);
	assert.deepEqual(result.summary, ["1\t0\tfile.txt"]);
	assert.deepEqual(calls[0], ["git", "add", "-A"]);

	const malicious = {
		exec: async () => ({
			stdout: "diff --git a/.git/hooks/x b/.git/hooks/x\n",
			stderr: "",
			code: 0,
		}),
	} as unknown as SbxClient;
	await assert.rejects(
		() => exportPatch(malicious, state, ".pi/docker-sandbox/patches"),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.equal(error.phase, "export-or-preserve");
			assert.match(error.detail ?? "", /\.git content/);
			return true;
		},
	);
});
