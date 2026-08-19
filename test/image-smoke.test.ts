import assert from "node:assert/strict";
import test from "node:test";
import { loadImageLock, selectRuntimeImage } from "../src/image-lock.ts";

test("checked-in runtime selects the published standard image only", async () => {
	const lock = await loadImageLock();
	assert.equal(
		selectRuntimeImage(lock, false, "linux/amd64").reference,
		"ghcr.io/gurkanguray/pi-docker-sandboxes-runtime-standard@sha256:43433061a13ba16ca6e2d327d245844199acd231b9a4087aa26773e5f2d6714b",
	);
	assert.throws(
		() => selectRuntimeImage(lock, true, "linux/arm64"),
		/private Docker engine is unavailable in production 1\.0/,
	);
});
