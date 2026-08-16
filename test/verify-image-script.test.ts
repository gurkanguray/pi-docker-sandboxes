import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function fixture(source: boolean): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-verifier-script-"));
	await mkdir(join(directory, "scripts"));
	await mkdir(join(directory, "dist"));
	await mkdir(join(directory, "docker"));
	await cp(
		new URL("../scripts/verify-image.mjs", import.meta.url),
		join(directory, "scripts", "verify-image.mjs"),
	);
	await cp(
		new URL("../docker/image-lock.json", import.meta.url),
		join(directory, "docker", "image-lock.json"),
	);
	if (source) await writeFile(join(directory, ".source-checkout"), "");
	return directory;
}

const stale = `throw new Error("stale verifier imported");`;
const fresh = `
export async function verifyImageReceipt(image) { return { image, digest: "sha256:${"a".repeat(64)}", imageId: "sha256:${"a".repeat(64)}", registryDigest: null, platform: "linux/arm64", uid: 1000, user: "agent", entrypoint: [], versions: { package: "0.1.0", pi: "0.84.1", fd: "10.3.0-2ubuntu1", ripgrep: "15.1.0-1ubuntu1", git: "1:2.53.0-1ubuntu1", node: "v22.22.1", npm: "9.2.0" } }; }
export function compareImageReceipts() { throw new Error("unexpected candidate"); }
`;
const lock = `export async function loadImageLock(path) { return { path }; }`;

test("source verifier rebuilds before importing even when dist exists", async () => {
	const directory = await fixture(true);
	try {
		await writeFile(join(directory, "dist", "image.js"), stale);
		await writeFile(join(directory, "dist", "image-lock.js"), lock);
		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({
				type: "module",
				scripts: {
					"build:cli": `node -e 'require("fs").writeFileSync("dist/image.js", ${JSON.stringify(fresh)})'`,
				},
			}),
		);
		const { stdout } = await exec(process.execPath, [
			join(directory, "scripts", "verify-image.mjs"),
			"fake-image",
		]);
		const receipt = JSON.parse(stdout.trim().split("\n").at(-1)!) as {
			image?: string;
		};
		assert.equal(receipt.image, "fake-image");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
