import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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
	assert.deepEqual(spec.sandbox.entrypoint, [
		"pi",
		"-e",
		"/home/agent/.pi/agent/runtime/pi-docker-sandboxes.mjs",
	]);
	assert.deepEqual(spec.sandbox.command.interactive, []);
	assert.ok(spec.permissions.network.allow.includes("api.openai.com"));
	assert.ok(spec.permissions.network.allow.includes("docs.example.com"));
	assert.equal(JSON.stringify(spec).includes("API_KEY=sk-"), false);
});

test("Kit owns an exact private copy of the sandbox runtime", async () => {
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
	const runtimePath = join(
		directory,
		"files",
		"home",
		".pi",
		"agent",
		"runtime",
		"pi-docker-sandboxes.mjs",
	);
	const [installed, source] = await Promise.all([
		readFile(runtimePath),
		readFile(new URL("../runtime/extension.mjs", import.meta.url)),
	]);
	assert.equal(
		createHash("sha256").update(installed).digest("hex"),
		createHash("sha256").update(source).digest("hex"),
	);
	assert.equal((await stat(join(directory, "spec.yaml"))).mode & 0o777, 0o600);
	assert.equal((await stat(runtimePath)).mode & 0o777, 0o600);
	assert.equal((await stat(join(runtimePath, ".."))).mode & 0o777, 0o700);
});

test("Kit enforces runtime modes with restrictive umask and an existing directory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-kit-modes-"));
	const runtimeDirectory = join(
		directory,
		"files",
		"home",
		".pi",
		"agent",
		"runtime",
	);
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o755 });
	const spec = buildKitSpec({
		config: mergeConfig(),
		services: [],
		image: standard,
	});
	const previousUmask = process.umask(0o777);
	try {
		await writeKitDirectory(directory, spec);
	} finally {
		process.umask(previousUmask);
	}
	assert.equal((await stat(runtimeDirectory)).mode & 0o777, 0o700);
	assert.equal(
		(
			await stat(join(runtimeDirectory, "pi-docker-sandboxes.mjs"))
		).mode & 0o777,
		0o600,
	);
});

test("personalization cannot overwrite the Kit-owned runtime", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-kit-collision-"));
	const personalization = await mkdtemp(
		join(tmpdir(), "pi-dsbx-personalization-"),
	);
	await mkdir(join(personalization, "runtime"));
	await writeFile(
		join(personalization, "runtime", "pi-docker-sandboxes.mjs"),
		"throw new Error('user collision');\n",
	);
	const spec = buildKitSpec({
		config: mergeConfig(),
		services: [],
		image: standard,
	});
	await assert.rejects(
		writeKitDirectory(directory, spec, { personalization }),
		/already exists|EEXIST/i,
	);
});
