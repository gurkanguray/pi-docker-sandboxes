#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

try {
	const argument = process.argv[2];
	if (!argument || process.argv.length !== 3)
		throw new Error("Usage: node scripts/assert-one-tarball.mjs <directory>");
	const directory = resolve(argument);
	const entries = await readdir(directory, { withFileTypes: true });
	const tarballs = entries.filter(
		(entry) => entry.isFile() && entry.name.endsWith(".tgz"),
	);
	if (tarballs.length !== 1)
		throw new Error("Directory must contain exactly one .tgz file");
	console.log(join(directory, tarballs[0].name));
} catch (error) {
	console.error(
		`Tarball assertion failed: ${error instanceof Error ? error.message : error}`,
	);
	process.exitCode = 1;
}
