/**
 * Seatbelt: a safe, ergonomic permission system for pi.
 *
 * The core feature: replaces per-call approval with one approval per chain
 * of tool calls:
 * when an assistant message contains calls to gated tools, every call is
 * first labeled (safe / caution / dangerous, plus a one-line purpose) by a
 * cheap classifier model, then the user approves or rejects the whole batch
 * in a single dialog. Calls the model issues through nested execution
 * (codemode scripts) are approved one at a time as a fallback.
 *
 * The gated tools are configured in ~/.pi/agent/seatbelt/config.json
 * under "tools" (exact names like "bash", "write", or prefix patterns like
 * "mcp__slack__*"; default ["bash"]). The classifier model is set with
 * /seatbelt. Custom labeling rules go in policy.md next to the config:
 * its whole content is sent to the labeller as user policy that overrides
 * the built-in defaults, and it is re-read on every batch. Without a usable
 * model, every gated call requires approval (the policy file only affects
 * the model).
 *
 * Permission modes (cycled with the configured shortcut key, default alt+b,
 * shown in the status bar) are per session: switching affects only the
 * current session and is remembered per session id, so resuming a session
 * restores its mode. New sessions start in the config's default "mode",
 * settable with /seatbelt:default.
 * - "fastened" (default): one approval dialog per chain of gated tool calls.
 * - "auto": chains without a dangerous call run without asking; a dangerous
 *   call still shows the approval dialog.
 * - "unfastened": no approval requests at all.
 * In headless modes (no UI) only "safe" calls are auto-allowed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, UserMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_SHORTCUT,
	describeCall,
	matchesTool,
	parseAssessments,
	formatBatch,
	formatSingle,
	formatUnlabeled,
	formatHistory,
	normalizeMode,
	normalizeShortcut,
	isPermissionMode,
	nextMode,
	plainStyle,
	withPolicy,
	type Assessment,
	type ClassifyFailure,
	type DecisionRecord,
	type DialogStyle,
	type PermissionMode,
} from "./core.ts";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "seatbelt");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const POLICY_PATH = join(CONFIG_DIR, "policy.md");
const SESSION_MODES_PATH = join(CONFIG_DIR, "session-modes.json");

const POLICY_TEMPLATE = `# Seatbelt policy

Everything in this file is sent to the labeller model as additional policy and
overrides its built-in defaults. Write plain-sentence rules about what this
machine and workflow consider safe, caution, or dangerous. While this file
contains only this header, the built-in defaults apply unchanged.
`;

const CONFIG_TEMPLATE = {
	timeoutMs: 20000,
	mode: "fastened",
	shortcut: DEFAULT_SHORTCUT,
	tools: ["bash"],
};

let hasSeededFreshConfig = false;

// Seeds the config folder on load: writes templates for anything missing so a
// fresh install has editable files. No "model" key in the template:
// /seatbelt sets it.
function ensureConfigFiles(): void {
	if (!existsSync(CONFIG_PATH)) {
		hasSeededFreshConfig = true;
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`);
	}
	if (!existsSync(POLICY_PATH)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(POLICY_PATH, POLICY_TEMPLATE);
	}
}

type Config = {
	model?: string;
	timeoutMs?: number;
	mode?: string;
	shortcut?: string;
	tools?: string[];
};

function readConfig(): Config {
	try {
		// Safe cast: every field is optional, and each consumer validates the
		// value it reads (isPermissionMode, string patterns, /seatbelt).
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Config;
	} catch {
		return {};
	}
}

function writeConfig(config: Config): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function readPolicy(): string {
	try {
		const content = readFileSync(POLICY_PATH, "utf8");
		return content.trim() === POLICY_TEMPLATE.trim() ? "" : content;
	} catch {
		return "";
	}
}

function getCurrentMode(ctx: ExtensionContext): PermissionMode {
	return sessionModes.get(ctx.sessionManager.getSessionId()) ?? normalizeMode(readConfig().mode);
}

// Per-session mode overrides, persisted by session id so a resumed session
// keeps its mode. shortcut: entries are never pruned; revisit if this grows large
const sessionModes = new Map<string, PermissionMode>();

function loadSessionModes(): void {
	try {
		// Safe cast: values are validated with isPermissionMode before use.
		const raw = JSON.parse(readFileSync(SESSION_MODES_PATH, "utf8")) as Record<string, unknown>;
		for (const [id, mode] of Object.entries(raw)) {
			if (isPermissionMode(mode)) sessionModes.set(id, mode);
		}
	} catch {}
}

function setSessionMode(ctx: ExtensionContext, mode: PermissionMode): void {
	sessionModes.set(ctx.sessionManager.getSessionId(), mode);
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(SESSION_MODES_PATH, `${JSON.stringify(Object.fromEntries(sessionModes), null, 2)}\n`);
}

// User decisions from the current session, fed to the classifier as context.
const sessionHistory = new Map<string, DecisionRecord[]>();

function recordDecisions(
	ctx: ExtensionContext,
	entries: readonly GatedCall[],
	displays: readonly string[],
	isAllowed: boolean,
	rejectMessage?: string,
): void {
	const id = ctx.sessionManager.getSessionId();
	const history = sessionHistory.get(id) ?? [];
	for (const [i, entry] of entries.entries()) {
		history.push({ tool: entry.tool, display: displays[i], allowed: isAllowed, reason: isAllowed ? undefined : rejectMessage });
	}
	sessionHistory.set(id, history);
}

function getGatedTools(): string[] {
	return readConfig().tools ?? ["bash"];
}

function findModel(spec: string | undefined, ctx: ExtensionContext): Model | undefined {
	if (!spec) return undefined;
	const slash = spec.indexOf("/");
	return slash > 0 ? ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1)) : undefined;
}

function getCallArgs(input: unknown): Record<string, unknown> {
	// Safe cast: runtime-checked above, and callers only read known keys.
	return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

const CLASSIFIER_SYSTEM = `You label tool calls for a user approval dialog.

Each item is a tool name and its input: for bash, the shell command; for other
tools, the arguments (paths, file content, requests).

For each call return:
- "danger": "safe" (read-only or trivially reversible: ls, cat, grep, git status, reading a file), "caution" (changes files or state, installs code, reaches the network, or sends a message: mv, npm install, git commit, curl, write or edit a file), or "dangerous" (destroys data, alters the system, escalates privileges, or is hard to reverse: rm -rf, sudo, git push --force, chmod 777, dd, kill, deleting or overwriting files).
- "purpose": one line, max 12 words, saying what the call does for the task.
- "risk": one line, max 12 words, saying WHY the call is dangerous; the empty string "" when danger is not "dangerous".

When earlier user decisions from this session are given, use them as context:
a call similar to one the user approved leans safer; a call similar to one the
user rejected, especially with a stated reason, leans dangerous.

Respond with ONLY a JSON array in input order, no markdown fences:
[{"danger":"safe","purpose":"...","risk":"..."}]`;

type Decision = { isAllowed: boolean; rejectMessage?: string };

const decisions = new Map<string, Decision>();

type GatedCall = {
	id: string;
	tool: string;
	args: Record<string, unknown>;
};

/** classifyCalls result: labels on success, the failure reason otherwise. */
type ClassifyResult = { ok: true; assessments: Assessment[] } | { ok: false; failure: ClassifyFailure };

async function classifyCalls(
	calls: GatedCall[],
	taskContext: string,
	ctx: ExtensionContext,
): Promise<ClassifyResult> {
	const { model: spec, timeoutMs = 20000 } = readConfig();
	const system = withPolicy(CLASSIFIER_SYSTEM, readPolicy());
	const inputs = calls.map((c) => ({ tool: c.tool, input: describeCall(c.tool, c.args) }));
	const model = findModel(spec, ctx);
	if (!model) return { ok: false, failure: "no-model" };

	const user: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: [
					`Task context:\n${taskContext || "(none)"}`,
					formatHistory(sessionHistory.get(ctx.sessionManager.getSessionId()) ?? []),
					`Tool calls:\n${JSON.stringify(inputs)}`,
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		],
		timestamp: Date.now(),
	};
	try {
		// shortcut: on timeout the classifier request keeps running in the background, harmless but not free
		const reply = await Promise.race([
			ctx.modelRegistry.complete(model, { systemPrompt: system, messages: [user] }, { signal: ctx.signal }),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("classifier timeout")), timeoutMs)),
		]);
		const text = reply.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const parsed = parseAssessments(text, calls.length);
		if (parsed) return { ok: true, assessments: parsed };
	} catch {}
	return { ok: false, failure: "unavailable" };
}

const DANGER_COLOR = {
	dangerous: "error",
	caution: "warning",
	safe: "success",
} as const;

// The selector renders the whole dialog body in accent+bold, so every fragment
// needs an explicit style; only the TUI has a theme.
function getDialogStyle(ctx: ExtensionContext): DialogStyle {
	if (ctx.mode !== "tui" || !ctx.hasUI) return plainStyle;
	const theme = ctx.ui.theme;
	return {
		label: (danger, text) => theme.fg(DANGER_COLOR[danger], text),
		text: (text) => theme.fg("text", text),
		dim: (text) => theme.fg("dim", text),
	};
}

function notifyClassifyFailure(failure: ClassifyFailure, ctx: ExtensionContext): void {
	if (failure === "no-model" && ctx.hasUI) {
		ctx.ui.notify(
			"seatbelt: no classifier model set, so every gated call requires approval. Pick one with /seatbelt.",
			"warning",
		);
	}
}

// Runs the approval dialog (or headless fallback) and stores one decision per
// call. Returns the rejection message when the user wrote one.
async function approveWithDialog(
	body: string,
	isSingle: boolean,
	ctx: ExtensionContext,
): Promise<{ isAllowed: boolean; rejectMessage?: string }> {
	const approveLabel = isSingle ? "Approve" : "Approve all";
	const rejectLabel = isSingle ? "Reject" : "Reject all";
	const choice = await ctx.ui.select(body, [approveLabel, rejectLabel, "Reject with message"]);
	if (choice === "Reject with message") {
		// Cancelling the input still rejects, just without a message.
		const message = await ctx.ui.input("Why reject? This is sent to the agent.");
		return { isAllowed: false, rejectMessage: message ?? undefined };
	}
	return { isAllowed: choice === approveLabel };
}

function rejectReason(toolName: string, args: Record<string, unknown>, rejectMessage?: string): string {
	const base = `User rejected this ${toolName} call: ${describeCall(toolName, args)}`;
	return rejectMessage ? `${base}. User said: ${rejectMessage}` : base;
}

async function approveBatch(
	entries: GatedCall[],
	taskContext: string,
	ctx: ExtensionContext,
): Promise<void> {
	const mode = getCurrentMode(ctx);
	if (mode === "unfastened") return;
	const result = await classifyCalls(entries, taskContext, ctx);
	const displays = entries.map((e) => describeCall(e.tool, e.args));
	let isAllowed: boolean;
	let rejectMessage: string | undefined;
	if (!result.ok) {
		// classifier failed: always ask, no matter the mode (fastened/auto); fail-safe without a UI
		notifyClassifyFailure(result.failure, ctx);
		if (ctx.hasUI) {
			const decision = await approveWithDialog(
				formatUnlabeled(displays, result.failure, getDialogStyle(ctx)),
				entries.length === 1,
				ctx,
			);
			isAllowed = decision.isAllowed;
			rejectMessage = decision.rejectMessage;
			recordDecisions(ctx, entries, displays, isAllowed, rejectMessage);
		} else {
			isAllowed = false;
		}
	} else if (mode === "auto" && result.assessments.every((a) => a.danger !== "dangerous")) {
		isAllowed = true;
	} else if (ctx.hasUI) {
		const decision = await approveWithDialog(
			formatBatch(displays, result.assessments, getDialogStyle(ctx)),
			entries.length === 1,
			ctx,
		);
		isAllowed = decision.isAllowed;
		rejectMessage = decision.rejectMessage;
		recordDecisions(ctx, entries, displays, isAllowed, rejectMessage);
	} else {
		// no UI: fail-safe, only clearly safe calls pass without a human
		isAllowed = result.assessments.every((a) => a.danger === "safe");
	}
	for (const entry of entries) {
		decisions.set(entry.id, { isAllowed, rejectMessage });
	}
}

export default function (pi: ExtensionAPI) {
	ensureConfigFiles();
	loadSessionModes();

	// The assistant message is finalized before its tool calls execute, so the
	// whole chain is known here and can be approved in one dialog.
	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const calls = message.content
			.filter(
				(c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
					c.type === "toolCall" && matchesTool(getGatedTools(), c.name),
			)
			.map((c) => ({ id: c.id, tool: c.name, args: c.arguments ?? {} }));
		if (calls.length === 0) return;
		if (getCurrentMode(ctx) === "unfastened") return;
		const taskContext = message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.slice(0, 800);
		await approveBatch(calls, taskContext, ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!matchesTool(getGatedTools(), event.toolName)) return undefined;
		if (getCurrentMode(ctx) === "unfastened") return undefined;
		if (!decisions.has(event.toolCallId)) {
			// Nested or otherwise unseen call (for example a codemode script): approve it on its own
			const entry: GatedCall = { id: event.toolCallId, tool: event.toolName, args: getCallArgs(event.input) };
			const result = await classifyCalls([entry], "", ctx);
			let isAllowed: boolean;
			let rejectMessage: string | undefined;
			if (!result.ok) {
				// classifier failed: always ask, no matter the mode (fastened/auto); fail-safe without a UI
				notifyClassifyFailure(result.failure, ctx);
				if (ctx.hasUI) {
					const decision = await approveWithDialog(
						formatUnlabeled([describeCall(entry.tool, entry.args)], result.failure, getDialogStyle(ctx)),
						true,
						ctx,
					);
					isAllowed = decision.isAllowed;
					rejectMessage = decision.rejectMessage;
					recordDecisions(ctx, [entry], [describeCall(entry.tool, entry.args)], isAllowed, rejectMessage);
				} else {
					isAllowed = false;
				}
			} else {
				const assessment = result.assessments[0];
				if (getCurrentMode(ctx) === "auto" && assessment.danger !== "dangerous") {
					isAllowed = true;
				} else if (ctx.hasUI) {
					const decision = await approveWithDialog(
						formatSingle(describeCall(entry.tool, entry.args), assessment, getDialogStyle(ctx)),
						true,
						ctx,
					);
					isAllowed = decision.isAllowed;
					rejectMessage = decision.rejectMessage;
					recordDecisions(ctx, [entry], [describeCall(entry.tool, entry.args)], isAllowed, rejectMessage);
				} else {
					isAllowed = assessment.danger === "safe";
				}
			}
			decisions.set(event.toolCallId, { isAllowed, rejectMessage });
		}
		const decision = decisions.get(event.toolCallId);
		decisions.delete(event.toolCallId);
		// A missing decision is unreachable; blocking is the fail-safe default.
		if (!decision?.isAllowed) {
			return {
				block: true,
				reason: rejectReason(event.toolName, getCallArgs(event.input), decision?.rejectMessage),
			};
		}
		return undefined;
	});

	pi.registerCommand("seatbelt", {
		description: "Show or set the model that labels tool calls for approval",
		handler: async (args, ctx) => {
			const current = readConfig().model ?? "(none, every gated call requires approval)";
			let value = args.trim();
			if (!value) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Classifier model: ${current}. Usage: /seatbelt provider/model-id`, "info");
					return;
				}
				const options = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
				if (options.length === 0) {
					ctx.ui.notify("No models available", "error");
					return;
				}
				const choice = await ctx.ui.select(
					`Seatbelt classifier (current: ${current}). Pick a model:`,
					options,
				);
				if (!choice) return;
				value = choice;
			}
			const model = findModel(value, ctx);
			if (!model) {
				ctx.ui.notify(`Unknown model: ${value}`, "error");
				return;
			}
			writeConfig({ ...readConfig(), model: value });
			ctx.ui.notify(`Seatbelt labels now use ${model.name} (${value})`, "info");
		},
	});

	const MODE_HINTS = {
		fastened: "every chain of gated tool calls needs one approval",
		auto: "auto-approve unless a call is dangerous",
		unfastened: "no approval requests",
	} satisfies Record<PermissionMode, string>;

	// Status-bar wording: gated (fastened), no gating (unfastened), the
	// labeller decides what runs (auto).
	const MODE_LABELS = {
		fastened: "fastened 🔒",
		auto: "auto 🤖",
		unfastened: "unfastened 💀",
	} satisfies Record<PermissionMode, string>;

	const MODE_COLOR = {
		fastened: "success",
		auto: "warning",
		unfastened: "error",
	} satisfies Record<PermissionMode, "success" | "warning" | "error">;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const mode = getCurrentMode(ctx);
		const label = `seatbelt:${MODE_LABELS[mode]}`;
		const text = ctx.mode === "tui" ? ctx.ui.theme.fg(MODE_COLOR[mode], label) : label;
		ctx.ui.setStatus("seatbelt", text);
	}

	pi.registerCommand("seatbelt:mode", {
		description: "Switch seatbelt mode (fastened, auto, unfastened); no argument cycles",
		handler: async (args, ctx) => {
			const wanted = args.trim();
			if (wanted && !isPermissionMode(wanted)) {
				ctx.ui.notify(`Unknown mode: ${wanted}. Use fastened, auto, or unfastened.`, "error");
				return;
			}
			// Safe cast: wanted is non-empty and passed isPermissionMode above.
			const mode = (wanted || nextMode(getCurrentMode(ctx))) as PermissionMode;
			setSessionMode(ctx, mode);
			updateStatus(ctx);
			ctx.ui.notify(`Seatbelt: ${mode} (${MODE_HINTS[mode]}), this session only`, "info");
		},
	});

	pi.registerCommand("seatbelt:default", {
		description: "Set the default mode for new sessions (fastened, auto, unfastened); no argument shows it",
		handler: async (args, ctx) => {
			const wanted = args.trim();
			if (!wanted) {
				const current = normalizeMode(readConfig().mode);
				ctx.ui.notify(
					`Default mode for new sessions: ${current}. Usage: /seatbelt:default fastened|auto|unfastened`,
					"info",
				);
				return;
			}
			if (!isPermissionMode(wanted)) {
				ctx.ui.notify(`Unknown mode: ${wanted}. Use fastened, auto, or unfastened.`, "error");
				return;
			}
			writeConfig({ ...readConfig(), mode: wanted });
			ctx.ui.notify(
				`New sessions will start ${wanted} (${MODE_HINTS[wanted]}). This session stays ${getCurrentMode(ctx)}.`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
		if (hasSeededFreshConfig && ctx.hasUI) {
			ctx.ui.notify(
				"seatbelt: no labeller model set, so every gated call requires approval. Pick one with /seatbelt.",
				"info",
			);
		}
	});

	// Read at startup; KeyId is a compile-time union, so the runtime string
	// from config is cast after normalizeShortcut validated it.
	const shortcut = normalizeShortcut(readConfig().shortcut) as Parameters<
		ExtensionAPI["registerShortcut"]
	>[0];
	pi.registerShortcut(shortcut, {
		description: "Cycle seatbelt mode (fastened, auto, unfastened)",
		handler: (ctx) => {
			const mode = nextMode(getCurrentMode(ctx));
			setSessionMode(ctx, mode);
			updateStatus(ctx);
			if (ctx.hasUI) ctx.ui.notify(`Seatbelt: ${mode} (${MODE_HINTS[mode]}), this session only`, "info");
		},
	});
}
