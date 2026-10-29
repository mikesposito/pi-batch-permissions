export type Danger = "safe" | "caution" | "dangerous";

export const PERMISSION_MODES = ["fastened", "auto", "unfastened"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
	// Widening the tuple to string[] so `includes` accepts a plain string;
	// the typeof check plus the includes result validate the predicate.
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function normalizeMode(value: unknown): PermissionMode {
	return isPermissionMode(value) ? value : "fastened";
}

export function nextMode(mode: PermissionMode): PermissionMode {
	const index = (PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length;
	return PERMISSION_MODES[index] ?? mode;
}

export const DEFAULT_SHORTCUT = "alt+b";

/**
 * A pi key id from config ("alt+b", "ctrl+shift+p", "f5"): a non-empty
 * string without whitespace. Anything else falls back to the default.
 */
export function normalizeShortcut(value: unknown): string {
	const key = typeof value === "string" ? value.trim() : "";
	return key !== "" && !/\s/.test(key) ? key : DEFAULT_SHORTCUT;
}

export type Assessment = {
	danger: Danger;
	purpose: string;
	/** Why the call is dangerous; empty unless danger is "dangerous". */
	risk: string;
};

/** Per-fragment styling for the approval dialog. Defaults to plain text. */
export type DialogStyle = {
	label: (danger: Danger, text: string) => string;
	text: (text: string) => string;
	dim: (text: string) => string;
};

export const plainStyle: DialogStyle = {
	label: (_danger, text) => text,
	text: (text) => text,
	dim: (text) => text,
};

const LABELS = {
	dangerous: "✗ DANGEROUS",
	caution: "! caution",
	safe: "✓ safe",
} satisfies Record<Danger, string>;

/**
 * Merge the user's policy.md into the labeller system prompt. An empty or
 * missing policy leaves the base prompt unchanged.
 */
export function withPolicy(base: string, policy: string): string {
	const trimmed = policy.trim();
	return trimmed
		? `${base}\n\nThe user's own policy below overrides the defaults above:\n\n${trimmed}`
		: base;
}

/** Exact tool name, or prefix match with a trailing "*" (e.g. "mcp__slack__*"). */
export function matchesTool(patterns: readonly string[], name: string): boolean {
	return patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));
}

/** One-line description of a tool call, used for both the classifier input and the dialog. */
export function describeCall(toolName: string, args: Record<string, unknown>): string {
	if (toolName === "bash" && typeof args.command === "string") return args.command;
	const json = JSON.stringify(args) ?? "{}";
	if (json.length > 500) return `${toolName} ${json.slice(0, 500)}…(truncated)`;
	return json === "{}" ? toolName : `${toolName} ${json}`;
}

/** One user decision from the current session, used as classifier context. */
export type DecisionRecord = {
	tool: string;
	/** The call as shown in the dialog (describeCall output). */
	display: string;
	allowed: boolean;
	/** The user's stated reason, present only on rejects with a message. */
	reason?: string;
};

/** Prior user decisions as classifier-prompt context; empty string when there is none. Most recent last, capped. */
export function formatHistory(records: readonly DecisionRecord[], max = 20): string {
	if (records.length === 0) return "";
	const lines = records
		.slice(-max)
		.map(
			(r) =>
				`- ${r.allowed ? "approved" : "rejected"}: ${r.display}${r.reason ? ` (user said: ${r.reason})` : ""}`,
		);
	return `Earlier user decisions in this session (most recent last):\n${lines.join("\n")}`;
}

/**
 * Parse the classifier's reply. Expects a JSON array of {danger, purpose},
 * exactly `count` items, in input order. Returns undefined on any mismatch
 * so the caller treats classification as failed.
 */
export function parseAssessments(raw: string, count: number): Assessment[] | undefined {
	const start = raw.indexOf("[");
	const end = raw.lastIndexOf("]");
	if (start === -1 || end <= start) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length !== count) return undefined;

	const result: Assessment[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null) return undefined;
		// Safe because only "danger", "purpose", and "risk" are read, and all
		// are validated immediately below.
		const { danger, purpose, risk } = item as Record<string, unknown>;
		if (danger !== "safe" && danger !== "caution" && danger !== "dangerous") return undefined;
		const text = typeof purpose === "string" ? purpose.slice(0, 120).trim() : "";
		const riskText = typeof risk === "string" ? risk.slice(0, 120).trim() : "";
		result.push({ danger, purpose: text || "(no purpose given)", risk: riskText });
	}
	return result;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)} …(truncated)` : text;
}

/** Body for the one-shot batch approval dialog. */
export function formatBatch(
	commands: string[],
	assessments: Assessment[],
	style: DialogStyle = plainStyle,
): string {
	if (commands.length === 1) {
		return `Approve this tool call?\n\n${formatSingle(commands[0], assessments[0], style)}`;
	}
	const lines = [
		`Approve ${commands.length} tool calls?`,
		"",
	];
	for (let i = 0; i < commands.length; i++) {
		const assessment = assessments[i];
		lines.push(` ${String(i + 1).padEnd(2)} ${style.label(assessment.danger, LABELS[assessment.danger])}`);
		lines.push(`    ${style.dim("> ")}${style.text(truncate(commands[i], 300))}`);
		lines.push(`    ${style.dim(`What it does: ${assessment.purpose}`)}`);
		if (assessment.danger === "dangerous" && assessment.risk) {
			lines.push(`    ${style.label("dangerous", `Why it's dangerous: ${assessment.risk}`)}`);
		}
		lines.push("");
	}
	lines.push(style.dim("One approval covers every tool call in this batch."));
	return lines.join("\n");
}

/** Why the classifier could not label calls: no model configured, or the call itself failed. */
export type ClassifyFailure = "no-model" | "unavailable";

/** Body for the approval dialog when the classifier failed: calls listed without labels. */
export function formatUnlabeled(
	commands: string[],
	failure: ClassifyFailure,
	style: DialogStyle = plainStyle,
): string {
	const warning =
		failure === "no-model"
			? "! no classifier model set: these calls could not be labeled (pick one with /seatbelt)"
			: "! classifier unavailable: these calls could not be labeled";
	const lines = [
		commands.length === 1 ? "Approve this tool call?" : `Approve ${commands.length} tool calls?`,
		"",
		style.label("caution", warning),
		"",
	];
	for (let i = 0; i < commands.length; i++) {
		lines.push(` ${String(i + 1).padEnd(2)} ${style.dim("> ")}${style.text(truncate(commands[i], 300))}`);
		lines.push("");
	}
	if (commands.length > 1) {
		lines.push(style.dim("One approval covers every tool call in this batch."));
	}
	return lines.join("\n");
}

/** Body for the single-call fallback dialog, also embedded by formatBatch. */
export function formatSingle(command: string, assessment: Assessment, style: DialogStyle = plainStyle): string {
	const lines = [
		style.label(assessment.danger, LABELS[assessment.danger]),
		`  ${style.dim("> ")}${style.text(truncate(command, 300))}`,
		`  ${style.dim(`What it does: ${assessment.purpose}`)}`,
	];
	if (assessment.danger === "dangerous" && assessment.risk) {
		lines.push(`  ${style.label("dangerous", `Why it's dangerous: ${assessment.risk}`)}`);
	}
	return lines.join("\n");
}
