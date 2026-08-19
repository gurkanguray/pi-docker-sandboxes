#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

async function archiveIdentity(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return {
		name: basename(path),
		sha256: `sha256:${hash.digest("hex")}`,
		size: (await stat(path)).size,
	};
}

export async function finalizeRuntimeReceipt({
	receiptPath,
	archivePath,
	evidenceDirectory,
	sourceSha,
	variant,
}) {
	if (variant !== "standard")
		throw new Error("production publication is limited to standard runtime");
	const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
	const archive = await archiveIdentity(archivePath);
	if (
		receipt.variant !== variant ||
		receipt.sourceSha !== sourceSha ||
		archive.name !== "runtime.oci.tar" ||
		JSON.stringify(receipt.archive) !== JSON.stringify(archive) ||
		Object.keys(receipt.platformDigests ?? {}).length !== 2 ||
		Object.keys(receipt.platformConfigDigests ?? {}).length !== 2
	)
		throw new Error("runtime receipt identity is invalid");
	const evidenceNames = (await readdir(evidenceDirectory))
		.filter((name) => name.endsWith(".evidence.json"))
		.sort();
	if (evidenceNames.length !== 2)
		throw new Error("exactly two platform evidence receipts are required");
	const sbom = {};
	const scans = {};
	const seen = new Set();
	for (const name of evidenceNames) {
		const evidence = JSON.parse(
			await readFile(join(evidenceDirectory, name), "utf8"),
		);
		if (
			evidence.variant !== variant ||
			evidence.sourceSha !== sourceSha ||
			evidence.indexDigest !== receipt.indexDigest ||
			evidence.manifestDigest !== receipt.platformDigests[evidence.platform] ||
			evidence.configDigest !==
				receipt.platformConfigDigests[evidence.platform] ||
			seen.has(evidence.platform)
		)
			throw new Error(`platform evidence identity mismatch: ${name}`);
		seen.add(evidence.platform);
		for (const [kind, output] of [
			["sbom", sbom],
			["scan", scans],
		]) {
			const item = evidence[kind];
			const expectedName = `runtime-${variant}-${evidence.platform.slice(6)}.${
				kind === "sbom" ? "cdx.json" : "sarif"
			}`;
			if (basename(item?.name ?? "") !== expectedName)
				throw new Error(`${kind} evidence name mismatch: ${name}`);
			const bytes = await readFile(join(evidenceDirectory, expectedName));
			if (digest(bytes) !== item.sha256)
				throw new Error(`${kind} evidence digest mismatch: ${name}`);
			output[evidence.platform] = item;
		}
	}
	if (
		seen.size !== 2 ||
		!["linux/amd64", "linux/arm64"].every((platform) => seen.has(platform))
	)
		throw new Error("platform evidence set is incomplete");
	receipt.sbom = sbom;
	receipt.scans = scans;
	await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
	return receipt;
}

export async function main([
	receiptPath,
	archivePath,
	evidenceDirectory,
	sourceSha,
	variant,
]) {
	if (
		!receiptPath ||
		!archivePath ||
		!evidenceDirectory ||
		!sourceSha ||
		!variant
	)
		throw new Error(
			"receipt, archive, evidence directory, source SHA, and variant required",
		);
	await finalizeRuntimeReceipt({
		receiptPath,
		archivePath,
		evidenceDirectory,
		sourceSha,
		variant,
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	await main(process.argv.slice(2));
