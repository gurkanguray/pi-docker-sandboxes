#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const [packageRoot, image, templateStoreId] = process.argv.slice(2);
if (!packageRoot || !image || !templateStoreId)
	throw new Error("installed package, runtime image, and template store ID required");
const root = await mkdtemp(join(tmpdir(), "pi-public-runtime-"));
try {
	await exec("git", ["init", "-b", "main"], { cwd: root });
	await exec("git", ["config", "user.email", "release@example.invalid"], {
		cwd: root,
	});
	await exec("git", ["config", "user.name", "Release verification"], {
		cwd: root,
	});
	await writeFile(join(root, "release-smoke.txt"), "public install\n");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "-m", "release smoke"], { cwd: root });
	const [{ launch }, { SbxClient }] = await Promise.all([
		import(pathToFileURL(join(packageRoot, "dist", "launch.js")).href),
		import(pathToFileURL(join(packageRoot, "dist", "sbx", "client.js")).href),
	]);
	const result = await launch({
		cwd: root,
		client: new SbxClient(),
		yes: true,
		projectTrusted: false,
		config: {
			syncProfile: "clean",
			auth: { mode: "none", providers: [] },
			sandbox: { keep: false },
		},
		piArgs: ["--help"],
		resolveImage: async () => ({ image, templateStoreId }),
	});
	if (result.agentExitCode !== 0 || result.custody !== "released")
		throw new Error("public package runtime launch did not exit and clean up");
	console.log(JSON.stringify({ runtimeLaunches: 1, custody: result.custody }));
} finally {
	await rm(root, { recursive: true, force: true });
}
