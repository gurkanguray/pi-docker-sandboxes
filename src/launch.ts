import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
	loadConfigResult,
	mergeConfig,
	parseConfig,
	type ConfigOverride,
	type DockerSandboxConfig,
} from "./config.ts";
import { decideDisposition, type ChangeState } from "./disposition.ts";
import {
	formatError,
	OperationError,
	sanitizeDetail,
	type OperationPhase,
} from "./errors.ts";
import {
	buildKitSpec,
	resolveKitImage,
	type KitImageResolver,
	writeKitDirectory,
} from "./kit.ts";
import {
	createPersonalizationSnapshot,
	syncOptions,
	type ResourceManifestEntry,
} from "./personalization.ts";
import { providerSetupGuidance } from "./preflight.ts";
import { resolveAvailableServices } from "./providers.ts";
import { SbxClient, SbxCommandError } from "./sbx/client.ts";
import { backupSessions } from "./sessions.ts";
import {
	createEmptyInitialCommit,
	exportPatch,
	inspectRepository,
	loadSandboxStateResult,
	removeSandboxState,
	sandboxName,
	saveSandboxState,
	statePath,
	type SandboxState,
	UnbornHeadError,
} from "./workspace.ts";

const OUTER_BOOLEAN_FLAGS = new Set([
	"--docker-sandbox",
	"--docker-sandbox-fresh",
	"--docker-sandbox-direct",
	"--docker-sandbox-keep",
	"--docker-sandbox-no-sync-back",
	"--docker-sandbox-discard-changes",
]);
const OUTER_VALUE_FLAGS = new Set([
	"--docker-sandbox-profile",
	"--docker-sandbox-name",
	"--docker-sandbox-sync",
]);

export function stripSandboxFlags(argv: readonly string[]): string[] {
	const output: string[] = [];
	for (let index = 0; index < argv.length; index++) {
		const value = argv[index]!;
		const [key, inline] = value.split("=", 2);
		if (OUTER_BOOLEAN_FLAGS.has(key!)) {
			if (inline !== undefined && inline !== "true" && inline !== "false")
				throw new TypeError(`${key} requires a boolean true or false value`);
			continue;
		}
		if (OUTER_VALUE_FLAGS.has(key!)) {
			if (inline === undefined) index++;
			continue;
		}
		output.push(value);
	}
	return output;
}

export interface LaunchCleanup {
	removeTemp(path: string): Promise<void>;
}

export interface LaunchStateCleanup {
	removeState(path: string): Promise<void>;
}

export interface LaunchOptions {
	cwd: string;
	config?: ConfigOverride;
	piArgs?: string[];
	fresh?: boolean;
	noSyncBack?: boolean;
	discardChanges?: boolean;
	yes?: boolean;
	projectTrusted?: boolean;
	client?: SbxClient;
	cleanup?: LaunchCleanup;
	stateCleanup?: LaunchStateCleanup;
	confirm?: (question: string) => Promise<boolean>;
	confirmInitialCommit?: (root: string) => Promise<boolean>;
	confirmResourceCopy?: (summary: string) => Promise<boolean>;
	onWarning?: (warning: string) => void;
	/** @internal Test-only image resolver injection. */
	resolveImage?: KitImageResolver;
	/** @internal Test-only state persistence injection. */
	saveState?: typeof saveSandboxState;
	/** @internal Test-only repository inspection injection. */
	inspectRepository?: typeof inspectRepository;
}

async function terminalConfirm(question: string): Promise<boolean> {
	if (!stdin.isTTY || !stdout.isTTY) return false;
	const readline = createInterface({ input: stdin, output: stdout });
	try {
		return /^y(?:es)?$/i.test(
			(await readline.question(`${question} [y/N] `)).trim(),
		);
	} finally {
		readline.close();
	}
}

const HOST_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"COLORTERM",
	"LANG",
] as const;
const LOCALE_ENV_NAME = /^LC_[A-Z0-9_]+$/;

export function sanitizedHostEnvironment(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const output: NodeJS.ProcessEnv = {};
	const add = (key: string): void => {
		const value = env[key];
		if (value && !/[\u0000-\u001f\u007f-\u009f]/.test(value))
			output[key] = value;
	};
	for (const key of HOST_ENV_ALLOWLIST) add(key);
	for (const key of Object.keys(env)) if (LOCALE_ENV_NAME.test(key)) add(key);
	return output;
}

export function requireExplicitWeakModes(
	config: DockerSandboxConfig,
	yes: boolean,
	confirm: (question: string) => Promise<boolean>,
): Promise<void> {
	const warnings: string[] = [];
	if (config.workspaceMode === "direct")
		warnings.push(
			"Direct mode allows the sandbox to modify your host working tree.",
		);
	if (config.shareSkills)
		warnings.push("Shared skills are a writable cross-sandbox trust boundary.");
	if (warnings.length === 0 || yes) return Promise.resolve();
	return confirm(`${warnings.join("\n")} Continue?`).then((accepted) => {
		if (!accepted)
			throw new Error(
				"Launch cancelled; weaker security mode was not approved",
			);
	});
}

export interface LaunchLifecycle {
	name: string;
	existedBefore: boolean;
	created: boolean;
	changed: boolean | "unknown";
	exported: boolean;
	preserved: boolean;
	cleanupWarnings: string[];
}

export interface LaunchResult {
	exitCode: number;
	name: string;
	state?: SandboxState;
	warnings: string[];
	lifecycle: LaunchLifecycle;
}

export function verifyCreatedImage(
	inspection: Record<string, unknown>,
	resolved: { image: string; templateStoreId?: string },
): void {
	if (inspection.image !== resolved.image)
		throw new Error("Created sandbox image does not match the selected image");
	if (resolved.templateStoreId) {
		const digest = inspection.image_digest;
		if (
			typeof digest !== "string" ||
			!digest.startsWith(`sha256:${resolved.templateStoreId}`)
		)
			throw new Error(
				"Created sandbox image digest does not match the selected template store image",
			);
	}
}

async function inspectSandboxChanges(
	client: SbxClient,
	name: string,
	workdir: string,
): Promise<boolean> {
	const result = await client.exec(name, ["git", "status", "--porcelain=v1"], {
		workdir,
	});
	return result.stdout.trim().length > 0;
}

const defaultCleanup: LaunchCleanup = {
	removeTemp: (path) => rm(path, { recursive: true, force: true }),
};
class LaunchOperationError extends OperationError {
	constructor(
		phase: OperationPhase,
		operation: string,
		lifecycle: LaunchLifecycle,
		cause: unknown,
		detail: string,
		recovery: readonly string[] = [],
		supplementalDetails: readonly { label: string; detail: string }[] = [],
	) {
		super({
			phase,
			operation,
			detail: [
				`sandbox=${lifecycle.name}`,
				`changed=${lifecycle.changed}`,
				`exported=${lifecycle.exported}`,
				`preserved=${lifecycle.preserved}`,
				...supplementalDetails.map(
					(supplemental) => `${supplemental.label}: ${supplemental.detail}`,
				),
			].join("; "),
			recovery,
			cause,
		});
		this.message = `${this.message}: ${sanitizeDetail(detail)}`;
	}
}

type CleanupResult =
	| { ok: true }
	| { ok: false; cause: unknown; detail: string };

async function cleanupHostStaging(
	path: string,
	cleanup: LaunchCleanup = defaultCleanup,
): Promise<CleanupResult> {
	try {
		await cleanup.removeTemp(path);
		return { ok: true };
	} catch (cause) {
		return {
			ok: false,
			cause,
			detail: errorDetail(cause, "Unknown cleanup failure"),
		};
	}
}

function shellArg(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function countLabel(count: number): string {
	return `${count} ${count === 1 ? "file" : "files"}`;
}

export function resourceCopySummary(
	manifest: readonly ResourceManifestEntry[],
): string {
	const lines = ["Copy opt-in personalization resources into the sandbox?"];
	for (const resource of [
		"skills",
		"prompts",
		"themes",
		"extensions",
	] as const) {
		const entries = manifest.filter((entry) => entry.resource === resource);
		if (entries.length > 0)
			lines.push(
				`${resource}: ${countLabel(entries.length)}, ${entries.reduce((sum, entry) => sum + entry.bytes, 0)} bytes`,
			);
	}
	lines.push(
		`Total: ${countLabel(manifest.length)}, ${manifest.reduce((sum, entry) => sum + entry.bytes, 0)} bytes`,
	);
	return lines.join("\n");
}

function errorDetail(error: unknown, fallback = "Unknown failure"): string {
	return sanitizeDetail(
		error instanceof SbxCommandError
			? error.stderr || error.message
			: error instanceof Error
				? error.message
				: error === undefined || error === null
					? fallback
					: String(error),
	);
}

export async function launch(options: LaunchOptions): Promise<LaunchResult> {
	const cwd = resolve(options.cwd);
	const client = options.client ?? new SbxClient();
	let loadedConfig: Awaited<ReturnType<typeof loadConfigResult>>;
	try {
		loadedConfig = await loadConfigResult(cwd, {
			projectTrusted: options.projectTrusted === true,
		});
	} catch (cause) {
		throw new OperationError({
			phase: "preflight",
			operation: "load sandbox configuration",
			detail: errorDetail(cause),
			recovery: ["pi-dsbx config"],
			cause,
		});
	}
	const override = options.config
		? parseConfig(options.config, "launch options")
		: {};
	const config = mergeConfig(loadedConfig.value, override);
	const sync = syncOptions(config.syncProfile, config.sync);
	if (!config.enabled)
		throw new Error(
			"Docker Sandboxes integration is disabled by configuration",
		);
	await requireExplicitWeakModes(
		config,
		options.yes ?? false,
		options.confirm ?? terminalConfirm,
	);
	let capabilities: Awaited<ReturnType<SbxClient["capabilities"]>>;
	try {
		capabilities = await client.capabilities();
	} catch (cause) {
		throw new OperationError({
			phase: "preflight",
			operation: "inspect installed sbx capabilities",
			detail: errorDetail(cause),
			recovery: ["pi-dsbx doctor"],
			cause,
		});
	}
	if (config.workspaceMode === "clone" && !capabilities.clone)
		throw new OperationError({
			phase: "preflight",
			operation: "require sbx clone capability",
			detail: "Installed sbx does not support required clone mode",
			recovery: ["pi-dsbx doctor"],
		});
	if (!config.shareSkills && !capabilities.noShareSkills)
		throw new OperationError({
			phase: "preflight",
			operation: "require sbx no-share-skills capability",
			detail: "Installed sbx cannot disable shared skills",
			recovery: ["pi-dsbx doctor"],
		});
	if (!capabilities.kitValidate)
		throw new OperationError({
			phase: "preflight",
			operation: "require sbx Kit validation capability",
			detail: "Installed sbx cannot validate Docker Sandbox Kits",
			recovery: ["pi-dsbx doctor"],
		});

	const inspectHostRepository = options.inspectRepository ?? inspectRepository;
	let repository: Awaited<ReturnType<typeof inspectRepository>> | undefined;
	if (config.workspaceMode === "clone") {
		try {
			repository = await inspectHostRepository(cwd);
		} catch (error) {
			if (!(error instanceof UnbornHeadError)) throw error;
			const accepted =
				options.yes === true ||
				(await options.confirmInitialCommit?.(error.root)) === true;
			if (!accepted) throw error;
			await createEmptyInitialCommit(error.root);
			repository = await inspectHostRepository(cwd);
		}
		if (!repository.mainWorktree)
			throw new Error("Clone mode does not support secondary Git worktrees");
	}
	const root = repository?.root ?? cwd;
	const name = config.sandbox.name ?? sandboxName(root, options.fresh);
	let existing: boolean;
	try {
		existing = await client.exists(name);
	} catch (cause) {
		throw new OperationError({
			phase: "prepare",
			operation: `inspect sandbox ${name} existence`,
			detail: errorDetail(cause),
			recovery: [`sbx list --json`],
			cause,
		});
	}
	let state: SandboxState | undefined;
	let stateMigrated = false;
	const warnings = [...loadedConfig.warnings];
	if (existing && config.workspaceMode === "clone") {
		const loadedState = await loadSandboxStateResult(root, name);
		state = loadedState.value;
		stateMigrated = loadedState.migrated;
		warnings.push(...loadedState.warnings);
		if (state.hostRepoIdentity !== repository!.identity)
			throw new Error("Existing sandbox belongs to another repository");
		if (state.hostBaseCommit !== repository!.head)
			throw new Error(
				"Host HEAD changed since sandbox creation; export or destroy the sandbox before continuing",
			);
	}

	const pushProviderWarning = (warning: string): void => {
		warnings.push(warning);
		options.onWarning?.(warning);
	};
	const resolvedProviders = resolveAvailableServices(
		capabilities.credentialServices,
		config.providers,
		config.services,
	);
	for (const id of resolvedProviders.unsupported)
		pushProviderWarning(
			`Requested credential service ${id} is not both audited and proxy-supported`,
		);
	if (
		config.providers.length > 0 &&
		capabilities.credentialServices.length === 0
	)
		pushProviderWarning(
			"credential proxy service discovery unavailable; no credential services were added to the Kit",
		);
	let configuredServices = new Set<string>();
	if (resolvedProviders.services.length > 0) {
		try {
			configuredServices = await client.secretServices();
		} catch {
			pushProviderWarning(
				"configured credential service discovery unavailable; credential setup guidance omitted",
			);
			configuredServices = new Set(
				resolvedProviders.services.map((service) => service.id),
			);
		}
		for (const warning of providerSetupGuidance(
			resolvedProviders.services,
			configuredServices,
		))
			pushProviderWarning(warning);
	}

	const lifecycle: LaunchLifecycle = {
		name,
		existedBefore: existing,
		created: false,
		changed: "unknown",
		exported: false,
		preserved: existing,
		cleanupWarnings: [],
	};
	const temp = await mkdtemp(join(tmpdir(), "pi-docker-sandboxes-"));
	let exitCode: number | undefined;
	let result: LaunchResult | undefined;
	let primaryError: unknown;
	let stagingCleaned = false;
	const finalizationStopped = Symbol("finalization-stopped");
	let primaryPhase: OperationPhase = "prepare";
	let primaryOperation = "prepare sandbox launch";
	const custodyCommands = (): string[] =>
		config.workspaceMode === "direct"
			? [
					`pi-dsbx destroy --name ${shellArg(name)} --direct --discard-changes`,
					`pi-dsbx run --name ${shellArg(name)} --direct`,
				]
			: [
					`pi-dsbx export --name ${shellArg(name)}`,
					`pi-dsbx destroy --name ${shellArg(name)} --discard-changes`,
					`pi-dsbx run --name ${shellArg(name)}`,
				];
	const custodyWarning = (): string =>
		`Sandbox ${shellArg(name)} preserved. Safe recovery commands:\n` +
		custodyCommands()
			.map((command) => `  ${command}`)
			.join("\n");
	const warnCustody = (): void => {
		const warning = custodyWarning();
		if (!warnings.includes(warning)) warnings.push(warning);
	};
	const recovery = (phase: OperationPhase): string[] =>
		phase === "export-or-preserve"
			? [`pi-dsbx export --name ${shellArg(name)}`]
			: phase === "remove-or-keep"
				? [`sbx inspect ${shellArg(name)}`]
				: [`sbx exec ${shellArg(name)} git status --porcelain=v1`];
	const finalize = async (
		phase: OperationPhase,
		operation: string,
		action: () => Promise<void>,
		operationRecovery = recovery(phase),
	): Promise<boolean> => {
		try {
			await action();
			return true;
		} catch (cause) {
			if (cause instanceof OperationError && cause.phase === phase) {
				if (exitCode !== undefined) {
					warnings.push(formatError(cause));
					return false;
				}
				throw cause;
			}
			const error = new LaunchOperationError(
				phase,
				operation,
				lifecycle,
				cause,
				errorDetail(cause),
				operationRecovery,
			);
			if (exitCode !== undefined) {
				warnings.push(formatError(error));
				return false;
			}
			throw error;
		}
	};
	try {
		const profileDirectory = join(temp, "profile");
		const snapshot = await createPersonalizationSnapshot(
			join(homedir(), ".pi", "agent"),
			profileDirectory,
			config.syncProfile,
			config.sync,
		);
		warnings.push(...snapshot.warnings);
		if (
			snapshot.manifest.length > 0 &&
			options.yes !== true &&
			(await options.confirmResourceCopy?.(
				resourceCopySummary(snapshot.manifest),
			)) !== true
		)
			throw new Error(
				"Resource copy cancelled; opt-in resources were not approved",
			);
		if (process.env.SSH_AUTH_SOCK)
			warnings.push(
				"launcher does not pass host SSH_AUTH_SOCK; Docker Sandboxes may independently provide a proxy socket",
			);
		let resolvedImage: Awaited<ReturnType<typeof resolveKitImage>>;
		try {
			resolvedImage = await (options.resolveImage ?? resolveKitImage)(config);
		} catch (cause) {
			if (cause instanceof OperationError) throw cause;
			throw new OperationError({
				phase: "preflight",
				operation: "resolve immutable sandbox image",
				detail: errorDetail(cause),
				recovery: ["pi-dsbx image build"],
				cause,
			});
		}
		const spec = buildKitSpec({
			config,
			services: resolvedProviders.services,
			image: resolvedImage.image,
			sandboxName: name,
		});
		const kitDirectory = join(temp, "kit");
		await writeKitDirectory(kitDirectory, spec, {
			personalization: profileDirectory,
		});
		await client.validateKit(kitDirectory);

		const request = {
			name,
			workspace: root,
			kit: kitDirectory,
			workspaceMode: config.workspaceMode,
			shareSkills: config.shareSkills,
			agentArgs: stripSandboxFlags(options.piArgs ?? []),
			env: sanitizedHostEnvironment(),
		};
		if (!existing) {
			primaryPhase = "create";
			primaryOperation = "create sandbox";
			await client.create(request);
			lifecycle.created = true;
			lifecycle.preserved = true;
			if (repository) {
				state = {
					version: 1,
					name,
					hostBaseCommit: repository.head,
					hostBranch: repository.branch,
					hostRepoIdentity: repository.identity,
					hostRoot: repository.root,
					workspaceMode: "clone",
					createdAt: new Date().toISOString(),
					...(resolvedImage.templateStoreId
						? {
								imageAttestation: {
									status: "pending" as const,
									image: resolvedImage.image,
									templateStoreId: resolvedImage.templateStoreId,
								},
							}
						: {}),
				};
			}
		}

		if (state && (!existing || stateMigrated)) {
			primaryPhase = !existing ? "create" : "prepare";
			if (!existing) {
				primaryOperation = "persist pending sandbox state";
				try {
					await (options.saveState ?? saveSandboxState)(state);
				} catch (cause) {
					throw new LaunchOperationError(
						"create",
						primaryOperation,
						lifecycle,
						cause,
						errorDetail(cause),
						[
							`sbx inspect ${shellArg(name)}`,
							`sbx exec ${shellArg(name)} git status --porcelain=v1`,
							`sbx exec ${shellArg(name)} git diff --binary`,
							`sbx rm --force ${shellArg(name)}`,
						],
						[
							{
								label: "data-loss warning",
								detail: `removing ${shellArg(name)} loses any sandbox-only changes`,
							},
						],
					);
				}
				primaryOperation =
					"reinspect repository after sandbox state persistence";
				try {
					const current = await inspectHostRepository(root);
					if (
						current.identity !== state.hostRepoIdentity ||
						current.head !== state.hostBaseCommit
					)
						throw new Error("Host repository changed during sandbox creation");
				} catch (cause) {
					throw new LaunchOperationError(
						"create",
						primaryOperation,
						lifecycle,
						cause,
						errorDetail(cause),
						custodyCommands(),
					);
				}
			} else {
				primaryOperation = "persist migrated sandbox state";
				const current = await inspectHostRepository(root);
				if (
					current.identity !== state.hostRepoIdentity ||
					current.head !== state.hostBaseCommit
				)
					throw new Error("Host repository changed during sandbox preparation");
				await (options.saveState ?? saveSandboxState)(state);
			}
		}
		const recordedAttestation = state?.imageAttestation;
		const directAttestation =
			config.workspaceMode === "direct" ? resolvedImage : undefined;
		const attestation = recordedAttestation ?? directAttestation;
		if (attestation) {
			primaryOperation = existing
				? "verify resumed sandbox image"
				: "verify created sandbox image";
			try {
				verifyCreatedImage(await client.inspect(name), attestation);
				if (recordedAttestation?.status === "pending") {
					recordedAttestation.status = "verified";
					await (options.saveState ?? saveSandboxState)(state!);
				}
			} catch (cause) {
				throw new LaunchOperationError(
					existing ? "prepare" : "create",
					primaryOperation,
					lifecycle,
					cause,
					errorDetail(cause),
					custodyCommands(),
				);
			}
		}

		primaryPhase = "run";
		primaryOperation = "attach to sandbox";
		exitCode = await client.attach(request);
		lifecycle.preserved = true;

		let present = false;
		const existenceKnown = await finalize(
			"inspect-exit",
			"inspect final sandbox existence",
			async () => {
				present = await client.exists(name);
			},
		);
		if (!existenceKnown) {
			lifecycle.changed = "unknown";
			lifecycle.preserved = true;
			warnCustody();
			result = { exitCode, name, state, warnings, lifecycle };
			throw finalizationStopped;
		}
		if (!present) lifecycle.preserved = false;

		if (present && state && sync.sessions === "managed") {
			try {
				await backupSessions(
					client,
					join(homedir(), ".pi", "agent"),
					state.hostRepoIdentity,
					name,
				);
			} catch (cause) {
				lifecycle.preserved = true;
				const error = new LaunchOperationError(
					"export-or-preserve",
					"managed session backup",
					lifecycle,
					cause,
					errorDetail(cause),
					[],
					[
						{
							label: "managed session backup guidance",
							detail:
								"sandbox and state preserved; relaunch to retry managed backup",
						},
					],
				);
				warnings.push(formatError(error));
				warnCustody();
				result = { exitCode, name, state, warnings, lifecycle };
				throw finalizationStopped;
			}
		}

		if (present) {
			let changed = false;
			const inspected = await finalize(
				"inspect-exit",
				"inspect sandbox changes",
				async () => {
					changed = await inspectSandboxChanges(client, name, root);
				},
			);
			const changes: ChangeState = inspected
				? changed
					? "changed"
					: "clean"
				: "unknown";
			lifecycle.changed = inspected ? changed : "unknown";

			let exportRequested = false;
			let exportSucceeded = false;
			if (
				inspected &&
				changes === "changed" &&
				!config.sandbox.keep &&
				state &&
				!options.noSyncBack &&
				config.workspaceMode === "clone"
			) {
				exportRequested =
					config.export.onExit === "always" ||
					(config.export.onExit === "prompt" &&
						(await (options.confirm ?? terminalConfirm)(
							"Export sandbox changes as a patch?",
						)));
				if (exportRequested)
					exportSucceeded = await finalize(
						"export-or-preserve",
						"export sandbox changes",
						() =>
							exportPatch(client, state!, config.export.directory).then(
								() => {},
							),
					);
			}
			lifecycle.exported = exportSucceeded;

			const disposition = decideDisposition({
				keep: config.sandbox.keep,
				changes,
				exportRequested,
				exportSucceeded,
				discardAuthorized: options.discardChanges === true,
			});
			if (disposition.action === "preserve") warnCustody();
			else {
				const cleanup = await cleanupHostStaging(temp, options.cleanup);
				stagingCleaned = true;
				if (!cleanup.ok) {
					lifecycle.cleanupWarnings.push(cleanup.detail);
					warnings.push(`Host staging cleanup failed: ${cleanup.detail}`);
					warnCustody();
					result = { exitCode, name, state, warnings, lifecycle };
					throw finalizationStopped;
				}
				const removed = await finalize("remove-or-keep", "remove sandbox", () =>
					client.remove(name, true),
				);
				if (!removed) {
					warnCustody();
					result = { exitCode, name, state, warnings, lifecycle };
					throw finalizationStopped;
				}
				lifecycle.preserved = false;
				if (state) {
					const path = statePath(root, name);
					const stateRemoved = await finalize(
						"remove-or-keep",
						"remove stale sandbox state",
						() =>
							options.stateCleanup
								? options.stateCleanup.removeState(path)
								: removeSandboxState(root, name),
						[`rm -f -- ${shellArg(path)}`],
					);
					if (!stateRemoved)
						warnings.push(
							`Sandbox ${name} is gone but stale state remains; remove ${statePath(root, name)} after inspection`,
						);
				}
			}
		}
		result = { exitCode, name, state, warnings, lifecycle };
	} catch (error) {
		if (error !== finalizationStopped)
			primaryError =
				error instanceof OperationError
					? error
					: new LaunchOperationError(
							primaryPhase,
							primaryOperation,
							lifecycle,
							error,
							errorDetail(error),
							recovery(primaryPhase),
						);
	}

	const cleanup = stagingCleaned
		? ({ ok: true } as const)
		: await cleanupHostStaging(temp, options.cleanup);
	if (!cleanup.ok) {
		lifecycle.cleanupWarnings.push(cleanup.detail);
		if (result) warnings.push(`Host staging cleanup failed: ${cleanup.detail}`);
		else if (primaryError) {
			const operationError = primaryError as OperationError;
			primaryError = new LaunchOperationError(
				operationError.phase,
				operationError.operation,
				lifecycle,
				operationError.cause ?? operationError,
				errorDetail(operationError.cause ?? operationError),
				operationError.recovery,
				[{ label: "host cleanup warning", detail: cleanup.detail }],
			);
		} else
			primaryError = new LaunchOperationError(
				"cleanup-host-staging",
				"remove temporary host staging",
				lifecycle,
				cleanup.cause,
				cleanup.detail,
				[`rm -rf -- ${shellArg(temp)}`],
			);
	}
	if (primaryError) throw primaryError;
	return result!;
}
