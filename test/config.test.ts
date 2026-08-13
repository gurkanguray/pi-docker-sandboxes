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

test("fresh defaults use the approved safe personalization and removal policy", () => {
	assert.deepEqual(DEFAULT_CONFIG, {
		version: 1,
		enabled: true,
		profile: "development",
		syncProfile: "custom",
		sync: {
			settings: true,
			models: true,
			packages: false,
			skills: false,
			prompts: false,
			themes: false,
			extensions: false,
			sessions: "managed",
		},
		workspaceMode: "clone",
		shareSkills: false,
		sandbox: { keep: false, dockerEngine: true },
		providers: [],
		services: [],
		network: { allow: [], deny: [] },
		export: {
			onExit: "prompt",
			directory: ".git/pi-docker-sandbox/patches",
		},
	});
});

test("config is strict and merges nested fields", () => {
	const parsed = parseConfig({
		version: 1,
		profile: "hardened",
		syncProfile: "custom",
		sync: { extensions: true, sessions: "ephemeral" },
		sandbox: { keep: false },
		network: { allow: ["api.example.com:443"] },
	});
	const config = mergeConfig(parsed);
	assert.equal(config.profile, "hardened");
	assert.equal(config.sandbox.keep, false);
	assert.equal(config.sandbox.dockerEngine, true);
	assert.deepEqual(config.network.allow, ["api.example.com:443"]);
	assert.equal(config.sync.extensions, true);
	assert.equal(config.sync.settings, true);
	assert.equal(config.sync.sessions, "ephemeral");
	assert.throws(
		() => parseConfig({ workspaecMode: "clone" }),
		/Unknown configuration field/,
	);
	assert.throws(() => parseConfig({ version: 2 }), /must be 1/);
});

test("network profiles control egress only", async () => {
	for (const name of [
		"hardened",
		"development",
		"research",
		"browser",
	] as const) {
		assert.equal("runtimeInstall" in NETWORK_PROFILES[name], false);
		const fixture = JSON.parse(
			await readFile(
				new URL(`../profiles/${name}.json`, import.meta.url),
				"utf8",
			),
		);
		assert.equal("runtimeInstall" in fixture, false);
	}
});

test("sandbox images must be explicit immutable digest references", () => {
	assert.throws(
		() => parseConfig({ sandbox: { image: "example.invalid/pi:latest" } }),
		/digest/,
	);
	const image = `example.invalid/pi@sha256:${"a".repeat(64)}`;
	assert.equal(parseConfig({ sandbox: { image } }).sandbox?.image, image);
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
		/Invalid network domain/,
	);
	assert.throws(
		() => parseConfig({ export: { directory: "../outside" } }),
		/traverse/,
	);
});

test("legacy config is normalized in memory without changing source bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-config-migration-"));
	const home = join(root, "home");
	const path = join(home, ".pi", "agent", "docker-sandboxes.json");
	const original =
		'{"version":1,"syncProfile":"balanced","sandbox":{"keep":true}}\n';
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(path, original);
	const loaded = await loadConfigResult(root, { home });
	assert.equal(loaded.value.syncProfile, "custom");
	assert.deepEqual(loaded.value.sync, {
		settings: true,
		models: true,
		packages: false,
		skills: false,
		prompts: false,
		themes: false,
		extensions: false,
		sessions: "managed",
	});
	assert.equal(loaded.value.sandbox.keep, false);
	assert.ok(
		loaded.warnings.some((warning) => /safe personalization/i.test(warning)),
	);
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
		'{"version":1,"profile":"hardened"}',
	);
	await writeFile(
		join(cwd, ".pi", "docker-sandboxes.json"),
		'{"version":1,"workspaceMode":"direct"}',
	);
	assert.equal(
		(await loadConfig(cwd, { home, projectTrusted: false })).workspaceMode,
		DEFAULT_CONFIG.workspaceMode,
	);
	const trusted = await loadConfig(cwd, { home, projectTrusted: true });
	assert.equal(trusted.profile, "hardened");
	assert.equal(trusted.workspaceMode, "direct");
});
