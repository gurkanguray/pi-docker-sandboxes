import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	reconcileSandbox,
	type SandboxInspection,
} from "../src/reconcile.ts";
import type { SandboxPhase, SandboxStateV2 } from "../src/state-schema.ts";
import { loadSandboxState } from "../src/workspace.ts";

const exec = promisify(execFile);
const image = `example.invalid/runtime@sha256:${"a".repeat(64)}`;

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
		{ action: "mark-ready" },
	);
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
	for (const phase of ["creating", "ready", "exporting", "removing", "failed"] as const)
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

test("Python SIGKILL phase probe restarts without authorizing ambiguous removal", async () => {
	for (const phase of ["creating", "ready", "exporting", "removing"] as const) {
		const root = await mkdtemp(join(tmpdir(), `pi-dsbx-kill-${phase}-`));
		const name = `pi-kill-${phase}`;
		const persisted = {
			...state(phase),
			name,
			hostRoot: root,
			hostWorktreeIdentity: root,
		};
		const nodeSource = [
			'import { mkdir, open, rename } from "node:fs/promises";',
			'import { dirname } from "node:path";',
			`const path = ${JSON.stringify(join(root, ".git/pi-docker-sandbox/state", `${name}.json`))};`,
			`const value = ${JSON.stringify(persisted)};`,
			'await mkdir(dirname(path), { recursive: true });',
			'const temp = `${path}.partial`;',
			'const file = await open(temp, "wx", 0o600);',
			'await file.writeFile(`${JSON.stringify(value)}\\n`);',
			'await file.sync(); await file.close();',
			'await rename(temp, path);',
			'const parent = await open(dirname(path), "r"); await parent.sync(); await parent.close();',
			'process.stdout.write("persisted\\n");',
			'await new Promise(() => {});',
		].join("\n");
		const python = [
			"import os, signal, subprocess, sys",
			"p = subprocess.Popen([sys.argv[1], '--input-type=module', '-e', sys.argv[2]], stdout=subprocess.PIPE, text=True)",
			"assert p.stdout.readline().strip() == 'persisted'",
			"os.kill(p.pid, signal.SIGKILL)",
			"assert p.wait() == -signal.SIGKILL",
		].join("\n");
		await exec("python3", ["-c", python, process.execPath, nodeSource]);
		assert.equal(JSON.parse(await readFile(join(root, ".git/pi-docker-sandbox/state", `${name}.json`), "utf8")).phase, phase);
		const restarted = await loadSandboxState(root, name);
		const inspection: SandboxInspection = { exists: "unknown" };
		assert.notEqual(reconcileSandbox(restarted, inspection).action, "remove-state");
	}
});
