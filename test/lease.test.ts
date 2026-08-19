import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
	cp,
	link,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	acquireSandboxLease,
	inspectSandboxLease,
	LEASE_BUSY_EXIT_CODE,
	type SandboxLeaseRuntime,
	unlockSandboxLease,
	withSandboxLease,
} from "../src/lease.ts";
import { sandboxName } from "../src/workspace.ts";

const exec = promisify(execFile);

const leaseAgentDirs = new Map<string, string>();

async function fixture(t: {
	after(fn: () => Promise<void>): void;
}): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-lease-"));
	const agentDir = join(root, "agent");
	await Promise.all([
		mkdir(join(root, ".git")),
		mkdir(agentDir, { mode: 0o700 }),
	]);
	leaseAgentDirs.set(root, agentDir);
	t.after(async () => {
		leaseAgentDirs.delete(root);
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

function runtime(
	root: string,
	overrides: SandboxLeaseRuntime = {},
): SandboxLeaseRuntime {
	return {
		agentDir: leaseAgentDirs.get(root) ?? join(root, "agent"),
		...overrides,
	};
}

async function preparedLeasePath(root: string, name = "box"): Promise<string> {
	const lease = await acquireSandboxLease(root, name, "run", runtime(root));
	const { path } = lease;
	await lease.release();
	return path;
}

function record(overrides: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		schema: 1,
		sandbox: "box",
		operation: "run",
		pid: process.pid,
		host: hostname(),
		startedAt: "2026-08-18T00:00:00.000Z",
		...overrides,
	})}\n`;
}

test("live leases are exclusive and report their owning operation", async (t) => {
	const root = await fixture(t);
	const first = await acquireSandboxLease(root, "box", "run", runtime(root));
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "destroy", runtime(root)),
		(error: unknown) => {
			assert.equal(
				(error as { exitCode?: number }).exitCode,
				LEASE_BUSY_EXIT_CODE,
			);
			assert.match(String(error), /busy.*run/i);
			return true;
		},
	);
	await first.release();
	const second = await acquireSandboxLease(
		root,
		"box",
		"destroy",
		runtime(root),
	);
	await second.release();
});

test("abandoned leases stay busy without local-owner inference or reclamation", async (t) => {
	for (const [name, contents, diagnostic] of [
		[
			"dead-local",
			record({ sandbox: "dead-local", pid: 2_147_483_647 }),
			/busy.*run/i,
		],
		[
			"duplicate-hostname",
			record({ sandbox: "duplicate-hostname", pid: 2_147_483_647 }),
			/busy.*run/i,
		],
		[
			"foreign",
			record({ sandbox: "foreign", pid: 2_147_483_647, host: "another-host" }),
			/busy.*another-host/i,
		],
		["malformed", "not json\n", /busy.*uncertain/i],
	] as const) {
		const root = await fixture(t);
		const path = await preparedLeasePath(root, name);
		await writeFile(path, contents, { mode: 0o600 });
		const attempts = await Promise.allSettled(
			Array.from({ length: 16 }, () =>
				acquireSandboxLease(root, name, "export", runtime(root)),
			),
		);
		assert.equal(
			attempts.every((attempt) => attempt.status === "rejected"),
			true,
		);
		for (const attempt of attempts) {
			if (attempt.status === "rejected")
				assert.match(String(attempt.reason), diagnostic);
		}
		assert.equal(await readFile(path, "utf8"), contents);
	}
});

test("explicit unlock requires a demonstrably absent recorded Python process", async (t) => {
	const root = await fixture(t);
	const path = await preparedLeasePath(root);
	const child = spawn("python3", ["-c", "import time; time.sleep(30)"]);
	assert.ok(child.pid);
	t.after(async () => {
		if (child.exitCode === null) child.kill("SIGKILL");
	});
	await writeFile(
		path,
		record({ pid: child.pid, host: hostname(), sandbox: "box" }),
	);
	assert.equal(
		(await inspectSandboxLease(root, "box", runtime(root))).status,
		"live",
	);
	await assert.rejects(
		unlockSandboxLease(root, "box", true, runtime(root)),
		/still present/,
	);
	child.kill("SIGKILL");
	await once(child, "exit");
	assert.equal(
		(await inspectSandboxLease(root, "box", runtime(root))).status,
		"abandoned",
	);
	assert.equal(
		(await unlockSandboxLease(root, "box", true, runtime(root))).pid,
		child.pid,
	);
	assert.equal(
		(await inspectSandboxLease(root, "box", runtime(root))).status,
		"absent",
	);
});

test("canonical repository roots share one sandbox lease", async (t) => {
	const root = await fixture(t);
	const alias = `${root}-alias`;
	await symlink(root, alias);
	t.after(() => rm(alias, { force: true }));
	const first = await acquireSandboxLease(alias, "box", "run", runtime(root));
	try {
		await assert.rejects(
			() => acquireSandboxLease(root, "box", "export", runtime(root)),
			/busy.*run/i,
		);
		const otherSandbox = await acquireSandboxLease(
			root,
			"other",
			"run",
			runtime(root),
		);
		await otherSandbox.release();
	} finally {
		await first.release();
	}
});

test("unrelated repositories contend globally by explicit sandbox name", async (t) => {
	const firstRoot = await fixture(t);
	const secondRoot = await fixture(t);
	const sharedAgentDir = leaseAgentDirs.get(firstRoot)!;
	const sharedRuntime = { agentDir: sharedAgentDir };
	const explicit = await acquireSandboxLease(
		firstRoot,
		"shared",
		"run",
		sharedRuntime,
	);
	try {
		await assert.rejects(
			() => acquireSandboxLease(secondRoot, "shared", "destroy", sharedRuntime),
			/busy.*run/i,
		);
		assert.notEqual(sandboxName(firstRoot), sandboxName(secondRoot));
		const isolated = await acquireSandboxLease(
			secondRoot,
			sandboxName(secondRoot),
			"run",
			sharedRuntime,
		);
		await isolated.release();
	} finally {
		await explicit.release();
	}
});

test("global lease directory symlinks fail closed", async (t) => {
	const root = await fixture(t);
	const agentDir = leaseAgentDirs.get(root)!;
	const outside = await mkdtemp(join(tmpdir(), "pi-dsbx-lease-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await symlink(outside, join(agentDir, "docker-sandboxes"));
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "run", runtime(root)),
		/symlink|without symlinks/i,
	);
});

test("symlinked and hard-linked lease paths fail closed", async (t) => {
	const root = await fixture(t);
	const path = await preparedLeasePath(root);
	const target = join(root, "target");
	await writeFile(target, record({ pid: 2_147_483_647 }));
	await symlink(target, path);
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "run", runtime(root)),
		/busy.*uncertain/i,
	);
	assert.equal(await readFile(target, "utf8"), record({ pid: 2_147_483_647 }));
	await unlink(path);

	await link(target, path);
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "run", runtime(root)),
		/busy.*uncertain/i,
	);
	assert.equal(await readFile(path, "utf8"), record({ pid: 2_147_483_647 }));
});

test("release refuses to unlink a replacement lease", async (t) => {
	const root = await fixture(t);
	const lease = await acquireSandboxLease(root, "box", "run", runtime(root));
	const { path } = lease;
	await unlink(path);
	await writeFile(path, record({ operation: "destroy" }), { mode: 0o600 });
	await assert.rejects(() => lease.release(), /ownership changed/i);
	assert.match(await readFile(path, "utf8"), /"operation":"destroy"/);
});

test("directory sync failures propagate through create and release", async (t) => {
	for (const code of ["EINVAL", "ENOTSUP", "EBADF"] as const) {
		const directoryRoot = await fixture(t);
		const failure = Object.assign(
			new Error(`injected ${code} directory sync failure`),
			{ code },
		);
		await assert.rejects(
			() =>
				acquireSandboxLease(
					directoryRoot,
					`directory-${code}`,
					"run",
					runtime(directoryRoot, {
						syncDirectory: async () => {
							throw failure;
						},
					}),
				),
			(error: unknown) => error === failure,
		);
	}

	const root = await fixture(t);
	const synced: string[] = [];
	const syncDirectory = async (
		path: string,
		handle: { sync(): Promise<void> },
	) => {
		synced.push(path);
		await handle.sync();
	};
	const lease = await acquireSandboxLease(
		root,
		"box",
		"run",
		runtime(root, { syncDirectory }),
	);
	await lease.release();
	assert.deepEqual(
		synced.map((path) => path.slice(path.indexOf("agent"))),
		[
			"agent",
			"agent/docker-sandboxes",
			"agent/docker-sandboxes/leases",
			"agent/docker-sandboxes/leases",
		],
	);

	const invalid = Object.assign(new Error("injected directory sync failure"), {
		code: "EINVAL",
	});
	await assert.rejects(
		() =>
			acquireSandboxLease(
				root,
				"sync-create",
				"run",
				runtime(root, {
					syncDirectory: async (
						path: string,
						handle: { sync(): Promise<void> },
					) => {
						if (path.endsWith("/leases")) throw invalid;
						await handle.sync();
					},
				}),
			),

		(error: unknown) => error === invalid,
	);
	await assert.rejects(
		() => acquireSandboxLease(root, "sync-create", "destroy", runtime(root)),
		/busy.*run/i,
	);

	let leaseDirectorySyncs = 0;
	const release = await acquireSandboxLease(
		root,
		"sync-release",
		"run",
		runtime(root, {
			syncDirectory: async (
				path: string,
				handle: { sync(): Promise<void> },
			) => {
				if (path.endsWith("/leases") && ++leaseDirectorySyncs === 2)
					throw invalid;
				await handle.sync();
			},
		}),
	);
	await assert.rejects(
		() => release.release(),
		(error: unknown) => error === invalid,
	);
	const reacquired = await acquireSandboxLease(
		root,
		"sync-release",
		"destroy",
		runtime(root),
	);
	await reacquired.release();
});

test("withSandboxLease releases after its callback rejects", async (t) => {
	const root = await fixture(t);
	await assert.rejects(
		() =>
			withSandboxLease(
				root,
				"box",
				"run",
				async () => {
					throw new Error("injected callback failure");
				},
				runtime(root),
			),
		/injected callback failure/,
	);
	const reacquired = await acquireSandboxLease(
		root,
		"box",
		"destroy",
		runtime(root),
	);
	await reacquired.release();
});

test("concurrent in-process acquisition has exactly one winner", async (t) => {
	const root = await fixture(t);
	const attempts = await Promise.allSettled(
		Array.from({ length: 16 }, () =>
			acquireSandboxLease(root, "box", "run", runtime(root)),
		),
	);
	const acquired = attempts.filter(
		(
			result,
		): result is PromiseFulfilledResult<
			Awaited<ReturnType<typeof acquireSandboxLease>>
		> => result.status === "fulfilled",
	);
	assert.equal(acquired.length, 1);
	assert.equal(
		attempts.filter(
			(result) =>
				result.status === "rejected" &&
				(result.reason as { exitCode?: number }).exitCode ===
					LEASE_BUSY_EXIT_CODE,
		).length,
		15,
	);
	await acquired[0]!.value.release();
});

test("Python launches two actual pi-dsbx run processes with one lifecycle owner", async (t) => {
	const harness = await mkdtemp(join(tmpdir(), "pi-dsbx-cli-lease-probe-"));
	t.after(() => rm(harness, { recursive: true, force: true }));
	await Promise.all([
		cp(new URL("../src", import.meta.url), join(harness, "src"), {
			recursive: true,
		}),
		cp(new URL("../docker", import.meta.url), join(harness, "docker"), {
			recursive: true,
		}),
		cp(new URL("../runtime", import.meta.url), join(harness, "runtime"), {
			recursive: true,
		}),
		symlink(
			new URL("../node_modules", import.meta.url),
			join(harness, "node_modules"),
		),
	]);
	const image = `example.invalid/runtime@sha256:${"a".repeat(64)}`;
	await writeFile(
		join(harness, "docker", "image-lock.json"),
		`${JSON.stringify(
			{
				version: 2,
				runtimeSchema: 1,
				piVersion: "0.84.1",
				images: {
					standard: {
						status: "published",
						reference: image,
						platforms: ["linux/amd64", "linux/arm64"],
						privileged: false,
					},
					docker: {
						status: "published",
						reference: image,
						platforms: ["linux/amd64", "linux/arm64"],
						privileged: true,
					},
				},
			},
			null,
			2,
		)}\n`,
	);
	const root = join(harness, "repository");
	const home = join(harness, "home");
	const bin = join(harness, "bin");
	await Promise.all([mkdir(root), mkdir(home), mkdir(bin)]);
	await exec("git", ["init", "-b", "main"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "file.txt"), "initial\n");
	await exec("git", ["add", "file.txt"], { cwd: root });
	await exec("git", ["commit", "-m", "initial"], { cwd: root });

	const ready = join(harness, "ready");
	const proceed = join(harness, "proceed");
	const present = join(harness, "present");
	const log = join(harness, "sbx.log");
	const fakeSbx = join(bin, "sbx");
	await writeFile(
		fakeSbx,
		`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, parent: process.ppid }) + "\\n");
const output = (value) => process.stdout.write(value);
if (args[0] === "create" && args[1] === "--help") output("--clone --no-share-skills\\n");
else if (args[0] === "kit" && args[1] === "--help") output("validate\\n");
else if (args[0] === "inspect" && args[1] === "--help") output("--json\\n");
else if (args[0] === "policy") output("policy check network\\n");
else if (args[0] === "secret") process.exit(1);
else if (args[0] === "list") {
  if (!fs.existsSync(${JSON.stringify(ready)})) {
    fs.writeFileSync(${JSON.stringify(ready)}, String(process.ppid));
    while (!fs.existsSync(${JSON.stringify(proceed)}))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  const name = fs.existsSync(${JSON.stringify(present)}) ? fs.readFileSync(${JSON.stringify(present)}, "utf8") : undefined;
  output(JSON.stringify({ sandboxes: name ? [{ name }] : [] }));
} else if (args[0] === "create" && args.includes("--name")) {
  fs.writeFileSync(${JSON.stringify(present)}, args[args.indexOf("--name") + 1]);
} else if (args[0] === "inspect") output(JSON.stringify({ image: ${JSON.stringify(image)} }));
else if (args[0] === "exec") output("");
`,
	);
	await exec("chmod", ["755", fakeSbx]);

	const python = `
import json, os, subprocess, sys, time
node, cli, root, home, bin_dir, ready, proceed, log, busy = sys.argv[1:]
env = os.environ.copy()
env["HOME"] = home
env["PATH"] = bin_dir + os.pathsep + env["PATH"]
command = [node, "--experimental-strip-types", cli, "run", "--cwd", root, "--sync", "clean", "--keep", "--no-host-auth", "--yes"]
first = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
deadline = time.time() + 10
while not os.path.exists(ready) and first.poll() is None and time.time() < deadline:
    time.sleep(0.025)
if not os.path.exists(ready):
    out, err = first.communicate(timeout=2)
    raise SystemExit(f"first pi-dsbx run did not reach lifecycle: {first.returncode} {out!r} {err!r}")
second = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
second_out, second_err = second.communicate(timeout=10)
with open(proceed, "w") as handle:
    handle.write("continue")
first_out, first_err = first.communicate(timeout=10)
with open(log) as handle:
    calls = [json.loads(line) for line in handle if line.strip()]
second_state_reads = [call for call in calls if call["parent"] == second.pid and call["args"][:1] == ["list"]]
print(f"codes={first.returncode},{second.returncode} second_state_reads={len(second_state_reads)}")
print("contender=" + " ".join(second_err.split()))
if [first.returncode, second.returncode] != [0, int(busy)] or second_state_reads:
    raise SystemExit(f"contention failed: first={first_err!r} second={second_err!r} calls={second_state_reads!r}")
`;
	const result = await exec(
		"python3",
		[
			"-c",
			python,
			process.execPath,
			join(harness, "src", "cli.ts"),
			root,
			home,
			bin,
			ready,
			proceed,
			log,
			String(LEASE_BUSY_EXIT_CODE),
		],
		{ timeout: 30_000 },
	);
	console.log(
		`python CLI lease probe: ${result.stdout.trim().replaceAll("\n", "; ")}`,
	);
	assert.match(result.stdout, new RegExp(`codes=0,${LEASE_BUSY_EXIT_CODE}`));
	assert.match(result.stdout, /second_state_reads=0/);
	assert.match(result.stdout, /contender=.*busy.*run/i);
});
