import { access, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, type LaunchCrashPoint } from "../../src/launch.ts";
import { reconcileSandbox } from "../../src/reconcile.ts";
import type { SbxClient } from "../../src/sbx/client.ts";
import { loadSandboxState, sandboxName } from "../../src/workspace.ts";

const image = `example.invalid/runtime@sha256:${"a".repeat(64)}`;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw cause;
	}
}

async function reconcile(root: string): Promise<void> {
	const name = sandboxName(root);
	const state = await loadSandboxState(root, name);
	const present = await exists(join(root, "daemon-present"));
	const removalInvoked = await exists(join(root, "removal-invoked"));
	const decision = reconcileSandbox(state, {
		exists: present,
		...(present ? { imageMatches: state.runtimeImage === image } : {}),
	});
	const patches = await readdir(
		join(root, ".git/pi-docker-sandbox/patches"),
	).catch((cause) => {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw cause;
	});
	process.stdout.write(
		`${JSON.stringify({
			phase: state.phase,
			attestation: state.imageAttestation?.status,
			exists: present,
			removalInvoked,
			patches: patches.length,
			decision,
		})}\n`,
	);
}

async function run(root: string, crashPoint: LaunchCrashPoint): Promise<void> {
	const daemon = join(root, "daemon-present");
	const removalInvocation = join(root, "removal-invoked");
	const scenario = crashPoint.includes("export")
		? "export"
		: crashPoint.includes("remov")
			? "remove"
			: "create";
	const client = {
		capabilities: async () => ({
			clone: true,
			noShareSkills: true,
			kitValidate: true,
			inspectJson: true,
			policyCheckNetwork: true,
			credentialServices: [],
		}),
		exists: async () => exists(daemon),
		validateKit: async () => {},
		create: async () => writeFile(daemon, "present\n"),
		inspect: async () => ({ image }),
		attach: async () => 0,
		exec: async (_name: string, argv: readonly string[]) => {
			if (argv[0] === "git" && argv[1] === "status")
				return {
					stdout: scenario === "export" ? " M file.txt\n" : "",
					stderr: "",
					code: 0,
				};
			if (argv[0] === "git" && argv[1] === "diff" && argv.includes("--binary"))
				return {
					stdout: "diff --git a/file.txt b/file.txt\n",
					stderr: "",
					code: 0,
				};
			if (argv[0] === "git" && argv[1] === "diff")
				return { stdout: "1\t0\tfile.txt\n", stderr: "", code: 0 };
			return { stdout: "", stderr: "", code: 0 };
		},
		remove: async () => {
			await writeFile(removalInvocation, "invoked\n");
			await rm(daemon, { force: true });
		},
	} as unknown as SbxClient;
	await launch({
		cwd: root,
		client,
		config: {
			syncProfile: "clean",
			sandbox: { keep: scenario === "create" },
			export: {
				onExit: scenario === "export" ? "always" : "never",
				directory: ".git/pi-docker-sandbox/patches",
			},
		},
		noHostAuth: true,
		resolveImage: async () => ({ image }),
		certifyPlatform: async () => ({
			os: "darwin",
			arch: "arm64",
			runtimePlatform: "linux/arm64",
		}),
		onCrashPoint: async (point) => {
			if (point !== crashPoint) return;
			process.stdout.write(`CRASH:${point}\n`);
			await new Promise(() => {});
		},
	});
}

const [mode, root, point] = process.argv.slice(2);
if (!root) throw new Error("fixture root is required");
if (mode === "reconcile") await reconcile(root);
else if (mode === "launch" && point) await run(root, point as LaunchCrashPoint);
else throw new Error("fixture mode and crash point are required");
