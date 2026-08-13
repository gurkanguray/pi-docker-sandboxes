import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	chmod,
	mkdtemp,
	readFile,
	realpath,
	writeFile,
	access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createWarningReporter, main } from "../src/cli.ts";
import {
	inspectRepository,
	sandboxName,
	saveSandboxState,
	statePath,
} from "../src/workspace.ts";

const exec = promisify(execFile);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;

async function fixture(
	options: { git?: boolean; state?: boolean } = { git: true, state: true },
): Promise<{ root: string; bin: string; log: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-cli-destroy-"));
	if (options.git !== false) {
		await exec("git", ["init", "-b", "main"], { cwd: root });
		await exec("git", ["config", "user.email", "test@example.com"], {
			cwd: root,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: root });
		await writeFile(join(root, "file.txt"), "initial\n");
		await exec("git", ["add", "file.txt"], { cwd: root });
		await exec("git", ["commit", "-m", "initial"], { cwd: root });
	}
	const canonical = await realpath(root);
	if (options.git !== false && options.state !== false) {
		const repository = await inspectRepository(canonical);
		const name = sandboxName(canonical);
		await saveSandboxState({
			version: 1,
			name,
			hostBaseCommit: repository.head,
			hostBranch: repository.branch,
			hostRepoIdentity: repository.identity,
			hostRoot: canonical,
			workspaceMode: "clone",
			createdAt: "2026-08-12T00:00:00.000Z",
		});
	}
	const bin = join(root, "bin");
	const log = join(root, "sbx.log");
	await exec("mkdir", ["-p", bin]);
	const script = join(bin, "sbx");
	await writeFile(
		script,
		`#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\nappendFileSync(process.env.FAKE_SBX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\nif (process.argv[2] === "exec") process.stdout.write(process.env.FAKE_DIRTY === "1" ? " M file.txt\\n" : "");\n`,
	);
	await chmod(script, 0o755);
	return { root: canonical, bin, log };
}

async function runDestroy(
	subject: Awaited<ReturnType<typeof fixture>>,
	args: string[],
	dirty: boolean,
): Promise<{ code: number; stderr: string; calls: string[][] }> {
	try {
		await exec(
			process.execPath,
			["--experimental-strip-types", cli, "destroy", ...args],
			{
				cwd: subject.root,
				env: {
					...process.env,
					PATH: `${subject.bin}:${process.env.PATH}`,
					FAKE_SBX_LOG: subject.log,
					FAKE_DIRTY: dirty ? "1" : "0",
				},
			},
		);
		return {
			code: 0,
			stderr: "",
			calls: (await readFile(subject.log, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		};
	} catch (cause) {
		const error = cause as { code: number; stderr: string };
		let calls: string[][] = [];
		try {
			calls = (await readFile(subject.log, "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		} catch {
			calls = [];
		}
		return { code: error.code, stderr: error.stderr, calls };
	}
}

test("warning reporter prints delivered preflight warnings once and later warnings", () => {
	const output: string[] = [];
	const reporter = createWarningReporter((message) => output.push(message));
	reporter.onWarning("provider warning");
	reporter.reportRemaining(["provider warning", "later warning"]);
	assert.deepEqual(output, ["! provider warning", "! later warning"]);
});

test("inline false destroy booleans strip without granting authority", async () => {
	const dirty = await fixture();
	const rejected = await runDestroy(
		dirty,
		["--yes=false", "--discard-changes=false"],
		true,
	);
	assert.equal(rejected.code, 1);
	assert.match(rejected.stderr, /--discard-changes/);
	assert.deepEqual(
		rejected.calls.map((call) => call[0]),
		["exec"],
	);

	const invalid = await fixture();
	const malformed = await runDestroy(invalid, ["--yes=maybe"], false);
	assert.equal(malformed.code, 1);
	assert.match(malformed.stderr, /boolean true or false/);
	assert.deepEqual(malformed.calls, []);
});

test("direct destroy recovery works without Git or clone state", async () => {
	const subject = await fixture({ git: false, state: false });
	const name = "pi-direct-recovery";
	const removed = await runDestroy(
		subject,
		["--name", name, "--direct", "--discard-changes"],
		false,
	);
	assert.equal(removed.code, 0, removed.stderr);
	assert.deepEqual(removed.calls, [["rm", "--force", name]]);

	const yesOnly = await fixture({ git: false, state: false });
	const rejected = await runDestroy(
		yesOnly,
		["--name", name, "--direct", "--yes"],
		false,
	);
	assert.equal(rejected.code, 1);
	assert.match(rejected.stderr, /--discard-changes/);
	assert.deepEqual(rejected.calls, []);
});

test("--yes cannot discard dirty sandbox changes", async () => {
	const subject = await fixture();
	const result = await runDestroy(subject, ["--yes"], true);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /--discard-changes/);
	assert.deepEqual(
		result.calls.map((call) => call[0]),
		["exec"],
	);
});

test("--discard-changes authorizes dirty removal and --yes authorizes clean removal", async () => {
	for (const [args, dirty] of [
		[["--discard-changes"], true],
		[["--yes"], false],
	] as const) {
		const subject = await fixture();
		const result = await runDestroy(subject, [...args], dirty);
		assert.equal(result.code, 0, result.stderr);
		assert.deepEqual(
			result.calls.map((call) => call[0]),
			["exec", "rm"],
		);
		await assert.rejects(
			access(statePath(subject.root, sandboxName(subject.root))),
		);
	}
});

test("destroy reports stale state custody when exact state cleanup fails", async () => {
	const subject = await fixture();
	const path = statePath(subject.root, sandboxName(subject.root));
	const previousCwd = process.cwd();
	const previousPath = process.env.PATH;
	process.chdir(subject.root);
	process.env.PATH = `${subject.bin}:${previousPath}`;
	process.env.FAKE_SBX_LOG = subject.log;
	process.env.FAKE_DIRTY = "0";
	try {
		await assert.rejects(
			main(["destroy", "--yes"], {
				removeState: async (actual) => {
					assert.equal(actual, path);
					throw new Error("injected exact state cleanup failure");
				},
			}),
			(error: unknown) => {
				assert.equal((error as { phase?: string }).phase, "remove-or-keep");
				assert.match(
					(error as { detail?: string }).detail ?? "",
					/sandbox.*gone.*stale state/i,
				);
				assert.deepEqual((error as { recovery?: string[] }).recovery, [
					`Inspect ${path} and its parent directory manually`,
				]);
				return true;
			},
		);
		const calls = (await readFile(subject.log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			calls.map((call) => call[0]),
			["exec", "rm"],
		);
	} finally {
		process.chdir(previousCwd);
		process.env.PATH = previousPath;
		delete process.env.FAKE_SBX_LOG;
		delete process.env.FAKE_DIRTY;
	}
});
