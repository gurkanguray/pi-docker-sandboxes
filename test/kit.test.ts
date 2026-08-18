import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mergeConfig } from "../src/config.ts";
import type { RuntimeImageLock } from "../src/image-lock.ts";
import {
	buildKitSpec,
	resolveKitImage,
	writeKitDirectory,
} from "../src/kit.ts";
import { BUILTIN_SERVICES } from "../src/providers.ts";

const digest = "a".repeat(64);
const standard =
	`ghcr.io/gurkanguray/pi-docker-sandboxes/runtime-standard@sha256:${digest}` as const;
const docker =
	`ghcr.io/gurkanguray/pi-docker-sandboxes/runtime-docker@sha256:${"b".repeat(64)}` as const;
const publishedLock: RuntimeImageLock = {
	version: 2,
	runtimeSchema: 1,
	piVersion: "0.84.1",
	images: {
		standard: {
			status: "published",
			reference: standard,
			platforms: ["linux/amd64", "linux/arm64"],
			privileged: false,
		},
		docker: {
			status: "published",
			reference: docker,
			platforms: ["linux/amd64", "linux/arm64"],
			privileged: true,
		},
	},
};

test("runtime image resolution fails closed while source variants are unpublished", async () => {
	await assert.rejects(
		resolveKitImage(mergeConfig()),
		/production runtime image standard is unpublished/,
	);
	await assert.rejects(
		resolveKitImage(mergeConfig({ sandbox: { dockerEngine: true } })),
		/production runtime image docker is unpublished/,
	);
});

test("runtime image resolution selects the exact configured variant", async () => {
	assert.deepEqual(await resolveKitImage(mergeConfig(), publishedLock), {
		image: standard,
	});
	assert.deepEqual(
		await resolveKitImage(
			mergeConfig({ sandbox: { dockerEngine: true } }),
			publishedLock,
		),
		{ image: docker },
	);
});

test("Kit v2 generation is deterministic and secret-free", () => {
	const config = mergeConfig({
		auth: { mode: "proxy", providers: ["openai"] },
		network: { allow: ["docs.example.com"] },
	});
	const spec = buildKitSpec({
		config,
		services: [BUILTIN_SERVICES.openai!],
		image: standard,
	});
	assert.equal(spec.schemaVersion, "2");
	assert.equal(spec.version, "1.0.0");
	assert.equal(spec.security.privileged, false);
	assert.equal(spec.sandbox.image, standard);
	assert.deepEqual(spec.sandbox.command.interactive, []);
	assert.ok(spec.permissions.network.allow.includes("api.openai.com"));
	assert.ok(spec.permissions.network.allow.includes("docs.example.com"));
	assert.equal(JSON.stringify(spec).includes("API_KEY=sk-"), false);
});

test("Kit files are owner-private", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-kit-"));
	const spec = buildKitSpec({
		config: mergeConfig(),
		services: [],
		image: standard,
	});
	await writeKitDirectory(directory, spec);
	assert.deepEqual(
		JSON.parse(await readFile(join(directory, "spec.yaml"), "utf8")),
		spec,
	);
});
