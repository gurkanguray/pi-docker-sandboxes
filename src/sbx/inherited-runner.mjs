import { spawn } from "node:child_process";
import { constants } from "node:os";

const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"];
export const INHERITED_GRACE_MS = Object.freeze({
	termGraceMs: 2_000,
	killGraceMs: 2_000,
});

export class SbxNotInstalledError extends Error {
	constructor(executable) {
		super(`Docker Sandboxes executable not found: ${executable}`);
		this.name = "SbxNotInstalledError";
	}
}

export function runInherited(
	command,
	args,
	env,
	runtime = { spawn, kill: process.kill.bind(process) },
	grace = INHERITED_GRACE_MS,
) {
	if (process.platform === "win32")
		return Promise.reject(
			new Error("Inherited process-group execution is unsupported on Windows"),
		);

	return new Promise((resolve, reject) => {
		let child;
		const pendingSignals = [];
		let shuttingDown = false;
		let forwardedTerm = false;
		let cleanedUp = false;
		const handlers = new Map();
		const cleanup = () => {
			if (cleanedUp) return;
			cleanedUp = true;
			for (const [signal, handler] of handlers) process.off(signal, handler);
		};
		const forward = (signal) => {
			shuttingDown = true;
			if (!child?.pid) {
				pendingSignals.push(signal);
				return true;
			}
			if (signal === "SIGTERM") forwardedTerm = true;
			try {
				runtime.kill(-child.pid, signal);
				return true;
			} catch (error) {
				if (error?.code === "ESRCH") return true;
				cleanup();
				reject(error);
				return false;
			}
		};
		for (const signal of forwardedSignals) {
			const handler = () => forward(signal);
			handlers.set(signal, handler);
			process.on(signal, handler);
		}
		try {
			child = runtime.spawn(command, [...args], {
				stdio: "inherit",
				env: env ?? {},
				detached: true,
			});
		} catch (error) {
			cleanup();
			reject(error);
			return;
		}
		child.once("error", (error) => {
			cleanup();
			if (error.code === "ENOENT") reject(new SbxNotInstalledError(command));
			else reject(error);
		});
		child.once("exit", (code, signal) => {
			const status = signal ? 128 + constants.signals[signal] : (code ?? 1);
			const killGroup = (groupSignal) => {
				try {
					runtime.kill(-child.pid, groupSignal);
					return true;
				} catch (error) {
					if (error?.code === "ESRCH") return false;
					throw error;
				}
			};
			const finish = () => {
				cleanup();
				resolve(status);
			};
			try {
				if (!shuttingDown || !forwardedTerm) {
					if (!killGroup("SIGTERM")) {
						finish();
						return;
					}
				}
			} catch (error) {
				cleanup();
				reject(error);
				return;
			}
			let deadline = Date.now() + grace.termGraceMs;
			let killed = false;
			const verify = () => {
				try {
					if (!killGroup(0)) {
						finish();
						return;
					}
					if (Date.now() >= deadline) {
						if (killed) {
							cleanup();
							reject(
								new Error(`Process group ${child.pid} remained after SIGKILL`),
							);
							return;
						}
						killed = true;
						if (!killGroup("SIGKILL")) {
							finish();
							return;
						}
						deadline = Date.now() + grace.killGraceMs;
					}
					setTimeout(verify, 10);
				} catch (error) {
					cleanup();
					reject(error);
				}
			};
			verify();
		});
		if (child.pid) {
			for (const signal of pendingSignals.splice(0))
				if (!forward(signal)) break;
		}
	});
}
