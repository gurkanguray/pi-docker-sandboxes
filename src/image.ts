import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OperationError } from "./errors.ts";

const execFileAsync = promisify(execFile);

interface CommandResult {
	stdout: string;
	stderr: string;
}

export async function runImageCommand(
	command: string,
	args: string[],
	options: { cwd?: string; maxBuffer?: number } = {},
): Promise<CommandResult> {
	try {
		return await execFileAsync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
		});
	} catch (cause) {
		const error = cause as { code?: number; stderr?: string };
		throw new OperationError({
			phase: "prepare",
			operation: `${command} ${args[0] ?? "command"}`,
			exitCode: typeof error.code === "number" ? error.code : undefined,
			detail: error.stderr,
			recovery: ["verify the published production runtime image"],
			cause,
		});
	}
}

export function packageRoot(): string {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

export type ImageCommand = typeof runImageCommand;

export async function packPackage(
	destination: string,
	root = packageRoot(),
	run: ImageCommand = runImageCommand,
): Promise<string> {
	try {
		await access(join(root, ".source-checkout"));
		await run("npm", ["run", "build:cli"], { cwd: root });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const { stdout } = await run("npm", [
		"pack",
		root,
		"--pack-destination",
		destination,
		"--json",
		"--ignore-scripts",
	]);
	let filename: string | undefined;
	try {
		filename = (JSON.parse(stdout) as Array<{ filename?: string }>)[0]
			?.filename;
	} catch (cause) {
		throw new OperationError({
			phase: "prepare",
			operation: "parse npm pack output",
			detail: "npm pack returned malformed JSON",
			recovery: ["npm pack --dry-run"],
			cause,
		});
	}
	if (!filename || basename(filename) !== filename)
		throw new OperationError({
			phase: "prepare",
			operation: "validate npm pack output",
			detail: "npm pack returned an invalid filename",
			recovery: ["npm pack --dry-run"],
		});
	return join(destination, filename);
}

