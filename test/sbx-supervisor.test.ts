import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CommandCancelledError,
	CommandOutputLimitError,
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

async function waitForPidExit(pid: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			process.kill(pid, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`descendant ${pid} was not reaped`);
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
	await waitForPidExit(pid);
});

test("direct exit clears its deadline while a descendant is reaped", {
	skip: isWindows,
	timeout: 10_000,
}, async () => {
	const descendant =
		"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
	const parent = `
		const {spawn} = require("node:child_process");
		spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], {stdio: "ignore"});
		setTimeout(() => process.exit(0), 25);
	`;
	const result = await superviseCommand(process.execPath, ["-e", parent], {
		policy: { timeoutMs: 2_000, killGraceMs: 3_000 },
	});
	assert.equal(result.code, 0);
});

test("maxBuffer is finite and nonnegative and real overflow is bounded", async () => {
	for (const maxBuffer of [-1, Number.NaN, Number.POSITIVE_INFINITY])
		assert.throws(
			() =>
				superviseCommand(process.execPath, ["-e", ""], {
					policy: { timeoutMs: 1_000, killGraceMs: 100 },
					maxBuffer,
				}),
			/maxBuffer must be a nonnegative finite number/,
		);
	await assert.rejects(
		superviseCommand(process.execPath, ["-e", "process.stdout.write('xx')"], {
			policy: { timeoutMs: 1_000, killGraceMs: 100 },
			maxBuffer: 1,
		}),
		CommandOutputLimitError,
	);
});

test("AbortSignal cancels a started Python process group after cleanup", {
	skip: isWindows,
	timeout: 10_000,
}, async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-cancel-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pidPath = join(directory, "python.pid");
	const controller = new AbortController();
	const operation = superviseCommand(
		"python3",
		[
			"-c",
			`import os,signal,time; open(${JSON.stringify(pidPath)}, 'w').write(str(os.getpid())); signal.signal(signal.SIGTERM, lambda *_: exit(0)); time.sleep(60)`,
		],
		{
			policy: {
				timeoutMs: 5_000,
				killGraceMs: 1_000,
				signal: controller.signal,
			},
		},
	);
	const pid = await waitForPid(pidPath);
	controller.abort();
	await assert.rejects(operation, CommandCancelledError);
	await waitForPidExit(pid);
	assert.throws(
		() => process.kill(-pid, 0),
		(error: NodeJS.ErrnoException) => error.code === "ESRCH",
	);
});
