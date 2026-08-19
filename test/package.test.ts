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

const exec = promisify(execFile);
const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);

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
		await cp(join(rootPath, "runtime"), join(source, "runtime"), {
			recursive: true,
		});
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
				return true;
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
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
		);
		await assert.rejects(access(join(packageDirectory, ".source-checkout")));
	} finally {
		await chmod(
			join(directory, "node_modules", "pi-docker-sandboxes"),
			0o755,
		).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

test("installed read-only package repacks without scripts or a compiler", async () => {
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
		const { stdout: listing } = await exec("tar", ["-tf", archive]);
		assert.match(listing, /^package\/dist\/cli\.js$/m);
	} finally {
		await chmod(
			join(directory, "node_modules", "pi-docker-sandboxes"),
			0o755,
		).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
});

test("npm package includes the image lock and standalone runtime contracts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-pack-"));
	try {
		const { stdout } = await exec(
			"npm",
			["pack", "--silent", "--pack-destination", directory],
			{ cwd: root },
		);
		const { stdout: listing } = await exec("tar", [
			"-tf",
			join(directory, stdout.trim()),
		]);
		const files = new Set(listing.trim().split("\n"));
		assert.equal(files.has("package/docker/image-lock.json"), true);
		assert.equal(files.has("package/docker/runtime-lock.json"), true);
		assert.equal(
			files.has("package/docker/runtime-release-lock.json"),
			true,
		);
		assert.equal(files.has("package/docker/runtime-package.json"), true);
		assert.equal(files.has("package/docker/runtime-package-lock.json"), true);
		assert.equal(files.has("package/src/image-lock.ts"), true);
		assert.equal(files.has("package/src/platform.ts"), true);
		assert.equal(files.has("package/src/state-schema.ts"), true);
		assert.equal(files.has("package/dist/cli.js"), true);
		assert.equal(files.has("package/runtime/extension.mjs"), true);
		assert.equal(files.has("package/runtime/package.json"), true);
		assert.equal(files.has("package/scripts/verify-image.mjs"), false);
		const { stdout: runtimeSource } = await exec("tar", [
			"-xOf",
			join(directory, stdout.trim()),
			"package/runtime/extension.mjs",
		]);
		assert.doesNotMatch(
			runtimeSource,
			/(?:from\s+|import\s*\()["'][^"']*(?:src\/(?:launch|image|workspace|config)|image-lock|host-auth)[^"']*["']/,
		);
		const { stdout: dockerfile } = await exec("tar", [
			"-xOf",
			join(directory, stdout.trim()),
			"package/docker/runtime.Dockerfile",
		]);
		assert.doesNotMatch(dockerfile, /pi-docker-sandboxes\.tgz/);
		assert.doesNotMatch(dockerfile, /node_modules\/pi-docker-sandboxes/);
		assert.doesNotMatch(dockerfile, /apt-get/);
		assert.match(dockerfile, /runtime-package-lock\.json/);
		assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
		assert.match(dockerfile, /sha256sum --check/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
