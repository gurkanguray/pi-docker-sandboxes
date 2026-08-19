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
		let status;
		let groupGone = false;
		let childExited = false;
		let teardownStarted = false;
		let teardownTimer;
		let teardownProbe;
		let settled = false;
		const pendingSignals = [];
		const handlers = new Map();
		const cleanup = () => {
			if (teardownTimer) clearTimeout(teardownTimer);
			for (const [signal, handler] of handlers) process.off(signal, handler);
		};
		const rejectOnce = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const finish = () => {
			if (settled || status === undefined || !groupGone) return;
			settled = true;
			cleanup();
			resolve(status);
		};
		const killGroup = (signal) => {
			try {
				runtime.kill(-child.pid, signal);
				return true;
			} catch (error) {
				if (error?.code === "ESRCH") return false;
				throw error;
			}
		};
		const startTeardown = (sendTerm) => {
			if (teardownStarted || settled) return;
			teardownStarted = true;
			let deadline = Date.now() + grace.termGraceMs;
			let killed = false;
			try {
				if (sendTerm && !killGroup("SIGTERM")) {
					groupGone = true;
					finish();
					return;
				}
			} catch (error) {
				rejectOnce(error);
				return;
			}
			const verify = () => {
				if (settled) return;
				if (!childExited && Date.now() < deadline) {
					teardownTimer = setTimeout(verify, 10);
					return;
				}
				try {
					if (!killGroup(0)) {
						groupGone = true;
						finish();
						return;
					}
					if (Date.now() >= deadline) {
						if (killed) {
							rejectOnce(
								new Error(`Process group ${child.pid} remained after SIGKILL`),
							);
							return;
						}
						killed = true;
						if (!killGroup("SIGKILL")) {
							groupGone = true;
							finish();
							return;
						}
						deadline = Date.now() + grace.killGraceMs;
					}
					teardownTimer = setTimeout(verify, 10);
				} catch (error) {
					rejectOnce(error);
				}
			};
			teardownProbe = verify;
			verify();
		};
		const forward = (signal) => {
			if (!child?.pid) {
				pendingSignals.push(signal);
				return true;
			}
			try {
				if (!killGroup(signal)) groupGone = true;
				else startTeardown(false);
				finish();
				return true;
			} catch (error) {
				rejectOnce(error);
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
			rejectOnce(error);
			return;
		}
		child.once("error", (error) => {
			if (error.code === "ENOENT")
				rejectOnce(new SbxNotInstalledError(command));
			else rejectOnce(error);
		});
		child.once("exit", (code, signal) => {
			childExited = true;
			status = signal ? 128 + constants.signals[signal] : (code ?? 1);
			if (!teardownStarted) startTeardown(true);
			else {
				if (teardownTimer) clearTimeout(teardownTimer);
				teardownTimer = undefined;
				teardownProbe?.();
			}
			finish();
		});
		if (child.pid) {
			for (const signal of pendingSignals.splice(0))
				if (!forward(signal)) break;
		}
	});
}
