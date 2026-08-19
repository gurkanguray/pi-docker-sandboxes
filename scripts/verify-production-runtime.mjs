#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fail(message) {
	throw new Error(message);
}

export async function verifyProductionRuntime({
	imageLockPath,
	releaseLockPath,
	receiptPath,
	evidenceDirectory,
}) {
	const [imageLock, release, receipt] = await Promise.all([
		readFile(imageLockPath, "utf8").then(JSON.parse),
		readFile(releaseLockPath, "utf8").then(JSON.parse),
		readFile(receiptPath, "utf8").then(JSON.parse),
	]);
	const runtime = imageLock.images?.standard;
	const reference = runtime?.reference ?? "";
	const indexDigest = reference.split("@")[1];
	const expectedPlatforms = ["linux/amd64", "linux/arm64"];
	if (
		runtime?.status !== "published" ||
		!/^ghcr\.io\/[^@]+@sha256:[0-9a-f]{64}$/.test(reference) ||
		JSON.stringify(runtime.platforms) !== JSON.stringify(expectedPlatforms) ||
		runtime.privileged !== false
	)
		fail("standard runtime lock is not immutable and published");
	if (
		release?.version !== 1 ||
		!Number.isSafeInteger(release?.runId) ||
		release.runId <= 0 ||
		!Number.isSafeInteger(release?.runAttempt) ||
		release.runAttempt <= 0 ||
		!/^\w[\w.-]*$/.test(release?.receiptArtifact ?? "") ||
		!Array.isArray(release?.securityArtifacts) ||
		release.securityArtifacts.length !== 2 ||
		!release.securityArtifacts.every((name) => /^security-(?:amd64|arm64)-standard-\d+-\d+$/.test(name))
	)
		fail("standard runtime release evidence lock is incomplete");
	if (
		receipt.schemaVersion !== 1 ||
		receipt.variant !== "standard" ||
		receipt.indexDigest !== indexDigest ||
		receipt.candidateReference !== reference ||
		receipt.sourceSha !== release.sourceSha ||
		JSON.stringify(receipt.platforms) !== JSON.stringify(expectedPlatforms) ||
		JSON.stringify(Object.keys(receipt.scans ?? {}).sort()) !==
			JSON.stringify(expectedPlatforms) ||
		JSON.stringify(Object.keys(receipt.sbom ?? {}).sort()) !==
			JSON.stringify(expectedPlatforms)
	)
		fail("runtime receipt does not bind the locked standard runtime");

	const names = new Set(await readdir(evidenceDirectory));
	for (const platform of expectedPlatforms) {
		for (const kind of ["scans", "sbom"]) {
			const item = receipt[kind]?.[platform];
			const name = basename(item?.name ?? "");
			if (!name || !names.has(name))
				fail(`missing ${kind} evidence for ${platform}`);
			const bytes = await readFile(join(evidenceDirectory, name));
			if (digest(bytes) !== item.sha256)
				fail(`${kind} evidence digest mismatch for ${platform}`);
			if (kind === "scans") {
				const sarif = JSON.parse(bytes);
				const findings = (sarif.runs ?? []).reduce(
					(total, run) => total + (run.results?.length ?? 0),
					0,
				);
				if (findings !== 0)
					fail(`standard runtime raw scan has ${findings} findings for ${platform}`);
			}
		}
	}
	return { reference, indexDigest, sourceSha: receipt.sourceSha, platforms: expectedPlatforms };
}

async function main([
	imageLockPath,
	releaseLockPath,
	receiptPath,
	evidenceDirectory,
	outputPath,
]) {
	if (!imageLockPath || !releaseLockPath || !receiptPath || !evidenceDirectory)
		fail("image lock, release lock, runtime receipt, and evidence are required");
	const verified = await verifyProductionRuntime({
		imageLockPath,
		releaseLockPath,
		receiptPath,
		evidenceDirectory,
	});
	const output = `${JSON.stringify(verified, null, 2)}\n`;
	if (outputPath) {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(outputPath, output);
	}
	console.log(JSON.stringify(verified));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	await main(process.argv.slice(2));
