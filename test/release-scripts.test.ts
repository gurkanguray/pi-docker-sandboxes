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
const version = "1.2.3-alpha.1";
const piVersion = "0.84.1";
const digest = `sha256:${"a".repeat(64)}`;
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
	assert.equal(
		pkg.description,
		"Run Pi inside a Docker Sandboxes microVM",
	);
	assert.equal(pkg.packageManager, "npm@11.6.2");
	assert.equal(pkg.exports, undefined);
	assert.equal(
		pkg.peerDependencies["@earendil-works/pi-coding-agent"],
		">=0.84.1 <0.85.0",
	);
	// Pi's package-authoring docs require wildcard peers for its bundled
	// singleton/type packages so extensions reuse the host's module instances.
	for (const peer of [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-tui",
		"typebox",
	])
		assert.equal(pkg.peerDependencies[peer], "*");

	const { stdout } = await exec("npm", ["pack", "--dry-run", "--json"], {
		cwd: packageRoot,
	});
	const packed = JSON.parse(stdout)[0];
	const bin = packed.files.find(
		(file: { path: string }) => file.path === "bin/pi-dsbx.mjs",
	);
	assert.ok(bin, "npm pack must include bin/pi-dsbx.mjs");
	assert.notEqual(bin.mode & 0o111, 0, "packed bin must be executable");
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
			packageVersion: fixtureVersion,
			piVersion,
			publishedImage: `ghcr.io/example/pi@${digest}`,
		}),
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
				version: "9.8.7-alpha.1",
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
		const { stdout: packOutput } = await exec(
			"npm",
			["pack", "--json", source],
			{ cwd: directory },
		);
		const tarball = join(directory, JSON.parse(packOutput)[0].filename);
		const { stdout, stderr } = await exec(
			process.execPath,
			[freshInstallSmoke.pathname, tarball],
			{
				cwd: directory,
				env: {
					...process.env,
					OPENAI_API_KEY: "must-not-reach-smoke",
					PI_HOST_SECRET: "must-not-reach-smoke",
				},
			},
		);
		assert.equal(stderr, "");
		const receipt = JSON.parse(stdout.trim().split("\n").at(-1)!);
		assert.equal(receipt.version, "9.8.7-alpha.1");
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
			"v1.2.3-alpha.2",
		]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /tag.*v1\.2\.3-alpha\.1/i);
	}));

test("rejects package-lock root version mismatches", () =>
	withFixture(async (directory) => {
		const path = join(directory, "package-lock.json");
		for (const field of ["version", "packages"] as const) {
			const lock = JSON.parse(await readFile(path, "utf8"));
			lock.version = version;
			lock.packages[""].version = version;
			if (field === "version") lock.version = "1.2.3";
			else lock.packages[""].version = "1.2.3";
			await writeFile(path, JSON.stringify(lock));
			await git(directory, ["add", path]);
			await git(directory, ["commit", "--quiet", "-m", `mismatched ${field}`]);
			const result = await run(directory);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /package-lock.*1\.2\.3-alpha\.1/i);
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

test("rejects image-lock package and Pi version mismatches", () =>
	withFixture(async (directory) => {
		const path = join(directory, "docker", "image-lock.json");
		for (const [field, value, message] of [
			["packageVersion", "1.2.3", /image lock package.*1\.2\.3-alpha\.1/i],
			["piVersion", "0.83.0", /image lock Pi.*0\.84\.1/i],
		] as const) {
			const lock = JSON.parse(await readFile(path, "utf8"));
			lock.packageVersion = version;
			lock.piVersion = piVersion;
			lock[field] = value;
			await writeFile(path, JSON.stringify(lock));
			await git(directory, ["add", path]);
			await git(directory, ["commit", "--quiet", "-m", `bad ${field}`]);
			const result = await run(directory);
			assert.equal(result.code, 1);
			assert.match(result.stderr, message);
		}
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

test("release mode rejects missing and mutable published image references", () =>
	withFixture(async (directory) => {
		const path = join(directory, "docker", "image-lock.json");
		for (const publishedImage of [null, "ghcr.io/example/pi:1.2.3-alpha.1"]) {
			const lock = JSON.parse(await readFile(path, "utf8"));
			lock.publishedImage = publishedImage;
			await writeFile(path, JSON.stringify(lock));
			await git(directory, ["add", path]);
			await git(directory, ["commit", "--quiet", "-m", "bad image reference"]);
			const result = await run(directory, ["--tag", `v${version}`]);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /published image.*digest/i);
		}
	}));

test("allow-unreleased permits a missing published image digest", () =>
	withFixture(async (directory) => {
		const path = join(directory, "docker", "image-lock.json");
		const lock = JSON.parse(await readFile(path, "utf8"));
		lock.publishedImage = null;
		await writeFile(path, JSON.stringify(lock));
		await git(directory, ["add", path]);
		await git(directory, ["commit", "--quiet", "-m", "unreleased image"]);
		const result = await run(directory);
		assert.equal(result.code, 0, result.stderr);
	}));

test("allow-unreleased rejects a mutable published image", () =>
	withFixture(async (directory) => {
		const path = join(directory, "docker", "image-lock.json");
		const lock = JSON.parse(await readFile(path, "utf8"));
		lock.publishedImage = "ghcr.io/example/pi:latest";
		await writeFile(path, JSON.stringify(lock));
		await git(directory, ["add", path]);
		await git(directory, ["commit", "--quiet", "-m", "mutable image"]);
		const result = await run(directory);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /published image.*digest/i);
	}));

test("image candidate accepts its signed suffix with a missing image", () =>
	withFixture(async (directory) => {
		const path = join(directory, "docker", "image-lock.json");
		const lock = JSON.parse(await readFile(path, "utf8"));
		lock.publishedImage = null;
		await writeFile(path, JSON.stringify(lock));
		await git(directory, ["add", path]);
		await git(directory, ["commit", "--quiet", "-m", "image candidate"]);
		const tag = `v${version}-oci.1`;
		const signing = await signedTag(directory, tag);
		try {
			const result = await run(
				directory,
				["--image-candidate", "--tag", tag],
				signing.env,
			);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /✓ signed tag:/);
		} finally {
			await signing.cleanup();
		}
	}));

test("image candidate rejects a mutable published image", () =>
	withFixture(async (directory) => {
		const path = join(directory, "docker", "image-lock.json");
		const lock = JSON.parse(await readFile(path, "utf8"));
		lock.publishedImage = "ghcr.io/example/pi:latest";
		await writeFile(path, JSON.stringify(lock));
		await git(directory, ["add", path]);
		await git(directory, ["commit", "--quiet", "-m", "mutable candidate"]);
		const result = await run(directory, [
			"--image-candidate",
			"--tag",
			`v${version}-oci.1`,
		]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /published image.*digest/i);
	}));

test("release mode rejects an unsigned tag", () =>
	withFixture(async (directory) => {
		await git(directory, ["tag", `v${version}`]);
		const result = await run(directory, ["--tag", `v${version}`]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /git tag -v/);
	}));

test("release mode accepts a signed tag at HEAD", () =>
	withFixture(async (directory) => {
		const signing = await signedTag(directory);
		try {
			const result = await run(
				directory,
				["--tag", `v${version}`],
				signing.env,
			);
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
			const result = await run(
				directory,
				["--tag", `v${version}`],
				signing.env,
			);
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
		const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
		assert.deepEqual(Object.keys(receipt), [
			"tag",
			"version",
			"commit",
			"changelog",
			"imageLock",
			"imageCandidate",
			"clean",
		]);
		assert.equal(receipt.imageCandidate, false);
		assert.equal(receipt.tag, `v${version}`);
		assert.equal(receipt.version, version);
		assert.match(receipt.commit, /^[0-9a-f]{40}$/);
		assert.equal(receipt.changelog, `${version} — 2026-08-12`);
		assert.equal(receipt.imageLock, `ghcr.io/example/pi@${digest}`);
		assert.equal(receipt.clean, true);
		const after = await exec("git", ["diff", "HEAD", "--"], { cwd: directory });
		assert.equal(after.stdout, before.stdout);
		assert.equal(
			(await exec("git", ["status", "--porcelain"], { cwd: directory })).stdout,
			"",
		);
	}));
