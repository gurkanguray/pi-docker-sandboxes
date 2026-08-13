import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	access,
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import type { ImageLock } from "../src/image-lock.ts";
import { loadImageLock } from "../src/image-lock.ts";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);
const imageTestEnabled = process.env.PI_DOCKER_SANDBOX_IMAGE_TEST === "1";

interface InstalledImageReceipt {
	image: string;
	digest: string;
	imageId: string;
	registryDigest: string | null;
	platform: string;
	uid: number;
	user: string;
	entrypoint: string[];
	versions: Record<string, string>;
	parity: { status: string; candidate: string | null };
}

function assertInstalledImageReceipt(
	receipt: InstalledImageReceipt,
	image: string,
	lock: ImageLock,
): void {
	assert.deepEqual(Object.keys(receipt).sort(), [
		"digest",
		"entrypoint",
		"image",
		"imageId",
		"parity",
		"platform",
		"registryDigest",
		"uid",
		"user",
		"versions",
	]);
	assert.equal(receipt.image, image);
	assert.match(receipt.digest, /^sha256:[0-9a-f]{64}$/);
	assert.equal(receipt.digest, receipt.imageId);
	assert.equal(receipt.registryDigest, null);
	assert.equal(receipt.platform, "linux/arm64");
	assert.equal(receipt.uid, 1000);
	assert.equal(receipt.user, "agent");
	assert.deepEqual(receipt.entrypoint, ["tini", "--"]);
	assert.deepEqual(Object.keys(receipt.versions).sort(), [
		"fd",
		"git",
		"node",
		"npm",
		"package",
		"pi",
		"ripgrep",
	]);
	assert.equal(receipt.versions.package, lock.packageVersion);
	assert.equal(receipt.versions.pi, lock.piVersion);
	assert.equal(receipt.versions.fd, lock.tools.fdDebianVersion);
	assert.equal(receipt.versions.ripgrep, lock.tools.rgDebianVersion);
	assert.equal(receipt.versions.git, lock.tools.gitDebianVersion);
	assert.match(receipt.versions.node ?? "", /^v\d+\.\d+\.\d+$/);
	assert.match(receipt.versions.npm ?? "", /^\d+\.\d+\.\d+$/);
	assert.deepEqual(receipt.parity, {
		status: "not-compared",
		candidate: null,
	});
}

test("source package builds the CLI exactly once before scriptless packing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-source-pack-"));
	try {
		const source = join(directory, "source");
		const output = join(directory, "output");
		await mkdir(source);
		await mkdir(output);
		for (const path of ["package.json", "tsconfig.json", "tsconfig.cli.json"])
			await cp(join(rootPath, path), join(source, path));
		await cp(join(rootPath, "src"), join(source, "src"), { recursive: true });
		await symlink(join(rootPath, "node_modules"), join(source, "node_modules"));
		await writeFile(join(source, ".source-checkout"), "");
		const { packPackage, runImageCommand } = await import("../src/image.ts");
		const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
		const archive = await packPackage(
			output,
			source,
			async (command, args, options = {}) => {
				calls.push({ command, args, cwd: options.cwd });
				return runImageCommand(command, args, options);
			},
		);
		assert.deepEqual(calls, [
			{ command: "npm", args: ["run", "build:cli"], cwd: source },
			{
				command: "npm",
				args: [
					"pack",
					source,
					"--pack-destination",
					output,
					"--json",
					"--ignore-scripts",
				],
				cwd: undefined,
			},
		]);
		const { stdout: listing } = await exec("tar", ["-tf", archive]);
		assert.match(listing, /^package\/dist\/cli\.js$/m);
		assert.match(listing, /^package\/dist\/image\.js$/m);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("source CLI build failure is structured", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-source-fail-"));
	try {
		await writeFile(join(directory, ".source-checkout"), "");
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({
				name: "pi-dsbx-build-failure",
				version: "1.0.0",
				scripts: { "build:cli": "node -e 'process.exit(7)'" },
			}),
		);
		const { packPackage } = await import("../src/image.ts");
		await assert.rejects(
			packPackage(directory, directory),
			(error: unknown) => {
				assert.equal((error as { name?: string }).name, "OperationError");
				assert.equal((error as { phase?: string }).phase, "prepare");
				assert.equal((error as { exitCode?: number }).exitCode, 7);
				assert.deepEqual((error as { recovery?: string[] }).recovery, [
					"pi-dsbx image build",
				]);
				return true;
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("installed receipt assertion rejects every omitted or mutated field", async () => {
	const lock = await loadImageLock();
	const image = lock.localImage;
	const id = `sha256:${"a".repeat(64)}`;
	const receipt: InstalledImageReceipt = {
		image,
		digest: id,
		imageId: id,
		registryDigest: null,
		platform: lock.platform,
		uid: 1000,
		user: "agent",
		entrypoint: ["tini", "--"],
		versions: {
			package: lock.packageVersion,
			pi: lock.piVersion,
			fd: lock.tools.fdDebianVersion,
			ripgrep: lock.tools.rgDebianVersion,
			git: lock.tools.gitDebianVersion,
			node: "v22.22.1",
			npm: "9.2.0",
		},
		parity: { status: "not-compared", candidate: null },
	};
	assertInstalledImageReceipt(receipt, image, lock);
	const mutations: InstalledImageReceipt[] = [
		{ ...receipt, image: "wrong" },
		{ ...receipt, digest: "sha256:bad" },
		{ ...receipt, imageId: `sha256:${"b".repeat(64)}` },
		{ ...receipt, registryDigest: `registry/image@${id}` },
		{ ...receipt, platform: "linux/amd64" },
		{ ...receipt, uid: 0 },
		{ ...receipt, user: "root" },
		{ ...receipt, entrypoint: ["sh"] },
		...["package", "pi", "fd", "ripgrep", "git", "node", "npm"].map((name) => ({
			...receipt,
			versions: { ...receipt.versions, [name]: "mutated" },
		})),
		{ ...receipt, parity: { status: "matched", candidate: null } },
		{ ...receipt, parity: { status: "not-compared", candidate: "unexpected" } },
	];
	for (const mutation of mutations)
		assert.throws(() => assertInstalledImageReceipt(mutation, image, lock));
	for (const field of Object.keys(receipt)) {
		const incomplete = { ...receipt } as Record<string, unknown>;
		delete incomplete[field];
		assert.throws(() =>
			assertInstalledImageReceipt(
				incomplete as unknown as InstalledImageReceipt,
				image,
				lock,
			),
		);
	}
});

test("packed CLI runs from node_modules", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-cli-pack-"));
	try {
		const { stdout } = await exec(
			"npm",
			["pack", "--silent", "--pack-destination", directory],
			{ cwd: root },
		);
		const packageDirectory = join(
			directory,
			"node_modules",
			"pi-docker-sandboxes",
		);
		await mkdir(packageDirectory, { recursive: true });
		await exec("tar", [
			"-xzf",
			join(directory, stdout.trim()),
			"--strip-components=1",
			"-C",
			packageDirectory,
		]);
		const { stdout: help } = await exec(
			process.execPath,
			[join(packageDirectory, "bin", "pi-dsbx.mjs"), "--help"],
			{ cwd: directory },
		);
		assert.match(help, /^pi-dsbx - run Pi inside Docker Sandboxes$/m);

		const reexecCanary = join(directory, "reexec-canary.cjs");
		const reexecLog = join(directory, "reexec-canary.log");
		await writeFile(
			reexecCanary,
			`require("node:fs").appendFileSync(${JSON.stringify(reexecLog)}, process.pid + "\\n");`,
		);
		await exec(
			process.execPath,
			[join(packageDirectory, "bin", "pi-dsbx.mjs"), "--help"],
			{
				cwd: directory,
				env: {
					...process.env,
					NODE_OPTIONS: `--require=${reexecCanary}`,
					AWS_SESSION_TOKEN: "reexec-canary-secret",
				},
			},
		);
		assert.equal(
			(await readFile(reexecLog, "utf8")).trim().split("\n").length,
			1,
			"the package bin must not forward NODE_OPTIONS to its CLI child",
		);

		const { stdout: verifyHelp } = await exec(process.execPath, [
			join(packageDirectory, "scripts", "verify-image.mjs"),
			"--help",
		]);
		assert.match(verifyHelp, /^Usage: npm run image:verify/m);
		await assert.rejects(access(join(packageDirectory, ".source-checkout")));
		await writeFile(
			join(packageDirectory, "dist", "image.js"),
			`export async function verifyImageReceipt(image) { return { image, digest: "sha256:${"a".repeat(64)}", imageId: "sha256:${"a".repeat(64)}", registryDigest: null, platform: "linux/arm64", uid: 1000, user: "agent", entrypoint: ["tini", "--"], versions: { package: "0.1.0-alpha.1", pi: "0.84.1", fd: "10.3.0-2ubuntu1", ripgrep: "15.1.0-1ubuntu1", git: "1:2.53.0-1ubuntu1", node: "v22.22.1", npm: "9.2.0" } }; } export function compareImageReceipts() { throw new Error("unexpected candidate"); }`,
		);
		await chmod(packageDirectory, 0o555);
		const emptyPath = join(directory, "empty-path");
		await mkdir(emptyPath);
		const { stdout: offlineVerification } = await exec(
			process.execPath,
			[
				join(packageDirectory, "scripts", "verify-image.mjs"),
				"fake-local-image",
			],
			{ env: { ...process.env, PATH: emptyPath } },
		);
		const offlineReceipt = JSON.parse(
			offlineVerification.trim().split("\n").at(-1)!,
		) as InstalledImageReceipt;
		assertInstalledImageReceipt(
			offlineReceipt,
			"fake-local-image",
			await loadImageLock(join(packageDirectory, "docker", "image-lock.json")),
		);
		await chmod(packageDirectory, 0o755);
		await exec("tar", [
			"-xzf",
			join(directory, stdout.trim()),
			"--strip-components=1",
			"-C",
			packageDirectory,
		]);
		if (imageTestEnabled) {
			const image =
				process.env.PI_DOCKER_SANDBOX_IMAGE ??
				"docker.io/pi-docker-sandboxes/pi:0.1.0-alpha.1";
			const { stdout: verification } = await exec(process.execPath, [
				join(packageDirectory, "scripts", "verify-image.mjs"),
				image,
			]);
			const receipt = JSON.parse(
				verification.trim().split("\n").at(-1)!,
			) as InstalledImageReceipt;
			assertInstalledImageReceipt(
				receipt,
				image,
				await loadImageLock(
					join(packageDirectory, "docker", "image-lock.json"),
				),
			);
		}
	} finally {
		await chmod(
			join(directory, "node_modules", "pi-docker-sandboxes"),
			0o755,
		).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
	await assert.rejects(access(directory));
});

test("installed read-only package repacks without scripts or compiler", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-installed-pack-"));
	try {
		const sourceArchive = join(directory, "source.tgz");
		const { packPackage: packSource } = await import("../src/image.ts");
		await exec("mv", [await packSource(directory, rootPath), sourceArchive]);
		const packageDirectory = join(
			directory,
			"node_modules",
			"pi-docker-sandboxes",
		);
		await mkdir(packageDirectory, { recursive: true });
		await exec("tar", [
			"-xzf",
			sourceArchive,
			"--strip-components=1",
			"-C",
			packageDirectory,
		]);
		await chmod(packageDirectory, 0o555);
		const { packPackage, runImageCommand } = await import(
			pathToFileURL(join(packageDirectory, "dist", "image.js")).href
		);
		await assert.rejects(access(join(packageDirectory, ".source-checkout")));
		const output = join(directory, "output");
		await mkdir(output);
		const calls: string[][] = [];
		const archive = await packPackage(
			output,
			packageDirectory,
			async (
				command: string,
				args: string[],
				options: { cwd?: string; maxBuffer?: number } = {},
			) => {
				calls.push(args);
				return runImageCommand(command, args, options);
			},
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.[0], "pack");
		const { stdout: listing } = await exec("tar", ["-tf", archive]);
		assert.match(listing, /^package\/dist\/cli\.js$/m);
		assert.match(listing, /^package\/dist\/sbx\/inherited-runner\.mjs$/m);
	} finally {
		await chmod(
			join(directory, "node_modules", "pi-docker-sandboxes"),
			0o755,
		).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
	await assert.rejects(access(directory));
});

test("npm package includes the image lock contract", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-pack-"));
	try {
		const { stdout } = await exec(
			"npm",
			["pack", "--silent", "--pack-destination", directory],
			{ cwd: root },
		);
		const tarball = join(directory, stdout.trim());
		const { stdout: listing } = await exec("tar", ["-tf", tarball]);
		const files = new Set(listing.trim().split("\n"));
		assert.equal(files.has("package/docker/image-lock.json"), true);
		assert.equal(files.has("package/src/image-lock.ts"), true);
		assert.equal(files.has("package/dist/cli.js"), true);
		assert.equal(files.has("package/dist/image.js"), true);
		assert.equal(files.has("package/dist/sbx/inherited-runner.mjs"), true);
		assert.equal(files.has("package/scripts/verify-image.mjs"), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	await assert.rejects(access(directory));
});
