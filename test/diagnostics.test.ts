import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	access,
	mkdir,
	mkdtemp,
	rm,
	type statfs,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	buildDoctorReceipt,
	buildStatusReceipt,
	diagnosticsExitCode,
} from "../src/diagnostics.ts";
import { IMAGE_LOCK } from "../src/image-lock.ts";
import type { SbxClient } from "../src/sbx/client.ts";
import { createOwnedHostStaging } from "../src/workspace.ts";

const exec = promisify(execFile);

async function repository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-dsbx-diagnostics-"));
	await exec("git", ["init", "-b", "main"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, "file"), "test\n");
	await exec("git", ["add", "file"], { cwd: root });
	await exec("git", ["commit", "-m", "initial"], { cwd: root });
	return root;
}

function client(overrides: Partial<SbxClient> = {}): SbxClient {
	return {
		version: async () => ({ version: "0.38.0" }),
		capabilities: async () => ({
			clone: true,
			noShareSkills: true,
			kitValidate: true,
			inspectJson: true,
			policyCheckNetwork: true,
			credentialServices: [],
		}),
		list: async () => [],
		exists: async () => false,
		secretServices: async () => new Set<string>(),
		...overrides,
	} as unknown as SbxClient;
}

test("doctor JSON receipt is schema-versioned, ordered, deterministic, and redacted", async () => {
	const cwd = await repository();
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-agent-"));
	await mkdir(agentDir, { recursive: true });
	const secret = "sk-secretvalue123456";
	const receipt = await buildDoctorReceipt({
		cwd,
		agentDir,
		client: client(),
		now: new Date("2026-08-18T00:00:00.000Z"),
		platform: "darwin",
		arch: "arm64",
		nodeVersion: "v22.19.0",
		certifyPlatform: () =>
			Promise.resolve({
				os: "darwin",
				arch: "arm64",
				runtimePlatform: "linux/arm64",
			}),
		runCommand: async (command, args) =>
			command === "pi" ? "0.84.2" : args[0] === "info" ? cwd : `27.0.0-${secret}`,
	});
	assert.equal(receipt.schemaVersion, 1);
	assert.equal(receipt.kind, "pi-dsbx.doctor");
	assert.equal(receipt.generatedAt, "2026-08-18T00:00:00.000Z");
	assert.deepEqual(
		receipt.checks.map((entry) => entry.id),
		[...receipt.checks.map((entry) => entry.id)].sort(),
	);
	assert.equal(JSON.stringify(receipt).includes(secret), false);
	assert.equal(JSON.stringify(receipt).includes(cwd), false);
	assert.equal(
		receipt.checks.find((entry) => entry.id === "node")?.data?.expectedRange,
		"^22.19.0 || ^24.12.0",
	);
	assert.equal(
		receipt.checks.find((entry) => entry.id === "pi")?.data?.expectedRange,
		">=0.84.1 <0.85.0",
	);
	assert.equal(
		receipt.checks.some((entry) => entry.id === "image"),
		true,
	);
	assert.equal(
		receipt.checks.some((entry) => entry.id === "disk"),
		true,
	);
	assert.equal(
		receipt.checks.some((entry) => entry.id === "backup"),
		true,
	);
	assert.equal(
		receipt.checks.some((entry) => entry.id === "auth"),
		true,
	);
	assert.equal(diagnosticsExitCode(receipt), 0);
});

test("doctor is observational and preserves abandoned host staging", async () => {
	const cwd = await repository();
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-agent-"));
	const staging = await createOwnedHostStaging(tmpdir(), {
		pid: 2_147_483_647,
	});
	try {
		await buildDoctorReceipt({
			cwd,
			agentDir,
			client: client(),
			platform: "darwin",
			arch: "arm64",
			certifyPlatform: () =>
				Promise.resolve({
					os: "darwin",
					arch: "arm64",
					runtimePlatform: "linux/arm64",
				}),
			runCommand: async (command, args) =>
				command === "pi" ? "0.84.2" : args[0] === "info" ? cwd : "27.0.0",
		});
		await access(staging);
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
});

test("doctor rejects prerelease Node and Pi versions for stable ranges", async () => {
	const cwd = await repository();
	const receipt = await buildDoctorReceipt({
		cwd,
		client: client(),
		platform: "darwin",
		arch: "arm64",
		nodeVersion: "v24.12.0-rc.1",
		certifyPlatform: async () => ({
			os: "darwin",
			arch: "arm64",
			runtimePlatform: "linux/arm64",
		}),
		runCommand: async (command, args) =>
			command === "pi" ? "0.84.2-beta" : args[0] === "info" ? cwd : "27.0.0",
	});
	assert.equal(
		receipt.checks.find((entry) => entry.id === "node")?.level,
		"fail",
	);
	assert.equal(receipt.checks.find((entry) => entry.id === "pi")?.level, "fail");
	assert.equal(
		receipt.checks.find((entry) => entry.id === "pi")?.data?.version,
		"0.84.2-beta",
	);
});

test("doctor redacts POSIX and Windows paths while retaining failure codes", async () => {
	const cwd = await repository();
	const secret = "sk-secretvalue123456";
	const error = new Error(
		`denied "/home/alice/private file", '/opt/app/data', /workspace/repo/file, C:\\Users\\Alice\\secret.txt, and "\\\\server\\share\\private file" ${secret}`,
	) as NodeJS.ErrnoException;
	error.code = "EACCES";
	const receipt = await buildDoctorReceipt({
		cwd,
		client: client(),
		platform: "darwin",
		arch: "arm64",
		nodeVersion: "v24.12.0",
		certifyPlatform: () => Promise.reject(error),
		runCommand: async (command, args) =>
			command === "pi"
				? IMAGE_LOCK.piVersion
				: args[0] === "info"
					? cwd
					: "27.0.0",
	});
	const summary = receipt.checks.find((entry) => entry.id === "host")?.summary;
	assert.match(summary ?? "", /EACCES: denied/);
	assert.equal((summary?.match(/\[private-path\]/g) ?? []).length, 5);
	for (const privateValue of [
		"/home/alice",
		"/opt/app",
		"/workspace/repo",
		"C:\\Users\\Alice",
		"server\\share",
		secret,
	])
		assert.equal(JSON.stringify(receipt).includes(privateValue), false);
});

test("doctor and status use deterministic nonzero reconciliation exits", async () => {
	const cwd = await repository();
	const options = {
		cwd,
		client: client(),
		now: new Date("2026-08-18T00:00:00.000Z"),
		platform: "darwin" as const,
		arch: "arm64",
		nodeVersion: "v23.0.0",
		certifyPlatform: () =>
			Promise.resolve({
				os: "darwin" as const,
				arch: "arm64" as const,
				runtimePlatform: "linux/arm64" as const,
			}),
		runCommand: async (command: string, args: readonly string[]) =>
			command === "pi"
				? IMAGE_LOCK.piVersion
				: args[0] === "info"
					? cwd
					: "27.0.0",
	};
	const doctor = await buildDoctorReceipt(options);
	assert.equal(
		doctor.checks.find((entry) => entry.id === "node")?.level,
		"fail",
	);
	assert.equal(diagnosticsExitCode(doctor), 1);
	const status = await buildStatusReceipt(options);
	assert.equal(status.schemaVersion, 1);
	assert.equal(status.kind, "pi-dsbx.status");
	assert.deepEqual(
		status.checks.map((entry) => entry.id),
		["backup", "git", "image", "lease", "lifecycle", "upgrade"],
	);
	assert.equal(diagnosticsExitCode(status), 0);
});

test("doctor uses real host certification and a usable KVM character device", async () => {
	const cwd = await repository();
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-agent-"));
	let opened = false;
	const receipt = await buildDoctorReceipt({
		cwd,
		agentDir,
		client: client(),
		platform: "linux",
		arch: "x64",
		nodeVersion: "v24.12.0",
		certifyPlatform: async () => ({
			os: "linux",
			arch: "x64",
			runtimePlatform: "linux/amd64",
		}),
		statKvm: async () => ({ isCharacterDevice: () => true }),
		openKvm: async () => {
			opened = true;
			return { close: async () => undefined };
		},
		runCommand: async (command, args) =>
			command === "pi"
				? IMAGE_LOCK.piVersion
				: args[0] === "info"
					? cwd
					: "27.0.0",
	});
	assert.equal(
		receipt.checks.find((entry) => entry.id === "host")?.level,
		"pass",
	);
	assert.equal(
		receipt.checks.find((entry) => entry.id === "kvm")?.level,
		"pass",
	);
	assert.equal(opened, true);
});

test("doctor fails unsupported versions, non-device KVM, and missing explicit auth", async () => {
	const cwd = await repository();
	const home = await mkdtemp(join(tmpdir(), "pi-dsbx-diagnostics-home-"));
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(home, ".pi", "agent", "docker-sandboxes.json"),
		JSON.stringify({
			version: 2,
			auth: { mode: "proxy", providers: ["openai"] },
		}),
	);
	const receipt = await buildDoctorReceipt({
		cwd,
		agentDir: join(home, ".pi", "agent"),
		home: home,
		client: client({
			capabilities: async () => ({
				clone: true,
				noShareSkills: true,
				kitValidate: true,
				inspectJson: true,
				policyCheckNetwork: true,
				credentialServices: ["openai"],
			}),
		}),
		platform: "linux",
		arch: "x64",
		nodeVersion: "v24.12.0",
		certifyPlatform: () =>
			Promise.reject(new Error("Ubuntu 24.04 or newer is required")),
		statKvm: async () => ({ isCharacterDevice: () => false }),
		runCommand: async (command, args) =>
			command === "pi"
				? IMAGE_LOCK.piVersion
				: args[0] === "info"
					? cwd
					: "27.0.0",
	});
	assert.equal(
		receipt.checks.find((entry) => entry.id === "host")?.level,
		"fail",
	);
	assert.equal(
		receipt.checks.find((entry) => entry.id === "kvm")?.level,
		"fail",
	);
	assert.equal(
		receipt.checks.find((entry) => entry.id === "auth")?.level,
		"warning",
	);
});

test("Docker Desktop VM storage reports usage without host statfs ENOENT", async () => {
	const cwd = await repository();
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-agent-"));
	const statted: string[] = [];
	const usage =
		'{"Type":"Images","TotalCount":"3","Active":"1","Size":"1.2GB","Reclaimable":"400MB (33%)"}';
	const receipt = await buildDoctorReceipt({
		cwd,
		agentDir,
		client: client(),
		platform: "darwin",
		arch: "arm64",
		nodeVersion: "v24.12.0",
		certifyPlatform: async () => ({
			os: "darwin",
			arch: "arm64",
			runtimePlatform: "linux/arm64",
		}),
		runCommand: async (command, args) => {
			if (command === "pi") return IMAGE_LOCK.piVersion;
			if (args[0] === "info") return "/var/lib/docker";
			if (args[0] === "system") return usage;
			return "27.0.0";
		},
		statFilesystem: (async (path: string) => {
			statted.push(path);
			if (path === "/var/lib/docker") {
				const error = new Error("not host-addressable") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			}
			return { bavail: 2_000_000, bsize: 1024 };
		}) as typeof statfs,
	});
	const dockerDisk = receipt.checks.find((entry) => entry.id === "disk-docker");
	assert.equal(dockerDisk?.level, "warning");
	assert.match(dockerDisk?.summary ?? "", /VM-managed/);
	assert.equal(dockerDisk?.data?.usage, usage);
	assert.equal(statted.includes("/var/lib/docker"), true);
	assert.equal(
		receipt.checks.find((entry) => entry.id === "disk")?.level,
		"warning",
	);
});

test("Linux host-addressable Docker storage contributes low disk warning", async () => {
	const cwd = await repository();
	const agentDir = await mkdtemp(join(tmpdir(), "pi-dsbx-agent-"));
	const receipt = await buildDoctorReceipt({
		cwd,
		agentDir,
		client: client(),
		platform: "linux",
		arch: "x64",
		nodeVersion: "v24.12.0",
		certifyPlatform: async () => ({
			os: "linux",
			arch: "x64",
			runtimePlatform: "linux/amd64",
		}),
		statKvm: async () => ({ isCharacterDevice: () => true }),
		openKvm: async () => ({ close: async () => undefined }),
		runCommand: async (command, args) => {
			if (command === "pi") return IMAGE_LOCK.piVersion;
			if (args[0] === "info") return "/var/lib/docker";
			if (args[0] === "system") return '{"Type":"Images","Size":"1GB"}';
			return "27.0.0";
		},
		statFilesystem: (async (path: string) => ({
			bavail: path === "/var/lib/docker" ? 512 : 2_000_000,
			bsize: 1024,
		})) as typeof statfs,
	});
	assert.equal(
		receipt.checks.find((entry) => entry.id === "disk-docker")?.level,
		"warning",
	);
	assert.equal(
		receipt.checks.find((entry) => entry.id === "disk-docker")?.data
			?.availableBytes,
		512 * 1024,
	);
	assert.equal(
		receipt.checks.find((entry) => entry.id === "disk")?.level,
		"warning",
	);
});

test("status receipt is observational and skips doctor probes", async () => {
	const cwd = await repository();
	const commands: string[] = [];
	const receipt = await buildStatusReceipt({
		cwd,
		client: client(),
		runCommand: async (command) => {
			commands.push(command);
			throw new Error("status must not probe commands");
		},
		certifyPlatform: async () => {
			throw new Error("status must not certify host");
		},
	});
	assert.equal(receipt.kind, "pi-dsbx.status");
	assert.deepEqual(commands, []);
});
