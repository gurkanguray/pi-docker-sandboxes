#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sanitizedHostEnvironment } from "../dist/launch.js";
import { runInherited } from "../dist/sbx/inherited-runner.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const args = [cli, ...process.argv.slice(2)];
const env = sanitizedHostEnvironment();

function runDirect() {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, args, { env, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => resolve(code ?? 1));
	});
}

try {
	process.exitCode =
		process.platform === "win32"
			? await runDirect()
			: await runInherited(process.execPath, args, env);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
