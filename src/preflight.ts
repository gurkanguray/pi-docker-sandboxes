import type { CredentialService } from "./config.ts";

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
