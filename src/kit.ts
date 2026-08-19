import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DockerSandboxConfig } from "./config.ts";
import type { CredentialService } from "./config.ts";
import {
	IMAGE_LOCK,
	assertDigestReference,
	selectRuntimeImage,
	type RuntimeImageLock,
} from "./image-lock.ts";
import { detectHostPlatform } from "./platform.ts";
import { getNetworkProfile } from "./profiles.ts";

export const PACKAGE_VERSION = "1.0.0";

export interface KitOptions {
	config: DockerSandboxConfig;
	services: CredentialService[];
	image?: string;
	sandboxName?: string;
	extraAllow?: string[];
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
	lock: RuntimeImageLock = IMAGE_LOCK,
): Promise<ResolvedKitImage> {
	const host = detectHostPlatform();
	return {
		image: selectRuntimeImage(
			lock,
			config.sandbox.dockerEngine,
			host.runtimePlatform,
		).reference,
	};
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)].sort();
}

export function buildKitSpec(options: KitOptions): PiKitSpec {
	const { config, services } = options;
	const profile = getNetworkProfile(config.profile);
	if (!options.image)
		throw new Error(
			"production runtime image must be resolved before Kit build",
		);
	const image = assertDigestReference(options.image, "sandbox.image");
	const serviceDomains = services.flatMap((service) => service.domains);
	const allow = unique([
		...profile.allow,
		...serviceDomains,
		...config.network.allow,
		...(options.extraAllow ?? []),
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
				"/home/agent/.pi/agent/runtime/pi-docker-sandboxes.mjs",
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
	const agentDirectory = join(directory, "files", "home", ".pi", "agent");
	const runtimeDirectory = join(agentDirectory, "runtime");
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
	await writeFile(
		join(runtimeDirectory, "pi-docker-sandboxes.mjs"),
		await readFile(new URL("../runtime/extension.mjs", import.meta.url)),
		{ flag: "wx", mode: 0o600 },
	);
	if (options.personalization)
		await cp(options.personalization, agentDirectory, {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
}
