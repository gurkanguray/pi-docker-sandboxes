#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { loadRuntimeLock, runtimeBuildArgs } from "./runtime-lock.mjs";

export async function main(argv) {
	const mode = argv[0];
	const path = argv[1] ?? "docker/runtime-lock.json";
	const lock = await loadRuntimeLock(path);
	const args = runtimeBuildArgs(lock);
	if (mode === "--github-output") {
		for (const [name, value] of Object.entries(args))
			console.log(`${name.toLowerCase()}=${value}`);
		console.log(`buildx_version=${lock.build.buildxVersion}`);
		console.log(`buildkit_driver=${lock.build.buildkitDriver}`);
		console.log(`skopeo_image=${lock.build.skopeo}`);
		return;
	}
	if (mode === "--shell") {
		for (const [name, value] of Object.entries(args))
			console.log(`--build-arg ${name}=${value}`);
		return;
	}
	throw new Error(
		"usage: runtime-build-args.mjs --github-output|--shell [lock]",
	);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	await main(process.argv.slice(2));
