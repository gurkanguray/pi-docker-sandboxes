import assert from "node:assert/strict";
import { renameSync, symlinkSync } from "node:fs";
import {
	chmod,
	link,
	mkdir,
	lstat,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
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
import { loadSandboxStateResult, statePath } from "../src/workspace.ts";

test("current config is preserved without migration warnings", () => {
	const fixture = {
		version: 2 as const,
		syncProfile: "custom" as const,
		sandbox: { keep: true },
	};
	const migrated = migrateConfig(fixture, "fixture");
	assert.equal(migrated.sourceVersion, 2);
	assert.equal(migrated.migrated, false);
	assert.deepEqual(migrated.value, fixture);
	assert.deepEqual(migrated.warnings, []);
});

test("state migration rejects unknown versions with preservation instructions", () => {
	assert.throws(
		() =>
			migrateSandboxState(
				{ version: 3, unexpected: true },
				"/tmp/sandbox-state.json",
			),
		(error: unknown) => {
			assert.match((error as Error).message, /unsupported state version 3/i);
			assert.match(
				(error as Error).message,
				/preserve \/tmp\/sandbox-state\.json/i,
			);
			return true;
		},
	);
});

test("version 1 migration requires matching daemon and image evidence", () => {
	const remoteImage = `example.invalid/pi@sha256:${"b".repeat(64)}`;
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
	assert.throws(
		() => migrateSandboxState(base, "/tmp/state.json"),
		/requires matching daemon and image evidence/i,
	);
	const evidence = {
		exists: true as const,
		inspectedImage: remoteImage,
		expectedImage: remoteImage,
		runtimeSchema: 1,
		packageVersion: "1.0.0",
		migratedAt: "2026-08-18T00:00:00.000Z",
	};
	const migrated = migrateSandboxState(base, "/tmp/state.json", evidence);
	assert.equal(migrated.sourceVersion, 1);
	assert.equal(migrated.migrated, true);
	assert.equal(migrated.value.version, 2);
	assert.equal(migrated.value.phase, "ready");
	assert.equal(migrated.value.runtimeImage, remoteImage);
	assert.throws(
		() =>
			migrateSandboxState(base, "/tmp/state.json", {
				...evidence,
				inspectedImage: `example.invalid/pi@sha256:${"c".repeat(64)}`,
			}),
		/requires matching daemon and image evidence/i,
	);
});

test("version 1 parser keeps strict local image attestation checks", () => {
	const imageAttestation = {
		status: "pending" as const,
		image: `docker.io/pi-docker-sandboxes/pi:local-${"a".repeat(64)}`,
		templateStoreId: "abc123def456",
	};
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
	const evidence = {
		exists: true as const,
		inspectedImage: imageAttestation.image,
		expectedImage: imageAttestation.image,
		runtimeSchema: 1,
		packageVersion: "1.0.0",
		templateStoreId: imageAttestation.templateStoreId,
	};
	assert.equal(
		migrateSandboxState(
			{ ...base, imageAttestation },
			"/tmp/state.json",
			evidence,
		).value.imageAttestation?.status,
		"verified",
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
					evidence,
				),
			/imageAttestation|template|store/i,
		);
});

test("version 1 file migration durably preserves exact source bytes", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "pi-dsbx-v1-backup-")),
	);
	const name = "pi-v1-backup";
	const path = statePath(root, name);
	await mkdir(join(root, ".git/pi-docker-sandbox/state"), { recursive: true });
	const image = `example.invalid/pi@sha256:${"d".repeat(64)}`;
	const source = ` {\n  "version": 1,\n  "name": "${name}",\n  "hostBaseCommit": "base",\n  "hostBranch": "main",\n  "hostRepoIdentity": "identity",\n  "hostRoot": ${JSON.stringify(root)},\n  "workspaceMode": "clone",\n  "createdAt": "2026-08-12T00:00:00.000Z"\n}\n`;
	await writeFile(path, source);
	let evidenceCalls = 0;
	const migrated = await loadSandboxStateResult(
		root,
		name,
		async () => {
			evidenceCalls++;
			return {
				exists: true,
				inspectedImage: image,
				expectedImage: image,
				runtimeSchema: 1,
				packageVersion: "1.0.0",
				migratedAt: "2026-08-18T00:00:00.000Z",
			};
		},
		{
			expectedRepositoryIdentity: "identity",
			expectedWorktreeIdentity: root,
		},
	);
	assert.equal(evidenceCalls, 1);
	assert.equal(migrated.migrated, true);
	assert.equal(await readFile(`${path}.v1.backup`, "utf8"), source);
	assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
});

async function legacyStateFixture(overrides: Record<string, unknown> = {}) {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "pi-dsbx-v1-secure-")),
	);
	const name = "pi-v1-secure";
	const path = statePath(root, name);
	await mkdir(join(root, ".git/pi-docker-sandbox/state"), { recursive: true });
	const value = {
		version: 1,
		name,
		hostBaseCommit: "base",
		hostBranch: "main",
		hostRepoIdentity: "identity",
		hostRoot: root,
		workspaceMode: "clone",
		createdAt: "2026-08-12T00:00:00.000Z",
		...overrides,
	};
	const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
	await writeFile(path, bytes);
	return { root, name, path, bytes };
}

const migrationEvidence = {
	exists: true as const,
	inspectedImage: `example.invalid/pi@sha256:${"e".repeat(64)}`,
	expectedImage: `example.invalid/pi@sha256:${"e".repeat(64)}`,
	runtimeSchema: 1,
	packageVersion: "1.0.0",
};

test("v1 identity is validated before evidence, backup, or publication", async () => {
	for (const overrides of [
		{ name: "pi-other" },
		{ hostRoot: "/tmp/untrusted-state-root" },
		{ hostRepoIdentity: "other-repository" },
	]) {
		const fixture = await legacyStateFixture(overrides);
		let evidenceCalls = 0;
		await assert.rejects(
			() =>
				loadSandboxStateResult(
					fixture.root,
					fixture.name,
					async () => {
						evidenceCalls++;
						return migrationEvidence;
					},
					{
						expectedRepositoryIdentity: "identity",
						expectedWorktreeIdentity: fixture.root,
					},
				),
			(error: unknown) => {
				assert.match(
					(error as { detail?: string }).detail ?? "",
					/metadata|identity|repository/i,
				);
				return true;
			},
		);
		assert.equal(evidenceCalls, 0);
		assert.deepEqual(await readFile(fixture.path), fixture.bytes);
		await assert.rejects(readFile(`${fixture.path}.v1.backup`));
	}
});

test("existing exact regular v1 backup is durably accepted", async () => {
	const fixture = await legacyStateFixture();
	await writeFile(`${fixture.path}.v1.backup`, fixture.bytes, { mode: 0o600 });
	const migrated = await loadSandboxStateResult(
		fixture.root,
		fixture.name,
		migrationEvidence,
		{
			expectedRepositoryIdentity: "identity",
			expectedWorktreeIdentity: fixture.root,
		},
	);
	assert.equal(migrated.value.version, 2);
	assert.deepEqual(await readFile(`${fixture.path}.v1.backup`), fixture.bytes);
});

test("existing v1 backups reject symlinks and hardlinks", async () => {
	for (const kind of ["symlink", "hardlink"] as const) {
		const fixture = await legacyStateFixture();
		const target = join(fixture.root, `${kind}-target`);
		await writeFile(target, fixture.bytes);
		if (kind === "symlink") await symlink(target, `${fixture.path}.v1.backup`);
		else await link(target, `${fixture.path}.v1.backup`);
		await assert.rejects(
			() =>
				loadSandboxStateResult(fixture.root, fixture.name, migrationEvidence, {
					expectedRepositoryIdentity: "identity",
					expectedWorktreeIdentity: fixture.root,
				}),
			(error: unknown) => {
				assert.match(
					(error as { detail?: string }).detail ?? "",
					/backup|regular|link|ELOOP/i,
				);
				return true;
			},
		);
		assert.deepEqual(await readFile(fixture.path), fixture.bytes);
	}
});

test("v1 migration never overwrites state changed during async evidence", async () => {
	for (const mutation of ["replace", "rewrite", "before-replace"] as const) {
		const fixture = await legacyStateFixture();
		const future = Buffer.from('{"version":3,"future":true}\n');
		const mutate = async () => {
			if (mutation === "replace") {
				await rename(fixture.path, `${fixture.path}.old`);
				await writeFile(fixture.path, future);
			} else await writeFile(fixture.path, future);
		};
		await assert.rejects(() =>
			loadSandboxStateResult(
				fixture.root,
				fixture.name,
				async () => {
					if (mutation !== "before-replace") await mutate();
					return migrationEvidence;
				},
				{
					expectedRepositoryIdentity: "identity",
					expectedWorktreeIdentity: fixture.root,
					beforeMigrationReplace:
						mutation === "before-replace" ? mutate : undefined,
				},
			),
		);
		assert.deepEqual(await readFile(fixture.path), future);
		assert.equal(JSON.parse(await readFile(fixture.path, "utf8")).version, 3);
		await rm(`${fixture.path}.${process.pid}.tmp`, { force: true });
	}
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
