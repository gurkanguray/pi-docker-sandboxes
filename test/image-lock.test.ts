import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertDigestReference,
	loadImageLock,
	parseImageLock,
	selectRuntimeImage,
} from "../src/image-lock.ts";

const packageJson = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string; devDependencies: Record<string, string> };
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
	version: 2,
	runtimeSchema: 1,
	piVersion: "0.84.1",
	images: {
		standard: {
			status: "published",
			reference: `ghcr.io/gurkanguray/pi-docker-sandboxes/runtime-standard@sha256:${digest}`,
			platforms: ["linux/amd64", "linux/arm64"],
			privileged: false,
		},
		docker: {
			status: "published",
			reference: `ghcr.io/gurkanguray/pi-docker-sandboxes/runtime-docker@sha256:${"b".repeat(64)}`,
			platforms: ["linux/amd64", "linux/arm64"],
			privileged: true,
		},
	},
};

const unpublishedLock = {
	...validLock,
	images: {
		standard: {
			status: "unpublished",
			platforms: ["linux/amd64", "linux/arm64"],
			privileged: false,
		},
		docker: {
			status: "unpublished",
			platforms: ["linux/amd64", "linux/arm64"],
			privileged: true,
		},
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
		() => assertDigestReference("ghcr.io/example/runtime:latest", "reference"),
		/digest/,
	);
});

test("parses both exact runtime variants", () => {
	const parsed = parseImageLock(validLock);
	assert.deepEqual(Object.keys(parsed.images).sort(), ["docker", "standard"]);
	assert.deepEqual(parsed.images.standard.platforms, [
		"linux/amd64",
		"linux/arm64",
	]);
	assert.equal(parsed.images.standard.privileged, false);
	assert.equal(parsed.images.docker.privileged, true);
});

test("rejects mutable, malformed, and unknown lock values", () => {
	assert.throws(
		() =>
			parseImageLock({
				...validLock,
				images: {
					...validLock.images,
					standard: {
						...validLock.images.standard,
						reference: "ghcr.io/x/runtime:latest",
					},
				},
			}),
		/digest/i,
	);
	assert.throws(() => parseImageLock({ ...validLock, extra: true }), /unknown/);
	assert.throws(
		() =>
			parseImageLock({
				...validLock,
				images: {
					...validLock.images,
					standard: {
						...validLock.images.standard,
						platforms: ["linux/arm64", "linux/amd64"],
					},
				},
			}),
		/platforms/,
	);
	assert.throws(
		() =>
			parseImageLock({
				...validLock,
				images: {
					...validLock.images,
					standard: { ...validLock.images.standard, privileged: true },
				},
			}),
		/privileged/,
	);
});

test("unpublished runtime variants parse but selection fails closed", () => {
	const parsed = parseImageLock(unpublishedLock);
	assert.equal(parsed.images.standard.status, "unpublished");
	assert.equal("reference" in parsed.images.standard, false);
	assert.throws(
		() => selectRuntimeImage(parsed, false, "linux/amd64"),
		/production runtime image standard is unpublished/,
	);
	assert.throws(
		() => selectRuntimeImage(parsed, true, "linux/arm64"),
		/private Docker engine is unavailable in production 1\.0/,
	);
});

test("selects standard and rejects Docker even when a Docker image is published", () => {
	const parsed = parseImageLock(validLock);
	assert.equal(
		selectRuntimeImage(parsed, false, "linux/amd64").reference,
		validLock.images.standard.reference,
	);
	assert.throws(
		() => selectRuntimeImage(parsed, true, "linux/arm64"),
		/private Docker engine is unavailable in production 1\.0/,
	);
});

test("loads a strict lock fixture", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-lock-"));
	const path = join(directory, "image-lock.json");
	await writeFile(path, JSON.stringify(validLock));
	assert.deepEqual(await loadImageLock(path), validLock);
});

test("checked-in lock selects the verified production standard runtime", async () => {
	const lock = await loadImageLock();
	assert.equal(packageJson.version, "1.0.0");
	assert.equal(packageLock.packages[""]?.version, "1.0.0");
	assert.equal(lock.version, 2);
	assert.equal(lock.runtimeSchema, 1);
	assert.equal(lock.piVersion, "0.84.1");
	assert.deepEqual(lock.images.standard, {
		status: "published",
		reference:
			"ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b",
		platforms: ["linux/amd64", "linux/arm64"],
		privileged: false,
	});
	assert.deepEqual(lock.images.docker, {
		status: "unpublished",
		platforms: ["linux/amd64", "linux/arm64"],
		privileged: true,
	});
	assert.equal(
		packageJson.devDependencies["@earendil-works/pi-coding-agent"],
		"0.84.2",
	);
	assert.equal(
		packageLock.packages[""]?.devDependencies?.[
			"@earendil-works/pi-coding-agent"
		],
		"0.84.2",
	);
});
