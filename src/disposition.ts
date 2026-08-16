export type ChangeState = "clean" | "changed" | "unknown";
export type DispositionAction = "preserve" | "remove";
export interface DispositionInput {
	keep: boolean;
	changes: ChangeState;
	exportRequested: boolean;
	exportSucceeded: boolean;
	discardAuthorized: boolean;
}

export function decideDisposition(input: DispositionInput): DispositionAction {
	if (input.keep) return "preserve";
	if (input.exportRequested && !input.exportSucceeded) return "preserve";
	if (input.changes === "clean") return "remove";
	if (input.exportRequested && input.exportSucceeded) return "remove";
	if (input.discardAuthorized) return "remove";
	return "preserve";
}
