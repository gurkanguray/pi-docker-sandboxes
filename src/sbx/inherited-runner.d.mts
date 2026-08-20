export class SbxNotInstalledError extends Error {
	constructor(executable: string);
}

import type { ChildProcess, SpawnOptions } from "node:child_process";

export interface InheritedGrace {
	termGraceMs: number;
	killGraceMs: number;
}

export const INHERITED_GRACE_MS: Readonly<InheritedGrace>;

export interface InheritedRuntime {
	spawn(
		command: string,
		args: readonly string[],
		options: SpawnOptions,
	): ChildProcess;
	kill(pid: number, signal: NodeJS.Signals | 0): void;
}

export function runInherited(
	command: string,
	args: readonly string[],
	env?: Record<string, string | undefined>,
	runtime?: InheritedRuntime,
	grace?: InheritedGrace,
): Promise<number>;
