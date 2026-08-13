import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseRunArgs } from "../src/cli.ts";
import {
	launch,
	requireExplicitWeakModes,
	sanitizedHostEnvironment,
	stripSandboxFlags,
} from "../src/launch.ts";
import { buildReexecArguments } from "../src/reexec.ts";
import { sandboxName, statePath } from "../src/workspace.ts";
import {
	SbxClient,
	SbxCommandError,
	type CommandRunner,
} from "../src/sbx/client.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function unbornRepository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-unborn-"));
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.email", "test@example.com");
	await git(root, "config", "user.name", "Test");
	return root;
}

async function committedRepository(): Promise<string> {
	const root = await unbornRepository();
	await writeFile(join(root, "file.txt"), "initial\n");
	await git(root, "add", "file.txt");
	await git(root, "commit", "-m", "initial");
	return await realpath(root);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

const launchClient = {
	capabilities: async () => ({
		clone: true,
		noShareSkills: true,
		kitValidate: true,
		inspectJson: true,
		policyCheckNetwork: true,
		credentialServices: [],
	}),
	secretServices: async () => new Set<string>(),
	exists: async () => false,
	validateKit: async () => undefined,
	create: async () => undefined,
	attach: async () => 0,
} as unknown as SbxClient;

const launchConfig = {
	syncProfile: "clean" as const,
	sandbox: {
		image: `example.invalid/image@sha256:${"a".repeat(64)}`,
		keep: true,
	},
	export: { onExit: "never" as const },
};

test("launch stages personalization but no runtime package archive or setup", async () => {
	const root = await committedRepository();
	let kit = "";
	const client = {
		...launchClient,
		validateKit: async (directory: string) => {
			kit = await readFile(join(directory, "spec.yaml"), "utf8");
			assert.equal(
				await exists(join(directory, "files", "home", ".cache")),
				false,
			);
			assert.equal(
				await exists(
					join(
						directory,
						"files",
						"home",
						".pi",
						"agent",
						"docker-sandboxes-profile.json",
					),
				),
				true,
			);
		},
	} as unknown as SbxClient;
	await launch({ cwd: root, client, config: launchConfig });
	assert.equal(JSON.parse(kit).setup, undefined);
	assert.equal(kit.includes("npm install"), false);
	assert.equal(kit.includes(".tgz"), false);
	assert.equal(kit.includes("Downloading"), false);
});

test("resource copying is confirmed before Kit validation and sandbox creation", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-home-"));
	await mkdir(join(home, ".pi", "agent", "skills"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "skills", "SKILL.md"), "# Safe\n");
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	try {
		for (const mode of ["callback", "yes", "headless-reject"] as const) {
			const events: string[] = [];
			let summary = "";
			const removed: string[] = [];
			const client = {
				...launchClient,
				validateKit: async () => {
					events.push("validate");
				},
				create: async () => {
					events.push("create");
				},
				attach: async () => {
					events.push("attach");
					return 0;
				},
			} as unknown as SbxClient;
			const operation = launch({
				cwd: root,
				client,
				config: {
					...launchConfig,
					syncProfile: "custom",
					sync: {
						settings: false,
						models: false,
						packages: false,
						skills: true,
						prompts: false,
						themes: false,
						extensions: false,
						sessions: "managed",
					},
				},
				yes: mode === "yes",
				confirmResourceCopy:
					mode === "callback"
						? async (value) => {
								events.push("confirm");
								summary = value;
								return true;
							}
						: undefined,
				cleanup: { removeTemp: async (path) => void removed.push(path) },
			});
			if (mode === "headless-reject") {
				await assert.rejects(operation, /resource copy.*not approved/i);
				assert.deepEqual(events, []);
				assert.equal(removed.length, 1);
			} else {
				await operation;
				assert.deepEqual(
					events,
					mode === "callback"
						? ["confirm", "validate", "create", "attach"]
						: ["validate", "create", "attach"],
				);
				if (mode === "callback")
					assert.equal(
						summary,
						"Copy opt-in personalization resources into the sandbox?\nskills: 1 file, 7 bytes\nTotal: 1 file, 7 bytes",
					);
			}
		}
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("safe default needs no resource confirmation", async () => {
	const root = await committedRepository();
	let confirmations = 0;
	await launch({
		cwd: root,
		client: launchClient,
		config: launchConfig,
		confirmResourceCopy: async () => {
			confirmations++;
			return false;
		},
	});
	assert.equal(confirmations, 0);
});

test("missing proxy credentials are optional and guidance precedes launch", async () => {
	const root = await committedRepository();
	let kit = "";
	const events: string[] = [];
	const client = {
		...launchClient,
		capabilities: async () => ({
			...(await launchClient.capabilities()),
			credentialServices: ["cursor", "openai"],
		}),
		secretServices: async () => new Set<string>(),
		validateKit: async (directory: string) => {
			events.push("validate");
			kit = await readFile(join(directory, "spec.yaml"), "utf8");
		},
		create: async () => {
			events.push("create");
		},
		attach: async () => {
			events.push("attach");
			return 0;
		},
	} as unknown as SbxClient;
	const result = await launch({
		cwd: root,
		client,
		config: { ...launchConfig, providers: ["cursor", "openai"] },
		onWarning: (warning) => events.push(`warning:${warning}`),
	});
	const spec = JSON.parse(kit);
	assert.deepEqual(
		spec.credentials.map(
			(credential: { service: string }) => credential.service,
		),
		["openai"],
	);
	assert.equal(spec.credentials[0].required, false);
	assert.deepEqual(events.slice(-3), ["validate", "create", "attach"]);
	assert.ok(kit.includes('"required": false'));
	assert.equal(kit.includes("API_KEY=sk-"), false);
	assert.ok(
		events.indexOf("warning:  sbx secret set openai") <
			events.indexOf("validate"),
	);
	assert.ok(
		result.warnings.includes(
			"Requested credential service cursor is not both audited and proxy-supported",
		),
	);
	for (const line of [
		"No proxied model credential is configured. Exit Pi, run one of:",
		"  sbx secret set openai",
		"Then relaunch: pi --docker-sandbox",
		"Sandbox-local /login is unsupported by this package.",
	])
		assert.ok(result.warnings.includes(line));
});

test("configured requested proxy credential suppresses no-credential guidance callback", async () => {
	const root = await committedRepository();
	const delivered: string[] = [];
	const client = {
		...launchClient,
		capabilities: async () => ({
			...(await launchClient.capabilities()),
			credentialServices: ["cursor", "openai"],
		}),
		secretServices: async () => new Set(["openai"]),
	} as unknown as SbxClient;
	const result = await launch({
		cwd: root,
		client,
		config: { ...launchConfig, providers: ["openai", "cursor"] },
		onWarning: (warning) => delivered.push(warning),
	});
	assert.equal(
		result.warnings.some((warning) =>
			warning.startsWith("No proxied model credential is configured"),
		),
		false,
	);
	assert.ok(result.warnings.some((warning) => warning.includes("cursor")));
	assert.equal(
		delivered.some((warning) =>
			warning.startsWith("No proxied model credential is configured"),
		),
		false,
	);
});

test("credential presence discovery failures do not guess that credentials are missing", async () => {
	const root = await committedRepository();
	const client = {
		...launchClient,
		capabilities: async () => ({
			...(await launchClient.capabilities()),
			credentialServices: ["openai"],
		}),
		secretServices: async () => {
			throw new Error("unrecognized output");
		},
	} as unknown as SbxClient;
	const result = await launch({
		cwd: root,
		client,
		config: { ...launchConfig, providers: ["openai"] },
	});
	assert.ok(
		result.warnings.includes(
			"configured credential service discovery unavailable; credential setup guidance omitted",
		),
	);
	assert.equal(
		result.warnings.some((warning) =>
			warning.startsWith("No proxied model credential is configured"),
		),
		false,
	);
});

test("unborn repository rejection does not create a commit", async () => {
	const root = await unbornRepository();
	const statusBefore = await git(root, "status", "--porcelain=v1");
	const stagedBefore = await git(root, "ls-files", "--stage");
	await assert.rejects(
		() =>
			launch({
				cwd: root,
				client: launchClient,
				config: launchConfig,
				confirmInitialCommit: async (candidate) => {
					assert.equal(candidate, await realpath(root));
					return false;
				},
			}),
		/no initial commit/i,
	);
	await assert.rejects(() => git(root, "rev-parse", "--verify", "HEAD"));
	assert.equal(await git(root, "status", "--porcelain=v1"), statusBefore);
	assert.equal(await git(root, "ls-files", "--stage"), stagedBefore);
});

test("callback approval creates exactly one empty initial commit", async () => {
	const root = await unbornRepository();
	let approvals = 0;
	await launch({
		cwd: root,
		client: launchClient,
		config: launchConfig,
		confirmInitialCommit: async () => {
			approvals++;
			return true;
		},
	});
	assert.equal(approvals, 1);
	assert.equal(await git(root, "rev-list", "--count", "HEAD"), "1");
	assert.equal(await git(root, "show", "--format=", "--name-only", "HEAD"), "");
});

test("--yes creates exactly one empty initial commit", async () => {
	const root = await unbornRepository();
	await launch({
		cwd: root,
		client: launchClient,
		config: launchConfig,
		yes: true,
	});
	assert.equal(await git(root, "rev-list", "--count", "HEAD"), "1");
	assert.equal(await git(root, "show", "--format=", "--name-only", "HEAD"), "");
});

test("state persists immediately after create before repository reinspection", async () => {
	for (const mode of [
		"success",
		"launch-failure",
		"head-drift",
		"identity-drift",
	] as const) {
		const root = await committedRepository();
		const name = sandboxName(root);
		const path = statePath(root, name);
		const calls: string[] = [];
		const client = {
			capabilities: launchClient.capabilities,
			exists: async () => false,
			validateKit: async () => {
				calls.push("validate");
				assert.equal(await exists(path), false);
			},
			create: async () => {
				calls.push("create");
				assert.equal(await exists(path), false);
				if (mode === "launch-failure")
					throw new Error("injected launch failure");
				if (mode === "head-drift") {
					await writeFile(join(root, "drift.txt"), "drift\n");
					await git(root, "add", "drift.txt");
					await git(root, "commit", "-m", "drift");
				}
				if (mode === "identity-drift")
					await git(
						root,
						"remote",
						"add",
						"origin",
						"https://example.invalid/repo",
					);
			},
			attach: async () => {
				calls.push("attach");
				assert.equal(await exists(path), true);
				return 0;
			},
		} as unknown as SbxClient;
		const operation = launch({ cwd: root, client, config: launchConfig });
		if (mode === "success") await operation;
		else
			await assert.rejects(
				operation,
				mode === "launch-failure" ? /injected/ : /changed during/,
			);
		assert.deepEqual(
			calls,
			mode === "launch-failure"
				? ["validate", "create"]
				: mode === "success"
					? ["validate", "create", "attach"]
					: ["validate", "create"],
		);
		assert.equal(
			await exists(path),
			mode === "success" || mode === "head-drift" || mode === "identity-drift",
		);
	}
});

test("capability and existence failures are phased and redact sbx stderr", async () => {
	for (const boundary of ["capabilities", "exists"] as const) {
		const root = await committedRepository();
		const secret = `sk-${boundary}-1234567890abcdef`;
		const client = {
			capabilities: async () => {
				if (boundary === "capabilities")
					throw new SbxCommandError(["create"], 7, `token=${secret}`);
				return await launchClient.capabilities();
			},
			exists: async () => {
				throw new SbxCommandError(["list"], 8, `token=${secret}`);
			},
		} as unknown as SbxClient;
		await assert.rejects(
			() => launch({ cwd: root, client, config: launchConfig }),
			(error) => {
				assert.equal(
					(error as { phase?: string }).phase,
					boundary === "capabilities" ? "preflight" : "prepare",
				);
				assert.equal(String(error).includes(secret), false);
				assert.equal(
					(error as { detail?: string }).detail?.includes(secret),
					false,
				);
				assert.match(
					(error as { detail?: string }).detail ?? "",
					/\[redacted\]/,
				);
				assert.ok((error as { recovery?: readonly string[] }).recovery?.length);
				return true;
			},
		);
	}
});

test("outer Pi flags are stripped without touching provider flags", () => {
	assert.deepEqual(
		stripSandboxFlags([
			"--docker-sandbox",
			"--docker-sandbox=false",
			"--docker-sandbox-profile",
			"hardened",
			"--provider",
			"openai",
			"--docker-sandbox-sync=clean",
			"--docker-sandbox-discard-changes=false",
			"prompt",
		]),
		["--provider", "openai", "prompt"],
	);
	assert.throws(
		() => stripSandboxFlags(["--docker-sandbox-keep=invalid"]),
		/boolean/i,
	);
});

test("host environment uses a deterministic positive allowlist", () => {
	const filtered = sanitizedHostEnvironment({
		LC_Z: "Zulu",
		PATH: "/bin",
		HOME: "/home/test",
		USER: "test",
		LOGNAME: "test-logname",
		SHELL: "/bin/sh",
		TERM: "xterm",
		COLORTERM: "truecolor",
		LANG: "日本語.UTF-8",
		LC_A: "Ångström.UTF-8",
		AWS_SESSION_TOKEN: "secret",
		OAUTH_TOKEN: "secret",
		NPM_TOKEN: "secret",
		CI_JOB_TOKEN: "secret",
		UNKNOWN: "not-needed",
		HTTP_PROXY: "http://proxy.invalid",
		NO_PROXY: "localhost",
		SSH_AUTH_SOCK: "/tmp/agent.sock",
		OPENAI_API_KEY: "secret",
		PI_PROVIDER_TOKEN: "secret",
		NODE_OPTIONS: "--require=/tmp/inherited.js",
		lc_time: "lowercase",
		LC_: "empty-suffix",
		LC_bad: "mixed-case",
		"LC_BAD-NAME": "dashed",
		LC_UNDEFINED: undefined,
	});
	assert.deepEqual(Object.keys(filtered), [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"TERM",
		"COLORTERM",
		"LANG",
		"LC_Z",
		"LC_A",
	]);
	assert.deepEqual(filtered, {
		PATH: "/bin",
		HOME: "/home/test",
		USER: "test",
		LOGNAME: "test-logname",
		SHELL: "/bin/sh",
		TERM: "xterm",
		COLORTERM: "truecolor",
		LANG: "日本語.UTF-8",
		LC_Z: "Zulu",
		LC_A: "Ångström.UTF-8",
	});
});

test("host environment omits empty and controlled values from fixed and locale keys", () => {
	const controls = [
		["NUL", "\0"],
		["BEL", "\x07"],
		["TAB", "\t"],
		["LF", "\n"],
		["VT", "\v"],
		["FF", "\f"],
		["CR", "\r"],
		["ESC", "\x1b"],
		["DEL", "\x7f"],
		["NEL", "\x85"],
	] as const;
	for (const key of [
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"SHELL",
		"TERM",
		"COLORTERM",
		"LANG",
		"LC_ALL",
	] as const) {
		assert.deepEqual(sanitizedHostEnvironment({ [key]: "" }), {});
		for (const [name, control] of controls)
			assert.deepEqual(
				sanitizedHostEnvironment({ [key]: `safe${control}unsafe` }),
				{},
				`${key} containing ${name}`,
			);
	}
});

test("launch passes the exact sanitized environment to create and attach requests", async () => {
	const root = await committedRepository();
	const requests: Array<{ env?: NodeJS.ProcessEnv }> = [];
	const inherited = {
		NODE_OPTIONS: process.env.NODE_OPTIONS,
		AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
		SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
	};
	Object.assign(process.env, {
		NODE_OPTIONS: "--require=/tmp/canary.js",
		AWS_SESSION_TOKEN: "canary",
		SSH_AUTH_SOCK: "/tmp/host-agent.sock",
	});
	let result: Awaited<ReturnType<typeof launch>> | undefined;
	try {
		const client = {
			...launchClient,
			create: async (request: { env?: NodeJS.ProcessEnv }) => {
				requests.push(request);
			},
			inspect: async () => ({ image: launchConfig.sandbox.image }),
			attach: async (request: { env?: NodeJS.ProcessEnv }) => {
				requests.push(request);
				return 0;
			},
		} as unknown as SbxClient;
		result = await launch({
			cwd: root,
			client,
			config: { ...launchConfig, workspaceMode: "direct" },
			yes: true,
		});
	} finally {
		if (inherited.AWS_SESSION_TOKEN === undefined)
			delete process.env.AWS_SESSION_TOKEN;
		else process.env.AWS_SESSION_TOKEN = inherited.AWS_SESSION_TOKEN;
		if (inherited.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = inherited.NODE_OPTIONS;
		if (inherited.SSH_AUTH_SOCK === undefined) delete process.env.SSH_AUTH_SOCK;
		else process.env.SSH_AUTH_SOCK = inherited.SSH_AUTH_SOCK;
	}
	assert.ok(
		result?.warnings.includes(
			"launcher does not pass host SSH_AUTH_SOCK; Docker Sandboxes may independently provide a proxy socket",
		),
	);
	assert.equal(requests.length, 2);
	assert.deepEqual(requests[0]?.env, sanitizedHostEnvironment(process.env));
	assert.equal(requests[0]?.env?.NODE_OPTIONS, undefined);
	assert.equal(requests[0]?.env?.AWS_SESSION_TOKEN, undefined);
	assert.deepEqual(requests[1]?.env, requests[0]?.env);
});

test("weaker boundaries require approval and fail closed", async () => {
	const base = (await import("../src/config.ts")).mergeConfig({
		workspaceMode: "direct",
		shareSkills: true,
	});
	await assert.rejects(
		() =>
			requireExplicitWeakModes(base, false, async (question) => {
				assert.match(question, /modify your host working tree/);
				assert.match(question, /cross-sandbox trust boundary/);
				return false;
			}),
		/cancelled/,
	);
	await requireExplicitWeakModes(base, true, async () => false);
});

test("re-exec boolean flags accept only exact true or false values", () => {
	const flags = [
		["--docker-sandbox-fresh", "--fresh"],
		["--docker-sandbox-direct", "--direct"],
		["--docker-sandbox-keep", "--keep"],
		["--docker-sandbox-no-sync-back", "--no-sync-back"],
		["--docker-sandbox-discard-changes", "--discard-changes"],
		["--yes", "--yes"],
	] as const;
	for (const [outer, launcher] of flags) {
		for (const spelling of [outer, `${outer}=true`]) {
			const parsed = buildReexecArguments(["--docker-sandbox", spelling]);
			assert.ok(parsed?.launcherArgs.includes(launcher), spelling);
		}
		const disabled = buildReexecArguments([
			"--docker-sandbox",
			`${outer}=false`,
			"prompt",
		]);
		assert.ok(disabled);
		assert.equal(disabled.launcherArgs.includes(launcher), false, outer);
		assert.deepEqual(disabled.innerPiArgs, ["prompt"]);
		assert.throws(
			() => buildReexecArguments(["--docker-sandbox", `${outer}=invalid`]),
			/boolean/i,
		);
	}
	assert.equal(
		buildReexecArguments(["--docker-sandbox=false", "prompt"]),
		undefined,
	);
	assert.throws(
		() => buildReexecArguments(["--docker-sandbox=invalid"]),
		/boolean/i,
	);
});

test("re-exec maps sandbox flags and preserves inner Pi argv", () => {
	const parsed = buildReexecArguments([
		"--docker-sandbox",
		"--docker-sandbox-profile=hardened",
		"--docker-sandbox-fresh",
		"--docker-sandbox-discard-changes",
		"--yes",
		"--model",
		"openai/gpt",
		"hello world",
	]);
	assert.ok(parsed);
	assert.deepEqual(parsed.innerPiArgs, [
		"--model",
		"openai/gpt",
		"hello world",
	]);
	assert.deepEqual(parsed.launcherArgs.slice(-4), [
		"--",
		"--model",
		"openai/gpt",
		"hello world",
	]);
	assert.ok(parsed.launcherArgs.includes("--profile"));
	assert.ok(parsed.launcherArgs.includes("--yes"));
	assert.ok(parsed.launcherArgs.includes("--discard-changes"));
	assert.equal(buildReexecArguments(["--model", "x"]), undefined);
});

test("sbx create argv uses clone and no-share-skills by default", () => {
	const client = new SbxClient("sbx", (async () => ({
		stdout: "",
		stderr: "",
		code: 0,
	})) as CommandRunner);
	assert.deepEqual(
		client.createArgs({
			name: "pi-safe-123",
			workspace: "/tmp/repo with spaces",
			kit: "/tmp/kit",
			workspaceMode: "clone",
			agentArgs: ["--model", "x"],
		}),
		[
			"create",
			"--name",
			"pi-safe-123",
			"--kit",
			"/tmp/kit",
			"--clone",
			"--no-share-skills",
			"pi-docker-sandboxes",
			"/tmp/repo with spaces",
		],
	);
	assert.equal(
		client
			.createArgs({
				name: "pi-safe",
				workspace: "/tmp/x",
				kit: "/tmp/k",
				workspaceMode: "direct",
			})
			.includes("--clone"),
		false,
	);
});

test("CLI parser requires explicit options and keeps Pi args after separator", () => {
	const parsed = parseRunArgs([
		"--profile",
		"hardened",
		"--direct",
		"--discard-changes",
		"--yes",
		"--",
		"--help",
	]);
	assert.equal(parsed.override.profile, "hardened");
	assert.equal(parsed.override.workspaceMode, "direct");
	assert.equal(parsed.yes, true);
	assert.equal(parsed.discardChanges, true);
	assert.deepEqual(parsed.piArgs, ["--help"]);
	assert.throws(() => parseRunArgs(["--wat"]), /Unknown run option/);
});
