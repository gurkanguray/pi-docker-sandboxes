import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, statfs } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { sanitizeDetail } from "./errors.ts";
import { IMAGE_LOCK } from "./image-lock.ts";
import { PACKAGE_VERSION, resolveKitImage } from "./kit.ts";
import { inspectSandboxLease } from "./lease.ts";
import { detectHostPlatform } from "./platform.ts";
import { reconcileSandbox } from "./reconcile.ts";
import { SbxClient } from "./sbx/client.ts";
import { listSessionBackups, reconcileSessionStaging } from "./sessions.ts";
import {
	inspectRepository,
	loadSandboxState,
	reconcileOwnedHostStaging,
	sandboxName,
	sandboxStateExists,
} from "./workspace.ts";

const execFileAsync = promisify(execFile);

export type DiagnosticLevel = "pass" | "warning" | "fail";

export interface DiagnosticCheck {
	id: string;
	level: DiagnosticLevel;
	summary: string;
	data?: Record<string, boolean | number | string>;
}

export interface DoctorReceipt {
	schemaVersion: 1;
	kind: "pi-dsbx.doctor";
	generatedAt: string;
	ok: boolean;
	checks: DiagnosticCheck[];
}

export interface StatusReceipt {
	schemaVersion: 1;
	kind: "pi-dsbx.status";
	generatedAt: string;
	ok: boolean;
	checks: DiagnosticCheck[];
}

export interface DiagnosticsOptions {
	cwd?: string;
	client?: SbxClient;
	now?: Date;
	platform?: NodeJS.Platform;
	arch?: string;
	nodeVersion?: string;
	agentDir?: string;
	runCommand?: (command: string, args: readonly string[]) => Promise<string>;
}

function check(
	id: string,
	level: DiagnosticLevel,
	summary: string,
	data?: DiagnosticCheck["data"],
): DiagnosticCheck {
	const redactedData = data
		? Object.fromEntries(
				Object.entries(data).map(([key, value]) => [
					key,
					typeof value === "string" ? sanitizeDetail(value, 200) : value,
				]),
			)
		: undefined;
	return {
		id,
		level,
		summary: sanitizeDetail(summary),
		...(redactedData ? { data: redactedData } : {}),
	};
}

function failure(id: string, cause: unknown): DiagnosticCheck {
	return check(
		id,
		"fail",
		cause instanceof Error ? cause.message : String(cause),
	);
}

async function defaultCommand(
	command: string,
	args: readonly string[],
): Promise<string> {
	return (
		await execFileAsync(command, [...args], {
			encoding: "utf8",
			timeout: 10_000,
		})
	).stdout.trim();
}

function supportedNode(version: string): boolean {
	const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
	return Boolean(
		match &&
			Number(match[1]) === 24 &&
			(Number(match[2]) > 12 ||
				(Number(match[2]) === 12 && Number(match[3]) >= 0)),
	);
}

export function diagnosticsExitCode(
	receipt: Pick<DoctorReceipt | StatusReceipt, "checks">,
): number {
	return receipt.checks.some((entry) => entry.level === "fail") ? 1 : 0;
}

function redactReceipt<T extends DoctorReceipt | StatusReceipt>(receipt: T): T {
	return JSON.parse(sanitizeDetail(JSON.stringify(receipt), 1024 * 1024)) as T;
}

export async function buildDoctorReceipt(
	options: DiagnosticsOptions = {},
): Promise<DoctorReceipt> {
	const cwd = options.cwd ?? process.cwd();
	const client = options.client ?? new SbxClient();
	const now = options.now ?? new Date();
	const agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
	const runCommand = options.runCommand ?? defaultCommand;
	const checks: DiagnosticCheck[] = [];

	try {
		const removed = await reconcileOwnedHostStaging(tmpdir());
		checks.push(
			check("staging", "pass", "Owned host staging inspected", {
				staleStagingRemoved: removed.length,
			}),
		);
	} catch (cause) {
		checks.push(failure("staging", cause));
	}

	let host: ReturnType<typeof detectHostPlatform> | undefined;
	try {
		host = detectHostPlatform(
			options.platform ?? process.platform,
			options.arch ?? process.arch,
		);
		checks.push(
			check("host", "pass", `host ${host.os}/${host.arch} is certified`, {
				os: host.os,
				arch: host.arch,
				runtimePlatform: host.runtimePlatform,
			}),
		);
	} catch (cause) {
		checks.push(failure("host", cause));
	}

	const nodeVersion = options.nodeVersion ?? process.version;
	checks.push(
		check(
			"node",
			supportedNode(nodeVersion) ? "pass" : "fail",
			supportedNode(nodeVersion)
				? `Node ${nodeVersion} is supported`
				: `Node ${nodeVersion} is outside >=24.12.0 <25`,
			{ version: nodeVersion },
		),
	);

	try {
		const version = await runCommand("pi", ["--version"]);
		const compatible =
			version.match(/\d+\.\d+\.\d+/)?.[0] === IMAGE_LOCK.piVersion;
		checks.push(
			check(
				"pi",
				compatible ? "pass" : "fail",
				compatible
					? `Pi ${IMAGE_LOCK.piVersion} is available`
					: `Pi version is incompatible with ${IMAGE_LOCK.piVersion}`,
				{ expectedVersion: IMAGE_LOCK.piVersion },
			),
		);
	} catch (cause) {
		checks.push(failure("pi", cause));
	}

	try {
		const version = await runCommand("docker", [
			"version",
			"--format",
			"{{.Server.Version}}",
		]);
		checks.push(
			check("docker", version ? "pass" : "fail", "Docker daemon responds", {
				version,
			}),
		);
	} catch (cause) {
		checks.push(failure("docker", cause));
	}

	try {
		const [version, capabilities] = await Promise.all([
			client.version(),
			client.capabilities(),
			client.list(),
		]);
		const compatible =
			/^0\.38\./.test(version.version) &&
			capabilities.clone &&
			capabilities.noShareSkills &&
			capabilities.kitValidate &&
			capabilities.inspectJson &&
			capabilities.policyCheckNetwork;
		checks.push(
			check(
				"sbx",
				compatible ? "pass" : "fail",
				compatible
					? "Docker SBX daemon and tested adapter respond"
					: `Docker SBX ${version.version} lacks the tested production contract`,
				{ version: version.version },
			),
		);
	} catch (cause) {
		checks.push(failure("sbx", cause));
	}

	if (host?.os === "linux") {
		try {
			await access("/dev/kvm", constants.R_OK | constants.W_OK);
			checks.push(check("kvm", "pass", "Linux KVM is readable and writable"));
		} catch (cause) {
			checks.push(failure("kvm", cause));
		}
	} else
		checks.push(
			check("kvm", "pass", "Linux KVM check is not required on this host"),
		);

	let repository: Awaited<ReturnType<typeof inspectRepository>> | undefined;
	let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
	let name: string | undefined;
	let state: Awaited<ReturnType<typeof loadSandboxState>> | undefined;
	try {
		config = await loadConfig(cwd);
		repository = await inspectRepository(cwd);
		name = config.sandbox.name ?? sandboxName(repository.root);
		checks.push(
			check("git", "pass", "Git worktree is clone-mode eligible", {
				mainWorktree: repository.mainWorktree,
				dirty: repository.dirty,
			}),
		);
	} catch (cause) {
		checks.push(failure("git", cause));
	}

	if (repository && config && name) {
		let selectedImage: string | undefined;
		try {
			const resolved = await resolveKitImage(config);
			selectedImage = resolved.image;
			checks.push(
				check("image", "pass", "Exact runtime image digest is selected", {
					reference: resolved.image,
					runtimePlatform: host?.runtimePlatform ?? "unknown",
				}),
			);
		} catch (cause) {
			checks.push(failure("image", cause));
		}
		try {
			const lease = await inspectSandboxLease(repository.root, name);
			checks.push(
				check(
					"lease",
					lease.status === "absent"
						? "pass"
						: lease.status === "live"
							? "warning"
							: "fail",
					`Lifecycle lease is ${lease.status}`,
					lease.record
						? { operation: lease.record.operation, pid: lease.record.pid }
						: undefined,
				),
			);
		} catch (cause) {
			checks.push(failure("lease", cause));
		}
		try {
			const hasState = await sandboxStateExists(repository.root, name);
			const daemonExists = await client.exists(name);
			if (hasState) {
				state = await loadSandboxState(repository.root, name, undefined, {
					expectedRepositoryIdentity: repository.identity,
					expectedWorktreeIdentity: repository.worktreeIdentity,
				});
				const inspection = daemonExists ? await client.inspect(name) : undefined;
				const decision = reconcileSandbox(state, {
					exists: daemonExists,
					...(inspection
						? { imageMatches: inspection.image === state.runtimeImage }
						: {}),
				});
				const healthy = state.phase === "ready" && decision.action === "preserve";
				checks.push(
					check(
						"lifecycle",
						healthy ? "pass" : "fail",
						healthy
							? "Lifecycle state and daemon reconcile"
							: `Lifecycle reconciliation requires ${decision.action}`,
						{ phase: state.phase, action: decision.action },
					),
				);
			} else
				checks.push(
					check(
						"lifecycle",
						daemonExists ? "fail" : "pass",
						daemonExists
							? "Sandbox exists without lifecycle state"
							: "No sandbox lifecycle state is present",
					),
				);
		} catch (cause) {
			checks.push(failure("lifecycle", cause));
		}
		checks.push(
			check(
				"upgrade",
				!state ||
					(state.runtimeSchema === IMAGE_LOCK.runtimeSchema &&
						state.packageVersion === PACKAGE_VERSION &&
						state.runtimeImage === selectedImage)
					? "pass"
					: "fail",
				!state ||
					(state.runtimeSchema === IMAGE_LOCK.runtimeSchema &&
						state.packageVersion === PACKAGE_VERSION &&
						state.runtimeImage === selectedImage)
					? "Runtime, package, and image versions are compatible"
					: "Sandbox requires an explicit compatible upgrade or recreation",
				{
					packageVersion: PACKAGE_VERSION,
					runtimeSchema: IMAGE_LOCK.runtimeSchema,
				},
			),
		);
		try {
			const removed = await reconcileSessionStaging(
				agentDir,
				repository.identity,
				name,
			);
			const backups = await listSessionBackups(
				agentDir,
				repository.identity,
				name,
			);
			const bytes = backups.reduce((total, backup) => total + backup.bytes, 0);
			const ageCutoff = now.getTime() - config.retention.maxAgeDays * 86_400_000;
			const expired = backups
				.slice(0, -1)
				.some((backup) => Date.parse(backup.createdAt) < ageCutoff);
			checks.push(
				check(
					"backup",
					bytes <= config.retention.maxBytes &&
						backups.length <= Math.max(1, config.retention.maxCount) &&
						!expired
						? "pass"
						: "warning",
					"Managed session backups inspected",
					{ count: backups.length, bytes, staleStagingRemoved: removed.length },
				),
			);
		} catch (cause) {
			checks.push(failure("backup", cause));
		}
	} else {
		for (const id of ["image", "lease", "lifecycle", "upgrade", "backup"])
			checks.push(check(id, "fail", "Git/configuration context is unavailable"));
	}

	try {
		const disk = await statfs(repository?.root ?? cwd);
		const availableBytes = Number(disk.bavail) * Number(disk.bsize);
		checks.push(
			check(
				"disk",
				availableBytes >= 1024 * 1024 * 1024 ? "pass" : "warning",
				"Host disk space inspected",
				{ availableBytes },
			),
		);
	} catch (cause) {
		checks.push(failure("disk", cause));
	}

	if (config)
		checks.push(
			check("auth", "pass", "Credential policy inspected without secret values", {
				mode: config.auth.mode,
				providerCount: config.auth.providers.length,
			}),
		);
	else checks.push(check("auth", "fail", "Credential policy is unavailable"));

	checks.sort((left, right) => left.id.localeCompare(right.id));
	const receipt: DoctorReceipt = {
		schemaVersion: 1,
		kind: "pi-dsbx.doctor",
		generatedAt: now.toISOString(),
		ok: !checks.some((entry) => entry.level === "fail"),
		checks,
	};
	return redactReceipt(receipt);
}

export async function buildStatusReceipt(
	options: DiagnosticsOptions = {},
): Promise<StatusReceipt> {
	const doctor = await buildDoctorReceipt(options);
	const ids = new Set([
		"image",
		"lease",
		"lifecycle",
		"upgrade",
		"backup",
		"git",
	]);
	const checks = doctor.checks.filter((entry) => ids.has(entry.id));
	return {
		schemaVersion: 1,
		kind: "pi-dsbx.status",
		generatedAt: doctor.generatedAt,
		ok: !checks.some((entry) => entry.level === "fail"),
		checks,
	};
}
