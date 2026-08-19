import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
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
const script = new URL("../scripts/check-release.mjs", import.meta.url);
const packageVerifier = new URL(
	"../scripts/verify-package.mjs",
	import.meta.url,
);
const tarballAssertion = new URL(
	"../scripts/assert-one-tarball.mjs",
	import.meta.url,
);
const freshInstallSmoke = new URL(
	"../scripts/fresh-install-smoke.mjs",
	import.meta.url,
);
const version = "1.2.3";
const piVersion = "0.84.1";
const baseImage =
	"docker/sandbox-templates@sha256:d86a6cdc105a1b299667a20c40bcf8d0584e56f21d44490a0737bb1baeb44299";
const packageRoot = new URL("../", import.meta.url);

test("public package metadata and packed CLI are release-ready", async () => {
	const pkg = JSON.parse(
		await readFile(new URL("package.json", packageRoot), "utf8"),
	);
	assert.deepEqual(pkg.repository, {
		type: "git",
		url: "git+https://github.com/gurkanguray/pi-docker-sandboxes.git",
	});
	assert.equal(
		pkg.homepage,
		"https://github.com/gurkanguray/pi-docker-sandboxes#readme",
	);
	assert.equal(
		pkg.bugs?.url,
		"https://github.com/gurkanguray/pi-docker-sandboxes/issues",
	);
	assert.equal(pkg.author, "Guray Gurkan");
	assert.equal(pkg.description, "Run Pi inside a Docker Sandboxes microVM");
	assert.equal(pkg.packageManager, "npm@11.6.2");
	assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
	assert.ok(pkg.keywords.includes("pi-package"));
	assert.deepEqual(pkg.pi.extensions, [
		"./extensions/docker-sandboxes/index.ts",
	]);
	assert.equal(pkg.exports, undefined);
	assert.equal(
		pkg.peerDependencies["@earendil-works/pi-coding-agent"],
		">=0.84.1 <0.85.0",
	);
	for (const peer of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-tui",
	])
		assert.equal(pkg.peerDependencies[peer], ">=0.84.1 <0.85.0");
	assert.equal(pkg.peerDependencies.typebox, "*");

	const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], {
		cwd: packageRoot,
	});
	const packed = JSON.parse(stdout)[0];
	const bin = packed.files.find(
		(file: { path: string }) => file.path === "bin/pi-dsbx.mjs",
	);
	assert.ok(bin, "npm pack must include bin/pi-dsbx.mjs");
	assert.notEqual(bin.mode & 0o111, 0, "packed bin must be executable");
	assert.ok(
		packed.files.some(
			(file: { path: string }) =>
				file.path === "extensions/docker-sandboxes/index.ts",
		),
		"npm pack must include the Pi extension",
	);
});

async function git(
	directory: string,
	args: string[],
	env = process.env,
): Promise<void> {
	await exec("git", args, { cwd: directory, env });
}

async function fixture(fixtureVersion = version): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-release-"));
	await mkdir(join(directory, "docker"));
	await writeFile(
		join(directory, "package.json"),
		JSON.stringify({
			name: "pi-docker-sandboxes",
			version: fixtureVersion,
			devDependencies: { "@earendil-works/pi-coding-agent": piVersion },
		}),
	);
	await writeFile(
		join(directory, "package-lock.json"),
		JSON.stringify({
			name: "pi-docker-sandboxes",
			version: fixtureVersion,
			packages: {
				"": {
					name: "pi-docker-sandboxes",
					version: fixtureVersion,
					devDependencies: { "@earendil-works/pi-coding-agent": piVersion },
				},
			},
		}),
	);
	await writeFile(
		join(directory, "CHANGELOG.md"),
		`# Changelog\n\n## ${fixtureVersion} — 2026-08-12\n`,
	);
	await writeFile(
		join(directory, "COMPATIBILITY.md"),
		`# Compatibility\n\n| Component | Tested | Status |\n|---|---|---|\n| Pi | ${piVersion} | tested |\n`,
	);
	await writeFile(
		join(directory, "docker", "image-lock.json"),
		JSON.stringify({
			piVersion,
			images: {
				standard: {
					status: "published",
					reference: `ghcr.io/example/runtime@sha256:${"a".repeat(64)}`,
					platforms: ["linux/amd64", "linux/arm64"],
					privileged: false,
				},
				docker: { status: "unpublished" },
			},
		}),
	);
	await writeFile(
		join(directory, "docker", "runtime-lock.json"),
		JSON.stringify({ bases: { docker: baseImage } }),
	);
	await writeFile(
		join(directory, "docker", "runtime-release-lock.json"),
		JSON.stringify({
			version: 1,
			runId: 123,
			runAttempt: 1,
			sourceSha: "b".repeat(40),
			receiptArtifact: "receipt-123-1",
			securityArtifacts: [
				"security-amd64-standard-123-1",
				"security-arm64-standard-123-1",
			],
		}),
	);
	await writeFile(
		join(directory, ".trivyignore.yaml"),
		await readFile(new URL(".trivyignore.yaml", packageRoot)),
	);
	await git(directory, ["init", "--quiet"]);
	await git(directory, ["config", "user.name", "Release Test"]);
	await git(directory, ["config", "user.email", "release@example.invalid"]);
	await git(directory, ["add", "."]);
	await git(directory, ["commit", "--quiet", "-m", "fixture"]);
	return directory;
}

async function run(
	directory: string,
	args = ["--allow-unreleased", "--tag", `v${version}`],
	env = process.env,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[script.pathname, ...args],
			{ cwd: directory, env },
			(error, stdout, stderr) => {
				resolve({
					code: typeof error?.code === "number" ? error.code : 0,
					stdout,
					stderr,
				});
			},
		);
	});
}

async function withFixture(
	check: (directory: string) => Promise<void>,
	fixtureVersion = version,
): Promise<void> {
	const directory = await fixture(fixtureVersion);
	try {
		await check(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function executableCanary(
	directory: string,
	name: string,
): Promise<{ executable: string; marker: string }> {
	const executable = join(directory, `${name}.mjs`);
	const marker = join(directory, `${name}.invoked`);
	await writeFile(
		executable,
		`#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "invoked\\n");\nprocess.exit(1);\n`,
	);
	await chmod(executable, 0o755);
	return { executable, marker };
}

async function signedTag(
	directory: string,
	tag = `v${version}`,
): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
	const home = await mkdtemp("/tmp/rgpg-");
	await chmod(home, 0o700);
	const env = { ...process.env, GNUPGHOME: home };
	try {
		await exec(
			"gpg",
			[
				"--batch",
				"--passphrase",
				"",
				"--quick-generate-key",
				"Release Test <release@example.invalid>",
				"ed25519",
				"sign",
				"0",
			],
			{ env },
		);
		const { stdout } = await exec(
			"gpg",
			["--batch", "--with-colons", "--list-secret-keys"],
			{ env },
		);
		const fingerprint = stdout
			.split("\n")
			.find((line) => line.startsWith("fpr:"))
			?.split(":")[9];
		assert.ok(fingerprint, "throwaway GPG key must have a fingerprint");
		await git(directory, ["config", "user.signingkey", fingerprint], env);
		const { stdout: publicKey } = await exec(
			"gpg",
			["--batch", "--armor", "--export", fingerprint],
			{ env },
		);
		await mkdir(join(directory, "docs"), { recursive: true });
		await writeFile(join(directory, "docs", "release-signing.asc"), publicKey);
		await git(directory, ["add", "docs/release-signing.asc"], env);
		await git(directory, ["commit", "--quiet", "-m", "release key"], env);
		await git(directory, ["tag", "-s", tag, "-m", tag], env);
		await exec("git", ["tag", "-v", tag], { cwd: directory, env });
		return {
			env,
			cleanup: () => rm(home, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(home, { recursive: true, force: true });
		throw error;
	}
}

async function packageFixture(
	options: {
		bin?: boolean;
		executable?: boolean;
		exports?: unknown;
		private?: boolean;
		unsupportedExport?: boolean;
		unexpected?: boolean;
	} = {},
): Promise<{ directory: string; tarball: string }> {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-package-"));
	const source = join(directory, "source");
	await mkdir(join(source, "bin"), { recursive: true });
	await writeFile(
		join(source, "package.json"),
		JSON.stringify({
			name: "pi-dsbx-package-fixture",
			version: "1.0.0",
			files: options.unexpected ? ["bin/"] : ["bin/", "README.md"],
			bin: { "pi-dsbx": "./bin/pi-dsbx.mjs" },
			...(options.exports === undefined ? {} : { exports: options.exports }),
			...(options.private === undefined ? {} : { private: options.private }),
		}),
	);
	await writeFile(
		join(source, "README.md"),
		options.unsupportedExport
			? "# Fixture\n\nThe programmatic root export is unsupported and unstable.\n"
			: "# Fixture\n",
	);
	if (options.bin !== false) {
		const bin = join(source, "bin", "pi-dsbx.mjs");
		await writeFile(
			bin,
			'#!/usr/bin/env node\nif (process.argv.includes("--help")) console.log("fixture help");\n',
		);
		await chmod(bin, options.executable === false ? 0o644 : 0o755);
	}

	const { stdout } = await exec("npm", ["pack", "--json", source], {
		cwd: directory,
	});
	const packed = JSON.parse(stdout)[0];
	return { directory, tarball: join(directory, packed.filename) };
}

async function verifyPackage(
	directory: string,
	tarball: string,
	receipt?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[
				packageVerifier.pathname,
				tarball,
				...(receipt ? ["--receipt", receipt] : []),
			],
			{ cwd: directory },
			(error, stdout, stderr) => {
				resolve({
					code: typeof error?.code === "number" ? error.code : 0,
					stdout,
					stderr,
				});
			},
		);
	});
}

async function withPackageFixture(
	options: Parameters<typeof packageFixture>[0],
	check: (fixture: { directory: string; tarball: string }) => Promise<void>,
): Promise<void> {
	const fixture = await packageFixture(options);
	try {
		await check(fixture);
	} finally {
		await rm(fixture.directory, { recursive: true, force: true });
	}
}

test("package verifier rejects files outside the documented allowlist", () =>
	withPackageFixture({ unexpected: true }, async ({ directory, tarball }) => {
		const result = await verifyPackage(directory, tarball);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /unexpected package file.*README\.md/i);
	}));

test("package verifier rejects a missing or non-executable bin", async () => {
	for (const options of [{ bin: false }, { executable: false }])
		await withPackageFixture(options, async ({ directory, tarball }) => {
			const result = await verifyPackage(directory, tarball);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /bin\/pi-dsbx\.mjs.*(?:missing|executable)/i);
		});
});

test("package verifier rejects every consumer-usable undocumented root export", async () => {
	for (const exports of [
		"./index.js",
		{ import: "./index.js", require: "./index.cjs" },
		{ ".": "./index.js" },
	])
		await withPackageFixture({ exports }, async ({ directory, tarball }) => {
			const result = await verifyPackage(directory, tarball);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /stable programmatic root export/i);
		});
});

test("package verifier permits a root export documented as unsupported", () =>
	withPackageFixture(
		{ exports: { ".": "./index.js" }, unsupportedExport: true },
		async ({ directory, tarball }) => {
			const result = await verifyPackage(directory, tarball);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /root export: documented as unsupported/);
		},
	));

test("private alone does not make a consumer-usable root export safe", () =>
	withPackageFixture(
		{ exports: "./index.js", private: true },
		async ({ directory, tarball }) => {
			const result = await verifyPackage(directory, tarball);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /stable programmatic root export/i);
		},
	));

test("package verifier permits no root export without an unsupported marker", () =>
	withPackageFixture(
		{ exports: { "./feature": "./feature.js" } },
		async ({ directory, tarball }) => {
			const result = await verifyPackage(directory, tarball);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /root export: not advertised/);
		},
	));

test("package verifier installs, runs the CLI, and writes a JSON receipt", () =>
	withPackageFixture({}, async ({ directory, tarball }) => {
		const receiptPath = join(directory, "package-verification.json");
		const result = await verifyPackage(directory, tarball, receiptPath);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /✓ installed package:/);
		assert.match(result.stdout, /✓ pi-dsbx --help: fixture help/);
		const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
		assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);
		assert.deepEqual(Object.keys(receipt), [
			"filename",
			"integrity",
			"files",
			"binVersion",
			"installRoot",
		]);
		assert.equal(receipt.filename, tarball);
		assert.match(receipt.integrity, /^sha512-/);
		assert.deepEqual(receipt.files, [...receipt.files].sort());
		assert.deepEqual(receipt.files, [
			"README.md",
			"bin/pi-dsbx.mjs",
			"package.json",
		]);
		assert.equal(receipt.binVersion, "1.0.0");
		assert.match(receipt.installRoot, /pi-dsbx-package-verify-/);
	}));

test("published smoke uses exact Pi install, remove, reinstall, and cleanup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-published-smoke-"));
	const npm = join(directory, "npm");
	const pi = join(directory, "pi");
	try {
		await writeFile(
			npm,
			`#!/bin/sh
printf '%s\\n' '[{"name":"pi-docker-sandboxes","version":"9.8.7","integrity":"sha512-test"}]'
`,
		);
		await writeFile(
			pi,
			`#!/usr/bin/env node
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const agentDir = process.env.PI_CODING_AGENT_DIR;
const root = join(agentDir, "npm", "node_modules", "pi-docker-sandboxes");
const settings = join(agentDir, "settings.json");
if (process.argv[2] === "install") {
  mkdirSync(join(root, "extensions", "fixture"), { recursive: true });
  mkdirSync(join(root, "dist", "sbx"), { recursive: true });
  writeFileSync(join(root, "extensions", "fixture", "index.js"), "export default {};");
  writeFileSync(join(root, "dist", "launch.js"), "export async function launch() { return { agentExitCode: 0, custody: 'released' }; }");
  writeFileSync(join(root, "dist", "sbx", "client.js"), "export class SbxClient {}");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pi-docker-sandboxes", version: "9.8.7", type: "module", pi: { extensions: ["extensions/fixture/index.js"] } }));
  writeFileSync(settings, JSON.stringify({ packages: [process.argv[3]] }));
} else if (process.argv[2] === "remove") {
  rmSync(root, { recursive: true, force: true });
  writeFileSync(settings, JSON.stringify({ packages: [] }));
} else {
  if (process.argv.includes("--docker-sandbox"))
    console.error("pi-dsbx: checking Docker Sandboxes");
  console.log("--docker-sandbox --docker-sandbox-no-host-auth");
}
`,
		);
		await chmod(npm, 0o755);
		await chmod(pi, 0o755);
		const { stdout } = await exec(
			process.execPath,
			[freshInstallSmoke.pathname, "--published", "9.8.7"],
			{
				env: {
					...process.env,
					PATH: `${directory}:${process.env.PATH}`,
					PI_COMMAND: pi,
					PI_RELEASE_RUNTIME_IMAGE: `docker.io/example/runtime@sha256:${"a".repeat(64)}`,
					PI_RELEASE_TEMPLATE_STORE_ID: "abcdef123456",
				},
			},
		);
		const receipt = JSON.parse(stdout.trim().split("\n").at(-1)!);
		assert.equal(receipt.actualPiInstall, true);
		assert.equal(receipt.exactInstallSource, "npm:pi-docker-sandboxes@9.8.7");
		assert.equal(receipt.packageRecordVerified, true);
		assert.equal(receipt.extensionFlagsVerified, true);
		assert.equal(receipt.extensionDispatchVerified, true);
		assert.equal(receipt.launchPathVerified, true);
		assert.equal(receipt.runtimeLaunches, 1);
		assert.deepEqual(
			receipt.commands.map(({ label }: { label: string }) => label),
			[
				"pi install exact npm version",
				"pi extension launch",
				"installed Pi extension dispatch",
				"pi remove exact npm version",
				"pi reinstall exact npm version",
				"pi final cleanup",
			],
		);
		assert.deepEqual(receipt.commands[2].args, [
			"--docker-sandbox",
			"--docker-sandbox-no-host-auth",
			"--yes",
			"--help",
		]);
		assert.deepEqual(receipt.cleanup, {
			packageRemoved: true,
			packageRecordRemoved: true,
			prefixRemoved: true,
			piHomeRemoved: true,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("fresh install smoke records signal failures as nonzero", async () => {
	// @ts-expect-error The release script is plain JavaScript without declarations.
	const { runCommand } = await import("../scripts/fresh-install-smoke.mjs");
	const result = await runCommand(
		process.execPath,
		["-e", 'console.log("started"); process.kill(process.pid, "SIGTERM")'],
		{},
	);
	assert.notEqual(result.exitCode, 0);
	assert.equal(result.signal, "SIGTERM");
	assert.match(result.error, /SIGTERM/);
});

test("fresh install smoke isolates Pi, exercises the CLI, and cleans up", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-fresh-fixture-"));
	const source = join(directory, "source");
	try {
		await mkdir(join(source, "bin"), { recursive: true });
		await mkdir(join(source, "extensions", "fixture"), { recursive: true });
		await writeFile(
			join(source, "package.json"),
			JSON.stringify({
				name: "pi-docker-sandboxes",
				version: "9.8.7",
				bin: { "pi-dsbx": "bin/pi-dsbx.mjs" },
				pi: { extensions: ["extensions/fixture/index.js"] },
				files: ["bin/", "extensions/"],
			}),
		);
		await writeFile(
			join(source, "extensions", "fixture", "index.js"),
			"export default function fixture() {}\n",
		);
		const bin = join(source, "bin", "pi-dsbx.mjs");
		await writeFile(
			bin,
			`#!/usr/bin/env node
const command = process.argv[2] ?? "--help";
if (process.env.OPENAI_API_KEY || process.env.PI_HOST_SECRET) process.exit(71);
if (command === "--help") console.log("fixture help");
else console.log(JSON.stringify({ command, home: process.env.HOME, piHome: process.env.PI_CODING_AGENT_DIR }));
if (command === "doctor") process.exitCode = 1;
`,
		);
		await chmod(bin, 0o755);
		const { stdout: packOutput } = await exec("npm", ["pack", "--json", source], {
			cwd: directory,
		});
		const tarball = join(directory, JSON.parse(packOutput)[0].filename);
		const { stdout, stderr } = await exec(
			process.execPath,
			[freshInstallSmoke.pathname, tarball],
			{
				cwd: directory,
				env: {
					...process.env,
					SOURCE_SHA: "a".repeat(40),
					OPENAI_API_KEY: "must-not-reach-smoke",
					PI_HOST_SECRET: "must-not-reach-smoke",
				},
			},
		);
		assert.equal(stderr, "");
		const receipt = JSON.parse(stdout.trim().split("\n").at(-1)!);
		assert.equal(receipt.sourceSha, "a".repeat(40));
		assert.equal(receipt.version, "9.8.7");
		assert.match(receipt.integrity, /^sha512-/);
		assert.deepEqual(receipt.platform, {
			os: process.platform,
			arch: process.arch,
			node: process.version,
		});
		assert.deepEqual(receipt.piPackage, {
			extensions: ["extensions/fixture/index.js"],
			verified: true,
		});
		assert.deepEqual(
			receipt.commands.map((entry: { label: string; exitCode: number }) => [
				entry.label,
				entry.exitCode,
			]),
			[
				["install", 0],
				["pi-dsbx --help", 0],
				["pi-dsbx config", 0],
				["pi-dsbx doctor", 1],
				["uninstall", 0],
			],
		);
		assert.ok(
			receipt.commands.every(
				(entry: { command: string; args: string[] }) =>
					typeof entry.command === "string" && Array.isArray(entry.args),
			),
		);
		const config = JSON.parse(receipt.commands[2].stdout);
		assert.match(config.home, /pi-dsbx-fresh-install-/);
		assert.match(config.piHome, /pi-dsbx-fresh-install-/);
		assert.equal(stdout.includes("must-not-reach-smoke"), false);
		assert.deepEqual(receipt.cleanup, {
			packageRemoved: true,
			packageRecordRemoved: true,
			prefixRemoved: true,
			piHomeRemoved: true,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function assertOneTarball(directory: string): Promise<{
	code: number;
	stdout: string;
	stderr: string;
}> {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[tarballAssertion.pathname, directory],
			(error, stdout, stderr) =>
				resolve({
					code: typeof error?.code === "number" ? error.code : 0,
					stdout,
					stderr,
				}),
		);
	});
}

test("tarball assertion requires exactly one tgz and ignores other entries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-tarballs-"));
	try {
		let result = await assertOneTarball(directory);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /exactly one.*\.tgz/i);

		await writeFile(join(directory, "one.tgz"), "one");
		result = await assertOneTarball(directory);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), join(directory, "one.tgz"));

		await writeFile(join(directory, "two.tgz"), "two");
		result = await assertOneTarball(directory);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /exactly one.*\.tgz/i);

		await rm(join(directory, "two.tgz"));
		await writeFile(join(directory, "receipt.json"), "{}");
		await mkdir(join(directory, "compiled-leftovers"));
		result = await assertOneTarball(directory);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(result.stdout.trim(), join(directory, "one.tgz"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects a tag that does not exactly match the package version", () =>
	withFixture(async (directory) => {
		const result = await run(directory, [
			"--allow-unreleased",
			"--tag",
			"v1.2.4",
		]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /tag.*v1\.2\.3/i);
	}));

test("rejects package-lock root version mismatches", () =>
	withFixture(async (directory) => {
		const path = join(directory, "package-lock.json");
		for (const field of ["version", "packages"] as const) {
			const lock = JSON.parse(await readFile(path, "utf8"));
			lock.version = version;
			lock.packages[""].version = version;
			if (field === "version") lock.version = "1.2.4";
			else lock.packages[""].version = "1.2.4";
			await writeFile(path, JSON.stringify(lock));
			await git(directory, ["add", path]);
			await git(directory, ["commit", "--quiet", "-m", `mismatched ${field}`]);
			const result = await run(directory);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /package-lock.*1\.2\.3/i);
		}
	}));

test("rejects invalid SemVer leading zeros", async () => {
	for (const invalid of ["01.2.3", "1.02.3", "1.2.03", "1.2.3-01"])
		await withFixture(async (directory) => {
			const result = await run(directory, [
				"--allow-unreleased",
				"--tag",
				`v${invalid}`,
			]);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /not exact semver/i);
		}, invalid);
});

test("rejects prerelease versions because major zero already signals development", () =>
	withFixture(async (directory) => {
		const prerelease = "1.2.3-rc.1";
		const result = await run(directory, [
			"--allow-unreleased",
			"--tag",
			`v${prerelease}`,
		]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /not exact semver/i);
	}, "1.2.3-rc.1"));

test("rejects a changelog without the package version and date", () =>
	withFixture(async (directory) => {
		const path = join(directory, "CHANGELOG.md");
		await writeFile(path, `# Changelog\n\n## ${version}\n`);
		await git(directory, ["add", path]);
		await git(directory, ["commit", "--quiet", "-m", "bad changelog"]);
		const result = await run(directory);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /CHANGELOG.*date/i);
	}));

test("rejects image-lock Pi version and mutable standard runtime", async () => {
	for (const mutate of [
		(lock: any) => {
			lock.piVersion = "0.83.0";
		},
		(lock: any) => {
			lock.images.standard.reference = "ghcr.io/example/runtime:latest";
		},
	])
		await withFixture(async (directory) => {
			const path = join(directory, "docker", "image-lock.json");
			const lock = JSON.parse(await readFile(path, "utf8"));
			mutate(lock);
			await writeFile(path, JSON.stringify(lock));
			await git(directory, ["add", path]);
			await git(directory, ["commit", "--quiet", "-m", "bad runtime lock"]);
			const result = await run(directory);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /image lock Pi|immutable GHCR digest/i);
		});
});

test("rejects incomplete or standard-authorizing CVE risk records", async () => {
	for (const mutate of [
		(record: any) => {
			delete record.owner;
		},
		(record: any) => {
			record.variant = "standard";
		},
		(record: any) => {
			record.expiry = "2026-08-18";
		},
	])
		await withFixture(async (directory) => {
			const path = join(directory, ".trivyignore.yaml");
			const policy = JSON.parse(await readFile(path, "utf8"));
			mutate(policy.vulnerabilities[0]);
			await writeFile(path, JSON.stringify(policy));
			await git(directory, ["add", path]);
			await git(directory, ["commit", "--quiet", "-m", "bad risk record"]);
			const result = await run(directory);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /risk record|standard runtime|expired/i);
		});
});

test("rejects broad Trivy exception paths", () =>
	withFixture(async (directory) => {
		const path = join(directory, ".trivyignore.yaml");
		for (const paths of [[], ["*"], ["../usr/bin/docker"], ["/usr/bin/docker"]]) {
			const policy = JSON.parse(await readFile(path, "utf8"));
			policy.vulnerabilities[0].paths = paths;
			await writeFile(path, JSON.stringify(policy));
			await git(directory, ["add", path]);
			await git(directory, ["commit", "--quiet", "-m", "broad policy path"]);
			const result = await run(directory);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /Trivy exception.*scoped path/i);
		}
	}));

test("rejects overdue CVE next review", () =>
	withFixture(async (directory) => {
		const path = join(directory, ".trivyignore.yaml");
		const policy = JSON.parse(await readFile(path, "utf8"));
		policy.vulnerabilities[0].nextReview = "2026-08-18";
		await writeFile(path, JSON.stringify(policy));
		await git(directory, ["add", path]);
		await git(directory, ["commit", "--quiet", "-m", "overdue review"]);
		const result = await run(directory);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /overdue next review/i);
	}));

test("rejects a dirty tracked worktree", () =>
	withFixture(async (directory) => {
		await writeFile(
			join(directory, "CHANGELOG.md"),
			`# Changelog\n\n## ${version} — 2026-08-12\n\nmodified\n`,
		);
		const result = await run(directory);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /tracked worktree.*clean/i);
	}));

test("release mode rejects an unsigned tag", () =>
	withFixture(async (directory) => {
		await git(directory, ["tag", `v${version}`]);
		const result = await run(directory, ["--tag", `v${version}`]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /release signing key|git tag -v/i);
	}));

test("release check never executes a repository fsmonitor", () =>
	withFixture(async (directory) => {
		const canary = await executableCanary(directory, "fsmonitor-canary");
		await git(directory, ["config", "core.fsmonitor", canary.executable]);
		const result = await run(directory);
		assert.equal(result.code, 0, result.stderr);
		await assert.rejects(readFile(canary.marker, "utf8"));
	}));

test("release mode verifies signed tags without a repository verifier", () =>
	withFixture(async (directory) => {
		const signing = await signedTag(directory);
		const canary = await executableCanary(directory, "verifier-canary");
		try {
			await git(directory, ["config", "gpg.format", "ssh"]);
			await git(directory, ["config", "gpg.program", canary.executable]);
			await git(directory, ["config", "gpg.ssh.program", canary.executable]);
			const result = await run(directory, ["--tag", `v${version}`], signing.env);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /✓ signed tag:/);
			await assert.rejects(readFile(canary.marker, "utf8"));
		} finally {
			await signing.cleanup();
		}
	}));

test("release mode accepts a signed tag at HEAD", () =>
	withFixture(async (directory) => {
		const signing = await signedTag(directory);
		try {
			const result = await run(directory, ["--tag", `v${version}`], signing.env);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /✓ signed tag:/);
		} finally {
			await signing.cleanup();
		}
	}));

test("release mode rejects a signed tag behind HEAD", () =>
	withFixture(async (directory) => {
		const signing = await signedTag(directory);
		try {
			await writeFile(join(directory, "later.txt"), "later\n");
			await git(directory, ["add", "later.txt"], signing.env);
			await git(directory, ["commit", "--quiet", "-m", "later"], signing.env);
			const result = await run(directory, ["--tag", `v${version}`], signing.env);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /signed tag.*point to HEAD/i);
		} finally {
			await signing.cleanup();
		}
	}));

test("succeeds without mutating tracked fixture files", () =>
	withFixture(async (directory) => {
		const before = await exec("git", ["diff", "HEAD", "--"], {
			cwd: directory,
		});
		const result = await run(directory);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /✓ tag\/version:/);
		assert.match(
			result.stdout,
			/✓ legacy-only CVE risk records: 12 CVEs \/ 64 scoped paths/,
		);
		const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
		assert.deepEqual(Object.keys(receipt), [
			"tag",
			"version",
			"commit",
			"changelog",
			"clean",
		]);
		assert.equal(receipt.tag, `v${version}`);
		assert.equal(receipt.version, version);
		assert.match(receipt.commit, /^[0-9a-f]{40}$/);
		assert.equal(receipt.changelog, `${version} — 2026-08-12`);
		assert.equal(receipt.clean, true);
		const after = await exec("git", ["diff", "HEAD", "--"], { cwd: directory });
		assert.equal(after.stdout, before.stdout);
		assert.equal(
			(await exec("git", ["status", "--porcelain"], { cwd: directory })).stdout,
			"",
		);
	}));
