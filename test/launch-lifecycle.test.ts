import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	access,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { OperationError } from "../src/errors.ts";
import { launch, type LaunchResult } from "../src/launch.ts";
import type { SbxClient } from "../src/sbx/client.ts";
import {
	inspectRepository,
	loadSandboxState,
	sandboxName,
	saveSandboxState,
	statePath,
	type SandboxState,
} from "../src/workspace.ts";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
	await exec("git", args, { cwd });
}

async function repository(): Promise<{
	root: string;
	name: string;
	state: SandboxState;
}> {
	const created = await mkdtemp(join(tmpdir(), "pi-dsbx-lifecycle-"));
	await git(created, "init", "-b", "main");
	await git(created, "config", "user.email", "test@example.com");
	await git(created, "config", "user.name", "Test");
	await writeFile(join(created, "file.txt"), "initial\n");
	await git(created, "add", "file.txt");
	await git(created, "commit", "-m", "initial");
	const root = await realpath(created);
	const inspected = await inspectRepository(root);
	const name = sandboxName(root);
	return {
		root,
		name,
		state: {
			version: 1,
			name,
			hostBaseCommit: inspected.head,
			hostBranch: inspected.branch,
			hostRepoIdentity: inspected.identity,
			hostRoot: root,
			workspaceMode: "clone",
			createdAt: "2026-08-12T00:00:00.000Z",
		},
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

interface FakeOptions {
	existed?: boolean;
	inspection?: Record<string, unknown>;
	status?: string;
	statusError?: Error;
	launchError?: Error;
	exportError?: Error;
	finalExistsError?: Error;
	removeError?: Error;
	backupError?: Error;
	exitCode?: number;
}

function fakeClient(log: string[], options: FakeOptions = {}) {
	let present = options.existed ?? false;
	let existsCalls = 0;
	const client = {
		capabilities: async () => {
			log.push("capabilities");
			return {
				clone: true,
				noShareSkills: true,
				kitValidate: true,
				inspectJson: true,
				policyCheckNetwork: true,
				credentialServices: [],
			};
		},
		exists: async () => {
			log.push("exists");
			existsCalls++;
			if (existsCalls > 1 && options.finalExistsError)
				throw options.finalExistsError;
			return present;
		},
		validateKit: async () => {
			log.push("validate");
		},
		create: async () => {
			log.push("create");
			if (options.launchError) throw options.launchError;
			present = true;
		},
		inspect: async () => {
			log.push("inspect");
			return options.inspection ?? {};
		},
		attach: async () => {
			log.push("attach");
			return options.exitCode ?? 0;
		},
		exec: async (_name: string, argv: readonly string[]) => {
			const operation = argv.join(" ");
			log.push(`exec:${operation}`);
			if (argv[0] === "git" && argv[1] === "status") {
				if (options.statusError) throw options.statusError;
				return { stdout: options.status ?? "", stderr: "", code: 0 };
			}
			if (
				argv[0] === "git" &&
				argv[1] === "diff" &&
				argv.includes("--binary")
			) {
				if (options.exportError) throw options.exportError;
				return {
					stdout: "diff --git a/file.txt b/file.txt\n",
					stderr: "",
					code: 0,
				};
			}
			if (argv[0] === "git" && argv[1] === "diff" && argv.includes("--numstat"))
				return { stdout: "1\t0\tfile.txt\n", stderr: "", code: 0 };
			return { stdout: "", stderr: "", code: 0 };
		},
		copyFrom: async () => {
			log.push("backup-sessions");
			if (options.backupError) throw options.backupError;
		},
		remove: async () => {
			log.push("remove");
			if (options.removeError) throw options.removeError;
			present = false;
		},
	} as unknown as SbxClient;
	return { client, present: () => present };
}

const baseConfig = {
	syncProfile: "clean" as const,
	sandbox: {
		image: `example.invalid/image@sha256:${"a".repeat(64)}`,
		keep: false,
	},
	export: { onExit: "never" as const },
};

async function runCase(
	options: FakeOptions & {
		keep?: boolean;
		onExit?: "never" | "always" | "prompt";
		confirm?: boolean;
		cleanupError?: unknown;
		stateCleanupError?: Error;
		noSyncBack?: boolean;
		workspaceMode?: "clone" | "direct";
		managedSessions?: boolean;
		discardChanges?: boolean;
		yes?: boolean;
		resolvedImage?: { image: string; templateStoreId?: string };
		imageAttestation?: SandboxState["imageAttestation"];
		saveStateErrorAfter?: number;
		repositoryInspectionErrorAfter?: number;
	},
) {
	const fixture = await repository();
	if (options.imageAttestation)
		fixture.state.imageAttestation = options.imageAttestation;
	if (options.existed) await saveSandboxState(fixture.state);
	const log: string[] = [];
	const fake = fakeClient(log, options);
	const cleanup = {
		removeTemp: async (path: string) => {
			log.push("cleanup");
			assert.match(path, /pi-docker-sandboxes-/);
			if ("cleanupError" in options) throw options.cleanupError;
			await rm(path, { recursive: true, force: true });
		},
	};
	const stateCleanup = {
		removeState: async (path: string) => {
			log.push("unlink-state");
			if (options.stateCleanupError) throw options.stateCleanupError;
			await rm(path, { force: true });
		},
	};
	let saveStateCalls = 0;
	let repositoryInspectionCalls = 0;
	const operation = launch({
		cwd: fixture.root,
		client: fake.client,
		config: {
			...baseConfig,
			syncProfile: options.managedSessions ? "balanced" : "clean",
			workspaceMode: options.workspaceMode ?? "clone",
			sandbox: { ...baseConfig.sandbox, keep: options.keep ?? false },
			export: {
				onExit: options.onExit ?? "never",
				directory: ".git/pi-docker-sandbox/patches",
			},
		},
		cleanup,
		stateCleanup,
		noSyncBack: options.noSyncBack,
		discardChanges: options.discardChanges,
		yes: options.yes ?? options.workspaceMode === "direct",
		confirm: async () => {
			log.push("confirm");
			return options.confirm ?? false;
		},
		...(options.resolvedImage
			? { resolveImage: async () => options.resolvedImage! }
			: {}),
		...(options.saveStateErrorAfter
			? {
					saveState: async (state: SandboxState) => {
						saveStateCalls++;
						if (saveStateCalls >= options.saveStateErrorAfter!)
							throw new Error("injected attestation state save failure");
						await saveSandboxState(state);
					},
				}
			: {}),
		...(options.repositoryInspectionErrorAfter
			? {
					inspectRepository: async (cwd: string) => {
						repositoryInspectionCalls++;
						if (
							repositoryInspectionCalls >=
							options.repositoryInspectionErrorAfter!
						)
							throw new Error("injected repository reinspection failure");
						return inspectRepository(cwd);
					},
				}
			: {}),
	});
	return { fixture, log, fake, operation };
}

test("new local template is inspected before attach and mismatch preserves it", async () => {
	const hex = "a".repeat(64);
	const image = `docker.io/pi-docker-sandboxes/pi:local-${hex}`;
	const storeId = "abc123def456";
	const matching = await runCase({
		keep: true,
		resolvedImage: { image, templateStoreId: storeId },
		inspection: { image, image_digest: `sha256:${storeId}7890` },
	});
	const result = await matching.operation;
	assert.equal(result.exitCode, 0);
	assert.ok(matching.log.indexOf("inspect") > matching.log.indexOf("create"));
	assert.ok(matching.log.indexOf("inspect") < matching.log.indexOf("attach"));
	assert.equal(result.state?.imageAttestation?.status, "verified");

	const mismatched = await runCase({
		keep: true,
		resolvedImage: { image, templateStoreId: storeId },
		inspection: {
			image: `${image}-wrong`,
			image_digest: `sha256:${storeId}7890`,
		},
	});
	await assert.rejects(mismatched.operation, (error: unknown) => {
		assert.match(String(error), /created sandbox image/i);
		assert.deepEqual((error as { recovery?: string[] }).recovery, [
			`pi-dsbx export --name '${mismatched.fixture.name}'`,
			`pi-dsbx destroy --name '${mismatched.fixture.name}' --discard-changes`,
			`pi-dsbx run --name '${mismatched.fixture.name}'`,
		]);
		return true;
	});
	assert.equal(mismatched.log.includes("attach"), false);
	assert.equal(mismatched.log.includes("remove"), false);
	assert.equal(
		await pathExists(
			statePath(mismatched.fixture.root, mismatched.fixture.name),
		),
		true,
	);
	assert.equal(
		(await loadSandboxState(mismatched.fixture.root, mismatched.fixture.name))
			.imageAttestation?.status,
		"pending",
	);
});

test("direct sandboxes attest the current resolved image before every attach", async () => {
	const localImage = `docker.io/pi-docker-sandboxes/pi:local-${"a".repeat(64)}`;
	const storeId = "abc123def456";
	for (const existed of [false, true]) {
		const matching = await runCase({
			existed,
			workspaceMode: "direct",
			keep: true,
			yes: true,
			resolvedImage: { image: localImage, templateStoreId: storeId },
			inspection: {
				image: localImage,
				image_digest: `sha256:${storeId}7890`,
			},
		});
		await matching.operation;
		assert.ok(matching.log.indexOf("inspect") < matching.log.indexOf("attach"));
		assert.equal(matching.log.filter((entry) => entry === "inspect").length, 1);

		const mismatch = await runCase({
			existed,
			workspaceMode: "direct",
			keep: true,
			yes: true,
			resolvedImage: { image: localImage, templateStoreId: storeId },
			inspection: {
				image: `${localImage}-wrong`,
				image_digest: `sha256:${storeId}7890`,
			},
		});
		await assert.rejects(mismatch.operation, (error: unknown) => {
			assert.equal(
				(error as { phase?: string }).phase,
				existed ? "prepare" : "create",
			);
			assert.deepEqual((error as { recovery?: string[] }).recovery, [
				`pi-dsbx destroy --name '${mismatch.fixture.name}' --direct --discard-changes`,
				`pi-dsbx run --name '${mismatch.fixture.name}' --direct`,
			]);
			return true;
		});
		assert.equal(mismatch.log.includes("attach"), false);
		assert.equal(mismatch.log.includes("remove"), false);
		assert.equal(mismatch.fake.present(), true);
	}
});

test("direct preservation warnings omit clone-only export recovery", async () => {
	for (const options of [
		{ keep: true },
		{ statusError: new Error("injected direct inspection failure") },
	]) {
		const subject = await runCase({
			existed: true,
			workspaceMode: "direct",
			yes: true,
			resolvedImage: { image: baseConfig.sandbox.image },
			inspection: { image: baseConfig.sandbox.image },
			...options,
		});
		const result = await subject.operation;
		const warnings = result.warnings.join("\n");
		assert.doesNotMatch(warnings, /pi-dsbx export/);
		assert.match(
			warnings,
			new RegExp(
				`pi-dsbx destroy --name '${subject.fixture.name}' --direct --discard-changes`,
			),
		);
		assert.match(
			warnings,
			new RegExp(`pi-dsbx run --name '${subject.fixture.name}' --direct`),
		);
	}
});

test("clone create state failures retain executable custody", async () => {
	const failedSave = await runCase({ keep: true, saveStateErrorAfter: 1 });
	await assert.rejects(failedSave.operation, (error: unknown) => {
		assert.equal((error as { phase?: string }).phase, "create");
		assert.deepEqual((error as { recovery?: string[] }).recovery, [
			`sbx inspect '${failedSave.fixture.name}'`,
			`sbx exec '${failedSave.fixture.name}' git status --porcelain=v1`,
			`sbx exec '${failedSave.fixture.name}' git diff --binary`,
			`sbx rm --force '${failedSave.fixture.name}'`,
		]);
		assert.match(
			(error as { detail?: string }).detail ?? "",
			/data-loss warning: removing .* loses any sandbox-only changes/,
		);
		return true;
	});
	assert.equal(failedSave.log.includes("attach"), false);
	assert.equal(
		await pathExists(
			statePath(failedSave.fixture.root, failedSave.fixture.name),
		),
		false,
	);

	const failedReinspection = await runCase({
		keep: true,
		repositoryInspectionErrorAfter: 2,
	});
	await assert.rejects(failedReinspection.operation, (error: unknown) => {
		assert.equal((error as { phase?: string }).phase, "create");
		assert.deepEqual((error as { recovery?: string[] }).recovery, [
			`pi-dsbx export --name '${failedReinspection.fixture.name}'`,
			`pi-dsbx destroy --name '${failedReinspection.fixture.name}' --discard-changes`,
			`pi-dsbx run --name '${failedReinspection.fixture.name}'`,
		]);
		return true;
	});
	assert.equal(failedReinspection.log.includes("attach"), false);
	assert.equal(
		await pathExists(
			statePath(
				failedReinspection.fixture.root,
				failedReinspection.fixture.name,
			),
		),
		true,
	);
});

test("direct image attestation checks local digest and explicit image equality", async () => {
	const localImage = `docker.io/pi-docker-sandboxes/pi:local-${"a".repeat(64)}`;
	const local = await runCase({
		workspaceMode: "direct",
		keep: true,
		yes: true,
		resolvedImage: { image: localImage, templateStoreId: "abc123def456" },
		inspection: { image: localImage, image_digest: "sha256:def456abc123" },
	});
	await assert.rejects(local.operation, /digest/i);
	assert.equal(local.log.includes("attach"), false);

	const explicit = `example.invalid/image@sha256:${"b".repeat(64)}`;
	const explicitMismatch = await runCase({
		workspaceMode: "direct",
		keep: true,
		yes: true,
		resolvedImage: { image: explicit },
		inspection: { image: `${explicit}-wrong` },
	});
	await assert.rejects(explicitMismatch.operation, /selected image/i);
	assert.equal(explicitMismatch.log.includes("attach"), false);
});

test("verified attestation state save failure preserves without attach", async () => {
	const image = `docker.io/pi-docker-sandboxes/pi:local-${"a".repeat(64)}`;
	const templateStoreId = "abc123def456";
	const subject = await runCase({
		keep: true,
		resolvedImage: { image, templateStoreId },
		inspection: { image, image_digest: `sha256:${templateStoreId}7890` },
		saveStateErrorAfter: 2,
	});
	await assert.rejects(subject.operation, /attestation state save failure/);
	assert.equal(subject.log.includes("attach"), false);
	assert.equal(subject.fake.present(), true);
	assert.equal(
		(await loadSandboxState(subject.fixture.root, subject.fixture.name))
			.imageAttestation?.status,
		"pending",
	);
});

test("recorded local image attestation is enforced on every resume", async () => {
	const image = `docker.io/pi-docker-sandboxes/pi:local-${"a".repeat(64)}`;
	const templateStoreId = "abc123def456";
	for (const status of ["pending", "verified"] as const) {
		const matching = await runCase({
			existed: true,
			keep: true,
			imageAttestation: { status, image, templateStoreId },
			resolvedImage: {
				image: `docker.io/pi-docker-sandboxes/pi:local-${"b".repeat(64)}`,
				templateStoreId: "def456abc123",
			},
			inspection: { image, image_digest: `sha256:${templateStoreId}7890` },
		});
		const result = await matching.operation;
		assert.equal(result.state?.imageAttestation?.status, "verified");
		assert.ok(matching.log.indexOf("inspect") < matching.log.indexOf("attach"));

		const mismatch = await runCase({
			existed: true,
			keep: true,
			imageAttestation: { status, image, templateStoreId },
			resolvedImage: {
				image: `docker.io/pi-docker-sandboxes/pi:local-${"b".repeat(64)}`,
				templateStoreId: "def456abc123",
			},
			inspection: {
				image: `${image}-wrong`,
				image_digest: `sha256:${templateStoreId}`,
			},
		});
		await assert.rejects(mismatch.operation, /resumed sandbox image/i);
		assert.equal(mismatch.log.includes("attach"), false);
	}
});

function assertLifecycle(
	result: LaunchResult,
	expected: Partial<LaunchResult["lifecycle"]>,
): void {
	assert.equal(result.lifecycle.name, result.name);
	for (const [key, value] of Object.entries(expected))
		assert.deepEqual(
			result.lifecycle[key as keyof LaunchResult["lifecycle"]],
			value,
		);
}

test("newly created clean sandbox is removed with its state", async () => {
	const subject = await runCase({ status: "" });
	const result = await subject.operation;
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"create",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"cleanup",
		"remove",
		"unlink-state",
	]);
	assertLifecycle(result, {
		existedBefore: false,
		created: true,
		changed: false,
		exported: false,
		preserved: false,
		cleanupWarnings: [],
	});
	assert.equal(subject.fake.present(), false);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		false,
	);
});

test("existing sandbox with keep is preserved", async () => {
	const subject = await runCase({ existed: true, keep: true });
	const result = await subject.operation;
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"cleanup",
	]);
	assertLifecycle(result, {
		existedBefore: true,
		created: false,
		changed: false,
		exported: false,
		preserved: true,
		cleanupWarnings: [],
	});
	assert.equal(subject.fake.present(), true);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});

test("new sandbox with keep remains classified as newly created", async () => {
	const subject = await runCase({ keep: true });
	const result = await subject.operation;
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"create",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"cleanup",
	]);
	assertLifecycle(result, {
		existedBefore: false,
		created: true,
		changed: false,
		exported: false,
		preserved: true,
	});
	assert.equal(subject.fake.present(), true);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});

test("changed sandbox is removed only after successful export", async () => {
	const subject = await runCase({ status: " M file.txt\n", onExit: "always" });
	const result = await subject.operation;
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"create",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"exec:git add -A",
		`exec:git diff --cached --binary --full-index ${subject.fixture.state.hostBaseCommit}`,
		`exec:git diff --cached --numstat ${subject.fixture.state.hostBaseCommit}`,
		"cleanup",
		"remove",
		"unlink-state",
	]);
	assertLifecycle(result, { changed: true, exported: true, preserved: false });
	assert.equal(subject.fake.present(), false);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		false,
	);
	const patchDirectory = join(
		subject.fixture.root,
		".git/pi-docker-sandbox/patches",
	);
	const patches = await readdir(patchDirectory);
	assert.equal(patches.length, 1);
	assert.match(
		await readFile(join(patchDirectory, patches[0]!), "utf8"),
		/diff --git/,
	);
});

test("changed sandbox with rejected export is preserved", async () => {
	const subject = await runCase({
		existed: true,
		status: " M file.txt\n",
		onExit: "prompt",
		confirm: false,
	});
	const result = await subject.operation;
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"confirm",
		"cleanup",
	]);
	assertLifecycle(result, {
		existedBefore: true,
		created: false,
		changed: true,
		exported: false,
		preserved: true,
	});
	assert.equal(subject.fake.present(), true);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});

test("discard authority removes changed sandbox without export", async () => {
	const subject = await runCase({
		existed: true,
		status: " M file.txt\n",
		onExit: "never",
		discardChanges: true,
	});
	const result = await subject.operation;
	assertLifecycle(result, { changed: true, exported: false, preserved: false });
	assert.equal(subject.log.filter((entry) => entry === "remove").length, 1);
	assert.equal(
		subject.log.filter((entry) => entry.startsWith("exec:git add")).length,
		0,
	);
	assert.equal(subject.fake.present(), false);
});

test("generic yes never grants discard authority", async () => {
	const subject = await runCase({
		existed: true,
		status: " M file.txt\n",
		onExit: "never",
		yes: true,
	});
	const result = await subject.operation;
	assertLifecycle(result, { changed: true, exported: false, preserved: true });
	assert.equal(subject.log.includes("remove"), false);
});

test("changed sandbox with export disabled is preserved", async () => {
	const subject = await runCase({
		existed: true,
		status: " M file.txt\n",
		onExit: "never",
	});
	const result = await subject.operation;
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"cleanup",
	]);
	assertLifecycle(result, {
		existedBefore: true,
		created: false,
		changed: true,
		exported: false,
		preserved: true,
	});
	const quoted = `'${subject.fixture.name}'`;
	assert.match(
		result.warnings.join("\n"),
		new RegExp(`pi-dsbx export --name ${quoted}`),
	);
	assert.match(
		result.warnings.join("\n"),
		new RegExp(`pi-dsbx destroy --name ${quoted} --discard-changes`),
	);
	assert.match(
		result.warnings.join("\n"),
		new RegExp(`pi-dsbx run --name ${quoted}`),
	);
	assert.equal(subject.fake.present(), true);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});

test("export failure preserves sandbox and remains the primary error", async () => {
	const primary = new Error("injected export failure");
	const subject = await runCase({
		existed: true,
		status: " M file.txt\n",
		onExit: "always",
		exportError: primary,
		cleanupError: new Error("injected cleanup failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 0);
	assertLifecycle(result, { exported: false, preserved: true });
	assert.match(result.warnings.join("\n"), /injected export failure/);
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"exec:git add -A",
		`exec:git diff --cached --binary --full-index ${subject.fixture.state.hostBaseCommit}`,
		"cleanup",
	]);
	assert.equal(subject.fake.present(), true);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});

test("host cleanup failure retains Pi exit code and reports warning", async () => {
	const subject = await runCase({
		status: "",
		exitCode: 17,
		cleanupError: new Error("injected cleanup failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 17);
	assertLifecycle(result, {
		changed: false,
		preserved: true,
		cleanupWarnings: ["injected cleanup failure"],
	});
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"create",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"cleanup",
	]);
	assert.equal(subject.fake.present(), true);
});

test("failed cleanup never triggers sandbox removal", async () => {
	const subject = await runCase({
		existed: true,
		exitCode: 31,
		status: "",
		cleanupError: new Error("injected pre-remove cleanup failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 31);
	assertLifecycle(result, { changed: false, preserved: true });
	assert.equal(subject.log.includes("remove"), false);
	assert.equal(subject.fake.present(), true);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});

test("create failure never removes a sandbox or writes state", async () => {
	const primary = new Error("injected create failure");
	const subject = await runCase({ launchError: primary });
	await assert.rejects(subject.operation, (error) => {
		assert.ok(error instanceof OperationError);
		assert.equal(error.phase, "create");
		assert.equal(error.cause, primary);
		return true;
	});
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"create",
		"cleanup",
	]);
	assert.equal(subject.fake.present(), false);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		false,
	);
});

test("nonzero Pi exit survives final existence failure", async () => {
	const subject = await runCase({
		exitCode: 19,
		finalExistsError: new Error("injected final exists failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 19);
	assertLifecycle(result, { changed: "unknown", preserved: true });
	assert.match(
		result.warnings.join("\n"),
		/inspect[\s\S]*injected final exists failure/i,
	);
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"create",
		"attach",
		"exists",
		"cleanup",
	]);
	assert.equal(subject.fake.present(), true);
});

test("zero Pi exit turns final existence failure into phased error", async () => {
	const subject = await runCase({
		finalExistsError: new Error("injected final exists failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 0);
	assertLifecycle(result, { changed: "unknown", preserved: true });
	assert.match(result.warnings.join("\n"), /injected final exists failure/);
	assert.equal(subject.fake.present(), true);
});

test("remove failure preserves sandbox and state after nonzero Pi exit", async () => {
	const subject = await runCase({
		existed: true,
		exitCode: 23,
		status: "",
		removeError: new Error("injected remove failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 23);
	assertLifecycle(result, { changed: false, preserved: true });
	assert.match(
		result.warnings.join("\n"),
		/remove[\s\S]*injected remove failure/i,
	);
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"cleanup",
		"remove",
	]);
	assert.equal(subject.fake.present(), true);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});

test("state unlink failure reports stale state after successful remove", async () => {
	const subject = await runCase({
		existed: true,
		exitCode: 29,
		status: "",
		stateCleanupError: new Error("injected state unlink failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 29);
	assertLifecycle(result, { changed: false, preserved: false });
	assert.match(
		result.warnings.join("\n"),
		/stale[\s\S]*injected state unlink failure/i,
	);
	assert.deepEqual(subject.log.slice(-3), [
		"cleanup",
		"remove",
		"unlink-state",
	]);
	assert.equal(subject.fake.present(), false);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});

test("cleanup warnings and errors redact secret-shaped detail", async () => {
	const secret = "sk-cleanup-1234567890abcdef";
	const nonzero = await runCase({
		keep: true,
		exitCode: 41,
		cleanupError: new Error(`token=${secret}`),
	});
	const result = await nonzero.operation;
	assert.equal(
		result.lifecycle.cleanupWarnings.some((warning) =>
			warning.includes(secret),
		),
		false,
	);
	assert.equal(
		result.warnings.some((warning) => warning.includes(secret)),
		false,
	);

	const zero = await runCase({
		keep: true,
		cleanupError: new Error(`token=${secret}`),
	});
	const zeroResult = await zero.operation;
	assert.equal(zeroResult.exitCode, 0);
	assert.equal(zeroResult.warnings.join("\n").includes(secret), false);
});

test("undefined and null cleanup throws are failures on zero and nonzero exits", async () => {
	for (const cause of [undefined, null]) {
		const nonzero = await runCase({
			existed: true,
			exitCode: 47,
			status: "",
			cleanupError: cause,
		});
		const result = await nonzero.operation;
		assert.equal(result.exitCode, 47);
		assertLifecycle(result, {
			preserved: true,
			cleanupWarnings: ["Unknown cleanup failure"],
		});
		assert.equal(
			result.warnings.filter((warning) => /cleanup/i.test(warning)).length,
			1,
		);
		assert.equal(nonzero.log.includes("remove"), false);
		assert.equal(nonzero.fake.present(), true);

		const zero = await runCase({ keep: true, cleanupError: cause });
		const zeroResult = await zero.operation;
		assert.equal(zeroResult.exitCode, 0);
		assert.deepEqual(zeroResult.lifecycle.cleanupWarnings, [
			"Unknown cleanup failure",
		]);
		assert.equal(zero.fake.present(), true);
	}
});

test("zero-exit host cleanup failure preserves exit code and custody", async () => {
	const subject = await runCase({
		keep: true,
		cleanupError: new Error("injected cleanup-only failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 0);
	assert.match(result.warnings.join("\n"), /injected cleanup-only failure/);
	assert.equal(subject.fake.present(), true);
});

test("zero-exit state unlink failure reports warning without masking exit", async () => {
	const subject = await runCase({
		existed: true,
		status: "",
		stateCleanupError: new Error("injected zero-exit state unlink failure"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 0);
	assertLifecycle(result, { preserved: false });
	assert.match(
		result.warnings.join("\n"),
		/injected zero-exit state unlink failure/,
	);
	assert.equal(subject.fake.present(), false);
});

test("cleanup warning is rendered without losing primary export cause", async () => {
	const primary = new Error("injected export primary");
	const subject = await runCase({
		existed: true,
		status: " M file.txt\n",
		onExit: "always",
		exportError: primary,
		cleanupError: new Error("injected cleanup companion"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 0);
	assert.match(result.warnings.join("\n"), /injected export primary/);
	assert.match(result.warnings.join("\n"), /injected cleanup companion/);
	assert.equal(subject.fake.present(), true);
});

test("managed session backup failure preserves sandbox and state", async () => {
	for (const exitCode of [0, 43]) {
		const cause = new Error("injected managed backup failure");
		const subject = await runCase({
			existed: true,
			status: "",
			exitCode,
			managedSessions: true,
			backupError: cause,
		});
		const result = await subject.operation;
		assert.equal(result.exitCode, exitCode);
		assertLifecycle(result, { preserved: true });
		const backupWarnings = result.warnings.filter((warning) =>
			/managed session backup/i.test(warning),
		);
		assert.equal(backupWarnings.length, 1);
		const formatted = backupWarnings[0]!;
		assert.equal(
			formatted.match(/injected managed backup failure/g)?.length,
			1,
		);
		assert.equal(
			formatted.match(/relaunch to retry managed backup/gi)?.length,
			1,
		);
		assert.match(formatted, /managed session backup guidance:/i);
		assert.equal(subject.log.includes("remove"), false);
		assert.equal(subject.fake.present(), true);
		assert.equal(
			await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
			true,
		);
	}
});

test("combined cleanup detail is sanitized while retaining primary cause", async () => {
	const primary = new Error("injected export primary");
	const secret = "sk-companion-1234567890abcdef";
	const subject = await runCase({
		existed: true,
		status: " M file.txt\n",
		onExit: "always",
		exportError: primary,
		cleanupError: new Error(`token=${secret}`),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 0);
	assert.equal(result.warnings.join("\n").includes(secret), false);
	assert.match(result.warnings.join("\n"), /injected export primary/);
});

test("noSyncBack and direct mode preserve changed work without export", async () => {
	for (const options of [
		{
			existed: true,
			status: " M file.txt\n",
			onExit: "always" as const,
			noSyncBack: true,
		},
		{
			workspaceMode: "direct" as const,
			status: " M file.txt\n",
			onExit: "always" as const,
			inspection: { image: baseConfig.sandbox.image },
		},
	]) {
		const subject = await runCase(options);
		const result = await subject.operation;
		assertLifecycle(result, {
			changed: true,
			exported: false,
			preserved: true,
		});
		assert.equal(
			subject.log.some((entry) => entry.startsWith("exec:git add")),
			false,
		);
		assert.equal(subject.fake.present(), true);
	}
});

test("interrupted run with unknown dirty state is preserved", async () => {
	const subject = await runCase({
		exitCode: 130,
		statusError: new Error("sandbox unavailable"),
	});
	const result = await subject.operation;
	assert.equal(result.exitCode, 130);
	assert.deepEqual(subject.log, [
		"capabilities",
		"exists",
		"validate",
		"create",
		"attach",
		"exists",
		"exec:git status --porcelain=v1",
		"cleanup",
	]);
	assertLifecycle(result, {
		created: true,
		changed: "unknown",
		exported: false,
		preserved: true,
	});
	assert.equal(subject.fake.present(), true);
	assert.equal(
		await pathExists(statePath(subject.fixture.root, subject.fixture.name)),
		true,
	);
});
