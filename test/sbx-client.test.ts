import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseSecretRowPrefix,
	runInherited,
	SbxClient,
	SbxCommandError,
	type CommandRunner,
} from "../src/sbx/client.ts";
import { sanitizedHostEnvironment } from "../src/launch.ts";
import type { InheritedRuntime } from "../src/sbx/inherited-runner.mjs";

function containsString(value: unknown, needle: string): boolean {
	if (typeof value === "string") return value.includes(needle);
	if (value instanceof Set)
		return [...value].some((entry) => containsString(entry, needle));
	if (Array.isArray(value))
		return value.some((entry) => containsString(entry, needle));
	if (value && typeof value === "object")
		return Object.values(value).some((entry) => containsString(entry, needle));
	return false;
}

function fakeRunner(
	outputs: Record<string, string>,
	calls: string[][],
): CommandRunner {
	return async (command, args) => {
		calls.push([command, ...args]);
		const key = args.join(" ");
		return {
			stdout: outputs[key] ?? "",
			stderr: "",
			code: key in outputs ? 0 : 1,
		};
	};
}

test("uses argv arrays and parses current sbx output", async () => {
	const calls: string[][] = [];
	const client = new SbxClient(
		"sbx-test",
		fakeRunner(
			{
				version:
					"sbx version: v0.38.0 c022b14634c4bea846ca12870d1d5e97d5868b54\n",
				"list --json": '{"sandboxes":[]}',
				"inspect safe-name --json": '{"name":"safe-name"}',
			},
			calls,
		),
	);

	assert.deepEqual(await client.version(), {
		version: "0.38.0",
		commit: "c022b14634c4bea846ca12870d1d5e97d5868b54",
	});
	assert.deepEqual(await client.list(), []);
	assert.deepEqual(await client.inspect("safe-name"), { name: "safe-name" });
	assert.deepEqual(calls, [
		["sbx-test", "version"],
		["sbx-test", "list", "--json"],
		["sbx-test", "inspect", "safe-name", "--json"],
	]);
});

test("credential services are parsed from current sbx help", async () => {
	const client = new SbxClient(
		"sbx",
		fakeRunner(
			{
				"secret set --help":
					"Create a secret.\n  Available services: openai, openrouter, xai\n",
			},
			[],
		),
	);

	assert.deepEqual(await client.credentialServices(), [
		"openai",
		"openrouter",
		"xai",
	]);
});

test("credential service parsing is tolerant, strict, and deterministic", async () => {
	for (const [output, expected] of [
		[
			"Available services: xai, openai, xai,  anthropic\n",
			["anthropic", "openai", "xai"],
		],
		["prefix Available services: openai\n", []],
		["Available services: openai, INVALID, openrouter\n", []],
		["Available services: openai\nAvailable services: xai\n", []],
		["Available services:\n", []],
		["unrelated help\n", []],
	] as const) {
		const client = new SbxClient("sbx", async () => ({
			stdout: output,
			stderr: "",
			code: 0,
		}));
		assert.deepEqual(await client.credentialServices(), expected);
	}

	const unavailable = new SbxClient("sbx", async () => ({
		stdout: "",
		stderr: "command unavailable",
		code: 1,
	}));
	assert.deepEqual(await unavailable.credentialServices(), []);
});

test("secret row prefix parsing never captures the opaque secret remainder", () => {
	const canary = "unique-canary-proxy-secret-remainder";
	const parsed = parseSecretRowPrefix(
		`(global) service openai ${canary} with-spaces`,
	);
	assert.deepEqual(parsed, {
		scope: "(global)",
		type: "service",
		name: "openai",
	});
	const retained: unknown[] = [
		parsed,
		Object.keys(parsed),
		Object.values(parsed),
	];
	assert.equal(containsString(retained, canary), false);
	assert.equal(parseSecretRowPrefix("(global) service openai "), undefined);
	assert.equal(parseSecretRowPrefix("(global) service openai"), undefined);
});

test("secret service parsing reads names only from actual sbx table formats", async () => {
	const canary = "unique-canary-client-secret-remainder";
	for (const [output, expected] of [
		[
			`SCOPE      TYPE     NAME       SECRET\n(global)   service  github     ${canary}\nmy-box     service  openai     another-secret\n(global)   registry ghcr.io    registry-secret\n`,
			new Set(["github", "openai"]),
		],
		[
			"No secrets found. Run 'sbx secret set --help' to see available services.\n",
			new Set(),
		],
		['No secrets found for service "openai".\n', new Set()],
	] as const) {
		const client = new SbxClient("sbx", async () => ({
			stdout: output,
			stderr: "",
			code: 0,
		}));
		const services = await client.secretServices();
		assert.deepEqual(services, expected);
		assert.equal(containsString(services, canary), false);
	}
});

test("secret listing failures and malformed output do not expose command output", async () => {
	const secret = "canary-secret-value-never-materialize";
	const retained: unknown[] = [];
	for (const result of [
		{ stdout: "", stderr: `fatal: token=${secret}`, code: 7 },
		{
			stdout: `SCOPE TYPE NAME SECRET\n(global) service openai ${secret}\nmalformed`,
			stderr: "",
			code: 0,
		},
		{
			stdout: `No secrets found. Run 'sbx secret set --help' to see available services.\n${secret}`,
			stderr: "",
			code: 0,
		},
		{
			stdout: `No secrets found for service "openai".\n${secret}`,
			stderr: "",
			code: 0,
		},
	]) {
		const client = new SbxClient("sbx", async () => result);
		await assert.rejects(
			() => client.secretServices(),
			(error: unknown) => {
				retained.push(error);
				assert.equal(String(error).includes(secret), false);
				assert.equal(containsString(error, secret), false);
				return true;
			},
		);
	}
	assert.equal(containsString(retained, secret), false);
});

test("capabilities include dynamically discovered credential services", async () => {
	const client = new SbxClient("sbx", async (_command, args) => {
		const help: Record<string, string> = {
			"create --help": "--clone --no-share-skills",
			"kit --help": "validate",
			"inspect --help": "--json",
			"policy check network --help": "sbx policy check network",
			"secret set --help": "Available services: openrouter, openai",
		};
		const key = args.join(" ");
		return { stdout: help[key] ?? "", stderr: "", code: key in help ? 0 : 1 };
	});

	assert.deepEqual((await client.capabilities()).credentialServices, [
		"openai",
		"openrouter",
	]);
});

test("setSecret times out instead of hanging on an interactive helper", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-secret-timeout-"));
	const helper = join(directory, "sbx");
	await writeFile(
		helper,
		`#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n`,
	);
	await chmod(helper, 0o755);
	const client = new SbxClient(helper);
	const started = Date.now();
	await assert.rejects(
		() => client.setSecret("openai", "host-api-key-value", 200),
		/failed/,
	);
	assert.ok(Date.now() - started < 20_000);
	await rm(directory, { recursive: true, force: true });
});

test("setSecret sends the value on stdin and never on argv", async () => {
	const calls: Array<{ args: string[]; input?: string }> = [];
	const client = new SbxClient("sbx", async (_command, args, options) => {
		calls.push({ args: [...args], input: options?.input });
		return { stdout: "", stderr: "", code: 0 };
	});
	await client.setSecret("openai", "host-api-key-value");
	assert.deepEqual(calls, [
		{ args: ["secret", "set", "openai"], input: "host-api-key-value\n" },
	]);
	assert.equal(JSON.stringify(calls[0]?.args).includes("host-api-key-value"), false);
	await assert.rejects(() => client.setSecret("openai", "one\ntwo"), /Invalid secret value/);
});

test("rejects sandbox names before process execution", async () => {
	let called = false;
	const client = new SbxClient("sbx", async () => {
		called = true;
		return { stdout: "", stderr: "", code: 0 };
	});

	await assert.rejects(() => client.inspect("bad;touch /tmp/pwned"), TypeError);
	assert.equal(called, false);
});

test("lifecycle and policy methods preserve literal argv", async () => {
	const calls: string[][] = [];
	const runner: CommandRunner = async (command, args) => {
		calls.push([command, ...args]);
		const key = args.join(" ");
		if (key.startsWith("policy check"))
			return {
				stdout: '{"allowed":false,"reason":"default deny"}',
				stderr: "",
				code: 0,
			};
		return { stdout: "", stderr: "", code: 0 };
	};
	const client = new SbxClient("sbx", runner);
	assert.deepEqual(
		await client.policyCheckNetwork("api.example.com:443", "safe-name"),
		{ allowed: false, reason: "default deny" },
	);
	await client.exec("safe-name", ["printf", "%s", "$(not-shell)"], {
		workdir: "/repo with spaces",
		env: { SAFE: "x y" },
		user: "root",
	});
	await client.remove("safe-name", true);
	await client.copyFrom("safe-name", "/tmp/a b", "/host/a b");
	assert.deepEqual(calls[1], [
		"sbx",
		"exec",
		"--workdir",
		"/repo with spaces",
		"--env",
		"SAFE=x y",
		"-u",
		"root",
		"safe-name",
		"printf",
		"%s",
		"$(not-shell)",
	]);
	assert.deepEqual(calls.at(-1), [
		"sbx",
		"cp",
		"safe-name:/tmp/a b",
		"/host/a b",
	]);
	await assert.rejects(
		() => client.policyCheckNetwork("api.example.com\nmalicious"),
		TypeError,
	);
});

test("detects the hidden no-share-skills flag without creating a sandbox", async () => {
	const client = new SbxClient("sbx", async (_command, args) => {
		const key = args.join(" ");
		if (key === "create --no-share-skills") {
			return {
				stdout: "",
				stderr: "ERROR: requires at least 1 argument: AGENT",
				code: 1,
			};
		}
		const help: Record<string, string> = {
			"create --help": "--clone",
			"kit --help": "validate",
			"inspect --help": "--json",
			"policy check network --help": "sbx policy check network",
		};
		return { stdout: help[key] ?? "", stderr: "", code: key in help ? 0 : 1 };
	});

	assert.deepEqual(await client.capabilities(), {
		clone: true,
		noShareSkills: true,
		kitValidate: true,
		inspectJson: true,
		policyCheckNetwork: true,
		credentialServices: [],
	});
});

test("runInherited uses the exact supplied child environment without fallback merging", async () => {
	const environments: Array<NodeJS.ProcessEnv | undefined> = [];
	const child = Object.assign(
		new (await import("node:events")).EventEmitter(),
		{
			pid: 4321,
		},
	);
	const runtime: InheritedRuntime = {
		spawn: (_command, _args, spawnOptions) => {
			environments.push(spawnOptions.env);
			queueMicrotask(() => child.emit("exit", 0, null));
			return child as never;
		},
		kill: (_pid, signal) => {
			if (signal === 0)
				throw Object.assign(new Error("group absent"), { code: "ESRCH" });
		},
	};
	const env: NodeJS.ProcessEnv = { PATH: "/bin", TERM: "xterm" };
	await runInherited("sbx", ["run"], env, runtime);
	await runInherited("sbx", ["run"], undefined, runtime);
	assert.deepEqual(environments, [env, {}]);
	assert.equal(environments[0]?.NODE_OPTIONS, undefined);
});

test("constructs separate create and attach argv with the exact request environment", async () => {
	const commandCalls: Array<{
		command: string;
		args: readonly string[];
		env?: NodeJS.ProcessEnv;
	}> = [];
	const inheritedCalls: Array<{
		command: string;
		args: readonly string[];
		env?: NodeJS.ProcessEnv;
	}> = [];
	const client = new SbxClient(
		"sbx",
		async (command, args, options) => {
			commandCalls.push({ command, args, env: options?.env });
			return { stdout: "", stderr: "", code: 0 };
		},
		async (command, args, env) => {
			inheritedCalls.push({ command, args, env });
			return 0;
		},
	);
	const request = {
		name: "pi-safe",
		workspace: "/repo with spaces",
		kit: "/tmp/kit",
		agentArgs: ["--model", "x"],
		env: { PATH: "/bin", TERM: "xterm" },
	};
	const requestWithoutEnvironment = {
		name: "pi-empty",
		workspace: "/repo",
		kit: "/tmp/kit",
	};
	assert.deepEqual(client.createArgs(request), [
		"create",
		"--name",
		"pi-safe",
		"--kit",
		"/tmp/kit",
		"--clone",
		"--no-share-skills",
		"pi-docker-sandboxes",
		"/repo with spaces",
	]);
	assert.deepEqual(client.attachArgs(request), [
		"run",
		"--name",
		"pi-safe",
		"--",
		"--model",
		"x",
	]);
	await client.create(request);
	await client.attach(request);
	await client.create(requestWithoutEnvironment);
	await client.attach(requestWithoutEnvironment);
	assert.deepEqual(commandCalls, [
		{
			command: "sbx",
			args: client.createArgs(request),
			env: request.env,
		},
		{
			command: "sbx",
			args: client.createArgs(requestWithoutEnvironment),
			env: {},
		},
	]);
	assert.deepEqual(inheritedCalls, [
		{
			command: "sbx",
			args: client.attachArgs(request),
			env: request.env,
		},
		{
			command: "sbx",
			args: client.attachArgs(requestWithoutEnvironment),
			env: {},
		},
	]);
});

test("execBytes preserves binary stdout and enforces stdout maxBuffer", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-exec-bytes-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const executable = join(directory, "sbx");
	await writeFile(
		executable,
		`#!${process.execPath}\nconst size=Number(process.argv.at(-1)); process.stdout.write(Buffer.alloc(size, 0xff));\n`,
	);
	await chmod(executable, 0o755);
	const client = new SbxClient(executable);
	const result = await client.execBytes("pi-safe", ["emit", "4"], {
		maxBuffer: 5,
	});
	assert.deepEqual(result.stdout, Buffer.from([255, 255, 255, 255]));
	await assert.rejects(
		() => client.execBytes("pi-safe", ["emit", "6"], { maxBuffer: 5 }),
		/output exceeded the allowed size/,
	);
});

test("create process receives only the sanitized environment", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-create-env-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const executable = join(directory, "sbx");
	const output = join(directory, "environment.json");
	await writeFile(
		executable,
		`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));\n`,
	);
	await chmod(executable, 0o755);
	const blocked = [
		"AWS_SESSION_TOKEN",
		"OAUTH_TOKEN",
		"NPM_TOKEN",
		"CI_JOB_TOKEN",
		"HTTP_PROXY",
		"HTTPS_PROXY",
		"NO_PROXY",
		"SSH_AUTH_SOCK",
		"OPENAI_API_KEY",
		"PI_PROVIDER_TOKEN",
		"CUSTOM_VALUE",
		"NODE_OPTIONS",
	] as const;
	const candidate: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: "/home/test",
		TERM: "xterm-256color",
		LANG: "日本語.UTF-8",
		LC_ALL: "C.UTF-8",
	};
	for (const key of blocked) candidate[key] = `canary-${key}`;
	const env = sanitizedHostEnvironment(candidate);
	const client = new SbxClient(executable);
	await client.create({
		name: "pi-safe",
		workspace: "/repo",
		kit: directory,
		env,
	});
	const childEnvironment = JSON.parse(
		await readFile(output, "utf8"),
	) as NodeJS.ProcessEnv;
	// macOS injects this metadata variable even when spawn receives an explicit env.
	delete childEnvironment.__CF_USER_TEXT_ENCODING;
	assert.deepEqual(
		blocked.filter((key) => key in childEnvironment),
		[],
	);
	for (const key of Object.keys(env))
		assert.equal(key in childEnvironment, true);
	assert.deepEqual(
		Object.keys(childEnvironment).filter((key) => !(key in env)),
		[],
	);
});

test("create process with omitted environment does not inherit host canaries", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-create-empty-env-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const executable = join(directory, "sbx");
	const output = join(directory, "environment.json");
	await writeFile(
		executable,
		`#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.env));\n`,
	);
	await chmod(executable, 0o755);
	const canaryKey = "TASK2_OMITTED_ENV_CANARY";
	const previous = process.env[canaryKey];
	process.env[canaryKey] = "never-forward-this-value";
	try {
		await new SbxClient(executable).create({
			name: "pi-safe",
			workspace: "/repo",
			kit: directory,
		});
	} finally {
		if (previous === undefined) delete process.env[canaryKey];
		else process.env[canaryKey] = previous;
	}
	const childEnvironment = JSON.parse(
		await readFile(output, "utf8"),
	) as NodeJS.ProcessEnv;
	assert.equal(canaryKey in childEnvironment, false);
});

test("create process failures remain captured and sanitized", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-create-error-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const executable = join(directory, "sbx");
	const secret = "sk-create-process-canary";
	await writeFile(
		executable,
		`#!${process.execPath}\nprocess.stderr.write("fatal: token=${secret}"); process.exit(7);\n`,
	);
	await chmod(executable, 0o755);
	const client = new SbxClient(executable);
	await assert.rejects(
		() =>
			client.create({
				name: "pi-safe",
				workspace: "/repo",
				kit: directory,
				env: { PATH: process.env.PATH },
			}),
		(error: unknown) => {
			assert.ok(error instanceof SbxCommandError);
			assert.equal(error.exitCode, 7);
			assert.equal(error.stderr, "fatal: token=[redacted]");
			assert.equal(containsString(error, secret), false);
			return true;
		},
	);
});

test("constructs command errors without stderr", () => {
	const error = new SbxCommandError(["exec"], 7);
	assert.equal(error.message, "sbx exec failed with exit code 7");
	assert.equal(error.stderr, "");
});

test("maps non-zero exits without exposing command output or argv secrets", async () => {
	const secret = "sk-test-1234567890abcdef";
	const stdoutSentinel = "opaque-stdout-sentinel";
	const client = new SbxClient("sbx", async () => ({
		stdout: stdoutSentinel,
		stderr: `fatal: token=${secret}`,
		code: 7,
	}));
	await assert.rejects(
		() => client.exec("safe-name", ["false"], { env: { API_KEY: secret } }),
		(error: unknown) => {
			assert.ok(error instanceof SbxCommandError);
			assert.equal(error.message, "sbx exec failed with exit code 7");
			assert.equal(error.stderr, "fatal: token=[redacted]");
			assert.equal(error.message.includes(secret), false);
			assert.equal(error.stderr.includes(secret), false);
			assert.equal(error.message.includes(stdoutSentinel), false);
			assert.equal(error.stderr.includes(stdoutSentinel), false);
			return true;
		},
	);
});
