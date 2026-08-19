import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { CredentialService } from "./config.ts";
import type { SupportedHost } from "./platform.ts";

export interface KvmPreflightOptions {
	statKvm?: () => Promise<{ isCharacterDevice(): boolean }>;
	openKvm?: () => Promise<Pick<FileHandle, "close">>;
}

export async function preflightLinuxKvm(
	host: SupportedHost,
	options: KvmPreflightOptions = {},
): Promise<void> {
	if (host.os !== "linux") return;
	const metadata = await (options.statKvm ?? (() => lstat("/dev/kvm")))();
	if (!metadata.isCharacterDevice())
		throw new Error("/dev/kvm is not a character device");
	const handle = await (
		options.openKvm ??
		(() => open("/dev/kvm", constants.O_RDWR | constants.O_NOFOLLOW))
	)();
	await handle.close();
}

export function providerSetupGuidance(
	services: readonly CredentialService[],
	configured: ReadonlySet<string>,
): string[] {
	if (
		services.length === 0 ||
		services.some((service) => configured.has(service.id))
	)
		return [];
	return [
		"No proxied model credential is configured. Exit Pi, run one of:",
		...services.map((service) => `  sbx secret set ${service.id}`),
		"Then relaunch: pi --docker-sandbox",
		"Sandbox-local /login is unsupported by this package.",
	];
}
