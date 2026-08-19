import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { reconcileSandbox } from "../src/reconcile.ts";
import type { LaunchCrashPoint } from "../src/launch.ts";
import type { SandboxPhase, SandboxStateV2 } from "../src/state-schema.ts";

const exec = promisify(execFile);
const image = `example.invalid/runtime@sha256:${"a".repeat(64)}`;
const crashFixture = new URL(
	"./fixtures/lifecycle-crash-launcher.ts",
	import.meta.url,
).pathname;

function state(phase: SandboxPhase): SandboxStateV2 {
	return {
		version: 2,
		phase,
		name: "pi-reconcile",
		hostBaseCommit: "base",
		hostBranch: "main",
		hostRepoIdentity: "repository",
		hostWorktreeIdentity: "/repo",
		hostRoot: "/repo",
		workspaceMode: "clone",
		createdAt: "2026-08-18T00:00:00.000Z",
		updatedAt: "2026-08-18T00:00:00.000Z",
		runtimeImage: image,
		runtimeSchema: 1,
		packageVersion: "1.0.0",
	};
}

test("reconciliation transition table preserves ambiguous custody", () => {
	assert.deepEqual(
		reconcileSandbox(state("creating"), {
			exists: true,
			imageMatches: true,
		}),
		{
			action: "preserve",
			reason: "interrupted creation requires explicit recovery",
		},
	);
	assert.deepEqual(reconcileSandbox(state("creating"), { exists: false }), {
		action: "preserve",
		reason: "interrupted creation requires explicit recovery",
	});
	assert.deepEqual(reconcileSandbox(state("removing"), { exists: false }), {
		action: "remove-state",
	});
	assert.deepEqual(
		reconcileSandbox(state("exporting"), {
			exists: true,
			imageMatches: true,
		}),
		{ action: "preserve", reason: "interrupted export" },
	);
	for (const phase of [
		"creating",
		"ready",
		"exporting",
		"removing",
		"failed",
	] as const)
		assert.notEqual(
			reconcileSandbox(state(phase), { exists: "unknown" }).action,
			"remove-state",
		);
});

test("known image mismatch never resumes or removes a sandbox", () => {
	for (const phase of ["creating", "ready"] as const)
		assert.deepEqual(
			reconcileSandbox(state(phase), {
				exists: true,
				imageMatches: false,
			}),
			{ action: "mark-failed", reason: "runtime image mismatch" },
		);
});

async function repository(): Promise<string> {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "pi-dsbx-production-crash-")),
	);
	await exec("git", ["init", "-b", "main"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "file.txt"), "initial\n");
	await exec("git", ["add", "file.txt"], { cwd: root });
	await exec("git", ["commit", "-m", "initial"], { cwd: root });
	return root;
}

interface RestartReceipt {
	phase: SandboxPhase;
	attestation?: "pending" | "verified";
	exists: boolean;
	removalInvoked: boolean;
	patches: number;
	decision: ReturnType<typeof reconcileSandbox>;
}

async function killAndRestart(
	point: LaunchCrashPoint,
): Promise<RestartReceipt> {
	const root = await repository();
	const python = [
		"import json, os, signal, subprocess, sys",
		"node, fixture, root, point = sys.argv[1:]",
		"p = subprocess.Popen([node, '--experimental-strip-types', fixture, 'launch', root, point], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)",
		"assert p.stdout.readline().strip() == 'CRASH:' + point",
		"os.kill(p.pid, signal.SIGKILL)",
		"assert p.wait() == -signal.SIGKILL",
		"restart = subprocess.run([node, '--experimental-strip-types', fixture, 'reconcile', root], capture_output=True, text=True)",
		"assert restart.returncode == 0, restart.stderr",
		"print(restart.stdout.strip())",
	].join("\n");
	const result = await exec("python3", [
		"-c",
		python,
		process.execPath,
		crashFixture,
		root,
		point,
	]);
	return JSON.parse(result.stdout) as RestartReceipt;
}

test("Python SIGKILL probes production launch lifecycle crash points", async () => {
	for (const point of [
		"before-create",
		"after-create",
		"before-image-inspection",
		"after-image-inspection",
		"before-ready-transition",
	] as const) {
		const receipt = await killAndRestart(point);
		assert.equal(receipt.phase, "creating", point);
		assert.equal(receipt.attestation, "pending", point);
		assert.equal(receipt.decision.action, "preserve", point);
	}

	const ready = await killAndRestart("after-ready-transition");
	assert.equal(ready.phase, "ready");
	assert.equal(ready.attestation, "verified");
	assert.equal(ready.decision.action, "preserve");

	for (const [point, patches] of [
		["before-export-publication", 0],
		["after-export-publication", 1],
	] as const) {
		const receipt = await killAndRestart(point);
		assert.equal(receipt.phase, "exporting", point);
		assert.equal(receipt.patches, patches, point);
		assert.deepEqual(receipt.decision, {
			action: "preserve",
			reason: "interrupted export",
		});
	}

	const beforeRemove = await killAndRestart(
		"after-removing-state-persistence",
	);
	assert.equal(beforeRemove.phase, "removing");
	assert.equal(beforeRemove.exists, true);
	assert.equal(beforeRemove.removalInvoked, false);
	assert.notEqual(beforeRemove.decision.action, "remove-state");
	assert.deepEqual(beforeRemove.decision, {
		action: "preserve",
		reason: "interrupted removal",
	});

	for (const point of [
		"before-removal-confirmation",
		"after-removal-confirmation",
	] as const) {
		const receipt = await killAndRestart(point);
		assert.equal(receipt.phase, "removing", point);
		assert.equal(receipt.exists, false, point);
		assert.equal(receipt.removalInvoked, true, point);
		assert.equal(receipt.decision.action, "remove-state", point);
	}
});
