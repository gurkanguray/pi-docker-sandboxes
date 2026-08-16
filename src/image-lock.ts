import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface ImageLock {
	packageVersion: string;
	piVersion: string;
	platform: "linux/arm64";
	baseImage: string;
	localImage: string;
	tools: {
		fdDebianVersion: string;
		rgDebianVersion: string;
		gitDebianVersion: string;
	};
}

const LOCK_URL = new URL("../docker/image-lock.json", import.meta.url);
const LOCK_FIELDS = new Set([
	"packageVersion",
	"piVersion",
	"platform",
	"baseImage",
	"localImage",
	"tools",
]);
const TOOL_FIELDS = new Set([
	"fdDebianVersion",
	"rgDebianVersion",
	"gitDebianVersion",
]);
const SEMVER_LIKE =
	/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

function object(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${field} must be an object`);
	return value as Record<string, unknown>;
}

function rejectUnknown(
	value: Record<string, unknown>,
	allowed: Set<string>,
	field: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key))
			throw new TypeError(`${field} has unknown field ${key}`);
	}
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.trim() !== value)
		throw new TypeError(`${field} must be a nonempty exact string`);
	return value;
}

function version(value: unknown, field: string): string {
	const parsed = requiredString(value, field);
	if (!SEMVER_LIKE.test(parsed))
		throw new TypeError(`${field} must be semver-like`);
	return parsed;
}

function debianVersion(value: unknown, field: string): string {
	const parsed = requiredString(value, field);
	if (!/^\d[0-9A-Za-z.+:~-]*$/.test(parsed))
		throw new TypeError(`${field} must be an exact Debian package version`);
	return parsed;
}

export function assertDigestReference(value: string, field: string): string {
	if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(value))
		throw new TypeError(
			`${field} must be an immutable sha256 digest reference`,
		);
	return value;
}

export function parseImageLock(value: unknown): ImageLock {
	const lock = object(value, "image lock");
	rejectUnknown(lock, LOCK_FIELDS, "image lock");
	const baseImage = assertDigestReference(
		requiredString(lock.baseImage, "baseImage"),
		"baseImage",
	);
	const packageVersion = version(lock.packageVersion, "packageVersion");
	const piVersion = version(lock.piVersion, "piVersion");
	if (lock.platform !== "linux/arm64")
		throw new TypeError("platform must be exactly linux/arm64");
	const localImage = requiredString(lock.localImage, "localImage");
	if (localImage !== `docker.io/pi-docker-sandboxes/pi:${packageVersion}`)
		throw new TypeError(
			"localImage must be the package-versioned local build tag; resolve its RepoDigest before selection",
		);
	const tools = object(lock.tools, "tools");
	rejectUnknown(tools, TOOL_FIELDS, "tools");
	return {
		packageVersion,
		piVersion,
		platform: "linux/arm64",
		baseImage,
		localImage,
		tools: {
			fdDebianVersion: debianVersion(
				tools.fdDebianVersion,
				"tools.fdDebianVersion",
			),
			rgDebianVersion: debianVersion(
				tools.rgDebianVersion,
				"tools.rgDebianVersion",
			),
			gitDebianVersion: debianVersion(
				tools.gitDebianVersion,
				"tools.gitDebianVersion",
			),
		},
	};
}

export async function loadImageLock(
	path = fileURLToPath(LOCK_URL),
): Promise<ImageLock> {
	return parseImageLock(JSON.parse(await readFile(path, "utf8")));
}

export const IMAGE_LOCK = parseImageLock(
	JSON.parse(readFileSync(LOCK_URL, "utf8")),
);
