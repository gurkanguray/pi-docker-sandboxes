import assert from "node:assert/strict";
import test from "node:test";
import { OperationError } from "../src/errors.ts";
import type { ImageLock } from "../src/image-lock.ts";
import {
	buildLocalImage,
	compareImageReceipts,
	runImageCommand,
	verifyImage,
	verifyImageReceipt,
} from "../src/image.ts";
import { deriveLocalTemplateImage } from "../src/local-template.ts";

const digest = "a".repeat(64);
const id = `sha256:${digest}`;
const lock: ImageLock = {
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

function metadata(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify([
		{
			Id: id,
			Os: "linux",
			Architecture: "arm64",
			RepoDigests: [],
			Config: { User: "agent" },
			...overrides,
		},
	]);
}

function smokeOutput(overrides: Record<string, string> = {}): string {
	return Object.entries({
		uid: "1000",
		pi: lock.piVersion,
		package: lock.packageVersion,
		fd: lock.tools.fdDebianVersion,
		ripgrep: lock.tools.rgDebianVersion,
		git: lock.tools.gitDebianVersion,
		node: "v24.12.0",
		npm: "11.6.2",
		...overrides,
	})
		.map(([key, value]) => `PI_DSBX_VERIFY_${key}=${value}`)
		.join("\n");
}

function runner(inspect = metadata(), smoke = smokeOutput()) {
	const calls: string[][] = [];
	return {
		calls,
		run: async (_command: string, args: string[]) => {
			calls.push(args);
			return args[0] === "run"
				? { stdout: smoke, stderr: "" }
				: { stdout: inspect, stderr: "" };
		},
	};
}

test("Dockerfile requires the lock-supplied base image", async () => {
	const { readFile } = await import("node:fs/promises");
	const dockerfile = await readFile(
		new URL("../docker/Dockerfile", import.meta.url),
		"utf8",
	);
	assert.match(dockerfile, /^ARG BASE_IMAGE\nFROM \$\{BASE_IMAGE\}$/m);
	assert.doesNotMatch(dockerfile, /^ARG BASE_IMAGE=/m);
	assert.match(
		dockerfile,
		/rm -f \/usr\/libexec\/docker\/cli-plugins\/docker-buildx/,
	);
	assert.match(
		dockerfile,
		/test ! -e \/usr\/libexec\/docker\/cli-plugins\/docker-buildx/,
	);
});

test("npm pack output errors are structured", async () => {
	const { packPackage } = await import("../src/image.ts");
	for (const stdout of ["not json", '[{"filename":"../bad.tgz"}]']) {
		await assert.rejects(
			packPackage("/tmp", "/package", async () => ({ stdout, stderr: "" })),
			(error: unknown) => {
				assert.ok(error instanceof OperationError);
				assert.equal(error.phase, "prepare");
				assert.deepEqual(error.recovery, ["pi-dsbx image build"]);
				return true;
			},
		);
	}
});

test("image command failures are structured and sanitized", async () => {
	await assert.rejects(
		runImageCommand(process.execPath, [
			"-e",
			"console.error('token=topsecret123'); process.exit(4)",
		]),
		(error: unknown) => {
			assert.ok(error instanceof OperationError);
			assert.equal(error.phase, "prepare");
			assert.equal(error.exitCode, 4);
			assert.doesNotMatch(error.detail ?? "", /topsecret123/);
			return true;
		},
	);
});

test("verify image inspects before a pull-free smoke of the exact immutable ID", async () => {
	const fake = runner();
	assert.equal(await verifyImage(lock.localImage, lock, fake.run), id);
	assert.deepEqual(
		fake.calls.map((args) => args[0]),
		["image", "run"],
	);
	const runArgs = fake.calls[1]!;
	assert.deepEqual(runArgs.slice(0, 7), [
		"run",
		"--rm",
		"--pull=never",
		"--network",
		"none",
		"--platform",
		lock.platform,
	]);
	assert.equal(runArgs.at(-3), id);
	const script = runArgs.at(-1)!;
	assert.match(script, /dpkg-query.*fd-find.*10\.3\.0-2ubuntu1/);
	assert.match(script, /dpkg-query.*ripgrep.*15\.1\.0-1ubuntu1/);
	assert.match(script, /dpkg-query.*git.*1:2\.53\.0-1ubuntu1/);
});

test("verify image rejects malformed inspect output as OperationError", async () => {
	const fake = runner("not json");
	await assert.rejects(
		verifyImage(lock.localImage, lock, fake.run),
		(error) => {
			assert.ok(error instanceof OperationError);
			assert.equal(error.phase, "prepare");
			assert.deepEqual(error.recovery, ["pi-dsbx image build"]);
			return true;
		},
	);
});

test("verify image rejects invalid metadata and requested-ID mismatch before run", async () => {
	for (const [image, changed] of [
		[lock.localImage, { Id: "bad" }],
		[lock.localImage, { Os: "windows" }],
		[lock.localImage, { Architecture: "amd64" }],
		[lock.localImage, { Config: { User: "root" } }],
		[`sha256:${"b".repeat(64)}`, {}],
	] as const) {
		const fake = runner(metadata(changed));
		await assert.rejects(verifyImage(image, lock, fake.run), OperationError);
		assert.deepEqual(
			fake.calls.map((args) => args[0]),
			["image"],
		);
	}
});

test("verify image rejects exact Debian package version mutation", async () => {
	const fake = runner();
	fake.run = async (_command: string, args: string[]) => {
		fake.calls.push(args);
		if (args[0] === "run")
			throw new OperationError({
				phase: "prepare",
				operation: "docker run",
				detail: "git package version mismatch",
				recovery: ["pi-dsbx image build"],
			});
		return { stdout: metadata(), stderr: "" };
	};
	await assert.rejects(
		verifyImage(lock.localImage, lock, fake.run),
		/docker run/,
	);
});

test("a deleted immutable ID at smoke time fails closed without pull", async () => {
	const fake = runner();
	fake.run = async (_command: string, args: string[]) => {
		fake.calls.push(args);
		if (args[0] === "run")
			throw new OperationError({
				phase: "prepare",
				operation: "docker run",
				detail: "No such image",
				recovery: ["pi-dsbx image build"],
			});
		return { stdout: metadata(), stderr: "" };
	};
	await assert.rejects(
		verifyImage(lock.localImage, lock, fake.run),
		(error) => {
			assert.ok(error instanceof OperationError);
			assert.equal(error.phase, "prepare");
			return true;
		},
	);
	assert.equal(fake.calls[1]?.includes("--pull=never"), true);
	assert.equal(fake.calls[1]?.at(-3), id);
});

test("verification receipt records local image ID without inventing a registry digest", async () => {
	const receipt = await verifyImageReceipt(lock.localImage, lock, runner().run);
	assert.equal(receipt.image, lock.localImage);
	assert.equal(receipt.digest, id);
	assert.equal(receipt.imageId, id);
	assert.equal(receipt.registryDigest, null);
	assert.equal(receipt.platform, lock.platform);
	assert.equal(receipt.uid, 1000);
	assert.equal(receipt.user, "agent");
	assert.deepEqual(receipt.entrypoint, []);
	assert.deepEqual(receipt.versions, {
		package: lock.packageVersion,
		pi: lock.piVersion,
		fd: lock.tools.fdDebianVersion,
		ripgrep: lock.tools.rgDebianVersion,
		git: lock.tools.gitDebianVersion,
		node: "v24.12.0",
		npm: "11.6.2",
	});
	assert.equal(await verifyImage(lock.localImage, lock, runner().run), id);
});

test("remote verification selects the exact requested RepoDigest", async () => {
	const candidate = `registry.example/image@sha256:${"b".repeat(64)}`;
	const other = `registry.example/other@sha256:${"c".repeat(64)}`;
	const receipt = await verifyImageReceipt(
		candidate,
		lock,
		runner(metadata({ RepoDigests: [other, candidate] })).run,
	);
	assert.equal(receipt.digest, `sha256:${"b".repeat(64)}`);
	assert.equal(receipt.registryDigest, candidate);
	assert.equal(receipt.imageId, id);

	await assert.rejects(
		verifyImageReceipt(
			candidate,
			lock,
			runner(metadata({ RepoDigests: [other] })).run,
		),
		OperationError,
	);
	await assert.rejects(
		verifyImageReceipt("registry.example/image:latest", lock, runner().run),
		OperationError,
	);
});

test("local build idempotently loads an existing content tag without removing it", async () => {
	const replacementId = `sha256:${"b".repeat(64)}`;
	const contentImage = deriveLocalTemplateImage(lock.localImage, id);
	const [repository, tag] = contentImage.split(/:(?=[^:]+$)/);
	const calls: Array<{ command: string; args: string[] }> = [];
	let mutableTagTarget = id;
	let listed = 0;
	const run = async (command: string, args: string[]) => {
		calls.push({ command, args });
		if (command === "npm" && args[0] === "pack") {
			const destination = args[args.indexOf("--pack-destination") + 1]!;
			const { writeFile } = await import("node:fs/promises");
			await writeFile(`${destination}/package.tgz`, "package");
			return { stdout: '[{"filename":"package.tgz"}]', stderr: "" };
		}
		if (command === "sbx" && args.join(" ") === "template ls --json") {
			listed++;
			return {
				stdout: JSON.stringify({
					images:
						listed === 1
							? [{ id: "abc123def456", repository, tag }]
							: [{ id: "def456abc123", repository, tag }],
				}),
				stderr: "",
			};
		}
		return { stdout: "", stderr: "" };
	};
	const result = await buildLocalImage(
		{ keepBuildDirectory: true },
		{
			run,
			verify: async (image) => {
				assert.equal(image, lock.localImage);
				mutableTagTarget = replacementId;
				return id;
			},
		},
	);
	try {
		assert.equal(result.image, contentImage);
		assert.equal(result.verifiedImage, id);
		assert.equal(result.templateStoreId, "def456abc123");
		assert.equal(mutableTagTarget, replacementId);
		assert.deepEqual(
			calls.map(({ command, args }) => `${command} ${args.join(" ")}`),
			[
				"npm run build:cli",
				`npm pack ${new URL("..", import.meta.url).pathname.replace(/\/$/, "")} --pack-destination ${result.buildDirectory} --json --ignore-scripts`,
				calls[2] && `docker ${calls[2].args.join(" ")}`,
				`docker tag ${id} ${contentImage}`,
				"sbx template ls --json",
				`docker save --output ${result.archive} ${contentImage}`,
				`sbx template load ${result.archive}`,
				"sbx template ls --json",
				`docker image rm ${contentImage}`,
			],
		);
	} finally {
		const { rm } = await import("node:fs/promises");
		await rm(result.buildDirectory, { recursive: true, force: true });
	}
});

test("local build leaves an existing registration intact when save or load fails", async () => {
	const contentImage = deriveLocalTemplateImage(lock.localImage, id);
	const [repository, tag] = contentImage.split(/:(?=[^:]+$)/);
	for (const failure of ["save", "load"] as const) {
		const calls: Array<{ command: string; args: string[] }> = [];
		const run = async (command: string, args: string[]) => {
			calls.push({ command, args });
			if (command === "npm" && args[0] === "pack") {
				const destination = args[args.indexOf("--pack-destination") + 1]!;
				const { writeFile } = await import("node:fs/promises");
				await writeFile(`${destination}/package.tgz`, "package");
				return { stdout: '[{"filename":"package.tgz"}]', stderr: "" };
			}
			if (command === "sbx" && args.join(" ") === "template ls --json")
				return {
					stdout: JSON.stringify({
						images: [{ id: "abc123def456", repository, tag }],
					}),
					stderr: "",
				};
			if (command === "docker" && args[0] === "save" && failure === "save")
				throw new Error("save failed");
			if (command === "sbx" && args[1] === "load" && failure === "load")
				throw new Error("load failed");
			return { stdout: "", stderr: "" };
		};
		await assert.rejects(
			buildLocalImage({}, { run, verify: async () => id }),
			new RegExp(`${failure} failed`),
		);
		assert.equal(
			calls.some(({ command, args }) => command === "sbx" && args[1] === "rm"),
			false,
		);
	}
});

test("local build cleans only its temporary Docker tag when template load fails", async () => {
	const contentImage = deriveLocalTemplateImage(lock.localImage, id);
	const calls: Array<{ command: string; args: string[] }> = [];
	const run = async (command: string, args: string[]) => {
		calls.push({ command, args });
		if (command === "npm" && args[0] === "pack") {
			const destination = args[args.indexOf("--pack-destination") + 1]!;
			const { writeFile } = await import("node:fs/promises");
			await writeFile(`${destination}/package.tgz`, "package");
			return { stdout: '[{"filename":"package.tgz"}]', stderr: "" };
		}
		if (command === "sbx" && args.join(" ") === "template ls --json")
			return { stdout: '{"images":[]}', stderr: "" };
		if (command === "sbx" && args[1] === "load") throw new Error("load failed");
		return { stdout: "", stderr: "" };
	};
	await assert.rejects(
		buildLocalImage({}, { run, verify: async () => id }),
		/load failed/,
	);
	assert.deepEqual(
		calls
			.filter(
				({ command, args }) => command === "docker" && args[0] === "image",
			)
			.map(({ args }) => args),
		[["image", "rm", contentImage]],
	);
	assert.equal(
		calls.some(
			({ args }) => args.includes(lock.localImage) && args[0] === "image",
		),
		false,
	);
});

test("local build does not load an archive when immutable save fails", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const run = async (command: string, args: string[]) => {
		calls.push({ command, args });
		if (command === "npm" && args[0] === "pack") {
			const destination = args[args.indexOf("--pack-destination") + 1]!;
			const { writeFile } = await import("node:fs/promises");
			await writeFile(`${destination}/package.tgz`, "package");
			return { stdout: '[{"filename":"package.tgz"}]', stderr: "" };
		}
		if (command === "docker" && args[0] === "save")
			throw new Error("save failed");
		if (command === "sbx" && args.join(" ") === "template ls --json")
			return { stdout: '{"images":[]}', stderr: "" };
		return { stdout: "", stderr: "" };
	};
	await assert.rejects(
		buildLocalImage({}, { run, verify: async () => id }),
		/save failed/,
	);
	assert.equal(
		calls.some(({ command, args }) => command === "sbx" && args[1] === "load"),
		false,
	);
});

test("malformed smoke receipts fail closed", async () => {
	const valid = smokeOutput().split("\n");
	for (const output of [
		valid.filter((line) => !line.startsWith("PI_DSBX_VERIFY_node=")).join("\n"),
		`${smokeOutput()}\nPI_DSBX_VERIFY_node=v25.0.0`,
		`${smokeOutput()}\nPI_DSBX_VERIFY_extra=unexpected`,
		`${smokeOutput()}\nPI_DSBX_VERIFY_broken`,
		smokeOutput({ uid: "1000.0" }),
	])
		await assert.rejects(
			verifyImageReceipt(lock.localImage, lock, runner(metadata(), output).run),
			OperationError,
		);
});

test("parity compares every runtime identity field but not build digest", async () => {
	const local = await verifyImageReceipt(lock.localImage, lock, runner().run);
	const candidateRef = `registry.example/image@sha256:${"b".repeat(64)}`;
	const candidate = await verifyImageReceipt(
		candidateRef,
		lock,
		runner(metadata({ RepoDigests: [candidateRef] })).run,
	);
	assert.deepEqual(compareImageReceipts(local, candidate), {
		status: "matched",
		candidate: candidateRef,
	});
	const mutations: Array<[string, typeof candidate]> = [
		["platform", { ...candidate, platform: "linux/amd64" as "linux/arm64" }],
		["uid", { ...candidate, uid: 0 }],
		["user", { ...candidate, user: "root" }],
		["entrypoint", { ...candidate, entrypoint: ["sh"] }],
		...["package", "pi", "fd", "ripgrep", "git", "node", "npm"].map(
			(name) =>
				[
					`versions.${name}`,
					{
						...candidate,
						versions: { ...candidate.versions, [name]: "mutated" },
					},
				] as [string, typeof candidate],
		),
	];
	for (const [name, mutated] of mutations)
		assert.throws(
			() => compareImageReceipts(local, mutated),
			(error: unknown) => {
				assert.ok(error instanceof OperationError);
				assert.match(error.detail ?? "", /parity mismatch/i, name);
				return true;
			},
		);
});
