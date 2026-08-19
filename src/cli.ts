import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { stderr, stdin, stdout } from "node:process";
import {
	loadConfig,
	type ConfigOverride,
	type SecurityProfile,
	type SyncProfile,
} from "./config.ts";
import { decideDisposition } from "./disposition.ts";
import { formatError, OperationError } from "./errors.ts";
import {
	buildDoctorReceipt,
	buildStatusReceipt,
	diagnosticsExitCode,
} from "./diagnostics.ts";
import { LauncherExitCode } from "./exit-codes.ts";
import { IMAGE_LOCK } from "./image-lock.ts";
import { PACKAGE_VERSION, resolveKitImage } from "./kit.ts";
import { launch, type LaunchResult } from "./launch.ts";
import {
	SandboxLeaseBusyError,
	unlockSandboxLease,
	withSandboxLease,
} from "./lease.ts";
import { markSandboxReady, reconcileSandbox } from "./reconcile.ts";
import { SbxClient } from "./sbx/client.ts";
import {
	deleteSessionBackup,
	listSessionBackups,
	restoreSessions,
} from "./sessions.ts";
import {
	attestSandbox,
	formatDoctor,
	runDoctor,
	sandboxStatus,
} from "./status.ts";
import {
	applyPatch,
	exportPatch,
	inspectRepository,
	loadSandboxStateResult,
	removeSandboxState,
	saveSandboxState,
	sandboxStateExists,
	sandboxName,
	statePath,
} from "./workspace.ts";

const setInterval = globalThis.setInterval as unknown as (
	callback: () => void,
	delay: number,
) => NodeJS.Timeout;
const clearInterval = globalThis.clearInterval as unknown as (
	timer: NodeJS.Timeout,
) => void;

async function confirm(question: string): Promise<boolean> {
	if (!stdin.isTTY || !stdout.isTTY) return false;
	const reader = createInterface({ input: stdin, output: stdout });
	try {
		return /^y(?:es)?$/i.test(
			(await reader.question(`${question} [y/N] `)).trim(),
		);
	} finally {
		reader.close();
	}
}

function booleanOption(args: string[], name: string): boolean {
	const matches = args.flatMap((value, index) => {
		if (value === name) return [{ index, enabled: true }];
		if (!value.startsWith(`${name}=`)) return [];
		const inline = value.slice(name.length + 1);
		if (inline !== "true" && inline !== "false")
			throw new TypeError(`${name} requires a boolean true or false value`);
		return [{ index, enabled: inline === "true" }];
	});
	if (matches.length > 1) throw new TypeError(`${name} may be set only once`);
	if (matches[0]) args.splice(matches[0].index, 1);
	return matches[0]?.enabled ?? false;
}

function take(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--"))
		throw new TypeError(`${flag} requires a value`);
	args.splice(index, 2);
	return value;
}

interface ParsedRun {
	override: ConfigOverride;
	fresh: boolean;
	discardChanges: boolean;
	noHostAuth: boolean;
	yes: boolean;
	trustProjectConfig: boolean;
	cwd: string;
	piArgs: string[];
}

export function parseRunArgs(input: readonly string[]): ParsedRun {
	const args = [...input];
	const override: ConfigOverride = {};
	let fresh = false;
	let discardChanges = false;
	let noHostAuth = false;
	let yes = false;
	let trustProjectConfig = false;
	let cwd = process.cwd();
	const separator = args.indexOf("--");
	const piArgs = separator >= 0 ? args.splice(separator + 1) : [];
	if (separator >= 0) args.splice(separator, 1);
	for (let index = 0; index < args.length; ) {
		const flag = args[index]!;
		if (flag === "--profile") {
			override.profile = take(args, index, flag) as SecurityProfile;
			continue;
		}
		if (flag === "--sync") {
			override.syncProfile = take(args, index, flag) as SyncProfile;
			continue;
		}
		if (flag === "--name") {
			override.sandbox = { ...override.sandbox, name: take(args, index, flag) };
			continue;
		}
		if (flag === "--cwd") {
			cwd = resolve(take(args, index, flag));
			continue;
		}
		if (flag === "--fresh") {
			fresh = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--keep") {
			override.sandbox = { ...override.sandbox, keep: true };
			args.splice(index, 1);
			continue;
		}
		if (flag === "--discard-changes") {
			discardChanges = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--no-host-auth") {
			noHostAuth = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--yes") {
			yes = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--trust-project-config") {
			trustProjectConfig = true;
			args.splice(index, 1);
			continue;
		}
		throw new TypeError(`Unknown run option: ${flag}`);
	}
	return {
		override,
		fresh,
		discardChanges,
		noHostAuth,
		yes,
		trustProjectConfig,
		cwd,
		piArgs,
	};
}

export interface StatusReporter {
	onStatus(line: string): void;
	onWarning(warning: string): void;
	reportRemaining(warnings: readonly string[]): void;
	stop(): void;
}

export function createLaunchReporter(
	write: (message: string) => void = (message) =>
		stderr.write(message.endsWith("\r") ? message : `${message}\n`),
	clock: {
		now(): number;
		setInterval: typeof setInterval;
		clearInterval: typeof clearInterval;
	} = { now: Date.now, setInterval, clearInterval },
	tty = stderr.isTTY === true,
): StatusReporter {
	const delivered = new Set<string>();
	let timer: ReturnType<typeof setInterval> | undefined;
	let startedAt = 0;
	let status = "";
	let width = 0;
	const stopTimer = () => {
		if (timer !== undefined) clock.clearInterval(timer);
		timer = undefined;
	};
	const clearStatus = () => {
		if (!tty || width === 0) return;
		write(`\r${" ".repeat(width)}\r`);
		width = 0;
	};
	const writeStatus = (message: string) => {
		if (!tty) {
			write(message);
			return;
		}
		const padding = " ".repeat(Math.max(0, width - message.length));
		width = Math.max(width, message.length);
		write(`${message}${padding}\r`);
	};
	return {
		onStatus(line) {
			stopTimer();
			status = line;
			startedAt = clock.now();
			writeStatus(`pi-dsbx: ${line}`);
			if (line === "starting Pi") {
				if (tty) {
					write("\n\r");
					width = 0;
				}
				return;
			}
			timer = clock.setInterval(
				() => {
					const elapsed = clock.now() - startedAt;
					const seconds = Math.floor(elapsed / 1_000);
					if (tty) writeStatus(`pi-dsbx: ${status} (${seconds}s)`);
					else write(`pi-dsbx: ${status}… still working (${seconds}s)`);
				},
				tty ? 2_000 : 5_000,
			);
		},
		onWarning(warning) {
			delivered.add(warning);
			clearStatus();
			write(`! ${warning}`);
		},
		reportRemaining(warnings) {
			for (const warning of warnings) {
				if (delivered.has(warning)) continue;
				clearStatus();
				write(`! ${warning}`);
			}
		},
		stop() {
			stopTimer();
			clearStatus();
		},
	};
}

export function createPausedConfirm(
	reporter: StatusReporter,
	prompt: (question: string) => Promise<boolean>,
	resumePhase?: string,
): (question: string) => Promise<boolean> {
	return (question) => {
		reporter.stop();
		return prompt(question).then((accepted) => {
			if (accepted && resumePhase) reporter.onStatus(resumePhase);
			return accepted;
		});
	};
}

function usage(): string {
	return `pi-dsbx - run Pi inside Docker Sandboxes\n\nUsage:\n  pi-dsbx run [options] [-- PI_ARGS...]\n  pi-dsbx status [--json]\n  pi-dsbx doctor [--json]\n  pi-dsbx config\n  pi-dsbx export [--name NAME]\n  pi-dsbx apply PATCH [--name NAME] --yes\n  pi-dsbx destroy [--name NAME] [--yes] [--discard-changes]\n  pi-dsbx unlock --name NAME --yes\n  pi-dsbx sessions list [--name NAME]\n  pi-dsbx sessions restore [BACKUP] [--name NAME]\n  pi-dsbx sessions delete BACKUP [--name NAME] --yes\n\nRun options: --profile NAME --sync NAME --name NAME --fresh --keep --discard-changes --no-host-auth --trust-project-config --yes --cwd PATH\nPi session resume: pi-dsbx run [options] -- --session ID\nDestroy options: --yes approves clean clone removal only; --discard-changes explicitly authorizes changed/unknown removal`;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	return take(args, index, name);
}

export function launchProcessExitCode(
	result: Pick<LaunchResult, "agentExitCode" | "launcherExitCode">,
): number {
	return result.agentExitCode !== 0
		? result.agentExitCode
		: result.launcherExitCode;
}

export async function main(
	argv = process.argv.slice(2),
	dependencies: {
		removeState?: (path: string) => Promise<void>;
		/** @internal Test-only launch boundary. */
		launch?: typeof launch;
	} = {},
): Promise<number> {
	const [command = "run", ...args] = argv;
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return 0;
	}
	if (command === "run") {
		const parsed = parseRunArgs(args);
		const reporter = createLaunchReporter();
		const pausedConfirm = createPausedConfirm(reporter, confirm);
		const checkingConfirm = createPausedConfirm(
			reporter,
			confirm,
			"checking Docker Sandboxes",
		);
		const copyingConfirm = createPausedConfirm(
			reporter,
			confirm,
			"copying host profile",
		);
		const oauthConfirm = createPausedConfirm(
			reporter,
			confirm,
			"syncing host credentials",
		);
		try {
			const result = await (dependencies.launch ?? launch)({
				cwd: parsed.cwd,
				config: parsed.override,
				fresh: parsed.fresh,
				discardChanges: parsed.discardChanges,
				noHostAuth: parsed.noHostAuth,
				yes: parsed.yes,
				projectTrusted: parsed.trustProjectConfig,
				piArgs: parsed.piArgs,
				confirm: checkingConfirm,
				confirmResourceCopy: copyingConfirm,
				confirmOAuthCopy: oauthConfirm,
				confirmNativePackages: (packages) =>
					pausedConfirm(
						`${packages.length} packages need a compiler in this sandbox (${packages.join(", ")}).\nInstall toolchain here? ~1–2 min, not saved.`,
					),
				onStatus: reporter.onStatus,
				onWarning: reporter.onWarning,
				confirmInitialCommit: (root) =>
					checkingConfirm(
						`Clone mode needs an initial commit. Create an empty commit in ${root}?`,
					),
			});
			reporter.reportRemaining(result.warnings);
			return launchProcessExitCode(result);
		} finally {
			reporter.stop();
		}
	}
	const cwd = process.cwd();
	const client = new SbxClient();
	const sandboxAttested = await attestSandbox();
	if (command === "status") {
		const json = booleanOption(args, "--json");
		if (args.length > 0) throw new TypeError(`Unexpected argument: ${args[0]}`);
		if (json) {
			const receipt = await buildStatusReceipt({ cwd, client });
			console.log(JSON.stringify(receipt, null, 2));
			return diagnosticsExitCode(receipt);
		}
		console.log(sandboxStatus(sandboxAttested));
		if (!sandboxAttested)
			console.log(JSON.stringify(await client.list(), null, 2));
		return 0;
	}
	if (command === "doctor") {
		const json = booleanOption(args, "--json");
		if (args.length > 0) throw new TypeError(`Unexpected argument: ${args[0]}`);
		if (json) {
			const receipt = await buildDoctorReceipt({ cwd, client });
			console.log(JSON.stringify(receipt, null, 2));
			return diagnosticsExitCode(receipt);
		}
		const results = await runDoctor(sandboxAttested, client, cwd);
		console.log(formatDoctor(results));
		return results.some((result) => result.level === "fail") ? 1 : 0;
	}
	if (command === "config") {
		console.log(JSON.stringify(await loadConfig(cwd), null, 2));
		return 0;
	}
	if (command === "unlock") {
		const root = resolve(cwd);
		const repository = await inspectRepository(root);
		const name = option(args, "--name");
		const yes = booleanOption(args, "--yes");
		if (!name) throw new TypeError("unlock requires --name NAME");
		if (!yes) throw new TypeError("unlock requires explicit --yes authority");
		if (args.length > 0) throw new TypeError(`Unexpected argument: ${args[0]}`);
		const record = await unlockSandboxLease(repository.root, name, true);
		console.log(
			`Unlocked abandoned ${record.operation} lease for sandbox ${record.sandbox}`,
		);
		return 0;
	}
	if (command === "sessions") {
		const action = args.shift();
		if (action !== "list" && action !== "restore" && action !== "delete")
			throw new TypeError("sessions requires list, restore, or delete");
		const repository = await inspectRepository(resolve(cwd));
		const config = await loadConfig(cwd);
		const name =
			option(args, "--name") ??
			config.sandbox.name ??
			sandboxName(repository.root);
		const yes = booleanOption(args, "--yes");
		const backupId = args.shift();
		if (args.length > 0) throw new TypeError(`Unexpected argument: ${args[0]}`);
		const agentDir = join(homedir(), ".pi", "agent");
		if (action === "list") {
			if (backupId || yes)
				throw new TypeError("sessions list accepts only --name NAME");
			console.log(
				JSON.stringify(
					await listSessionBackups(agentDir, repository.identity, name),
					null,
					2,
				),
			);
			return 0;
		}
		if (action === "restore") {
			if (yes) throw new TypeError("--yes is not valid for sessions restore");
			return withSandboxLease(
				repository.root,
				name,
				"sessions-restore",
				async () => {
					if (!(await sandboxStateExists(repository.root, name)))
						throw new Error(`No clone state for sandbox ${name}`);
					if (!(await client.exists(name)))
						throw new Error(`Sandbox ${name} does not exist`);
					const [resolved, inspection] = await Promise.all([
						resolveKitImage(config),
						client.inspect(name),
					]);
					const state = (
						await loadSandboxStateResult(
							repository.root,
							name,
							{
								exists: true,
								inspectedImage: String(inspection.image ?? ""),
								expectedImage: resolved.image,
								runtimeSchema: IMAGE_LOCK.runtimeSchema,
								packageVersion: PACKAGE_VERSION,
								...(resolved.templateStoreId
									? { templateStoreId: resolved.templateStoreId }
									: {}),
							},
							{
								expectedRepositoryIdentity: repository.identity,
								expectedWorktreeIdentity: repository.worktreeIdentity,
							},
						)
					).value;
					if (
						state.hostRepoIdentity !== repository.identity ||
						state.hostWorktreeIdentity !== repository.worktreeIdentity
					)
						throw new Error("Sandbox state belongs to another worktree");
					if (
						state.runtimeImage !== resolved.image ||
						state.runtimeSchema !== IMAGE_LOCK.runtimeSchema ||
						state.packageVersion !== PACKAGE_VERSION
					)
						throw new Error("Sandbox runtime is incompatible with session restore");
					const decision = reconcileSandbox(state, {
						exists: true,
						imageMatches: inspection.image === state.runtimeImage,
					});
					if (
						state.phase !== "ready" ||
						decision.action !== "preserve" ||
						state.imageAttestation?.status !== "verified" ||
						state.imageAttestation.image !== state.runtimeImage
					)
						throw new Error(
							`Sandbox is not ready for exact session restore: ${decision.action}`,
						);
					const restored = await restoreSessions(
						client,
						agentDir,
						repository.identity,
						name,
						backupId,
					);
					if (!restored) throw new Error("No managed session backup exists");
					for (const warning of restored.warnings)
						console.warn(`pi-dsbx: warning: ${warning}`);
					console.log(`Restored ${restored.backupDirectory}`);
					return 0;
				},
			);
		}
		if (!backupId) throw new TypeError("sessions delete requires BACKUP");
		if (!yes)
			throw new TypeError("sessions delete requires explicit --yes authority");
		return withSandboxLease(
			repository.root,
			name,
			"sessions-delete",
			async () => {
				await deleteSessionBackup(agentDir, repository.identity, name, backupId);
				console.log(`Deleted session backup ${backupId}`);
				return 0;
			},
		);
	}
	if (command === "export" || command === "apply" || command === "destroy") {
		const root = resolve(cwd);
		const repository = await inspectRepository(root);
		const name = option(args, "--name") ?? sandboxName(repository.root);
		const yes = booleanOption(args, "--yes");
		const discardChanges = booleanOption(args, "--discard-changes");
		if (discardChanges && command !== "destroy")
			throw new TypeError("--discard-changes is only valid for destroy");
		const patch = command === "apply" ? args.shift() : undefined;
		if (command === "apply" && !patch)
			throw new TypeError("apply requires a patch path");
		if (args.length > 0) throw new TypeError(`Unexpected argument: ${args[0]}`);
		return withSandboxLease(repository.root, name, command, async () => {
			const hasState = await sandboxStateExists(repository.root, name);
			const state = hasState
				? (
						await loadSandboxStateResult(
							repository.root,
							name,
							async () => {
								const config = await loadConfig(cwd);
								const resolved = await resolveKitImage(config);
								const inspection = await client.inspect(name);
								return {
									exists: true,
									inspectedImage: String(inspection.image ?? ""),
									expectedImage: resolved.image,
									runtimeSchema: IMAGE_LOCK.runtimeSchema,
									packageVersion: PACKAGE_VERSION,
									...(resolved.templateStoreId
										? { templateStoreId: resolved.templateStoreId }
										: {}),
								};
							},
							{
								expectedRepositoryIdentity: repository.identity,
								expectedWorktreeIdentity: repository.worktreeIdentity,
							},
						)
					).value
				: undefined;
			const daemonExists = await client.exists(name);
			if (!state)
				throw new Error(
					daemonExists
						? "Sandbox exists without durable lifecycle state; automatic mutation is refused"
						: `No clone state for sandbox ${name}`,
				);
			const inspection = daemonExists ? await client.inspect(name) : undefined;
			const decision = reconcileSandbox(state, {
				exists: daemonExists,
				...(inspection
					? { imageMatches: inspection.image === state.runtimeImage }
					: {}),
			});
			if (decision.action === "mark-failed") {
				state.phase = "failed";
				state.updatedAt = new Date().toISOString();
				state.lastOperationError = {
					category: "image",
					at: state.updatedAt,
				};
				await saveSandboxState(state);
				throw new Error(`${decision.reason}; sandbox preserved for recovery`);
			}
			if (decision.action === "remove-state") {
				if (command !== "destroy")
					throw new Error("Sandbox is absent; lifecycle state preserved");
				await removeSandboxState(repository.root, name, dependencies.removeState);
				console.log(`Sandbox ${name} was already absent; removed stale state`);
				return 0;
			}
			if (state.phase !== "ready" || decision.reason !== "sandbox is ready")
				throw new Error(`${decision.reason}; sandbox preserved for recovery`);
			if (
				state.imageAttestation?.status !== "verified" ||
				state.imageAttestation.image !== state.runtimeImage
			)
				throw new Error(
					"Ready lifecycle state lacks verified runtime image attestation; sandbox preserved",
				);
			if (command === "export") {
				if (!state) throw new TypeError(`No clone state for sandbox ${name}`);
				const config = await loadConfig(cwd);
				state.phase = "exporting";
				state.updatedAt = new Date().toISOString();
				await saveSandboxState(state);
				const result = await exportPatch(client, state, config.export.directory);
				markSandboxReady(state);
				await saveSandboxState(state);
				console.log(`${result.path}\n${result.summary.join("\n")}`);
				return 0;
			}
			if (command === "apply") {
				if (!state) throw new TypeError(`No clone state for sandbox ${name}`);
				const patchPath = patch!;
				if (
					!yes &&
					!(await confirm(`Apply ${patchPath} to the host working tree?`))
				)
					throw new Error("Patch apply cancelled");
				await applyPatch(state, resolve(patchPath));
				console.log(`Applied ${patchPath}`);
				return 0;
			}
			const dirty = !state
				? undefined
				: (
						await client.exec(name, ["git", "status", "--porcelain=v1"], {
							workdir: state.hostRoot,
						})
					).stdout.trim().length > 0;
			let discardAuthorized = discardChanges;
			if ((!state || dirty) && !discardAuthorized)
				discardAuthorized = await confirm(
					!state
						? "Destroy this sandbox permanently? Unexported work cannot be inspected without clone state."
						: "Sandbox has unexported changes. Destroy and discard them permanently?",
				);
			if (
				dirty === false &&
				!yes &&
				!(await confirm("Destroy sandbox permanently?"))
			)
				throw new Error("Destroy cancelled");
			const disposition = decideDisposition({
				keep: false,
				changes: !state ? "unknown" : dirty ? "changed" : "clean",
				exportRequested: false,
				exportSucceeded: false,
				discardAuthorized,
			});
			if (disposition !== "remove")
				throw new Error(
					"Destroy cancelled; use --discard-changes to authorize noninteractive dirty removal",
				);
			if (!state)
				throw new Error("Sandbox removal requires durable lifecycle state");
			state.phase = "removing";
			state.updatedAt = new Date().toISOString();
			await saveSandboxState(state);
			await client.remove(name, true);
			if (await client.exists(name))
				throw new Error("Sandbox removal was not confirmed by the daemon");
			try {
				await removeSandboxState(repository.root, name, dependencies.removeState);
			} catch (cause) {
				throw new OperationError({
					phase: "remove-or-keep",
					operation: "remove stale sandbox state",
					detail: `Sandbox ${name} is gone but stale state requires inspection; automatic removal was refused`,
					recovery: [
						`Inspect ${statePath(repository.root, name)} and its parent directory manually`,
					],
					cause,
				});
			}
			console.log(`Destroyed ${name}`);
			return 0;
		});
	}
	throw new TypeError(`Unknown command: ${command}\n${usage()}`);
}

export async function run(
	argv = process.argv.slice(2),
	dependencies: Parameters<typeof main>[1] = {},
): Promise<number> {
	try {
		return await main(argv, dependencies);
	} catch (error) {
		console.error(`Error: ${formatError(error)}`);
		return error instanceof SandboxLeaseBusyError
			? LauncherExitCode.Busy
			: LauncherExitCode.Failure;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
	process.exitCode = await run();
}
