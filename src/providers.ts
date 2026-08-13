import type { CredentialService } from "./config.ts";

type AuditedCredentialService = Readonly<CredentialService>;

function frozenService(service: CredentialService): AuditedCredentialService {
	Object.freeze(service.domains);
	return Object.freeze(service);
}

function cloneService(service: AuditedCredentialService): CredentialService {
	return { ...service, domains: [...service.domains] };
}

// Endpoints and headers verified against each provider's primary API documentation on 2026-08-12.
export const BUILTIN_SERVICES = Object.freeze({
	anthropic: frozenService({
		id: "anthropic",
		envVar: "ANTHROPIC_API_KEY",
		domains: ["api.anthropic.com"],
		headerName: "x-api-key",
		valueFormat: "%s",
	}),
	google: frozenService({
		id: "google",
		envVar: "GEMINI_API_KEY",
		domains: ["generativelanguage.googleapis.com"],
		headerName: "x-goog-api-key",
		valueFormat: "%s",
	}),
	openai: frozenService({
		id: "openai",
		envVar: "OPENAI_API_KEY",
		domains: ["api.openai.com"],
		headerName: "Authorization",
		valueFormat: "Bearer %s",
	}),
	openrouter: frozenService({
		id: "openrouter",
		envVar: "OPENROUTER_API_KEY",
		domains: ["openrouter.ai"],
		headerName: "Authorization",
		valueFormat: "Bearer %s",
	}),
	xai: frozenService({
		id: "xai",
		envVar: "XAI_API_KEY",
		domains: ["api.x.ai"],
		headerName: "Authorization",
		valueFormat: "Bearer %s",
	}),
});

const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;

function registry(
	custom: readonly CredentialService[],
): Map<string, AuditedCredentialService> {
	const services = new Map<string, AuditedCredentialService>(
		Object.entries(BUILTIN_SERVICES),
	);
	const customIds = new Set<string>();
	for (const service of custom) {
		if (!SERVICE_ID.test(service.id))
			throw new TypeError(
				`Invalid custom credential service ID: ${service.id}`,
			);
		if (customIds.has(service.id))
			throw new TypeError(`Duplicate custom credential service: ${service.id}`);
		if (services.has(service.id))
			throw new TypeError(
				`Custom credential service shadows built-in service: ${service.id}`,
			);
		if (
			service.domains.length === 0 ||
			service.domains.some(
				(domain) =>
					domain.includes("*") ||
					domain.includes("://") ||
					domain.includes("/") ||
					domain.includes("@") ||
					/[\s\0]/.test(domain),
			)
		)
			throw new TypeError(
				`Custom credential service ${service.id} must use exact domains`,
			);
		customIds.add(service.id);
		services.set(service.id, service as AuditedCredentialService);
	}
	return services;
}

export function resolveAvailableServices(
	proxyIds: readonly string[],
	requestedIds: readonly string[],
	custom: readonly CredentialService[] = [],
): { services: CredentialService[]; unsupported: string[] } {
	const audited = registry(custom);
	const proxied = new Set(proxyIds.filter((id) => SERVICE_ID.test(id)));
	const services: CredentialService[] = [];
	const unsupported: string[] = [];
	for (const id of requestedIds) {
		const service = audited.get(id);
		if (!SERVICE_ID.test(id) || !proxied.has(id) || !service) {
			unsupported.push(id);
			continue;
		}
		services.push(cloneService(service));
	}
	return { services, unsupported };
}
