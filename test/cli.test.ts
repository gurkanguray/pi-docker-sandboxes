import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdtemp,
	readFile,
	realpath,
	symlink,
	writeFile,
	access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createLaunchReporter, createPausedConfirm, main } from "../src/cli.ts";
import { acquireSandboxLease, LEASE_BUSY_EXIT_CODE } from "../src/lease.ts";
import {
	inspectRepository,
	sandboxName,
	saveSandboxState,
	statePath,
} from "../src/workspace.ts";

const exec = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

async function fixture(
	options: { git?: boolean; state?: boolean } = { git: true, state: true },
): Promise<{ root: string; bin: string; log: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-cli-destroy-"));
	if (options.git !== false) {
		await exec("git", ["init", "-b", "main"], { cwd: root });
		await exec("git", ["config", "user.email", "test@example.com"], {
			cwd: root,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: root });
		await writeFile(join(root, "file.txt"), "initial\n");
		await exec("git", ["add", "file.txt"], { cwd: root });
		await exec("git", ["commit", "-m", "initial"], { cwd: root });
	}
	const canonical = await realpath(root);
	if (options.git !== false && options.state !== false) {
		const repository = await inspectRepository(canonical);
		const name = sandboxName(canonical);
		await saveSandboxState({
			version: 1,
			name,
			hostBaseCommit: repository.head,
			hostBranch: repository.branch,
			hostRepoIdentity: repository.identity,
			hostRoot: canonical,
			workspaceMode: "clone",
			createdAt: "2026-08-12T00:00:00.000Z",
		});
	}
	const bin = join(root, "bin");
	const log = join(root, "sbx.log");
	await exec("mkdir", ["-p", bin]);
	const script = join(bin, "sbx");
	await writeFile(
		script,
		`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.FAKE_SBX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.argv[2] === "exec") process.stdout.write(process.env.FAKE_DIRTY === "1" ? " M file.txt\\n" : "");\n`,
	);
	await chmod(script, 0o755);
	return { root: canonical, bin, log };
}

async function runCli(
	subject: Awaited<ReturnType<typeof fixture>>,
	command: "export" | "apply" | "destroy",
	args: string[],
	dirty: boolean,
): Promise<{ code: number; stderr: string; calls: string[][] }> {
	try {
		await exec(
			process.execPath,
			["--experimental-strip-types", cli, command, ...args],
			{
				cwd: subject.root,
				env: {
					...process.env,
					PATH: `${subject.bin}:${process.env.PATH}`,
					FAKE_SBX_LOG: subject.log,
					FAKE_DIRTY: dirty ? "1" : "0",
				},
			},
		);
		return {
			code: 0,
			stderr: "",
			calls: (await readFile(subject.log, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		};
	} catch (cause) {
		const error = cause as { code: number; stderr: string };
		let calls: string[][] = [];
		try {
			calls = (await readFile(subject.log, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			calls = [];
		}
		return { code: error.code, stderr: error.stderr, calls };
	}
}

function runDestroy(
	subject: Awaited<ReturnType<typeof fixture>>,
	args: string[],
	dirty: boolean,
): ReturnType<typeof runCli> {
	return runCli(subject, "destroy", args, dirty);
}

test("all management mutations contend on the sandbox lifecycle lease", async () => {
	for (const [command, args] of [
		["export", []],
		["apply", ["change.patch", "--yes"]],
		["destroy", ["--yes"]],
	] as const) {
		const subject = await fixture();
		const held = await acquireSandboxLease(
			subject.root,
			sandboxName(subject.root),
			"run",
		);
		try {
			const result = await runCli(subject, command, [...args], false);
			assert.equal(result.code, LEASE_BUSY_EXIT_CODE, result.stderr);
			assert.match(result.stderr, /busy.*run/i);
			assert.deepEqual(result.calls, []);
		} finally {
			await held.release();
		}
	}
});

test("management commands reject trailing arguments", async () => {
	const destroyed = await runCli(
		await fixture(),
		"destroy",
		["--discard-changes", "trailing"],
		false,
	);
	assert.equal(destroyed.code, 1);
	assert.match(destroyed.stderr, /unexpected argument/i);

	const exported = await runCli(await fixture(), "export", ["trailing"], false);
	assert.equal(exported.code, 1);
	assert.match(exported.stderr, /unexpected argument/i);

	const appliedFixture = await fixture();
	await writeFile(join(appliedFixture.root, "file.txt"), "changed\n");
	const patch = join(appliedFixture.root, "change.patch");
	await writeFile(
		patch,
		(await exec("git", ["diff", "--binary"], { cwd: appliedFixture.root }))
			.stdout,
	);
	await exec("git", ["checkout", "--", "file.txt"], {
		cwd: appliedFixture.root,
	});
	const applied = await runCli(
		appliedFixture,
		"apply",
		[patch, "trailing", "--yes"],
		false,
	);
	assert.equal(applied.code, 1);
	assert.match(applied.stderr, /unexpected argument/i);
});

test("CLI help documents passing Pi session arguments after the separator", async () => {
	const output: string[] = [];
	const originalLog = console.log;
	console.log = (message?: unknown) => output.push(String(message));
	try {
		assert.equal(await main(["--help"]), 0);
	} finally {
		console.log = originalLog;
	}
	assert.match(output.join("\n"), /pi-dsbx run[^\n]*-- PI_ARGS/);
	assert.match(output.join("\n"), /-- --session ID/);
});

test("symlinked CLI entry executes its main function", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-cli-symlink-"));
	const link = join(directory, "pi-dsbx.ts");
	await symlink(await realpath(cli), link);
	const { stdout } = await exec(process.execPath, [
		"--experimental-strip-types",
		link,
		"--help",
	]);
	assert.match(stdout, /Usage:/);
});

test("status lines stop heartbeats at terminal handoff", () => {
	const output: string[] = [];
	const timers = new Map<number, { cb: () => void; ms: number }>();
	let nextTimer = 0;
	let now = 0;
	const reporter = createLaunchReporter(
		(message) => output.push(message),
		{
			now: () => now,
			setInterval: (cb, ms) => {
				const id = ++nextTimer;
				timers.set(id, { cb: cb as () => void, ms });
				return id as unknown as NodeJS.Timeout;
			},
			clearInterval: (id) => {
				timers.delete(id as unknown as number);
			},
		},
		true,
	);
	reporter.onStatus("installing compiler");
	assert.equal(output.at(-1)?.startsWith("!"), false);
	assert.match(output.at(-1) ?? "", /^pi-dsbx: installing compiler/);
	now = 3000;
	for (const timer of timers.values()) timer.cb();
	assert.ok(output.some((line) => /\(3s\)/.test(line)));
	reporter.onStatus("starting Pi");
	assert.equal(timers.size, 0);
	const outputAtHandoff = output.length;
	now = 10_000;
	for (const timer of timers.values()) timer.cb();
	assert.equal(output.length, outputAtHandoff);
	assert.ok(output.some((line) => /^pi-dsbx: starting Pi/.test(line)));
	reporter.stop();
});

test("TTY warnings clear an active carriage-return status", (t) => {
	const output: string[] = [];
	const reporter = createLaunchReporter(
		(message) => output.push(message),
		undefined,
		true,
	);
	t.after(() => reporter.stop());
	reporter.onStatus("installing a-very-long-package-name");
	reporter.onWarning("short warning");
	assert.match(output.at(-2) ?? "", /^\r +\r$/);
	assert.equal(output.at(-1), "! short warning");
	reporter.onStatus("copying host profile");
	reporter.reportRemaining(["later warning"]);
	assert.match(output.at(-2) ?? "", /^\r +\r$/);
	assert.equal(output.at(-1), "! later warning");
	reporter.stop();
});

test("interactive confirmation clears and pauses TTY status", async () => {
	const output: string[] = [];
	const timers = new Map<number, () => void>();
	let nextTimer = 0;
	let now = 0;
	let answer!: (accepted: boolean) => void;
	const pendingAnswer = new Promise<boolean>((resolve) => {
		answer = resolve;
	});
	const reporter = createLaunchReporter(
		(message) => output.push(message),
		{
			now: () => now,
			setInterval: (callback) => {
				const id = ++nextTimer;
				timers.set(id, callback as () => void);
				return id as unknown as NodeJS.Timeout;
			},
			clearInterval: (id) => {
				timers.delete(id as unknown as number);
			},
		},
		true,
	);
	const confirm = createPausedConfirm(
		reporter,
		async (question) => {
			output.push(`prompt:${question}`);
			return pendingAnswer;
		},
		"syncing host credentials",
	);
	reporter.onStatus("syncing host credentials");
	const result = confirm("Continue?");
	assert.equal(timers.size, 0);
	assert.match(output.at(-2) ?? "", /^\r +\r$/);
	assert.equal(output.at(-1), "prompt:Continue?");
	const outputWhilePending = output.length;
	now = 5_000;
	for (const callback of timers.values()) callback();
	assert.equal(output.length, outputWhilePending);
	answer(true);
	assert.equal(await result, true);
	assert.match(output.at(-1) ?? "", /^pi-dsbx: syncing host credentials/);
	assert.equal(timers.size, 1);
	assert.equal(
		output.filter((line) => /^pi-dsbx: syncing host credentials/.test(line))
			.length,
		2,
	);
	now = 7_000;
	for (const callback of timers.values()) callback();
	assert.match(output.at(-1) ?? "", /syncing host credentials \(2s\)/);
	reporter.stop();

	const rejectedConfirm = createPausedConfirm(
		reporter,
		async () => false,
		"checking Docker Sandboxes",
	);
	reporter.onStatus("checking Docker Sandboxes");
	assert.equal(await rejectedConfirm("Continue?"), false);
	assert.equal(timers.size, 0);
	assert.equal(
		output.filter((line) => /^pi-dsbx: checking Docker Sandboxes/.test(line))
			.length,
		1,
	);
	reporter.stop();
});

test("non-TTY heartbeat appends every five seconds", () => {
	const output: string[] = [];
	const timers: Array<{ cb: () => void; ms: number }> = [];
	let now = 0;
	const reporter = createLaunchReporter(
		(message) => output.push(message),
		{
			now: () => now,
			setInterval: (cb, ms) => {
				timers.push({ cb: cb as () => void, ms });
				return 1 as unknown as NodeJS.Timeout;
			},
			clearInterval: () => {},
		},
		false,
	);
	reporter.onStatus("installing compiler");
	assert.equal(timers[0]?.ms, 5_000);
	now = 5_000;
	timers[0]?.cb();
	now = 10_000;
	timers[0]?.cb();
	assert.deepEqual(output, [
		"pi-dsbx: installing compiler",
		"pi-dsbx: installing compiler… still working (5s)",
		"pi-dsbx: installing compiler… still working (10s)",
	]);
	reporter.stop();
});

test("inline false destroy booleans strip without granting authority", async () => {
	const dirty = await fixture();
	const rejected = await runDestroy(
		dirty,
		["--yes=false", "--discard-changes=false"],
		true,
	);
	assert.equal(rejected.code, 1);
	assert.match(rejected.stderr, /--discard-changes/);
	assert.deepEqual(
		rejected.calls.map((call) => call[0]),
		["exec"],
	);

	const invalid = await fixture();
	const malformed = await runDestroy(invalid, ["--yes=maybe"], false);
	assert.equal(malformed.code, 1);
	assert.match(malformed.stderr, /boolean true or false/);
	assert.deepEqual(malformed.calls, []);
});

test("destroy with --discard-changes removes a sandbox that has no clone state", async () => {
	const subject = await fixture({ state: false });
	const name = sandboxName(subject.root);
	const result = await runDestroy(
		subject,
		["--name", name, "--discard-changes"],
		false,
	);
	assert.equal(result.code, 0, result.stderr);
	assert.deepEqual(result.calls, [["rm", "--force", name]]);
});

test("--yes cannot discard dirty sandbox changes", async () => {
	const subject = await fixture();
	const result = await runDestroy(subject, ["--yes"], true);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /--discard-changes/);
	assert.deepEqual(
		result.calls.map((call) => call[0]),
		["exec"],
	);
});

test("--discard-changes authorizes dirty removal and --yes authorizes clean removal", async () => {
	for (const [args, dirty] of [
		[["--discard-changes"], true],
		[["--yes"], false],
	] as const) {
		const subject = await fixture();
		const result = await runDestroy(subject, [...args], dirty);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(
			result.calls.map((call) => call[0]),
			["exec", "rm"],
		);
		await assert.rejects(
			access(statePath(subject.root, sandboxName(subject.root))),
		);
	}
});

test("destroy reports stale state custody when exact state cleanup fails", async () => {
	const subject = await fixture();
	const path = statePath(subject.root, sandboxName(subject.root));
	const previousCwd = process.cwd();
	const previousPath = process.env.PATH;
	process.chdir(subject.root);
	process.env.PATH = `${subject.bin}:${previousPath}`;
	process.env.FAKE_SBX_LOG = subject.log;
	process.env.FAKE_DIRTY = "0";
	try {
		await assert.rejects(
			main(["destroy", "--yes"], {
				removeState: async (actual) => {
					assert.equal(actual, path);
					throw new Error("injected exact state cleanup failure");
				},
			}),
			(error: unknown) => {
				assert.equal((error as { phase?: string }).phase, "remove-or-keep");
				assert.match(
					(error as { detail?: string }).detail ?? "",
					/sandbox.*gone.*stale state/i,
				);
				assert.deepEqual((error as { recovery?: string[] }).recovery, [
					`Inspect ${path} and its parent directory manually`,
				]);
				return true;
			},
		);
		const calls = (await readFile(subject.log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			calls.map((call) => call[0]),
			["exec", "rm"],
		);
	} finally {
		process.chdir(previousCwd);
		process.env.PATH = previousPath;
		delete process.env.FAKE_SBX_LOG;
		delete process.env.FAKE_DIRTY;
	}
});
