import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const script = new URL("../scripts/e2e-receipt.mjs", import.meta.url);
const imageDigest = `sha256:${"a".repeat(64)}`;

interface Fixture {
	root: string;
	sourceSha: string;
	tarball: string;
	prefix: string;
	integrity: string;
}

async function fixture(): Promise<Fixture> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-e2e-receipt-"));
	await exec("git", ["init", "--quiet"], { cwd: root });
	await exec("git", ["config", "user.email", "e2e@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "E2E"], { cwd: root });
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({
			name: "receipt-fixture",
			version: "1.2.3",
			files: ["index.js"],
		}),
	);
	await writeFile(join(root, "index.js"), "export default true;\n");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
	const sourceSha = (
		await exec("git", ["rev-parse", "HEAD"], { cwd: root })
	).stdout.trim();
	const packed = JSON.parse(
		(await exec("npm", ["pack", "--json"], { cwd: root })).stdout,
	)[0];
	const tarball = join(root, packed.filename);
	const prefix = join(root, "prefix");
	await exec("npm", [
		"install",
		"--ignore-scripts",
		"--prefix",
		prefix,
		tarball,
	]);
	return { root, sourceSha, tarball, prefix, integrity: packed.integrity };
}

async function runReceipt(
	fixture: Fixture,
	overrides: Record<string, string> = {},
) {
	const values = {
		"source-sha": fixture.sourceSha,
		package: fixture.tarball,
		"package-integrity": fixture.integrity,
		"package-version": "1.2.3",
		"installed-package": join(
			fixture.prefix,
			"node_modules/receipt-fixture/package.json",
		),
		"image-digest": imageDigest,
		"selected-image": `docker.io/example/pi:local-${"a".repeat(64)}`,
		"selected-image-id": imageDigest,
		status: "passed",
		"tests-count": "1",
		"expected-platform": process.platform,
		"host-version": "15.6",
		"expected-architecture": process.arch,
		"require-kvm": "false",
		"sbx-version": "0.38.0",
		"pi-version": "0.84.1",
		"image-lock-pi-version": "0.84.1",
		receipt: join(fixture.root, "e2e-receipt.json"),
		...overrides,
	};
	const args = [
		...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]),
		"--test",
		"real scenario",
	];
	try {
		const result = await exec(process.execPath, [script.pathname, ...args], {
			cwd: fixture.root,
		});
		return {
			code: 0,
			stdout: result.stdout,
			stderr: result.stderr,
			receipt: values.receipt,
		};
	} catch (error) {
		const failed = error as { code: number; stdout: string; stderr: string };
		return {
			code: failed.code,
			stdout: failed.stdout,
			stderr: failed.stderr,
			receipt: values.receipt,
		};
	}
}

for (const [name, overrides, message] of [
	["source SHA", { "source-sha": "deadbeef" }, /source SHA/i],
	[
		"measured host",
		{ "expected-architecture": process.arch === "x64" ? "arm64" : "x64" },
		/measured host/i,
	],
	["package version", { "package-version": "9.9.9" }, /package version/i],
	[
		"package integrity",
		{ "package-integrity": "sha512-wrong" },
		/package integrity/i,
	],
	[
		"image digest",
		{ "selected-image": `docker.io/example/pi:local-${"b".repeat(64)}` },
		/image digest/i,
	],
	[
		"selected image inspect ID",
		{ "selected-image-id": `sha256:${"b".repeat(64)}` },
		/image digest/i,
	],
	[
		"sandbox runtime Pi version",
		{ "pi-version": "0.84.2" },
		/sandbox runtime Pi version/i,
	],
] as const) {
	test(`E2E receipt rejects mismatched ${name}`, async () => {
		const value = await fixture();
		try {
			const result = await runReceipt(value, overrides);
			assert.equal(result.code, 1);
			assert.match(result.stderr, message);
		} finally {
			await rm(value.root, { recursive: true, force: true });
		}
	});
}

test("E2E receipt binds successful tests to source, package, and image evidence", async () => {
	const value = await fixture();
	try {
		const result = await runReceipt(value);
		assert.equal(result.code, 0, result.stderr);
		const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
		assert.deepEqual(Object.keys(receipt), [
			"sourceSha",
			"packageIntegrity",
			"imageDigest",
			"selectedImage",
			"platform",
			"hostVersion",
			"architecture",
			"kvm",
			"sbxVersion",
			"piVersion",
			"imageLockPiVersion",
			"packageVersion",
			"tests",
			"testsCount",
			"status",
			"passedAt",
		]);
		assert.deepEqual(receipt, {
			sourceSha: value.sourceSha,
			packageIntegrity: value.integrity,
			imageDigest,
			selectedImage: `docker.io/example/pi:local-${"a".repeat(64)}`,
			platform: process.platform,
			hostVersion: "15.6",
			architecture: process.arch,
			kvm: {
				required: false,
				path: null,
				characterDevice: false,
				opened: false,
				openMode: null,
			},
			sbxVersion: "0.38.0",
			piVersion: "0.84.1",
			imageLockPiVersion: "0.84.1",
			packageVersion: "1.2.3",
			tests: ["real scenario"],
			testsCount: 1,
			status: "passed",
			passedAt: receipt.passedAt,
		});
		assert.equal(Number.isNaN(Date.parse(receipt.passedAt)), false);
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("failed E2E receipt records failure without claiming a pass time", async () => {
	const value = await fixture();
	try {
		const result = await runReceipt(value, {
			status: "failed",
			"tests-count": "0",
		});
		assert.equal(result.code, 0, result.stderr);
		const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
		assert.equal(receipt.status, "failed");
		assert.equal(receipt.testsCount, 0);
		assert.equal(receipt.passedAt, null);
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});

test("failed E2E receipt exists when candidate evidence is unavailable", async () => {
	const value = await fixture();
	try {
		const result = await runReceipt(value, {
			status: "failed",
			"tests-count": "0",
			package: "",
			"package-integrity": "",
			"package-version": "",
			"installed-package": "",
			"selected-image": "",
			"selected-image-id": "",
			"pi-version": "",
			"image-lock-pi-version": "",
		});
		assert.equal(result.code, 0, result.stderr);
		const receipt = JSON.parse(await readFile(result.receipt, "utf8"));
		assert.equal(receipt.packageIntegrity, null);
		assert.equal(receipt.packageVersion, null);
		assert.equal(receipt.selectedImage, null);
		assert.equal(receipt.piVersion, null);
		assert.equal(receipt.imageLockPiVersion, null);
		assert.equal(receipt.status, "failed");
		assert.equal(receipt.passedAt, null);
	} finally {
		await rm(value.root, { recursive: true, force: true });
	}
});
