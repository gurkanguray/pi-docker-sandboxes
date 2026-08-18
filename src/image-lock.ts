import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { RuntimePlatform } from "./platform.ts";

export type DigestReference = `${string}@sha256:${string}`;

type RuntimeImageFields = {
	platforms: readonly ["linux/amd64", "linux/arm64"];
	privileged: boolean;
};

export type LockedRuntimeImage =
	| (RuntimeImageFields & { status: "unpublished" })
	| (RuntimeImageFields & {
			status: "published";
			reference: DigestReference;
	  });

export type PublishedRuntimeImage = Extract<
	LockedRuntimeImage,
	{ status: "published" }
>;

export interface RuntimeImageLock {
	version: 2;
	runtimeSchema: 1;
	piVersion: string;
	images: {
		standard: LockedRuntimeImage;
		docker: LockedRuntimeImage;
	};
}

const LOCK_URL = new URL("../docker/image-lock.json", import.meta.url);
const LOCK_FIELDS = new Set([
	"version",
	"runtimeSchema",
	"piVersion",
	"images",
]);
const IMAGE_FIELDS = new Set([
	"status",
	"reference",
	"platforms",
	"privileged",
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

export function assertDigestReference(
	value: string,
	field: string,
): DigestReference {
	if (!/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(value))
		throw new TypeError(
			`${field} must be an immutable sha256 digest reference`,
		);
	return value as DigestReference;
}

function parseRuntimeImage(
	value: unknown,
	variant: "standard" | "docker",
): LockedRuntimeImage {
	const field = `images.${variant}`;
	const image = object(value, field);
	rejectUnknown(image, IMAGE_FIELDS, field);
	if (
		!Array.isArray(image.platforms) ||
		image.platforms.length !== 2 ||
		image.platforms[0] !== "linux/amd64" ||
		image.platforms[1] !== "linux/arm64"
	)
		throw new TypeError(
			`${field}.platforms must be exactly linux/amd64, linux/arm64`,
		);
	const expectedPrivilege = variant === "docker";
	if (image.privileged !== expectedPrivilege)
		throw new TypeError(
			`${field}.privileged must be exactly ${String(expectedPrivilege)}`,
		);
	const fields: RuntimeImageFields = {
		platforms: ["linux/amd64", "linux/arm64"],
		privileged: expectedPrivilege,
	};
	if (image.status === "unpublished") {
		if (image.reference !== undefined)
			throw new TypeError(`${field}.reference is forbidden while unpublished`);
		return { status: "unpublished", ...fields };
	}
	if (image.status === "published")
		return {
			status: "published",
			reference: assertDigestReference(
				requiredString(image.reference, `${field}.reference`),
				`${field}.reference`,
			),
			...fields,
		};
	throw new TypeError(`${field}.status is unsupported`);
}

export function parseImageLock(value: unknown): RuntimeImageLock {
	const lock = object(value, "image lock");
	rejectUnknown(lock, LOCK_FIELDS, "image lock");
	if (lock.version !== 2) throw new TypeError("image lock.version must be 2");
	if (lock.runtimeSchema !== 1)
		throw new TypeError("image lock.runtimeSchema must be 1");
	const images = object(lock.images, "images");
	rejectUnknown(images, new Set(["standard", "docker"]), "images");
	return {
		version: 2,
		runtimeSchema: 1,
		piVersion: version(lock.piVersion, "piVersion"),
		images: {
			standard: parseRuntimeImage(images.standard, "standard"),
			docker: parseRuntimeImage(images.docker, "docker"),
		},
	};
}

export function selectRuntimeImage(
	lock: RuntimeImageLock,
	dockerEngine: boolean,
	runtimePlatform: RuntimePlatform,
): PublishedRuntimeImage {
	const variant = dockerEngine ? "docker" : "standard";
	const image = lock.images[variant];
	if (image.status === "unpublished")
		throw new Error(`production runtime image ${variant} is unpublished`);
	if (!image.platforms.includes(runtimePlatform))
		throw new Error(
			`production runtime image ${variant} does not support ${runtimePlatform}`,
		);
	return image;
}

export async function loadImageLock(
	path = fileURLToPath(LOCK_URL),
): Promise<RuntimeImageLock> {
	return parseImageLock(JSON.parse(await readFile(path, "utf8")));
}

export const IMAGE_LOCK = parseImageLock(
	JSON.parse(readFileSync(LOCK_URL, "utf8")),
);
