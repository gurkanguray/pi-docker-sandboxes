import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig } from "../src/config.ts";
import type { ImageLock } from "../src/image-lock.ts";
import type { runImageCommand } from "../src/image.ts";
import { deriveLocalTemplateImage } from "../src/local-template.ts";
import {
	buildKitSpec,
	resolveKitImage,
	writeKitDirectory,
} from "../src/kit.ts";
import { BUILTIN_SERVICES } from "../src/providers.ts";

const digest = "a".repeat(64);
const explicitImage = `example.invalid/image@sha256:${digest}`;
const lock: ImageLock = {
	packageVersion: "0.1.0",
	piVersion: "0.84.1",
	platform: "linux/arm64",
	baseImage: `example.invalid/base@sha256:${"b".repeat(64)}`,
	localImage: "docker.io/pi-docker-sandboxes/pi:0.1.0",
	tools: {
		fdDebianVersion: "10.3.0-2ubuntu1",
		rgDebianVersion: "15.1.0-1ubuntu1",
		gitDebianVersion: "1:2.53.0-1ubuntu1",
	},
};

test("Kit v2 generation is deterministic, strict, and secret-free", async () => {
	const config = mergeConfig({
		profile: "development",
		providers: ["openai"],
		sandbox: { image: explicitImage },
		network: { allow: ["docs.example.com"], deny: ["blocked.example.com"] },
	});
	const spec = buildKitSpec({
		config,
		services: [BUILTIN_SERVICES.openai!],
	});
	assert.equal(spec.schemaVersion, "2");
	assert.equal(spec.kind, "sandbox");
	assert.equal(spec.security.privileged, true);
	assert.deepEqual(spec.sandbox.command.interactive, []);
	assert.ok(
		spec.permissions.network.allow.some(
			(domain) => domain === "api.openai.com",
		),
	);
	assert.ok(
		spec.permissions.network.allow.some(
			(domain) => domain === "registry.npmjs.org",
		),
	);
	assert.equal(spec.credentials?.[0]?.required, false);
	assert.equal(spec.credentials?.[0]?.apiKey.proxyManaged, true);
	assert.equal(spec.environment.variables.OPENAI_API_KEY, undefined);
	assert.equal("setup" in spec, false);
	assert.match(spec.sandbox.image, /@sha256:[0-9a-f]{64}$/);
	const serialized = JSON.stringify(spec);
	assert.equal(serialized.includes("sk-test-never-copy"), false);
	assert.equal(serialized.includes("npm install"), false);
	assert.equal(serialized.includes("Downloading"), false);

	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-kit-"));
	await writeKitDirectory(directory, spec);
	assert.deepEqual(
		JSON.parse(await readFile(join(directory, "spec.yaml"), "utf8")),
		spec,
	);
});

test("Kit adds native install hosts only when explicitly supplied", () => {
	const config = mergeConfig({
		profile: "hardened",
		sandbox: { image: explicitImage },
	});
	const defaults = buildKitSpec({ config, services: [] });
	assert.deepEqual(defaults.permissions.network.allow, []);
	const native = buildKitSpec({
		config,
		services: [],
		extraAllow: ["archive.ubuntu.com", "registry.npmjs.org"],
	});
	assert.deepEqual(native.permissions.network.allow, [
		"archive.ubuntu.com",
		"registry.npmjs.org",
	]);
});

test("image resolution fails closed or selects an immutable configured or verified local image", async () => {
	const config = mergeConfig();
	await assert.rejects(
		() =>
			resolveKitImage(config, lock, async () => {
				throw new Error("No such image");
			}),
		(error) => {
			assert.equal((error as { phase?: string }).phase, "preflight");
			assert.deepEqual((error as { recovery?: string[] }).recovery, [
				"pi-dsbx image build",
			]);
			return true;
		},
	);

	let commands = 0;
	assert.deepEqual(
		await resolveKitImage(
			mergeConfig({ sandbox: { image: explicitImage } }),
			lock,
			async () => {
				commands++;
				return { stdout: "", stderr: "" };
			},
		),
		{ image: explicitImage },
	);
	assert.equal(commands, 0);

	const localId = `sha256:${"e".repeat(64)}`;
	const localImage = deriveLocalTemplateImage(lock.localImage, localId);
	const localRun: typeof runImageCommand = async (_command, args) => {
		if (args.includes("--format"))
			return { stdout: `${localId}\n`, stderr: "" };
		if (args[0] === "image")
			return {
				stdout: JSON.stringify([
					{
						Id: localId,
						Os: "linux",
						Architecture: "arm64",
						RepoDigests: [],
						Config: { User: "agent" },
					},
				]),
				stderr: "",
			};
		return {
			stdout: JSON.stringify({
				images: [
					{
						id: "abc123def456",
						repository: "docker.io/pi-docker-sandboxes/pi",
						tag: localImage.split(":").at(-1),
					},
				],
			}),
			stderr: "",
		};
	};
	assert.deepEqual(await resolveKitImage(config, lock, localRun), {
		image: localImage,
		templateStoreId: "abc123def456",
	});
	assert.equal(
		buildKitSpec({ config, services: [], image: localImage }).sandbox.image,
		localImage,
	);
});

test("mutable or mutated image evidence is never selected", async () => {
	assert.throws(
		() =>
			buildKitSpec({
				config: mergeConfig({
					sandbox: { image: "example.invalid/pi:latest" },
				}),
				services: [],
			}),
		/digest/,
	);
	await assert.rejects(
		() =>
			resolveKitImage(mergeConfig(), lock, async () => ({
				stdout: "not-json",
				stderr: "",
			})),
		(error) => {
			assert.equal((error as { phase?: string }).phase, "preflight");
			assert.deepEqual((error as { recovery?: string[] }).recovery, [
				"pi-dsbx image build",
			]);
			return true;
		},
	);
});

test("non-Docker-engine image resolution requires explicit digest without commands", async () => {
	const config = mergeConfig({ sandbox: { dockerEngine: false } });
	let commands = 0;
	await assert.rejects(
		resolveKitImage(config, lock, async () => {
			commands++;
			return { stdout: "", stderr: "" };
		}),
		/sandbox\.image.*digest-pinned/,
	);
	assert.equal(commands, 0);
});

test("local fallback verifies Docker without pull and selects only its exact registered content tag", async () => {
	const localId = `sha256:${"e".repeat(64)}`;
	const localImage = deriveLocalTemplateImage(lock.localImage, localId);
	const calls: string[][] = [];
	const run: typeof runImageCommand = async (_command, args) => {
		calls.push(args);
		if (args.includes("--format"))
			return { stdout: `${localId}\n`, stderr: "" };
		if (args[0] === "image")
			return {
				stdout: JSON.stringify([
					{
						Id: localId,
						Os: "linux",
						Architecture: "arm64",
						RepoDigests: [],
						Config: { User: "agent" },
					},
				]),
				stderr: "",
			};
		if (args[0] === "run") return { stdout: "", stderr: "" };
		return {
			stdout: JSON.stringify({
				images: [
					{
						id: "b0761d296d76",
						repository: "docker.io/pi-docker-sandboxes/pi",
						tag: lock.localImage.split(":").at(-1),
					},
					{
						id: "abc123def456",
						repository: "docker.io/pi-docker-sandboxes/pi",
						tag: localImage.split(":").at(-1),
					},
				],
			}),
			stderr: "",
		};
	};
	assert.deepEqual(await resolveKitImage(mergeConfig(), lock, run), {
		image: localImage,
		templateStoreId: "abc123def456",
	});
	assert.deepEqual(
		calls.map((args) => args[0]),
		["image", "image", "run", "template"],
	);
	assert.equal(calls[2]?.includes("--pull=never"), true);
});

test("local fallback fails closed if the tag changes between discovery and verification", async () => {
	const discoveredId = `sha256:${"e".repeat(64)}`;
	const changedId = `sha256:${"f".repeat(64)}`;
	const calls: string[][] = [];
	await assert.rejects(
		resolveKitImage(mergeConfig(), lock, async (_command, args) => {
			calls.push(args);
			if (args.includes("--format"))
				return { stdout: `${discoveredId}\n`, stderr: "" };
			return {
				stdout: JSON.stringify([
					{
						Id: changedId,
						Os: "linux",
						Architecture: "arm64",
						RepoDigests: [],
						Config: { User: "agent" },
					},
				]),
				stderr: "",
			};
		}),
		/preflight/,
	);
	assert.deepEqual(
		calls.map((args) => args[0]),
		["image", "image"],
	);
});

test("local fallback rejects missing, malformed, duplicate, and wrong template entries", async () => {
	const localId = `sha256:${"e".repeat(64)}`;
	const localImage = deriveLocalTemplateImage(lock.localImage, localId);
	const tag = localImage.split(":").at(-1)!;
	const valid = {
		id: "abc123def456",
		repository: "docker.io/pi-docker-sandboxes/pi",
		tag,
	};
	for (const images of [
		[],
		[{ ...valid, id: "short" }],
		[{ ...valid, repository: "docker.io/other/pi" }],
		[{ ...valid, tag: `${tag}-wrong` }],
		[valid, valid],
	]) {
		await assert.rejects(
			resolveKitImage(mergeConfig(), lock, async (_command, args) => {
				if (args.includes("--format")) return { stdout: localId, stderr: "" };
				if (args[0] === "image")
					return {
						stdout: JSON.stringify([
							{
								Id: localId,
								Os: "linux",
								Architecture: "arm64",
								RepoDigests: [],
								Config: { User: "agent" },
							},
						]),
						stderr: "",
					};
				if (args[0] === "run") return { stdout: "", stderr: "" };
				return { stdout: JSON.stringify({ images }), stderr: "" };
			}),
			/preflight/,
		);
	}
});

test("Kit accepts only a digest reference or the exact derived local content tag shape", () => {
	const config = mergeConfig();
	const valid = deriveLocalTemplateImage(
		lock.localImage,
		`sha256:${"e".repeat(64)}`,
	);
	assert.equal(
		buildKitSpec({ config, services: [], image: valid }).sandbox.image,
		valid,
	);
	for (const image of [
		`sha256:${"e".repeat(64)}`,
		"docker.io/pi-docker-sandboxes/pi:latest",
		`docker.io/other/pi:local-${"e".repeat(64)}`,
		`docker.io/pi-docker-sandboxes/pi:local-${"e".repeat(63)}`,
	])
		assert.throws(
			() => buildKitSpec({ config, services: [], image }),
			/image/i,
		);
});

test("non-Docker-engine Kit requires an explicit digest-pinned image", () => {
	const config = mergeConfig({ sandbox: { dockerEngine: false } });
	assert.throws(
		() => buildKitSpec({ config, services: [] }),
		/sandbox\.image.*digest-pinned/,
	);
	config.sandbox.image = "docker/sandbox-templates:shell";
	assert.throws(() => buildKitSpec({ config, services: [] }), /digest/);
	config.sandbox.image = `example.invalid/sandbox@sha256:${digest}`;
	assert.equal(
		buildKitSpec({ config, services: [] }).sandbox.image,
		config.sandbox.image,
	);
});
