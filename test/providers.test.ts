import assert from "node:assert/strict";
import test from "node:test";
import {
	BUILTIN_SERVICES,
	resolveAvailableServices,
} from "../src/providers.ts";

const EXPECTED_BUILTINS = {
	anthropic: {
		id: "anthropic",
		envVar: "ANTHROPIC_API_KEY",
		domains: ["api.anthropic.com"],
		headerName: "x-api-key",
		valueFormat: "%s",
	},
	google: {
		id: "google",
		envVar: "GEMINI_API_KEY",
		domains: ["generativelanguage.googleapis.com"],
		headerName: "x-goog-api-key",
		valueFormat: "%s",
	},
	openai: {
		id: "openai",
		envVar: "OPENAI_API_KEY",
		domains: ["api.openai.com"],
		headerName: "Authorization",
		valueFormat: "Bearer %s",
	},
	openrouter: {
		id: "openrouter",
		envVar: "OPENROUTER_API_KEY",
		domains: ["openrouter.ai"],
		headerName: "Authorization",
		valueFormat: "Bearer %s",
	},
	xai: {
		id: "xai",
		envVar: "XAI_API_KEY",
		domains: ["api.x.ai"],
		headerName: "Authorization",
		valueFormat: "Bearer %s",
	},
};

test("all audited provider mappings are exact and complete", () => {
	assert.deepEqual(BUILTIN_SERVICES, EXPECTED_BUILTINS);
	for (const service of Object.values(BUILTIN_SERVICES))
		assert.ok(service.domains.every((domain) => !domain.includes("*")));
});

test("built-in mappings are deeply immutable and resolutions are clones", () => {
	const openai = BUILTIN_SERVICES.openai!;
	assert.ok(Object.isFrozen(BUILTIN_SERVICES));
	assert.ok(Object.isFrozen(openai));
	assert.ok(Object.isFrozen(openai.domains));
	assert.throws(() => openai.domains.push("evil.example"), TypeError);
	assert.throws(
		() => ((openai as { headerName: string }).headerName = "x-evil"),
		TypeError,
	);
	const first = resolveAvailableServices(["openai"], ["openai"]).services[0]!;
	assert.notEqual(first, openai);
	assert.notEqual(first.domains, openai.domains);
	first.domains[0] = "mutated.example";
	first.headerName = "x-mutated";
	const second = resolveAvailableServices(["openai"], ["openai"]).services[0]!;
	assert.deepEqual(second, EXPECTED_BUILTINS.openai);
});

test("provider resolution intersects requested, audited, and live proxy services", () => {
	const result = resolveAvailableServices(
		["openai", "openrouter"],
		["openai", "anthropic", "unknown"],
	);
	assert.deepEqual(
		result.services.map((service) => service.id),
		["openai"],
	);
	assert.deepEqual(result.unsupported, ["anthropic", "unknown"]);
});

test("provider resolution preserves requested order and reports malformed IDs deterministically", () => {
	const result = resolveAvailableServices(
		["openrouter", "cursor", "openai", "anthropic"],
		["openrouter", "cursor", "Bad ID", "openai", "cursor", "unknown"],
	);
	assert.deepEqual(
		result.services.map((service) => service.id),
		["openrouter", "openai"],
	);
	assert.deepEqual(result.unsupported, [
		"cursor",
		"Bad ID",
		"cursor",
		"unknown",
	]);
});
