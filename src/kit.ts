import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DockerSandboxConfig } from "./config.ts";
import type { CredentialService } from "./config.ts";
import {
	IMAGE_LOCK,
	assertDigestReference,
	type ImageLock,
} from "./image-lock.ts";
import { OperationError } from "./errors.ts";
import { runImageCommand, verifyImage, type ImageCommand } from "./image.ts";
import {
	deriveLocalTemplateImage,
	requireLocalTemplate,
} from "./local-template.ts";
import { getNetworkProfile } from "./profiles.ts";

export const PI_VERSION = IMAGE_LOCK.piVersion;
export const PACKAGE_VERSION = IMAGE_LOCK.packageVersion;
export const BASE_IMAGES = { docker: IMAGE_LOCK.baseImage } as const;

export interface KitOptions {
	config: DockerSandboxConfig;
	services: CredentialService[];
	image?: string;
	sandboxName?: string;
}

export interface KitCredential {
	service: string;
	required: boolean;
	apiKey: {
		name: string;
		proxyManaged: true;
		inject: Array<{ domain: string; header: string; format: string }>;
	};
}

export interface PiKitSpec {
	schemaVersion: "2";
	kind: "sandbox";
	name: "pi-docker-sandboxes";
	version: string;
	displayName: string;
	description: string;
	locked: string[];
	security: { privileged: boolean };
	sandbox: {
		image: string;
		entrypoint: string[];
		command: { default: string[]; interactive: string[] };
	};
	environment: { variables: Record<string, string> };
	permissions: { network: { allow: string[]; deny: string[] } };
	credentials?: KitCredential[];
}

export interface ResolvedKitImage {
	image: string;
	templateStoreId?: string;
}

export type KitImageResolver = (
	config: DockerSandboxConfig,
) => Promise<ResolvedKitImage>;

export async function resolveKitImage(
	config: DockerSandboxConfig,
	lock: ImageLock = IMAGE_LOCK,
	run: ImageCommand = runImageCommand,
): Promise<ResolvedKitImage> {
	if (config.sandbox.image)
		return {
			image: assertDigestReference(config.sandbox.image, "sandbox.image"),
		};
	if (!config.sandbox.dockerEngine)
		throw new TypeError(
			"sandbox.image must be set to a digest-pinned image when dockerEngine is false",
		);
	if (lock.publishedImage)
		return {
			image: assertDigestReference(lock.publishedImage, "publishedImage"),
		};
	try {
		const discoveredId = (
			await run("docker", [
				"image",
				"inspect",
				"--format",
				"{{.Id}}",
				lock.localImage,
			])
		).stdout.trim();
		if (!/^sha256:[0-9a-f]{64}$/.test(discoveredId))
			throw new TypeError("locked local tag must resolve to an image ID");
		const verifiedImage = await verifyImage(discoveredId, lock, run);
		if (verifiedImage !== discoveredId)
			throw new TypeError("verified local image identity changed");
		const image = deriveLocalTemplateImage(lock.localImage, verifiedImage);
		const template = requireLocalTemplate(
			(await run("sbx", ["template", "ls", "--json"])).stdout,
			image,
		);
		return { image, templateStoreId: template.storeId };
	} catch (cause) {
		throw new OperationError({
			phase: "preflight",
			operation: "resolve immutable sandbox image",
			detail:
				"No published image is locked and the locked local image is absent or invalid",
			recovery: ["pi-dsbx image build"],
			cause,
		});
	}
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

export function buildKitSpec(options: KitOptions): PiKitSpec {
	const { config, services } = options;
	const profile = getNetworkProfile(config.profile);
	if (!config.sandbox.dockerEngine && !config.sandbox.image)
		throw new Error(
			"sandbox.image must be set to a digest-pinned image when dockerEngine is false",
		);
	const image =
		options.image ?? config.sandbox.image ?? IMAGE_LOCK.publishedImage;
	if (!image)
		throw new Error(
			"sandbox.image must be resolved to an immutable published or verified local image",
		);
	try {
		assertDigestReference(image, "sandbox.image");
	} catch (cause) {
		const expectedLocal = image.match(/^(.+):local-([0-9a-f]{64})$/);
		if (
			!expectedLocal ||
			deriveLocalTemplateImage(
				IMAGE_LOCK.localImage,
				`sha256:${expectedLocal[2]}`,
			) !== image
		)
			throw cause;
	}
	const serviceDomains = services.flatMap((service) => service.domains);
	const allow = unique([
		...profile.allow,
		...serviceDomains,
		...config.network.allow,
	]);
	const deny = unique(config.network.deny);
	const spec: PiKitSpec = {
		schemaVersion: "2",
		kind: "sandbox",
		name: "pi-docker-sandboxes",
		version: PACKAGE_VERSION,
		displayName: "Pi",
		description: "Pi coding agent in a Docker Sandboxes microVM",
		locked: ["sandbox.image"],
		security: { privileged: config.sandbox.dockerEngine },
		sandbox: {
			image,
			entrypoint: [
				"pi",
				"-e",
				"/usr/local/share/npm-global/lib/node_modules/pi-docker-sandboxes",
			],
			command: { default: [], interactive: [] },
		},
		environment: {
			variables: {
				PI_DOCKER_SANDBOX_ACTIVE: "1",
				...(options.sandboxName
					? { PI_DOCKER_SANDBOX_NAME: options.sandboxName }
					: {}),
				PI_DOCKER_SANDBOX_PACKAGE_VERSION: PACKAGE_VERSION,
				PI_DOCKER_SANDBOX_PROFILE: config.profile,
				PI_DOCKER_SANDBOX_SYNC_PROFILE: config.syncProfile,
				PI_DOCKER_SANDBOX_WORKSPACE_MODE: config.workspaceMode,
				PI_TELEMETRY: "0",
			},
		},
		permissions: { network: { allow, deny } },
	};
	if (services.length > 0) {
		spec.credentials = services.map((service) => ({
			service: service.id,
			required: false,
			apiKey: {
				name: service.envVar,
				proxyManaged: true,
				inject: service.domains.map((domain) => ({
					domain,
					header: service.headerName,
					format: service.valueFormat,
				})),
			},
		}));
	}
	return spec;
}

export async function writeKitDirectory(
	directory: string,
	spec: PiKitSpec,
	options: { personalization?: string } = {},
): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await writeFile(
		join(directory, "spec.yaml"),
		`${JSON.stringify(spec, null, 2)}\n`,
		{ mode: 0o600 },
	);
	if (options.personalization) {
		const destination = join(directory, "files", "home", ".pi", "agent");
		await mkdir(destination, { recursive: true, mode: 0o700 });
		await cp(options.personalization, destination, {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
	}
}

export function assertKitContainsNoSecrets(
	specText: string,
	secrets: readonly string[],
): void {
	for (const secret of secrets) {
		if (secret && specText.includes(secret))
			throw new Error("Generated Kit contains a host secret");
	}
}
