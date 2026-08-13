import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
	loadConfig,
	type ConfigOverride,
	type SecurityProfile,
	type SyncProfile,
} from "./config.ts";
import { decideDisposition } from "./disposition.ts";
import { formatError, OperationError } from "./errors.ts";
import { buildLocalImage } from "./image.ts";
import { launch } from "./launch.ts";
import { SbxClient } from "./sbx/client.ts";
import { formatDoctor, runDoctor, sandboxStatus } from "./status.ts";
import {
	applyPatch,
	exportPatch,
	inspectRepository,
	loadSandboxState,
	removeSandboxState,
	sandboxName,
	statePath,
} from "./workspace.ts";

async function confirm(question: string): Promise<boolean> {
	if (!stdin.isTTY || !stdout.isTTY) return false;
	const reader = createInterface({ input: stdin, output: stdout });
	try {
		return /^y(?:es)?$/i.test(
			(await reader.question(`${question} [y/N] `)).trim(),
		);
	} finally {
		reader.close();
	}
}

function booleanOption(args: string[], name: string): boolean {
	const matches = args.flatMap((value, index) => {
		if (value === name) return [{ index, enabled: true }];
		if (!value.startsWith(`${name}=`)) return [];
		const inline = value.slice(name.length + 1);
		if (inline !== "true" && inline !== "false")
			throw new TypeError(`${name} requires a boolean true or false value`);
		return [{ index, enabled: inline === "true" }];
	});
	if (matches.length > 1) throw new TypeError(`${name} may be set only once`);
	if (matches[0]) args.splice(matches[0].index, 1);
	return matches[0]?.enabled ?? false;
}

function take(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--"))
		throw new TypeError(`${flag} requires a value`);
	args.splice(index, 2);
	return value;
}

interface ParsedRun {
	override: ConfigOverride;
	fresh: boolean;
	noSyncBack: boolean;
	discardChanges: boolean;
	yes: boolean;
	trustProjectConfig: boolean;
	cwd: string;
	piArgs: string[];
}

export function parseRunArgs(input: readonly string[]): ParsedRun {
	const args = [...input];
	const override: ConfigOverride = {};
	let fresh = false;
	let noSyncBack = false;
	let discardChanges = false;
	let yes = false;
	let trustProjectConfig = false;
	let cwd = process.cwd();
	const separator = args.indexOf("--");
	const piArgs = separator >= 0 ? args.splice(separator + 1) : [];
	if (separator >= 0) args.splice(separator, 1);
	for (let index = 0; index < args.length; ) {
		const flag = args[index]!;
		if (flag === "--profile") {
			override.profile = take(args, index, flag) as SecurityProfile;
			continue;
		}
		if (flag === "--sync") {
			override.syncProfile = take(args, index, flag) as SyncProfile;
			continue;
		}
		if (flag === "--name") {
			override.sandbox = { ...override.sandbox, name: take(args, index, flag) };
			continue;
		}
		if (flag === "--image") {
			override.sandbox = {
				...override.sandbox,
				image: take(args, index, flag),
			};
			continue;
		}
		if (flag === "--cwd") {
			cwd = resolve(take(args, index, flag));
			continue;
		}
		if (flag === "--direct") {
			override.workspaceMode = "direct";
			args.splice(index, 1);
			continue;
		}
		if (flag === "--share-skills") {
			override.shareSkills = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--fresh") {
			fresh = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--keep") {
			override.sandbox = { ...override.sandbox, keep: true };
			args.splice(index, 1);
			continue;
		}
		if (flag === "--no-sync-back") {
			noSyncBack = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--discard-changes") {
			discardChanges = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--yes") {
			yes = true;
			args.splice(index, 1);
			continue;
		}
		if (flag === "--trust-project-config") {
			trustProjectConfig = true;
			args.splice(index, 1);
			continue;
		}
		throw new TypeError(`Unknown run option: ${flag}`);
	}
	return {
		override,
		fresh,
		noSyncBack,
		discardChanges,
		yes,
		trustProjectConfig,
		cwd,
		piArgs,
	};
}

export function createWarningReporter(
	write: (message: string) => void = console.error,
): {
	onWarning(warning: string): void;
	reportRemaining(warnings: readonly string[]): void;
} {
	const delivered = new Set<string>();
	return {
		onWarning(warning) {
			delivered.add(warning);
			write(`! ${warning}`);
		},
		reportRemaining(warnings) {
			for (const warning of warnings)
				if (!delivered.has(warning)) write(`! ${warning}`);
		},
	};
}

function usage(): string {
	return `pi-dsbx - run Pi inside Docker Sandboxes\n\nUsage:\n  pi-dsbx run [options] [-- PI_ARGS...]\n  pi-dsbx status\n  pi-dsbx doctor\n  pi-dsbx config\n  pi-dsbx export [--name NAME]\n  pi-dsbx apply PATCH [--name NAME] --yes\n  pi-dsbx destroy [--name NAME] [--direct] [--yes] [--discard-changes]\n  pi-dsbx image build\n\nRun options: --profile NAME --sync NAME --name NAME --image REF --direct --share-skills --fresh --keep --no-sync-back --discard-changes --trust-project-config --yes --cwd PATH\nDestroy options: --direct selects state-less direct mode; --yes approves clean clone removal only; --discard-changes explicitly authorizes changed/unknown removal`;
}

function option(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	return take(args, index, name);
}

export async function main(
	argv = process.argv.slice(2),
	dependencies: { removeState?: (path: string) => Promise<void> } = {},
): Promise<number> {
	const [command = "run", ...args] = argv;
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(usage());
		return 0;
	}
	if (command === "run") {
		const parsed = parseRunArgs(args);
		const warningReporter = createWarningReporter();
		const result = await launch({
			cwd: parsed.cwd,
			config: parsed.override,
			fresh: parsed.fresh,
			noSyncBack: parsed.noSyncBack,
			discardChanges: parsed.discardChanges,
			yes: parsed.yes,
			projectTrusted: parsed.trustProjectConfig,
			piArgs: parsed.piArgs,
			confirm,
			confirmResourceCopy: confirm,
			onWarning: warningReporter.onWarning,
			confirmInitialCommit: (root) =>
				confirm(
					`Clone mode needs an initial commit. Create an empty commit in ${root}?`,
				),
		});
		warningReporter.reportRemaining(result.warnings);
		return result.exitCode;
	}
	const cwd = process.cwd();
	const client = new SbxClient();
	if (command === "status") {
		console.log(sandboxStatus());
		if (process.env.PI_DOCKER_SANDBOX_ACTIVE !== "1")
			console.log(JSON.stringify(await client.list(), null, 2));
		return 0;
	}
	if (command === "doctor") {
		const results = await runDoctor(client, cwd);
		console.log(formatDoctor(results));
		return results.some((result) => result.level === "fail") ? 1 : 0;
	}
	if (command === "config") {
		console.log(JSON.stringify(await loadConfig(cwd), null, 2));
		return 0;
	}
	if (command === "image" && args[0] === "build") {
		const result = await buildLocalImage({ keepBuildDirectory: true });
		console.log(
			`Built and verified ${result.verifiedImage}\nLoaded ${result.image}\nArtifacts: ${result.buildDirectory}`,
		);
		return 0;
	}
	if (command === "export" || command === "apply" || command === "destroy") {
		const direct = booleanOption(args, "--direct");
		if (direct && command !== "destroy")
			throw new TypeError("--direct is only valid for destroy");
		const root = resolve(cwd);
		const repository = direct ? undefined : await inspectRepository(root);
		const name =
			option(args, "--name") ?? sandboxName(repository?.root ?? root);
		const yes = booleanOption(args, "--yes");
		const discardChanges = booleanOption(args, "--discard-changes");
		if (discardChanges && command !== "destroy")
			throw new TypeError("--discard-changes is only valid for destroy");
		const state = direct
			? undefined
			: await loadSandboxState(repository!.root, name);
		if (command === "export") {
			const config = await loadConfig(cwd);
			const result = await exportPatch(client, state!, config.export.directory);
			console.log(`${result.path}\n${result.summary.join("\n")}`);
			return 0;
		}
		if (command === "apply") {
			const patch = args.shift();
			if (!patch) throw new TypeError("apply requires a patch path");
			if (!yes && !(await confirm(`Apply ${patch} to the host working tree?`)))
				throw new Error("Patch apply cancelled");
			await applyPatch(state!, resolve(patch));
			console.log(`Applied ${patch}`);
			return 0;
		}
		const dirty = direct
			? undefined
			: (
					await client.exec(name, ["git", "status", "--porcelain=v1"], {
						workdir: state!.hostRoot,
					})
				).stdout.trim().length > 0;
		let discardAuthorized = discardChanges;
		if ((direct || dirty) && !discardAuthorized)
			discardAuthorized = await confirm(
				direct
					? "Direct sandbox changes are already on the host. Destroy sandbox permanently?"
					: "Sandbox has unexported changes. Destroy and discard them permanently?",
			);
		if (
			dirty === false &&
			!yes &&
			!(await confirm("Destroy sandbox permanently?"))
		)
			throw new Error("Destroy cancelled");
		const disposition = decideDisposition({
			keep: false,
			changes: direct ? "unknown" : dirty ? "changed" : "clean",
			exportRequested: false,
			exportSucceeded: false,
			discardAuthorized,
		});
		if (disposition.action !== "remove")
			throw new Error(
				"Destroy cancelled; use --discard-changes to authorize noninteractive dirty removal",
			);
		await client.remove(name, true);
		try {
			await removeSandboxState(
				repository?.root ?? root,
				name,
				dependencies.removeState,
			);
		} catch (cause) {
			throw new OperationError({
				phase: "remove-or-keep",
				operation: "remove stale sandbox state",
				detail: `Sandbox ${name} is gone but stale state requires inspection; automatic removal was refused`,
				recovery: [
					`Inspect ${statePath(repository?.root ?? root, name)} and its parent directory manually`,
				],
				cause,
			});
		}
		console.log(`Destroyed ${name}`);
		return 0;
	}
	throw new TypeError(`Unknown command: ${command}\n${usage()}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(`Error: ${formatError(error)}`);
			process.exitCode = 1;
		});
}
