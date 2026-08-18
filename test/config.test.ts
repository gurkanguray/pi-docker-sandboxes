import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	loadConfig,
	loadConfigResult,
	mergeConfig,
	parseConfig,
	validateDomain,
} from "../src/config.ts";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETWORK_PROFILES } from "../src/profiles.ts";

test("fresh defaults use the approved production security policy", () => {
	assert.deepEqual(DEFAULT_CONFIG, {
		version: 2,
		enabled: true,
		profile: "hardened",
		syncProfile: "custom",
		sync: {
			settings: false,
			models: false,
			packages: false,
			skills: false,
			prompts: false,
			themes: false,
			extensions: false,
			sessions: "managed",
		},
		auth: { mode: "none", providers: [] },
		sandbox: { keep: false, dockerEngine: false },
		network: { allow: [], deny: [] },
		export: {
			onExit: "prompt",
			directory: ".git/pi-docker-sandbox/patches",
		},
	});
});

test("config is strict and merges nested fields", () => {
	const parsed = parseConfig({
		version: 2,
		profile: "hardened",
		syncProfile: "custom",
		sync: { extensions: true, sessions: "sandbox" },
		auth: { mode: "proxy", providers: ["openai"] },
		sandbox: { keep: false },
		network: { allow: ["api.example.com:443"] },
	});
	const config = mergeConfig(parsed);
	assert.equal(config.profile, "hardened");
	assert.equal(config.sandbox.keep, false);
	assert.equal(config.sandbox.dockerEngine, false);
	assert.deepEqual(config.auth, { mode: "proxy", providers: ["openai"] });
	assert.deepEqual(config.network.allow, ["api.example.com:443"]);
	assert.equal(config.sync.extensions, true);
	assert.equal(config.sync.settings, false);
	assert.equal(config.sync.sessions, "sandbox");
	assert.throws(
		() => parseConfig({ workspaecMode: "clone" }),
		/Unknown configuration field/,
	);
	assert.throws(
		() => parseConfig({ workspaceMode: "direct" }),
		/Unknown configuration field/,
	);
	assert.throws(
		() => parseConfig({ shareSkills: true }),
		/Unknown configuration field/,
	);
	assert.throws(() => parseConfig({ profile: "research" }), /unsupported/);
	assert.throws(() => parseConfig({ profile: "browser" }), /unsupported/);
	assert.throws(() => parseConfig({ syncProfile: "balanced" }), /unsupported/);
	assert.throws(
		() => parseConfig({ sync: { sessions: "ephemeral" } }),
		/unsupported/,
	);
	assert.throws(() => parseConfig({ version: 1 }), /must be 2/);
	assert.throws(() => parseConfig({ providers: ["openai"] }), /Unknown/);
	assert.throws(
		() => parseConfig({ auth: { mode: "automatic" } }),
		/unsupported/,
	);
});

test("network profiles control egress only", () => {
	for (const name of ["hardened", "development"] as const)
		assert.equal("runtimeInstall" in NETWORK_PROFILES[name], false);
});

test("custom sandbox images are rejected without a compatibility alias", () => {
	assert.throws(
		() =>
			parseConfig({
				sandbox: {
					image: `example.invalid/pi@sha256:${"a".repeat(64)}`,
				},
			}),
		/Unknown configuration field: config\.sandbox\.image/,
	);
});

test("security-sensitive values reject injection and ambiguous domains", () => {
	for (const domain of [
		"https://api.example.com",
		"user@api.example.com",
		"api.example.com\nother",
		"**.example.com",
		"api.example.com:99999",
	]) {
		assert.throws(() => validateDomain(domain), TypeError, domain);
	}
	assert.equal(validateDomain("*.example.com:443"), "*.example.com:443");
	assert.throws(
		() =>
			parseConfig({
				services: [
					{
						id: "x",
						envVar: "X_KEY",
						domains: ["*.example.com"],
						headerName: "Authorization",
						valueFormat: "Bearer %s",
					},
				],
			}),
		/Unknown configuration field/,
	);
	assert.throws(
		() => parseConfig({ export: { directory: "../outside" } }),
		/traverse/,
	);
});

test("current config is loaded without changing source bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-config-migration-"));
	const home = join(root, "home");
	const path = join(home, ".pi", "agent", "docker-sandboxes.json");
	const original =
		'{"version":2,"syncProfile":"custom","sandbox":{"keep":true}}\n';
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(path, original);
	const loaded = await loadConfigResult(root, { home });
	assert.equal(loaded.value.syncProfile, "custom");
	assert.deepEqual(loaded.value.sync, {
		settings: false,
		models: false,
		packages: false,
		skills: false,
		prompts: false,
		themes: false,
		extensions: false,
		sessions: "managed",
	});
	assert.equal(loaded.value.sandbox.keep, true);
	assert.deepEqual(loaded.warnings, []);
	assert.equal(await readFile(path, "utf8"), original);
});

test("project config applies only when explicitly trusted", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-config-"));
	const home = join(root, "home");
	const cwd = join(root, "repo");
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "docker-sandboxes.json"),
		'{"version":2,"profile":"hardened"}',
	);
	await writeFile(
		join(cwd, ".pi", "docker-sandboxes.json"),
		'{"version":2,"sandbox":{"keep":true}}',
	);
	assert.equal(
		(await loadConfig(cwd, { home, projectTrusted: false })).sandbox.keep,
		false,
	);
	const trusted = await loadConfig(cwd, { home, projectTrusted: true });
	assert.equal(trusted.profile, "hardened");
	assert.equal(trusted.sandbox.keep, true);
});
