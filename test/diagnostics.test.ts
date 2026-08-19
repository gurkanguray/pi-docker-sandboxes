import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	buildDoctorReceipt,
	buildStatusReceipt,
	diagnosticsExitCode,
} from "../src/diagnostics.ts";
import { IMAGE_LOCK } from "../src/image-lock.ts";
import type { SbxClient } from "../src/sbx/client.ts";

const exec = promisify(execFile);

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-diagnostics-"));
	await exec("git", ["init", "-b", "main"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "file"), "test\n");
	await exec("git", ["add", "file"], { cwd: root });
	await exec("git", ["commit", "-m", "initial"], { cwd: root });
	return root;
}

function client(): SbxClient {
	return {
		version: async () => ({ version: "0.38.0" }),
		capabilities: async () => ({
			clone: true,
			noShareSkills: true,
			kitValidate: true,
			inspectJson: true,
			policyCheckNetwork: true,
			credentialServices: [],
		}),
		list: async () => [],
		exists: async () => false,
	} as unknown as SbxClient;
}

test("doctor JSON receipt is schema-versioned, ordered, deterministic, and redacted", async () => {
	const cwd = await repository();
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-agent-"));
	await mkdir(agentDir, { recursive: true });
	const secret = "sk-secretvalue123456";
	const receipt = await buildDoctorReceipt({
		cwd,
		agentDir,
		client: client(),
		now: new Date("2026-08-18T00:00:00.000Z"),
		platform: "darwin",
		arch: "arm64",
		nodeVersion: "v24.12.0",
		runCommand: async (command) =>
			command === "pi" ? IMAGE_LOCK.piVersion : `27.0.0-${secret}`,
	});
	assert.equal(receipt.schemaVersion, 1);
	assert.equal(receipt.kind, "pi-dsbx.doctor");
	assert.equal(receipt.generatedAt, "2026-08-18T00:00:00.000Z");
	assert.deepEqual(
		receipt.checks.map((entry) => entry.id),
		[...receipt.checks.map((entry) => entry.id)].sort(),
	);
	assert.equal(JSON.stringify(receipt).includes(secret), false);
	assert.equal(receipt.checks.some((entry) => entry.id === "image"), true);
	assert.equal(receipt.checks.some((entry) => entry.id === "disk"), true);
	assert.equal(receipt.checks.some((entry) => entry.id === "backup"), true);
	assert.equal(receipt.checks.some((entry) => entry.id === "auth"), true);
	assert.equal(diagnosticsExitCode(receipt), 0);
});

test("doctor and status use deterministic nonzero reconciliation exits", async () => {
	const cwd = await repository();
	const options = {
		cwd,
		client: client(),
		now: new Date("2026-08-18T00:00:00.000Z"),
		platform: "darwin" as const,
		arch: "arm64",
		nodeVersion: "v23.0.0",
		runCommand: async (command: string) =>
			command === "pi" ? IMAGE_LOCK.piVersion : "27.0.0",
	};
	const doctor = await buildDoctorReceipt(options);
	assert.equal(
		doctor.checks.find((entry) => entry.id === "node")?.level,
		"fail",
	);
	assert.equal(diagnosticsExitCode(doctor), 1);
	const status = await buildStatusReceipt(options);
	assert.equal(status.schemaVersion, 1);
	assert.equal(status.kind, "pi-dsbx.status");
	assert.deepEqual(
		status.checks.map((entry) => entry.id),
		["backup", "git", "image", "lease", "lifecycle", "upgrade"],
	);
	assert.equal(diagnosticsExitCode(status), 0);
});
