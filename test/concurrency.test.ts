import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	acquireSandboxLease,
	LEASE_BUSY_EXIT_CODE,
} from "../src/lease.ts";
import {
	CommandCancelledError,
	CommandTimeoutError,
	SbxClient,
} from "../src/sbx/client.ts";

async function leaseFixture(t: { after(fn: () => Promise<void>): void }) {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-concurrency-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir, { mode: 0o700 });
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, agentDir };
}

test("simultaneous lifecycle commands have one owner and deterministic busy contenders", async (t) => {
	const { root, agentDir } = await leaseFixture(t);
	const attempts = await Promise.allSettled(
		Array.from({ length: 12 }, () =>
			acquireSandboxLease(root, "pi-concurrent", "run", { agentDir }),
		),
	);
	const owners = attempts.filter(
		(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireSandboxLease>>> =>
			result.status === "fulfilled",
	);
	assert.equal(owners.length, 1);
	assert.equal(
		attempts.filter(
			(result) =>
				result.status === "rejected" &&
				(result.reason as { exitCode?: number }).exitCode === LEASE_BUSY_EXIT_CODE,
		).length,
		11,
	);
	await owners[0]!.value.release();
});

test("hung daemon commands time out and interrupted commands are cancelled", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-daemon-timeout-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const daemon = join(root, "sbx");
	await writeFile(
		daemon,
		`#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);\n`,
	);
	await chmod(daemon, 0o755);

	const timed = new SbxClient(daemon, undefined, undefined, {
		policies: { discovery: { timeoutMs: 100, killGraceMs: 500 } },
	});
	await assert.rejects(() => timed.list(), CommandTimeoutError);

	const controller = new AbortController();
	const interrupted = new SbxClient(daemon, undefined, undefined, {
		signal: controller.signal,
		policies: { discovery: { timeoutMs: 5_000, killGraceMs: 500 } },
	});
	const operation = interrupted.list();
	setTimeout(() => controller.abort(), 100);
	await assert.rejects(operation, CommandCancelledError);
});
