#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

if (existsSync(new URL("../.source-checkout", import.meta.url))) {
	rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
	const require = createRequire(import.meta.url);
	const tsc = join(
		dirname(dirname(require.resolve("typescript"))),
		"bin",
		"tsc",
	);
	const result = spawnSync(
		process.execPath,
		[tsc, "--project", "tsconfig.cli.json"],
		{ cwd: new URL("..", import.meta.url), stdio: "inherit" },
	);
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}
