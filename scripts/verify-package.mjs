#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function fail(message) {
	throw new Error(message);
}

function allowed(path, files, hasLicense) {
	if (path === "package.json" || (hasLicense && path === "LICENSE"))
		return true;
	return files.some((entry) => {
		const normalized = entry.replace(/^\.\//, "");
		if (normalized.endsWith("/")) return path.startsWith(normalized);
		const pattern = normalized
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replaceAll("**", "\0")
			.replaceAll("*", "[^/]*")
			.replaceAll("\0", ".*");
		return new RegExp(`^${pattern}(?:/.*)?$`).test(path);
	});
}

async function npm(args, cwd) {
	try {
		return await exec("npm", args, { cwd });
	} catch (error) {
		fail(String(error?.stderr ?? error?.message ?? error).trim());
	}
}

let installRoot;
try {
	const [argument, flag, receiptArgument] = process.argv.slice(2);
	if (
		!argument ||
		(flag !== undefined && flag !== "--receipt") ||
		(flag === "--receipt" && !receiptArgument) ||
		process.argv.length > 5
	)
		fail("Usage: node scripts/verify-package.mjs <tarball> [--receipt <path>]");
	const filename = resolve(argument);
	const receiptPath = receiptArgument && resolve(receiptArgument);
	const { stdout } = await npm(
		["pack", "--dry-run", "--json", filename],
		dirname(filename),
	);
	const packed = JSON.parse(stdout)[0];
	if (!packed?.integrity || !Array.isArray(packed.files))
		fail("npm did not return package integrity and files");
	const files = packed.files.map(({ path }) => path).sort();

	installRoot = await mkdtemp(join(tmpdir(), "pi-dsbx-package-verify-"));
	await npm(
		["install", "--ignore-scripts", "--prefix", installRoot, filename],
		installRoot,
	);
	const packageRoot = join(installRoot, "node_modules", packed.name);
	const pkg = JSON.parse(
		await readFile(join(packageRoot, "package.json"), "utf8"),
	);
	const hasLicense = files.includes("LICENSE");
	for (const path of files)
		if (!allowed(path, pkg.files ?? [], hasLicense))
			fail(`Unexpected package file outside documented allowlist: ${path}`);

	const bin = packed.files.find(({ path }) => path === "bin/pi-dsbx.mjs");
	if (!bin) fail("bin/pi-dsbx.mjs is missing");
	if ((bin.mode & 0o111) === 0) fail("bin/pi-dsbx.mjs must be executable");
	if (pkg.bin?.["pi-dsbx"]?.replace(/^\.\//, "") !== "bin/pi-dsbx.mjs")
		fail("package bin pi-dsbx must point to bin/pi-dsbx.mjs");
	let rootExport = "not advertised";
	const rootExportAdvertised =
		typeof pkg.exports === "string" ||
		Array.isArray(pkg.exports) ||
		(pkg.exports &&
			typeof pkg.exports === "object" &&
			(Object.hasOwn(pkg.exports, ".") ||
				!Object.keys(pkg.exports).every((key) => key.startsWith("."))));
	if (rootExportAdvertised) {
		const documentation = files
			.filter((path) => /(?:^|\/)(?:README|[^/]+\.md)$/i.test(path))
			.map((path) => readFile(join(packageRoot, path), "utf8"));
		const documentedUnsupported = (await Promise.all(documentation)).some(
			(text) =>
				/programmatic root export[^\n]*(?:unsupported|unstable)|(?:unsupported|unstable)[^\n]*programmatic root export/i.test(
					text,
				),
		);
		if (!documentedUnsupported)
			fail("Package advertises a stable programmatic root export");
		rootExport = "documented as unsupported";
	}

	const cli = process.platform === "win32" ? "pi-dsbx.cmd" : "pi-dsbx";
	const help = await exec(
		join(installRoot, "node_modules", ".bin", cli),
		["--help"],
		{
			cwd: installRoot,
		},
	);
	console.log(`✓ integrity: ${packed.integrity}`);
	console.log(`✓ files: ${files.join(", ")}`);
	console.log(`✓ installed package: ${packed.name}@${pkg.version}`);
	console.log(`✓ pi-dsbx --help: ${help.stdout.trim()}`);
	console.log(`✓ programmatic root export: ${rootExport}`);
	const receipt = {
		filename,
		integrity: packed.integrity,
		files,
		binVersion: pkg.version,
		installRoot,
	};
	if (receiptPath) await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
	console.log(JSON.stringify(receipt));
} catch (error) {
	console.error(
		`Package verification failed: ${error instanceof Error ? error.message : error}`,
	);
	process.exitCode = 1;
} finally {
	if (installRoot) await rm(installRoot, { recursive: true, force: true });
}
