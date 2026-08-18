import assert from "node:assert/strict";
import test from "node:test";
import { loadImageLock, selectRuntimeImage } from "../src/image-lock.ts";

test("checked-in runtime images cannot enter the smoke path before publication", async () => {
	const lock = await loadImageLock();
	assert.throws(
		() => selectRuntimeImage(lock, false, "linux/amd64"),
		/production runtime image standard is unpublished/,
	);
	assert.throws(
		() => selectRuntimeImage(lock, true, "linux/arm64"),
		/production runtime image docker is unpublished/,
	);
});
