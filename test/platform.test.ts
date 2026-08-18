import assert from "node:assert/strict";
import test from "node:test";
import {
	certifyHostPlatform,
	detectHostPlatform,
	runtimePlatformForHost,
	type HostVersionProbe,
} from "../src/platform.ts";

test("production host mapping is explicit", () => {
	assert.deepEqual(detectHostPlatform("darwin", "arm64"), {
		os: "darwin",
		arch: "arm64",
		runtimePlatform: "linux/arm64",
	});
	assert.equal(
		detectHostPlatform("linux", "x64").runtimePlatform,
		"linux/amd64",
	);
	assert.equal(
		detectHostPlatform("linux", "arm64").runtimePlatform,
		"linux/arm64",
	);
	assert.throws(() => detectHostPlatform("win32", "x64"), /not certified/i);
});

test("runtime platform comes from the certified host mapping", () => {
	assert.equal(
		runtimePlatformForHost(detectHostPlatform("linux", "x64")),
		"linux/amd64",
	);
});

const probe = (
	macosVersion: string,
	linux: { id: string; versionId: string },
): HostVersionProbe => ({
	macosVersion: async () => macosVersion,
	linuxOsRelease: async () => linux,
});

test("production host certification enforces OS floors", async () => {
	await assert.rejects(
		certifyHostPlatform(
			detectHostPlatform("darwin", "arm64"),
			probe("13.6.9", { id: "ubuntu", versionId: "24.04" }),
		),
		/macOS 14 or newer is required/,
	);
	await assert.rejects(
		certifyHostPlatform(
			detectHostPlatform("linux", "x64"),
			probe("14.0", { id: "ubuntu", versionId: "22.04" }),
		),
		/Ubuntu 24\.04 or newer is required/,
	);
	await assert.rejects(
		certifyHostPlatform(
			detectHostPlatform("linux", "arm64"),
			probe("14.0", { id: "debian", versionId: "24.04" }),
		),
		/Ubuntu 24\.04 or newer is required/,
	);
	await assert.doesNotReject(
		certifyHostPlatform(
			detectHostPlatform("linux", "arm64"),
			probe("14.0", { id: "ubuntu", versionId: "24.04.1" }),
		),
	);
});

test("actual host passes production certification", async () => {
	await assert.doesNotReject(certifyHostPlatform(detectHostPlatform()));
});
