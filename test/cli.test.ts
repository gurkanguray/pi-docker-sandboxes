import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
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
import {
	createLaunchReporter,
	createPausedConfirm,
	launchProcessExitCode,
	main,
	run,
} from "../src/cli.ts";
import { LauncherExitCode } from "../src/exit-codes.ts";
import { IMAGE_LOCK } from "../src/image-lock.ts";
import {
	acquireSandboxLease,
	LEASE_BUSY_EXIT_CODE,
	SandboxLeaseBusyError,
} from "../src/lease.ts";
import { sessionBackupRoot } from "../src/sessions.ts";
import {
	inspectRepository,
	loadSandboxState,
	sandboxName,
	saveSandboxState,
	statePath,
	type SandboxPhase,
} from "../src/workspace.ts";

const exec = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

const fixtureImage = `example.invalid/runtime@sha256:${"a".repeat(64)}`;

test("CLI run maps lease contention and ordinary failures to process exit codes", async (t) => {
	const errors: string[] = [];
	t.mock.method(console, "error", (message: unknown) =>
		errors.push(String(message)),
	);
	assert.equal(
		await run(["run"], {
			launch: async () => {
				throw new SandboxLeaseBusyError("busy fixture");
			},
		}),
		LauncherExitCode.Busy,
	);
	assert.equal(
		await run(["run"], {
			launch: async () => {
				throw new Error("failure fixture");
			},
		}),
		LauncherExitCode.Failure,
	);
	assert.deepEqual(errors, ["Error: busy fixture", "Error: failure fixture"]);
});

test("launcher custody status is primary only after a successful agent", () => {
	assert.equal(
		launchProcessExitCode({
			agentExitCode: 0,
			launcherExitCode: LauncherExitCode.CustodyFailure,
		}),
		LauncherExitCode.CustodyFailure,
	);
	assert.equal(
		launchProcessExitCode({
			agentExitCode: 17,
			launcherExitCode: LauncherExitCode.CustodyFailure,
		}),
		17,
	);
});

async function fixture(
	options: { git?: boolean; state?: boolean; phase?: SandboxPhase } = {
		git: true,
		state: true,
	},
): Promise<{ root: string; bin: string; log: string; daemon: string }> {
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
			version: 2,
			phase: options.phase ?? "ready",
			name,
			hostBaseCommit: repository.head,
			hostBranch: repository.branch,
			hostRepoIdentity: repository.identity,
			hostWorktreeIdentity: canonical,
			hostRoot: canonical,
			workspaceMode: "clone",
			createdAt: "2026-08-12T00:00:00.000Z",
			updatedAt: "2026-08-18T00:00:00.000Z",
			runtimeImage: fixtureImage,
			runtimeSchema: 1,
			packageVersion: "1.0.0",
			...(options.phase === undefined || options.phase === "ready"
				? {
						imageAttestation: {
							status: "verified" as const,
							image: fixtureImage,
						},
					}
				: {}),
		});
	}
	const bin = join(root, "bin");
	const log = join(root, "sbx.log");
	const daemon = join(root, "daemon-present");
	await writeFile(daemon, "present\n");
	await exec("mkdir", ["-p", bin]);
	const script = join(bin, "sbx");
	await writeFile(
		script,
		`#!/usr/bin/env node\nimport { appendFileSync, existsSync, unlinkSync } from "node:fs";\nconst args = process.argv.slice(2);\nappendFileSync(process.env.FAKE_SBX_LOG, JSON.stringify(args) + "\\n");\nif (args[0] === "exec") process.stdout.write(process.env.FAKE_DIRTY === "1" ? " M file.txt\\n" : "");
if (args[0] === "list" && process.env.FAKE_LIST_ERROR === "1") { process.stderr.write("daemon unavailable\\n"); process.exit(7); }
if (args[0] === "list") process.stdout.write(JSON.stringify({ sandboxes: existsSync(process.env.FAKE_DAEMON) ? [{ name: process.env.FAKE_NAME }] : [] }) + "\\n");
if (args[0] === "inspect") process.stdout.write(JSON.stringify({ image: process.env.FAKE_IMAGE }) + "\\n");
if (args[0] === "rm" && existsSync(process.env.FAKE_DAEMON)) unlinkSync(process.env.FAKE_DAEMON);
`,
	);
	await chmod(script, 0o755);
	return { root: canonical, bin, log, daemon };
}

async function runCli(
	subject: Awaited<ReturnType<typeof fixture>>,
	command: "export" | "apply" | "destroy",
	args: string[],
	dirty: boolean,
	daemonImage = fixtureImage,
	listError = false,
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
					FAKE_DAEMON: subject.daemon,
					FAKE_NAME: sandboxName(subject.root),
					FAKE_IMAGE: daemonImage,
					FAKE_LIST_ERROR: listError ? "1" : "0",
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
	daemonImage?: string,
): ReturnType<typeof runCli> {
	return runCli(subject, "destroy", args, dirty, daemonImage);
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

test("CLI session restore rejects mismatched custody and accepts exact state", async () => {
	const subject = await fixture();
	const repository = await inspectRepository(subject.root);
	const name = sandboxName(subject.root);
	const image = IMAGE_LOCK.images.standard;
	assert.equal(image.status, "published");
	if (image.status !== "published") return;
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-cli-sessions-home-"));
	const agentDir = join(home, ".pi", "agent");
	await chmod(home, 0o700);
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	const backupId = "2026-08-14T12-34-56-789Z";
	await mkdir(
		join(
			sessionBackupRoot(agentDir, repository.identity, name),
			backupId,
			"sessions",
		),
		{ recursive: true },
	);
	await chmod(join(agentDir, "docker-sandboxes"), 0o700);
	const original = await loadSandboxState(subject.root, name);
	const valid = {
		...original,
		version: 2 as const,
		phase: "ready" as const,
		hostRepoIdentity: repository.identity,
		hostWorktreeIdentity: repository.worktreeIdentity,
		hostRoot: repository.root,
		runtimeImage: image.reference,
		runtimeSchema: IMAGE_LOCK.runtimeSchema,
		packageVersion: "1.0.0",
		imageAttestation: {
			status: "verified" as const,
			image: image.reference,
		},
		updatedAt: "2026-08-18T00:00:00.000Z",
	};
	const run = async (): Promise<{
		code: number;
		stderr: string;
		calls: string[][];
	}> => {
		await writeFile(subject.log, "");
		try {
			await exec(
				process.execPath,
				[
					"--experimental-strip-types",
					cli,
					"sessions",
					"restore",
					backupId,
					"--name",
					name,
				],
				{
					cwd: subject.root,
					env: {
						...process.env,
						HOME: home,
						PATH: `${subject.bin}:${process.env.PATH}`,
						FAKE_SBX_LOG: subject.log,
						FAKE_DIRTY: "0",
						FAKE_DAEMON: subject.daemon,
						FAKE_NAME: name,
						FAKE_IMAGE: image.reference,
						FAKE_LIST_ERROR: "0",
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
			return {
				code: error.code,
				stderr: error.stderr,
				calls: (await readFile(subject.log, "utf8"))
					.trim()
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line)),
			};
		}
	};
	for (const [label, state, diagnostic] of [
		[
			"state",
			{ ...valid, phase: "creating", imageAttestation: undefined },
			/ready/i,
		],
		[
			"repository",
			{ ...valid, hostRepoIdentity: "local:other" },
			/repository/i,
		],
		[
			"image",
			{
				...valid,
				runtimeImage: fixtureImage,
				imageAttestation: { status: "verified", image: fixtureImage },
			},
			/image|runtime/i,
		],
		[
			"worktree",
			{ ...valid, hostWorktreeIdentity: `${subject.root}-other` },
			/worktree/i,
		],
		["attestation", { ...valid, imageAttestation: undefined }, /attest|ready/i],
	] as const) {
		await saveSandboxState(state);
		const result = await run();
		assert.notEqual(result.code, 0, label);
		assert.match(result.stderr, diagnostic, `${label}: ${result.stderr}`);
		assert.equal(
			result.calls.some((call) => call[0] === "cp"),
			false,
			label,
		);
	}
	await saveSandboxState(valid);
	const restored = await run();
	assert.equal(restored.code, 0, restored.stderr);
	assert.equal(
		restored.calls.some((call) => call[0] === "cp"),
		true,
	);
	assert.equal(restored.calls.filter((call) => call[0] === "exec").length, 3);
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
	assert.match(output.join("\n"), /doctor \[--json\]/);
	assert.match(output.join("\n"), /status \[--json\]/);
	assert.match(output.join("\n"), /unlock --name NAME --yes/);
	assert.match(output.join("\n"), /sessions list/);
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
		["list", "inspect", "exec"],
	);

	const invalid = await fixture();
	const malformed = await runDestroy(invalid, ["--yes=maybe"], false);
	assert.equal(malformed.code, 1);
	assert.match(malformed.stderr, /boolean true or false/);
	assert.deepEqual(malformed.calls, []);
});

test("destroy refuses a sandbox that has no durable lifecycle state", async () => {
	const subject = await fixture({ state: false });
	const name = sandboxName(subject.root);
	const result = await runDestroy(
		subject,
		["--name", name, "--discard-changes"],
		false,
	);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /durable lifecycle state/i);
	assert.deepEqual(
		result.calls.map((call) => call[0]),
		["list"],
	);
});

test("management export and destroy refuse non-ready reconciled state", async () => {
	for (const [command, phase, args] of [
		["export", "exporting", []],
		["destroy", "failed", ["--discard-changes"]],
	] as const) {
		const subject = await fixture({ phase });
		const result = await runCli(subject, command, [...args], false);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /interrupted export|failed lifecycle/i);
		assert.equal(
			result.calls.some((call) => call[0] === "rm"),
			false,
		);
		assert.equal(
			(await loadSandboxState(subject.root, sandboxName(subject.root))).phase,
			phase,
		);
	}
});

test("management image mismatch marks failed and never removes", async () => {
	const subject = await fixture();
	const wrongImage = `example.invalid/runtime@sha256:${"b".repeat(64)}`;
	const result = await runDestroy(
		subject,
		["--discard-changes"],
		false,
		wrongImage,
	);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /runtime image mismatch/i);
	assert.equal(
		result.calls.some((call) => call[0] === "rm"),
		false,
	);
	assert.equal(
		(await loadSandboxState(subject.root, sandboxName(subject.root))).phase,
		"failed",
	);
});

test("management daemon ambiguity preserves state and never removes", async () => {
	const subject = await fixture();
	const result = await runCli(
		subject,
		"destroy",
		["--discard-changes"],
		false,
		fixtureImage,
		true,
	);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /daemon unavailable|sbx list failed/i);
	assert.equal(
		result.calls.some((call) => call[0] === "rm"),
		false,
	);
	assert.equal(
		(await loadSandboxState(subject.root, sandboxName(subject.root))).phase,
		"ready",
	);
});

test("--yes cannot discard dirty sandbox changes", async () => {
	const subject = await fixture();
	const result = await runDestroy(subject, ["--yes"], true);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /--discard-changes/);
	assert.deepEqual(
		result.calls.map((call) => call[0]),
		["list", "inspect", "exec"],
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
			["list", "inspect", "exec", "rm", "list"],
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
	process.env.FAKE_DAEMON = subject.daemon;
	process.env.FAKE_NAME = sandboxName(subject.root);
	process.env.FAKE_IMAGE = fixtureImage;
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
			["list", "inspect", "exec", "rm", "list"],
		);
	} finally {
		process.chdir(previousCwd);
		process.env.PATH = previousPath;
		delete process.env.FAKE_SBX_LOG;
		delete process.env.FAKE_DIRTY;
		delete process.env.FAKE_DAEMON;
		delete process.env.FAKE_NAME;
		delete process.env.FAKE_IMAGE;
	}
});
