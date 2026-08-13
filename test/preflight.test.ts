import assert from "node:assert/strict";
import test from "node:test";
import { providerSetupGuidance } from "../src/preflight.ts";
import { BUILTIN_SERVICES } from "../src/providers.ts";

test("missing proxied credentials produce exact host-side setup guidance", () => {
	assert.deepEqual(
		providerSetupGuidance(
			[BUILTIN_SERVICES.openai!, BUILTIN_SERVICES.openrouter!],
			new Set(),
		),
		[
			"No proxied model credential is configured. Exit Pi, run one of:",
			"  sbx secret set openai",
			"  sbx secret set openrouter",
			"Then relaunch: pi --docker-sandbox",
			"Sandbox-local /login is unsupported by this package.",
		],
	);
});

test("no requested audited services produce no credential guidance", () => {
	assert.deepEqual(providerSetupGuidance([], new Set()), []);
});

test("configured requested services suppress no-credential guidance", () => {
	assert.deepEqual(
		providerSetupGuidance(
			[BUILTIN_SERVICES.anthropic!, BUILTIN_SERVICES.openai!],
			new Set(["anthropic"]),
		),
		[],
	);
});

test("guidance never recommends sandbox-local login", () => {
	const guidance = providerSetupGuidance(
		[BUILTIN_SERVICES.openai!],
		new Set(),
	).join("\n");
	assert.match(guidance, /sbx secret set openai/);
	assert.equal(guidance.includes("run /login"), false);
	assert.match(guidance, /\/login is unsupported/);
});
