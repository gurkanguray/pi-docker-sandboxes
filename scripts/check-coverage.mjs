#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

// Production-only baseline measured on Node 24.12.0: lines 90.13,
// branches 79.95, functions 84.54. Floors trail that evidence and may only
// ratchet upward.
const tests = readdirSync(new URL("../test/", import.meta.url))
	.filter((name) => name.endsWith(".test.ts"))
	.sort()
	.map((name) => new URL(`../test/${name}`, import.meta.url).pathname);
const result = spawnSync(
	process.execPath,
	[
		"--experimental-strip-types",
		"--experimental-test-coverage",
		"--test-coverage-lines=90",
		"--test-coverage-branches=79",
		"--test-coverage-functions=84",
		"--test-coverage-exclude=**/test/**",
		"--test-coverage-exclude=**/pi-dsbx-*/**",
		"--test",
		...tests,
	],
	{ stdio: "inherit", env: { ...process.env, NODE_OPTIONS: "" } },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
