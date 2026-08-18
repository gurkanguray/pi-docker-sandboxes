import assert from "node:assert/strict";
import test from "node:test";
import {
	detectHostPlatform,
	runtimePlatformForHost,
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
