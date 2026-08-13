#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();

function fail(message) {
	throw new Error(message);
}

async function json(path) {
	return JSON.parse(await readFile(`${root}/${path}`, "utf8"));
}

async function git(args, operation = `git ${args.join(" ")}`) {
	try {
		return (await exec("git", args, { cwd: root })).stdout.trim();
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
	let imageCandidate = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--allow-unreleased") allowUnreleased = true;
		else if (argument === "--image-candidate") imageCandidate = true;
		else if (argument === "--tag") tag = argv[++index];
		else fail(`Unknown argument: ${argument}`);
	}
	if (!tag || (allowUnreleased && imageCandidate))
		fail(
			"Usage: node scripts/check-release.mjs [--allow-unreleased | --image-candidate] --tag vX.Y.Z[-prerelease][-oci.N]",
		);
	return { tag, allowUnreleased, imageCandidate };
}

try {
	const { tag, allowUnreleased, imageCandidate } = argumentsFrom(
		process.argv.slice(2),
	);
	const [pkg, packageLock, imageLock, changelogText, compatibility] =
		await Promise.all([
			json("package.json"),
			json("package-lock.json"),
			json("docker/image-lock.json"),
			readFile(`${root}/CHANGELOG.md`, "utf8"),
			readFile(`${root}/COMPATIBILITY.md`, "utf8"),
		]);
	if (
		!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
			pkg.version,
		)
	)
		fail(`Package version is not exact semver: ${pkg.version}`);
	const expectedTag = `v${pkg.version}`;
	const expectedCandidate = new RegExp(
		`^${escapeRegExp(expectedTag)}-oci\\.(?:0|[1-9]\\d*)$`,
	);
	if (
		(imageCandidate && !expectedCandidate.test(tag)) ||
		(!imageCandidate && tag !== expectedTag)
	)
		fail(
			`Tag must ${imageCandidate ? `match ${expectedTag}-oci.N` : `exactly match package version: expected ${expectedTag}`}, received ${tag}`,
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
	if (imageLock.publishedImage == null) {
		if (!allowUnreleased && !imageCandidate)
			fail("Published image must be present and pinned by sha256 digest");
	} else if (
		typeof imageLock.publishedImage !== "string" ||
		!/@sha256:[0-9a-f]{64}$/.test(imageLock.publishedImage)
	)
		fail("Published image must be pinned by sha256 digest");
	console.log(
		`✓ image lock: package=${imageLock.packageVersion} pi=${imageLock.piVersion} image=${imageLock.publishedImage ?? "unreleased"}`,
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
			imageLock: imageLock.publishedImage,
			imageCandidate,
			clean: true,
		}),
	);
} catch (error) {
	console.error(
		`Release check failed: ${error instanceof Error ? error.message : error}`,
	);
	process.exitCode = 1;
}
