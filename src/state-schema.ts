export type SandboxPhase =
	| "creating"
	| "ready"
	| "exporting"
	| "removing"
	| "failed";

export interface SandboxImageAttestation {
	status: "pending" | "verified";
	image: string;
	templateStoreId?: string;
}

interface SandboxStateBase {
	name: string;
	hostBaseCommit: string;
	hostBranch: string;
	hostRepoIdentity: string;
	hostRoot: string;
	workspaceMode: "clone";
	createdAt: string;
}

export interface SandboxStateV1 extends SandboxStateBase {
	version: 1;
	imageAttestation?: SandboxImageAttestation;
}

export interface SandboxStateV2 extends SandboxStateBase {
	version: 2;
	phase: SandboxPhase;
	imageAttestation?: SandboxImageAttestation;
	hostWorktreeIdentity: string;
	updatedAt: string;
	runtimeImage: string;
	runtimeSchema: number;
	packageVersion: string;
	templateStoreId?: string;
	lastOperationError?: {
		category: "create" | "image" | "export" | "remove" | "reconcile";
		at: string;
	};
}

export type SandboxState = SandboxStateV1 | SandboxStateV2;

function record(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${path} must contain a state object`);
	return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0)
		throw new TypeError(`${field} must be a non-empty string`);
	return value;
}

function rejectUnknown(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	path: string,
): void {
	const unknown = Object.keys(value).find((key) => !allowed.has(key));
	if (unknown)
		throw new TypeError(`${path} has unknown state field ${unknown}`);
}

function image(
	value: unknown,
	field: string,
	templateStoreId?: unknown,
): string {
	const parsed = requiredString(value, field);
	if (templateStoreId === undefined) {
		if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(parsed))
			throw new TypeError(`${field} must be an immutable digest reference`);
	} else {
		const store = requiredString(templateStoreId, `${field}.templateStoreId`);
		if (
			!/^[a-f0-9]{12,64}$/.test(store) ||
			!/^[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/[a-z0-9]+(?:[._/-][a-z0-9]+)*:local-[a-f0-9]{64}$/.test(
				parsed,
			)
		)
			throw new TypeError(
				`${field} has an invalid local template store attestation`,
			);
	}
	return parsed;
}

function parseImageAttestation(
	value: unknown,
	path: string,
): SandboxImageAttestation {
	const attestation = record(value, path);
	rejectUnknown(
		attestation,
		new Set(["status", "image", "templateStoreId"]),
		path,
	);
	if (attestation.status !== "pending" && attestation.status !== "verified")
		throw new TypeError(`${path}.status is unsupported`);
	return {
		status: attestation.status,
		image: image(
			attestation.image,
			`${path}.image`,
			attestation.templateStoreId,
		),
		...(typeof attestation.templateStoreId === "string"
			? { templateStoreId: attestation.templateStoreId }
			: {}),
	};
}

const BASE_KEYS = [
	"version",
	"name",
	"hostBaseCommit",
	"hostBranch",
	"hostRepoIdentity",
	"hostRoot",
	"workspaceMode",
	"createdAt",
] as const;

function base(input: Record<string, unknown>, path: string): SandboxStateBase {
	const workspaceMode = requiredString(
		input.workspaceMode,
		`${path}.workspaceMode`,
	);
	if (workspaceMode !== "clone")
		throw new TypeError(`${path}.workspaceMode is unsupported`);
	return {
		name: requiredString(input.name, `${path}.name`),
		hostBaseCommit: requiredString(
			input.hostBaseCommit,
			`${path}.hostBaseCommit`,
		),
		hostBranch: requiredString(input.hostBranch, `${path}.hostBranch`),
		hostRepoIdentity: requiredString(
			input.hostRepoIdentity,
			`${path}.hostRepoIdentity`,
		),
		hostRoot: requiredString(input.hostRoot, `${path}.hostRoot`),
		workspaceMode,
		createdAt: requiredString(input.createdAt, `${path}.createdAt`),
	};
}

export function parseSandboxStateV1(
	value: unknown,
	path: string,
): SandboxStateV1 {
	const input = record(value, path);
	if (input.version !== 1)
		throw new TypeError(`${path} is not version 1 state`);
	rejectUnknown(input, new Set([...BASE_KEYS, "imageAttestation"]), path);
	const imageAttestation =
		input.imageAttestation === undefined
			? undefined
			: parseImageAttestation(
					input.imageAttestation,
					`${path}.imageAttestation`,
				);
	return {
		version: 1,
		...base(input, path),
		...(imageAttestation ? { imageAttestation } : {}),
	};
}

export function parseSandboxStateV2(
	value: unknown,
	path: string,
): SandboxStateV2 {
	const input = record(value, path);
	if (input.version !== 2)
		throw new TypeError(`${path} is not version 2 state`);
	rejectUnknown(
		input,
		new Set([
			...BASE_KEYS,
			"phase",
			"imageAttestation",
			"hostWorktreeIdentity",
			"updatedAt",
			"runtimeImage",
			"runtimeSchema",
			"packageVersion",
			"templateStoreId",
			"lastOperationError",
		]),
		path,
	);
	if (
		!["creating", "ready", "exporting", "removing", "failed"].includes(
			String(input.phase),
		)
	)
		throw new TypeError(`${path}.phase is unsupported`);
	if (
		!Number.isSafeInteger(input.runtimeSchema) ||
		(input.runtimeSchema as number) < 1
	)
		throw new TypeError(`${path}.runtimeSchema must be a positive integer`);
	const imageAttestation =
		input.imageAttestation === undefined
			? undefined
			: parseImageAttestation(
					input.imageAttestation,
					`${path}.imageAttestation`,
				);
	let lastOperationError: SandboxStateV2["lastOperationError"];
	if (input.lastOperationError !== undefined) {
		const error = record(
			input.lastOperationError,
			`${path}.lastOperationError`,
		);
		rejectUnknown(
			error,
			new Set(["category", "at"]),
			`${path}.lastOperationError`,
		);
		if (
			!["create", "image", "export", "remove", "reconcile"].includes(
				String(error.category),
			)
		)
			throw new TypeError(`${path}.lastOperationError.category is unsupported`);
		lastOperationError = {
			category: error.category as NonNullable<
				SandboxStateV2["lastOperationError"]
			>["category"],
			at: requiredString(error.at, `${path}.lastOperationError.at`),
		};
	}
	return {
		version: 2,
		...base(input, path),
		phase: input.phase as SandboxPhase,
		...(imageAttestation ? { imageAttestation } : {}),
		hostWorktreeIdentity: requiredString(
			input.hostWorktreeIdentity,
			`${path}.hostWorktreeIdentity`,
		),
		updatedAt: requiredString(input.updatedAt, `${path}.updatedAt`),
		runtimeImage: image(
			input.runtimeImage,
			`${path}.runtimeImage`,
			input.templateStoreId,
		),
		runtimeSchema: input.runtimeSchema as number,
		packageVersion: requiredString(
			input.packageVersion,
			`${path}.packageVersion`,
		),
		...(typeof input.templateStoreId === "string"
			? { templateStoreId: input.templateStoreId }
			: {}),
		...(lastOperationError ? { lastOperationError } : {}),
	};
}

export function parseSandboxState(value: unknown, path: string): SandboxState {
	const input = record(value, path);
	if (input.version === 1) return parseSandboxStateV1(input, path);
	if (input.version === 2) return parseSandboxStateV2(input, path);
	throw new TypeError(
		`${path} has unsupported state version ${String(input.version)}`,
	);
}
