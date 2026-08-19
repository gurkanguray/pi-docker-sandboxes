import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = new URL("..", import.meta.url);

test("runtime doctor ranges match package requirements", async () => {
	const manifest = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	const metadata = await import("../src/package-metadata.ts");
	assert.equal(metadata.NODE_RANGE, manifest.engines.node);
	assert.equal(
		metadata.HOST_PI_RANGE,
		manifest.peerDependencies["@earendil-works/pi-coding-agent"],
	);
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
