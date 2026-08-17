import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { sanitizeDetail } from "../errors.ts";
import { runInherited, SbxNotInstalledError } from "./inherited-runner.mjs";

export { runInherited, SbxNotInstalledError };

const execFileAsync = promisify(execFile);

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface CommandOptions {
	env?: NodeJS.ProcessEnv;
	input?: string;
	timeoutMs?: number;
}
export type CommandRunner = (
	command: string,
	args: readonly string[],
	options?: CommandOptions,
) => Promise<CommandResult>;
export type InheritedRunner = (
	command: string,
	args: readonly string[],
	env?: NodeJS.ProcessEnv,
) => Promise<number>;

export interface SbxVersion {
	version: string;
	commit?: string;
}
export interface SbxCapabilities {
	clone: boolean;
	noShareSkills: boolean;
	kitValidate: boolean;
	inspectJson: boolean;
	policyCheckNetwork: boolean;
	credentialServices: string[];
}

export type SandboxSummary = Record<string, unknown>;
export type SandboxInspection = Record<string, unknown>;

export interface LaunchRequest {
	name: string;
	workspace: string;
	kit: string;
	agentArgs?: string[];
	env?: NodeJS.ProcessEnv;
}

export interface ExecResult extends CommandResult {}
export interface ExecBytesResult {
	stdout: Buffer;
	stderr: string;
	code: number;
}
export interface PolicyDecision {
	allowed: boolean;
	reason?: string;
	context?: string;
}

export class SbxCommandError extends Error {
	readonly exitCode: number;
	readonly stderr: string;

	constructor(args: readonly string[], exitCode: number, stderr = "") {
		super(`sbx ${args[0] ?? "command"} failed with exit code ${exitCode}`);
		this.name = "SbxCommandError";
		this.exitCode = exitCode;
		this.stderr = sanitizeDetail(stderr);
	}
}

function runPipedCommand(
	command: string,
	args: readonly string[],
	options: CommandOptions,
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, [...args], {
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						child.kill("SIGKILL");
					}, options.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				reject(new SbxNotInstalledError(command));
			else reject(error);
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolve({ stdout, stderr, code: code ?? 1 });
		});
		child.stdin.end(options.input ?? "");
	});
}

async function runCommand(
	command: string,
	args: readonly string[],
	options: CommandOptions = {},
): Promise<CommandResult> {
	if (options.input !== undefined)
		return runPipedCommand(command, args, options);
	try {
		const result = await execFileAsync(command, [...args], {
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
			timeout: options.timeoutMs,
			...(options.env !== undefined ? { env: options.env } : {}),
		});
		return { stdout: result.stdout, stderr: result.stderr, code: 0 };
	} catch (cause) {
		const error = cause as NodeJS.ErrnoException & {
			stdout?: string;
			stderr?: string;
		};
		if (error.code === "ENOENT") throw new SbxNotInstalledError(command);
		return {
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			code: typeof error.code === "number" ? error.code : 1,
		};
	}
}

const SERVICE_ID = /^[a-z0-9][a-z0-9-]*$/;

function parseCredentialServices(output: string): string[] {
	const matches = [...output.matchAll(/^\s*Available services:\s*(.*)$/gm)];
	if (matches.length !== 1 || !matches[0]?.[1]?.trim()) return [];
	const services = matches[0][1].split(",").map((service) => service.trim());
	if (services.some((service) => !SERVICE_ID.test(service))) return [];
	return [...new Set(services)].sort();
}

const NO_SECRETS_OUTPUT =
	"No secrets found. Run 'sbx secret set --help' to see available services.";
const NO_SERVICE_SECRET_OUTPUT =
	/^No secrets found for service "[a-z0-9][a-z0-9-]*"\.$/;

export interface SecretRowPrefix {
	scope: string;
	type: string;
	name: string;
}

export function parseSecretRowPrefix(
	line: string,
): SecretRowPrefix | undefined {
	const match = line.match(/^\s*(\S+)\s+(\S+)\s+(\S+)(?=\s+\S)/);
	if (!match) return undefined;
	const [, scope, type, name] = match;
	return scope && type && name ? { scope, type, name } : undefined;
}

function parseSecretServices(output: string): Set<string> {
	const trimmed = output.trim();
	if (trimmed === NO_SECRETS_OUTPUT || NO_SERVICE_SECRET_OUTPUT.test(trimmed))
		return new Set();
	const lines = trimmed.split(/\r?\n/);
	if (
		lines[0]?.trim().split(/\s+/).join(" ") !== "SCOPE TYPE NAME SECRET" ||
		lines.length < 2
	)
		throw new Error("Unrecognized sbx secret list output");
	const services = new Set<string>();
	for (const line of lines.slice(1)) {
		const prefix = parseSecretRowPrefix(line);
		if (!prefix) throw new Error("Unrecognized sbx secret list output");
		const { scope, type, name } = prefix;
		if (scope !== "(global)" && !SERVICE_ID.test(scope))
			throw new Error("Unrecognized sbx secret list output");
		if (type === "service") {
			if (!SERVICE_ID.test(name))
				throw new Error("Unrecognized sbx secret list output");
			services.add(name);
		} else if (type !== "registry")
			throw new Error("Unrecognized sbx secret list output");
	}
	return services;
}

function parseObject(value: string, command: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error(`sbx ${command} returned invalid JSON`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`sbx ${command} returned an unexpected JSON shape`);
	return parsed as Record<string, unknown>;
}

export function validateSandboxName(name: string): void {
	if (name.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(name))
		throw new TypeError(`Invalid Docker Sandbox name: ${JSON.stringify(name)}`);
}

function validatePath(path: string, label: string): void {
	if (
		!path ||
		path.includes("\0") ||
		path.includes("\n") ||
		path.includes("\r")
	)
		throw new TypeError(`Invalid ${label}`);
}

export class SbxClient {
	readonly executable: string;
	private readonly runner: CommandRunner;
	private readonly inheritedRunner: InheritedRunner;

	constructor(
		executable = "sbx",
		runner: CommandRunner = runCommand,
		inheritedRunner: InheritedRunner = runInherited,
	) {
		this.executable = executable;
		this.runner = runner;
		this.inheritedRunner = inheritedRunner;
	}

	private async execute(
		args: readonly string[],
		allowFailure = false,
		options?: CommandOptions,
	): Promise<CommandResult> {
		const result = await this.runner(this.executable, args, options);
		if (!allowFailure && result.code !== 0)
			throw new SbxCommandError(args, result.code, result.stderr);
		return result;
	}

	private async acceptsFlag(
		args: readonly string[],
		flag: string,
	): Promise<boolean> {
		const result = await this.execute(args, true);
		const output = `${result.stdout}\n${result.stderr}`;
		return (
			result.code === 0 ||
			(output.trim().length > 0 && !output.includes(`unknown flag: --${flag}`))
		);
	}

	async version(): Promise<SbxVersion> {
		const { stdout } = await this.execute(["version"]);
		const match = stdout.match(
			/sbx version:\s*v?(\d+\.\d+\.\d+)(?:\s+([0-9a-f]+))?/i,
		);
		if (!match?.[1]) throw new Error("Unrecognized sbx version output");
		return { version: match[1], ...(match[2] ? { commit: match[2] } : {}) };
	}

	async list(): Promise<SandboxSummary[]> {
		const { stdout } = await this.execute(["list", "--json"]);
		const parsed = parseObject(stdout, "list");
		if (!Array.isArray(parsed.sandboxes))
			throw new Error("sbx list returned no sandboxes array");
		return parsed.sandboxes as SandboxSummary[];
	}

	async inspect(name: string): Promise<SandboxInspection> {
		validateSandboxName(name);
		const { stdout } = await this.execute(["inspect", name, "--json"]);
		return parseObject(stdout, "inspect");
	}

	async exists(name: string): Promise<boolean> {
		validateSandboxName(name);
		return (await this.list()).some((sandbox) => sandbox.name === name);
	}

	async capabilities(): Promise<SbxCapabilities> {
		const [create, kit, inspect, policy, noShareSkills, credentialServices] =
			await Promise.all([
				this.execute(["create", "--help"]),
				this.execute(["kit", "--help"]),
				this.execute(["inspect", "--help"]),
				this.execute(["policy", "check", "network", "--help"]),
				this.acceptsFlag(["create", "--no-share-skills"], "no-share-skills"),
				this.credentialServices(),
			]);
		return {
			clone: create.stdout.includes("--clone"),
			// sbx 0.38 accepts this security flag but omits it from --help.
			noShareSkills:
				create.stdout.includes("--no-share-skills") || noShareSkills,
			kitValidate: kit.stdout.includes("validate"),
			inspectJson: inspect.stdout.includes("--json"),
			policyCheckNetwork: policy.stdout.includes("policy check network"),
			credentialServices,
		};
	}

	async credentialServices(): Promise<string[]> {
		const result = await this.execute(["secret", "set", "--help"], true);
		if (result.code !== 0) return [];
		return parseCredentialServices(`${result.stdout}\n${result.stderr}`);
	}

	async secretServices(): Promise<Set<string>> {
		const { stdout } = await this.execute(["secret", "ls"]);
		try {
			return parseSecretServices(stdout);
		} catch {
			throw new Error("Unrecognized sbx secret list output");
		}
	}

	async setSecret(
		id: string,
		value: string,
		timeoutMs = 15_000,
	): Promise<void> {
		if (!SERVICE_ID.test(id)) throw new TypeError(`Invalid credential service: ${id}`);
		if (!value || /[\0\r\n]/.test(value) || value.trim() !== value)
			throw new TypeError("Invalid secret value");
		await this.execute(["secret", "set", id], false, {
			input: `${value}\n`,
			timeoutMs,
		});
	}

	createArgs(request: LaunchRequest): string[] {
		validateSandboxName(request.name);
		validatePath(request.workspace, "workspace path");
		validatePath(request.kit, "Kit path");
		const args = [
			"create",
			"--name",
			request.name,
			"--kit",
			request.kit,
			"--clone",
			"--no-share-skills",
			"pi-docker-sandboxes",
			request.workspace,
		];
		return args;
	}

	attachArgs(request: LaunchRequest): string[] {
		validateSandboxName(request.name);
		const args = ["run", "--name", request.name];
		if (request.agentArgs?.length) args.push("--", ...request.agentArgs);
		return args;
	}

	async create(request: LaunchRequest): Promise<void> {
		await this.execute(this.createArgs(request), false, {
			env: request.env ?? {},
		});
	}

	async attach(request: LaunchRequest): Promise<number> {
		return this.inheritedRunner(
			this.executable,
			this.attachArgs(request),
			request.env ?? {},
		);
	}

	private execArgs(
		name: string,
		argv: readonly string[],
		options: { workdir?: string; env?: Record<string, string>; user?: string },
	): string[] {
		validateSandboxName(name);
		if (argv.length === 0 || argv.some((arg) => arg.includes("\0")))
			throw new TypeError("Invalid sandbox command argv");
		const args = ["exec"] as string[];
		if (options.workdir) {
			validatePath(options.workdir, "workdir");
			args.push("--workdir", options.workdir);
		}
		for (const [key, value] of Object.entries(options.env ?? {})) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"))
				throw new TypeError("Invalid sandbox environment entry");
			args.push("--env", `${key}=${value}`);
		}
		if (options.user) {
			if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*(:[A-Za-z0-9._][A-Za-z0-9._-]*)?$/.test(options.user))
				throw new TypeError("Invalid sandbox user");
			args.push("-u", options.user);
		}
		args.push(name, ...argv);
		return args;
	}

	async exec(
		name: string,
		argv: readonly string[],
		options: { workdir?: string; env?: Record<string, string>; user?: string } = {},
	): Promise<ExecResult> {
		return this.execute(this.execArgs(name, argv, options));
	}

	async execBytes(
		name: string,
		argv: readonly string[],
		options: {
			workdir?: string;
			env?: Record<string, string>;
			maxBuffer?: number;
		} = {},
	): Promise<ExecBytesResult> {
		const args = this.execArgs(name, argv, options);
		try {
			const result = await execFileAsync(this.executable, args, {
				encoding: "buffer",
				maxBuffer: options.maxBuffer,
			});
			return {
				stdout: result.stdout,
				stderr: result.stderr.toString("utf8"),
				code: 0,
			};
		} catch (cause) {
			const error = cause as NodeJS.ErrnoException & {
				stdout?: Buffer;
				stderr?: Buffer;
			};
			if (error.code === "ENOENT")
				throw new SbxNotInstalledError(this.executable);
			if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
				throw new Error("sandbox command output exceeded the allowed size", {
					cause,
				});
			throw new SbxCommandError(
				args,
				typeof error.code === "number" ? error.code : 1,
				error.stderr?.toString("utf8") ??
					"sandbox command output exceeded the allowed size",
			);
		}
	}

	async validateKit(path: string): Promise<void> {
		validatePath(path, "Kit path");
		await this.execute(["kit", "validate", path]);
	}
	async policyCheckNetwork(
		target: string,
		sandbox?: string,
	): Promise<PolicyDecision> {
		if (/\s|\0/.test(target))
			throw new TypeError("Invalid network policy target");
		const args = ["policy", "check", "network", "--json"] as string[];
		if (sandbox) {
			validateSandboxName(sandbox);
			args.push("--sandbox", sandbox);
		}
		args.push(target);
		const result = await this.execute(args, true);
		const parsed = parseObject(result.stdout, "policy check network");
		if (typeof parsed.allowed !== "boolean")
			throw new Error("sbx policy check returned no allowed decision");
		return {
			allowed: parsed.allowed,
			...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
			...(typeof parsed.context === "string"
				? { context: parsed.context }
				: {}),
		};
	}

	async remove(name: string, force = false): Promise<void> {
		validateSandboxName(name);
		await this.execute(["rm", ...(force ? ["--force"] : []), name]);
	}
	async copyFrom(
		name: string,
		source: string,
		destination: string,
	): Promise<void> {
		validateSandboxName(name);
		validatePath(source, "sandbox source path");
		validatePath(destination, "host destination path");
		await this.execute(["cp", `${name}:${source}`, destination]);
	}
	async copyTo(
		name: string,
		source: string,
		destination: string,
	): Promise<void> {
		validateSandboxName(name);
		validatePath(source, "host source path");
		validatePath(destination, "sandbox destination path");
		await this.execute(["cp", source, `${name}:${destination}`]);
	}
}
