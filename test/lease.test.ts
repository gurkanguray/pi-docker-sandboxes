import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
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
	LEASE_BUSY_EXIT_CODE,
} from "../src/lease.ts";

const exec = promisify(execFile);

async function fixture(t: { after(fn: () => Promise<void>): void }): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-lease-"));
	await mkdir(join(root, ".git"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

async function preparedLeasePath(root: string, name = "box"): Promise<string> {
	const lease = await acquireSandboxLease(root, name, "run");
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
	const first = await acquireSandboxLease(root, "box", "run");
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "destroy"),
		(error: unknown) => {
			assert.equal((error as { exitCode?: number }).exitCode, LEASE_BUSY_EXIT_CODE);
			assert.match(String(error), /busy.*run/i);
			return true;
		},
	);
	await first.release();
	const second = await acquireSandboxLease(root, "box", "destroy");
	await second.release();
});

test("only demonstrably dead local leases are reclaimed", async (t) => {
	const root = await fixture(t);
	const path = await preparedLeasePath(root);
	await writeFile(path, record({ pid: 2_147_483_647 }), { mode: 0o600 });
	const reclaimed = await acquireSandboxLease(root, "box", "export");
	await reclaimed.release();

	await writeFile(path, "not json\n", { mode: 0o600 });
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "run"),
		/busy.*uncertain/i,
	);
	assert.equal(await readFile(path, "utf8"), "not json\n");

	await writeFile(path, record({ pid: 2_147_483_647, host: "another-host" }));
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "run"),
		/busy.*another-host/i,
	);
});

test("canonical repository roots share one sandbox lease", async (t) => {
	const root = await fixture(t);
	const alias = `${root}-alias`;
	await symlink(root, alias);
	t.after(() => rm(alias, { force: true }));
	const first = await acquireSandboxLease(alias, "box", "run");
	try {
		await assert.rejects(
			() => acquireSandboxLease(root, "box", "export"),
			/busy.*run/i,
		);
		const otherSandbox = await acquireSandboxLease(root, "other", "run");
		await otherSandbox.release();
	} finally {
		await first.release();
	}
});

test("symlinked and hard-linked lease paths fail closed", async (t) => {
	const root = await fixture(t);
	const path = await preparedLeasePath(root);
	const target = join(root, "target");
	await writeFile(target, record({ pid: 2_147_483_647 }));
	await symlink(target, path);
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "run"),
		/busy.*uncertain/i,
	);
	assert.equal(await readFile(target, "utf8"), record({ pid: 2_147_483_647 }));
	await unlink(path);

	await link(target, path);
	await assert.rejects(
		() => acquireSandboxLease(root, "box", "run"),
		/busy.*uncertain/i,
	);
	assert.equal(await readFile(path, "utf8"), record({ pid: 2_147_483_647 }));
});

test("release refuses to unlink a replacement lease", async (t) => {
	const root = await fixture(t);
	const lease = await acquireSandboxLease(root, "box", "run");
	const { path } = lease;
	await unlink(path);
	await writeFile(path, record({ operation: "destroy" }), { mode: 0o600 });
	await assert.rejects(() => lease.release(), /ownership changed/i);
	assert.match(await readFile(path, "utf8"), /"operation":"destroy"/);
});

test("concurrent in-process acquisition has exactly one winner", async (t) => {
	const root = await fixture(t);
	const attempts = await Promise.allSettled(
		Array.from({ length: 16 }, () =>
			acquireSandboxLease(root, "box", "run"),
		),
	);
	const acquired = attempts.filter(
		(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSandboxLease>>> =>
			result.status === "fulfilled",
	);
	assert.equal(acquired.length, 1);
	assert.equal(
		attempts.filter(
			(result) =>
				result.status === "rejected" &&
				(result.reason as { exitCode?: number }).exitCode === LEASE_BUSY_EXIT_CODE,
		).length,
		15,
	);
	await acquired[0]!.value.release();
});

test("Python process probe observes one owner and the documented busy code", async (t) => {
	const root = await fixture(t);
	const module = new URL("../src/lease.ts", import.meta.url).href;
	const worker = `
const { acquireSandboxLease, LEASE_BUSY_EXIT_CODE } = await import(process.argv[1]);
try {
  const lease = await acquireSandboxLease(process.argv[2], "box", "run");
  console.log("ACQUIRED");
  await new Promise((resolve) => setTimeout(resolve, Number(process.argv[3])));
  await lease.release();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error?.exitCode ?? 1;
}
`;
	const python = `
import subprocess, sys
node, module, root, worker, busy = sys.argv[1:]
command = [node, "--experimental-strip-types", "--input-type=module", "-e", worker, module, root]
first = subprocess.Popen(command + ["1500"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
ready = first.stdout.readline().strip()
if ready != "ACQUIRED":
    out, err = first.communicate()
    raise SystemExit(f"first probe did not acquire: {ready}{out} {err}")
second = subprocess.run(command + ["0"], capture_output=True, text=True)
first_out, first_err = first.communicate()
codes = [first.returncode, second.returncode]
print(f"ready={ready} codes={codes[0]},{codes[1]}")
print(f"contender={second.stderr.strip()}")
if codes != [0, int(busy)]:
    raise SystemExit(f"unexpected codes {codes}: first={first_err!r} second={second.stderr!r}")
`;
	const result = await exec(
		"python3",
		["-c", python, process.execPath, module, root, worker, String(LEASE_BUSY_EXIT_CODE)],
		{ timeout: 10_000 },
	);
	console.log(`python lease probe: ${result.stdout.trim().replaceAll("\n", "; ")}`);
	assert.match(result.stdout, new RegExp(`codes=0,${LEASE_BUSY_EXIT_CODE}`));
	assert.match(result.stdout, /contender=.*busy.*run/i);
});
