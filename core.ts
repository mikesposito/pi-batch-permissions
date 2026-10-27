export type Danger = "safe" | "caution" | "dangerous";

export const PERMISSION_MODES = ["all", "auto", "off"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
	// Widening the tuple to string[] so `includes` accepts a plain string;
	// the typeof check plus the includes result validate the predicate.
	return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function normalizeMode(value: unknown): PermissionMode {
	return isPermissionMode(value) ? value : "all";
}

export function nextMode(mode: PermissionMode): PermissionMode {
	const index = (PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length;
	return PERMISSION_MODES[index] ?? mode;
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

const DANGEROUS_PATTERNS = [
	/\brm\s+(-[a-z]*[rf][a-z]*|--recursive|--force)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b[^;&|]*\b777\b/i,
	/\bgit\s+push\b[^;&|]*(--force\b|\s-f\b)/i,
	/\bdd\b/i,
	/\bmkfs\b/i,
	/\b(shutdown|reboot|halt)\b/i,
	/\bkill(all)?\s+-9\b/i,
	/(curl|wget)[^;&|]*\|\s*(sudo\s+)?(ba|z|fi)?sh\b/i,
];

const CAUTION_PATTERNS = [
	/\b(git\s+(commit|reset|checkout|rebase|merge)|npm|npx|pnpm|yarn|pip|cargo|brew)\b/i,
	/\b(curl|wget|ssh|scp|rsync)\b/i,
	/\b(mv|cp|mkdir|touch|tee|sed\s+-i|chmod|chown|rm)\b/i,
	/\b(kill|pkill)\b/i,
];

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

const READ_ONLY_TOOLS = new Set(["read", "ls", "grep", "find"]);

/** Fallback labels when no classifier model is configured or the call fails. */
export function getHeuristicAssessment(toolName: string, input: string): Assessment {
	const purpose = "no purpose (local heuristic label)";
	if (toolName !== "bash") {
		return { danger: READ_ONLY_TOOLS.has(toolName) ? "safe" : "caution", purpose, risk: "" };
	}
	if (DANGEROUS_PATTERNS.some((p) => p.test(input))) {
		return { danger: "dangerous", purpose, risk: "matches a known dangerous pattern (local heuristic label)" };
	}
	if (CAUTION_PATTERNS.some((p) => p.test(input))) {
		return { danger: "caution", purpose, risk: "" };
	}
	return { danger: "safe", purpose, risk: "" };
}

/**
 * Parse the classifier's reply. Expects a JSON array of {danger, purpose},
 * exactly `count` items, in input order. Returns undefined on any mismatch so
 * the caller falls back to heuristics.
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
	const lines = [
		`Approve ${commands.length} tool call${commands.length === 1 ? "" : "s"}?`,
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

/** Body for the single-call fallback dialog. */
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
