import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertDigestReference,
	loadImageLock,
	parseImageLock,
} from "../src/image-lock.ts";

const packageJson = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as {
	version: string;
	devDependencies: Record<string, string>;
};
const packageLock = JSON.parse(
	await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
) as {
	packages: Record<
		string,
		{ version?: string; devDependencies?: Record<string, string> }
	>;
};
const digest = "a".repeat(64);
const validLock = {
	packageVersion: "0.1.0",
	piVersion: "0.84.1",
	platform: "linux/arm64",
	baseImage: `docker/sandbox-templates@sha256:${digest}`,
	localImage: "docker.io/pi-docker-sandboxes/pi:0.1.0",
	tools: {
		fdDebianVersion: "10.3.0-2ubuntu1",
		rgDebianVersion: "15.1.0-1ubuntu1",
		gitDebianVersion: "1:2.53.0-1ubuntu1",
	},
};

test("validates digest-pinned image references", () => {
	assert.equal(
		assertDigestReference(
			`ghcr.io/gurkanguray/pi-docker-sandboxes@sha256:${digest}`,
			"publishedImage",
		).includes("@sha256:"),
		true,
	);
	assert.throws(
		() => assertDigestReference("docker/sandbox-templates:shell", "baseImage"),
		/digest/,
	);
});

test("strictly requires every lock field", () => {
	assert.deepEqual(parseImageLock(validLock), validLock);
	for (const field of [
		"packageVersion",
		"piVersion",
		"platform",
		"baseImage",
		"localImage",
		"tools",
	] as const) {
		const lock: Record<string, unknown> = structuredClone(validLock);
		delete lock[field];
		assert.throws(() => parseImageLock(lock), new RegExp(field), field);
	}
	for (const field of [
		"fdDebianVersion",
		"rgDebianVersion",
		"gitDebianVersion",
	] as const) {
		const lock = structuredClone(validLock);
		delete lock.tools[field];
		assert.throws(
			() => parseImageLock(lock),
			new RegExp(`tools\\.${field}`),
			field,
		);
	}
});

test("strictly rejects invalid and unknown lock fields", () => {
	assert.throws(() => parseImageLock({ ...validLock, extra: true }), /unknown/);
	assert.throws(
		() =>
			parseImageLock({
				...validLock,
				tools: { ...validLock.tools, extra: true },
			}),
		/tools has unknown field extra/,
	);
	assert.throws(
		() => parseImageLock({ ...validLock, platform: "linux/amd64" }),
		/linux\/arm64/,
	);
	assert.throws(
		() => parseImageLock({ ...validLock, packageVersion: "latest" }),
		/packageVersion/,
	);
	assert.throws(
		() => parseImageLock({ ...validLock, piVersion: "latest" }),
		/piVersion/,
	);
	assert.throws(
		() =>
			parseImageLock({
				...validLock,
				tools: { ...validLock.tools, fdDebianVersion: "" },
			}),
		/fdDebianVersion/,
	);
	assert.throws(
		() =>
			parseImageLock({
				...validLock,
				tools: { ...validLock.tools, rgDebianVersion: "latest" },
			}),
		/exact Debian package version/,
	);
	assert.throws(
		() => parseImageLock({ ...validLock, publishedImage: "repo:latest" }),
		/unknown field publishedImage/,
	);
	assert.throws(
		() => parseImageLock({ ...validLock, localImage: `repo@sha256:${digest}` }),
		/localImage.*build tag/,
	);
});

test("loads a strict lock fixture", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-lock-"));
	const path = join(directory, "image-lock.json");
	await writeFile(path, JSON.stringify(validLock));
	assert.deepEqual(await loadImageLock(path), validLock);
});

test("checked-in lock matches every reviewed immutable value", async () => {
	const lock = await loadImageLock();
	assert.equal(lock.packageVersion, "0.1.0");
	assert.equal(packageJson.version, "0.1.0");
	assert.equal(lock.piVersion, "0.84.1");
	assert.equal(
		packageJson.devDependencies["@earendil-works/pi-coding-agent"],
		"0.84.1",
	);
	assert.equal(
		packageLock.packages[""]?.devDependencies?.[
			"@earendil-works/pi-coding-agent"
		],
		"0.84.1",
	);
	assert.equal(
		packageLock.packages["node_modules/@earendil-works/pi-coding-agent"]
			?.version,
		"0.84.1",
	);
	assert.equal(
		lock.baseImage,
		"docker/sandbox-templates@sha256:d86a6cdc105a1b299667a20c40bcf8d0584e56f21d44490a0737bb1baeb44299",
	);
	assert.equal(lock.platform, "linux/arm64");
	assert.equal(
		lock.localImage,
		"docker.io/pi-docker-sandboxes/pi:0.1.0",
	);
	assert.equal(lock.tools.fdDebianVersion, "10.3.0-2ubuntu1");
	assert.equal(lock.tools.rgDebianVersion, "15.1.0-1ubuntu1");
	assert.equal(lock.tools.gitDebianVersion, "1:2.53.0-1ubuntu1");
});
