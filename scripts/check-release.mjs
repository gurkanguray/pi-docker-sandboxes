#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const APPROVED_BASE_IMAGE =
	"docker/sandbox-templates@sha256:d86a6cdc105a1b299667a20c40bcf8d0584e56f21d44490a0737bb1baeb44299";
const APPROVED_TRIVY_POLICY_SHA256 =
	"3eaef1efc293ef48b66b6d930e19d285fa67f141e0f44e39a32bf7213a65cc50";
const exec = promisify(execFile);
const root = process.cwd();
const SAFE_GIT_ARGS = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"commit.gpgSign=false",
	"-c",
	"tag.gpgSign=false",
	"-c",
	"gpg.format=openpgp",
	"-c",
	"gpg.program=gpg",
];

function fail(message) {
	throw new Error(message);
}

async function json(path) {
	return JSON.parse(await readFile(`${root}/${path}`, "utf8"));
}

async function git(args, operation = `git ${args.join(" ")}`) {
	try {
		return (
			await exec("git", [...SAFE_GIT_ARGS, ...args], { cwd: root })
		).stdout.trim();
	} catch (error) {
		throw new Error(
			`${operation} failed: ${String(error?.stderr ?? error?.message ?? error).trim()}`,
		);
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function argumentsFrom(argv) {
	let tag;
	let allowUnreleased = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--allow-unreleased") allowUnreleased = true;
		else if (argument === "--tag") tag = argv[++index];
		else fail(`Unknown argument: ${argument}`);
	}
	if (!tag)
		fail(
			"Usage: node scripts/check-release.mjs [--allow-unreleased] --tag vX.Y.Z",
		);
	return { tag, allowUnreleased };
}

try {
	const { tag, allowUnreleased } = argumentsFrom(process.argv.slice(2));
	const [
		pkg,
		packageLock,
		imageLock,
		trivyPolicyText,
		changelogText,
		compatibility,
	] = await Promise.all([
		json("package.json"),
		json("package-lock.json"),
		json("docker/image-lock.json"),
		readFile(`${root}/.trivyignore.yaml`, "utf8"),
		readFile(`${root}/CHANGELOG.md`, "utf8"),
		readFile(`${root}/COMPATIBILITY.md`, "utf8"),
	]);
	const trivyExceptions = JSON.parse(trivyPolicyText);
	if (
		!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
			pkg.version,
		)
	)
		fail(`Package version is not exact semver: ${pkg.version}`);
	const expectedTag = `v${pkg.version}`;
	if (tag !== expectedTag)
		fail(
			`Tag must exactly match package version: expected ${expectedTag}, received ${tag}`,
		);
	console.log(`✓ tag/version: ${tag}`);

	const lockRoot = packageLock.packages?.[""];
	if (packageLock.version !== pkg.version || lockRoot?.version !== pkg.version)
		fail(`package-lock root version must match ${pkg.version}`);
	if (packageLock.name !== pkg.name || lockRoot?.name !== pkg.name)
		fail(`package-lock root package name must match ${pkg.name}`);
	const lockPiVersion =
		lockRoot?.devDependencies?.["@earendil-works/pi-coding-agent"];
	const piVersion = pkg.devDependencies?.["@earendil-works/pi-coding-agent"];
	if (!piVersion) fail("Package must pin @earendil-works/pi-coding-agent");
	if (lockPiVersion !== piVersion)
		fail(`package-lock root Pi version must match ${piVersion}`);
	console.log(`✓ package lock: ${pkg.name}@${pkg.version}`);

	const headingPattern = new RegExp(
		`^##\\s+${escapeRegExp(pkg.version)}\\s+[—-]\\s+(\\d{4}-\\d{2}-\\d{2})\\s*$`,
		"m",
	);
	const heading = changelogText.match(headingPattern);
	if (!heading)
		fail(`CHANGELOG heading for ${pkg.version} must include a YYYY-MM-DD date`);
	const changelog = `${pkg.version} — ${heading[1]}`;
	console.log(`✓ changelog: ${changelog}`);

	if (imageLock.packageVersion !== pkg.version)
		fail(`Image lock package version must match ${pkg.version}`);
	if (imageLock.piVersion !== piVersion)
		fail(`Image lock Pi version must match ${piVersion}`);
	if (
		!new RegExp(
			`^\\|\\s*Pi\\s*\\|\\s*${escapeRegExp(piVersion)}\\s*\\|`,
			"m",
		).test(compatibility)
	)
		fail(`COMPATIBILITY Pi version must match ${piVersion}`);
	console.log(
		`✓ image lock: package=${imageLock.packageVersion} pi=${imageLock.piVersion}`,
	);

	if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(imageLock.baseImage ?? ""))
		fail("Image lock base image must use an immutable sha256 digest");
	if (
		!trivyExceptions ||
		Array.isArray(trivyExceptions) ||
		JSON.stringify(Object.keys(trivyExceptions).sort()) !==
			JSON.stringify(["vulnerabilities"])
	)
		fail("Trivy exceptions must contain only a vulnerabilities array");
	if (!Array.isArray(trivyExceptions.vulnerabilities))
		fail("Trivy exceptions vulnerabilities must be an array");
	const exceptionIds = new Set();
	const exceptionPaths = new Set();
	for (const exception of trivyExceptions.vulnerabilities) {
		if (
			!exception ||
			Array.isArray(exception) ||
			JSON.stringify(Object.keys(exception).sort()) !==
				JSON.stringify(["id", "paths", "statement"])
		)
			fail("Each Trivy exception must contain only id, paths, and statement");
		if (!/^CVE-\d{4}-\d{4,}$/.test(exception.id ?? ""))
			fail("Trivy exception IDs must be CVE identifiers");
		if (exceptionIds.has(exception.id))
			fail(`Duplicate Trivy exception ID: ${exception.id}`);
		exceptionIds.add(exception.id);
		if (!Array.isArray(exception.paths) || exception.paths.length === 0)
			fail(`Trivy exception ${exception.id} must use at least one scoped path`);
		if (
			typeof exception.statement !== "string" ||
			!exception.statement.includes(imageLock.baseImage)
		)
			fail(`Trivy exception ${exception.id} must name the locked base image`);
		if (!exception.statement.includes("upstream Docker-owned"))
			fail(`Trivy exception ${exception.id} must identify upstream ownership`);
		const reviewed = exception.statement.match(
			/\breviewed (\d{4}-\d{2}-\d{2})\b/i,
		)?.[1];
		if (
			!reviewed ||
			new Date(`${reviewed}T00:00:00Z`).toISOString().slice(0, 10) !== reviewed
		)
			fail(`Trivy exception ${exception.id} must include a valid review date`);
		for (const path of exception.paths) {
			const segments = typeof path === "string" ? path.split("/") : [];
			if (
				typeof path !== "string" ||
				!/^[A-Za-z0-9._+/-]+$/.test(path) ||
				path.startsWith("/") ||
				segments.some(
					(segment) => !segment || segment === "." || segment === "..",
				)
			)
				fail(`Trivy exception ${exception.id} has an invalid scoped path`);
			const key = `${exception.id}\0${path}`;
			if (exceptionPaths.has(key))
				fail(`Trivy exception ${exception.id} repeats scoped path ${path}`);
			exceptionPaths.add(key);
		}
	}
	if (imageLock.baseImage !== APPROVED_BASE_IMAGE)
		fail(`Image lock base image must equal approved base image ${APPROVED_BASE_IMAGE}`);
	const trivyPolicySha256 = createHash("sha256")
		.update(trivyPolicyText)
		.digest("hex");
	if (trivyPolicySha256 !== APPROVED_TRIVY_POLICY_SHA256)
		fail(
			`Trivy exceptions must match approved Trivy policy ${APPROVED_TRIVY_POLICY_SHA256}`,
		);
	console.log(
		`✓ Trivy exceptions: ${exceptionIds.size} CVEs / ${exceptionPaths.size} scoped paths`,
	);

	const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
	if (dirty) fail("Tracked worktree must be clean");
	console.log("✓ tracked worktree: clean");

	const commit = await git(["rev-parse", "HEAD"]);
	if (!allowUnreleased) {
		await git(["tag", "-v", tag], `git tag -v ${tag}`);
		const tagCommit = await git(["rev-list", "-n", "1", tag]);
		if (tagCommit !== commit)
			fail(`Signed tag ${tag} must point to HEAD ${commit}`);
		console.log(`✓ signed tag: ${tag}`);
	} else console.log("- signed tag: skipped for unreleased development");

	console.log(
		JSON.stringify({
			tag,
			version: pkg.version,
			commit,
			changelog,
			clean: true,
		}),
	);
} catch (error) {
	console.error(
		`Release check failed: ${error instanceof Error ? error.message : error}`,
	);
	process.exitCode = 1;
}
