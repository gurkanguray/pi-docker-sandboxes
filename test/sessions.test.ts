import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	access,
	chmod,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	backupSessions,
	deleteSessionBackup,
	listSessionBackups,
	pruneSessionBackups,
	reconcileSessionStaging,
	restoreSessions,
	sessionBackupRoot,
} from "../src/sessions.ts";
import { SbxCommandError, type SbxClient } from "../src/sbx/client.ts";

const exec = promisify(execFile);

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

test("missing sandbox sessions are a no-op", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
	const calls: string[] = [];
	const client = {
		exec: async (
			_name: string,
			argv: readonly string[],
			options: { user?: string },
		) => {
			calls.push(`${options.user}:${argv.join(" ")}`);
			throw new SbxCommandError(["exec", ...argv], 1);
		},
		copyFrom: async () => {
			calls.push("copy");
		},
	} as unknown as SbxClient;

	assert.equal(
		await backupSessions(client, agentDir, "repo", "sandbox"),
		undefined,
	);
	assert.deepEqual(calls, ["agent:test -e /home/agent/.pi/agent/sessions"]);
	assert.equal(
		await exists(sessionBackupRoot(agentDir, "repo", "sandbox")),
		false,
	);
});

test("existing sandbox sessions publish atomically into a private backup", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	const calls: string[] = [];
	const client = {
		exec: async (
			_name: string,
			argv: readonly string[],
			options: { user?: string },
		) => {
			calls.push(`${options.user}:${argv.join(" ")}`);
			return { stdout: "", stderr: "", code: 0 };
		},
		copyFrom: async (_name: string, source: string, destination: string) => {
			calls.push(`copy:${source}:${destination}`);
			assert.match(basename(destination), /^\.partial-/);
			assert.equal((await stat(root)).mode & 0o777, 0o700);
			assert.equal((await stat(destination)).mode & 0o777, 0o700);
			assert.equal(
				(await readdir(root)).some((entry) => /^\d{4}-/.test(entry)),
				false,
			);
			await mkdir(join(destination, "sessions"));
		},
	} as unknown as SbxClient;

	const destination = await backupSessions(client, agentDir, "repo", "sandbox");
	assert.ok(destination);
	assert.deepEqual(calls.slice(0, 2), [
		"agent:test -e /home/agent/.pi/agent/sessions",
		"agent:test -d /home/agent/.pi/agent/sessions",
	]);
	assert.match(
		basename(destination),
		/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/,
	);
	assert.match(
		calls[2]!,
		/^copy:\/home\/agent\/\.pi\/agent\/sessions:.*\/\.partial-/,
	);
	assert.deepEqual(await readdir(root), [basename(destination)]);
	assert.equal((await stat(destination)).mode & 0o777, 0o700);
});

test("backup rejects a symlink in its controlled path ancestors", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-link-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-outside-"));
	await symlink(outside, join(agentDir, "docker-sandboxes"));
	const client = {
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		copyFrom: async () => assert.fail("must not copy"),
	} as unknown as SbxClient;

	await assert.rejects(
		backupSessions(client, agentDir, "repo", "sandbox"),
		/symlink|symbolic link/i,
	);
	assert.deepEqual(await readdir(outside), []);
});

test("failed session copy publishes no backup and removes its partial", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	const failure = new Error("injected copy failure");
	const client = {
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		copyFrom: async () => {
			throw failure;
		},
	} as unknown as SbxClient;

	await assert.rejects(
		backupSessions(client, agentDir, "repo", "sandbox"),
		failure,
	);
	assert.deepEqual(await readdir(root), []);
	assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test("session source type and inspection failures propagate without a backup", async () => {
	for (const failure of [
		new SbxCommandError(["exec", "test", "-d"], 1),
		new SbxCommandError(["exec", "test", "-e"], 2),
	]) {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
		let inspections = 0;
		const client = {
			exec: async () => {
				inspections++;
				if (inspections === 1 && failure.exitCode === 1)
					return { stdout: "", stderr: "", code: 0 };
				throw failure;
			},
			copyFrom: async () => assert.fail("must not copy"),
		} as unknown as SbxClient;

		await assert.rejects(
			backupSessions(client, agentDir, "repo", "sandbox"),
			failure,
		);
		assert.equal(
			await exists(sessionBackupRoot(agentDir, "repo", "sandbox")),
			false,
		);
	}
});

test("session retention prunes oldest by count, age, and bytes but keeps latest", async () => {
	for (const [policy, expected] of [
		[{ maxCount: 2, maxAgeDays: 3650, maxBytes: 1_000_000 }, 2],
		[{ maxCount: 10, maxAgeDays: 1, maxBytes: 1_000_000 }, 1],
		[{ maxCount: 10, maxAgeDays: 3650, maxBytes: 5 }, 2],
	] as const) {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-retention-"));
		const root = sessionBackupRoot(agentDir, "repo", "sandbox");
		for (const [id, contents] of [
			["2026-08-10T00-00-00-000Z", "aaaa"],
			["2026-08-11T00-00-00-000Z", "bbbb"],
			["2026-08-12T00-00-00-000Z", "cccc"],
		] as const) {
			await mkdir(join(root, id, "sessions"), { recursive: true });
			await writeFile(join(root, id, "sessions", "data"), contents);
		}
		await pruneSessionBackups(
			agentDir,
			"repo",
			"sandbox",
			policy,
			new Date("2026-08-13T12:00:00.000Z"),
		);
		const backups = await listSessionBackups(agentDir, "repo", "sandbox");
		assert.equal(backups.length, expected);
		assert.equal(backups.at(-1)?.id, "2026-08-12T00-00-00-000Z");
		assert.equal(
			(await readdir(root)).some((entry) => entry.startsWith(".deleting-")),
			false,
		);
	}
});

test("byte retention excludes the protected latest backup", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-retention-latest-"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	for (const [id, contents] of [
		["2026-08-10T00-00-00-000Z", "1234"],
		["2026-08-11T00-00-00-000Z", "5678"],
		["2026-08-12T00-00-00-000Z", "x".repeat(100)],
	] as const) {
		await mkdir(join(root, id, "sessions"), { recursive: true });
		await writeFile(join(root, id, "sessions", "data"), contents);
	}
	await pruneSessionBackups(
		agentDir,
		"repo",
		"sandbox",
		{ maxCount: 10, maxAgeDays: 3650, maxBytes: 8 },
		new Date("2026-08-13T00:00:00.000Z"),
	);
	assert.deepEqual(
		(await listSessionBackups(agentDir, "repo", "sandbox")).map(
			(backup) => backup.id,
		),
		[
			"2026-08-10T00-00-00-000Z",
			"2026-08-11T00-00-00-000Z",
			"2026-08-12T00-00-00-000Z",
		],
	);
});

test("session list/delete and owned stale staging are explicit and bounded", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-session-admin-"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	const id = "2026-08-12T00-00-00-000Z";
	await mkdir(join(root, id, "sessions"), { recursive: true });
	await writeFile(join(root, id, "sessions", "data"), "session");
	const partialName = ".partial-2026-08-11T00-00-00-000Z-dead";
	await mkdir(join(root, partialName));
	await writeFile(
		join(root, `${partialName}.owner.json`),
		JSON.stringify({
			schema: 1,
			kind: "pi-dsbx-session-staging",
			path: partialName,
			pid: 999_999_999,
			...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
		}),
	);
	await mkdir(join(root, ".partial-unowned"));
	assert.deepEqual(await reconcileSessionStaging(agentDir, "repo", "sandbox"), [
		join(root, partialName),
	]);
	assert.equal(await exists(join(root, ".partial-unowned")), true);
	assert.equal(
		(await listSessionBackups(agentDir, "repo", "sandbox")).length,
		1,
	);
	await deleteSessionBackup(agentDir, "repo", "sandbox", id);
	assert.deepEqual(await listSessionBackups(agentDir, "repo", "sandbox"), []);
});

test("restore selects only the latest backup and atomically swaps exact sessions", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	for (const timestamp of [
		"2026-08-12T00-00-00-000Z",
		"2026-08-14T12-34-56-789Z",
		"2026-08-13T00-00-00-000Z",
	])
		await mkdir(join(root, timestamp, "sessions"), { recursive: true });
	const calls: string[][] = [];
	const client = {
		copyTo: async (name: string, source: string, destination: string) => {
			calls.push([name, source, destination]);
		},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	} as unknown as SbxClient;

	assert.deepEqual(
		await restoreSessions(client, agentDir, "repo", "sandbox"),
		{
			backupDirectory: join(root, "2026-08-14T12-34-56-789Z"),
			warnings: [],
		},
	);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.[0], "sandbox");
	assert.equal(
		calls[0]?.[1],
		join(root, "2026-08-14T12-34-56-789Z", "sessions"),
	);
	assert.match(
		calls[0]?.[2] ?? "",
		/^\/home\/agent\/\.pi\/agent\/\.sessions-restore-/,
	);
});

test("real restore shell rolls back swap, lost-response, and validation failures", async (t) => {
	for (const mode of [
		"swap-failure",
		"lost-response",
		"validation-failure",
		"host-validation-failure",
	] as const) {
		await t.test(mode, async () => {
			const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-restore-shell-"));
			const sandbox = await mkdtemp(join(tmpdir(), "pi-dsbx-restore-target-"));
			const id = "2026-08-14T12-34-56-789Z";
			const sessions = join(
				sessionBackupRoot(agentDir, "repo", "sandbox"),
				id,
				"sessions",
			);
			await mkdir(sessions, { recursive: true });
			await writeFile(join(sessions, "value"), "new\n");
			const target = join(sandbox, "sessions");
			await mkdir(target);
			await writeFile(join(target, "value"), "old\n");
			const fakeBin = join(sandbox, "bin");
			await mkdir(fakeBin);
			await writeFile(
				join(fakeBin, "mv"),
				'#!/bin/sh\nif [ "$2" = "$FAIL_STAGED" ]; then exit 42; fi\nexec /bin/mv "$@"\n',
			);
			await chmod(join(fakeBin, "mv"), 0o755);
			let shellCalls = 0;
			let staged = "";
			const map = (path: string): string =>
				path === "/home/agent/.pi/agent/sessions"
					? target
					: join(sandbox, basename(path));
			const client = {
				copyTo: async (_name: string, source: string, destination: string) => {
					staged = map(destination);
					await cp(source, staged, { recursive: true });
				},
				exec: async (_name: string, argv: string[]) => {
					if (argv[0] === "rm") {
						await rm(map(argv[3]!), { recursive: true, force: true });
						return { stdout: "", stderr: "", code: 0 };
					}
					shellCalls++;
					if (mode === "validation-failure" && shellCalls === 2)
						throw new Error("injected target validation failure");
					const args = argv.slice(1).map((value, index) =>
						index >= 3 ? map(value) : value,
					);
					await exec("sh", args, {
						env: {
							...process.env,
							...(mode === "swap-failure" && shellCalls === 1
								? {
										PATH: `${fakeBin}:${process.env.PATH}`,
										FAIL_STAGED: staged,
									}
								: {}),
						},
					});
					if (mode === "lost-response" && shellCalls === 1)
						throw new Error("injected lost response");
					if (mode === "host-validation-failure" && shellCalls === 2)
						await rm(join(sessions, ".."), { recursive: true });
					return { stdout: "", stderr: "", code: 0 };
				},
			} as unknown as SbxClient;

			await assert.rejects(
				restoreSessions(client, agentDir, "repo", "sandbox", id),
				/failure|response|Command failed|ENOENT/,
			);
			assert.equal(await readFile(join(target, "value"), "utf8"), "old\n");
			assert.equal(
				(await readdir(sandbox)).some((entry) =>
					/\.sessions-(?:restore|rollback)-/.test(entry),
				),
				false,
			);
		});
	}
});

test("restore cleanup residue is a warning after a valid target", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-restore-cleanup-"));
	const sandbox = await mkdtemp(join(tmpdir(), "pi-dsbx-restore-target-"));
	const id = "2026-08-14T12-34-56-789Z";
	const sessions = join(
		sessionBackupRoot(agentDir, "repo", "sandbox"),
		id,
		"sessions",
	);
	await mkdir(sessions, { recursive: true });
	await writeFile(join(sessions, "value"), "new\n");
	const target = join(sandbox, "sessions");
	await mkdir(target);
	await writeFile(join(target, "value"), "old\n");
	let shellCalls = 0;
	const map = (path: string): string =>
		path === "/home/agent/.pi/agent/sessions"
			? target
			: join(sandbox, basename(path));
	const client = {
		copyTo: async (_name: string, source: string, destination: string) =>
			cp(source, map(destination), { recursive: true }),
		exec: async (_name: string, argv: string[]) => {
			shellCalls++;
			if (shellCalls === 3) throw new Error("injected cleanup residue");
			await exec(
				"sh",
				argv.slice(1).map((value, index) => (index >= 3 ? map(value) : value)),
			);
			return { stdout: "", stderr: "", code: 0 };
		},
	} as unknown as SbxClient;
	const result = await restoreSessions(client, agentDir, "repo", "sandbox", id);
	assert.equal(result?.backupDirectory, join(sessions, ".."));
	assert.match(result?.warnings[0] ?? "", /cleanup.*residue/i);
	assert.equal(await readFile(join(target, "value"), "utf8"), "new\n");
	assert.equal(
		(await readdir(sandbox)).some((entry) => entry.startsWith(".sessions-rollback-")),
		true,
	);
});

test("restore rejects a symlink in its controlled path ancestors", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-link-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-outside-"));
	await symlink(outside, join(agentDir, "docker-sandboxes"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	await mkdir(join(root, "2026-08-14T12-34-56-789Z", "sessions"), {
		recursive: true,
	});
	const client = {
		copyTo: async () => assert.fail("must not restore"),
	} as unknown as SbxClient;

	await assert.rejects(
		restoreSessions(client, agentDir, "repo", "sandbox"),
		/symlink|symbolic link/i,
	);
});

test("restore is a no-op when the backup root is missing or empty", async () => {
	for (const createRoot of [false, true]) {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
		if (createRoot)
			await mkdir(sessionBackupRoot(agentDir, "repo", "sandbox"), {
				recursive: true,
			});
		const client = {
			copyTo: async () => assert.fail("must not copy"),
		} as unknown as SbxClient;

		assert.equal(
			await restoreSessions(client, agentDir, "repo", "sandbox"),
			undefined,
		);
	}
});

test("restore ignores partial and arbitrary entries when selecting newest backup", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	const valid = "2026-08-14T12-34-56-789Z";
	for (const entry of [valid, ".partial-2026-08-15T00-00-00-000Z-abc", "zzzz"])
		await mkdir(join(root, entry, "sessions"), { recursive: true });
	let source = "";
	const client = {
		copyTo: async (_name: string, value: string) => {
			source = value;
		},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	} as unknown as SbxClient;

	assert.deepEqual(
		await restoreSessions(client, agentDir, "repo", "sandbox"),
		{ backupDirectory: join(root, valid), warnings: [] },
	);
	assert.equal(source, join(root, valid, "sessions"));
});

test("newest published backup fails closed when incomplete", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	await mkdir(join(root, "2026-08-13T00-00-00-000Z", "sessions"), {
		recursive: true,
	});
	await mkdir(join(root, "2026-08-14T00-00-00-000Z"));
	const client = {
		copyTo: async () => assert.fail("must not copy"),
	} as unknown as SbxClient;

	await assert.rejects(
		restoreSessions(client, agentDir, "repo", "sandbox"),
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
});

test("restore rejects symlink and non-directory backup candidates", async () => {
	for (const kind of ["symlink", "file"] as const) {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
		const root = sessionBackupRoot(agentDir, "repo", "sandbox");
		const candidate = join(root, "2026-08-14T12-34-56-789Z");
		await mkdir(root, { recursive: true });
		if (kind === "symlink") {
			const target = join(agentDir, "outside");
			await mkdir(join(target, "sessions"), { recursive: true });
			await symlink(target, candidate);
		} else await writeFile(candidate, "not a backup directory");
		const client = {
			copyTo: async () => assert.fail("must not copy"),
		} as unknown as SbxClient;

		await assert.rejects(
			restoreSessions(client, agentDir, "repo", "sandbox"),
			/directory|symbolic link/i,
		);
	}
});

test("restore rejects symlink and non-directory sessions children", async () => {
	for (const kind of ["symlink", "file"] as const) {
		const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
		const candidate = join(
			sessionBackupRoot(agentDir, "repo", "sandbox"),
			"2026-08-14T12-34-56-789Z",
		);
		await mkdir(candidate, { recursive: true });
		const sessions = join(candidate, "sessions");
		if (kind === "symlink") {
			const target = join(agentDir, "outside");
			await mkdir(target);
			await symlink(target, sessions);
		} else await writeFile(sessions, "not a sessions directory");
		const client = {
			copyTo: async () => assert.fail("must not copy"),
		} as unknown as SbxClient;

		await assert.rejects(
			restoreSessions(client, agentDir, "repo", "sandbox"),
			/directory|symbolic link/i,
		);
	}
});

test("restore rejects a symlink backup root", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
	const root = sessionBackupRoot(agentDir, "repo", "sandbox");
	const target = join(agentDir, "outside");
	await mkdir(join(target, "2026-08-14T12-34-56-789Z", "sessions"), {
		recursive: true,
	});
	await mkdir(join(root, ".."), { recursive: true });
	await symlink(target, root);
	const client = {
		copyTo: async () => assert.fail("must not copy"),
	} as unknown as SbxClient;

	await assert.rejects(
		restoreSessions(client, agentDir, "repo", "sandbox"),
		/directory|symbolic link/i,
	);
});

test("restore propagates a candidate disappearance race", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-sessions-"));
	const candidate = join(
		sessionBackupRoot(agentDir, "repo", "sandbox"),
		"2026-08-14T12-34-56-789Z",
	);
	await mkdir(join(candidate, "sessions"), { recursive: true });
	const client = {
		copyTo: async () => {
			await rm(candidate, { recursive: true });
			const error = new Error("candidate disappeared") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	} as unknown as SbxClient;

	await assert.rejects(
		restoreSessions(client, agentDir, "repo", "sandbox"),
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
});
