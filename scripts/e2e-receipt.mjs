#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, open, readFile, writeFile } from "node:fs/promises";
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

function versionAtLeast(actual, minimum) {
	const left = actual.match(/^\d+(?:\.\d+)*$/)?.[0].split(".").map(Number);
	const right = minimum.split(".").map(Number);
	if (!left) return false;
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		if ((left[index] ?? 0) !== (right[index] ?? 0))
			return (left[index] ?? 0) > (right[index] ?? 0);
	}
	return true;
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
		fail(`Source SHA mismatch: expected ${expectedSourceSha}, got ${sourceSha}`);

	const expectedPlatform = required(values, "expected-platform");
	const expectedArchitecture = required(values, "expected-architecture");
	if (
		process.platform !== expectedPlatform ||
		process.arch !== expectedArchitecture
	)
		fail(
			`Measured host mismatch: expected ${expectedPlatform}/${expectedArchitecture}, got ${process.platform}/${process.arch}`,
		);
	const osName = required(values, "os-name");
	const osVersion = required(values, "os-version");
	const requireKvm = required(values, "require-kvm");
	if (requireKvm !== "true" && requireKvm !== "false")
		fail("--require-kvm must be true or false");
	if (process.platform === "darwin") {
		if (osName !== "macOS") fail(`Supported host OS is macOS; got ${osName}`);
		if (!versionAtLeast(osVersion, "14"))
			fail(`macOS 14 or newer is required; got ${osVersion}`);
	} else if (process.platform === "linux") {
		if (osName !== "ubuntu")
			fail(`Supported host OS is Ubuntu; got ${osName}`);
		if (!versionAtLeast(osVersion, "24.04"))
			fail(`Ubuntu 24.04 or newer is required; got ${osVersion}`);
	} else fail(`Supported host OS is macOS or Ubuntu; got ${process.platform}`);
	const kvm = {
		required: requireKvm === "true",
		path: requireKvm === "true" ? "/dev/kvm" : null,
		characterDevice: false,
		opened: false,
		openMode: requireKvm === "true" ? "r+" : null,
	};
	if (kvm.required) {
		try {
			kvm.characterDevice = (await lstat("/dev/kvm")).isCharacterDevice();
			const handle = await open("/dev/kvm", "r+");
			await handle.close();
			kvm.opened = true;
		} catch {
			// The failed receipt still records measured negative KVM evidence.
		}
		if (status === "passed" && (!kvm.characterDevice || !kvm.opened))
			fail("Passing Linux KVM receipt requires a character device opened r+");
	}

	const dockerVersion = required(values, "docker-version");
	const dockerMajor = Number(
		dockerVersion.match(/^(\d+)(?:\.\d+){1,3}(?:[-+].*)?$/)?.[1],
	);
	if (!Number.isSafeInteger(dockerMajor) || dockerMajor < 29)
		fail(`Docker 29 or newer is required; got ${dockerVersion}`);
	const sbxVersion = required(values, "sbx-version");
	if (!/^0\.38\.\d+(?:[-+].*)?$/.test(sbxVersion))
		fail(`Docker SBX 0.38.x is required; got ${sbxVersion}`);

	const expectedImageDigest = required(values, "image-digest");
	const selectedImage = optional(values, "selected-image");
	const selectedImageId = optional(values, "selected-image-id");
	const packageArgument = optional(values, "package");
	const expectedIntegrity = optional(values, "package-integrity");
	const expectedPackageVersion = optional(values, "package-version");
	const installedPackageArgument = optional(values, "installed-package");
	const piVersion = optional(values, "pi-version");
	const imageLockPiVersion = optional(values, "image-lock-pi-version");
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
		if (!piVersion || !imageLockPiVersion)
			fail("Passing receipt requires sandbox runtime Pi evidence");
	}
	if (Boolean(piVersion) !== Boolean(imageLockPiVersion))
		fail("Sandbox runtime Pi evidence must be complete or absent");
	if (imageLockPiVersion && imageLockPiVersion !== "0.84.1")
		fail("Image lock Pi version must be 0.84.1");
	if (piVersion && piVersion !== imageLockPiVersion)
		fail(
			`Sandbox runtime Pi version mismatch: expected ${imageLockPiVersion}, got ${piVersion}`,
		);

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
		platform: process.platform,
		osName,
		osVersion,
		architecture: process.arch,
		kvm,
		dockerVersion,
		sbxVersion,
		piVersion,
		imageLockPiVersion,
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
