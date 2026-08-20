import { readFile } from "node:fs/promises";

const SOURCE_MOUNT = "/run/sandbox/source";

export function isSandboxAttested(env, mountInfo) {
	if (env.PI_DOCKER_SANDBOX_ACTIVE !== "1") return false;
	return mountInfo.split("\n").some((line) => {
		const fields = line.split(" ");
		return (
			fields[4] === SOURCE_MOUNT &&
			fields[5]?.split(",").includes("ro") === true
		);
	});
}

export function sandboxStatus(env) {
	return `SBX: clone · ${env.PI_DOCKER_SANDBOX_PROFILE ?? "unknown"}`;
}

export function sandboxDiagnostics(env, mountInfo) {
	if (!isSandboxAttested(env, mountInfo))
		return [{ level: "fail", message: "sandbox attestation failed" }];
	return [
		{ level: "pass", message: "sandbox attestation verified" },
		{ level: "pass", message: "host source mount is read-only" },
		{
			level: env.PI_DOCKER_SANDBOX_PROFILE ? "pass" : "warning",
			message: `security profile: ${env.PI_DOCKER_SANDBOX_PROFILE ?? "unknown"}`,
		},
	];
}

function formatDiagnostics(results) {
	const marker = { pass: "✓", warning: "!", fail: "✗" };
	return results
		.map((result) => `${marker[result.level]} ${result.message}`)
		.join("\n");
}

function report(message, level, context) {
	if (context.mode === "print") process.stdout.write(`${message}\n`);
	else context.ui.notify(message, level);
}

export async function registerSandboxRuntime(pi, context) {
	const { env, mountInfo } = context;
	if (!isSandboxAttested(env, mountInfo)) return;
	const status = sandboxStatus(env);
	pi.registerCommand("docker-sandbox", {
		description: "Docker Sandbox status and diagnostics",
		getArgumentCompletions: (prefix) =>
			["status", "doctor"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [command = "status"] = args.trim().split(/\s+/).filter(Boolean);
			if (command === "status") {
				report(status, "info", ctx);
				return;
			}
			if (command === "doctor") {
				const results = sandboxDiagnostics(env, mountInfo);
				report(
					formatDiagnostics(results),
					results.some((result) => result.level === "fail") ? "error" : "info",
					ctx,
				);
				return;
			}
			report(`Unknown subcommand: ${command}`, "error", ctx);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("docker-sandboxes", status);
	});
}

export default async function sandboxRuntimeExtension(
	pi,
	{
		env = process.env,
		readMountInfo = () => readFile("/proc/self/mountinfo", "utf8"),
	} = {},
) {
	let mountInfo = "";
	try {
		mountInfo = await readMountInfo();
	} catch {
		// Missing evidence is intentionally treated as failed attestation.
	}
	await registerSandboxRuntime(pi, { env, mountInfo });
}
