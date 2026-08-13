import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { loadImageLock } from "../src/image-lock.ts";
import { imageSmokeArgs } from "../src/image.ts";

const exec = promisify(execFile);
const enabled = process.env.PI_DOCKER_SANDBOX_IMAGE_TEST === "1";

test("runtime image contains every pinned dependency for the agent user", {
	skip: !enabled,
}, async () => {
	const lock = await loadImageLock();
	const image = process.env.PI_DOCKER_SANDBOX_IMAGE ?? lock.localImage;
	const script = [
		"set -eu",
		'printf "uid=%s\\n" "$(id -u)"',
		'printf "pi=%s\\n" "$(pi --version)"',
		"pi-dsbx --help >/dev/null",
		'printf "pi-dsbx=ok\\n"',
		`test "$(dpkg-query -W -f='${"${Version}"}' fd-find)" = "${lock.tools.fdDebianVersion}"`,
		`test "$(dpkg-query -W -f='${"${Version}"}' ripgrep)" = "${lock.tools.rgDebianVersion}"`,
		`test "$(dpkg-query -W -f='${"${Version}"}' git)" = "${lock.tools.gitDebianVersion}"`,
		'printf "fd=%s\\n" "$(fd --version)"',
		'printf "fdfind=%s\\n" "$(fdfind --version)"',
		'printf "rg=%s\\n" "$(rg --version)"',
		'printf "git=%s\\n" "$(git --version)"',
		'printf "node=%s\\n" "$(node --version)"',
		'printf "npm=%s\\n" "$(npm --version)"',
		'printf "package=%s\\n" "$(node -p \'require("/usr/local/share/npm-global/lib/node_modules/pi-docker-sandboxes/package.json").version\')"',
	].join("; ");
	const { stdout, stderr } = await exec(
		"docker",
		imageSmokeArgs(image, lock, script),
		{ encoding: "utf8", maxBuffer: 1024 * 1024 },
	);
	const output = `${stdout}\n${stderr}`;
	assert.match(stdout, /^uid=1000$/m);
	assert.match(
		stdout,
		new RegExp(`^pi=${lock.piVersion.replaceAll(".", "\\.")}$`, "m"),
	);
	assert.match(stdout, /^pi-dsbx=ok$/m);
	assert.match(stdout, /^fd=fdfind 10\.3\.0$/m);
	assert.match(stdout, /^fdfind=fdfind 10\.3\.0$/m);
	assert.match(stdout, /^rg=ripgrep 15\.1\.0$/m);
	assert.match(stdout, /^git=git version \S+$/m);
	assert.match(stdout, /^node=v\d+\.\d+\.\d+$/m);
	assert.match(stdout, /^npm=\d+\.\d+\.\d+$/m);
	assert.match(
		stdout,
		new RegExp(`^package=${lock.packageVersion.replaceAll(".", "\\.")}$`, "m"),
	);
	assert.doesNotMatch(output, /Downloading/i);

	const { stdout: verifyOutput } = await exec(
		process.execPath,
		["scripts/verify-image.mjs", image],
		{ encoding: "utf8", maxBuffer: 1024 * 1024 },
	);
	const verifyLines = verifyOutput.trim().split("\n");
	const jsonLines = verifyLines.filter((line) => {
		try {
			JSON.parse(line);
			return true;
		} catch {
			return false;
		}
	});
	assert.equal(jsonLines.length, 1);
	assert.equal(jsonLines[0], verifyLines.at(-1));
	assert.equal(
		verifyLines.slice(0, -1).every((line) => {
			try {
				JSON.parse(line);
				return false;
			} catch {
				return true;
			}
		}),
		true,
	);
	const receipt = JSON.parse(jsonLines[0]!) as {
		image: string;
		digest: string;
		imageId: string;
		registryDigest: string | null;
		platform: string;
		uid: number;
		user: string;
		entrypoint: string[];
		versions: Record<string, string>;
		parity: { status: string; candidate: string | null };
	};
	assert.equal(receipt.image, image);
	assert.match(receipt.digest, /^sha256:[0-9a-f]{64}$/);
	assert.equal(receipt.platform, "linux/arm64");
	assert.equal(receipt.uid, 1000);
	assert.equal(receipt.user, "agent");
	assert.deepEqual(receipt.entrypoint, ["tini", "--"]);
	assert.equal(receipt.registryDigest, null);
	assert.equal(receipt.digest, receipt.imageId);
	assert.equal(receipt.versions.pi, lock.piVersion);
	assert.equal(receipt.versions.package, lock.packageVersion);
	assert.equal(receipt.versions.fd, lock.tools.fdDebianVersion);
	assert.equal(receipt.versions.ripgrep, lock.tools.rgDebianVersion);
	assert.equal(receipt.versions.git, lock.tools.gitDebianVersion);
	assert.match(receipt.versions.node, /^v\d+\.\d+\.\d+$/);
	assert.match(receipt.versions.npm, /^\d+\.\d+\.\d+$/);
	assert.deepEqual(receipt.parity, {
		status: "not-compared",
		candidate: null,
	});
});
