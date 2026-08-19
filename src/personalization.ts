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
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { SyncOptions, SyncProfile } from "./config.ts";
import { scanSecretCategories } from "./errors.ts";
import { isCopyEligibleOAuthEntry } from "./host-auth.ts";
import { superviseCommand } from "./sbx/supervisor.ts";

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
	availableProviders?: ReadonlySet<string>,
): Sanitized<Record<string, unknown>> {
	if (!plainObject(value))
		throw new TypeError("settings.json must contain an object");
	const output: Record<string, unknown> = {};
	const warnings: string[] = [];
	for (const [key, entry] of Object.entries(value)) {
		if (!SAFE_SETTINGS.has(key)) {
			if (key !== "packages") warnings.push(`settings.${key}: not imported`);
			continue;
		}
		if (
			typeof entry === "string" &&
			(entry.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry))
		) {
			warnings.push(`settings.${key}: absolute host path not imported`);
			continue;
		}
		const sanitized = sanitizeSettingValue(
			entry,
			`settings.${key}`,
			key,
			warnings,
			false,
		);
		if (sanitized !== undefined) output[key] = sanitized;
	}
	if (availableProviders) {
		const models = output.enabledModels;
		if (Array.isArray(models))
			output.enabledModels = models.filter((entry) => {
				if (typeof entry !== "string") return false;
				const provider = entry.split("/")[0] ?? "";
				return availableProviders.has(provider);
			});
		const defaultProvider = output.defaultProvider;
		if (
			typeof defaultProvider === "string" &&
			!availableProviders.has(defaultProvider)
		) {
			delete output.defaultProvider;
			delete output.defaultModel;
		}
	}
	return { value: output, warnings };
}

const PACKAGE_CONTROLS = /\p{C}/u;
const NPM_PACKAGE =
	/^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/i;
const NPM_PACKAGE_LEGACY =
	/^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9*^~<>=|.+_-]+)?$/i;
const NPM_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/i;
const GIT_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const GIT_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const GIT_REF_SEGMENT = /^[a-z0-9._-]+$/i;

function safeGitHost(host: string): boolean {
	return (
		host.length <= 253 &&
		!host.startsWith("www.") &&
		host.includes(".") &&
		host.split(".").every((label) => GIT_HOST_LABEL.test(label))
	);
}

function safeGitPath(
	pathWithRef: string,
): { path: string; ref?: string } | undefined {
	const match = /^([^@#]+)(?:@([^@#]+))?$/.exec(pathWithRef);
	if (!match) return undefined;
	const path = (match[1] ?? "").replace(/\.git$/, "");
	const pathSegments = path.split("/");
	const ref = match[2];
	if (
		pathSegments.length !== 2 ||
		pathSegments.some(
			(segment) =>
				segment === "." || segment === ".." || !GIT_PATH_SEGMENT.test(segment),
		) ||
		pathSegments[1]?.endsWith(".git") ||
		(ref !== undefined &&
			(ref === "." || ref === ".." || !GIT_REF_SEGMENT.test(ref)))
	)
		return undefined;
	return { path, ref };
}

function safeRemotePackage(source: string, immutable = true): boolean {
	if (
		PACKAGE_CONTROLS.test(source) ||
		/\s/u.test(source) ||
		source.includes("?") ||
		source.includes("#") ||
		source.includes("\\")
	)
		return false;
	if (source.startsWith("npm:"))
		return (immutable ? NPM_PACKAGE : NPM_PACKAGE_LEGACY).test(source);
	if (!source.startsWith("git:") || source.includes("%")) return false;
	const spec = source.slice(4);
	const protocol = /^(https?|git|ssh):\/\//.exec(spec);
	if (protocol) {
		const remainder = spec.slice(protocol[0].length);
		const slash = remainder.indexOf("/");
		const rawHost = remainder.slice(0, slash);
		const rawPath = safeGitPath(remainder.slice(slash + 1));
		if (
			slash <= 0 ||
			!safeGitHost(rawHost) ||
			!rawPath ||
			(immutable && !GIT_COMMIT.test(rawPath.ref ?? ""))
		)
			return false;
		try {
			const parsed = new URL(spec);
			const parsedPath = safeGitPath(parsed.pathname.replace(/^\/+/, ""));
			return (
				parsed.protocol === `${protocol[1]}:` &&
				!parsed.username &&
				!parsed.password &&
				!parsed.search &&
				!parsed.hash &&
				!parsed.port &&
				parsed.hostname === rawHost &&
				safeGitHost(parsed.hostname) &&
				parsedPath?.path === rawPath.path &&
				parsedPath.ref === rawPath.ref
			);
		} catch {
			return false;
		}
	}
	if (spec.startsWith("git@")) {
		const colon = spec.indexOf(":", 4);
		const path = safeGitPath(spec.slice(colon + 1));
		return (
			colon > 4 &&
			safeGitHost(spec.slice(4, colon)) &&
			Boolean(path) &&
			(!immutable || GIT_COMMIT.test(path?.ref ?? ""))
		);
	}
	const slash = spec.indexOf("/");
	const path = safeGitPath(spec.slice(slash + 1));
	return (
		slash > 0 &&
		safeGitHost(spec.slice(0, slash)) &&
		Boolean(path) &&
		(!immutable || GIT_COMMIT.test(path?.ref ?? ""))
	);
}

export interface ImmutablePackageLock {
	source: string;
	kind: "npm" | "git";
	integrity?: string;
	commit?: string;
}

export type NpmPackCommand = (
	command: string,
	args: readonly string[],
	options: {
		policy: { timeoutMs: number; killGraceMs: number };
		maxBuffer?: number;
	},
) => Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;

export async function fetchVerifiedNpmPackage(
	lock: ImmutablePackageLock,
	destination: string,
	run: NpmPackCommand = superviseCommand,
): Promise<string> {
	const parsed = NPM_PACKAGE.exec(lock.source);
	if (lock.kind !== "npm" || !parsed || !lock.integrity)
		throw new TypeError("exact npm lock with sha512 integrity required");
	const result = await run(
		"npm",
		[
			"pack",
			`${parsed[1]}@${parsed[2]}`,
			"--pack-destination",
			destination,
			"--json",
			"--ignore-scripts",
		],
		{
			policy: { timeoutMs: 120_000, killGraceMs: 5_000 },
			maxBuffer: 1024 * 1024,
		},
	);
	if (result.code !== 0) throw new Error("npm package fetch failed");
	let filename: unknown;
	try {
		filename = (JSON.parse(result.stdout.toString("utf8")) as unknown[])[0];
		filename = plainObject(filename) ? filename.filename : undefined;
	} catch {
		throw new Error("npm package fetch returned an invalid response");
	}
	if (
		typeof filename !== "string" ||
		basename(filename) !== filename ||
		!filename.endsWith(".tgz")
	)
		throw new Error("npm package fetch returned an invalid response");
	const path = join(destination, filename);
	const [root, resolved, before] = await Promise.all([
		realpath(destination),
		realpath(path),
		lstat(path),
	]);
	if (
		resolved !== join(root, filename) ||
		!before.isFile() ||
		before.isSymbolicLink() ||
		before.nlink !== 1 ||
		before.size > 64 * 1024 * 1024
	)
		throw new Error("npm package fetch returned an unsafe artifact");
	const bytes = await readFile(path);
	const after = await lstat(path);
	if (
		after.dev !== before.dev ||
		after.ino !== before.ino ||
		after.size !== before.size
	)
		throw new Error("npm package artifact changed during verification");
	const declared = Buffer.from(
		lock.integrity.slice("sha512-".length),
		"base64",
	);
	const actual = createHash("sha512").update(bytes).digest();
	if (declared.length !== actual.length || !timingSafeEqual(declared, actual))
		throw new Error("npm package integrity verification failed");
	return path;
}

export function resolvePackageLocks(
	value: unknown,
): Sanitized<ImmutablePackageLock[]> {
	if (value === undefined) return { value: [], warnings: [] };
	if (!Array.isArray(value))
		throw new TypeError("settings.packages must be an array");
	const locks = new Map<string, ImmutablePackageLock>();
	const warnings: string[] = [];
	for (const [index, entry] of value.entries()) {
		const source =
			typeof entry === "string"
				? entry
				: plainObject(entry) && typeof entry.source === "string"
					? entry.source
					: undefined;
		if (!source || !/^(?:npm|git):/.test(source)) {
			warnings.push(
				`settings.packages[${index}]: host path package specs are not imported`,
			);
			continue;
		}
		if (!safeRemotePackage(source)) {
			if (safeRemotePackage(source, false))
				throw new TypeError(
					`settings.packages[${index}]: immutable package source required`,
				);
			warnings.push(
				`settings.packages[${index}]: unsafe remote package spec not imported`,
			);
			continue;
		}
		if (source.startsWith("npm:")) {
			const integrity = plainObject(entry) ? entry.integrity : undefined;
			if (typeof integrity !== "string" || !NPM_INTEGRITY.test(integrity))
				throw new TypeError(
					`settings.packages[${index}]: exact npm package requires sha512 integrity`,
				);
			const existing = locks.get(source);
			if (existing?.integrity && existing.integrity !== integrity)
				throw new TypeError(
					`settings.packages[${index}]: conflicting integrity receipts`,
				);
			locks.set(source, { source, kind: "npm", integrity });
			continue;
		}
		const commit = source.match(/@([0-9a-f]{40})$/i)?.[1];
		locks.set(source, { source, kind: "git", commit });
	}
	return { value: [...locks.values()], warnings };
}

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
		if (!source || !safeRemotePackage(source, false)) {
			warnings.push(
				source && /^(?:npm|git):/i.test(source)
					? `settings.packages[${index}]: unsafe remote package spec not imported`
					: `settings.packages[${index}]: host path package specs are not imported`,
			);
			continue;
		}
		packages.push(source);
	}
	return { value: [...new Set(packages)], warnings };
}

const NATIVE_NPM_DEPS = new Set([
	"better-sqlite3",
	"sqlite3",
	"node-gyp",
	"prebuild-install",
]);

function npmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4);
	const scoped = spec.match(/^(@[^/]+\/[^@]+)(?:@.+)?$/);
	if (scoped) return scoped[1];
	const name = spec.split("@")[0];
	return name || undefined;
}

function packageHasNativeDeps(pkg: Record<string, unknown>): boolean {
	const deps = {
		...(plainObject(pkg.dependencies) ? pkg.dependencies : {}),
		...(plainObject(pkg.optionalDependencies) ? pkg.optionalDependencies : {}),
	};
	return Object.keys(deps).some((name) => NATIVE_NPM_DEPS.has(name));
}

async function readInstalledNpmPackage(
	agentDir: string,
	source: string,
): Promise<Record<string, unknown> | undefined> {
	const name = npmPackageName(source);
	if (!name) return undefined;
	try {
		const parsed = JSON.parse(
			await readFile(
				join(agentDir, "npm", "node_modules", name, "package.json"),
				"utf8",
			),
		) as unknown;
		return plainObject(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function listNativePackageSpecs(
	agentDir: string,
	profile: SyncProfile,
	custom?: SyncOptions,
): Promise<string[]> {
	const policy = syncOptions(profile, custom);
	if (!policy.packages) return [];
	let settings: unknown;
	try {
		settings = JSON.parse(
			await readFile(join(agentDir, "settings.json"), "utf8"),
		);
	} catch {
		return [];
	}
	const packages = resolvePackageSpecs(
		plainObject(settings) ? settings.packages : undefined,
	);
	const native: string[] = [];
	for (const source of packages.value) {
		const installed = await readInstalledNpmPackage(agentDir, source);
		if (installed && packageHasNativeDeps(installed)) native.push(source);
	}
	return native;
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

function sanitizeSettingValue(
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
				sanitizeSettingValue(
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
			const sanitized = sanitizeSettingValue(
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

export type SanitizedModelMetadata = Record<string, unknown>;

const MODEL_STRING_KEYS = new Set(["id", "name", "api"]);
const MODEL_NUMBER_KEYS = new Set(["contextWindow", "maxTokens"]);
const MODEL_ENTRY_KEYS = new Set([
	...MODEL_STRING_KEYS,
	...MODEL_NUMBER_KEYS,
	"reasoning",
	"baseUrl",
	"input",
	"thinkingLevelMap",
	"cost",
]);
const PROVIDER_KEYS = new Set([
	...MODEL_ENTRY_KEYS,
	"models",
	"modelOverrides",
]);
const THINKING_LEVEL_KEYS = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);
const COST_KEYS = new Set([
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"inputTokensAbove",
]);

const DANGEROUS_METADATA_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor",
]);
const DYNAMIC_METADATA_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/;

function validateDynamicMetadataKey(key: string): string {
	if (DANGEROUS_METADATA_KEYS.has(key) || !DYNAMIC_METADATA_KEY.test(key))
		throw new TypeError("unsafe dynamic model metadata key");
	return key;
}

function safeMetadataUrl(value: unknown): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		/[^\x21-\x7e]/.test(value) ||
		value.includes("\\") ||
		/%(?:0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(value)
	)
		return undefined;
	try {
		const url = new URL(value);
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const labels = hostname.split(".");
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.port ||
			isIP(hostname) !== 0 ||
			labels.length < 2 ||
			labels.some(
				(label) =>
					label.startsWith("xn--") ||
					!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
			) ||
			/\.(?:internal|local|localhost)$/i.test(hostname)
		)
			return undefined;
		return url.href;
	} catch {
		return undefined;
	}
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function sanitizeCostTier(value: unknown): Record<string, unknown> | undefined {
	if (!plainObject(value)) return undefined;
	const output: Record<string, unknown> = {};
	for (const key of COST_KEYS) {
		const number = finiteNumber(value[key]);
		if (number !== undefined) output[key] = number;
	}
	return output;
}

function sanitizeCost(value: unknown): Record<string, unknown> | undefined {
	const output = sanitizeCostTier(value);
	if (!output || !plainObject(value)) return output;
	if (Array.isArray(value.tiers))
		output.tiers = value.tiers.flatMap((tier) => {
			const sanitized = sanitizeCostTier(tier);
			return sanitized ? [sanitized] : [];
		});
	return output;
}

function sanitizeModelEntry(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!plainObject(value)) return undefined;
	const output: Record<string, unknown> = {};
	for (const key of MODEL_STRING_KEYS)
		if (typeof value[key] === "string") output[key] = value[key];
	for (const key of MODEL_NUMBER_KEYS) {
		const number = finiteNumber(value[key]);
		if (number !== undefined) output[key] = number;
	}
	if (typeof value.reasoning === "boolean") output.reasoning = value.reasoning;
	const baseUrl = safeMetadataUrl(value.baseUrl);
	if (baseUrl) output.baseUrl = baseUrl;
	if (Array.isArray(value.input)) {
		const input = value.input.filter(
			(entry): entry is "text" | "image" =>
				entry === "text" || entry === "image",
		);
		if (input.length > 0) output.input = [...new Set(input)];
	}
	if (plainObject(value.thinkingLevelMap)) {
		const levels: Record<string, unknown> = {};
		for (const key of THINKING_LEVEL_KEYS) {
			const level = value.thinkingLevelMap[key];
			if (typeof level === "string" || level === null) levels[key] = level;
		}
		output.thinkingLevelMap = levels;
	}
	const cost = sanitizeCost(value.cost);
	if (cost) output.cost = cost;
	return output;
}

function modelEntryHasUnsupportedMetadata(value: unknown): boolean {
	if (!plainObject(value)) return true;
	if (Object.keys(value).some((key) => !MODEL_ENTRY_KEYS.has(key))) return true;
	if (!plainObject(value.cost)) return value.cost !== undefined;
	if (
		Object.keys(value.cost).some(
			(key) => key !== "tiers" && !COST_KEYS.has(key),
		)
	)
		return true;
	return (
		Array.isArray(value.cost.tiers) &&
		value.cost.tiers.some(
			(tier) =>
				!plainObject(tier) ||
				Object.keys(tier).some((key) => !COST_KEYS.has(key)),
		)
	);
}

function providerHasUnsupportedMetadata(value: unknown): boolean {
	if (!plainObject(value)) return true;
	if (Object.keys(value).some((key) => !PROVIDER_KEYS.has(key))) return true;
	if (
		Array.isArray(value.models) &&
		value.models.some((model) => modelEntryHasUnsupportedMetadata(model))
	)
		return true;
	return (
		plainObject(value.modelOverrides) &&
		Object.values(value.modelOverrides).some((override) =>
			modelEntryHasUnsupportedMetadata(override),
		)
	);
}

function sanitizeProvider(value: unknown): Record<string, unknown> | undefined {
	if (!plainObject(value)) return undefined;
	const output = sanitizeModelEntry(value)!;
	if (Array.isArray(value.models))
		output.models = value.models.flatMap((model) => {
			const sanitized = sanitizeModelEntry(model);
			return sanitized && typeof sanitized.id === "string" ? [sanitized] : [];
		});
	if (plainObject(value.modelOverrides)) {
		const overrides: Record<string, unknown> = {};
		for (const [id, override] of Object.entries(value.modelOverrides)) {
			validateDynamicMetadataKey(id);
			const sanitized = sanitizeModelEntry(override);
			if (sanitized) overrides[id] = sanitized;
		}
		output.modelOverrides = overrides;
	}
	return output;
}

export function sanitizeModels(
	value: unknown,
	kind: "models" | "store" = "models",
): Sanitized<SanitizedModelMetadata> {
	if (!plainObject(value))
		throw new TypeError("models.json must contain an object");
	const output: SanitizedModelMetadata = {};
	let dropped = false;
	if (kind === "models") {
		if (plainObject(value.providers)) {
			const providers: Record<string, unknown> = {};
			for (const [id, provider] of Object.entries(value.providers)) {
				validateDynamicMetadataKey(id);
				if (providerHasUnsupportedMetadata(provider)) dropped = true;
				const sanitized = sanitizeProvider(provider);
				if (sanitized) providers[id] = sanitized;
			}
			output.providers = providers;
		}
		dropped ||= Object.keys(value).some((key) => key !== "providers");
	} else {
		for (const [id, provider] of Object.entries(value)) {
			validateDynamicMetadataKey(id);
			if (!plainObject(provider)) {
				dropped = true;
				continue;
			}
			const sanitized: Record<string, unknown> = {};
			const checkedAt = finiteNumber(provider.checkedAt);
			if (checkedAt !== undefined) sanitized.checkedAt = checkedAt;
			if (Array.isArray(provider.models)) {
				if (
					provider.models.some((model) =>
						modelEntryHasUnsupportedMetadata(model),
					)
				)
					dropped = true;
				sanitized.models = provider.models.flatMap((model) => {
					const entry = sanitizeModelEntry(model);
					return entry && typeof entry.id === "string" ? [entry] : [];
				});
			}
			output[id] = sanitized;
			if (
				Object.keys(provider).some(
					(key) => key !== "checkedAt" && key !== "models",
				)
			)
				dropped = true;
		}
	}
	return {
		value: output,
		warnings: dropped
			? ["model metadata outside the production allowlist was not imported"]
			: [],
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
	const categories = scanSecretCategories(text).filter(
		(category) =>
			category !== "secret assignment" ||
			!/^\.(?:md|mdx)$/i.test(extname(relativePath)),
	);
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
	| "afterDirectoryEnumerate"
	| "afterExtensionClassification";
interface PersonalizationSnapshotOptions {
	testHook?: (boundary: TestBoundary, relativePath: string) => Promise<void>;
	availableProviders?: ReadonlySet<string>;
	copyOAuth?: boolean;
	allowNativePackages?: boolean;
	deferNativePackages?: boolean;
	deferAllPackages?: boolean;
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

async function isPiExtensionEntry(
	source: string,
	realRoot: string,
	entry: {
		name: string;
		isDirectory(): boolean;
		isFile(): boolean;
		isSymbolicLink(): boolean;
	},
	options: PersonalizationSnapshotOptions,
): Promise<boolean> {
	if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
		return true;
	if (entry.isFile()) return /\.(?:js|ts)$/.test(entry.name);

	for (const name of ["index.ts", "index.js"]) {
		try {
			await lstat(join(source, name));
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw filesystemFailure(`${entry.name}/${name}`, error);
		}
	}

	const manifestPath = join(source, "package.json");
	let discovery;
	try {
		discovery = await lstat(manifestPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw filesystemFailure(`${entry.name}/package.json`, error);
	}
	if (discovery.isSymbolicLink()) return true;
	if (!discovery.isFile()) return false;
	const content = await readValidatedFile(
		manifestPath,
		realRoot,
		`${entry.name}/package.json`,
		discovery,
		options,
	);
	let manifest: unknown;
	try {
		manifest = JSON.parse(content.toString("utf8"));
	} catch {
		return false;
	}
	const pi =
		plainObject(manifest) && plainObject(manifest.pi) ? manifest.pi : {};
	const candidates =
		Array.isArray(pi.extensions) &&
		pi.extensions.every(
			(candidate): candidate is string => typeof candidate === "string",
		)
			? pi.extensions
			: [];
	const root = resolve(source);
	for (const candidate of candidates) {
		if (candidate.length === 0) continue;
		const target = resolve(source, candidate);
		if (target === root || !target.startsWith(`${root}${sep}`)) continue;
		try {
			await lstat(target);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw filesystemFailure(`${entry.name}/package.json`, error);
		}
	}
	return false;
}

async function copyResourceTree(
	source: string,
	destination: string,
	root: string,
	realRoot: string,
	resource: Resource,
	manifest: ResourceManifestEntry[],
	warnings: string[],
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
						warnings,
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
	if (findings.length > 0) {
		warnings.push(`skipped ${relativePath}: ${findings[0]}`);
		return;
	}
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
	name: "settings.json" | "models.json" | "models-store.json" | "auth.json",
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
	packageLocks: ImmutablePackageLock[];
	packageSpecs: string[];
	nativePackages: string[];
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
		const packageLocks: ImmutablePackageLock[] = [];
		const packageSpecs: string[] = [];
		const nativePackages: string[] = [];
		let nativeSkillsDestinationCreated = false;
		const policy = syncOptions(profile, custom);
		if (policy.settings || policy.packages) {
			const settings = await readJson(agentDir, "settings.json", options);
			if (settings !== undefined) {
				const sanitized = policy.settings
					? sanitizeSettings(settings, options.availableProviders)
					: { value: {}, warnings: [] };
				warnings.push(...sanitized.warnings);
				if (policy.packages) {
					const packages = resolvePackageLocks(
						plainObject(settings) ? settings.packages : undefined,
					);
					warnings.push(...packages.warnings);
					packageLocks.push(...packages.value);
					packageSpecs.push(...packages.value.map((entry) => entry.source));
					const installable: string[] = [];
					for (const { source } of packages.value) {
						const installed = await readInstalledNpmPackage(agentDir, source);
						if (installed && packageHasNativeDeps(installed)) {
							nativePackages.push(source);
							if (options.allowNativePackages && !options.deferAllPackages) {
								installable.push(source);
								continue;
							}
							if (!options.deferNativePackages && !options.deferAllPackages)
								warnings.push(
									`${source} skipped: native module cannot install in the sandbox`,
								);
							const name = npmPackageName(source);
							if (name) {
								const skillRoot = join(
									agentDir,
									"npm",
									"node_modules",
									name,
									"skills",
								);
								let skillStat;
								try {
									skillStat = await lstat(skillRoot);
								} catch (error) {
									if ((error as NodeJS.ErrnoException).code === "ENOENT")
										continue;
									throw filesystemFailure("skills", error);
								}
								if (skillStat.isSymbolicLink())
									rejectResource("skills", "symbolic link");
								if (!skillStat.isDirectory())
									rejectResource("skills", "non-directory resource");
								let realSkillRoot: string;
								try {
									realSkillRoot = await realpath(skillRoot);
								} catch (error) {
									throw filesystemFailure("skills", error);
								}
								const handle = await openValidatedDirectory(
									skillRoot,
									realSkillRoot,
									"skills",
									skillStat,
									true,
								);
								const openedStat = await handle.stat();
								try {
									const skillDest = join(destination, "skills");
									await ownedStage(skillDest, () =>
										mkdir(skillDest, { recursive: true, mode: 0o700 }).then(
											() => {},
										),
									);
									nativeSkillsDestinationCreated = true;
									const directory = await opendir(skillRoot);
									try {
										await validateOpenedPath(
											handle,
											skillRoot,
											realSkillRoot,
											openedStat,
											true,
										);
										for await (const entry of directory) {
											const entryDestination = join(skillDest, entry.name);
											try {
												await lstat(entryDestination);
												rejectResource(
													`skills/${entry.name}`,
													"destination collision",
												);
											} catch (error) {
												if (error instanceof ResourcePolicyError) throw error;
												if ((error as NodeJS.ErrnoException).code !== "ENOENT")
													throw error;
											}
											await copyResourceTree(
												join(skillRoot, entry.name),
												entryDestination,
												skillRoot,
												realSkillRoot,
												"skills",
												manifest,
												warnings,
												options,
												ownedStage,
											);
										}
									} finally {
										await directory.close().catch(() => {});
									}
									await validateOpenedPath(
										handle,
										skillRoot,
										realSkillRoot,
										openedStat,
										true,
									);
								} catch (error) {
									if (error instanceof ResourcePolicyError) throw error;
									if ((error as Error).message.startsWith("Resource "))
										throw error;
									throw filesystemFailure("skills", error);
								} finally {
									await handle.close().catch(() => {});
								}
							}
							continue;
						}
						if (!options.deferAllPackages) installable.push(source);
					}
					if (installable.length > 0) sanitized.value.packages = installable;
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
			const store = await readJson(agentDir, "models-store.json", options);
			if (store !== undefined && plainObject(store)) {
				const sanitized = sanitizeModels(store, "store");
				warnings.push(...sanitized.warnings);
				const storePath = join(destination, "models-store.json");
				await ownedStage(storePath, () =>
					writeFile(
						storePath,
						`${JSON.stringify(sanitized.value, null, 2)}\n`,
						{ mode: 0o600 },
					),
				);
			}
		}
		const hostAuth = options.copyOAuth
			? await readJson(agentDir, "auth.json", options)
			: undefined;
		if (hostAuth !== undefined && plainObject(hostAuth)) {
			const oauthAuth: Record<string, unknown> = {};
			for (const [id, entry] of Object.entries(hostAuth)) {
				if (!isCopyEligibleOAuthEntry(entry)) continue;
				if (options.availableProviders && !options.availableProviders.has(id))
					continue;
				oauthAuth[id] = {
					type: "oauth",
					access: entry.access,
					refresh: entry.refresh,
					...(typeof entry.expires === "number"
						? { expires: entry.expires }
						: {}),
					...(typeof entry.accountId === "string"
						? { accountId: entry.accountId }
						: {}),
				};
			}
			if (Object.keys(oauthAuth).length > 0) {
				const authPath = join(destination, "auth.json");
				await ownedStage(authPath, () =>
					writeFile(authPath, `${JSON.stringify(oauthAuth, null, 2)}\n`, {
						mode: 0o600,
					}),
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
				await ownedStage(resourceDestination, async () => {
					try {
						await mkdir(resourceDestination, { mode: 0o700 });
					} catch (error) {
						if (
							resource !== "skills" ||
							!nativeSkillsDestinationCreated ||
							(error as NodeJS.ErrnoException).code !== "EEXIST"
						)
							throw error;
						const current = await lstat(resourceDestination);
						if (current.isSymbolicLink())
							rejectResource(resource, "destination symbolic link");
						if (!current.isDirectory())
							rejectResource(resource, "destination collision");
					}
				});
				const destinationRealRoot =
					resource === "extensions"
						? await realpath(resourceDestination)
						: undefined;
				const directory = await opendir(source);
				try {
					await validateOpenedPath(handle, source, realRoot, openedStat, true);
					for await (const entry of directory) {
						const entrySource = join(source, entry.name);
						if (resource === "extensions") {
							if (
								!(await isPiExtensionEntry(
									entrySource,
									realRoot,
									entry,
									options,
								))
							) {
								warnings.push(
									`skipped extensions/${entry.name}: not a Pi extension`,
								);
								continue;
							}
							await options.testHook?.(
								"afterExtensionClassification",
								entry.name,
							);
						}
						const entryDestination = join(resourceDestination, entry.name);
						try {
							await lstat(entryDestination);
							rejectResource(
								`${resource}/${entry.name}`,
								"destination collision",
							);
						} catch (error) {
							if (error instanceof ResourcePolicyError) throw error;
							if ((error as NodeJS.ErrnoException).code !== "ENOENT")
								throw error;
						}
						await copyResourceTree(
							entrySource,
							entryDestination,
							resolve(source),
							realRoot,
							resource,
							manifest,
							warnings,
							options,
							ownedStage,
						);
						if (
							resource === "extensions" &&
							!(await isPiExtensionEntry(
								entryDestination,
								destinationRealRoot!,
								entry,
								options,
							))
						)
							rejectResource(
								`extensions/${entry.name}`,
								"entrypoint changed during copy",
							);
					}
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
		const resourceScanWarning =
			/^skipped .+: (?:credential URL|authorization credential|secret token|secret assignment|private key header)$/;
		const skipped = warnings.filter((warning) =>
			resourceScanWarning.test(warning),
		);
		if (skipped.length > 0) {
			const remaining = warnings.filter(
				(warning) => !resourceScanWarning.test(warning),
			);
			warnings.length = 0;
			warnings.push(
				...remaining,
				`skipped ${skipped.length} secret-bearing files during ${profile} sync`,
			);
		}
		const collapseWarnings = (
			pattern: RegExp,
			summary: (count: number) => string,
		): void => {
			let count = 0;
			for (let index = warnings.length - 1; index >= 0; index -= 1) {
				if (!pattern.test(warnings[index]!)) continue;
				warnings.splice(index, 1);
				count += 1;
			}
			if (count > 0) warnings.push(summary(count));
		};
		collapseWarnings(
			/^settings\.[^:]+: not imported$/,
			(count) => `skipped ${count} settings keys`,
		);
		collapseWarnings(
			/^settings\.packages\[\d+\]: host path/,
			(count) => `skipped ${count} host-path packages`,
		);
		collapseWarnings(
			/ skipped: native module cannot install in the sandbox$/,
			(count) => `skipped ${count} native packages (no compiler)`,
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
				`${JSON.stringify({ hash, profile, policy, warnings, manifest, packageLocks }, null, 2)}\n`,
				{ mode: 0o600 },
			),
		);
		return {
			hash,
			warnings,
			directory: destination,
			manifest,
			packageLocks,
			packageSpecs,
			nativePackages,
		};
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
