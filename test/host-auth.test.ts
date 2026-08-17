import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	listHostOAuthProviderIds,
	printHostApiKey,
	syncHostProviderSecrets,
} from "../src/host-auth.ts";
import { BUILTIN_SERVICES } from "../src/providers.ts";

const openai = BUILTIN_SERVICES.openai!;
const hostKey = "host-api-key-value";

test("syncs a missing host API key to sbx through stdin only", async () => {
	const calls: Array<{ id: string; key: string }> = [];
	const result = await syncHostProviderSecrets({
		services: [openai],
		configured: new Set(),
		printApiKey: async () => hostKey,
		setSecret: async (id, key) => {
			calls.push({ id, key });
		},
	});
	assert.deepEqual(result.synced, ["openai"]);
	assert.deepEqual(result.requested, ["openai"]);
	assert.ok(
		result.warnings.some((warning) =>
			warning.includes("Storing host credential for openai"),
		),
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.id, "openai");
	assert.equal(calls[0]?.key, hostKey);
	assert.equal(JSON.stringify(result).includes(hostKey), false);
});

test("does not overwrite an existing sbx secret", async () => {
	let set = 0;
	const result = await syncHostProviderSecrets({
		services: [openai],
		configured: new Set(["openai"]),
		printApiKey: async () => "should-not-print",
		setSecret: async () => {
			set++;
		},
	});
	assert.deepEqual(result.synced, []);
	assert.equal(set, 0);
});

test("rejects empty, multiline, or control-bearing keys", async () => {
	for (const key of ["", "   ", "one\ntwo", "key\0value", "key\rvalue"]) {
		let set = 0;
		const result = await syncHostProviderSecrets({
			services: [openai],
			configured: new Set(),
			printApiKey: async () => key,
			setSecret: async () => {
				set++;
			},
		});
		assert.equal(set, 0, key);
		assert.deepEqual(result.synced, []);
		assert.ok(
			result.warnings.some((warning) => warning.includes("openai")),
			key,
		);
		if (key.trim())
			assert.equal(result.warnings.join("\n").includes(key.trim()), false);
	}
});

test("missing host API key stays fail-open and suggests oauth when needed", async () => {
	let set = 0;
	const result = await syncHostProviderSecrets({
		services: [openai],
		configured: new Set(),
		printApiKey: async () => undefined,
		setSecret: async () => {
			set++;
		},
	});
	assert.equal(set, 0);
	assert.deepEqual(result.synced, []);
	assert.ok(
		result.warnings.some((warning) => /sbx secret set openai/.test(warning)),
	);
});

test("setSecret failure does not throw and does not leak the key", async () => {
	const result = await syncHostProviderSecrets({
		services: [openai],
		configured: new Set(),
		printApiKey: async () => hostKey,
		setSecret: async () => {
			throw new Error(`sbx refused ${hostKey}`);
		},
	});
	assert.deepEqual(result.synced, []);
	assert.ok(result.warnings.some((warning) => warning.includes("openai")));
	assert.equal(result.warnings.join("\n").includes(hostKey), false);
});

test("oauth host ids are not unmatched", async () => {
	const result = await syncHostProviderSecrets({
		hostProviderIds: ["openai-codex", "qwen-token-plan", "xai"],
		proxyIds: ["openai", "openrouter", "xai"],
		configured: new Set(),
		oauthHostIds: new Set(["openai-codex", "xai"]),
		printApiKey: async () => undefined,
		setSecret: async () => {},
	});
	assert.equal(
		result.warnings.some((warning) => warning.includes("openai-codex")),
		false,
	);
	assert.ok(result.warnings.some((warning) => /qwen-token-plan/.test(warning)));
	assert.equal(
		result.warnings.some((warning) => /no exact sbx/.test(warning)),
		false,
	);
});

test("does not map openai-codex onto openai", async () => {
	const printed: string[] = [];
	const stored: string[] = [];
	const result = await syncHostProviderSecrets({
		hostProviderIds: ["openai-codex", "qwen-token-plan", "xai"],
		proxyIds: ["openai", "openrouter", "xai"],
		configured: new Set(),
		printApiKey: async (id) => {
			printed.push(`key:${id}`);
			return undefined;
		},
		setSecret: async (id) => {
			stored.push(id);
		},
	});
	assert.deepEqual(result.synced, []);
	assert.deepEqual(result.requested, ["xai"]);
	assert.deepEqual(stored, []);
	assert.deepEqual(printed, ["key:xai"]);
	assert.ok(
		result.warnings.some((warning) => warning.includes("openai-codex")),
	);
	assert.ok(
		result.warnings.some((warning) => warning.includes("qwen-token-plan")),
	);
});

test("only copy-eligible OAuth tokens suppress provider warnings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-auth-eligibility-"));
	const authPath = join(directory, "auth.json");
	await writeFile(
		authPath,
		JSON.stringify({
			valid: { type: "oauth", access: "access", refresh: "refresh" },
			"missing-refresh": { type: "oauth", access: "access" },
			"wrong-access": { type: "oauth", access: 42, refresh: "refresh" },
			"api-key": { type: "api_key", key: "key" },
		}),
	);
	try {
		assert.deepEqual(
			await listHostOAuthProviderIds(
				["valid", "missing-refresh", "wrong-access", "api-key"],
				authPath,
			),
			new Set(["valid"]),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("reads host auth.json without spawning pi", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-auth-"));
	const authPath = join(directory, "auth.json");
	await writeFile(
		authPath,
		JSON.stringify({
			xai: { type: "oauth", access: "host-oauth-access", refresh: "refresh" },
			openrouter: { type: "api_key", key: "host-api-key-value" },
		}),
	);
	try {
		assert.equal(
			await printHostApiKey("openrouter", authPath),
			"host-api-key-value",
		);
		assert.equal(await printHostApiKey("xai", authPath), undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("noHostAuth skips print and set", async () => {
	let printed = 0;
	let set = 0;
	const result = await syncHostProviderSecrets({
		services: [openai],
		configured: new Set(),
		noHostAuth: true,
		printApiKey: async () => {
			printed++;
			return "nope";
		},
		setSecret: async () => {
			set++;
		},
	});
	assert.equal(printed, 0);
	assert.equal(set, 0);
	assert.deepEqual(result.synced, []);
	assert.deepEqual(result.warnings, []);
});
