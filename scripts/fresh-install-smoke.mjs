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
				exitCode: error ? (typeof error.code === "number" ? error.code : -1) : 0,
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

async function hasPackageRecord(piHome, source) {
	const settings = await readFile(join(piHome, "settings.json"), "utf8")
		.then(JSON.parse)
		.catch(() => ({}));
	return (settings.packages ?? []).some(
		(entry) => (typeof entry === "string" ? entry : entry?.source) === source,
	);
}

async function main() {
	const args = process.argv.slice(2);
	const published = args[0] === "--published";
	const argument = published ? args[1] : args[0];
	if (!argument || args.length !== (published ? 2 : 1))
		fail(
			"Usage: node scripts/fresh-install-smoke.mjs [--published] <tarball-or-version>",
		);
	if (published && !/^\d+\.\d+\.\d+$/.test(argument))
		fail("Published Pi install verification requires an exact stable version");

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
	const npmUserConfig = join(root, "npmrc");
	await import("node:fs/promises").then(({ writeFile }) =>
		writeFile(npmUserConfig, "registry=https://registry.npmjs.org/\n"),
	);
	const env = {
		HOME: home,
		LOGNAME: "pi-dsbx-smoke",
		NPM_CONFIG_USERCONFIG: npmUserConfig,
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

		const installSource = `npm:${packageName}@${packed.version}`;
		const piCommand = process.env.PI_COMMAND ?? "pi";
		const install = published
			? await runCommand(piCommand, ["install", installSource], { cwd: root, env })
			: await runCommand(
					npmCommand,
					["install", "--ignore-scripts", "--prefix", prefix, artifact],
					{ cwd: root, env },
				);
		install.label = published ? "pi install exact npm version" : "install";
		commands.push(install);
		if (install.exitCode !== 0) fail("fresh install failed");

		const packageRoot = published
			? join(piHome, "npm", "node_modules", packed.name)
			: join(prefix, "node_modules", packed.name);
		if (published && !(await hasPackageRecord(piHome, installSource)))
			fail("Pi did not record the exact installed package source");
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
			published ? join(piHome, "npm") : prefix,
			"node_modules",
			".bin",
			process.platform === "win32" ? "pi-dsbx.cmd" : "pi-dsbx",
		);
		const smokeCommands = published
			? [["pi extension launch", piCommand, ["--help"]]]
			: [
					["pi-dsbx --help", cli, ["--help"]],
					["pi-dsbx config", cli, ["config"]],
					["pi-dsbx doctor", cli, ["doctor"]],
				];
		for (const [label, command, args] of smokeCommands) {
			const result = await runCommand(command, args, { cwd: root, env });
			result.label = label;
			commands.push(result);
			// doctor intentionally reports unmet host prerequisites with exit 1;
			// reaching a diagnostic result is the credential-free smoke assertion.
			if (result.exitCode !== 0 && label !== "pi-dsbx doctor")
				fail(`${label} failed`);
			if (
				label === "pi extension launch" &&
				(!result.stdout.includes("--docker-sandbox") ||
					!result.stdout.includes("--docker-sandbox-no-host-auth"))
			)
				fail("Pi did not discover the installed extension flags");
			if (
				label === "pi-dsbx doctor" &&
				(![0, 1].includes(result.exitCode) || !result.stdout)
			)
				fail(`${label} did not complete diagnostics`);
		}

		const removeArgs = published
			? ["remove", installSource]
			: ["uninstall", "--ignore-scripts", "--prefix", prefix, packed.name];
		let runtimeLaunches = 0;
		if (published) {
			const image = process.env.PI_RELEASE_RUNTIME_IMAGE;
			const templateStoreId = process.env.PI_RELEASE_TEMPLATE_STORE_ID;
			if (!image || !templateStoreId)
				fail("published verification requires the exact loaded runtime");
			const helper = fileURLToPath(
				new URL("./public-runtime-launch.mjs", import.meta.url),
			);
			const launched = await runCommand(
				process.execPath,
				[helper, packageRoot, image, templateStoreId],
				{ cwd: root, env },
			);
			launched.label = "one exact runtime launch";
			commands.push(launched);
			if (launched.exitCode !== 0) fail("exact runtime launch failed");
			const launchReceipt = JSON.parse(launched.stdout.split("\n").at(-1));
			if (
				launchReceipt.runtimeLaunches !== 1 ||
				launchReceipt.custody !== "released"
			)
				fail("exact runtime launch cleanup was not verified");
			runtimeLaunches = 1;
		}

		const uninstall = await runCommand(
			published ? piCommand : npmCommand,
			removeArgs,
			{ cwd: root, env },
		);
		uninstall.label = published ? "pi remove exact npm version" : "uninstall";
		commands.push(uninstall);
		if (uninstall.exitCode !== 0) fail("fresh uninstall failed");
		if (published) {
			if (await hasPackageRecord(piHome, installSource))
				fail("Pi remove left the package recorded");
			const reinstall = await runCommand(piCommand, ["install", installSource], {
				cwd: root,
				env,
			});
			reinstall.label = "pi reinstall exact npm version";
			commands.push(reinstall);
			if (reinstall.exitCode !== 0) fail("Pi reinstall failed");
			if (!(await hasPackageRecord(piHome, installSource)))
				fail("Pi reinstall did not restore the package record");
			const finalRemove = await runCommand(piCommand, ["remove", installSource], {
				cwd: root,
				env,
			});
			finalRemove.label = "pi final cleanup";
			commands.push(finalRemove);
			if (finalRemove.exitCode !== 0) fail("Pi final cleanup failed");
			if (await hasPackageRecord(piHome, installSource))
				fail("Pi final cleanup left the package recorded");
		}

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
			actualPiInstall: published,
			exactInstallSource: published ? installSource : null,
			packageRecordVerified: published,
			extensionFlagsVerified: published,
			runtimeLaunches,
			commands,
		};
	} catch (error) {
		failure = error;
	} finally {
		const installedPackage = receipt
			? published
				? join(piHome, "npm", "node_modules", packageName)
				: join(prefix, "node_modules", packageName)
			: undefined;
		const packageRemoved = installedPackage
			? !(await exists(installedPackage))
			: true;
		await rm(root, { recursive: true, force: true });
		if (receipt) {
			receipt.cleanup = {
				packageRemoved,
				packageRecordRemoved: true,
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
