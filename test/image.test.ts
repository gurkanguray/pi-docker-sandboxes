import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeImageLock } from "../src/image-lock.ts";
import {
	buildLocalImage,
	compareImageReceipts,
	runImageCommand,
	verifyImageReceipt,
} from "../src/image.ts";

test("local production runtime builds fail closed before invoking tools", async () => {
	await assert.rejects(
		buildLocalImage(),
		/production runtime image standard is unpublished/,
	);
});

test("verification and parity APIs fail closed until Task 8", async () => {
	const reference =
		`example.invalid/runtime@sha256:${"a".repeat(64)}` as const;
	const lock: RuntimeImageLock = {
		version: 2,
		runtimeSchema: 1,
		piVersion: "0.84.1",
		images: {
			standard: {
				status: "published",
				reference,
				platforms: ["linux/amd64", "linux/arm64"],
				privileged: false,
			},
			docker: {
				status: "unpublished",
				platforms: ["linux/amd64", "linux/arm64"],
				privileged: true,
			},
		},
	};
	await assert.rejects(
		verifyImageReceipt(reference, lock),
		/production runtime image verification is unavailable until Task 8/,
	);
	assert.throws(
		() =>
			compareImageReceipts(
				{ image: reference, digest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" },
				{ image: reference, digest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" },
			),
		/production runtime image parity verification is unavailable until Task 8/,
	);
});

test("image command failures remain structured", async () => {
	await assert.rejects(
		runImageCommand(process.execPath, ["-e", "process.exit(7)"]),
		(error: unknown) => {
			assert.equal((error as { name?: string }).name, "OperationError");
			assert.equal((error as { exitCode?: number }).exitCode, 7);
			return true;
		},
	);
});
