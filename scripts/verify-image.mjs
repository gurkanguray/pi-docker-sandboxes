#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compiled = `${root}/dist/image.js`;
const exec = promisify(execFile);

async function productionModule() {
	let source = true;
	try {
		await access(`${root}/.source-checkout`);
	} catch {
		source = false;
	}
	if (source) await exec("npm", ["run", "build:cli"], { cwd: root });
	else
		try {
			await access(compiled);
		} catch {
			throw new Error(
				"Installed image verifier is incomplete: dist/image.js is missing",
			);
		}
	return import(pathToFileURL(compiled).href);
}

function failure(error) {
	const detail = String(
		error?.detail ?? (error instanceof Error ? error.message : error),
	)
		.replace(
			/((?:token|password|secret|api[-_]?key)\s*[:=]\s*)\S+/gi,
			"$1[redacted]",
		)
		.replace(/\s+/g, " ")
		.slice(0, 500);
	return {
		status: "failed",
		phase: error?.phase ?? "prepare",
		operation: error?.operation ?? "verify image",
		detail,
	};
}

const [image, candidate] = process.argv.slice(2);
if (!image || image === "--help" || image === "-h") {
	console.log(
		"Usage: npm run image:verify -- <local-image> [candidate@sha256:digest]",
	);
	process.exitCode = image ? 0 : 2;
} else {
	try {
		const { compareImageReceipts, verifyImageReceipt } =
			await productionModule();
		const { loadImageLock } = await import(
			pathToFileURL(
				`${root}/${await access(`${root}/dist/image-lock.js`).then(
					() => "dist/image-lock.js",
					() => "src/image-lock.ts",
				)}`,
			).href
		);
		const lock = await loadImageLock(`${root}/docker/image-lock.json`);
		const receipt = await verifyImageReceipt(image, lock);
		console.log(`✓ image: ${receipt.image}`);
		console.log(`✓ digest: ${receipt.digest}`);
		console.log(
			`✓ platform/user: ${receipt.platform} uid=${receipt.uid} (${receipt.user})`,
		);
		console.log(
			`✓ versions: pi=${receipt.versions.pi} package=${receipt.versions.package}`,
		);
		const parity = candidate
			? compareImageReceipts(receipt, await verifyImageReceipt(candidate, lock))
			: { status: "not-compared", candidate: null };
		console.log(
			candidate ? `✓ parity: ${candidate}` : "- parity: candidate not supplied",
		);
		console.log(JSON.stringify({ ...receipt, parity }));
	} catch (error) {
		console.error(`Image verification failed: ${failure(error).detail}`);
		console.log(JSON.stringify(failure(error)));
		process.exitCode = 1;
	}
}
