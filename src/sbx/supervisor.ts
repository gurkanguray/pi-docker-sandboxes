import { spawn } from "node:child_process";
import { constants } from "node:os";

export interface CommandPolicy {
	timeoutMs: number;
	killGraceMs: number;
	signal?: AbortSignal;
}

export interface SupervisedCommandOptions {
	policy: CommandPolicy;
	env?: NodeJS.ProcessEnv;
	input?: string | Buffer;
	/** Combined stdout/stderr byte limit; zero permits no output. */
	maxBuffer?: number;
}

export interface SupervisedCommandResult {
	stdout: Buffer;
	stderr: Buffer;
	code: number;
}

export class CommandTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(command: string, timeoutMs: number) {
		super(`${command} timed out after ${timeoutMs}ms`);
		this.name = "CommandTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export class CommandCancelledError extends Error {
	constructor(command: string) {
		super(`${command} was cancelled`);
		this.name = "CommandCancelledError";
	}
}

export class CommandOutputLimitError extends Error {
	constructor(command: string) {
		super(`${command} output exceeded the allowed size`);
		this.name = "CommandOutputLimitError";
	}
}

function positive(value: number, name: string): void {
	if (!Number.isFinite(value) || value <= 0)
		throw new TypeError(`${name} must be a positive finite number`);
}

function nonnegative(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0)
		throw new TypeError(`${name} must be a nonnegative finite number`);
}

/** Run a bounded non-interactive command and reap its POSIX process group. */
export function superviseCommand(
	command: string,
	args: readonly string[],
	options: SupervisedCommandOptions,
): Promise<SupervisedCommandResult> {
	positive(options.policy.timeoutMs, "timeoutMs");
	positive(options.policy.killGraceMs, "killGraceMs");
	if (options.maxBuffer !== undefined)
		nonnegative(options.maxBuffer, "maxBuffer");
	if (options.policy.signal?.aborted)
		return Promise.reject(new CommandCancelledError(command));

	return new Promise((resolve, reject) => {
		const posix = process.platform !== "win32";
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
		let outputBytes = 0;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let closed = false;
		let settled = false;
		let terminationError: Error | undefined;
		let groupGone = !posix;
		let escalationTimer: NodeJS.Timeout | undefined;
		let cleanupTimer: NodeJS.Timeout | undefined;
		let timeoutTimer: NodeJS.Timeout | undefined;

		const child = spawn(command, [...args], {
			detached: posix,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const clearTimers = () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (escalationTimer) clearTimeout(escalationTimer);
			if (cleanupTimer) clearTimeout(cleanupTimer);
		};
		const cleanup = () => {
			clearTimers();
			options.policy.signal?.removeEventListener("abort", abort);
		};
		const finish = () => {
			if (settled || !closed || !groupGone) return;
			settled = true;
			cleanup();
			if (terminationError) {
				reject(terminationError);
				return;
			}
			const code = exitSignal
				? 128 + (constants.signals[exitSignal] ?? 0)
				: (exitCode ?? 1);
			resolve({
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				code,
			});
		};
		const kill = (signal: NodeJS.Signals | 0): boolean => {
			try {
				if (posix && child.pid) process.kill(-child.pid, signal);
				else if (signal !== 0) child.kill(signal);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				throw error;
			}
		};
		const failCleanup = (error: unknown) => {
			terminationError ??=
				error instanceof Error ? error : new Error(String(error));
			groupGone = true;
			finish();
		};
		const waitForGroupExit = (afterKill: boolean) => {
			if (!posix) {
				groupGone = true;
				finish();
				return;
			}
			const deadline = Date.now() + options.policy.killGraceMs;
			const probe = () => {
				try {
					if (!kill(0)) {
						groupGone = true;
						finish();
						return;
					}
					if (Date.now() >= deadline) {
						if (afterKill) {
							failCleanup(
								new Error(`Process group ${child.pid} remained after SIGKILL`),
							);
							return;
						}
						kill("SIGKILL");
						waitForGroupExit(true);
						return;
					}
					cleanupTimer = setTimeout(probe, 10);
				} catch (error) {
					failCleanup(error);
				}
			};
			probe();
		};
		const terminate = (error: Error) => {
			if (terminationError || settled) return;
			terminationError = error;
			try {
				if (!kill("SIGTERM")) groupGone = true;
				else if (posix) waitForGroupExit(false);
				else {
					escalationTimer = setTimeout(() => {
						try {
							kill("SIGKILL");
						} catch (cause) {
							failCleanup(cause);
						}
					}, options.policy.killGraceMs);
				}
			} catch (cause) {
				failCleanup(cause);
			}
			finish();
		};
		const abort = () => terminate(new CommandCancelledError(command));
		const capture = (target: Buffer[]) => (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > maxBuffer) {
				terminate(new CommandOutputLimitError(command));
				return;
			}
			target.push(chunk);
		};

		child.stdout.on("data", capture(stdout));
		child.stderr.on("data", capture(stderr));
		child.stdin.on("error", () => {});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		});
		child.once("exit", (code, signal) => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			timeoutTimer = undefined;
			exitCode = code;
			exitSignal = signal;
			if (!terminationError) {
				try {
					if (!kill("SIGTERM")) groupGone = true;
					else waitForGroupExit(false);
				} catch (error) {
					failCleanup(error);
				}
			}
			finish();
		});
		child.once("close", () => {
			closed = true;
			if (!posix) groupGone = true;
			finish();
		});

		options.policy.signal?.addEventListener("abort", abort, { once: true });
		if (options.policy.signal?.aborted) abort();
		timeoutTimer = setTimeout(
			() =>
				terminate(new CommandTimeoutError(command, options.policy.timeoutMs)),
			options.policy.timeoutMs,
		);
		child.stdin.end(options.input);
	});
}
