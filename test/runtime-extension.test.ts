import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface RuntimeExtensionModule {
	registerSandboxRuntime(
		pi: ExtensionAPI,
		context: { env: NodeJS.ProcessEnv; mountInfo: string },
	): Promise<void>;
}

const runtimeUrl = new URL("../runtime/extension.mjs", import.meta.url);
const readOnlySourceMount =
	"42 31 0:39 / /run/sandbox/source ro,nosuid,nodev - virtiofs source rw";

function fakeApi() {
	let command:
		| {
				getArgumentCompletions?: (prefix: string) => Array<{ value: string }>;
				handler: (
					args: string,
					context: { ui: { notify(message: string, level: string): void } },
				) => Promise<void>;
			}
		| undefined;
	let sessionStart:
		| ((_event: unknown, context: { ui: { setStatus(key: string, value: string): void } }) => void)
		| undefined;
	let flagRegistrations = 0;
	const pi = {
		registerFlag: () => {
			flagRegistrations++;
		},
		registerCommand: (_name: string, options: typeof command) => {
			command = options;
		},
		on: (event: string, handler: typeof sessionStart) => {
			if (event === "session_start") sessionStart = handler;
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		command: () => command,
		sessionStart: () => sessionStart,
		flagRegistrations: () => flagRegistrations,
	};
}

test("sandbox runtime is standalone from every host controller subsystem", async () => {
	const source = await readFile(runtimeUrl, "utf8");
	assert.doesNotMatch(
		source,
		/(?:from\s+|import\s*\()["'][^"']*(?:src\/(?:launch|image|workspace|config)|image-lock|host-auth)[^"']*["']/,
	);
	assert.doesNotMatch(source, /registerFlag\s*\(/);
});

test("attested runtime exposes status and diagnostics only", async () => {
	const runtime = (await import(runtimeUrl.href)) as RuntimeExtensionModule;
	const fake = fakeApi();
	await runtime.registerSandboxRuntime(fake.pi, {
		env: {
			PI_DOCKER_SANDBOX_ACTIVE: "1",
			PI_DOCKER_SANDBOX_PROFILE: "hardened",
		},
		mountInfo: readOnlySourceMount,
	});

	assert.equal(fake.flagRegistrations(), 0);
	assert.deepEqual(
		fake.command()?.getArgumentCompletions?.("").map(({ value }) => value),
		["status", "doctor"],
	);
	const notifications: Array<[string, string]> = [];
	const context = {
		ui: {
			notify: (message: string, level: string) =>
				notifications.push([message, level]),
		},
	};
	await fake.command()?.handler("status", context);
	await fake.command()?.handler("doctor", context);
	await fake.command()?.handler("config", context);
	assert.deepEqual(notifications[0], ["SBX: clone · hardened", "info"]);
	assert.match(notifications[1]![0], /✓ sandbox attestation verified/);
	assert.match(notifications[1]![0], /✓ host source mount is read-only/);
	assert.deepEqual(notifications[2], ["Unknown subcommand: config", "error"]);

	const statuses: Array<[string, string]> = [];
	fake.sessionStart()?.({}, {
		ui: { setStatus: (key, value) => statuses.push([key, value]) },
	});
	assert.deepEqual(statuses, [["docker-sandboxes", "SBX: clone · hardened"]]);
});

test("runtime registers no UI without sandbox attestation", async () => {
	const runtime = (await import(runtimeUrl.href)) as RuntimeExtensionModule;
	const fake = fakeApi();
	await runtime.registerSandboxRuntime(fake.pi, {
		env: { PI_DOCKER_SANDBOX_ACTIVE: "1" },
		mountInfo:
			"42 31 0:39 / /run/sandbox/source rw,nosuid,nodev - virtiofs source rw",
	});
	assert.equal(fake.command(), undefined);
	assert.equal(fake.sessionStart(), undefined);
	assert.equal(fake.flagRegistrations(), 0);
});
