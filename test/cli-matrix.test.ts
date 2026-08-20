import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import dockerSandboxesExtension from "../extensions/docker-sandboxes/index.ts";
import { main, parseRunArgs } from "../src/cli.ts";
import { buildReexecArguments } from "../src/reexec.ts";

const commands = [
	"run",
	"status",
	"doctor",
	"config",
	"export",
	"apply",
	"destroy",
	"unlock",
	"sessions list",
	"sessions restore",
	"sessions delete",
];

const extensionFlags = [
	"docker-sandbox",
	"docker-sandbox-profile",
	"docker-sandbox-sync",
	"docker-sandbox-session",
	"docker-sandbox-name",
	"docker-sandbox-fresh",
	"docker-sandbox-keep",
	"docker-sandbox-discard-changes",
	"docker-sandbox-no-host-auth",
];

test("CLI help exposes every supported command operation", async (t) => {
	let output = "";
	t.mock.method(console, "log", (value: string) => {
		output += `${value}\n`;
	});
	assert.equal(await main(["--help"]), 0);
	assert.deepEqual(
		output
			.split("\n")
			.map((line) =>
				/^\s+pi-dsbx ((?:sessions )?[^\s[]+)/.exec(line)?.[1],
			)
			.filter(Boolean),
		commands,
	);
});

test("command matrix reaches every dispatcher without mutation", async (t) => {
	let output = "";
	t.mock.method(console, "log", (value: string) => {
		output += `${value}\n`;
	});
	for (const [argv, expected] of [
		[["run", "--matrix-probe"], /Unknown run option/],
		[["status", "--matrix-probe"], /Unexpected argument/],
		[["doctor", "--matrix-probe"], /Unexpected argument/],
		[["unlock"], /unlock requires --name/],
		[["sessions", "list", "unexpected"], /accepts only --name/],
		[["sessions", "restore", "--yes"], /--yes is not valid/],
		[["sessions", "delete"], /requires BACKUP/],
		[["export", "unexpected"], /Unexpected argument/],
		[["apply"], /requires a patch path/],
		[["destroy", "unexpected"], /Unexpected argument/],
	] as const)
		await assert.rejects(main([...argv]), expected, argv.join(" "));
	assert.equal(await main(["config"]), 0);
	assert.match(output, /"version": 2/);
});

test("run parser maps every supported launcher option", () => {
	assert.deepEqual(
		parseRunArgs([
			"--profile",
			"development",
			"--sync",
			"mirror",
			"--name",
			"matrix",
			"--cwd",
			".",
			"--fresh",
			"--keep",
			"--discard-changes",
			"--no-host-auth",
			"--yes",
			"--trust-project-config",
			"--",
			"--help",
		]),
		{
			override: {
				profile: "development",
				syncProfile: "mirror",
				sandbox: { name: "matrix", keep: true },
			},
			fresh: true,
			discardChanges: true,
			noHostAuth: true,
			yes: true,
			trustProjectConfig: true,
			cwd: resolve("."),
			piArgs: ["--help"],
		},
	);
});

test("installed extension flags all have re-exec matrix coverage", async () => {
	const registered: string[] = [];
	const pi = {
		registerFlag: (name: string) => registered.push(name),
		registerCommand: () => undefined,
		on: () => undefined,
	} as unknown as ExtensionAPI;
	await dockerSandboxesExtension(pi);
	assert.deepEqual(registered, extensionFlags);

	const valueCases = [
		["--docker-sandbox-profile", "development", "--profile"],
		["--docker-sandbox-sync", "mirror", "--sync"],
		["--docker-sandbox-name", "matrix", "--name"],
	] as const;
	for (const [outer, value, inner] of valueCases) {
		const parsed = buildReexecArguments(["--docker-sandbox", outer, value]);
		const index = parsed?.launcherArgs.indexOf(inner) ?? -1;
		assert.equal(parsed?.launcherArgs[index + 1], value, outer);
	}
	for (const [outer, inner] of [
		["--docker-sandbox-fresh", "--fresh"],
		["--docker-sandbox-keep", "--keep"],
		["--docker-sandbox-discard-changes", "--discard-changes"],
		["--docker-sandbox-no-host-auth", "--no-host-auth"],
		["--yes", "--yes"],
	] as const)
		assert.ok(
			buildReexecArguments(["--docker-sandbox", outer])?.launcherArgs.includes(
				inner,
			),
			outer,
		);
	assert.deepEqual(
		buildReexecArguments([
			"--docker-sandbox",
			"--docker-sandbox-session",
			"session-id",
		])?.innerPiArgs,
		["--session", "session-id"],
	);
	assert.equal(
		buildReexecArguments(["--docker-sandbox=false", "--help"]),
		undefined,
	);
});
