import { randomUUID } from "node:crypto";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	loadConfigResult,
	mergeConfig,
	parseConfig,
	type ConfigOverride,
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
import { withSandboxLease } from "./lease.ts";
import {
	createPersonalizationSnapshot,
	listNativePackageSpecs,
	syncOptions,
	type ResourceManifestEntry,
} from "./personalization.ts";
import {
	classifyHostProviders,
	listHostOAuthProviderIds,
	syncHostProviderSecrets,
} from "./host-auth.ts";
import { certifyHostPlatform, type SupportedHost } from "./platform.ts";
import { providerSetupGuidance } from "./preflight.ts";
import { resolveAvailableServices } from "./providers.ts";
import { SbxClient, SbxCommandError } from "./sbx/client.ts";
import { backupSessions, restoreSessions } from "./sessions.ts";
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
	"--docker-sandbox-keep",
	"--docker-sandbox-discard-changes",
	"--docker-sandbox-no-host-auth",
]);
const OUTER_VALUE_FLAGS = new Set([
	"--docker-sandbox-profile",
	"--docker-sandbox-name",
	"--docker-sandbox-sync",
]);
const NATIVE_INSTALL_ALLOW_HOSTS = [
	"archive.ubuntu.com",
	"security.ubuntu.com",
	"ports.ubuntu.com",
	"registry.npmjs.org",
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
];

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
	discardChanges?: boolean;
	noHostAuth?: boolean;
	yes?: boolean;
	projectTrusted?: boolean;
	client?: SbxClient;
	cleanup?: LaunchCleanup;
	stateCleanup?: LaunchStateCleanup;
	confirm?: (question: string) => Promise<boolean>;
	confirmInitialCommit?: (root: string) => Promise<boolean>;
	confirmResourceCopy?: (summary: string) => Promise<boolean>;
	confirmNativePackages?: (packages: readonly string[]) => Promise<boolean>;
	onStatus?: (line: string) => void;
	onWarning?: (warning: string) => void;
	/** @internal Test-only image resolver injection. */
	resolveImage?: KitImageResolver;
	/** @internal Test-only host certification injection. */
	certifyPlatform?: () => Promise<SupportedHost>;
	/** @internal Test-only state persistence injection. */
	saveState?: typeof saveSandboxState;
	/** @internal Test-only repository inspection injection. */
	inspectRepository?: typeof inspectRepository;
	/** @internal Test-only host API-key printer. */
	printApiKey?: (id: string) => Promise<string | undefined>;
	/** @internal Test-only host provider listing. */
	listHostProviders?: () => Promise<string[]>;
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
	options.onStatus?.("checking Docker Sandboxes");
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
	if (options.fresh && config.sandbox.name)
		throw new Error("--fresh cannot be combined with sandbox.name");
	if (!config.enabled)
		throw new Error(
			"Docker Sandboxes integration is disabled by configuration",
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
			recovery: ["wait for a published production runtime image"],
			cause,
		});
	}
	try {
		await (options.certifyPlatform ?? certifyHostPlatform)();
	} catch (cause) {
		throw new OperationError({
			phase: "preflight",
			operation: "certify host platform",
			detail: errorDetail(cause),
			recovery: ["pi-dsbx doctor"],
			cause,
		});
	}
	const sync = syncOptions(config.syncProfile, config.sync);
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
	if (!capabilities.clone)
		throw new OperationError({
			phase: "preflight",
			operation: "require sbx clone capability",
			detail: "Installed sbx does not support required clone mode",
			recovery: ["pi-dsbx doctor"],
		});
	if (!capabilities.noShareSkills)
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
	let repository: Awaited<ReturnType<typeof inspectRepository>>;
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
	const root = repository.root;
	const name = config.sandbox.name ?? sandboxName(root, options.fresh);
	return withSandboxLease(root, name, "run", () =>
		launchWithLease({
			options,
			client,
			loadedConfig,
			config,
			resolvedImage,
			sync,
			capabilities,
			inspectHostRepository,
			repository,
			root,
			name,
		}),
	);
}

async function launchWithLease(context: {
	options: LaunchOptions;
	client: SbxClient;
	loadedConfig: Awaited<ReturnType<typeof loadConfigResult>>;
	config: ReturnType<typeof mergeConfig>;
	resolvedImage: Awaited<ReturnType<typeof resolveKitImage>>;
	sync: ReturnType<typeof syncOptions>;
	capabilities: Awaited<ReturnType<SbxClient["capabilities"]>>;
	inspectHostRepository: typeof inspectRepository;
	repository: Awaited<ReturnType<typeof inspectRepository>>;
	root: string;
	name: string;
}): Promise<LaunchResult> {
	const {
		options,
		client,
		loadedConfig,
		config,
		resolvedImage,
		sync,
		capabilities,
		inspectHostRepository,
		repository,
		root,
		name,
	} = context;
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
	if (options.fresh && existing)
		throw new Error("Fresh sandbox name collision; retry the launch");
	let state: SandboxState | undefined;
	let stateMigrated = false;
	const warnings = [...loadedConfig.warnings];
	if (existing) {
		const loadedState = await loadSandboxStateResult(root, name);
		state = loadedState.value;
		stateMigrated = loadedState.migrated;
		warnings.push(...loadedState.warnings);
		if (state.hostRepoIdentity !== repository.identity)
			throw new Error("Existing sandbox belongs to another repository");
		if (state.hostBaseCommit !== repository.head)
			throw new Error(
				"Host HEAD changed since sandbox creation; export or destroy the sandbox before continuing",
			);
	}

	options.onStatus?.("syncing host credentials");
	const pushProviderWarning = (warning: string): void => {
		warnings.push(warning);
		options.onWarning?.(warning);
	};
	const hostProviderIds =
		config.auth.mode === "none" ? [] : config.auth.providers;
	const oauthHostIds =
		config.auth.mode === "oauth-copy" && !options.noHostAuth
			? await listHostOAuthProviderIds(hostProviderIds)
			: new Set<string>();
	const mapped = classifyHostProviders(
		hostProviderIds,
		capabilities.credentialServices,
		oauthHostIds,
	);
	const resolvedProviders = resolveAvailableServices(
		capabilities.credentialServices,
		mapped.requested,
	);
	for (const id of mapped.unmatched)
		pushProviderWarning(
			`Host provider ${id} has no sandbox credential service`,
		);
	for (const id of resolvedProviders.unsupported)
		pushProviderWarning(
			`Requested credential service ${id} is not both audited and proxy-supported`,
		);
	if (
		config.auth.mode === "proxy" &&
		config.auth.providers.length > 0 &&
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
	const custodyCommands = (): string[] => [
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
		const agentDir = join(homedir(), ".pi", "agent");
		const nativePackages = existing
			? []
			: await listNativePackageSpecs(agentDir, config.syncProfile, config.sync);
		const allowNativePackages =
			nativePackages.length > 0 &&
			options.yes !== true &&
			(await options.confirmNativePackages?.(nativePackages)) === true;
		const consentedNativePackages = new Set(nativePackages);
		options.onStatus?.("copying host profile");
		const snapshot = await createPersonalizationSnapshot(
			agentDir,
			profileDirectory,
			config.syncProfile,
			config.sync,
			{
				availableProviders: new Set([
					...configuredServices,
					...(options.noHostAuth ? [] : hostProviderIds),
				]),
				copyOAuth: !options.noHostAuth,
				deferAllPackages: !existing,
			},
		);
		warnings.push(...snapshot.warnings);
		let oauthAuthPath: string | undefined;
		try {
			oauthAuthPath = join(temp, "oauth-auth.json");
			await rename(join(profileDirectory, "auth.json"), oauthAuthPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			oauthAuthPath = undefined;
		}
		const nativePackagesToInstall = allowNativePackages
			? snapshot.nativePackages.filter((packageSpec) =>
					consentedNativePackages.has(packageSpec),
				)
			: [];
		if (
			snapshot.manifest.length > 0 &&
			config.syncProfile !== "mirror" &&
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
		const spec = buildKitSpec({
			config,
			services: resolvedProviders.services,
			image: resolvedImage.image,
			sandboxName: name,
			extraAllow:
				nativePackagesToInstall.length > 0
					? NATIVE_INSTALL_ALLOW_HOSTS
					: undefined,
		});
		const kitDirectory = join(temp, "kit");
		await writeKitDirectory(kitDirectory, spec, {
			personalization: profileDirectory,
		});
		await client.validateKit(kitDirectory);

		if (resolvedProviders.services.length > 0) {
			if (typeof client.setSecret === "function") {
				const synced = await syncHostProviderSecrets({
					services: resolvedProviders.services,
					hostProviderIds,
					configured: configuredServices,
					noHostAuth: options.noHostAuth,
					printApiKey: options.printApiKey,
					setSecret: (id, key) => client.setSecret(id, key),
				});
				for (const warning of synced.warnings) pushProviderWarning(warning);
				for (const id of synced.synced) configuredServices.add(id);
			}
			for (const warning of providerSetupGuidance(
				resolvedProviders.services,
				configuredServices,
			))
				pushProviderWarning(warning);
		}

		const request = {
			name,
			workspace: root,
			kit: kitDirectory,
			agentArgs: stripSandboxFlags(options.piArgs ?? []),
			env: sanitizedHostEnvironment(),
		};
		if (!existing) {
			primaryPhase = "create";
			primaryOperation = "create sandbox";
			options.onStatus?.("creating sandbox");
			await client.create(request);
			lifecycle.created = true;
			lifecycle.preserved = true;
			let compilerInstalled = nativePackagesToInstall.length === 0;
			if (nativePackagesToInstall.length > 0) {
				primaryOperation = "install sandbox compiler toolchain";
				options.onStatus?.("installing compiler");
				try {
					compilerInstalled =
						(
							await client.exec(
								name,
								[
									"sh",
									"-c",
									"apt-get -o Dir::Etc::sourcelist=sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=- update -qq && apt-get -o Dir::Etc::sourcelist=sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=- install -y --no-install-recommends build-essential python3",
								],
								{ user: "root" },
							)
						).code === 0;
				} catch {
					compilerInstalled = false;
				}
				if (!compilerInstalled) {
					const warning =
						"Could not install compiler; native packages were skipped";
					warnings.push(warning);
					options.onWarning?.(warning);
				}
			}
			const nativePackagesToInstallSet = new Set(nativePackagesToInstall);
			for (const packageSpec of snapshot.packageSpecs) {
				const native = snapshot.nativePackages.includes(packageSpec);
				if (
					native &&
					(!nativePackagesToInstallSet.has(packageSpec) || !compilerInstalled)
				)
					continue;
				primaryOperation = `install package ${packageSpec}`;
				options.onStatus?.(`installing ${packageSpec}`);
				let installed = false;
				try {
					installed =
						(
							await client.exec(name, ["pi", "install", packageSpec], {
								user: "agent",
							})
						).code === 0;
				} catch {
					installed = false;
				}
				if (!installed) {
					const warning = native
						? `Could not install ${packageSpec}; skills were copied instead`
						: `Could not install ${packageSpec}; package was skipped`;
					warnings.push(warning);
					options.onWarning?.(warning);
				}
			}
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
					imageAttestation: {
						status: "pending",
						image: resolvedImage.image,
						...(resolvedImage.templateStoreId
							? { templateStoreId: resolvedImage.templateStoreId }
							: {}),
					},
				};
			}
		}

		if (existing && state && !state.imageAttestation) {
			state.imageAttestation = {
				status: "pending",
				image: resolvedImage.image,
				...(resolvedImage.templateStoreId
					? { templateStoreId: resolvedImage.templateStoreId }
					: {}),
			};
			stateMigrated = true;
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
		const attestation = state?.imageAttestation;
		if (attestation) {
			primaryOperation = existing
				? "verify resumed sandbox image"
				: "verify created sandbox image";
			try {
				verifyCreatedImage(await client.inspect(name), attestation);
				if (attestation.status === "pending") {
					attestation.status = "verified";
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

		if (oauthAuthPath) {
			primaryOperation = "copy OAuth credentials into sandbox";
			const temporaryAuth = `/root/.pi-docker-sandboxes-auth-${randomUUID()}.json`;
			let credentialError: unknown;
			try {
				await client.copyTo(name, oauthAuthPath, temporaryAuth);
				const installed = await client.exec(
					name,
					[
						"install",
						"-o",
						"agent",
						"-g",
						"agent",
						"-m",
						"600",
						temporaryAuth,
						"/home/agent/.pi/agent/auth.json",
					],
					{ user: "root" },
				);
				if (installed.code !== 0)
					throw new Error("Could not install sandbox OAuth credentials");
			} catch (cause) {
				credentialError = cause;
			}
			try {
				const removed = await client.exec(
					name,
					["rm", "-f", "--", temporaryAuth],
					{ user: "root" },
				);
				if (removed.code !== 0)
					throw new Error("Could not remove staged OAuth credentials");
			} catch (cause) {
				credentialError ??= cause;
			}
			if (credentialError) throw credentialError;
		}

		if (!existing && !options.fresh && state && sync.sessions === "managed") {
			primaryPhase = "create";
			primaryOperation = "restore managed sessions";
			await restoreSessions(client, agentDir, state.hostRepoIdentity, name);
		}

		primaryPhase = "run";
		primaryOperation = "attach to sandbox";
		options.onStatus?.("starting Pi");
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
			if (inspected && changes === "changed" && !config.sandbox.keep && state) {
				exportRequested =
					config.export.onExit === "always" ||
					(config.export.onExit === "prompt" &&
						(await options.confirm?.("Export sandbox changes as a patch?")) ===
							true);
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
			if (disposition === "preserve") warnCustody();
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
