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
const {
	readDescriptor,
	validateAttestationCoverage,
	validateAttestationManifest,
	validatePlatformDescriptors,
} = verifierModule;

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
	assert.match(
		lock.build.qemu,
		/^tonistiigi\/binfmt:qemu-v\d+\.\d+\.\d+(?:-\d+)?@sha256:[0-9a-f]{64}$/,
	);
	assert.doesNotMatch(lock.build.qemu, /:latest(?:@|$)/);
	const dockerfile = await readFile("docker/runtime.Dockerfile", "utf8");
	assert.equal(
		dockerfile.split("\n")[0],
		`# syntax=${lock.build.dockerfileFrontend}`,
	);
	for (const name of Object.keys(args))
		assert.match(dockerfile, new RegExp(`ARG ${name}`));
	assert.doesNotMatch(dockerfile, /0\.84\.1|10\.3\.0/);
	assert.match(
		dockerfile,
		/FROM \$\{STANDARD_BASE\} AS standard\nARG STANDARD_BASE/,
	);
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

test("runtime lock rejects omitted and mutable QEMU pins", async () => {
	const directory = await mkdtemp(join(tmpdir(), "runtime-qemu-lock-"));
	try {
		const source = JSON.parse(await readFile("docker/runtime-lock.json", "utf8"));
		for (const qemu of [
			undefined,
			`tonistiigi/binfmt:latest@sha256:${"a".repeat(64)}`,
		]) {
			const path = join(directory, `lock-${qemu ? "mutable" : "missing"}.json`);
			const lock = structuredClone(source);
			if (qemu) lock.build.qemu = qemu;
			else delete lock.build.qemu;
			await writeFile(path, JSON.stringify(lock));
			await assert.rejects(
				loadRuntimeLock(path),
				/stable digest-pinned tag|must be digest-pinned/,
			);
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
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
			verifyRuntimeEnvironment({ ...environment, protection_rules: [] }, policies),
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

test("attestations bind actual BuildKit mode=max SLSA v1 provenance", () => {
	const sourceSha = "c".repeat(40);
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
		subject: [] as unknown[],
		predicate: {
			buildDefinition: {
				buildType:
					"https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
				resolvedDependencies: [
					{
						uri: "pkg:docker/docker/dockerfile@1.7",
						digest: { sha256: "d".repeat(64) },
					},
				],
				externalParameters: {
					configSource: { path: "runtime.Dockerfile" },
					request: {
						args: {
							"build-arg:SOURCE_SHA": sourceSha,
							target: "standard",
						},
					},
				},
			},
			runDetails: {
				builder: { id: "" },
				metadata: {
					invocationId: "buildkit-invocation",
					startedOn: "2026-08-19T05:28:26.371221794Z",
					finishedOn: "2026-08-19T05:28:42.505743325Z",
				},
			},
		},
	};
	const validate = (candidate: unknown = statement) =>
		validateAttestationManifest(
			descriptor,
			manifest,
			[candidate],
			new Map([[digestA, platform]]),
			sourceSha,
			"standard",
		);

	assert.doesNotThrow(() => validate());
	assert.doesNotThrow(() => validate({ ...statement, subject: [] }));
	assert.doesNotThrow(() =>
		validate({
			...statement,
			subject: [{ digest: { sha256: digestA.slice(7) } }],
		}),
	);
	const alternateDigest: any = structuredClone(statement);
	alternateDigest.predicate.buildDefinition.resolvedDependencies[0].digest = {
		sha512: "e".repeat(128),
	};
	assert.doesNotThrow(() => validate(alternateDigest));
	assert.throws(
		() =>
			validateAttestationManifest(
				descriptor,
				{ ...manifest, subject: { ...platform, digest: digestB } },
				[statement],
				new Map([[digestA, platform]]),
				sourceSha,
				"standard",
			),
		/subject/,
	);

	const wrongSource = structuredClone(statement);
	wrongSource.predicate.buildDefinition.externalParameters.request.args[
		"build-arg:SOURCE_SHA"
	] = "e".repeat(40);
	const wrongVariant = structuredClone(statement);
	wrongVariant.predicate.buildDefinition.externalParameters.request.args.target =
		"docker";
	const missingDependency = structuredClone(statement);
	missingDependency.predicate.buildDefinition.resolvedDependencies = [];
	const invalidDependencies = [
		null,
		[],
		{},
		{ uri: "", digest: { sha256: "d".repeat(64) } },
		{ uri: " ", digest: { sha256: "d".repeat(64) } },
		{ uri: "pkg:test", digest: null },
		{ uri: "pkg:test", digest: [] },
		{ uri: "pkg:test", digest: {} },
		{ uri: "pkg:test", digest: { sha256: "D".repeat(64) } },
		{ uri: "pkg:test", digest: { sha256: "d".repeat(63) } },
		{ uri: "pkg:test", digest: { sha512: "not-hex" } },
		{
			uri: "pkg:test",
			digest: { sha256: "d".repeat(64), sha512: "not-hex" },
		},
	];
	const invalidTimestamps = [
		["", "2026-08-19T05:28:42Z"],
		["2026-08-19 05:28:26Z", "2026-08-19T05:28:42Z"],
		["2026-08-19T05:28:26+00:00", "2026-08-19T05:28:42Z"],
		["2026-08-19T05:28:26z", "2026-08-19T05:28:42Z"],
		["2026-02-30T05:28:26Z", "2026-03-02T05:28:42Z"],
		["2026-08-19T05:28:26.1234567890Z", "2026-08-19T05:28:42Z"],
		["2026-08-19T05:28:43Z", "2026-08-19T05:28:42Z"],
		["2026-08-19T05:28:26.000000009Z", "2026-08-19T05:28:26.000000001Z"],
	];
	const cases: Array<[string, unknown]> = [
		["missing predicate", { ...statement, predicate: undefined }],
		[
			"missing build definition",
			{
				...statement,
				predicate: { ...statement.predicate, buildDefinition: undefined },
			},
		],
		[
			"missing run details",
			{
				...statement,
				predicate: { ...statement.predicate, runDetails: undefined },
			},
		],
		["wrong source", wrongSource],
		["wrong variant", wrongVariant],
		["missing dependency", missingDependency],
		...invalidDependencies.map((dependency, index) => {
			const candidate: any = structuredClone(statement);
			candidate.predicate.buildDefinition.resolvedDependencies = [dependency];
			return [`invalid dependency ${index}`, candidate] as [string, unknown];
		}),
		...invalidTimestamps.map(([startedOn, finishedOn], index) => {
			const candidate = structuredClone(statement);
			candidate.predicate.runDetails.metadata.startedOn = startedOn;
			candidate.predicate.runDetails.metadata.finishedOn = finishedOn;
			return [`invalid timestamps ${index}`, candidate] as [string, unknown];
		}),
	];
	for (const [name, candidate] of cases)
		assert.throws(() => validate(candidate), /provenance/, name);

	for (const invalidStatement of [
		{ ...statement, _type: "bad" },
		{ ...statement, predicateType: "https://slsa.dev/provenance/v0.2" },
		{ ...statement, subject: undefined },
		{
			...statement,
			subject: [{ digest: { sha256: digestB.slice(7) } }],
		},
	])
		assert.throws(() => validate(invalidStatement), /attestation|subject/);
});

test("required platform manifests have distinct digests", () => {
	const descriptors = [
		{ platform: { os: "linux", architecture: "amd64" }, digest: digestA },
		{ platform: { os: "linux", architecture: "arm64" }, digest: digestB },
	];
	assert.deepEqual(
		validatePlatformDescriptors(descriptors, ["linux/amd64", "linux/arm64"]),
		descriptors,
	);
	assert.throws(
		() =>
			validatePlatformDescriptors(
				[descriptors[0], { ...descriptors[1], digest: digestA }],
				["linux/amd64", "linux/arm64"],
			),
		/duplicate OCI platform manifest digest/,
	);
});

test("exactly one attestation manifest targets each required platform", () => {
	const platforms = new Map([
		[digestA, { digest: digestA }],
		[digestB, { digest: digestB }],
	]);
	assert.doesNotThrow(() =>
		validateAttestationCoverage([digestA, digestB], platforms),
	);
	for (const [name, references] of [
		["no targets", []],
		["missing target", [digestA]],
		["duplicate target", [digestA, digestA]],
		["unexpected target", [digestA, digestB, `sha256:${"f".repeat(64)}`]],
	] as Array<[string, string[]]>)
		assert.throws(
			() => validateAttestationCoverage(references, platforms),
			/exactly one attestation manifest/,
			name,
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
			await writeFile(join(directory, `runtime-standard-${arch}.cdx.json`), sbom);
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
		await writeFile(join(directory, "runtime-standard-amd64.sarif"), "tampered");
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
