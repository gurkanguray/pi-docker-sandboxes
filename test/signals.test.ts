import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { runInherited, SbxNotInstalledError } from "../src/sbx/client.ts";
import {
	INHERITED_GRACE_MS,
	type InheritedRuntime,
} from "../src/sbx/inherited-runner.mjs";

const moduleUrl = new URL("../src/sbx/client.ts", import.meta.url).href;
const isWindows = process.platform === "win32";
const exec = promisify(execFile);

interface MarkedProcess {
	pid: number;
	processGroup: number;
	command: string;
}

type ProcessListRunner = (
	command: string,
	args: string[],
	options: { encoding: "utf8" },
) => Promise<{ stdout: string }>;

async function processList(
	run: ProcessListRunner = exec as ProcessListRunner,
): Promise<MarkedProcess[]> {
	const { stdout } = await run("ps", ["-axww", "-o", "pid=,pgid=,command="], {
		encoding: "utf8",
	});
	return stdout
		.split("\n")
		.map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
		.filter((match): match is RegExpMatchArray => match !== null)
		.map((match) => ({
			pid: Number(match[1]),
			processGroup: Number(match[2]),
			command: match[3]!,
		}));
}

async function markedProcesses(
	marker: string,
	run: ProcessListRunner = exec as ProcessListRunner,
): Promise<MarkedProcess[]> {
	return (await processList(run)).filter((process) =>
		process.command.includes(marker),
	);
}

test("signal identity scan requests untruncated full commands", async () => {
	let observedArgs: string[] | undefined;
	await markedProcesses("owned-marker", async (_command, args) => {
		observedArgs = args;
		return { stdout: "" };
	});
	assert.deepEqual(observedArgs, ["-axww", "-o", "pid=,pgid=,command="]);
});

interface WrappedProcess {
	child: ChildProcess;
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	output: string;
	waitForLine(line: string): Promise<void>;
	assertOwnedProcessTree(pids: readonly number[]): Promise<void>;
	assertNoOwnedProcesses(pids?: readonly number[]): Promise<void>;
}

function spawnWrapped(t: TestContext, source: string): WrappedProcess {
	const marker = `pi-dsbx-signal-${randomUUID()}`;
	const child = spawn(
		process.execPath,
		[
			"--experimental-strip-types",
			"--input-type=module",
			"-e",
			`import {runInherited} from ${JSON.stringify(moduleUrl)}; process.exitCode = await runInherited(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(`console.log("process-group:" + process.pid); ${source}`)}, process.argv[1]], process.env);`,
			marker,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	let processGroup: number | undefined;
	let exited = false;
	let closed = false;
	const waiters = new Map<
		string,
		Array<{ resolve: () => void; reject: (error: Error) => void }>
	>();
	const record = (chunk: Buffer) => {
		output += chunk.toString();
		processGroup ??=
			Number(output.match(/process-group:(\d+)/)?.[1]) || undefined;
		for (const [line, entries] of waiters) {
			if (!output.includes(line)) continue;
			waiters.delete(line);
			for (const entry of entries) entry.resolve();
		}
	};
	child.stdout!.on("data", record);
	child.stderr!.on("data", record);
	const rejectWaiters = () => {
		for (const [line, entries] of waiters) {
			const error = new Error(
				`wrapper exited before ${JSON.stringify(line)}; output: ${output}`,
			);
			for (const entry of entries) entry.reject(error);
		}
		waiters.clear();
	};
	const exit = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) =>
		child.once("exit", (code, signal) => {
			exited = true;
			rejectWaiters();
			resolve({ code, signal });
		}),
	);
	const close = new Promise<void>((resolve) => {
		child.once("close", () => {
			closed = true;
			rejectWaiters();
			resolve();
		});
	});
	t.after(async () => {
		const signalOwnedGroup = async (signal: NodeJS.Signals) => {
			if (!processGroup) return;
			const ownsGroup = (await markedProcesses(marker)).some(
				(process) => process.processGroup === processGroup,
			);
			if (!ownsGroup) return;
			try {
				process.kill(-processGroup, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		await signalOwnedGroup("SIGTERM");
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGTERM");
		let fallback: NodeJS.Timeout | undefined;
		const closedCleanly = await Promise.race([
			close.then(() => true),
			new Promise<false>((resolve) => {
				fallback = setTimeout(() => resolve(false), 1_000);
			}),
		]);
		if (fallback) clearTimeout(fallback);
		if (!closedCleanly) {
			await signalOwnedGroup("SIGKILL");
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGKILL");
		}
		await Promise.all([exit, close]);
		assert.deepEqual(await markedProcesses(marker), []);
	});
	return {
		child,
		exit,
		get output() {
			return output;
		},
		waitForLine(line: string) {
			if (output.includes(line)) return Promise.resolve();
			if (exited || closed)
				return Promise.reject(
					new Error(
						`wrapper exited before ${JSON.stringify(line)}; output: ${output}`,
					),
				);
			return new Promise<void>((resolve, reject) => {
				const entries = waiters.get(line) ?? [];
				entries.push({ resolve, reject });
				waiters.set(line, entries);
			});
		},
		async assertOwnedProcessTree(pids) {
			assert.ok(processGroup, output);
			const owned = await markedProcesses(marker);
			assert.deepEqual(
				owned
					.filter(
						(process) =>
							process.processGroup === processGroup && pids.includes(process.pid),
					)
					.map((process) => process.pid)
					.sort((left, right) => left - right),
				[...pids].sort((left, right) => left - right),
				`owned marker missing from live process tree: ${JSON.stringify(owned)}`,
			);
		},
		async assertNoOwnedProcesses(pids = []) {
			await close;
			const running = await processList();
			assert.deepEqual(
				running.filter((process) => process.command.includes(marker)),
				[],
			);
			assert.deepEqual(
				running.filter((process) => pids.includes(process.pid)),
				[],
			);
		},
	};
}

async function expectSignalStatus(
	t: TestContext,
	signal: "SIGINT" | "SIGTERM" | "SIGHUP",
	expectedCode: number,
	source = "console.log('ready'); setInterval(() => {}, 1000)",
): Promise<void> {
	const wrapper = spawnWrapped(t, source);
	await wrapper.waitForLine("ready");
	wrapper.child.kill(signal);
	assert.deepEqual(
		await wrapper.exit,
		{ code: expectedCode, signal: null },
		wrapper.output,
	);
}

test("signal received during spawn setup is forwarded after PID assignment", {
	skip: isWindows,
}, async () => {
	const child = Object.assign(new EventEmitter(), { pid: 4321 });
	const kills: Array<[number, NodeJS.Signals]> = [];
	const before = new Set(
		["SIGINT", "SIGTERM"].flatMap((signal) =>
			process.rawListeners(signal as NodeJS.Signals),
		),
	);
	const runtime: InheritedRuntime = {
		spawn: () => {
			const listeners = ["SIGINT", "SIGTERM"].map((signal) =>
				process
					.rawListeners(signal as NodeJS.Signals)
					.find((candidate) => !before.has(candidate)),
			);
			assert.ok(
				listeners.every(Boolean),
				"signal listeners must be installed before spawn",
			);
			listeners[0]!.call(process);
			listeners[1]!.call(process);
			queueMicrotask(() => child.emit("exit", 0, null));
			return child as unknown as ChildProcess;
		},
		kill: (pid, signal) => {
			kills.push([pid, signal as NodeJS.Signals]);
			if (signal === 0)
				throw Object.assign(new Error("group absent"), { code: "ESRCH" });
		},
	};
	const code = await runInherited("unused", [], undefined, runtime);
	assert.equal(code, 0);
	assert.deepEqual(kills, [
		[-4321, "SIGINT"],
		[-4321, "SIGTERM"],
		[-4321, 0],
	]);
});

test("PID-less child async error rejects without hanging or leaking listeners", {
	skip: isWindows,
	timeout: 10_000,
}, async () => {
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const before = Object.fromEntries(
		signals.map((signal) => [signal, process.listenerCount(signal)]),
	);
	const child = new EventEmitter();
	const beforeListeners = new Set(
		signals.flatMap((signal) => process.rawListeners(signal)),
	);
	const runtime: InheritedRuntime = {
		spawn: () => {
			const listener = process
				.rawListeners("SIGTERM")
				.find((candidate) => !beforeListeners.has(candidate));
			assert.ok(listener, "signal listener must be installed before spawn");
			listener.call(process);
			queueMicrotask(() =>
				child.emit(
					"error",
					Object.assign(new Error("async spawn error"), { code: "EIO" }),
				),
			);
			return child as unknown as ChildProcess;
		},
		kill: () => assert.fail("PID-less child must not be killed"),
	};
	await assert.rejects(
		() => runInherited("unused", [], undefined, runtime),
		/async spawn error/,
	);
	for (const signal of signals)
		assert.equal(process.listenerCount(signal), before[signal]);
});

test("process-group teardown rejects non-ESRCH probe errors and cleans listeners", {
	skip: isWindows,
}, async () => {
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const before = Object.fromEntries(
		signals.map((signal) => [signal, process.listenerCount(signal)]),
	);
	const child = Object.assign(new EventEmitter(), { pid: 4321 });
	const runtime: InheritedRuntime = {
		spawn: () => {
			queueMicrotask(() => child.emit("exit", 7, null));
			return child as unknown as ChildProcess;
		},
		kill: (_pid, signal) => {
			if (signal === 0)
				throw Object.assign(new Error("probe denied"), { code: "EPERM" });
		},
	};
	await assert.rejects(
		() => runInherited("unused", [], undefined, runtime),
		(error: NodeJS.ErrnoException) => error.code === "EPERM",
	);
	for (const signal of signals)
		assert.equal(process.listenerCount(signal), before[signal]);
});

test("inherited attach uses production grace measured in seconds", () => {
	assert.ok(INHERITED_GRACE_MS.termGraceMs >= 1_000);
	assert.ok(INHERITED_GRACE_MS.killGraceMs >= 1_000);
});

test("process-group teardown rejects boundedly when the group remains after KILL", {
	skip: isWindows,
	timeout: 2_000,
}, async () => {
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const before = Object.fromEntries(
		signals.map((signal) => [signal, process.listenerCount(signal)]),
	);
	const child = Object.assign(new EventEmitter(), { pid: 4321 });
	const kills: Array<NodeJS.Signals | 0> = [];
	const runtime: InheritedRuntime = {
		spawn: () => {
			queueMicrotask(() => child.emit("exit", 7, null));
			return child as unknown as ChildProcess;
		},
		kill: (_pid, signal) => kills.push(signal),
	};
	const started = Date.now();
	await assert.rejects(
		() =>
			runInherited("unused", [], undefined, runtime, {
				termGraceMs: 50,
				killGraceMs: 50,
			}),
		/Process group 4321 remained after SIGKILL/,
	);
	assert.ok(Date.now() - started < 1_500);
	assert.equal(kills.filter((signal) => signal === "SIGTERM").length, 1);
	assert.equal(kills.filter((signal) => signal === "SIGKILL").length, 1);
	const probes = kills.filter((signal) => signal === 0).length;
	assert.ok(probes > 1 && probes < 200, `finite probe count: ${probes}`);
	for (const signal of signals)
		assert.equal(process.listenerCount(signal), before[signal]);
});

test("queued drain stops after the first non-ESRCH kill failure", {
	skip: isWindows,
}, async () => {
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const before = Object.fromEntries(
		signals.map((signal) => [signal, process.listenerCount(signal)]),
	);
	const child = Object.assign(new EventEmitter(), { pid: 4321 });
	const kills: Array<[number, NodeJS.Signals]> = [];
	const beforeListeners = new Set(
		signals.flatMap((signal) => process.rawListeners(signal)),
	);
	const runtime: InheritedRuntime = {
		spawn: () => {
			for (const signal of ["SIGINT", "SIGTERM"] as const) {
				const listener = process
					.rawListeners(signal)
					.find((candidate) => !beforeListeners.has(candidate));
				assert.ok(listener, "signal listener must be installed before spawn");
				listener.call(process, signal);
			}
			return child as unknown as ChildProcess;
		},
		kill: (pid, signal) => {
			kills.push([pid, signal as NodeJS.Signals]);
			throw Object.assign(new Error("not permitted"), { code: "EPERM" });
		},
	};
	await assert.rejects(
		() => runInherited("unused", [], undefined, runtime),
		(error: NodeJS.ErrnoException) => error.code === "EPERM",
	);
	assert.deepEqual(kills, [[-4321, "SIGINT"]]);
	for (const signal of signals)
		assert.equal(process.listenerCount(signal), before[signal]);
});

test("synchronous spawn failure removes preinstalled listeners", {
	skip: isWindows,
}, async () => {
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const before = Object.fromEntries(
		signals.map((signal) => [signal, process.listenerCount(signal)]),
	);
	const runtime: InheritedRuntime = {
		spawn: () => {
			throw new Error("synchronous spawn failure");
		},
		kill: process.kill,
	};
	await assert.rejects(
		() => runInherited("unused", [], undefined, runtime),
		/synchronous spawn failure/,
	);
	for (const signal of signals)
		assert.equal(process.listenerCount(signal), before[signal]);
});

test("readiness rejects on early exit and leaves no child", {
	skip: isWindows,
	timeout: 10_000,
}, async (t) => {
	const wrapper = spawnWrapped(
		t,
		"console.error('child-pid:' + process.pid); process.exit(7)",
	);
	await assert.rejects(
		() => wrapper.waitForLine("ready"),
		/error: child-pid:|output: [\s\S]*child-pid:/,
	);
	assert.deepEqual(await wrapper.exit, { code: 7, signal: null });
	const pid = Number(wrapper.output.match(/child-pid:(\d+)/)?.[1]);
	assert.ok(pid > 0);
	await wrapper.assertNoOwnedProcesses();
});

test("natural direct-child exit kills a TERM-resistant same-group grandchild before resolving", {
	skip: isWindows,
	timeout: 10_000,
}, async (t) => {
	const grandchild = `
		process.on("SIGTERM", () => console.log("natural-grandchild-ignored-term"));
		process.send("ready");
		setInterval(() => {}, 1000);
	`;
	const child = `
		import { spawn } from "node:child_process";
		const grandchild = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchild)}, process.argv[1]], {
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		grandchild.once("message", () => {
			console.log("natural-grandchild:" + grandchild.pid);
			process.exit(7);
		});
	`;
	const wrapper = spawnWrapped(t, child);
	await wrapper.waitForLine("natural-grandchild:");
	await wrapper.waitForLine("natural-grandchild-ignored-term");
	assert.deepEqual(
		await wrapper.exit,
		{ code: 7, signal: null },
		wrapper.output,
	);
	const pid = Number(wrapper.output.match(/natural-grandchild:(\d+)/)?.[1]);
	assert.ok(pid > 0);
	await wrapper.assertNoOwnedProcesses();
});

test("forwarded TERM reaps a resistant grandchild before preserving the direct-child result", {
	skip: isWindows,
	timeout: 10_000,
}, async (t) => {
	const grandchild = `
		process.on("SIGTERM", () => console.log("forwarded-grandchild-ignored-term"));
		process.send("ready");
		setInterval(() => {}, 1000);
	`;
	const child = `
		import { spawn } from "node:child_process";
		const grandchild = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchild)}, process.argv[1]], {
			stdio: ["ignore", "inherit", "inherit", "ipc"],
		});
		process.on("SIGTERM", () => process.exit(42));
		grandchild.once("message", () => console.log("forwarded-grandchild:" + grandchild.pid));
	`;
	const wrapper = spawnWrapped(t, child);
	await wrapper.waitForLine("forwarded-grandchild:");
	wrapper.child.kill("SIGTERM");
	await wrapper.waitForLine("forwarded-grandchild-ignored-term");
	assert.deepEqual(
		await wrapper.exit,
		{ code: 42, signal: null },
		wrapper.output,
	);
	const pid = Number(wrapper.output.match(/forwarded-grandchild:(\d+)/)?.[1]);
	assert.ok(pid > 0);
	await wrapper.assertNoOwnedProcesses();
});

test("forwarded TERM boundedly kills a resistant direct child and descendant", {
	skip: isWindows,
	timeout: 30_000,
}, async (t) => {
	for (let attempt = 1; attempt <= 3; attempt++)
		await t.test(`attempt ${attempt}`, async (t) => {
			const grandchild = `
				process.on("SIGTERM", () => console.log("resistant-grandchild-ignored"));
				process.send("ready");
				setInterval(() => {}, 1000);
			`;
			const child = `
				import { spawn } from "node:child_process";
				const grandchild = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchild)}, process.argv[1]], {
					stdio: ["ignore", "inherit", "inherit", "ipc"],
				});
				process.on("SIGTERM", () => console.log("resistant-direct-ignored"));
				grandchild.once("message", () => console.log("resistant-grandchild:" + grandchild.pid));
			`;
			const wrapper = spawnWrapped(t, child);
			await wrapper.waitForLine("resistant-grandchild:");
			const processGroup = Number(
				wrapper.output.match(/process-group:(\d+)/)?.[1],
			);
			const grandchildPid = Number(
				wrapper.output.match(/resistant-grandchild:(\d+)/)?.[1],
			);
			assert.ok(processGroup > 0);
			assert.ok(grandchildPid > 0);
			await wrapper.assertOwnedProcessTree([processGroup, grandchildPid]);
			wrapper.child.kill("SIGTERM");
			await wrapper.waitForLine("resistant-direct-ignored");
			await wrapper.waitForLine("resistant-grandchild-ignored");
			const result = await wrapper.exit;
			await wrapper.assertNoOwnedProcesses([processGroup, grandchildPid]);
			if (result.code === 137) assert.equal(result.signal, null);
			else {
				assert.equal(result.signal, null);
				assert.notEqual(result.code, 0);
				assert.match(wrapper.output, /\bEPERM\b/);
			}
		});
});

test("inherited runner preserves a child-defined SIGINT exit", {
	skip: isWindows,
	timeout: 10_000,
}, async (t) => {
	await expectSignalStatus(
		t,
		"SIGINT",
		42,
		"process.on('SIGINT', () => process.exit(42)); console.log('ready'); setInterval(() => {}, 1000)",
	);
});

test(
	"inherited runner maps unhandled SIGTERM to 143",
	{ skip: isWindows, timeout: 10_000 },
	(t) => expectSignalStatus(t, "SIGTERM", 143),
);

test(
	"inherited runner maps unhandled SIGHUP to 129",
	{ skip: isWindows, timeout: 10_000 },
	(t) => expectSignalStatus(t, "SIGHUP", 129),
);

test("inherited runner maps spawn ENOENT to SbxNotInstalledError", {
	skip: isWindows,
}, async () => {
	await assert.rejects(
		() => runInherited(`/missing/pi-dsbx-${process.pid}`, [], process.env),
		SbxNotInstalledError,
	);
});

test("sequential inherited runs do not accumulate signal listeners", {
	skip: isWindows,
}, async () => {
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const before = Object.fromEntries(
		signals.map((signal) => [signal, process.listenerCount(signal)]),
	);
	for (let run = 0; run < 2; run++) {
		assert.equal(
			await runInherited(process.execPath, ["-e", ""], process.env),
			0,
		);
		for (const signal of signals)
			assert.equal(process.listenerCount(signal), before[signal]);
	}
});

test("termination reaches a grandchild in the child process group", {
	skip: isWindows,
	timeout: 10_000,
}, async (t) => {
	const grandchild = `
			process.on("SIGTERM", () => console.log("grandchild-terminated"));
			process.send("ready");
			setInterval(() => {}, 1000);
		`;
	const child = `
			import { spawn } from "node:child_process";
			const grandchild = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(grandchild)}, process.argv[1]], {
				stdio: ["ignore", "inherit", "inherit", "ipc"],
			});
			grandchild.once("message", () => console.log("ready:" + grandchild.pid));
			setInterval(() => {}, 1000);
		`;
	const wrapper = spawnWrapped(t, child);
	await wrapper.waitForLine("ready:");
	wrapper.child.kill("SIGTERM");
	await wrapper.waitForLine("grandchild-terminated");
	assert.deepEqual(
		await wrapper.exit,
		{ code: 143, signal: null },
		wrapper.output,
	);
});

test("inherited runner rejects explicitly on Windows", {
	skip: !isWindows,
}, async () => {
	await assert.rejects(
		() => runInherited(process.execPath, ["-e", ""], process.env),
		/unsupported on Windows/,
	);
});
