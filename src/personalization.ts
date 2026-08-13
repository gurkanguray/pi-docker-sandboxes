import { constants } from "node:fs";
import {
	chmod,
	lstat,
	mkdir,
	open,
	opendir,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
	type FileHandle,
} from "node:fs/promises";
import {
	basename,
	dirname,
	extname,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { createHash } from "node:crypto";
import type { SyncOptions, SyncProfile } from "./config.ts";
import { scanSecretCategories } from "./errors.ts";

const SAFE_SETTINGS = new Set([
	"theme",
	"defaultProvider",
	"defaultModel",
	"defaultThinkingLevel",
	"enabledModels",
	"compaction",
	"retry",
	"markdown",
	"warnings",
	"steeringMode",
	"followUpMode",
]);
const SAFE_TOKEN_KEYS = new Set([
	"max tokens",
	"input tokens",
	"output tokens",
	"token budget",
]);
const SECRET_VALUE =
	/^(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-\S+)$/;
const URL_KEYS = /(url|endpoint|baseurl|base_url)$/i;
const ENV_REFERENCE = /^\$(?:[A-Z][A-Z0-9_]*|\{[A-Z][A-Z0-9_]*\})$/;

export interface Sanitized<T> {
	value: T;
	warnings: string[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeSettings(
	value: unknown,
): Sanitized<Record<string, unknown>> {
	if (!plainObject(value))
		throw new TypeError("settings.json must contain an object");
	const output: Record<string, unknown> = {};
	const warnings: string[] = [];
	for (const [key, entry] of Object.entries(value)) {
		if (!SAFE_SETTINGS.has(key)) {
			warnings.push(`settings.${key}: not imported`);
			continue;
		}
		if (
			typeof entry === "string" &&
			(entry.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry))
		) {
			warnings.push(`settings.${key}: absolute host path not imported`);
			continue;
		}
		const sanitized = sanitizeModelValue(
			entry,
			`settings.${key}`,
			key,
			warnings,
			false,
		);
		if (sanitized !== undefined) output[key] = sanitized;
	}
	return { value: output, warnings };
}

const PINNED_NPM =
	/^npm:(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function resolvePackageSpecs(value: unknown): Sanitized<string[]> {
	if (value === undefined) return { value: [], warnings: [] };
	if (!Array.isArray(value))
		throw new TypeError("settings.packages must be an array");
	const packages: string[] = [];
	const warnings: string[] = [];
	for (const [index, entry] of value.entries()) {
		const source =
			typeof entry === "string"
				? entry
				: plainObject(entry) && typeof entry.source === "string"
					? entry.source
					: undefined;
		if (!source || !PINNED_NPM.test(source)) {
			warnings.push(
				`settings.packages[${index}]: only exact pinned npm package specs are imported`,
			);
			continue;
		}
		packages.push(source);
	}
	return { value: [...new Set(packages)], warnings };
}

function normalizedKey(key: string): string {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((term) => term.toLowerCase())
		.join(" ");
}

function credentialKey(key: string): boolean {
	const normalized = normalizedKey(key);
	if (SAFE_TOKEN_KEYS.has(normalized)) return false;
	const terms = normalized.split(" ");
	if (
		terms.some((term) => term === "token" || term === "tokens") ||
		terms.some((term) =>
			[
				"secret",
				"password",
				"passwd",
				"passphrase",
				"credential",
				"credentials",
				"authorization",
				"cookie",
				"cookies",
			].includes(term),
		)
	)
		return true;
	return /(?:^| )(?:private key(?: data)?|access key(?: id)?|(?:x )?api key|proxy authorization|set cookie)(?: |$)/.test(
		normalized,
	);
}

function sanitizeModelValue(
	value: unknown,
	path: string,
	key: string,
	warnings: string[],
	allowEnvironmentReference = true,
): unknown {
	const isCredentialKey = credentialKey(key);
	if (
		isCredentialKey &&
		(!allowEnvironmentReference ||
			typeof value !== "string" ||
			!ENV_REFERENCE.test(value))
	) {
		warnings.push(`${path}: credential field not imported`);
		return undefined;
	}
	if (typeof value === "string") {
		if (value.startsWith("!")) {
			warnings.push(`${path}: command credential resolver not imported`);
			return undefined;
		}
		if (/^(?:\/|~[\\/]|\\\\|[A-Za-z]:[\\/]|file:)/i.test(value)) {
			warnings.push(`${path}: absolute host path not imported`);
			return undefined;
		}
		if (URL_KEYS.test(key)) {
			let url: URL;
			try {
				url = new URL(value);
			} catch {
				throw new TypeError(`${path}: invalid URL`);
			}
			if (url.username || url.password) {
				warnings.push(`${path}: credential-bearing URL not imported`);
				return undefined;
			}
		}
		if (
			(SECRET_VALUE.test(value) || scanSecretCategories(value).length > 0) &&
			value !== "proxy-managed" &&
			(!allowEnvironmentReference || !ENV_REFERENCE.test(value))
		) {
			warnings.push(`${path}: inline credential not imported`);
			return undefined;
		}
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((entry, index) =>
				sanitizeModelValue(
					entry,
					`${path}[${index}]`,
					key,
					warnings,
					allowEnvironmentReference,
				),
			)
			.filter((entry) => entry !== undefined);
	}
	if (plainObject(value)) {
		const output: Record<string, unknown> = {};
		for (const [childKey, child] of Object.entries(value)) {
			const sanitized = sanitizeModelValue(
				child,
				`${path}.${childKey}`,
				childKey,
				warnings,
				allowEnvironmentReference,
			);
			if (sanitized !== undefined) output[childKey] = sanitized;
		}
		return output;
	}
	return value;
}

export function sanitizeModels(
	value: unknown,
): Sanitized<Record<string, unknown>> {
	if (!plainObject(value))
		throw new TypeError("models.json must contain an object");
	const warnings: string[] = [];
	return {
		value: sanitizeModelValue(value, "models", "models", warnings) as Record<
			string,
			unknown
		>,
		warnings,
	};
}

export const MAX_RESOURCE_FILE_BYTES = 1_048_576;
const TEXT_EXTENSIONS = new Set([
	".md",
	".mdx",
	".txt",
	".json",
	".yaml",
	".yml",
	".toml",
	".js",
	".mjs",
	".cjs",
	".ts",
	".tsx",
	".jsx",
	".sh",
]);
const PRIVATE_KEY_HEADER =
	/-{5}BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-{5}|-{5}BEGIN OPENSSH PRIVATE KEY-{5}|-{5}BEGIN PGP PRIVATE KEY BLOCK-{5}/i;
const PRIVATE_KEY_NAME = /^(?:id_rsa|id_ed25519|id_dsa|id_ecdsa)$/i;
const CREDENTIAL_STORE_NAME = /^(?:auth\.json|credentials(?:\.json)?)$/i;

type Resource = "skills" | "prompts" | "themes" | "extensions";

export interface ResourceManifestEntry {
	resource: Resource;
	relativePath: string;
	bytes: number;
	sha256: string;
}

function filenameCategory(name: string): string | undefined {
	if (/^\.env/i.test(name)) return "environment file";
	if (PRIVATE_KEY_NAME.test(name) || /\.(?:pem|key)$/i.test(name))
		return "private key filename";
	if (CREDENTIAL_STORE_NAME.test(name)) return "credential store filename";
	return undefined;
}

function safeRelativePath(root: string, path: string): string {
	const output = relative(root, path);
	if (
		!output ||
		output === "." ||
		output.startsWith(`..${sep}`) ||
		output === ".." ||
		resolve(root, output) !== resolve(path)
	)
		throw new Error("Resource path: unsafe relative traversal");
	return output.split(sep).join("/");
}

export function scanResourceContent(
	relativePath: string,
	content: Buffer,
): string[] {
	if (!TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) return [];
	const text = content.toString("utf8");
	const categories = scanSecretCategories(text);
	if (PRIVATE_KEY_HEADER.test(text)) categories.push("private key header");
	return [...new Set(categories)].sort();
}

class ResourcePolicyError extends Error {}

function rejectResource(relativePath: string, category: string): never {
	throw new ResourcePolicyError(`Resource ${relativePath}: ${category}`);
}

function filesystemFailure(relativePath: string, cause: unknown): Error {
	return new Error(
		`Resource ${relativePath || "resource"}: filesystem validation failed`,
		{ cause },
	);
}

function sameIdentity(
	first: Pick<Awaited<ReturnType<FileHandle["stat"]>>, "dev" | "ino">,
	second: Pick<Awaited<ReturnType<FileHandle["stat"]>>, "dev" | "ino">,
): boolean {
	return first.dev === second.dev && first.ino === second.ino;
}

function compareCodepoints(first: string, second: string): number {
	return first < second ? -1 : first > second ? 1 : 0;
}

function requireOpenFlag(
	name: "O_NOFOLLOW" | "O_DIRECTORY" | "O_NONBLOCK",
): number {
	const flag = constants[name];
	if (typeof flag !== "number")
		throw new Error(`${name} is unavailable on this platform`);
	return flag;
}

type TestBoundary =
	| "beforeDestinationClaim"
	| "afterDestinationClaim"
	| "beforeSnapshotWrite"
	| "beforeSnapshotCleanup"
	| "beforeFileOpen"
	| "afterFileOpen"
	| "duringFileRead"
	| "afterDirectoryEnumerate";
interface PersonalizationSnapshotOptions {
	testHook?: (boundary: TestBoundary, relativePath: string) => Promise<void>;
}

type FileIdentity = Pick<
	Awaited<ReturnType<FileHandle["stat"]>>,
	"dev" | "ino"
>;

function destinationOwnershipChanged(cause?: unknown): Error {
	return new Error("Personalization destination ownership changed", { cause });
}

async function validateDestination(
	destination: string,
	handle: FileHandle,
	claimed: FileIdentity,
	expectedRealpath: string,
): Promise<void> {
	try {
		const [openStat, current, resolved] = await Promise.all([
			handle.stat(),
			lstat(destination),
			realpath(destination),
		]);
		if (
			!openStat.isDirectory() ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			!sameIdentity(claimed, openStat) ||
			!sameIdentity(claimed, current) ||
			resolved !== expectedRealpath
		)
			throw destinationOwnershipChanged();
	} catch (error) {
		if (
			(error as Error).message ===
			"Personalization destination ownership changed"
		)
			throw error;
		throw destinationOwnershipChanged(error);
	}
}

async function validateOpenedPath(
	handle: FileHandle,
	source: string,
	realRoot: string,
	expected: Awaited<ReturnType<FileHandle["stat"]>>,
	allowRoot = false,
): Promise<void> {
	const resolved = await realpath(source);
	const contained = relative(realRoot, resolved);
	if (
		(!allowRoot && !contained) ||
		contained === ".." ||
		contained.startsWith(`..${sep}`) ||
		resolve(realRoot, contained) !== resolve(resolved)
	)
		throw new Error("path escaped resource root");
	const current = await lstat(source);
	const openStat = await handle.stat();
	if (!sameIdentity(expected, openStat) || !sameIdentity(openStat, current))
		throw new Error("resource identity changed");
}

async function openValidatedDirectory(
	source: string,
	realRoot: string,
	relativePath: string,
	discovery: Awaited<ReturnType<typeof lstat>>,
	allowRoot = false,
): Promise<FileHandle> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			source,
			constants.O_RDONLY |
				requireOpenFlag("O_DIRECTORY") |
				requireOpenFlag("O_NOFOLLOW"),
		);
		const stat = await handle.stat();
		if (!sameIdentity(discovery, stat))
			throw new Error("directory replaced before open");
		if (!stat.isDirectory())
			rejectResource(relativePath, "non-directory resource");
		await validateOpenedPath(handle, source, realRoot, stat, allowRoot);
		return handle;
	} catch (error) {
		await handle?.close().catch(() => {});
		if (error instanceof ResourcePolicyError) throw error;
		throw filesystemFailure(relativePath, error);
	}
}

async function readValidatedFile(
	source: string,
	realRoot: string,
	relativePath: string,
	discovery: Awaited<ReturnType<typeof lstat>>,
	options: PersonalizationSnapshotOptions,
): Promise<Buffer> {
	let handle: FileHandle | undefined;
	try {
		await options.testHook?.("beforeFileOpen", relativePath);
		handle = await open(
			source,
			constants.O_RDONLY |
				requireOpenFlag("O_NOFOLLOW") |
				requireOpenFlag("O_NONBLOCK"),
		);
		const stat = await handle.stat();
		if (!sameIdentity(discovery, stat))
			throw new Error("resource replaced before open");
		if (!stat.isFile()) rejectResource(relativePath, "non-regular file");
		if (stat.nlink !== 1) rejectResource(relativePath, "hard link");
		if (stat.size > MAX_RESOURCE_FILE_BYTES)
			rejectResource(relativePath, "file too large");
		await options.testHook?.("afterFileOpen", relativePath);
		await validateOpenedPath(handle, source, realRoot, stat);

		const chunks: Buffer[] = [];
		let bytes = 0;
		let readHookCalled = false;
		while (bytes <= MAX_RESOURCE_FILE_BYTES) {
			const chunk = Buffer.allocUnsafe(
				Math.min(64 * 1024, MAX_RESOURCE_FILE_BYTES + 1 - bytes),
			);
			const result = await handle.read(chunk, 0, chunk.length, null);
			if (result.bytesRead === 0) break;
			chunks.push(chunk.subarray(0, result.bytesRead));
			bytes += result.bytesRead;
			if (!readHookCalled) {
				readHookCalled = true;
				await options.testHook?.("duringFileRead", relativePath);
			}
		}
		const finalStat = await handle.stat();
		if (
			bytes > MAX_RESOURCE_FILE_BYTES ||
			finalStat.size > MAX_RESOURCE_FILE_BYTES
		)
			rejectResource(relativePath, "file too large");
		if (
			!finalStat.isFile() ||
			finalStat.nlink !== 1 ||
			finalStat.size !== stat.size
		)
			rejectResource(relativePath, "filesystem identity changed");
		await validateOpenedPath(handle, source, realRoot, stat);
		return Buffer.concat(chunks, bytes);
	} catch (error) {
		if (error instanceof ResourcePolicyError) throw error;
		throw filesystemFailure(relativePath, error);
	} finally {
		await handle?.close().catch(() => {});
	}
}

async function copyResourceTree(
	source: string,
	destination: string,
	root: string,
	realRoot: string,
	resource: Resource,
	manifest: ResourceManifestEntry[],
	options: PersonalizationSnapshotOptions,
	ownedStage: (path: string, action: () => Promise<void>) => Promise<void>,
): Promise<void> {
	const relativePath = safeRelativePath(root, source);
	let discovery;
	try {
		discovery = await lstat(source);
	} catch (error) {
		throw filesystemFailure(relativePath, error);
	}
	if (discovery.isSymbolicLink()) rejectResource(relativePath, "symbolic link");
	const category = filenameCategory(basename(source));
	if (category) rejectResource(relativePath, category);
	if (discovery.isDirectory()) {
		const handle = await openValidatedDirectory(
			source,
			realRoot,
			relativePath,
			discovery,
		);
		const openedStat = await handle.stat();
		try {
			await ownedStage(destination, () =>
				mkdir(destination, { recursive: true, mode: 0o700 }).then(() => {}),
			);
			await ownedStage(destination, () => chmod(destination, 0o700));
			const directory = await opendir(source);
			try {
				await validateOpenedPath(handle, source, realRoot, openedStat);
				for await (const entry of directory)
					await copyResourceTree(
						join(source, entry.name),
						join(destination, entry.name),
						root,
						realRoot,
						resource,
						manifest,
						options,
						ownedStage,
					);
			} finally {
				await directory.close().catch(() => {});
			}
			await options.testHook?.("afterDirectoryEnumerate", relativePath);
			await validateOpenedPath(handle, source, realRoot, openedStat);
		} catch (error) {
			if (error instanceof ResourcePolicyError) throw error;
			if ((error as Error).message.startsWith("Resource ")) throw error;
			throw filesystemFailure(relativePath, error);
		} finally {
			await handle.close().catch(() => {});
		}
		return;
	}
	if (!discovery.isFile()) rejectResource(relativePath, "non-regular file");
	const content = await readValidatedFile(
		source,
		realRoot,
		relativePath,
		discovery,
		options,
	);
	const findings = scanResourceContent(relativePath, content);
	if (findings.length > 0) rejectResource(relativePath, findings[0]!);
	await ownedStage(dirname(destination), () =>
		mkdir(dirname(destination), { recursive: true, mode: 0o700 }).then(
			() => {},
		),
	);
	await ownedStage(destination, () =>
		writeFile(destination, content, { flag: "wx", mode: 0o600 }),
	);
	await ownedStage(destination, () => chmod(destination, 0o600));
	manifest.push({
		resource,
		relativePath,
		bytes: content.byteLength,
		sha256: createHash("sha256").update(content).digest("hex"),
	});
}

async function readJson(
	agentDir: string,
	name: "settings.json" | "models.json",
	options: PersonalizationSnapshotOptions,
): Promise<unknown | undefined> {
	const source = join(agentDir, name);
	let discovery;
	try {
		discovery = await lstat(source);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw filesystemFailure(name, error);
	}
	let realRoot: string;
	try {
		realRoot = await realpath(agentDir);
		const agentStat = await lstat(agentDir);
		if (!agentStat.isDirectory() || agentStat.isSymbolicLink())
			throw new Error("agent root is not a real directory");
	} catch (error) {
		throw filesystemFailure(name, error);
	}
	const content = await readValidatedFile(
		source,
		realRoot,
		name,
		discovery,
		options,
	);
	try {
		return JSON.parse(content.toString("utf8"));
	} catch (error) {
		throw new TypeError(`${name}: invalid JSON`, { cause: error });
	}
}

export interface PersonalizationSnapshot {
	hash: string;
	warnings: string[];
	directory: string;
	manifest: ResourceManifestEntry[];
}

const SYNC_POLICIES: Record<Exclude<SyncProfile, "custom">, SyncOptions> = {
	clean: {
		settings: false,
		models: false,
		packages: false,
		skills: false,
		prompts: false,
		themes: false,
		extensions: false,
		sessions: "sandbox",
	},
	balanced: {
		settings: true,
		models: true,
		packages: false,
		skills: false,
		prompts: false,
		themes: false,
		extensions: false,
		sessions: "managed",
	},
	mirror: {
		settings: true,
		models: true,
		packages: true,
		skills: true,
		prompts: true,
		themes: true,
		extensions: true,
		sessions: "managed",
	},
};

export function syncOptions(
	profile: SyncProfile,
	custom?: SyncOptions,
): SyncOptions {
	const policy = profile === "custom" ? custom : SYNC_POLICIES[profile];
	if (!policy)
		throw new TypeError("custom sync profile requires explicit sync options");
	return structuredClone(policy);
}

export async function createPersonalizationSnapshot(
	agentDir: string,
	destination: string,
	profile: SyncProfile,
	custom?: SyncOptions,
	options: PersonalizationSnapshotOptions = {},
): Promise<PersonalizationSnapshot> {
	await options.testHook?.("beforeDestinationClaim", "destination");
	await mkdir(destination, { mode: 0o700 });
	const destinationDiscovery = await lstat(destination);
	let destinationHandle: FileHandle | undefined;
	let claimed: FileIdentity | undefined = destinationDiscovery;
	let expectedRealpath: string | undefined;
	try {
		destinationHandle = await open(
			destination,
			constants.O_RDONLY |
				requireOpenFlag("O_DIRECTORY") |
				requireOpenFlag("O_NOFOLLOW"),
		);
		claimed = await destinationHandle.stat();
		expectedRealpath = await realpath(destination);
		await validateDestination(
			destination,
			destinationHandle,
			claimed,
			expectedRealpath,
		);
		await options.testHook?.("afterDestinationClaim", "destination");
		const validateOwnedDestination = (): Promise<void> =>
			validateDestination(
				destination,
				destinationHandle!,
				claimed!,
				expectedRealpath!,
			);
		const ownedStage = async (
			path: string,
			action: () => Promise<void>,
		): Promise<void> => {
			await options.testHook?.(
				"beforeSnapshotWrite",
				relative(destination, path),
			);
			await validateOwnedDestination();
			await action();
			await validateOwnedDestination();
		};
		if (!sameIdentity(destinationDiscovery, claimed))
			throw destinationOwnershipChanged();
		const warnings: string[] = [];
		const manifest: ResourceManifestEntry[] = [];
		const policy = syncOptions(profile, custom);
		if (policy.settings || policy.packages) {
			const settings = await readJson(agentDir, "settings.json", options);
			if (settings !== undefined) {
				const sanitized = policy.settings
					? sanitizeSettings(settings)
					: { value: {}, warnings: [] };
				warnings.push(...sanitized.warnings);
				if (policy.packages) {
					const packages = resolvePackageSpecs(
						plainObject(settings) ? settings.packages : undefined,
					);
					warnings.push(...packages.warnings);
					if (packages.value.length > 0)
						sanitized.value.packages = packages.value;
				}
				const settingsPath = join(destination, "settings.json");
				await ownedStage(settingsPath, () =>
					writeFile(
						settingsPath,
						`${JSON.stringify(sanitized.value, null, 2)}\n`,
						{ mode: 0o600 },
					),
				);
			}
		}
		if (policy.models) {
			const models = await readJson(agentDir, "models.json", options);
			if (models !== undefined) {
				const sanitized = sanitizeModels(models);
				warnings.push(...sanitized.warnings);
				const modelsPath = join(destination, "models.json");
				await ownedStage(modelsPath, () =>
					writeFile(
						modelsPath,
						`${JSON.stringify(sanitized.value, null, 2)}\n`,
						{ mode: 0o600 },
					),
				);
			}
		}
		const resources = (
			["skills", "prompts", "themes", "extensions"] as const
		).filter((resource) => policy[resource]);
		for (const resource of resources) {
			const source = join(agentDir, resource);
			let sourceStat;
			try {
				sourceStat = await lstat(source);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw filesystemFailure(resource, error);
			}
			if (sourceStat.isSymbolicLink())
				rejectResource(resource, "symbolic link");
			if (!sourceStat.isDirectory())
				rejectResource(resource, "non-directory resource");
			let realRoot: string;
			try {
				realRoot = await realpath(source);
			} catch (error) {
				throw filesystemFailure(resource, error);
			}
			const handle = await openValidatedDirectory(
				source,
				realRoot,
				resource,
				sourceStat,
				true,
			);
			const openedStat = await handle.stat();
			try {
				const resourceDestination = join(destination, resource);
				await ownedStage(resourceDestination, () =>
					mkdir(resourceDestination, { mode: 0o700 }).then(() => {}),
				);
				const directory = await opendir(source);
				try {
					await validateOpenedPath(handle, source, realRoot, openedStat, true);
					for await (const entry of directory)
						await copyResourceTree(
							join(source, entry.name),
							join(destination, resource, entry.name),
							resolve(source),
							realRoot,
							resource,
							manifest,
							options,
							ownedStage,
						);
				} finally {
					await directory.close().catch(() => {});
				}
				await options.testHook?.("afterDirectoryEnumerate", resource);
				await validateOpenedPath(handle, source, realRoot, openedStat, true);
			} catch (error) {
				if (error instanceof ResourcePolicyError) throw error;
				if ((error as Error).message.startsWith("Resource ")) throw error;
				throw filesystemFailure(resource, error);
			} finally {
				await handle.close().catch(() => {});
			}
		}
		manifest.sort(
			(first, second) =>
				resources.indexOf(first.resource) -
					resources.indexOf(second.resource) ||
				compareCodepoints(first.relativePath, second.relativePath),
		);
		if (!policy.extensions && profile !== "clean")
			warnings.push(
				"loose global extensions: excluded pending explicit approval",
			);
		await options.testHook?.("beforeSnapshotWrite", "hash");
		await validateOwnedDestination();
		const hash = await hashTree(destination);
		await validateOwnedDestination();
		const profilePath = join(destination, "docker-sandboxes-profile.json");
		await ownedStage(profilePath, () =>
			writeFile(
				profilePath,
				`${JSON.stringify({ hash, profile, policy, warnings, manifest }, null, 2)}\n`,
				{ mode: 0o600 },
			),
		);
		return { hash, warnings, directory: destination, manifest };
	} catch (error) {
		await options.testHook?.("beforeSnapshotCleanup", "destination");
		let ownsCurrentPath = false;
		if (claimed) {
			try {
				const current = await lstat(destination);
				ownsCurrentPath =
					!current.isSymbolicLink() && sameIdentity(claimed, current);
			} catch {
				ownsCurrentPath = false;
			}
		}
		if (ownsCurrentPath)
			await rm(destination, { recursive: true, force: true }).catch(() => {});
		if (
			error instanceof Error &&
			error.message === "Personalization destination ownership changed"
		)
			throw error;
		if (!ownsCurrentPath) throw destinationOwnershipChanged(error);
		throw error;
	} finally {
		await destinationHandle?.close().catch(() => {});
	}
}

export async function hashTree(root: string): Promise<string> {
	const hash = createHash("sha256");
	async function visit(path: string): Promise<void> {
		for (const name of (await readdir(path)).sort()) {
			const child = join(path, name);
			const stat = await lstat(child);
			if (stat.isSymbolicLink())
				throw new Error(`Refusing to hash symlink: ${child}`);
			hash.update(`${child.slice(root.length)}\0${stat.mode & 0o777}\0`);
			if (stat.isDirectory()) await visit(child);
			else if (stat.isFile()) hash.update(await readFile(child));
		}
	}
	await visit(root);
	return hash.digest("hex");
}

export function safeResourceName(path: string): string {
	const name = basename(path);
	if (!name || name === "." || name === "..")
		throw new TypeError("Invalid resource name");
	return name;
}
