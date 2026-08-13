#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function fail(message) {
	throw new Error(message);
}

function argumentsFrom(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag?.startsWith("--") || value === undefined)
			fail("Arguments must be --name value pairs");
		const key = flag.slice(2);
		if (key === "test") values.set(key, [...(values.get(key) ?? []), value]);
		else {
			if (values.has(key)) fail(`Duplicate argument: --${key}`);
			values.set(key, value);
		}
	}
	return values;
}

function required(values, key) {
	const value = values.get(key);
	if (typeof value !== "string" || !value) fail(`Missing --${key}`);
	return value;
}

function optional(values, key) {
	const value = values.get(key);
	return typeof value === "string" && value ? value : null;
}

function imageIdentity(value) {
	const digest = value.match(/^sha256:([0-9a-f]{64})$/)?.[1];
	if (digest) return digest;
	const local = value.match(/:local-([0-9a-f]{64})$/)?.[1];
	if (local) return local;
	fail("Image digest must be a sha256 ID or local content tag");
}

try {
	const values = argumentsFrom(process.argv.slice(2));
	const status = required(values, "status");
	if (status !== "passed" && status !== "failed")
		fail("--status must be passed or failed");
	const testsCount = Number(required(values, "tests-count"));
	if (!Number.isSafeInteger(testsCount) || testsCount < 0)
		fail("--tests-count must be a nonnegative integer");
	const tests = values.get("test");
	if (!Array.isArray(tests) || tests.length === 0)
		fail("At least one --test is required");

	const expectedSourceSha = required(values, "source-sha");
	const sourceSha = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
	if (sourceSha !== expectedSourceSha)
		fail(
			`Source SHA mismatch: expected ${expectedSourceSha}, got ${sourceSha}`,
		);

	const expectedImageDigest = required(values, "image-digest");
	const selectedImage = optional(values, "selected-image");
	const selectedImageId = optional(values, "selected-image-id");
	const packageArgument = optional(values, "package");
	const expectedIntegrity = optional(values, "package-integrity");
	const expectedPackageVersion = optional(values, "package-version");
	const installedPackageArgument = optional(values, "installed-package");
	let packageIntegrity = null;
	let packageVersion = null;

	if (status === "passed") {
		if (testsCount !== tests.length)
			fail("Passing receipt tests count must match named tests");
		if (
			!packageArgument ||
			!expectedIntegrity ||
			!expectedPackageVersion ||
			!installedPackageArgument ||
			!selectedImage ||
			!selectedImageId
		)
			fail("Passing receipt requires complete package and image evidence");
	}

	if (
		packageArgument &&
		expectedIntegrity &&
		expectedPackageVersion &&
		installedPackageArgument
	) {
		const packagePath = resolve(packageArgument);
		const { stdout } = await exec(
			"npm",
			["pack", "--dry-run", "--json", packagePath],
			{ cwd: dirname(packagePath) },
		);
		const packed = JSON.parse(stdout)[0];
		if (packed?.integrity !== expectedIntegrity)
			fail(
				`Package integrity mismatch: expected ${expectedIntegrity}, got ${packed?.integrity ?? "missing"}`,
			);
		if (packed?.version !== expectedPackageVersion)
			fail(
				`Package version mismatch: expected ${expectedPackageVersion}, tarball has ${packed?.version ?? "missing"}`,
			);
		const installedPackage = JSON.parse(
			await readFile(resolve(installedPackageArgument), "utf8"),
		);
		if (installedPackage.version !== expectedPackageVersion)
			fail(
				`Package version mismatch: expected ${expectedPackageVersion}, installed package has ${installedPackage.version ?? "missing"}`,
			);
		packageIntegrity = packed.integrity;
		packageVersion = installedPackage.version;
	} else if (
		packageArgument ||
		expectedIntegrity ||
		expectedPackageVersion ||
		installedPackageArgument
	) {
		fail("Package evidence must be complete or absent");
	}

	if (selectedImage && selectedImageId) {
		const expectedIdentity = imageIdentity(expectedImageDigest);
		if (
			imageIdentity(selectedImage) !== expectedIdentity ||
			imageIdentity(selectedImageId) !== expectedIdentity
		)
			fail(
				`Image digest mismatch: expected ${expectedImageDigest}, selected ${selectedImage} (${selectedImageId})`,
			);
	} else if (selectedImage || selectedImageId) {
		fail("Selected image evidence must be complete or absent");
	}

	const receipt = {
		sourceSha,
		packageIntegrity,
		imageDigest: expectedImageDigest,
		selectedImage,
		platform: required(values, "platform"),
		macosVersion: required(values, "macos-version"),
		architecture: required(values, "architecture"),
		sbxVersion: optional(values, "sbx-version"),
		piVersion: optional(values, "pi-version"),
		packageVersion,
		tests,
		testsCount,
		status,
		passedAt: status === "passed" ? new Date().toISOString() : null,
	};
	await writeFile(
		resolve(required(values, "receipt")),
		`${JSON.stringify(receipt, null, 2)}\n`,
	);
	console.log(JSON.stringify(receipt));
} catch (error) {
	console.error(
		`E2E receipt failed: ${error instanceof Error ? error.message : error}`,
	);
	process.exitCode = 1;
}
