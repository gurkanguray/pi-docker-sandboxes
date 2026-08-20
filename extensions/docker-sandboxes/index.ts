import { existsSync } from "node:fs";
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
import {
	attestSandbox,
	formatDoctor,
	runDoctor,
	sandboxStatus,
} from "../../src/status.ts";

export function reexecArgumentsForSandbox(
	attested: boolean,
	argv: readonly string[],
) {
	return attested ? undefined : buildReexecArguments(argv);
}

async function runLauncher(args: string[]): Promise<number> {
	const sourceCheckout = existsSync(
		fileURLToPath(new URL("../../.source-checkout", import.meta.url)),
	);
	const cli = fileURLToPath(
		new URL(
			sourceCheckout ? "../../src/cli.ts" : "../../dist/cli.js",
			import.meta.url,
		),
	);
	return runInherited(
		process.execPath,
		[...(sourceCheckout ? ["--experimental-strip-types"] : []), cli, ...args],
		sanitizedHostEnvironment(),
	);
}

export default async function dockerSandboxesExtension(
	pi: ExtensionAPI,
): Promise<void> {
	if (await attestSandbox()) return;
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
	pi.registerFlag("docker-sandbox-session", {
		description: "Resume a managed sandbox Pi session",
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
	pi.registerFlag("docker-sandbox-keep", {
		description: "Keep the Docker Sandbox after exit",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-sandbox-discard-changes", {
		description: "Explicitly discard unexported sandbox changes on exit",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("docker-sandbox-no-host-auth", {
		description: "Do not copy missing host Pi API keys into sbx",
		type: "boolean",
		default: false,
	});

	const reexec = reexecArgumentsForSandbox(false, process.argv.slice(2));
	if (reexec) process.exit(await runLauncher(reexec.launcherArgs));

	pi.registerCommand("docker-sandbox", {
		description: "Docker Sandboxes status, diagnostics, or config",
		getArgumentCompletions: (prefix) =>
			["status", "doctor", "config"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const [command = "status"] = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (command === "status") {
					ctx.ui.notify(sandboxStatus(false), "info");
					return;
				}
				if (command === "doctor") {
					const results = await runDoctor(false, new SbxClient(), ctx.cwd);
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
				throw new Error(`Unknown subcommand: ${command}`);
			} catch (error) {
				ctx.ui.notify(formatError(error), "error");
			}
		},
	});
}
