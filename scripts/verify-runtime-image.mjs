#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadRuntimeLock } from "./runtime-lock.mjs";

const imageIndexMediaType = "application/vnd.oci.image.index.v1+json";
const imageManifestMediaType = "application/vnd.oci.image.manifest.v1+json";
const inTotoMediaType = "application/vnd.in-toto+json";
const buildKitBuildType =
	"https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md";
const isObject = (value) =>
	value !== null && typeof value === "object" && !Array.isArray(value);

function isResolvedDependency(dependency) {
	if (
		!isObject(dependency) ||
		typeof dependency.uri !== "string" ||
		dependency.uri.trim().length === 0 ||
		!isObject(dependency.digest)
	)
		return false;
	const digests = Object.entries(dependency.digest);
	return (
		digests.length > 0 &&
		digests.every(
			([algorithm, digest]) =>
				algorithm.length > 0 &&
				typeof digest === "string" &&
				/^(?:[0-9a-f]{2})+$/.test(digest) &&
				(algorithm !== "sha256" || digest.length === 64),
		)
	);
}

function parseUtcRfc3339(value) {
	if (typeof value !== "string") return null;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(
			value,
		);
	if (!match || !Number.isFinite(Date.parse(value))) return null;
	const wholeSecond = `${value.slice(0, 19)}Z`;
	const milliseconds = Date.parse(wholeSecond);
	if (
		!Number.isFinite(milliseconds) ||
		new Date(milliseconds).toISOString().slice(0, 19) !== value.slice(0, 19)
	)
		return null;
	const fraction = (match[7] ?? "").padEnd(9, "0");
	return BigInt(milliseconds) * 1_000_000n + BigInt(fraction || "0");
}

function parseArgs(argv) {
	const values = { receipt: "runtime-image-receipt.json" };
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || !value)
			throw new Error(`invalid argument: ${key ?? ""}`);
		values[key.slice(2).replaceAll("-", "_")] = value;
	}
	for (const key of ["archive", "variant", "source_sha", "lock"])
		if (!values[key])
			throw new Error(`--${key.replaceAll("_", "-")} is required`);
	if (!new Set(["standard", "docker"]).has(values.variant))
		throw new Error("--variant must be standard or docker");
	if (!/^[0-9a-f]{40}$/.test(values.source_sha))
		throw new Error("--source-sha must be a full lowercase Git SHA");
	return values;
}

async function run(command, args, options = {}) {
	await new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { stdio: "inherit", ...options });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolvePromise();
			else reject(new Error(`${command} failed (${signal ?? code})`));
		});
	});
}

const sha256 = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

export async function readDescriptor(layout, descriptor, mediaType) {
	if (descriptor?.mediaType !== mediaType)
		throw new Error(`unexpected OCI media type: ${descriptor?.mediaType}`);
	if (!/^sha256:[0-9a-f]{64}$/.test(descriptor.digest))
		throw new Error(`invalid OCI digest: ${descriptor.digest}`);
	const bytes = await readFile(
		join(layout, "blobs", "sha256", descriptor.digest.slice(7)),
	);
	if (bytes.length !== descriptor.size)
		throw new Error(`OCI blob size mismatch: ${descriptor.digest}`);
	if (sha256(bytes) !== descriptor.digest)
		throw new Error(`OCI blob digest mismatch: ${descriptor.digest}`);
	try {
		return { bytes, value: JSON.parse(bytes) };
	} catch (error) {
		throw new Error(`OCI blob is not valid JSON: ${descriptor.digest}`, {
			cause: error,
		});
	}
}

export function validateAttestationManifest(
	descriptor,
	manifest,
	statements,
	platformDescriptors,
	sourceSha,
	variant,
) {
	const reference = descriptor.annotations?.["vnd.docker.reference.digest"];
	const subject = manifest.subject;
	const platform = platformDescriptors.get(reference);
	if (
		descriptor.platform?.os !== "unknown" ||
		descriptor.platform?.architecture !== "unknown" ||
		descriptor.annotations?.["vnd.docker.reference.type"] !==
			"attestation-manifest" ||
		manifest.schemaVersion !== 2 ||
		manifest.mediaType !== imageManifestMediaType ||
		manifest.artifactType !==
			"application/vnd.docker.attestation.manifest.v1+json" ||
		!platform ||
		subject?.digest !== platform.digest ||
		subject?.size !== platform.size ||
		subject?.mediaType !== imageManifestMediaType
	)
		throw new Error(
			"attestation subject does not match a verified platform manifest",
		);
	if (!statements.length) throw new Error("attestation statement is required");
	for (const statement of statements) {
		if (
			statement?._type !== "https://in-toto.io/Statement/v1" ||
			statement.predicateType !== "https://slsa.dev/provenance/v1" ||
			!Array.isArray(statement.subject)
		)
			throw new Error("malformed in-toto attestation statement");
		if (statement.subject.length > 1)
			throw new Error("in-toto subject does not match its platform manifest");
		for (const statementSubject of statement.subject) {
			const digest = statementSubject.digest?.sha256;
			if (
				!/^[0-9a-f]{64}$/.test(digest ?? "") ||
				`sha256:${digest}` !== platform.digest
			)
				throw new Error("in-toto subject does not match its platform manifest");
		}

		const predicate = statement.predicate;
		const build = predicate?.buildDefinition;
		const external = build?.externalParameters;
		const args = external?.request?.args;
		const runDetails = predicate?.runDetails;
		const metadata = runDetails?.metadata;
		const startedOn = parseUtcRfc3339(metadata?.startedOn);
		const finishedOn = parseUtcRfc3339(metadata?.finishedOn);
		if (
			!isObject(predicate) ||
			!isObject(build) ||
			build.buildType !== buildKitBuildType ||
			!Array.isArray(build.resolvedDependencies) ||
			build.resolvedDependencies.length === 0 ||
			!build.resolvedDependencies.every(isResolvedDependency) ||
			!isObject(external) ||
			!isObject(external.configSource) ||
			external.configSource.path !== "runtime.Dockerfile" ||
			!isObject(external.request) ||
			!isObject(args) ||
			args.target !== variant ||
			args["build-arg:SOURCE_SHA"] !== sourceSha ||
			!isObject(runDetails) ||
			!isObject(runDetails.builder) ||
			typeof runDetails.builder.id !== "string" ||
			!isObject(metadata) ||
			typeof metadata.invocationId !== "string" ||
			metadata.invocationId.length === 0 ||
			startedOn === null ||
			finishedOn === null ||
			finishedOn < startedOn
		)
			throw new Error("malformed BuildKit SLSA v1 provenance predicate");
	}
}

export function validateAttestationCoverage(references, platformDescriptors) {
	if (
		references.length !== platformDescriptors.size ||
		new Set(references).size !== platformDescriptors.size ||
		references.some((reference) => !platformDescriptors.has(reference))
	)
		throw new Error(
			"exactly one attestation manifest is required per verified platform",
		);
}

export function validatePlatformDescriptors(descriptors, expectedPlatforms) {
	const expected = new Set(expectedPlatforms);
	const byPlatform = new Map();
	const digests = new Set();
	for (const descriptor of descriptors) {
		const platform = `${descriptor.platform?.os}/${descriptor.platform?.architecture}`;
		if (!expected.has(platform)) continue;
		if (byPlatform.has(platform))
			throw new Error(`duplicate OCI manifest for ${platform}`);
		if (digests.has(descriptor.digest))
			throw new Error(
				`duplicate OCI platform manifest digest: ${descriptor.digest}`,
			);
		byPlatform.set(platform, descriptor);
		digests.add(descriptor.digest);
	}
	if (byPlatform.size !== expected.size)
		throw new Error("archive does not contain the locked runtime platforms");
	return [...byPlatform.values()];
}

async function archiveIdentity(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return {
		name: "runtime.oci.tar",
		sha256: `sha256:${hash.digest("hex")}`,
		size: (await stat(path)).size,
	};
}

export async function inspectArchive(archive, variant, sourceSha, lock) {
	const expectedPlatforms = lock.platforms;
	const layout = await mkdtemp(join(tmpdir(), "pi-runtime-oci-"));
	try {
		await run("tar", ["-xf", archive, "-C", layout]);
		const indexBytes = await readFile(join(layout, "index.json"));
		const archiveIndex = JSON.parse(indexBytes);
		let index = archiveIndex;
		let indexDigest = sha256(indexBytes);
		if (
			archiveIndex.manifests?.length === 1 &&
			!archiveIndex.manifests[0].platform
		) {
			const descriptor = archiveIndex.manifests[0];
			({ value: index } = await readDescriptor(
				layout,
				descriptor,
				imageIndexMediaType,
			));
			indexDigest = descriptor.digest;
		}
		const platformDigests = {};
		const platformDescriptors = new Map();
		let labels;
		const requiredDescriptors = validatePlatformDescriptors(
			index.manifests ?? [],
			expectedPlatforms,
		);
		for (const descriptor of requiredDescriptors) {
			const platform = `${descriptor.platform.os}/${descriptor.platform.architecture}`;
			const { value: manifest } = await readDescriptor(
				layout,
				descriptor,
				imageManifestMediaType,
			);
			const { value: config } = await readDescriptor(
				layout,
				manifest.config,
				"application/vnd.oci.image.config.v1+json",
			);
			const currentLabels = config.config?.Labels ?? {};
			const expectedLabels = {
				"org.opencontainers.image.source":
					"https://github.com/gurkanguray/pi-docker-sandboxes",
				"org.opencontainers.image.revision": sourceSha,
				"org.opencontainers.image.version": lock.runtimeVersion,
				"org.opencontainers.image.base.name": lock.bases[variant],
				"io.pi-docker-sandboxes.runtime-schema": String(lock.runtimeSchema),
				"io.pi-docker-sandboxes.pi-version": lock.piVersion,
				"io.pi-docker-sandboxes.variant": variant,
			};
			for (const [name, value] of Object.entries(expectedLabels))
				if (currentLabels[name] !== value)
					throw new Error(`${platform} label ${name} is not ${value}`);
			if (config.config?.User !== "agent")
				throw new Error(`${platform} final user is not agent`);
			labels ??= currentLabels;
			platformDigests[platform] = descriptor.digest;
			platformDescriptors.set(descriptor.digest, descriptor);
		}
		const attestationReferences = [];
		for (const descriptor of index.manifests ?? []) {
			const platform = `${descriptor.platform?.os}/${descriptor.platform?.architecture}`;
			if (expectedPlatforms.includes(platform)) continue;
			const { value: manifest } = await readDescriptor(
				layout,
				descriptor,
				imageManifestMediaType,
			);
			await readDescriptor(
				layout,
				manifest.config,
				"application/vnd.oci.empty.v1+json",
			);
			const statements = [];
			for (const layer of manifest.layers ?? []) {
				const { value } = await readDescriptor(layout, layer, inTotoMediaType);
				statements.push(value);
			}
			validateAttestationManifest(
				descriptor,
				manifest,
				statements,
				platformDescriptors,
				sourceSha,
				variant,
			);
			attestationReferences.push(
				descriptor.annotations["vnd.docker.reference.digest"],
			);
		}
		validateAttestationCoverage(attestationReferences, platformDescriptors);
		return { indexDigest, platformDigests, labels };
	} finally {
		await rm(layout, { recursive: true, force: true });
	}
}

async function smokeArchive(archive, variant, lock) {
	const absoluteArchive = resolve(archive);
	for (const platform of lock.platforms) {
		const arch = platform.slice("linux/".length);
		const tag = `pi-runtime-verify:${variant}-${arch}-${process.pid}`;
		try {
			await run("docker", [
				"run",
				"--rm",
				"--volume",
				`${dirname(absoluteArchive)}:/work:ro`,
				"--volume",
				"/var/run/docker.sock:/var/run/docker.sock",
				lock.build.skopeo,
				"copy",
				"--override-os",
				"linux",
				"--override-arch",
				arch,
				`oci-archive:/work/${basename(absoluteArchive)}`,
				`docker-daemon:${tag}`,
			]);
			await run("docker", [
				"run",
				"--rm",
				"--platform",
				platform,
				tag,
				"sh",
				"-lc",
				`test "$(pi --version)" = "${lock.piVersion}" && test "$(fd --version)" = "fd ${lock.tools.fd.version}" && rg --version && git --version && test "$(id -u)" = 1000${variant === "standard" ? " && test ! -e /usr/libexec/docker/cli-plugins/docker-buildx" : ""}`,
			]);
		} finally {
			await run("docker", ["image", "rm", "--force", tag]).catch(() => {});
		}
	}
}

export async function main(argv) {
	const options = parseArgs(argv);
	const lock = await loadRuntimeLock(options.lock);
	const archive = resolve(options.archive);
	const inspection = await inspectArchive(
		archive,
		options.variant,
		options.source_sha,
		lock,
	);
	await smokeArchive(archive, options.variant, lock);
	const receipt = {
		schemaVersion: 1,
		sourceSha: options.source_sha,
		variant: options.variant,
		archive: await archiveIdentity(archive),
		...inspection,
		platforms: lock.platforms,
		buildPins: lock.build,
		sbom: {},
		scans: {},
		verifiedAt: new Date().toISOString(),
	};
	await writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, {
		flag: "wx",
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url))
	await main(process.argv.slice(2));
