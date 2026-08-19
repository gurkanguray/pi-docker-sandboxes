import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
// @ts-expect-error executable script module has no declaration file
import { finalizeRuntimeReceipt } from "../scripts/finalize-runtime-receipt.mjs";
// @ts-expect-error executable script module has no declaration file
import { loadRuntimeLock, runtimeBuildArgs } from "../scripts/runtime-lock.mjs";
// @ts-expect-error executable script module has no declaration file
import { verifyRuntimeEnvironment } from "../scripts/verify-runtime-environment.mjs";
// @ts-expect-error executable script module has no declaration file
const verifierModule = await import("../scripts/verify-runtime-image.mjs");
const { readDescriptor, validateAttestationManifest } = verifierModule;

const sha = (value: string) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;

test("runtime lock is authoritative and every registry tarball has integrity", async () => {
	const lock = await loadRuntimeLock("docker/runtime-lock.json");
	const args = runtimeBuildArgs(lock);
	assert.equal(args.PI_VERSION, lock.piVersion);
	assert.equal(args.STANDARD_BASE, lock.bases.standard);
	assert.match(lock.build.dockerfileFrontend, /@sha256:[0-9a-f]{64}$/);
	assert.match(lock.build.buildkitDriver, /:v?\d+\.\d+\.\d+@sha256:/);
	const dockerfile = await readFile("docker/Dockerfile", "utf8");
	assert.equal(
		dockerfile.split("\n")[0],
		`# syntax=${lock.build.dockerfileFrontend}`,
	);
	for (const name of Object.keys(args))
		assert.match(dockerfile, new RegExp(`ARG ${name}`));
	assert.doesNotMatch(dockerfile, /0\.84\.1|10\.3\.0/);
	assert.match(dockerfile, /FROM \$\{STANDARD_BASE\} AS standard\nARG STANDARD_BASE/);
	assert.match(dockerfile, /FROM \$\{DOCKER_BASE\} AS docker\nARG DOCKER_BASE/);
	const packageLock = JSON.parse(
		await readFile("docker/runtime-package-lock.json", "utf8"),
	);
	for (const [path, pkg] of Object.entries(packageLock.packages) as Array<
		[string, { resolved?: string; integrity?: string }]
	>)
		if (pkg.resolved?.startsWith("https://registry.npmjs.org/"))
			assert.match(pkg.integrity ?? "", /^sha512-/, path);
});

test("release-runtime protection fails closed", () => {
	const environment = {
		protection_rules: [{ type: "required_reviewers", reviewers: [{ id: 1 }] }],
		deployment_branch_policy: { custom_branch_policies: true },
	};
	const policies = { branch_policies: [{ name: "main" }, { name: "v*" }] };
	assert.equal(verifyRuntimeEnvironment(environment, policies), true);
	assert.throws(
		() =>
			verifyRuntimeEnvironment(
				{ ...environment, protection_rules: [] },
				policies,
			),
		/reviewer/,
	);
	assert.throws(
		() =>
			verifyRuntimeEnvironment(environment, {
				branch_policies: [{ name: "main" }],
			}),
		/main and v\*/,
	);
});

test("OCI descriptor digest, size, and media type fail closed", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-descriptor-"));
	try {
		const bytes = Buffer.from('{"ok":true}');
		const valueDigest = sha(bytes.toString());
		const blobDirectory = join(directory, "blobs", "sha256");
		await import("node:fs/promises").then(({ mkdir }) =>
			mkdir(blobDirectory, { recursive: true }),
		);
		await writeFile(join(blobDirectory, valueDigest.slice(7)), bytes);
		await writeFile(join(blobDirectory, digestA.slice(7)), bytes);
		const descriptor = {
			mediaType: "application/test+json",
			digest: valueDigest,
			size: bytes.length,
		};
		await assert.doesNotReject(
			readDescriptor(directory, descriptor, "application/test+json"),
		);
		await assert.rejects(
			readDescriptor(
				directory,
				{ ...descriptor, size: 1 },
				"application/test+json",
			),
			/size mismatch/,
		);
		await assert.rejects(
			readDescriptor(directory, descriptor, "application/other+json"),
			/media type/,
		);
		await assert.rejects(
			readDescriptor(
				directory,
				{ ...descriptor, digest: digestA },
				"application/test+json",
			),
			/digest mismatch/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("attestations bind descriptor, manifest, and statement subjects", () => {
	const platform = {
		digest: digestA,
		size: 42,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
	};
	const descriptor = {
		platform: { os: "unknown", architecture: "unknown" },
		annotations: {
			"vnd.docker.reference.type": "attestation-manifest",
			"vnd.docker.reference.digest": digestA,
		},
	};
	const manifest = {
		schemaVersion: 2,
		mediaType: "application/vnd.oci.image.manifest.v1+json",
		artifactType: "application/vnd.docker.attestation.manifest.v1+json",
		subject: platform,
	};
	const statement = {
		_type: "https://in-toto.io/Statement/v1",
		predicateType: "https://slsa.dev/provenance/v1",
		subject: [{ digest: { sha256: digestA.slice(7) } }],
	};
	assert.doesNotThrow(() =>
		validateAttestationManifest(
			descriptor,
			manifest,
			[statement],
			new Map([[digestA, platform]]),
		),
	);
	assert.throws(
		() =>
			validateAttestationManifest(
				descriptor,
				{ ...manifest, subject: { ...platform, digest: digestB } },
				[statement],
				new Map([[digestA, platform]]),
			),
		/subject/,
	);
	assert.throws(
		() =>
			validateAttestationManifest(
				descriptor,
				manifest,
				[{ ...statement, _type: "bad" }],
				new Map([[digestA, platform]]),
			),
		/malformed/,
	);
});

test("final receipt rejects incomplete, mismatched, and tampered evidence", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-evidence-"));
	try {
		const receiptPath = join(directory, "receipt.json");
		const archivePath = join(directory, "runtime.oci.tar");
		const archiveBytes = "archive";
		await writeFile(archivePath, archiveBytes);
		const receipt = {
			variant: "standard",
			sourceSha: "c".repeat(40),
			archive: {
				name: "runtime.oci.tar",
				sha256: sha(archiveBytes),
				size: archiveBytes.length,
			},
			indexDigest: digestA,
			platformDigests: { "linux/amd64": digestA, "linux/arm64": digestB },
		};
		await writeFile(receiptPath, JSON.stringify(receipt));
		for (const [arch, platformDigest] of [
			["amd64", digestA],
			["arm64", digestB],
		]) {
			const scan = `scan-${arch}`;
			const sbom = `sbom-${arch}`;
			await writeFile(join(directory, `runtime-standard-${arch}.sarif`), scan);
			await writeFile(
				join(directory, `runtime-standard-${arch}.cdx.json`),
				sbom,
			);
			await writeFile(
				join(directory, `runtime-standard-${arch}.evidence.json`),
				JSON.stringify({
					variant: "standard",
					sourceSha: receipt.sourceSha,
					indexDigest: digestA,
					platform: `linux/${arch}`,
					platformDigest,
					scan: { name: `runtime-standard-${arch}.sarif`, sha256: sha(scan) },
					sbom: {
						name: `runtime-standard-${arch}.cdx.json`,
						sha256: sha(sbom),
					},
				}),
			);
		}
		await finalizeRuntimeReceipt({
			receiptPath,
			archivePath,
			evidenceDirectory: directory,
			sourceSha: receipt.sourceSha,
			variant: "standard",
		});
		await writeFile(archivePath, "tampered-archive");
		await assert.rejects(
			finalizeRuntimeReceipt({
				receiptPath,
				archivePath,
				evidenceDirectory: directory,
				sourceSha: receipt.sourceSha,
				variant: "standard",
			}),
			/receipt identity/,
		);
		await writeFile(archivePath, archiveBytes);
		await writeFile(
			join(directory, "runtime-standard-amd64.sarif"),
			"tampered",
		);
		await writeFile(
			join(directory, "runtime-standard-amd64.cdx.json"),
			"sbom-amd64",
		);
		await assert.rejects(
			finalizeRuntimeReceipt({
				receiptPath,
				archivePath,
				evidenceDirectory: directory,
				sourceSha: receipt.sourceSha,
				variant: "standard",
			}),
			/digest mismatch/,
		);
		await assert.rejects(
			finalizeRuntimeReceipt({
				receiptPath,
				archivePath,
				evidenceDirectory: directory,
				sourceSha: receipt.sourceSha,
				variant: "docker",
			}),
			/limited to standard/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
