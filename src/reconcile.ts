import type { SandboxStateV2 } from "./state-schema.ts";

export interface SandboxInspection {
	exists: boolean | "unknown";
	imageMatches?: boolean;
}

export type ReconciliationDecision =
	| { action: "mark-ready" }
	| { action: "mark-failed"; reason: string }
	| { action: "remove-state" }
	| { action: "preserve"; reason: string };

export function reconcileSandbox(
	state: SandboxStateV2,
	inspection: SandboxInspection,
): ReconciliationDecision {
	if (inspection.exists === "unknown")
		return { action: "preserve", reason: "sandbox existence is unknown" };
	if (state.phase === "failed")
		return { action: "preserve", reason: "failed lifecycle requires recovery" };
	if (state.phase === "exporting")
		return { action: "preserve", reason: "interrupted export" };
	if (state.phase === "removing")
		return inspection.exists
			? { action: "preserve", reason: "interrupted removal" }
			: { action: "remove-state" };
	if (!inspection.exists) return { action: "remove-state" };
	if (inspection.imageMatches !== true)
		return inspection.imageMatches === false
			? { action: "mark-failed", reason: "runtime image mismatch" }
			: { action: "preserve", reason: "runtime image identity is unknown" };
	return state.phase === "creating"
		? { action: "mark-ready" }
		: { action: "preserve", reason: "sandbox is ready" };
}
