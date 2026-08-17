import assert from "node:assert/strict";
import {
	access,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
	backupSessions,
	restoreSessions,
	sessionBackupRoot,
} from "../src/sessions.ts";
import { SbxCommandError, type SbxClient } from "../src/sbx/client.ts";

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

test("restore selects only the latest backup and copies its sessions directory", async () => {
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
	} as unknown as SbxClient;

	assert.equal(
		await restoreSessions(client, agentDir, "repo", "sandbox"),
		join(root, "2026-08-14T12-34-56-789Z"),
	);
	assert.deepEqual(calls, [
		[
			"sandbox",
			join(root, "2026-08-14T12-34-56-789Z", "sessions"),
			"/home/agent/.pi/agent/",
		],
	]);
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
	} as unknown as SbxClient;

	assert.equal(
		await restoreSessions(client, agentDir, "repo", "sandbox"),
		join(root, valid),
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
	} as unknown as SbxClient;

	await assert.rejects(
		restoreSessions(client, agentDir, "repo", "sandbox"),
		(error: NodeJS.ErrnoException) => error.code === "ENOENT",
	);
});
