import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function fixture(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-dsbx-verifier-script-"));
	await mkdir(join(directory, "scripts"));
	await cp(
		new URL("../scripts/verify-image.mjs", import.meta.url),
		join(directory, "scripts", "verify-image.mjs"),
	);
	return directory;
}

test("image verification script fails explicitly without a success receipt", async () => {
	const directory = await fixture();
	try {
		await assert.rejects(
			exec(process.execPath, [
				join(directory, "scripts", "verify-image.mjs"),
				`example.invalid/runtime@sha256:${"a".repeat(64)}`,
			]),
			(error: unknown) => {
				const output = error as {
					stdout?: string;
					stderr?: string;
					code?: number;
				};
				assert.equal(output.code, 1);
				assert.match(
					output.stderr ?? "",
					/production runtime image verification is unavailable until the runtime image workflow/,
				);
				assert.doesNotMatch(output.stdout ?? "", /✓/);
				const receipt = JSON.parse(
					(output.stdout ?? "").trim().split("\n").at(-1)!,
				) as { status?: string; detail?: string };
				assert.deepEqual(receipt, {
					status: "failed",
					phase: "prepare",
					operation: "verify image",
					detail:
						"production runtime image verification is unavailable until the runtime image workflow",
				});
				return true;
			},
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
