import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

export type RuntimePlatform = "linux/amd64" | "linux/arm64";

export type SupportedHost =
	| { os: "darwin"; arch: "arm64"; runtimePlatform: "linux/arm64" }
	| { os: "linux"; arch: "x64"; runtimePlatform: "linux/amd64" }
	| { os: "linux"; arch: "arm64"; runtimePlatform: "linux/arm64" };

export interface HostVersionProbe {
	macosVersion(): Promise<string>;
	linuxOsRelease(): Promise<{ id: string; versionId: string }>;
}

const execFileAsync = promisify(execFile);

function osReleaseValue(contents: string, name: string): string {
	const prefix = `${name}=`;
	const line = contents.split("\n").find((entry) => entry.startsWith(prefix));
	if (!line) throw new Error(`/etc/os-release is missing ${name}`);
	const value = line.slice(prefix.length);
	const quote = value[0];
	if ((quote === '"' || quote === "'") && value.at(-1) === quote)
		return value.slice(1, -1);
	return value;
}

const DEFAULT_VERSION_PROBE: HostVersionProbe = {
	async macosVersion() {
		return (
			await execFileAsync("sw_vers", ["-productVersion"], {
				encoding: "utf8",
			})
		).stdout.trim();
	},
	async linuxOsRelease() {
		const contents = await readFile("/etc/os-release", "utf8");
		return {
			id: osReleaseValue(contents, "ID").toLowerCase(),
			versionId: osReleaseValue(contents, "VERSION_ID"),
		};
	},
};

function versionAtLeast(
	value: string,
	minimumMajor: number,
	minimumMinor = 0,
): boolean {
	const match = value.match(/^(\d+)(?:\.(\d+))?(?:\.\d+)*$/);
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2] ?? 0);
	return major > minimumMajor || (major === minimumMajor && minor >= minimumMinor);
}

export function detectHostPlatform(
	os: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): SupportedHost {
	if (os === "darwin" && arch === "arm64")
		return { os, arch, runtimePlatform: "linux/arm64" };
	if (os === "linux" && arch === "x64")
		return { os, arch, runtimePlatform: "linux/amd64" };
	if (os === "linux" && arch === "arm64")
		return { os, arch, runtimePlatform: "linux/arm64" };
	throw new Error(`${os}/${arch} host support is not certified`);
}

export async function certifyHostPlatform(
	host: SupportedHost = detectHostPlatform(),
	probe: HostVersionProbe = DEFAULT_VERSION_PROBE,
): Promise<SupportedHost> {
	if (host.os === "darwin") {
		const version = await probe.macosVersion();
		if (!versionAtLeast(version, 14))
			throw new Error(
				`macOS 14 or newer is required; detected ${version || "unknown"}`,
			);
		return host;
	}
	const release = await probe.linuxOsRelease();
	if (
		release.id !== "ubuntu" ||
		!versionAtLeast(release.versionId, 24, 4)
	)
		throw new Error(
			`Ubuntu 24.04 or newer is required; detected ${release.id || "unknown"} ${release.versionId || "unknown"}`,
		);
	return host;
}

export function runtimePlatformForHost(host: SupportedHost): RuntimePlatform {
	return host.runtimePlatform;
}
