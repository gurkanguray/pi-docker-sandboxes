import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	realpath,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { parseRunArgs } from "../src/cli.ts";
import { OperationError } from "../src/errors.ts";
import { acquireSandboxLease } from "../src/lease.ts";
import {
	launch as productionLaunch,
	sanitizedHostEnvironment,
	stripSandboxFlags,
} from "../src/launch.ts";
import { buildReexecArguments } from "../src/reexec.ts";
import {
	inspectRepository,
	loadSandboxState,
	sandboxName,
	saveSandboxState,
	statePath,
} from "../src/workspace.ts";
import {
	CommandCancelledError,
	CommandTimeoutError,
	SbxClient,
	SbxCommandError,
	type CommandRunner,
} from "../src/sbx/client.ts";

const exec = promisify(execFile);
const packageTarball = Buffer.from("verified npm tarball fixture");
const packageIntegrity = `sha512-${createHash("sha512").update(packageTarball).digest("base64")}`;
const packageCommit = "a".repeat(40);
const lockedNpm = (name: string) => ({
	source: `npm:${name}@1.0.0`,
	integrity: packageIntegrity,
});
const lockedGit = (source: string) => `${source}@${packageCommit}`;
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

const launchImage = `example.invalid/image@sha256:${"a".repeat(64)}`;
const launch: typeof productionLaunch = (options) =>
	productionLaunch({
		...options,
		fetchNpmPackage:
			options.fetchNpmPackage ??
			(async (_lock, destination) => {
				await mkdir(destination, { recursive: true, mode: 0o700 });
				const path = join(destination, "verified-package.tgz");
				await writeFile(path, packageTarball);
				return path;
			}),
		resolveImage:
			options.resolveImage ?? (async () => ({ image: launchImage })),
		certifyPlatform:
			options.certifyPlatform ??
			(async () => ({
				os: "darwin",
				arch: "arm64",
				runtimePlatform: "linux/arm64",
			})),
	});

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
	copyTo: async () => undefined,
	create: async () => undefined,
	inspect: async () => ({ image: launchImage }),
	attach: async () => 0,
} as unknown as SbxClient;

const launchConfig = {
	syncProfile: "clean" as const,
	sandbox: { keep: true },
	export: { onExit: "never" as const },
};

test("production launch resolves the published runtime before SBX preflight", async () => {
	const root = await committedRepository();
	let created = false;
	const client = {
		...launchClient,
		capabilities: async () => {
			throw new Error("capability probe reached");
		},
		create: async () => {
			created = true;
		},
	} as unknown as SbxClient;
	await assert.rejects(
		productionLaunch({ cwd: root, client, config: launchConfig }),
		(error: unknown) => {
			assert.equal(
				(error as { detail?: string }).detail,
				"capability probe reached",
			);
			return true;
		},
	);
	assert.equal(created, false);
});

test("host certification rejection precedes repository inspection", async () => {
	let inspected = false;
	await assert.rejects(
		launch({
			cwd: "/not-inspected",
			client: launchClient,
			config: launchConfig,
			certifyPlatform: async () => {
				throw new Error(
					"Ubuntu 24.04 or newer is required; detected ubuntu 22.04",
				);
			},
			inspectRepository: async (...args) => {
				inspected = true;
				return inspectRepository(...args);
			},
		}),
		(error: unknown) => {
			assert.equal(
				(error as { operation?: string }).operation,
				"certify host platform",
			);
			assert.match(
				(error as { detail?: string }).detail ?? "",
				/Ubuntu 24\.04 or newer is required/,
			);
			return true;
		},
	);
	assert.equal(inspected, false);
});

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

test("Ponytail installs before attach in snapshot order without an unsafe warning", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-ponytail-"));
	const agent = join(home, ".pi", "agent");
	const ponytail = lockedGit("git:github.com/DietrichGebert/ponytail");
	await mkdir(agent, { recursive: true });
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({ packages: [ponytail, lockedNpm("pi-subagents")] }),
	);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const events: string[] = [];
		const client = {
			...launchClient,
			create: async () => {
				events.push("create");
			},
			exec: async (_name: string, argv: string[]) => {
				if (argv[0] === "pi")
					events.push(
						argv[2]?.startsWith("/tmp/pi-dsbx-package-")
							? "install:npm-local"
							: `install:${argv[2]}`,
					);
				else if (argv[0] === "rm") events.push("cleanup:npm-local");
				return { stdout: "", stderr: "", code: 0 };
			},
			attach: async () => {
				events.push("attach");
				return 0;
			},
		} as unknown as SbxClient;
		const result = await launch({
			cwd: root,
			client,
			config: { ...launchConfig, syncProfile: "mirror" },
		});
		assert.deepEqual(events, [
			"create",
			`install:${ponytail}`,
			"install:npm-local",
			"cleanup:npm-local",
			"attach",
		]);
		assert.equal(
			result.warnings.some((warning) => /unsafe remote package/.test(warning)),
			false,
		);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("mutable package inputs fail before sandbox mutation", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-mutable-package-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "settings.json"),
		JSON.stringify({ packages: ["npm:mutable@latest"] }),
	);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	let created = 0;
	try {
		await assert.rejects(
			launch({
				cwd: root,
				client: {
					...launchClient,
					create: async () => {
						created++;
					},
				} as unknown as SbxClient,
				config: { ...launchConfig, syncProfile: "mirror" },
			}),
			/immutable package source required/,
		);
		assert.equal(created, 0);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("npm artifact verification completes before sandbox mutation", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-npm-verify-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "settings.json"),
		JSON.stringify({ packages: [lockedNpm("example")] }),
	);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	let created = 0;
	try {
		await assert.rejects(
			launch({
				cwd: root,
				client: {
					...launchClient,
					create: async () => {
						created++;
					},
				} as unknown as SbxClient,
				config: { ...launchConfig, syncProfile: "mirror" },
				fetchNpmPackage: async () => {
					throw new Error("npm registry response failed verification");
				},
			}),
			/registry response failed verification/,
		);
		assert.equal(created, 0);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
});

test("verified npm tarballs are copied, installed locally, and always cleaned", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-npm-local-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "settings.json"),
		JSON.stringify({ packages: [lockedNpm("example")] }),
	);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	try {
		for (const failure of ["none", "copy", "install", "cleanup"] as const) {
			const root = await committedRepository();
			const events: string[] = [];
			let installedArgument = "";
			const client = {
				...launchClient,
				create: async () => {
					events.push("create");
				},
				copyTo: async (_name: string, source: string, destination: string) => {
					events.push("copy");
					assert.deepEqual(await readFile(source), packageTarball);
					assert.match(destination, /^\/tmp\/pi-dsbx-package-[0-9a-f-]+\.tgz$/);
					if (failure === "copy") throw new Error("copy failed");
				},
				exec: async (_name: string, argv: string[]) => {
					if (argv[0] === "pi") {
						events.push("install");
						installedArgument = argv[2]!;
						return {
							stdout: "",
							stderr: "",
							code: failure === "install" ? 1 : 0,
						};
					}
					if (argv[0] === "rm") {
						events.push("cleanup");
						return {
							stdout: "",
							stderr: "",
							code: failure === "cleanup" ? 1 : 0,
						};
					}
					return { stdout: "", stderr: "", code: 0 };
				},
			} as unknown as SbxClient;
			const operation = launch({
				cwd: root,
				client,
				config: { ...launchConfig, syncProfile: "mirror" },
				onStatus: (status) => events.push(status),
			});
			if (failure === "copy" || failure === "cleanup")
				await assert.rejects(
					operation,
					new RegExp(`${failure} failed|staged npm package`),
				);
			else {
				const result = await operation;
				assert.equal(result.agentExitCode, 0);
				if (failure === "install")
					assert.ok(
						result.warnings.some((warning) =>
							/package was skipped/.test(warning),
						),
					);
			}
			assert.ok(events.indexOf("copy") > events.indexOf("create"));
			assert.ok(events.includes("cleanup"));
			if (failure !== "copy") {
				assert.match(installedArgument, /^\/tmp\/pi-dsbx-package-/);
				assert.notEqual(installedArgument, "npm:example@1.0.0");
			}
		}
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
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

test("explicit mirror sync does not wait for a second resource prompt", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-mirror-"));
	await mkdir(join(home, ".pi", "agent", "skills"), { recursive: true });
	await writeFile(join(home, ".pi", "agent", "skills", "SKILL.md"), "# Safe\n");
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	try {
		let confirmed = false;
		const result = await launch({
			cwd: root,
			client: launchClient,
			config: { ...launchConfig, syncProfile: "mirror" },
			confirmResourceCopy: async () => {
				confirmed = true;
				return false;
			},
		});
		assert.equal(confirmed, false);
		assert.equal(result.agentExitCode, 0);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("launch reports preflight and credential sync before profile copying", async () => {
	const root = await committedRepository();
	const statuses: string[] = [];
	let releaseCapabilities!: () => void;
	let markCapabilitiesStarted!: () => void;
	let statusAtCapabilities: string | undefined;
	const capabilitiesReady = new Promise<void>((resolve) => {
		releaseCapabilities = resolve;
	});
	const capabilitiesStarted = new Promise<void>((resolve) => {
		markCapabilitiesStarted = resolve;
	});
	const client = {
		...launchClient,
		capabilities: async () => {
			statusAtCapabilities = statuses.at(-1);
			markCapabilitiesStarted();
			await capabilitiesReady;
			return launchClient.capabilities();
		},
	} as unknown as SbxClient;
	const operation = launch({
		cwd: root,
		client,
		config: launchConfig,
		onStatus: (status) => statuses.push(status),
	});
	await capabilitiesStarted;
	assert.deepEqual(statuses, ["checking Docker Sandboxes"]);
	assert.equal(statusAtCapabilities, "checking Docker Sandboxes");
	releaseCapabilities();
	await operation;
	assert.ok(
		statuses.indexOf("syncing host credentials") <
			statuses.indexOf("copying host profile"),
	);
});

test("native packages prompt once and install a compiler only after yes", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-native-"));
	const agent = join(home, ".pi", "agent");
	await mkdir(join(agent, "npm", "node_modules", "context-mode"), {
		recursive: true,
	});
	await writeFile(
		join(agent, "npm", "node_modules", "context-mode", "package.json"),
		JSON.stringify({
			name: "context-mode",
			dependencies: { "better-sqlite3": "^12.0.0" },
		}),
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			packages: [
				lockedNpm("context-mode"),
				"NPM:pi-subagents",
				"git:example.com/owner/...git",
				"git:https://999.999/owner/repo",
				"git:github.com/owner/repo/tree/main",
				"git:git@gitlab.com:group/subgroup/repo",
				"git:example.com/owner/repo.git.git",
				"git:https://0x7f.1/owner/repo",
				"git:https://Example.com/owner/repo",
				"git:https://www.github.com/owner/repo",
				"git:example.com/owner/repo#secret-ref",
				"git:gitlab.com/owner/repo@feature/main",
				lockedNpm("pi-subagents"),
			],
		}),
	);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	try {
		for (const mode of ["yes", "no", "auto-yes"] as const) {
			const events: string[] = [];
			const execs: string[][] = [];
			const statuses: string[] = [];
			let kitAllow: string[] = [];
			const client = {
				...launchClient,
				validateKit: async (directory: string) => {
					kitAllow = JSON.parse(
						await readFile(join(directory, "spec.yaml"), "utf8"),
					).permissions.network.allow;
				},
				create: async () => {
					events.push("create");
				},
				attach: async () => {
					events.push("attach");
					return 0;
				},
				exec: async (
					_name: string,
					argv: string[],
					options?: { user?: string },
				) => {
					execs.push([options?.user ?? "", ...argv]);
					events.push("exec");
					return { stdout: "", stderr: "", code: 0 };
				},
			} as unknown as SbxClient;
			const result = await launch({
				cwd: root,
				client,
				config: { ...launchConfig, syncProfile: "mirror" },
				yes: mode === "auto-yes",
				confirmNativePackages:
					mode === "auto-yes"
						? async () => {
								events.push("prompt");
								return true;
							}
						: async (packages) => {
								events.push("prompt");
								assert.deepEqual(packages, ["npm:context-mode@1.0.0"]);
								return mode === "yes";
							},
				onStatus: (status) => statuses.push(status),
			});
			assert.equal(result.agentExitCode, 0);
			const rejected = [
				"NPM:pi-subagents",
				"git:example.com/owner/...git",
				"git:https://999.999/owner/repo",
				"git:github.com/owner/repo/tree/main",
				"git:git@gitlab.com:group/subgroup/repo",
				"git:example.com/owner/repo.git.git",
				"git:https://0x7f.1/owner/repo",
				"git:https://Example.com/owner/repo",
				"git:https://www.github.com/owner/repo",
				"git:example.com/owner/repo#secret-ref",
				"git:gitlab.com/owner/repo@feature/main",
			];
			assert.equal(
				statuses.some((status) =>
					rejected.some((source) => status.includes(source)),
				),
				false,
			);
			assert.equal(
				execs.some((argv) => rejected.some((source) => argv.includes(source))),
				false,
			);
			assert.deepEqual(statuses.slice(0, 3), [
				"checking Docker Sandboxes",
				"syncing host credentials",
				"copying host profile",
			]);
			const lastVerification = statuses.reduce(
				(last, status, index) =>
					status.startsWith("verifying npm:") ? index : last,
				-1,
			);
			assert.ok(statuses.indexOf("creating sandbox") > lastVerification);
			assert.equal(statuses.at(-1), "starting Pi");
			if (mode === "yes") {
				assert.deepEqual(events.slice(0, 2), ["prompt", "create"]);
				assert.equal(events.at(-1), "attach");
				assert.equal(execs[0]?.[0], "root");
				const compilerCommand = execs[0]?.join(" ") ?? "";
				assert.match(compilerCommand, /build-essential/);
				assert.equal(
					compilerCommand.match(
						/-o Dir::Etc::sourcelist=sources\.list\.d\/ubuntu\.sources/g,
					)?.length,
					2,
				);
				assert.equal(
					compilerCommand.match(/-o Dir::Etc::sourceparts=-/g)?.length,
					2,
				);
				const installs = execs.filter((argv) => argv[1] === "pi");
				assert.equal(installs.length, 2);
				assert.ok(
					installs.every((argv) =>
						/^\/tmp\/pi-dsbx-package-[0-9a-f-]+\.tgz$/.test(argv[3] ?? ""),
					),
				);
				assert.deepEqual(
					statuses.filter((status) => status.startsWith("installing npm:")),
					[
						"installing npm:context-mode@1.0.0",
						"installing npm:pi-subagents@1.0.0",
					],
				);
				assert.deepEqual(kitAllow, [
					"api.github.com",
					"archive.ubuntu.com",
					"codeload.github.com",
					"github.com",
					"objects.githubusercontent.com",
					"ports.ubuntu.com",
					"registry.npmjs.org",
					"security.ubuntu.com",
				]);
			} else {
				const installs = execs.filter((argv) => argv[1] === "pi");
				assert.equal(installs.length, 1);
				assert.match(installs[0]?.[3] ?? "", /^\/tmp\/pi-dsbx-package-/);
				assert.deepEqual(kitAllow, []);
				if (mode === "no") assert.ok(events.includes("prompt"));
				else assert.equal(events.includes("prompt"), false);
			}
		}
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("native consent installs only the frozen prompt set in snapshot order", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-native-frozen-"));
	const agent = join(home, ".pi", "agent");
	for (const name of ["context-mode", "pi-hermes-memory", "new-native"]) {
		await mkdir(join(agent, "npm", "node_modules", name, "skills", name), {
			recursive: true,
		});
		await writeFile(
			join(agent, "npm", "node_modules", name, "package.json"),
			JSON.stringify({
				name,
				dependencies: { "better-sqlite3": "^12.0.0" },
			}),
		);
		await writeFile(
			join(agent, "npm", "node_modules", name, "skills", name, "SKILL.md"),
			`# ${name}\n`,
		);
	}
	const settingsPath = join(agent, "settings.json");
	await writeFile(
		settingsPath,
		JSON.stringify({
			packages: [lockedNpm("context-mode"), lockedNpm("pi-hermes-memory")],
		}),
	);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	try {
		const installs: string[] = [];
		const statuses: string[] = [];
		let newNativeSkillCopied = false;
		const client = {
			...launchClient,
			validateKit: async (directory: string) => {
				newNativeSkillCopied = await exists(
					join(
						directory,
						"files",
						"home",
						".pi",
						"agent",
						"skills",
						"new-native",
						"SKILL.md",
					),
				);
			},
			exec: async (_name: string, argv: string[]) => {
				if (argv[0] === "pi" && argv[1] === "install") installs.push(argv[2]!);
				return { stdout: "", stderr: "", code: 0 };
			},
		} as unknown as SbxClient;
		await launch({
			cwd: root,
			client,
			config: { ...launchConfig, syncProfile: "mirror" },
			onStatus: (status) => statuses.push(status),
			confirmNativePackages: async (packages) => {
				assert.deepEqual(packages, [
					"npm:context-mode@1.0.0",
					"npm:pi-hermes-memory@1.0.0",
				]);
				await writeFile(
					settingsPath,
					JSON.stringify({
						packages: [
							lockedNpm("new-native"),
							lockedNpm("pi-hermes-memory"),
							lockedNpm("context-mode"),
						],
					}),
				);
				return true;
			},
		});
		assert.equal(installs.length, 2);
		assert.ok(
			installs.every((value) => value.startsWith("/tmp/pi-dsbx-package-")),
		);
		assert.deepEqual(
			statuses.filter((status) => status.startsWith("installing npm:")),
			[
				"installing npm:pi-hermes-memory@1.0.0",
				"installing npm:context-mode@1.0.0",
			],
		);
		assert.equal(newNativeSkillCopied, true);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("failed native setup drops failed specs and keeps fallback skills", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-native-fail-"));
	const agent = join(home, ".pi", "agent");
	for (const [name, skill] of [
		["context-mode", "ctx-doctor"],
		["pi-hermes-memory", "memory-doctor"],
	] as const) {
		await mkdir(join(agent, "npm", "node_modules", name, "skills", skill), {
			recursive: true,
		});
		await writeFile(
			join(agent, "npm", "node_modules", name, "package.json"),
			JSON.stringify({
				name,
				dependencies: { "better-sqlite3": "^12.0.0" },
			}),
		);
		await writeFile(
			join(agent, "npm", "node_modules", name, "skills", skill, "SKILL.md"),
			`# ${skill}\n`,
		);
	}
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			packages: [
				lockedNpm("context-mode"),
				lockedGit("git:github.com/example/failing-package"),
				lockedNpm("pi-hermes-memory"),
				lockedNpm("pi-subagents"),
			],
		}),
	);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	try {
		for (const failure of ["compiler", "package"] as const) {
			let attachedSettings: { packages?: string[] } | undefined;
			let kitSettingsPath = "";
			const sandboxSettingsPath = join(
				home,
				`sandbox-${failure}-settings.json`,
			);
			let skillsPresent = false;
			const delivered: string[] = [];
			const execs: string[][] = [];
			const statuses: string[] = [];
			const packageExecUsers: Array<string | undefined> = [];
			let npmInstallIndex = 0;
			const client = {
				...launchClient,
				validateKit: async (directory: string) => {
					kitSettingsPath = join(
						directory,
						"files",
						"home",
						".pi",
						"agent",
						"settings.json",
					);
					skillsPresent =
						(await exists(
							join(
								directory,
								"files",
								"home",
								".pi",
								"agent",
								"skills",
								"ctx-doctor",
								"SKILL.md",
							),
						)) &&
						(await exists(
							join(
								directory,
								"files",
								"home",
								".pi",
								"agent",
								"skills",
								"memory-doctor",
								"SKILL.md",
							),
						));
				},
				create: async () => {
					await writeFile(
						sandboxSettingsPath,
						await readFile(kitSettingsPath, "utf8"),
					);
				},
				attach: async () => {
					attachedSettings = JSON.parse(
						await readFile(sandboxSettingsPath, "utf8"),
					);
					return 0;
				},
				exec: async (
					_name: string,
					argv: string[],
					options?: { user?: string },
				) => {
					execs.push(argv);
					if (
						failure === "compiler" &&
						argv.some((arg) => arg.includes("build-essential"))
					)
						return { stdout: "", stderr: "apt secret-value", code: 1 };
					if (argv.includes("install")) {
						packageExecUsers.push(options?.user);
						const packageSpec = argv.at(-1)!;
						const npmTarball = packageSpec.startsWith("/tmp/pi-dsbx-package-");
						if (
							packageSpec ===
								lockedGit("git:github.com/example/failing-package") ||
							(failure === "package" && npmTarball && npmInstallIndex++ === 0)
						)
							return { stdout: "", stderr: "npm ERR secret-value", code: 1 };
						const settings = JSON.parse(
							await readFile(sandboxSettingsPath, "utf8"),
						) as { packages?: string[] };
						settings.packages = [...(settings.packages ?? []), packageSpec];
						await writeFile(sandboxSettingsPath, JSON.stringify(settings));
						assert.equal(
							JSON.parse(await readFile(kitSettingsPath, "utf8")).packages,
							undefined,
						);
					}
					return { stdout: "", stderr: "", code: 0 };
				},
			} as unknown as SbxClient;
			const result = await launch({
				cwd: root,
				client,
				config: { ...launchConfig, syncProfile: "mirror" },
				confirmNativePackages: async () => true,
				onStatus: (status) => statuses.push(status),
				onWarning: (warning) => delivered.push(warning),
			});
			assert.equal(result.agentExitCode, 0);
			assert.equal(skillsPresent, true);
			assert.equal(
				attachedSettings?.packages?.length,
				failure === "compiler" ? 1 : 2,
			);
			assert.ok(
				attachedSettings?.packages?.every((value) =>
					value.startsWith("/tmp/pi-dsbx-package-"),
				),
			);
			const packageInstalls = execs
				.filter((argv) => argv[0] === "pi" && argv[1] === "install")
				.map((argv) => argv[2]!);
			assert.equal(packageInstalls.length, failure === "compiler" ? 2 : 4);
			assert.equal(
				packageInstalls.filter((value) => value.startsWith("npm:")).length,
				0,
			);
			assert.deepEqual(
				statuses.filter(
					(status) =>
						status.startsWith("installing npm:") ||
						status.startsWith("installing git:"),
				),
				failure === "compiler"
					? [
							`installing ${lockedGit("git:github.com/example/failing-package")}`,
							"installing npm:pi-subagents@1.0.0",
						]
					: [
							"installing npm:context-mode@1.0.0",
							`installing ${lockedGit("git:github.com/example/failing-package")}`,
							"installing npm:pi-hermes-memory@1.0.0",
							"installing npm:pi-subagents@1.0.0",
						],
			);
			assert.deepEqual(
				packageExecUsers,
				new Array(failure === "compiler" ? 2 : 4).fill("agent"),
			);
			assert.deepEqual(
				delivered,
				failure === "compiler"
					? [
							"Could not install compiler; native packages were skipped",
							`Could not install ${lockedGit("git:github.com/example/failing-package")}; package was skipped`,
						]
					: [
							"Could not install npm:context-mode@1.0.0; skills were copied instead",
							`Could not install ${lockedGit("git:github.com/example/failing-package")}; package was skipped`,
						],
			);
			assert.equal(
				result.warnings.some((warning) => warning.includes("secret-value")),
				false,
			);
		}
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("native compiler and package interruption aborts before ready transition", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-native-timeout-"));
	const agent = join(home, ".pi", "agent");
	await mkdir(join(agent, "npm", "node_modules", "context-mode"), {
		recursive: true,
	});
	await writeFile(
		join(agent, "npm", "node_modules", "context-mode", "package.json"),
		JSON.stringify({
			name: "context-mode",
			dependencies: { "better-sqlite3": "^12.0.0" },
		}),
	);
	await writeFile(
		join(agent, "settings.json"),
		JSON.stringify({
			packages: [lockedNpm("context-mode"), lockedNpm("pi-subagents")],
		}),
	);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	try {
		for (const [failure, interruption] of [
			["compiler", "timeout"],
			["compiler", "cancel"],
			["package", "timeout"],
			["package", "cancel"],
		] as const) {
			const root = await committedRepository();
			let attached = false;
			let cleaned = false;
			const cause =
				interruption === "timeout"
					? new CommandTimeoutError("sbx", 100)
					: new CommandCancelledError("sbx");
			const client = {
				...launchClient,
				attach: async () => {
					attached = true;
					return 0;
				},
				exec: async (_name: string, argv: string[]) => {
					if (
						(failure === "compiler" &&
							argv.some((arg) => arg.includes("build-essential"))) ||
						(failure === "package" && argv[0] === "pi")
					)
						throw cause;
					return { stdout: "", stderr: "", code: 0 };
				},
			} as unknown as SbxClient;
			await assert.rejects(
				launch({
					cwd: root,
					client,
					config: { ...launchConfig, syncProfile: "mirror" },
					confirmNativePackages: async () => true,
					cleanup: {
						removeTemp: async (path) => {
							cleaned = true;
							await rm(path, { recursive: true, force: true });
						},
					},
				}),
				(error: unknown) =>
					error instanceof OperationError && error.cause === cause,
			);
			assert.equal(attached, false);
			assert.equal(cleaned, true);
			const state = await loadSandboxState(root, sandboxName(root));
			assert.equal(state.phase, "failed");
			assert.equal(state.lastOperationError?.category, "create");
		}
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		await rm(home, { recursive: true, force: true });
	}
});

test("reattach does not prompt for or install native packages", async () => {
	const root = await committedRepository();
	const repository = await inspectRepository(root);
	const name = sandboxName(root);
	await saveSandboxState({
		version: 1,
		name,
		hostBaseCommit: repository.head,
		hostBranch: repository.branch,
		hostRepoIdentity: repository.identity,
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: "2026-08-15T00:00:00.000Z",
	});
	let existenceChecks = 0;
	let prompts = 0;
	let installs = 0;
	const client = {
		...launchClient,
		exists: async () => existenceChecks++ === 0,
		exec: async (_name: string, argv: string[]) => {
			if (argv[0] === "pi" && argv[1] === "install") installs++;
			return { stdout: "", stderr: "", code: 0 };
		},
	} as unknown as SbxClient;
	const result = await launch({
		cwd: root,
		client,
		config: launchConfig,
		confirmNativePackages: async () => {
			prompts++;
			return true;
		},
	});
	assert.equal(result.agentExitCode, 0);
	assert.equal(prompts, 0);
	assert.equal(installs, 0);
});

test("safe default needs no resource or credential access", async () => {
	const root = await committedRepository();
	let resourceConfirmations = 0;
	let authReads = 0;
	let secretReads = 0;
	let secretWrites = 0;
	const client = {
		...launchClient,
		setSecret: async () => {
			secretWrites++;
		},
	} as unknown as SbxClient;
	await launch({
		cwd: root,
		client,
		config: launchConfig,
		confirmResourceCopy: async () => {
			resourceConfirmations++;
			return false;
		},
		listHostOAuthProviders: async () => {
			authReads++;
			return new Set(["openai-codex"]);
		},
		printApiKey: async () => {
			secretReads++;
			return "opaque-host-secret";
		},
	});
	assert.equal(resourceConfirmations, 0);
	assert.equal(authReads, 0);
	assert.equal(secretReads, 0);
	assert.equal(secretWrites, 0);
});

test("oauth-copy requires sandbox-specific consent even with --yes", async () => {
	const root = await committedRepository();
	let authReads = 0;
	let created = 0;
	const client = {
		...launchClient,
		create: async () => {
			created++;
		},
	} as unknown as SbxClient;
	await assert.rejects(
		launch({
			cwd: root,
			client,
			config: {
				...launchConfig,
				auth: { mode: "oauth-copy", providers: ["openai-codex"] },
			},
			yes: true,
			listHostOAuthProviders: async () => {
				authReads++;
				return new Set(["openai-codex"]);
			},
		}),
		/OAuth credential copy.*not approved/i,
	);
	assert.equal(authReads, 0);
	assert.equal(created, 0);
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
		config: {
			...launchConfig,
			auth: { mode: "proxy", providers: ["cursor", "openai"] },
		},
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
	assert.ok(kit.includes('"required": false'));
	assert.equal(kit.includes("API_KEY=sk-"), false);
	assert.ok(
		events.indexOf("validate") <
			events.indexOf("warning:  sbx secret set openai"),
	);
	assert.ok(
		events.indexOf("warning:  sbx secret set openai") <
			events.indexOf("create"),
	);
	assert.ok(events.indexOf("create") < events.indexOf("attach"));
	assert.equal(
		result.warnings.filter(
			(warning) =>
				warning === "Host provider cursor has no sandbox credential service",
		).length,
		1,
	);
	assert.equal(
		result.warnings.some((warning) => warning.includes("no exact sbx")),
		false,
	);
	for (const line of [
		"No proxied model credential is configured. Exit Pi, run one of:",
		"  sbx secret set openai",
		"Then relaunch: pi --docker-sandbox",
		"Sandbox-local /login is unsupported by this package.",
	])
		assert.ok(result.warnings.includes(line));
});

test("launch does not warn for copied oauth host providers", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-oauth-home-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "auth.json"),
		JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: "host-oauth-access",
				refresh: "host-oauth-refresh",
			},
		}),
	);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	let kitAuth: unknown;
	let copiedAuth: unknown;
	let copiedDestination: string | undefined;
	try {
		const client = {
			...launchClient,
			capabilities: async () => ({
				...(await launchClient.capabilities()),
				credentialServices: ["openai"],
			}),
			validateKit: async (directory: string) => {
				kitAuth = await readFile(
					join(directory, "files", "home", ".pi", "agent", "auth.json"),
					"utf8",
				)
					.then(JSON.parse)
					.catch((error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					});
			},
			copyTo: async (_name: string, source: string, destination: string) => {
				copiedAuth = JSON.parse(await readFile(source, "utf8"));
				copiedDestination = destination;
			},
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		} as unknown as SbxClient;
		const result = await launch({
			cwd: root,
			client,
			config: {
				...launchConfig,
				syncProfile: "custom",
				auth: { mode: "oauth-copy", providers: ["openai-codex"] },
				sync: { models: true },
			},
			listHostProviders: async () => ["openai-codex"],
			confirmOAuthCopy: async () => true,
			yes: true,
		});
		assert.equal(kitAuth, undefined);
		assert.deepEqual(copiedAuth, {
			"openai-codex": {
				type: "oauth",
				access: "host-oauth-access",
				refresh: "host-oauth-refresh",
			},
		});
		assert.match(
			copiedDestination ?? "",
			/^\/root\/\.pi-docker-sandboxes-auth-[0-9a-f-]+\.json$/,
		);
		assert.equal(
			result.warnings.some(
				(warning) =>
					warning ===
					"Host provider openai-codex has no sandbox credential service",
			),
			false,
		);
		assert.equal(
			result.warnings.some((warning) => warning.includes("openai-codex")),
			false,
		);
		assert.ok(
			result.warnings.some(
				(warning) =>
					warning.includes("VM-readable") && warning.includes("persist"),
			),
		);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("no-host-auth excludes OAuth credentials from generated Kit files", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-no-oauth-home-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "auth.json"),
		JSON.stringify({
			xai: {
				type: "oauth",
				access: "host-oauth-access",
				refresh: "host-oauth-refresh",
			},
		}),
	);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	let kitAuth: unknown;
	let copyCalls = 0;
	try {
		const client = {
			...launchClient,
			capabilities: async () => ({
				clone: true,
				noShareSkills: true,
				kitValidate: true,
				inspectJson: true,
				policyCheckNetwork: true,
				credentialServices: ["xai"],
			}),
			secretServices: async () => new Set(["xai"]),
			validateKit: async (directory: string) => {
				kitAuth = await readFile(
					join(directory, "files", "home", ".pi", "agent", "auth.json"),
					"utf8",
				)
					.then(JSON.parse)
					.catch((error: NodeJS.ErrnoException) => {
						if (error.code === "ENOENT") return undefined;
						throw error;
					});
			},
			copyTo: async () => {
				copyCalls++;
			},
			exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		} as unknown as SbxClient;
		await launch({
			cwd: root,
			client,
			config: {
				...launchConfig,
				syncProfile: "custom",
				auth: { mode: "oauth-copy", providers: ["xai"] },
			},
			listHostProviders: async () => ["xai"],
			noHostAuth: true,
			yes: true,
		});
		assert.equal(kitAuth, undefined);
		assert.equal(copyCalls, 0);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("OAuth staging cleanup runs after copy or install failure", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-launch-oauth-cleanup-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "auth.json"),
		JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: "host-oauth-access",
				refresh: "host-oauth-refresh",
			},
		}),
	);
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	try {
		for (const failure of ["copy", "install"] as const) {
			const root = await committedRepository();
			const commands: string[][] = [];
			const client = {
				...launchClient,
				copyTo: async () => {
					if (failure === "copy") throw new Error("copy failed");
				},
				exec: async (_name: string, args: string[]) => {
					commands.push(args);
					if (failure === "install" && args[0] === "install")
						throw new Error("install failed");
					return { stdout: "", stderr: "", code: 0 };
				},
			} as unknown as SbxClient;
			await assert.rejects(
				launch({
					cwd: root,
					client,
					config: {
						...launchConfig,
						syncProfile: "custom",
						auth: {
							mode: "oauth-copy",
							providers: ["openai-codex"],
						},
						sync: { models: true },
					},
					listHostProviders: async () => ["openai-codex"],
					confirmOAuthCopy: async () => true,
					yes: true,
				}),
				new RegExp(`${failure} failed`),
			);
			const cleanup = commands.find((args) => args[0] === "rm");
			assert.ok(cleanup, `${failure} failure must attempt OAuth cleanup`);
			assert.match(
				cleanup.at(-1) ?? "",
				/^\/root\/\.pi-docker-sandboxes-auth-/,
			);
		}
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("oauth-copy rejects explicitly requested providers without copyable tokens", async () => {
	const root = await committedRepository();
	const home = await mkdtemp(
		join(tmpdir(), "pi-dsbx-launch-oauth-ineligible-"),
	);
	const agent = join(home, ".pi", "agent");
	await mkdir(agent, { recursive: true });
	const oldHome = process.env.HOME;
	process.env.HOME = home;
	try {
		for (const scenario of ["malformed", "models-disabled"] as const) {
			await writeFile(
				join(agent, "auth.json"),
				JSON.stringify({
					"openai-codex":
						scenario === "malformed"
							? { type: "oauth", access: "host-oauth-access" }
							: {
									type: "oauth",
									access: "host-oauth-access",
									refresh: "host-oauth-refresh",
								},
				}),
			);
			let created = false;
			const operation = launch({
				cwd: root,
				client: {
					...launchClient,
					create: async () => {
						created = true;
					},
					copyTo: async () => undefined,
					exec: async () => ({ stdout: "", stderr: "", code: 0 }),
				} as unknown as SbxClient,
				config:
					scenario === "malformed"
						? {
								...launchConfig,
								syncProfile: "custom",
								auth: {
									mode: "oauth-copy",
									providers: ["openai-codex"],
								},
								sync: { models: true },
							}
						: {
								...launchConfig,
								syncProfile: "custom",
								auth: {
									mode: "oauth-copy",
									providers: ["openai-codex"],
								},
								sync: {
									settings: true,
									models: false,
									packages: false,
									skills: false,
									prompts: false,
									themes: false,
									extensions: false,
									sessions: "managed",
								},
							},
				listHostProviders: async () => ["openai-codex"],
				confirmOAuthCopy: async () => true,
				yes: true,
			});
			if (scenario === "malformed") {
				await assert.rejects(
					operation,
					/No copyable OAuth credential.*sign in on the host/i,
				);
				assert.equal(created, false);
			} else {
				const result = await operation;
				assert.equal(result.agentExitCode, 0);
			}
		}
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
	}
});

test("oauth-copy asks for consent again for every sandbox", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-oauth-repeat-home-"));
	const agent = join(home, ".pi", "agent");
	await mkdir(agent, { recursive: true });
	await writeFile(
		join(agent, "auth.json"),
		JSON.stringify({
			"openai-codex": {
				type: "oauth",
				access: "host-oauth-access",
				refresh: "host-oauth-refresh",
			},
		}),
	);
	const previousHome = process.env.HOME;
	process.env.HOME = home;
	const questions: string[] = [];
	try {
		for (let index = 0; index < 2; index++) {
			const root = await committedRepository();
			await launch({
				cwd: root,
				client: {
					...launchClient,
					copyTo: async () => undefined,
					exec: async () => ({ stdout: "", stderr: "", code: 0 }),
				} as unknown as SbxClient,
				config: {
					...launchConfig,
					auth: { mode: "oauth-copy", providers: ["openai-codex"] },
				},
				yes: true,
				confirmOAuthCopy: async (question) => {
					questions.push(question);
					return true;
				},
			});
		}
		assert.equal(questions.length, 2);
		assert.notEqual(questions[0], questions[1]);
		assert.ok(
			questions.every((question) => /VM-readable.*persist/i.test(question)),
		);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
	}
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
		config: {
			...launchConfig,
			auth: { mode: "proxy", providers: ["openai", "cursor"] },
		},
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

test("launch copies a missing host API key into sbx before guidance", async () => {
	const root = await committedRepository();
	const stored: Array<{ id: string; key: string }> = [];
	const client = {
		...launchClient,
		capabilities: async () => ({
			...(await launchClient.capabilities()),
			credentialServices: ["openai"],
		}),
		secretServices: async () => new Set<string>(),
		setSecret: async (id: string, key: string) => {
			stored.push({ id, key });
		},
	} as unknown as SbxClient;
	const result = await launch({
		cwd: root,
		client,
		config: {
			...launchConfig,
			auth: { mode: "proxy", providers: ["openai"] },
		},
		printApiKey: async () => "host-api-key-value",
	});
	assert.deepEqual(stored, [{ id: "openai", key: "host-api-key-value" }]);
	assert.equal(
		result.warnings.some((warning) =>
			warning.startsWith("No proxied model credential is configured"),
		),
		false,
	);
});

test("image preflight failure does not persist host credentials", async () => {
	const root = await committedRepository();
	let stored = false;
	const client = {
		...launchClient,
		capabilities: async () => ({
			...(await launchClient.capabilities()),
			credentialServices: ["openai"],
		}),
		secretServices: async () => new Set<string>(),
		setSecret: async () => {
			stored = true;
		},
	} as unknown as SbxClient;
	await assert.rejects(
		launch({
			cwd: root,
			client,
			config: {
				...launchConfig,
				auth: { mode: "proxy", providers: ["openai"] },
			},
			printApiKey: async () => "host-api-key-value",
			resolveImage: async () => {
				throw new Error("image unavailable");
			},
		}),
		/resolve immutable sandbox image/,
	);
	assert.equal(stored, false);
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
		config: {
			...launchConfig,
			auth: { mode: "proxy", providers: ["openai"] },
		},
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

test("concurrent unborn run cannot create an initial commit before its lease", async () => {
	const root = await unbornRepository();
	const canonical = await realpath(root);
	const held = await acquireSandboxLease(
		canonical,
		sandboxName(canonical),
		"destroy",
	);
	try {
		await assert.rejects(
			launch({
				cwd: root,
				client: launchClient,
				config: launchConfig,
				yes: true,
			}),
			/busy.*destroy/i,
		);
		await assert.rejects(() => git(root, "rev-parse", "--verify", "HEAD"));
	} finally {
		await held.release();
	}
	await launch({
		cwd: root,
		client: launchClient,
		config: launchConfig,
		yes: true,
	});
	assert.equal(await git(root, "rev-list", "--count", "HEAD"), "1");
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

test("creating intent persists before create and repository reinspection", async () => {
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
				assert.equal(await exists(path), true);
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
			inspect: async () => {
				calls.push("inspect");
				assert.equal(await exists(path), true);
				return { image: launchImage };
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
					? ["validate", "create", "inspect", "attach"]
					: ["validate", "create"],
		);
		assert.equal(await exists(path), true);
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
			inspect: async () => ({ image: launchImage }),
			attach: async (request: { env?: NodeJS.ProcessEnv }) => {
				requests.push(request);
				return 0;
			},
		} as unknown as SbxClient;
		result = await launch({
			cwd: root,
			client,
			config: launchConfig,
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

test("re-exec boolean flags accept only exact true or false values", () => {
	const flags = [
		["--docker-sandbox-fresh", "--fresh"],
		["--docker-sandbox-keep", "--keep"],
		["--docker-sandbox-discard-changes", "--discard-changes"],
		["--docker-sandbox-no-host-auth", "--no-host-auth"],
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

test("re-exec maps only the sandbox session flag to inner Pi argv", () => {
	for (const sessionFlag of [
		["--docker-sandbox-session", "session-id"],
		["--docker-sandbox-session=session-id"],
	]) {
		const parsed = buildReexecArguments([
			"--docker-sandbox",
			"--model",
			"openai/gpt",
			...sessionFlag,
			"prompt",
		]);
		assert.ok(parsed);
		assert.deepEqual(parsed.innerPiArgs, [
			"--model",
			"openai/gpt",
			"--session",
			"session-id",
			"prompt",
		]);
		assert.deepEqual(parsed.launcherArgs.slice(-6), [
			"--",
			"--model",
			"openai/gpt",
			"--session",
			"session-id",
			"prompt",
		]);
		assert.equal(
			[...parsed.innerPiArgs, ...parsed.launcherArgs].some((argument) =>
				argument.startsWith("--docker-sandbox-session"),
			),
			false,
		);
	}
});

test("re-exec session flag rejects missing option-like and duplicate values", () => {
	for (const args of [
		["--docker-sandbox", "--docker-sandbox-session"],
		["--docker-sandbox", "--docker-sandbox-session="],
		["--docker-sandbox", "--docker-sandbox-session", "--docker-sandbox-keep"],
		["--docker-sandbox", "--docker-sandbox-session", "-m"],
		["--docker-sandbox", "--docker-sandbox-session=-m"],
	])
		assert.throws(() => buildReexecArguments(args), /requires a value/i);

	for (const args of [
		[
			"--docker-sandbox",
			"--docker-sandbox-session",
			"--docker-sandbox-session=second",
		],
		[
			"--docker-sandbox",
			"--docker-sandbox-session",
			"--docker-sandbox-session",
			"second",
		],
		[
			"--docker-sandbox",
			"--docker-sandbox-session",
			"first",
			"--docker-sandbox-session",
			"second",
		],
		[
			"--docker-sandbox",
			"--docker-sandbox-session=first",
			"--docker-sandbox-session=second",
		],
	])
		assert.throws(() => buildReexecArguments(args), /may be set only once/i);
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
});

test("CLI parser requires explicit options and keeps Pi args after separator", () => {
	const parsed = parseRunArgs([
		"--profile",
		"hardened",
		"--discard-changes",
		"--no-host-auth",
		"--yes",
		"--",
		"--help",
	]);
	assert.equal(parsed.override.profile, "hardened");
	assert.equal(parsed.yes, true);
	assert.equal(parsed.discardChanges, true);
	assert.equal(parsed.noHostAuth, true);
	assert.deepEqual(parsed.piArgs, ["--help"]);
	assert.throws(() => parseRunArgs(["--direct"]), /Unknown run option/);
	assert.throws(() => parseRunArgs(["--share-skills"]), /Unknown run option/);
	assert.throws(
		() =>
			parseRunArgs(["--image", `example.invalid/pi@sha256:${"a".repeat(64)}`]),
		/Unknown run option: --image/,
	);
	assert.throws(() => parseRunArgs(["--no-sync-back"]), /Unknown run option/);
	assert.throws(() => parseRunArgs(["--wat"]), /Unknown run option/);
});
