import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, statfs, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { listHostOAuthProviderIds } from "./host-auth.ts";
import { sanitizeDetail } from "./errors.ts";
import { IMAGE_LOCK } from "./image-lock.ts";
import { PACKAGE_VERSION, resolveKitImage } from "./kit.ts";
import { inspectSandboxLease } from "./lease.ts";
import { HOST_PI_RANGE, NODE_RANGE } from "./package-metadata.ts";
import {
	certifyHostPlatform,
	detectHostPlatform,
	type SupportedHost,
} from "./platform.ts";
import { resolveAvailableServices } from "./providers.ts";
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
	home?: string;
	agentDir?: string;
	runCommand?: (command: string, args: readonly string[]) => Promise<string>;
	/** @internal Test-only host certification boundary. */
	certifyPlatform?: () => Promise<SupportedHost>;
	/** @internal Test-only host OAuth eligibility boundary. */
	listHostOAuthProviders?: (ids: readonly string[]) => Promise<Set<string>>;
	/** @internal Test-only KVM metadata boundary. */
	statKvm?: () => Promise<{ isCharacterDevice(): boolean }>;
	/** @internal Test-only KVM open boundary. */
	openKvm?: () => Promise<Pick<FileHandle, "close">>;
	/** @internal Test-only filesystem-stat boundary. */
	statFilesystem?: typeof statfs;
}

function shareable(value: string): string {
	let sanitized = sanitizeDetail(value, 200);
	for (const quotedPath of [
		/"(?:\/|[A-Za-z]:[\\/]|\\\\)[^"\r\n]*"/g,
		/'(?:\/|[A-Za-z]:[\\/]|\\\\)[^'\r\n]*'/g,
	])
		sanitized = sanitized.replace(quotedPath, "[private-path]");
	return sanitized.replace(
		/(^|[\s([{=:])(?:\/(?!\/)[^\s,;'"<>()[\]{}]*|[A-Za-z]:[\\/][^\s,;'"<>()[\]{}]*|\\\\[^\s,;'"<>()[\]{}]*)/g,
		"$1[private-path]",
	);
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
					typeof value === "string" ? shareable(value) : value,
				]),
			)
		: undefined;
	return {
		id,
		level,
		summary: shareable(summary),
		...(redactedData ? { data: redactedData } : {}),
	};
}

function failure(id: string, cause: unknown): DiagnosticCheck {
	const message = cause instanceof Error ? cause.message : String(cause);
	const code =
		typeof cause === "object" &&
		cause !== null &&
		"code" in cause &&
		typeof cause.code === "string"
			? cause.code
			: undefined;
	return check(
		id,
		"fail",
		code && !message.includes(code) ? `${code}: ${message}` : message,
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

interface ParsedVersion {
	core: [number, number, number];
	prerelease?: string[];
	build?: string;
}

function parseVersion(value: string): ParsedVersion | undefined {
	const match = value.match(
		/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
	);
	if (!match) return undefined;
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		...(match[4] ? { prerelease: match[4].split(".") } : {}),
		...(match[5] ? { build: match[5] } : {}),
	};
}

function compareVersion(left: ParsedVersion, right: ParsedVersion): number {
	for (let index = 0; index < 3; index++) {
		const difference = left.core[index]! - right.core[index]!;
		if (difference) return difference;
	}
	if (!left.prerelease) return right.prerelease ? 1 : 0;
	if (!right.prerelease) return -1;
	for (
		let index = 0;
		index < Math.max(left.prerelease.length, right.prerelease.length);
		index++
	) {
		const leftPart = left.prerelease[index];
		const rightPart = right.prerelease[index];
		if (leftPart === undefined) return -1;
		if (rightPart === undefined) return 1;
		if (leftPart === rightPart) continue;
		const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
		const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
		if (leftNumber !== undefined && rightNumber !== undefined)
			return leftNumber - rightNumber;
		if (leftNumber !== undefined) return -1;
		if (rightNumber !== undefined) return 1;
		return leftPart.localeCompare(rightPart);
	}
	return 0;
}

function supportedVersion(version: string, range: string): boolean {
	const actual = parseVersion(version);
	if (!actual) return false;
	return range.split("||").some((alternative) => {
		const clauses = [
			...alternative.matchAll(
				/(\^|>=|>|<=|<)?\s*(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/g,
			),
		];
		const targets = clauses.map(([, , expected]) => parseVersion(expected!));
		if (
			clauses.length === 0 ||
			targets.some((target) => !target) ||
			(actual.prerelease && !targets.some((target) => target?.prerelease)) ||
			(actual.build && !targets.some((target) => target?.build))
		)
			return false;
		return clauses.every(([, operator = ""], index) => {
			const target = targets[index]!;
			const compared = compareVersion(actual, target!);
			if (operator === "^")
				return compared >= 0 && actual.core[0] === target!.core[0];
			if (operator === ">=") return compared >= 0;
			if (operator === ">") return compared > 0;
			if (operator === "<=") return compared <= 0;
			if (operator === "<") return compared < 0;
			return compared === 0;
		});
	});
}

export function diagnosticsExitCode(
	receipt: Pick<DoctorReceipt | StatusReceipt, "checks">,
): number {
	return receipt.checks.some((entry) => entry.level === "fail") ? 1 : 0;
}

function redactReceipt<T extends DoctorReceipt | StatusReceipt>(receipt: T): T {
	// String fields are sanitized when checks are built; never rewrite schema keys or IDs.
	return receipt;
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

	let host: SupportedHost | undefined;
	let detectedHost: SupportedHost | undefined;
	try {
		const detected = detectHostPlatform(
			options.platform ?? process.platform,
			options.arch ?? process.arch,
		);
		detectedHost = detected;
		host = options.certifyPlatform
			? await options.certifyPlatform()
			: await certifyHostPlatform(detected);
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
			supportedVersion(nodeVersion, NODE_RANGE) ? "pass" : "fail",
			supportedVersion(nodeVersion, NODE_RANGE)
				? `Node ${nodeVersion} is supported`
				: `Node ${nodeVersion} is outside ${NODE_RANGE}`,
			{ version: nodeVersion, expectedRange: NODE_RANGE },
		),
	);

	try {
		const detectedVersion = (await runCommand("pi", ["--version"])).trim();
		const compatible = supportedVersion(detectedVersion, HOST_PI_RANGE);
		checks.push(
			check(
				"pi",
				compatible ? "pass" : "fail",
				compatible
					? `Pi ${detectedVersion} satisfies the host peer range`
					: `Pi ${detectedVersion} is outside ${HOST_PI_RANGE}`,
				{ version: detectedVersion, expectedRange: HOST_PI_RANGE },
			),
		);
	} catch (cause) {
		checks.push(failure("pi", cause));
	}

	let dockerRoot: string | undefined;
	let dockerUsage: string | undefined;
	try {
		const [version, root, usage] = await Promise.all([
			runCommand("docker", ["version", "--format", "{{.Server.Version}}"]),
			runCommand("docker", ["info", "--format", "{{.DockerRootDir}}"]),
			runCommand("docker", ["system", "df", "--format", "{{json .}}"]),
		]);
		dockerRoot = root || undefined;
		dockerUsage = usage || undefined;
		checks.push(
			check(
				"docker",
				version && dockerRoot && dockerUsage ? "pass" : "fail",
				"Docker daemon, storage root, and disk usage respond",
				{
					version,
					...(dockerRoot ? { storageRoot: dockerRoot } : {}),
					...(dockerUsage ? { usage: dockerUsage } : {}),
				},
			),
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

	if ((host ?? detectedHost)?.os === "linux") {
		try {
			const metadata = await (options.statKvm ?? (() => lstat("/dev/kvm")))();
			if (!metadata.isCharacterDevice())
				throw new Error("/dev/kvm is not a character device");
			const handle = await (
				options.openKvm ??
				(() => open("/dev/kvm", constants.O_RDWR | constants.O_NOFOLLOW))
			)();
			await handle.close();
			checks.push(
				check("kvm", "pass", "Linux KVM is a usable character device"),
			);
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
		config = await loadConfig(cwd, {
			...(options.home ? { home: options.home } : {}),
		});
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
				const inspection = daemonExists
					? await client.inspect(name)
					: undefined;
				const decision = reconcileSandbox(state, {
					exists: daemonExists,
					...(inspection
						? { imageMatches: inspection.image === state.runtimeImage }
						: {}),
				});
				const healthy =
					state.phase === "ready" && decision.action === "preserve";
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
			const bytes = backups
				.slice(0, -1)
				.reduce((total, backup) => total + backup.bytes, 0);
			const ageCutoff =
				now.getTime() - config.retention.maxAgeDays * 86_400_000;
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
			checks.push(
				check(id, "fail", "Git/configuration context is unavailable"),
			);
	}

	const diskChecks: DiagnosticCheck[] = [];
	const stat = options.statFilesystem ?? statfs;
	for (const [label, destination] of [
		["repository", repository?.root ?? cwd],
		["backups", agentDir],
		["staging", tmpdir()],
	] as const) {
		try {
			const disk = await stat(destination);
			const availableBytes = Number(disk.bavail) * Number(disk.bsize);
			diskChecks.push(
				check(
					`disk-${label}`,
					availableBytes >= 1024 * 1024 * 1024 ? "pass" : "warning",
					`${label} disk destination inspected`,
					{ destination, availableBytes },
				),
			);
		} catch (cause) {
			diskChecks.push(failure(`disk-${label}`, cause));
		}
	}
	if (dockerRoot) {
		try {
			const disk = await stat(dockerRoot);
			const availableBytes = Number(disk.bavail) * Number(disk.bsize);
			diskChecks.push(
				check(
					"disk-docker",
					availableBytes >= 1024 * 1024 * 1024 ? "pass" : "warning",
					"docker disk destination inspected",
					{ destination: dockerRoot, availableBytes },
				),
			);
		} catch (cause) {
			if (
				(host ?? detectedHost)?.os === "darwin" &&
				(cause as NodeJS.ErrnoException).code === "ENOENT"
			)
				diskChecks.push(
					check(
						"disk-docker",
						"warning",
						"Docker Desktop storage is VM-managed; host statfs is not applicable",
						{
							destination: dockerRoot,
							...(dockerUsage ? { usage: dockerUsage } : {}),
						},
					),
				);
			else diskChecks.push(failure("disk-docker", cause));
		}
	}
	checks.push(...diskChecks);
	checks.push(
		check(
			"disk",
			diskChecks.some((entry) => entry.level === "fail")
				? "fail"
				: diskChecks.some((entry) => entry.level === "warning")
					? "warning"
					: "pass",
			"All write destinations inspected",
			{ destinationCount: diskChecks.length },
		),
	);

	if (config) {
		try {
			if (config.auth.mode === "none")
				checks.push(
					check("auth", "pass", "Host credential transfer is disabled", {
						mode: config.auth.mode,
						providerCount: 0,
					}),
				);
			else if (config.auth.mode === "proxy") {
				const capabilities = await client.capabilities();
				const resolved = resolveAvailableServices(
					capabilities.credentialServices,
					config.auth.providers,
				);
				const configured =
					resolved.services.length > 0
						? await client.secretServices()
						: new Set<string>();
				const missing = resolved.services
					.map((service) => service.id)
					.filter((id) => !configured.has(id));
				checks.push(
					check(
						"auth",
						resolved.unsupported.length > 0
							? "fail"
							: missing.length > 0
								? "warning"
								: "pass",
						resolved.unsupported.length > 0
							? "Explicit proxy providers are unsupported"
							: missing.length > 0
								? "Explicit proxy providers lack configured SBX secrets"
								: "Explicit proxy providers are available and configured",
						{
							mode: config.auth.mode,
							providerCount: config.auth.providers.length,
							unsupportedCount: resolved.unsupported.length,
							missingCount: missing.length,
						},
					),
				);
			} else {
				const eligible = await (
					options.listHostOAuthProviders ?? listHostOAuthProviderIds
				)(config.auth.providers);
				const missing = config.auth.providers.filter((id) => !eligible.has(id));
				checks.push(
					check(
						"auth",
						missing.length > 0 ? "warning" : "pass",
						missing.length > 0
							? "Explicit OAuth providers lack copy-eligible credentials"
							: "Explicit OAuth providers have copy-eligible credentials",
						{
							mode: config.auth.mode,
							providerCount: config.auth.providers.length,
							missingCount: missing.length,
						},
					),
				);
			}
		} catch (cause) {
			checks.push(failure("auth", cause));
		}
	} else checks.push(check("auth", "fail", "Credential policy is unavailable"));

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
	const cwd = options.cwd ?? process.cwd();
	const client = options.client ?? new SbxClient();
	const now = options.now ?? new Date();
	const agentDir = options.agentDir ?? join(homedir(), ".pi", "agent");
	const checks: DiagnosticCheck[] = [];
	try {
		const config = await loadConfig(cwd, {
			...(options.home ? { home: options.home } : {}),
		});
		const repository = await inspectRepository(cwd);
		const name = config.sandbox.name ?? sandboxName(repository.root);
		checks.push(
			check("git", "pass", "Git worktree is clone-mode eligible", {
				mainWorktree: repository.mainWorktree,
				dirty: repository.dirty,
			}),
		);
		let selectedImage: string | undefined;
		try {
			selectedImage = (await resolveKitImage(config)).image;
			checks.push(
				check("image", "pass", "Exact runtime image digest is selected", {
					reference: selectedImage,
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
		let state: Awaited<ReturnType<typeof loadSandboxState>> | undefined;
		try {
			const hasState = await sandboxStateExists(repository.root, name);
			const daemonExists = await client.exists(name);
			if (hasState) {
				state = await loadSandboxState(repository.root, name, undefined, {
					expectedRepositoryIdentity: repository.identity,
					expectedWorktreeIdentity: repository.worktreeIdentity,
				});
				const inspection = daemonExists
					? await client.inspect(name)
					: undefined;
				const decision = reconcileSandbox(state, {
					exists: daemonExists,
					...(inspection
						? { imageMatches: inspection.image === state.runtimeImage }
						: {}),
				});
				const healthy =
					state.phase === "ready" && decision.action === "preserve";
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
		const compatible =
			!state ||
			(state.runtimeSchema === IMAGE_LOCK.runtimeSchema &&
				state.packageVersion === PACKAGE_VERSION &&
				state.runtimeImage === selectedImage);
		checks.push(
			check(
				"upgrade",
				compatible ? "pass" : "fail",
				compatible
					? "Runtime, package, and image versions are compatible"
					: "Sandbox requires an explicit compatible upgrade or recreation",
			),
		);
		try {
			const backups = await listSessionBackups(
				agentDir,
				repository.identity,
				name,
			);
			const nonLatestBytes = backups
				.slice(0, -1)
				.reduce((total, backup) => total + backup.bytes, 0);
			const cutoff = now.getTime() - config.retention.maxAgeDays * 86_400_000;
			const expired = backups
				.slice(0, -1)
				.some((backup) => Date.parse(backup.createdAt) < cutoff);
			checks.push(
				check(
					"backup",
					nonLatestBytes <= config.retention.maxBytes &&
						backups.length <= Math.max(1, config.retention.maxCount) &&
						!expired
						? "pass"
						: "warning",
					"Managed session backups inspected",
					{ count: backups.length, bytes: nonLatestBytes },
				),
			);
		} catch (cause) {
			checks.push(failure("backup", cause));
		}
	} catch (cause) {
		checks.push(failure("git", cause));
		for (const id of ["backup", "image", "lease", "lifecycle", "upgrade"])
			checks.push(
				check(id, "fail", "Git/configuration context is unavailable"),
			);
	}
	checks.sort((left, right) => left.id.localeCompare(right.id));
	return redactReceipt({
		schemaVersion: 1,
		kind: "pi-dsbx.status",
		generatedAt: now.toISOString(),
		ok: !checks.some((entry) => entry.level === "fail"),
		checks,
	});
}
