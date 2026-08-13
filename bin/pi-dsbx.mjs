#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { sanitizedHostEnvironment } from "../dist/launch.js";
import { runInherited } from "../dist/sbx/inherited-runner.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

try {
	process.exitCode = await runInherited(
		process.execPath,
		[cli, ...process.argv.slice(2)],
		sanitizedHostEnvironment(),
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
