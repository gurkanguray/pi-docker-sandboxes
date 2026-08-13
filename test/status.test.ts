import assert from "node:assert/strict";
import test from "node:test";
import {
	formatDoctor,
	getDockerSandboxStatus,
	runDoctor,
	sandboxStatus,
} from "../src/status.ts";
import type { SbxClient } from "../src/sbx/client.ts";

test("status trusts only the exact active sentinel", () => {
	assert.equal(sandboxStatus({}), "Docker SBX: host");
	assert.equal(
		sandboxStatus({ PI_DOCKER_SANDBOX_ACTIVE: "true" }),
		"Docker SBX: host",
	);
	assert.equal(
		sandboxStatus({
			PI_DOCKER_SANDBOX_ACTIVE: "1",
			PI_DOCKER_SANDBOX_PROFILE: "hardened",
			PI_DOCKER_SANDBOX_WORKSPACE_MODE: "clone",
		}),
		"SBX: clone · hardened",
	);
});

test("machine status does not promote sentinels into security attestation", () => {
	const status = getDockerSandboxStatus({
		PI_DOCKER_SANDBOX_ACTIVE: "1",
		PI_DOCKER_SANDBOX_NAME: "safe",
		PI_DOCKER_SANDBOX_WORKSPACE_MODE: "clone",
	});
	assert.equal(status.runningInsideSandbox, true);
	assert.equal(status.sandboxName, "safe");
	assert.equal(status.hostWorkspaceWritable, undefined);
	assert.equal(status.sharedSkills, "unknown");
	assert.equal(status.privateDockerEngine, "unknown");
});

test("doctor warns when proxy service discovery is unavailable", async () => {
	const client = {
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
	} as unknown as SbxClient;
	const results = await runDoctor(client, "/definitely-not-a-repository");
	assert.ok(
		results.some(
			(result) =>
				result.level === "warning" &&
				result.message.includes("credential proxy service discovery"),
		),
	);
});

test("doctor reports discovered proxy credential services", async () => {
	const client = {
		version: async () => ({ version: "0.38.0" }),
		capabilities: async () => ({
			clone: true,
			noShareSkills: true,
			kitValidate: true,
			inspectJson: true,
			policyCheckNetwork: true,
			credentialServices: ["openai"],
		}),
		list: async () => [],
	} as unknown as SbxClient;
	const results = await runDoctor(client, "/definitely-not-a-repository");
	assert.ok(
		results.some(
			(result) =>
				result.level === "pass" &&
				result.message === "credential proxy services: openai",
		),
	);
});

test("doctor reports configured requested credentials and unsupported requests separately", async () => {
	const config = await import("../src/config.ts");
	const original = config.DEFAULT_CONFIG.providers;
	config.DEFAULT_CONFIG.providers = ["openai", "cursor"];
	try {
		const client = {
			version: async () => ({ version: "0.38.0" }),
			capabilities: async () => ({
				clone: true,
				noShareSkills: true,
				kitValidate: true,
				inspectJson: true,
				policyCheckNetwork: true,
				credentialServices: ["openai", "cursor"],
			}),
			secretServices: async () => new Set(["openai"]),
			list: async () => [],
		} as unknown as SbxClient;
		const results = await runDoctor(client, "/definitely-not-a-repository");
		assert.ok(
			results.some(
				(result) => result.message === "credential service openai: configured",
			),
		);
		assert.ok(
			results.some(
				(result) =>
					result.level === "warning" &&
					result.message.includes("credential service cursor") &&
					result.message.includes("not both audited and proxy-supported"),
			),
		);
	} finally {
		config.DEFAULT_CONFIG.providers = original;
	}
});

test("doctor formatting is stable", () => {
	assert.equal(
		formatDoctor([
			{ level: "pass", message: "ok" },
			{ level: "warning", message: "check" },
			{ level: "fail", message: "broken" },
		]),
		"✓ ok\n! check\n✗ broken",
	);
});
