import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CommandCancelledError,
	CommandTimeoutError,
	superviseCommand,
} from "../src/sbx/supervisor.ts";

const isWindows = process.platform === "win32";

async function waitForPid(path: string): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const pid = Number(await readFile(path, "utf8"));
			if (pid > 0) return pid;
		} catch {
			// The fixture publishes asynchronously.
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("child fixture did not publish its PID");
}

test("supervisor captures output from a real Node child", async () => {
	const result = await superviseCommand(
		process.execPath,
		["-e", "process.stdout.write('out'); process.stderr.write('err')"],
		{ policy: { timeoutMs: 2_000, killGraceMs: 1_000 } },
	);
	assert.deepEqual(result, {
		stdout: Buffer.from("out"),
		stderr: Buffer.from("err"),
		code: 0,
	});
});

test("timeout is specific, bounded, and kills a TERM-resistant descendant", {
	skip: isWindows,
	timeout: 10_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-supervisor-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pidPath = join(directory, "descendant.pid");
	const descendant =
		"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
	const parent = `
		const {spawn} = require("node:child_process");
		const {writeFileSync} = require("node:fs");
		const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio: "ignore"});
		writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
		setInterval(() => {}, 1000);
	`;
	const started = Date.now();
	const operation = superviseCommand(process.execPath, ["-e", parent], {
		policy: { timeoutMs: 200, killGraceMs: 250 },
	});
	const pid = await waitForPid(pidPath);
	await assert.rejects(operation, (error: unknown) => {
		if (!(error instanceof CommandTimeoutError)) return false;
		assert.equal(error.timeoutMs, 200);
		return true;
	});
	assert.ok(Date.now() - started < 2_000);
	assert.throws(
		() => process.kill(pid, 0),
		(error: NodeJS.ErrnoException) => error.code === "ESRCH",
	);
});

test("AbortSignal cancels a real Python child after process cleanup", {
	skip: isWindows,
	timeout: 10_000,
}, async () => {
	const controller = new AbortController();
	const operation = superviseCommand(
		"python3",
		[
			"-c",
			"import signal,time; signal.signal(signal.SIGTERM, lambda *_: exit(0)); print('ready', flush=True); time.sleep(60)",
		],
		{
			policy: {
				timeoutMs: 5_000,
				killGraceMs: 1_000,
				signal: controller.signal,
			},
		},
	);
	setTimeout(() => controller.abort(), 100);
	await assert.rejects(operation, CommandCancelledError);
});
