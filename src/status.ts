import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { loadConfig } from "./config.ts";
import { resolveAvailableServices } from "./providers.ts";
import {
	SbxClient,
	SbxNotInstalledError,
	type SbxCapabilities,
} from "./sbx/client.ts";
import { inspectRepository } from "./workspace.ts";

const execFileAsync = promisify(execFile);
export const TESTED_SBX_VERSION = /^0\.38\./;

export interface DoctorResult {
	level: "pass" | "warning" | "fail";
	message: string;
}

export function isSandboxAttested(
	env: NodeJS.ProcessEnv,
	mountInfo: string,
): boolean {
	if (env.PI_DOCKER_SANDBOX_ACTIVE !== "1") return false;
	return mountInfo.split("\n").some((line) => {
		const fields = line.split(" ");
		return (
			fields[4] === "/run/sandbox/source" &&
			fields[5]?.split(",").includes("ro") === true
		);
	});
}

export async function attestSandbox(
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	if (env.PI_DOCKER_SANDBOX_ACTIVE !== "1") return false;
	try {
		return isSandboxAttested(
			env,
			await readFile("/proc/self/mountinfo", "utf8"),
		);
	} catch {
		return false;
	}
}

export function sandboxStatus(
	attested: boolean,
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (!attested) return "Docker SBX: host";
	const profile = env.PI_DOCKER_SANDBOX_PROFILE ?? "unknown";
	return `SBX: clone · ${profile}`;
}

function capabilityChecks(capabilities: SbxCapabilities): DoctorResult[] {
	const results = [
		["clone mode", capabilities.clone],
		["--no-share-skills", capabilities.noShareSkills],
		["kit validation", capabilities.kitValidate],
		["inspect JSON", capabilities.inspectJson],
		["network policy check", capabilities.policyCheckNetwork],
	].map(([name, supported]) => ({
		level: supported ? "pass" : "fail",
		message: `${name}: ${supported ? "available" : "unavailable"}`,
	})) as DoctorResult[];
	results.push(
		capabilities.credentialServices.length > 0
			? {
					level: "pass",
					message: `credential proxy services: ${capabilities.credentialServices.join(", ")}`,
				}
			: {
					level: "warning",
					message:
						"credential proxy service discovery unavailable; provider support cannot be determined",
				},
	);
	return results;
}

async function sandboxDoctor(): Promise<DoctorResult[]> {
	const results: DoctorResult[] = [
		{
			level: "pass",
			message: "sandbox sentinel present (not an attestation by itself)",
		},
		{
			level: "pass",
			message: "workspace mode: clone",
		},
		{
			level: "pass",
			message: `security profile: ${process.env.PI_DOCKER_SANDBOX_PROFILE ?? "unknown"}`,
		},
		{
			level: "pass",
			message: `package version: ${process.env.PI_DOCKER_SANDBOX_PACKAGE_VERSION ?? "unknown"}`,
		},
	];
	try {
		await access("/run/sandbox/source");
		const mounts = await readFile("/proc/self/mountinfo", "utf8");
		const source = mounts
			.split("\n")
			.find((line) => line.includes(" /run/sandbox/source "));
		results.push({
			level: source && /\sro(?:,|\s)/.test(source) ? "pass" : "fail",
			message:
				source && /\sro(?:,|\s)/.test(source)
					? "host source mount is read-only"
					: "host source mount is not proven read-only",
		});
		results.push({
			level: /skill/i.test(mounts) ? "warning" : "pass",
			message: /skill/i.test(mounts)
				? "shared skills-like mount detected"
				: "no shared skills mount detected",
		});
	} catch {
		results.push({
			level: "warning",
			message: "Docker Sandbox source mount not detected",
		});
	}
	for (const directory of [
		"/home/agent/.ssh",
		"/home/agent/.aws",
		"/home/agent/.config/gcloud",
	]) {
		try {
			await access(directory);
			results.push({
				level: "fail",
				message: `host credential directory visible: ${directory}`,
			});
		} catch {
			results.push({
				level: "pass",
				message: `credential directory absent: ${directory}`,
			});
		}
	}
	try {
		const docker = await execFileAsync(
			"docker",
			["info", "--format", "{{.ID}}"],
			{ encoding: "utf8" },
		);
		results.push({
			level: docker.stdout.trim() ? "pass" : "fail",
			message: docker.stdout.trim()
				? "private Docker daemon responds"
				: "Docker daemon identity missing",
		});
	} catch {
		results.push({
			level: "warning",
			message: "private Docker daemon unavailable",
		});
	}
	try {
		await access("/home/agent/.pi/agent/auth.json");
		results.push({
			level: "warning",
			message: "sandbox-local auth.json exists; VM processes can read it",
		});
	} catch {
		results.push({
			level: "pass",
			message: "no sandbox-local auth.json detected",
		});
	}
	const rawSecrets = Object.keys(process.env).filter(
		(key) =>
			/(?:API_KEY|ACCESS_TOKEN|SECRET_ACCESS_KEY)$/.test(key) &&
			process.env[key] &&
			!/proxy|sentinel|sbx/i.test(process.env[key]!),
	);
	results.push({
		level: rawSecrets.length ? "fail" : "pass",
		message: rawSecrets.length
			? `raw credential-like environment variables detected: ${rawSecrets.join(", ")}`
			: "no raw credential-like environment values detected",
	});
	return results;
}

export async function runDoctor(
	attested: boolean,
	client = new SbxClient(),
	cwd = process.cwd(),
): Promise<DoctorResult[]> {
	if (attested) return sandboxDoctor();
	const results: DoctorResult[] = [];
	let capabilities: SbxCapabilities;
	try {
		const version = await client.version();
		results.push({ level: "pass", message: `sbx ${version.version}` });
		if (!TESTED_SBX_VERSION.test(version.version))
			results.push({
				level: "warning",
				message: `sbx ${version.version} is outside the tested 0.38.x line`,
			});
		capabilities = await client.capabilities();
		results.push(...capabilityChecks(capabilities));
		await client.list();
		results.push({ level: "pass", message: "sandbox daemon responds" });
	} catch (error) {
		return [
			{
				level: "fail",
				message:
					error instanceof SbxNotInstalledError
						? error.message
						: `sbx unavailable: ${(error as Error).message}`,
			},
		];
	}

	try {
		const config = await loadConfig(cwd);
		results.push({
			level: "pass",
			message: `security profile: ${config.profile}`,
		});
		const resolved = resolveAvailableServices(
			capabilities!.credentialServices,
			config.providers,
		);
		for (const id of resolved.unsupported)
			results.push({
				level: "warning",
				message: `credential service ${id}: not both audited and proxy-supported`,
			});
		const configured =
			resolved.services.length > 0
				? await client.secretServices()
				: new Set<string>();
		for (const service of resolved.services) {
			results.push({
				level: configured.has(service.id) ? "pass" : "warning",
				message: `credential service ${service.id}: ${configured.has(service.id) ? "configured" : "not configured"}`,
			});
		}
	} catch (error) {
		results.push({
			level: "fail",
			message: `configuration: ${(error as Error).message}`,
		});
	}

	try {
		const repository = await inspectRepository(cwd);
		results.push({
			level: "pass",
			message: `Git repository: ${repository.branch}@${repository.head.slice(0, 12)}`,
		});
		results.push({
			level: repository.mainWorktree ? "pass" : "fail",
			message: repository.mainWorktree
				? "clone mode eligible: main worktree"
				: "clone mode ineligible: secondary worktree",
		});
		if (repository.dirty)
			results.push({
				level: "warning",
				message:
					"host working tree has uncommitted changes (clone still protects host writes)",
			});
	} catch {
		results.push({
			level: "warning",
			message: "workspace is not clone-mode eligible Git repository",
		});
	}

	return results;
}

export function formatDoctor(results: DoctorResult[]): string {
	const marker = { pass: "✓", warning: "!", fail: "✗" } as const;
	return results
		.map((result) => `${marker[result.level]} ${result.message}`)
		.join("\n");
}
