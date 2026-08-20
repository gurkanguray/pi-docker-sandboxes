/** Stable pi-dsbx launcher process exit status enum. */
export const LauncherExitCode = Object.freeze({
	Success: 0,
	Failure: 1,
	/** Required custody/finalization work failed after Pi stopped. */
	CustodyFailure: 74,
	/** Another process owns the sandbox operation lease. */
	Busy: 75,
} as const);

export type LauncherExitCode =
	(typeof LauncherExitCode)[keyof typeof LauncherExitCode];
