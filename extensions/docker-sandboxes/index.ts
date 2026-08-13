import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.ts";
import { formatError } from "../../src/errors.ts";
import { sanitizedHostEnvironment } from "../../src/launch.ts";
import { buildReexecArguments } from "../../src/reexec.ts";
import { runInherited, SbxClient } from "../../src/sbx/client.ts";
import { formatDoctor, runDoctor, sandboxStatus } from "../../src/status.ts";
import {
	applyPatch,
	exportPatch,
	inspectRepository,
	loadSandboxState,
	sandboxName,
} from "../../src/workspace.ts";

async function runLauncher(args: string[]): Promise<number> {
	const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
	return runInherited(
		process.execPath,
		["--experimental-strip-types", cli, ...args],
		sanitizedHostEnvironment(),
	);
}

export default async function dockerSandboxesExtension(
	pi: ExtensionAPI,
): Promise<void> {
	pi.registerFlag("docker-sandbox", {
		description: "Run Pi inside Docker Sandboxes",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-sandbox-profile", {
		description: "Docker Sandbox security profile",
		type: "string",
	});
	pi.registerFlag("docker-sandbox-sync", {
		description: "Pi synchronization profile",
		type: "string",
	});
	pi.registerFlag("docker-sandbox-name", {
		description: "Docker Sandbox name",
		type: "string",
	});
	pi.registerFlag("docker-sandbox-fresh", {
		description: "Create a fresh Docker Sandbox",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-sandbox-direct", {
		description: "Use weaker direct host workspace mode",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-sandbox-keep", {
		description: "Keep the Docker Sandbox after exit",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-sandbox-no-sync-back", {
		description: "Do not offer patch export on exit",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-sandbox-discard-changes", {
		description: "Explicitly discard unexported sandbox changes on exit",
		type: "boolean",
		default: false,
	});

	const reexec =
		process.env.PI_DOCKER_SANDBOX_ACTIVE === "1"
			? undefined
			: buildReexecArguments(process.argv.slice(2));
	if (reexec) process.exit(await runLauncher(reexec.launcherArgs));

	pi.registerCommand("docker-sandbox", {
		description:
			"Docker Sandboxes status, diagnostics, config, launch, export, apply, or destroy",
		getArgumentCompletions: (prefix) =>
			["status", "doctor", "config", "launch", "export", "apply", "destroy"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [command = "status", ...rest] = args
				.trim()
				.split(/\s+/)
				.filter(Boolean);
			try {
				if (command === "status") {
					ctx.ui.notify(sandboxStatus(), "info");
					return;
				}
				if (command === "doctor") {
					const results = await runDoctor(new SbxClient(), ctx.cwd);
					ctx.ui.notify(
						formatDoctor(results),
						results.some((result) => result.level === "fail")
							? "error"
							: "info",
					);
					return;
				}
				if (command === "config") {
					const config = await loadConfig(ctx.cwd, {
						projectTrusted: ctx.isProjectTrusted(),
						configDir: CONFIG_DIR_NAME,
					});
					ctx.ui.notify(JSON.stringify(config, null, 2), "info");
					return;
				}
				if (command === "launch") {
					ctx.ui.notify(
						"Exit this Pi session, then run: pi --docker-sandbox",
						"info",
					);
					return;
				}
				const direct =
					process.env.PI_DOCKER_SANDBOX_WORKSPACE_MODE === "direct";
				const repository = direct
					? undefined
					: await inspectRepository(ctx.cwd);
				const name = sandboxName(repository?.root ?? ctx.cwd);
				const state = direct
					? undefined
					: await loadSandboxState(repository!.root, name);
				const client = new SbxClient();
				if (command === "export") {
					const config = await loadConfig(ctx.cwd, {
						projectTrusted: ctx.isProjectTrusted(),
						configDir: CONFIG_DIR_NAME,
					});
					const result = await exportPatch(
						client,
						state!,
						config.export.directory,
					);
					ctx.ui.notify(
						`Saved ${result.path}\n${result.summary.join("\n")}`,
						"info",
					);
					return;
				}
				if (command === "apply") {
					const patch = rest.join(" ");
					if (!patch) throw new Error("Usage: /docker-sandbox apply <patch>");
					if (
						!ctx.hasUI ||
						!(await ctx.ui.confirm("Apply sandbox patch?", patch))
					)
						return;
					await applyPatch(state!, patch);
					ctx.ui.notify(`Applied ${patch}`, "info");
					return;
				}
				if (command === "destroy") {
					if (
						!ctx.hasUI ||
						!(await ctx.ui.confirm(
							"Destroy Docker Sandbox?",
							"Unexported changes will be lost.",
						))
					)
						return;
					const code = await runLauncher([
						"destroy",
						"--name",
						name,
						...(direct ? ["--direct"] : []),
						"--discard-changes",
					]);
					if (code !== 0) throw new Error("Sandbox destroy failed");
					ctx.ui.notify(`Destroyed ${name}`, "info");
					return;
				}
				throw new Error(`Unknown subcommand: ${command}`);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (process.env.PI_DOCKER_SANDBOX_ACTIVE === "1")
			ctx.ui.setStatus("docker-sandboxes", sandboxStatus());
	});
}
