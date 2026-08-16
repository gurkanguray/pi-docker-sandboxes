#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageName = "pi-docker-sandboxes";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(message) {
	throw new Error(message);
}

export function runCommand(command, args, options) {
	return new Promise((done) => {
		execFile(command, args, options, (error, stdout, stderr) =>
			done({
				command,
				args,
				exitCode: error
					? typeof error.code === "number"
						? error.code
						: -1
					: 0,
				error: error?.message,
				signal: error?.signal,
				stdout: stdout.trim(),
				stderr: stderr.trim(),
			}),
		);
	});
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const [argument] = process.argv.slice(2);
	if (!argument || process.argv.length !== 3)
		fail("Usage: node scripts/fresh-install-smoke.mjs <tarball-or-version>");

	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-fresh-install-"));
	const home = join(root, "home");
	const piHome = join(root, "pi-home");
	const prefix = join(root, "prefix");
	await Promise.all(
		[home, piHome, prefix].map((directory) =>
			mkdir(directory, { recursive: true }),
		),
	);
	const inputPath = resolve(argument);
	let artifact = argument;
	if (await exists(inputPath)) artifact = inputPath;
	else if (
		/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(argument)
	)
		artifact = `${packageName}@${argument.replace(/^v/, "")}`;
	const env = {
		HOME: home,
		LOGNAME: "pi-dsbx-smoke",
		PATH: process.env.PATH ?? "",
		PI_CODING_AGENT_DIR: piHome,
		TMPDIR: root,
		USER: "pi-dsbx-smoke",
		...(process.platform === "win32" && process.env.SystemRoot
			? { SystemRoot: process.env.SystemRoot }
			: {}),
	};
	const commands = [];
	let receipt;
	let failure;

	try {
		const metadata = await runCommand(
			npmCommand,
			["pack", "--dry-run", "--json", artifact],
			{ cwd: root, env },
		);
		if (metadata.exitCode !== 0)
			fail(metadata.stderr || "npm could not inspect the artifact");
		const packed = JSON.parse(metadata.stdout)[0];
		if (!packed?.integrity || !packed?.version)
			fail("npm did not return artifact version and integrity");
		if (packed.name !== packageName)
			fail(
				`Expected ${packageName} artifact, received ${packed.name ?? "unknown"}`,
			);

		const install = await runCommand(
			npmCommand,
			["install", "--ignore-scripts", "--prefix", prefix, artifact],
			{ cwd: root, env },
		);
		install.label = "install";
		commands.push(install);
		if (install.exitCode !== 0) fail("fresh install failed");

		const packageRoot = join(prefix, "node_modules", packed.name);
		const pkg = JSON.parse(
			await readFile(join(packageRoot, "package.json"), "utf8"),
		);
		const extensions = pkg.pi?.extensions ?? [];
		const extensionChecks = await Promise.all(
			extensions.map((extension) =>
				exists(join(packageRoot, extension.replace(/^\.\//, ""))),
			),
		);
		const piPackage = {
			extensions,
			verified: extensions.length > 0 && extensionChecks.every(Boolean),
		};
		if (!piPackage.verified)
			fail("installed artifact does not expose its declared Pi extension");

		const cli = join(
			prefix,
			"node_modules",
			".bin",
			process.platform === "win32" ? "pi-dsbx.cmd" : "pi-dsbx",
		);
		for (const [label, args] of [
			["pi-dsbx --help", ["--help"]],
			["pi-dsbx config", ["config"]],
			["pi-dsbx doctor", ["doctor"]],
		]) {
			const result = await runCommand(cli, args, { cwd: root, env });
			result.label = label;
			commands.push(result);
			// doctor intentionally reports unmet host prerequisites with exit 1;
			// reaching a diagnostic result is the credential-free smoke assertion.
			if (result.exitCode !== 0 && label !== "pi-dsbx doctor")
				fail(`${label} failed`);
			if (
				label === "pi-dsbx doctor" &&
				(![0, 1].includes(result.exitCode) || !result.stdout)
			)
				fail(`${label} did not complete diagnostics`);
		}

		const uninstall = await runCommand(
			npmCommand,
			["uninstall", "--ignore-scripts", "--prefix", prefix, packed.name],
			{ cwd: root, env },
		);
		uninstall.label = "uninstall";
		commands.push(uninstall);
		if (uninstall.exitCode !== 0) fail("fresh uninstall failed");

		receipt = {
			sourceSha: process.env.SOURCE_SHA ?? null,
			artifact,
			version: pkg.version,
			integrity: packed.integrity,
			platform: {
				os: process.platform,
				arch: process.arch,
				node: process.version,
			},
			piPackage,
			commands,
		};
	} catch (error) {
		failure = error;
	} finally {
		const installedPackage = receipt
			? join(prefix, "node_modules", packageName)
			: undefined;
		const packageRemoved = installedPackage
			? !(await exists(installedPackage))
			: true;
		await rm(root, { recursive: true, force: true });
		if (receipt) {
			receipt.cleanup = {
				packageRemoved,
				prefixRemoved: !(await exists(prefix)),
				piHomeRemoved: !(await exists(piHome)),
			};
			console.log(`Fresh-install smoke passed: ${basename(artifact)}`);
			console.log(JSON.stringify(receipt));
		}
	}

	if (failure)
		fail(
			`Fresh-install smoke failed: ${failure instanceof Error ? failure.message : failure}`,
		);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	await main();
