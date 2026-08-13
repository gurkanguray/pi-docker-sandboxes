import assert from "node:assert/strict";
import test from "node:test";
import { verifyCreatedImage } from "../src/launch.ts";

const hex = "a".repeat(64);
const image = `docker.io/pi-docker-sandboxes/pi:local-${hex}`;
const storeId = "abc123def456";

test("created local sandbox inspection must match the selected tag and store ID", () => {
	assert.doesNotThrow(() =>
		verifyCreatedImage(
			{ image, image_digest: `sha256:${storeId}7890` },
			{ image, templateStoreId: storeId },
		),
	);
	for (const inspection of [
		{},
		{ image: `${image}-wrong`, image_digest: `sha256:${storeId}7890` },
		{ image, image_digest: "sha256:def456abc123" },
		{ image, image_digest: storeId },
	])
		assert.throws(
			() => verifyCreatedImage(inspection, { image, templateStoreId: storeId }),
			/created sandbox image/i,
		);
});
