import assert from "node:assert/strict";
import test from "node:test";
import {
	attestSandbox,
	formatDoctor,
	isSandboxAttested,
	runDoctor,
	sandboxStatus,
} from "../src/status.ts";
import type { SbxClient } from "../src/sbx/client.ts";

const readOnlySourceMount =
	"42 35 0:39 / /run/sandbox/source ro,nosuid,nodev - virtiofs source rw\n";

test("sandbox attestation requires the exact sentinel and read-only source mount", () => {
	assert.equal(isSandboxAttested({}, readOnlySourceMount), false);
	assert.equal(
		isSandboxAttested(
			{ PI_DOCKER_SANDBOX_ACTIVE: "true" },
			readOnlySourceMount,
		),
		false,
	);
	assert.equal(
		isSandboxAttested(
			{ PI_DOCKER_SANDBOX_ACTIVE: "1" },
			readOnlySourceMount.replace(" ro,", " rw,"),
		),
		false,
	);
	assert.equal(
		isSandboxAttested({ PI_DOCKER_SANDBOX_ACTIVE: "1" }, readOnlySourceMount),
		true,
	);
});

test("a spoofed host sentinel is not attested", async () => {
	assert.equal(await attestSandbox({ PI_DOCKER_SANDBOX_ACTIVE: "1" }), false);
});

test("status uses attestation rather than the sentinel", () => {
	const spoofed = {
		PI_DOCKER_SANDBOX_ACTIVE: "1",
		PI_DOCKER_SANDBOX_PROFILE: "hardened",
	};
	assert.equal(sandboxStatus(false, spoofed), "Docker SBX: host");
	assert.equal(sandboxStatus(true, spoofed), "SBX: clone · hardened");
});

test("sandbox doctor reports the clone-only workspace mode", async () => {
	const results = await runDoctor(true);
	assert.ok(
		results.some(
			(result) =>
				result.level === "pass" && result.message === "workspace mode: clone",
		),
	);
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
	const results = await runDoctor(
		false,
		client,
		"/definitely-not-a-repository",
	);
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
	const results = await runDoctor(
		false,
		client,
		"/definitely-not-a-repository",
	);
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
		const results = await runDoctor(
			false,
			client,
			"/definitely-not-a-repository",
		);
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
