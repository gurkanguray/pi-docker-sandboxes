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
		],
		deny: [],
	},
	research: {
		name: "research",
		allow: [
			"registry.npmjs.org",
			"github.com",
			"api.github.com",
			"raw.githubusercontent.com",
			"objects.githubusercontent.com",
			"docs.docker.com",
			"pi.dev",
		],
		deny: [],
	},
	// Browser mode still requires explicit destinations; it never becomes unrestricted implicitly.
	browser: {
		name: "browser",
		allow: ["registry.npmjs.org"],
		deny: [],
	},
});

export function getNetworkProfile(name: SecurityProfile): NetworkProfile {
	return structuredClone(NETWORK_PROFILES[name]);
}
