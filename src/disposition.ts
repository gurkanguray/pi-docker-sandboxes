export type ChangeState = "clean" | "changed" | "unknown";
export type DispositionAction = "preserve" | "remove";
export type DispositionReason =
	| "keep-requested"
	| "export-failed"
	| "clean"
	| "exported"
	| "discard-authorized"
	| "unexported-changes";

export interface DispositionInput {
	keep: boolean;
	changes: ChangeState;
	exportRequested: boolean;
	exportSucceeded: boolean;
	discardAuthorized: boolean;
}

export interface DispositionDecision {
	action: DispositionAction;
	reason: DispositionReason;
	/** False only for the impossible state: export succeeded without a request. */
	meaningful: boolean;
}

export function decideDisposition(
	input: DispositionInput,
): DispositionDecision {
	const meaningful = !input.exportSucceeded || input.exportRequested;
	if (input.keep)
		return { action: "preserve", reason: "keep-requested", meaningful };
	if (input.exportRequested && !input.exportSucceeded)
		return { action: "preserve", reason: "export-failed", meaningful };
	if (input.changes === "clean")
		return { action: "remove", reason: "clean", meaningful };
	if (input.exportRequested && input.exportSucceeded)
		return { action: "remove", reason: "exported", meaningful };
	if (input.discardAuthorized)
		return { action: "remove", reason: "discard-authorized", meaningful };
	return { action: "preserve", reason: "unexported-changes", meaningful };
}
