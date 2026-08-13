import assert from "node:assert/strict";
import { renameSync, symlinkSync } from "node:fs";
import {
	chmod,
	mkdir,
	lstat,
	mkdtemp,
	readFile,
	readdir,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	migrateConfig,
	migrateSandboxState,
	sameFileIdentity,
	writeJsonAtomic,
} from "../src/migration.ts";

test("legacy defaults migrate in memory with warnings", () => {
	const fixture = {
		version: 1,
		syncProfile: "balanced",
		sandbox: { keep: true },
	};
	const migrated = migrateConfig(fixture, "fixture");
	assert.equal(migrated.sourceVersion, 1);
	assert.equal(migrated.migrated, true);
	assert.deepEqual(migrated.value, {
		version: 1,
		syncProfile: "custom",
		sync: {
			settings: true,
			models: true,
			packages: false,
			skills: false,
			prompts: false,
			themes: false,
			extensions: false,
			sessions: "managed",
		},
		sandbox: { keep: false },
	});
	assert.ok(
		migrated.warnings.some((warning) => /safe personalization/i.test(warning)),
	);
	assert.ok(
		migrated.warnings.some((warning) => /remove.*default/i.test(warning)),
	);
	assert.deepEqual(fixture, {
		version: 1,
		syncProfile: "balanced",
		sandbox: { keep: true },
	});
});

test("explicit legacy personalization values are distinguished from old defaults", () => {
	const explicit = migrateConfig(
		{
			version: 1,
			syncProfile: "balanced",
			sync: {
				settings: true,
				models: true,
				packages: true,
				skills: true,
				prompts: false,
				themes: false,
				extensions: false,
				sessions: "managed",
			},
		},
		"fixture",
	);
	assert.equal(explicit.value.syncProfile, "custom");
	assert.equal(explicit.value.sync?.packages, true);
	assert.equal(explicit.value.sync?.skills, true);
	assert.equal(
		explicit.warnings.some((warning) =>
			/packages and resources now require explicit opt-in/i.test(warning),
		),
		true,
	);
});

test("state migration rejects unknown versions with preservation instructions", () => {
	assert.throws(
		() =>
			migrateSandboxState(
				{ version: 2, unexpected: true },
				"/tmp/sandbox-state.json",
			),
		(error: unknown) => {
			assert.match((error as Error).message, /unsupported state version 2/i);
			assert.match(
				(error as Error).message,
				/preserve \/tmp\/sandbox-state\.json/i,
			);
			return true;
		},
	);
});

test("state migration accepts strict optional local image attestation", () => {
	const base = {
		version: 1,
		name: "pi-safe",
		hostBaseCommit: "a",
		hostBranch: "main",
		hostRepoIdentity: "identity",
		hostRoot: "/repo",
		workspaceMode: "clone",
		createdAt: "2026-08-12T00:00:00.000Z",
	};
	assert.equal(
		migrateSandboxState(base, "/tmp/state.json").value.imageAttestation,
		undefined,
	);
	const imageAttestation = {
		status: "pending" as const,
		image: `docker.io/pi-docker-sandboxes/pi:local-${"a".repeat(64)}`,
		templateStoreId: "abc123def456",
	};
	assert.deepEqual(
		migrateSandboxState({ ...base, imageAttestation }, "/tmp/state.json").value
			.imageAttestation,
		imageAttestation,
	);
	for (const mutation of [
		{ ...imageAttestation, unexpected: true },
		{ ...imageAttestation, status: "unknown" },
		{ ...imageAttestation, image: "docker.io/pi:latest" },
		{ ...imageAttestation, templateStoreId: "ABC123DEF456" },
		{ ...imageAttestation, templateStoreId: "short" },
	])
		assert.throws(
			() =>
				migrateSandboxState(
					{ ...base, imageAttestation: mutation },
					"/tmp/state.json",
				),
			/imageAttestation|template|store/i,
		);
});

test("directory identity comparison uses device and inode", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-atomic-identity-"));
	const first = join(root, "first");
	const second = join(root, "second");
	await mkdir(first);
	await mkdir(second);
	const identity = await lstat(first);
	assert.equal(sameFileIdentity(identity, await lstat(first)), true);
	assert.equal(sameFileIdentity(identity, await lstat(second)), false);
	assert.equal(
		sameFileIdentity(identity, { ...identity, dev: identity.dev + 1 }),
		false,
	);
});

test("atomic writer tightens modes and writes complete files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-atomic-modes-"));
	const directory = join(root, "state");
	const destination = join(directory, "state.json");
	await mkdir(directory, { mode: 0o755 });
	await chmod(directory, 0o755);
	await writeJsonAtomic(destination, { version: 1 });
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.equal((await stat(destination)).mode & 0o777, 0o600);
	assert.equal(await readFile(destination, "utf8"), '{\n  "version": 1\n}\n');
	assert.deepEqual(
		(await readdir(directory)).filter((entry) => entry.endsWith(".tmp")),
		[],
	);
});

test("atomic writer rejects symlinked parent without mutating its target", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-atomic-symlink-"));
	const target = join(root, "target");
	const directory = join(root, "state");
	await mkdir(target, { mode: 0o755 });
	await chmod(target, 0o755);
	await writeFile(join(target, "preserved"), "target bytes");
	await symlink(target, directory);
	await assert.rejects(() =>
		writeJsonAtomic(join(directory, "state.json"), { version: 1 }),
	);
	assert.equal((await stat(target)).mode & 0o777, 0o755);
	assert.equal(
		await readFile(join(target, "preserved"), "utf8"),
		"target bytes",
	);
	assert.deepEqual(await readdir(target), ["preserved"]);
});

test("atomic writer rejects directory replacement before writing", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-atomic-replacement-"));
	const directory = join(root, "state");
	const displaced = join(root, "displaced");
	const attacker = join(root, "attacker");
	const destination = join(directory, "state.json");
	await mkdir(directory, { mode: 0o700 });
	await mkdir(attacker, { mode: 0o755 });
	await chmod(attacker, 0o755);
	await writeFile(destination, "original destination");
	await writeFile(join(attacker, "preserved"), "attacker bytes");
	await assert.rejects(() =>
		writeJsonAtomic(destination, {
			get version() {
				renameSync(directory, displaced);
				symlinkSync(attacker, directory);
				return 1;
			},
		}),
	);
	assert.equal((await stat(attacker)).mode & 0o777, 0o755);
	assert.equal(
		await readFile(join(attacker, "preserved"), "utf8"),
		"attacker bytes",
	);
	assert.deepEqual(await readdir(attacker), ["preserved"]);
	assert.equal(
		await readFile(join(displaced, "state.json"), "utf8"),
		"original destination",
	);
	assert.deepEqual(await readdir(displaced), ["state.json"]);
});

test("atomic writer uses no-follow exclusive temporary creation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-atomic-temp-link-"));
	const destination = join(root, "state.json");
	const temporary = `${destination}.${process.pid}.tmp`;
	const target = join(root, "target");
	await writeFile(destination, "original bytes");
	await writeFile(target, "target bytes");
	await symlink(target, temporary);
	await assert.rejects(() => writeJsonAtomic(destination, { version: 1 }), {
		code: "EEXIST",
	});
	assert.equal(await readFile(destination, "utf8"), "original bytes");
	assert.equal(await readFile(target, "utf8"), "target bytes");
	assert.equal((await lstat(temporary)).isSymbolicLink(), true);
});

test("atomic writer preserves valid destination bytes on forced failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-atomic-failure-"));
	const destination = join(root, "state.json");
	await writeFile(destination, "original bytes");
	await mkdir(`${destination}.${process.pid}.tmp`);
	await assert.rejects(() => writeJsonAtomic(destination, { version: 1 }));
	assert.equal(await readFile(destination, "utf8"), "original bytes");
});

test("atomic writer does not delete an unowned deterministic temp collision", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-atomic-collision-"));
	const destination = join(root, "state.json");
	const temporary = `${destination}.${process.pid}.tmp`;
	await writeFile(destination, "original bytes");
	await writeFile(temporary, "unowned bytes");
	await assert.rejects(() => writeJsonAtomic(destination, { version: 1 }), {
		code: "EEXIST",
	});
	assert.equal(await readFile(destination, "utf8"), "original bytes");
	assert.equal(await readFile(temporary, "utf8"), "unowned bytes");
});
