import type { SecurityProfile } from "./config.ts";

export interface NetworkProfile {
	name: SecurityProfile;
	allow: string[];
	deny: string[];
}

export const NETWORK_PROFILES: Readonly<
	Record<SecurityProfile, NetworkProfile>
> = Object.freeze({
	hardened: {
		name: "hardened",
		allow: [],
		deny: [],
	},
	development: {
		name: "development",
		allow: [
			"registry.npmjs.org",
			"github.com",
			"api.github.com",
			"raw.githubusercontent.com",
			"objects.githubusercontent.com",
			"api.openai.com",
			"chatgpt.com",
			"api.x.ai",
			"openrouter.ai",
		],
		deny: [],
	},
});

export function getNetworkProfile(name: SecurityProfile): NetworkProfile {
	return structuredClone(NETWORK_PROFILES[name]);
}
