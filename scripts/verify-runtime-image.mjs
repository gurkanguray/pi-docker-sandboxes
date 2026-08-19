#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const expectedPlatforms = ["linux/amd64", "linux/arm64"];
const skopeoImage =
	"quay.io/skopeo/stable@sha256:9c68e585103448f7e4abb835132ffe9759d7a962a0fa426035775956e7a1e021";

function parseArgs(argv) {
	const values = { receipt: "runtime-image-receipt.json", sbom: {}, scans: {} };
	for (let index = 0; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || !value)
			throw new Error(`invalid argument: ${key ?? ""}`);
		if (key === "--sbom" || key === "--scan") {
			const separator = value.indexOf("=");
			if (separator < 1) throw new Error(`${key} must be PLATFORM=PATH`);
			values[key === "--sbom" ? "sbom" : "scans"][value.slice(0, separator)] =
				value.slice(separator + 1);
		} else values[key.slice(2).replaceAll("-", "_")] = value;
	}
	for (const key of ["archive", "variant", "source_sha"])
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

async function readBlob(layout, digest) {
	if (!/^sha256:[0-9a-f]{64}$/.test(digest))
		throw new Error(`invalid OCI digest: ${digest}`);
	const bytes = await readFile(
		join(layout, "blobs", "sha256", digest.slice(7)),
	);
	if (sha256(bytes) !== digest)
		throw new Error(`OCI blob digest mismatch: ${digest}`);
	return bytes;
}

async function inspectArchive(archive, variant, sourceSha) {
	const layout = await mkdtemp(join(tmpdir(), "pi-runtime-oci-"));
	try {
		await run("tar", ["-xf", archive, "-C", layout]);
		const indexBytes = await readFile(join(layout, "index.json"));
		const archiveIndex = JSON.parse(indexBytes);
		let index = archiveIndex;
		let indexDigest = sha256(indexBytes);
		if (
			archiveIndex.manifests?.length === 1 &&
			archiveIndex.manifests[0].mediaType?.includes("image.index") &&
			!archiveIndex.manifests[0].platform
		) {
			const descriptor = archiveIndex.manifests[0];
			index = JSON.parse(await readBlob(layout, descriptor.digest));
			indexDigest = descriptor.digest;
		}
		const platformDigests = {};
		const attestationReferences = [];
		let labels;
		for (const descriptor of index.manifests ?? []) {
			const platform = `${descriptor.platform?.os}/${descriptor.platform?.architecture}`;
			if (!expectedPlatforms.includes(platform)) {
				if (
					platform === "unknown/unknown" &&
					descriptor.annotations?.["vnd.docker.reference.type"] ===
						"attestation-manifest"
				) {
					attestationReferences.push(
						descriptor.annotations["vnd.docker.reference.digest"],
					);
					continue;
				}
				throw new Error(`unsupported OCI platform: ${platform}`);
			}
			if (platformDigests[platform])
				throw new Error(`duplicate OCI manifest for ${platform}`);
			const manifest = JSON.parse(await readBlob(layout, descriptor.digest));
			const config = JSON.parse(await readBlob(layout, manifest.config.digest));
			const currentLabels = config.config?.Labels ?? {};
			const expectedLabels = {
				"org.opencontainers.image.source":
					"https://github.com/gurkanguray/pi-docker-sandboxes",
				"org.opencontainers.image.revision": sourceSha,
				"org.opencontainers.image.version": "runtime-1",
				"org.opencontainers.image.base.name":
					variant === "standard"
						? "docker/sandbox-templates@sha256:c183a8ba03cdb30011c73f555c773c5712b84c6ea066f18409253dcab2cfe799"
						: "docker/sandbox-templates@sha256:d86a6cdc105a1b299667a20c40bcf8d0584e56f21d44490a0737bb1baeb44299",
				"io.pi-docker-sandboxes.runtime-schema": "1",
				"io.pi-docker-sandboxes.pi-version": "0.84.1",
				"io.pi-docker-sandboxes.variant": variant,
			};
			for (const [name, value] of Object.entries(expectedLabels))
				if (currentLabels[name] !== value)
					throw new Error(`${platform} label ${name} is not ${value}`);
			if (config.config?.User !== "agent")
				throw new Error(`${platform} final user is not agent`);
			labels ??= currentLabels;
			platformDigests[platform] = descriptor.digest;
		}
		if (
			Object.keys(platformDigests).sort().join() !==
			expectedPlatforms.sort().join()
		)
			throw new Error(
				"archive must contain exactly linux/amd64 and linux/arm64 images",
			);
		for (const reference of attestationReferences)
			if (!Object.values(platformDigests).includes(reference))
				throw new Error(`attestation references unknown manifest: ${reference}`);
		return { indexDigest, platformDigests, labels };
	} finally {
		await rm(layout, { recursive: true, force: true });
	}
}

async function smokeArchive(archive, variant) {
	const absoluteArchive = resolve(archive);
	for (const platform of expectedPlatforms) {
		const arch = platform.slice("linux/".length);
		const tag = `pi-runtime-verify:${variant}-${arch}-${process.pid}`;
		console.log(`docker run smoke ${platform} from ${absoluteArchive}`);
		try {
			await run("docker", [
				"run",
				"--rm",
				"--volume",
				`${dirname(absoluteArchive)}:/work:ro`,
				"--volume",
				"/var/run/docker.sock:/var/run/docker.sock",
				skopeoImage,
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
				'test "$(pi --version)" = "0.84.1" && test "$(fd --version)" = "fd 10.3.0" && rg --version && git --version && test "$(id -u)" = 1000',
			]);
		} finally {
			await run("docker", ["image", "rm", "--force", tag]).catch(() => {});
		}
	}
}

const options = parseArgs(process.argv.slice(2));
const archive = resolve(options.archive);
const inspection = await inspectArchive(
	archive,
	options.variant,
	options.source_sha,
);
await smokeArchive(archive, options.variant);
const receipt = {
	schemaVersion: 1,
	sourceSha: options.source_sha,
	variant: options.variant,
	archive,
	...inspection,
	platforms: expectedPlatforms,
	sbom: options.sbom,
	scans: options.scans,
	verifiedAt: new Date().toISOString(),
};
await writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`, {
	flag: "wx",
});
console.log(
	`${options.variant} ${inspection.indexDigest} -> ${options.receipt}`,
);
