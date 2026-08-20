import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { migrateSandboxState, writeJsonAtomic } from "../src/migration.ts";
import { reconcileSandbox } from "../src/reconcile.ts";
import {
	listSessionBackups,
	pruneSessionBackups,
	sessionBackupRoot,
} from "../src/sessions.ts";
import type { SandboxStateV2 } from "../src/state-schema.ts";

const oldImage = `example.invalid/runtime@sha256:${"a".repeat(64)}`;
const currentImage = `example.invalid/runtime@sha256:${"b".repeat(64)}`;
const legacy = {
	version: 1 as const,
	name: "pi-upgrade",
	hostBaseCommit: "base",
	hostBranch: "main",
	hostRepoIdentity: "repository",
	hostRoot: "/repo",
	workspaceMode: "clone" as const,
	createdAt: "2026-08-18T00:00:00.000Z",
};

function currentState(
	phase: SandboxStateV2["phase"] = "ready",
): SandboxStateV2 {
	return {
		version: 2,
		phase,
		name: legacy.name,
		hostBaseCommit: legacy.hostBaseCommit,
		hostBranch: legacy.hostBranch,
		hostRepoIdentity: legacy.hostRepoIdentity,
		hostWorktreeIdentity: legacy.hostRoot,
		hostRoot: legacy.hostRoot,
		workspaceMode: "clone",
		createdAt: legacy.createdAt,
		updatedAt: "2026-08-18T00:00:00.000Z",
		runtimeImage: currentImage,
		runtimeSchema: 1,
		packageVersion: "1.0.0",
	};
}

test("v1 upgrades to v2 only with exact current runtime evidence", () => {
	const migrated = migrateSandboxState(legacy, "/tmp/state.json", {
		exists: true,
		inspectedImage: currentImage,
		expectedImage: currentImage,
		runtimeSchema: 1,
		packageVersion: "1.0.0",
		migratedAt: "2026-08-18T01:00:00.000Z",
	});
	assert.equal(migrated.sourceVersion, 1);
	assert.equal(migrated.value.version, 2);
	assert.equal(migrated.value.runtimeImage, currentImage);
	assert.throws(
		() =>
			migrateSandboxState(legacy, "/tmp/state.json", {
				exists: true,
				inspectedImage: oldImage,
				expectedImage: currentImage,
				runtimeSchema: 1,
				packageVersion: "1.0.0",
			}),
		/matching daemon and image evidence/i,
	);
});

test("downgrade and interrupted lifecycle state fail closed without mutation", () => {
	assert.throws(
		() => migrateSandboxState({ version: 3 }, "/tmp/future.json"),
		/unsupported state version 3.*preserve/i,
	);
	for (const phase of ["creating", "exporting", "removing"] as const) {
		const state = currentState(phase);
		const before = structuredClone(state);
		const decision = reconcileSandbox(state, {
			exists: true,
			imageMatches: true,
		});
		assert.equal(decision.action, "preserve");
		assert.deepEqual(state, before);
	}
	assert.deepEqual(
		reconcileSandbox(currentState(), { exists: true, imageMatches: false }),
		{ action: "mark-failed", reason: "runtime image mismatch" },
	);
});

test("disk-full atomic sync preserves the previous state and clears staging", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-upgrade-disk-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "state.json");
	await writeFile(path, '{"version":1}\n');
	const diskFull = Object.assign(new Error("injected disk full"), {
		code: "ENOSPC",
	});
	await assert.rejects(
		writeJsonAtomic(
			path,
			{ version: 2 },
			{
				beforeRename: async () => {
					throw diskFull;
				},
			},
		),
		(error: unknown) => error === diskFull,
	);
	assert.equal(await readFile(path, "utf8"), '{"version":1}\n');
	assert.deepEqual(
		(await readdir(root)).filter((entry) => entry.endsWith(".tmp")),
		[],
	);
});

test("upgrade backup pruning ratchets limits while retaining the newest recovery point", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-upgrade-backups-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const root = sessionBackupRoot(agentDir, "repository", "pi-upgrade");
	for (const id of [
		"2026-08-16T00-00-00-000Z",
		"2026-08-17T00-00-00-000Z",
		"2026-08-18T00-00-00-000Z",
	]) {
		await mkdir(join(root, id, "sessions"), { recursive: true });
		await writeFile(join(root, id, "sessions", "state"), id);
	}
	assert.deepEqual(
		await pruneSessionBackups(
			agentDir,
			"repository",
			"pi-upgrade",
			{ maxCount: 2, maxAgeDays: 3650, maxBytes: 1_000_000 },
			new Date("2026-08-18T12:00:00.000Z"),
		),
		["2026-08-16T00-00-00-000Z"],
	);
	assert.deepEqual(
		(await listSessionBackups(agentDir, "repository", "pi-upgrade")).map(
			({ id }) => id,
		),
		["2026-08-17T00-00-00-000Z", "2026-08-18T00-00-00-000Z"],
	);
});
