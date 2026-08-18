export type RuntimePlatform = "linux/amd64" | "linux/arm64";

export type SupportedHost =
	| { os: "darwin"; arch: "arm64"; runtimePlatform: "linux/arm64" }
	| { os: "linux"; arch: "x64"; runtimePlatform: "linux/amd64" }
	| { os: "linux"; arch: "arm64"; runtimePlatform: "linux/arm64" };

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

export function runtimePlatformForHost(host: SupportedHost): RuntimePlatform {
	return host.runtimePlatform;
}
