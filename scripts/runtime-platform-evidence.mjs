#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (bytes) =>
	`sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

function expectedIdentity(receipt, arch, sourceSha, variant) {
	const platform = `linux/${arch}`;
	const manifestDigest = receipt.platformDigests?.[platform];
	const configDigest = receipt.platformConfigDigests?.[platform];
	if (
		!new Set(["amd64", "arm64"]).has(arch) ||
		receipt.sourceSha !== sourceSha ||
		receipt.variant !== variant ||
		!digestPattern.test(manifestDigest ?? "") ||
		!digestPattern.test(configDigest ?? "")
	)
		throw new Error(`invalid verified runtime receipt for ${platform}`);
	return { platform, manifestDigest, configDigest };
}

async function readBlob(layout, value) {
	const bytes = await readFile(`${layout}/blobs/sha256/${value.slice(7)}`);
	if (digest(bytes) !== value) throw new Error(`OCI blob digest mismatch: ${value}`);
	return { bytes, value: JSON.parse(bytes) };
}

export async function selectRuntimePlatform({
	receiptPath,
	layoutPath,
	arch,
	selectorPath,
	sourceSha,
	variant,
}) {
	const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
	const expected = expectedIdentity(receipt, arch, sourceSha, variant);
	const outer = JSON.parse(await readFile(`${layoutPath}/index.json`, "utf8"));
	let index = outer;
	if (outer.manifests?.length === 1 && !outer.manifests[0].platform)
		index = (await readBlob(layoutPath, outer.manifests[0].digest)).value;
	const matches = (index.manifests ?? []).filter(
		(item) =>
			`${item.platform?.os}/${item.platform?.architecture}` ===
			expected.platform,
	);
	if (
		matches.length !== 1 ||
		matches[0].digest !== expected.manifestDigest
	)
		throw new Error(`verified manifest not found for ${expected.platform}`);
	const descriptor = matches[0];
	const manifestBlob = await readBlob(layoutPath, descriptor.digest);
	if (
		descriptor.size !== manifestBlob.bytes.length ||
		manifestBlob.value.config?.digest !== expected.configDigest
	)
		throw new Error(`verified manifest identity mismatch for ${expected.platform}`);
	const configBlob = await readBlob(layoutPath, expected.configDigest);
	if (
		manifestBlob.value.config.size !== configBlob.bytes.length ||
		configBlob.value.os !== "linux" ||
		configBlob.value.architecture !== arch
	)
		throw new Error(`verified config architecture mismatch for ${expected.platform}`);

	await rm(selectorPath, { recursive: true, force: true });
	await mkdir(selectorPath, { recursive: true });
	await symlink(
		relative(resolve(selectorPath), resolve(layoutPath, "blobs")),
		resolve(selectorPath, "blobs"),
	);
	await writeFile(
		resolve(selectorPath, "oci-layout"),
		'{"imageLayoutVersion":"1.0.0"}\n',
	);
	await writeFile(
		resolve(selectorPath, "index.json"),
		`${JSON.stringify({ schemaVersion: 2, manifests: [descriptor] })}\n`,
	);
	return expected;
}

export function validateRuntimePlatformExport({
	receipt,
	arch,
	sourceSha,
	variant,
	rawManifest,
	exportedConfig,
	configInspection,
	inspection,
	archiveName,
}) {
	const expected = expectedIdentity(receipt, arch, sourceSha, variant);
	const manifest = JSON.parse(rawManifest);
	const config = JSON.parse(exportedConfig);
	const exportManifestDigest = digest(rawManifest);
	if (
		manifest.mediaType !==
			"application/vnd.docker.distribution.manifest.v2+json" ||
		manifest.config?.digest !== expected.configDigest ||
		digest(exportedConfig) !== expected.configDigest
	)
		throw new Error(`exported manifest/config identity mismatch for ${expected.platform}`);
	if (
		config.os !== "linux" ||
		config.architecture !== arch ||
		configInspection.os !== "linux" ||
		configInspection.architecture !== arch ||
		inspection.Os !== "linux" ||
		inspection.Architecture !== arch ||
		inspection.Digest !== exportManifestDigest
	)
		throw new Error(`exported archive architecture mismatch for ${expected.platform}`);
	return { ...expected, exportManifestDigest, archiveName };
}

const imageIdProperty = (properties) =>
	properties?.find((item) => item.name === "aquasecurity:trivy:ImageID")?.value;

export function validatePlatformEvidenceDocuments({
	sarif,
	sbom,
	archiveName,
	platform,
	manifestDigest,
	configDigest,
}) {
	const run = sarif?.runs?.[0];
	if (
		sarif?.version !== "2.1.0" ||
		run?.properties?.imageID !== configDigest
	)
		throw new Error("Trivy SARIF config identity mismatch");
	if (basename(run.properties.imageName ?? "") !== archiveName)
		throw new Error("Trivy SARIF target mismatch");
	const component = sbom?.metadata?.component;
	if (imageIdProperty(component?.properties) !== configDigest)
		throw new Error("Trivy SBOM config identity mismatch");
	if (component?.type !== "container" || basename(component.name ?? "") !== archiveName)
		throw new Error("Trivy SBOM target mismatch");
	const binding = { platform, manifestDigest, configDigest };
	for (const [name, value] of Object.entries(binding))
		if (run.properties[name] !== undefined && run.properties[name] !== value)
			throw new Error(`Trivy SARIF ${name} binding mismatch`);
	Object.assign(run.properties, binding);
	for (const [name, value] of [
		["io.pi-docker-sandboxes.platform", platform],
		["io.pi-docker-sandboxes.manifest-digest", manifestDigest],
		["io.pi-docker-sandboxes.config-digest", configDigest],
	]) {
		const matches = component.properties.filter((item) => item.name === name);
		if (matches.some((item) => item.value !== value))
			throw new Error(`Trivy SBOM ${name} binding mismatch`);
		if (matches.length === 0) component.properties.push({ name, value });
	}
	return { sarif, sbom };
}

export async function bindRuntimePlatformEvidence({
	receiptPath,
	inspectionPath,
	scanPath,
	sbomPath,
	arch,
	sourceSha,
	variant,
	evidencePath,
}) {
	const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
	const inspection = JSON.parse(await readFile(inspectionPath, "utf8"));
	const expected = expectedIdentity(receipt, arch, sourceSha, variant);
	if (
		inspection.platform !== expected.platform ||
		inspection.manifestDigest !== expected.manifestDigest ||
		inspection.configDigest !== expected.configDigest ||
		!digestPattern.test(inspection.exportManifestDigest ?? "") ||
		basename(inspection.archiveName ?? "") !== inspection.archiveName
	)
		throw new Error("platform export inspection identity mismatch");
	const bound = validatePlatformEvidenceDocuments({
		sarif: JSON.parse(await readFile(scanPath, "utf8")),
		sbom: JSON.parse(await readFile(sbomPath, "utf8")),
		archiveName: inspection.archiveName,
		...expected,
	});
	await writeFile(scanPath, `${JSON.stringify(bound.sarif, null, 2)}\n`);
	await writeFile(sbomPath, `${JSON.stringify(bound.sbom, null, 2)}\n`);
	const evidence = {
		variant,
		sourceSha,
		indexDigest: receipt.indexDigest,
		...expected,
		exportManifestDigest: inspection.exportManifestDigest,
		archiveName: inspection.archiveName,
		scan: { name: basename(scanPath), sha256: digest(await readFile(scanPath)) },
		sbom: { name: basename(sbomPath), sha256: digest(await readFile(sbomPath)) },
	};
	await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
	return evidence;
}

export async function main([command, ...args]) {
	if (command === "select" && args.length === 6)
		return selectRuntimePlatform({
			receiptPath: args[0],
			layoutPath: args[1],
			arch: args[2],
			selectorPath: args[3],
			sourceSha: args[4],
			variant: args[5],
		});
	if (command === "verify-export" && args.length === 10) {
		const receipt = JSON.parse(await readFile(args[0], "utf8"));
		const expected = expectedIdentity(receipt, args[1], args[7], args[8]);
		const identity = validateRuntimePlatformExport({
			receipt,
			arch: args[1],
			rawManifest: await readFile(args[2]),
			configInspection: JSON.parse(await readFile(args[3], "utf8")),
			inspection: JSON.parse(await readFile(args[4], "utf8")),
			exportedConfig: await readFile(
				`${args[5]}/${expected.configDigest.slice(7)}.json`,
			),
			archiveName: args[6],
			sourceSha: args[7],
			variant: args[8],
		});
		await writeFile(args[9], `${JSON.stringify(identity, null, 2)}\n`);
		return identity;
	}
	if (command === "bind" && args.length === 8)
		return bindRuntimePlatformEvidence({
			receiptPath: args[0],
			inspectionPath: args[1],
			scanPath: args[2],
			sbomPath: args[3],
			arch: args[4],
			sourceSha: args[5],
			variant: args[6],
			evidencePath: args[7],
		});
	throw new Error(`invalid runtime platform evidence command: ${command ?? ""}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	await main(process.argv.slice(2));
