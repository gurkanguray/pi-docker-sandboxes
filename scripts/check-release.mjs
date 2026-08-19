#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

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

function compareVersions(left, right) {
	const parse = (value) => {
		const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
		if (!match) fail(`Invalid exact version: ${value}`);
		return match.slice(1).map(Number);
	};
	const a = parse(left);
	const b = parse(right);
	for (let index = 0; index < 3; index++)
		if (a[index] !== b[index]) return a[index] - b[index];
	return 0;
}

function satisfiesVersionRange(version, range) {
	const match = /^>=(\d+\.\d+\.\d+) <(\d+\.\d+\.\d+)$/.exec(range);
	if (!match) fail(`Pi peer range must be a bounded exact range: ${range}`);
	return (
		compareVersions(version, match[1]) >= 0 &&
		compareVersions(version, match[2]) < 0
	);
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
		runtimeLock,
		runtimeReleaseLock,
		trivyPolicyText,
		changelogText,
		compatibility,
	] = await Promise.all([
		json("package.json"),
		json("package-lock.json"),
		json("docker/image-lock.json"),
		json("docker/runtime-lock.json"),
		json("docker/runtime-release-lock.json"),
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

	const piRange = pkg.peerDependencies?.["@earendil-works/pi-coding-agent"];
	if (!piRange) fail("Package must declare a bounded Pi peer range");
	if (!satisfiesVersionRange(imageLock.piVersion, piRange))
		fail(`Image lock Pi ${imageLock.piVersion} must satisfy ${piRange}`);
	if (
		(!compatibility.includes("| Host Pi |") &&
			!compatibility.includes("| Host Pi peer range |")) ||
		!compatibility.includes(piRange)
	)
		fail(`COMPATIBILITY Pi range must match ${piRange}`);
	const standard = imageLock.images?.standard;
	if (
		standard?.status !== "published" ||
		!/^ghcr\.io\/[^@]+@sha256:[0-9a-f]{64}$/.test(standard.reference ?? "") ||
		JSON.stringify(standard.platforms) !==
			JSON.stringify(["linux/amd64", "linux/arm64"]) ||
		standard.privileged !== false
	)
		fail("Standard runtime must be published at an immutable GHCR digest");
	const runtimeEvidence = runtimeReleaseLock;
	if (
		!Number.isSafeInteger(runtimeEvidence?.runId) ||
		!Number.isSafeInteger(runtimeEvidence?.runAttempt) ||
		!/^\d+$/.test(String(runtimeEvidence?.runId ?? "")) ||
		!/^\d+$/.test(String(runtimeEvidence?.runAttempt ?? "")) ||
		!/^[0-9a-f]{40}$/.test(runtimeEvidence?.sourceSha ?? "") ||
		!/^receipt-\d+-\d+$/.test(runtimeEvidence?.receiptArtifact ?? "") ||
		!Array.isArray(runtimeEvidence?.securityArtifacts) ||
		runtimeEvidence.securityArtifacts.length !== 2 ||
		!runtimeEvidence.securityArtifacts.includes(
			`security-amd64-standard-${runtimeEvidence.runId}-${runtimeEvidence.runAttempt}`,
		) ||
		!runtimeEvidence.securityArtifacts.includes(
			`security-arm64-standard-${runtimeEvidence.runId}-${runtimeEvidence.runAttempt}`,
		)
	)
		fail("Standard runtime release evidence lock is incomplete");
	if (imageLock.images?.docker?.status !== "unpublished")
		fail("Legacy Docker runtime must remain unpublished for the standard release");
	console.log(`✓ image lock: pi=${imageLock.piVersion} runtime=${standard.reference}`);

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
	const today = new Date().toISOString().slice(0, 10);
	const validDate = (value) =>
		typeof value === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(value) &&
		new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
	const requiredRiskKeys = [
		"controls", "expiry", "id", "nextReview", "owner", "paths",
		"reachability", "statement", "upstream", "variant",
	].sort();
	for (const exception of trivyExceptions.vulnerabilities) {
		if (
			!exception ||
			Array.isArray(exception) ||
			JSON.stringify(Object.keys(exception).sort()) !==
				JSON.stringify(requiredRiskKeys)
		)
			fail("Each CVE risk record must be complete");
		if (!/^CVE-\d{4}-\d{4,}$/.test(exception.id ?? ""))
			fail("Trivy exception IDs must be CVE identifiers");
		if (exceptionIds.has(exception.id))
			fail(`Duplicate Trivy exception ID: ${exception.id}`);
		exceptionIds.add(exception.id);
		if (exception.variant !== "docker")
			fail(`Trivy exception ${exception.id} cannot authorize the standard runtime`);
		if (!Array.isArray(exception.paths) || exception.paths.length === 0)
			fail(`Trivy exception ${exception.id} must use at least one scoped path`);
		if (
			typeof exception.statement !== "string" ||
			!exception.statement.includes("upstream Docker-owned") ||
			!/^docker\/sandbox-templates@sha256:[0-9a-f]{64}$/.test(
				runtimeLock.bases?.docker ?? "",
			)
		)
			fail(`Trivy exception ${exception.id} must bind the locked legacy base`);
		if (typeof exception.reachability !== "string" || !exception.reachability.trim())
			fail(`Trivy exception ${exception.id} must include reachability analysis`);
		if (!Array.isArray(exception.controls) || !exception.controls.length ||
			exception.controls.some((control) => typeof control !== "string" || !control.trim()))
			fail(`Trivy exception ${exception.id} must include compensating controls`);
		if (typeof exception.owner !== "string" || !exception.owner.trim())
			fail(`Trivy exception ${exception.id} must include a remediation owner`);
		if (!/^https:\/\//.test(exception.upstream ?? ""))
			fail(`Trivy exception ${exception.id} must include an upstream reference`);
		if (!validDate(exception.expiry) || exception.expiry < today)
			fail(`Trivy exception ${exception.id} is expired or has invalid expiry`);
		if (!validDate(exception.nextReview) || exception.nextReview < today ||
			exception.nextReview > exception.expiry)
			fail(`Trivy exception ${exception.id} has an invalid or overdue next review`);
		for (const path of exception.paths) {
			const segments = typeof path === "string" ? path.split("/") : [];
			if (
				typeof path !== "string" ||
				!/^[A-Za-z0-9._+/-]+$/.test(path) ||
				path.startsWith("/") ||
				segments.some((segment) => !segment || segment === "." || segment === "..")
			)
				fail(`Trivy exception ${exception.id} has an invalid scoped path`);
			const key = `${exception.id}\0${path}`;
			if (exceptionPaths.has(key))
				fail(`Trivy exception ${exception.id} repeats scoped path ${path}`);
			exceptionPaths.add(key);
		}
	}
	console.log(
		`✓ legacy-only CVE risk records: ${exceptionIds.size} CVEs / ${exceptionPaths.size} scoped paths`,
	);

	const dirty = await git(["status", "--porcelain", "--untracked-files=no"]);
	if (dirty) fail("Tracked worktree must be clean");
	console.log("✓ tracked worktree: clean");

	const commit = await git(["rev-parse", "HEAD"]);
	if (!allowUnreleased) {
		const signingKey = await readFile(
			`${root}/docs/release-signing.asc`,
			"utf8",
		).catch(() => "");
		if (!/-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+-----END PGP PUBLIC KEY BLOCK-----/.test(signingKey))
			fail("Missing committed release signing key: docs/release-signing.asc");
		const markerFiles = [
			"README.md", "CHANGELOG.md", "COMPATIBILITY.md", "RELEASE.md",
			"docs/index.md", "docs/getting-started.md",
		];
		for (const path of markerFiles) {
			const text = await readFile(`${root}/${path}`, "utf8").catch(() => "");
			if (/\b(?:Early Access|unpublished|not yet published|pre[- ]?release|alpha)\b/i.test(text))
				fail(`Production release marker remains in ${path}`);
		}
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
