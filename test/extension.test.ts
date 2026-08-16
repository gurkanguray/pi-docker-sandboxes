import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { attestSandbox } from "../src/status.ts";
import dockerSandboxesExtension, {
	reexecArgumentsForSandbox,
} from "../extensions/docker-sandboxes/index.ts";

test("slash command exposes read-only diagnostics only", async () => {
	let completions: ((prefix: string) => Array<{ value: string }>) | undefined;
	const pi = {
		registerFlag: () => undefined,
		registerCommand: (
			_name: string,
			options: { getArgumentCompletions?: typeof completions },
		) => {
			completions = options.getArgumentCompletions;
		},
		on: () => undefined,
	} as unknown as ExtensionAPI;
	await dockerSandboxesExtension(pi);
	assert.deepEqual(
		completions?.("").map((entry) => entry.value),
		["status", "doctor", "config"],
	);
});

test("spoofed host sentinel reports host", async () => {
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	const pi = {
		registerFlag: () => undefined,
		registerCommand: (_name: string, options: { handler?: typeof handler }) => {
			handler = options.handler;
		},
		on: () => undefined,
	} as unknown as ExtensionAPI;
	const previous = process.env.PI_DOCKER_SANDBOX_ACTIVE;
	process.env.PI_DOCKER_SANDBOX_ACTIVE = "1";
	const notifications: Array<[string, string]> = [];
	try {
		await dockerSandboxesExtension(pi);
		await handler?.("status", {
			cwd: process.cwd(),
			ui: {
				notify: (message: string, level: string) =>
					notifications.push([message, level]),
			},
		});
	} finally {
		if (previous === undefined) delete process.env.PI_DOCKER_SANDBOX_ACTIVE;
		else process.env.PI_DOCKER_SANDBOX_ACTIVE = previous;
	}
	assert.deepEqual(notifications, [["Docker SBX: host", "info"]]);
});

test("reexec decision uses sandbox attestation", async () => {
	const spoofed = await attestSandbox({ PI_DOCKER_SANDBOX_ACTIVE: "1" });
	assert.equal(spoofed, false);
	assert.ok(
		reexecArgumentsForSandbox(spoofed, ["--docker-sandbox"]),
		"spoofed host sentinel must not suppress reexec arguments",
	);
	assert.equal(
		reexecArgumentsForSandbox(true, ["--docker-sandbox"]),
		undefined,
		"attested sandbox must skip reexec",
	);
});
