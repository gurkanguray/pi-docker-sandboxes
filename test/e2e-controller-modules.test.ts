import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importControllerModule } from "./e2e-controller-modules.ts";

test("E2E controller imports stay inside the installed package root", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-controller-root-"));
	const packageRoot = join(root, "prefix/node_modules/pi-docker-sandboxes");
	const outside = join(root, "checkout-launch.mjs");
	try {
		await mkdir(join(packageRoot, "src"), { recursive: true });
		await writeFile(
			join(packageRoot, "src/launch.mjs"),
			"export const origin = 'installed-package';\n",
		);
		await writeFile(outside, "export const origin = 'checkout';\n");

		const loaded = await importControllerModule(packageRoot, "src/launch.mjs");
		assert.equal(loaded.module.origin, "installed-package");
		assert.match(loaded.modulePath, /node_modules\/pi-docker-sandboxes\/src/);

		await symlink(outside, join(packageRoot, "src/escaped.mjs"));
		await assert.rejects(
			importControllerModule(packageRoot, "src/escaped.mjs"),
			/resolves outside installed package/i,
		);
		await assert.rejects(
			importControllerModule(packageRoot, "../../../checkout-launch.mjs"),
			/resolves outside installed package/i,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
