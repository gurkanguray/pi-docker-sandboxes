export type OperationPhase =
	| "preflight"
	| "prepare"
	| "create"
	| "run"
	| "inspect-exit"
	| "export-or-preserve"
	| "remove-or-keep"
	| "cleanup-host-staging";

export interface OperationErrorOptions {
	phase: OperationPhase;
	operation: string;
	exitCode?: number;
	signal?: NodeJS.Signals;
	detail?: string;
	recovery?: readonly string[];
	cause?: unknown;
}

export const SECRET_PATTERNS = [
	{
		category: "credential URL",
		pattern: /(?:https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
	},
	{
		category: "authorization credential",
		pattern: /Authorization\s*:\s*Basic\s+\S+|Bearer\s+\S+/gi,
	},
	{
		category: "secret token",
		pattern: /sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-\S+/gi,
	},
	{
		category: "secret assignment",
		pattern:
			/((?:["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret)["']?)\s*[:=]\s*)(?!\[redacted\])("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,}\]\r\n]+)/gi,
	},
] as const;

export function scanSecretCategories(value: string): string[] {
	return SECRET_PATTERNS.filter(({ pattern }) => {
		pattern.lastIndex = 0;
		const matched = pattern.test(value);
		pattern.lastIndex = 0;
		return matched;
	})
		.map(({ category }) => category)
		.sort();
}

export function sanitizeDetail(value: string, limit = 500): string {
	let redacted = value;
	for (const { category, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		redacted = redacted.replace(pattern, (_match, prefix, assigned) => {
			if (category !== "secret assignment") return "[redacted]";
			const quote = assigned?.match(/^["']/)?.[0] ?? "";
			return `${prefix}${quote}[redacted]${quote}`;
		});
		pattern.lastIndex = 0;
	}
	const oneLine = redacted.replace(/\s+/g, " ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}

export class OperationError extends Error {
	readonly phase: OperationPhase;
	readonly operation: string;
	readonly exitCode?: number;
	readonly signal?: NodeJS.Signals;
	readonly detail?: string;
	readonly recovery: readonly string[];

	constructor(options: OperationErrorOptions) {
		const status =
			options.exitCode !== undefined
				? ` (exit ${options.exitCode})`
				: options.signal
					? ` (${options.signal})`
					: "";
		super(`${options.phase}: ${options.operation} failed${status}`, {
			cause: options.cause,
		});
		this.name = "OperationError";
		this.phase = options.phase;
		this.operation = options.operation;
		this.exitCode = options.exitCode;
		this.signal = options.signal;
		this.detail = options.detail ? sanitizeDetail(options.detail) : undefined;
		this.recovery = [...(options.recovery ?? [])];
	}
}

export function formatError(error: unknown): string {
	if (!(error instanceof OperationError))
		return error instanceof Error ? error.message : String(error);
	return [
		error.message,
		error.detail,
		...error.recovery.map((command) => `Try: ${command}`),
	]
		.filter(Boolean)
		.join("\n");
}
