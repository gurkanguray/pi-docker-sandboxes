import assert from "node:assert/strict";
import test from "node:test";
import { buildLocalImage, runImageCommand } from "../src/image.ts";

test("local production runtime builds fail closed before invoking tools", async () => {
	await assert.rejects(
		buildLocalImage(),
		/production runtime image standard is unpublished/,
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
