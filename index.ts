/**
 * Batch permissions for pi.
 *
 * Replaces per-call approval with one approval per chain of tool calls:
 * when an assistant message contains calls to gated tools, every call is
 * first labeled (safe / caution / dangerous, plus a one-line purpose) by a
 * cheap classifier model, then the user approves or rejects the whole batch
 * in a single dialog. Calls the model issues through nested execution
 * (codemode scripts) are approved one at a time as a fallback.
 *
 * The gated tools are configured in ~/.pi/agent/batch-permissions/config.json
 * under "tools" (exact names like "bash", "write", or prefix patterns like
 * "mcp__slack__*"; default ["bash"]). The classifier model is set with
 * /batchmodel. Custom labeling rules go in policy.md next to the config:
 * its whole content is sent to the labeller as user policy that overrides
 * the built-in defaults, and it is re-read on every batch. Without a usable
 * model, local heuristics label the calls instead (the policy file only
 * affects the model).
 *
 * Permission modes (cycled with alt+b, shown in the status bar):
 * - "all" (default): one approval dialog per chain of gated tool calls.
 * - "auto": chains without a dangerous call run without asking; a dangerous
 *   call still shows the approval dialog.
 * - "off": no approval requests at all.
 * In headless modes (no UI) only "safe" calls are auto-allowed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, UserMessage } from "@earendil-works/pi-ai";
import {
	describeCall,
	getHeuristicAssessment,
	matchesTool,
	parseAssessments,
	formatBatch,
	formatSingle,
	normalizeMode,
	nextMode,
	plainStyle,
	withPolicy,
	type Assessment,
	type DialogStyle,
	type PermissionMode,
} from "./core.ts";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "batch-permissions");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const POLICY_PATH = join(CONFIG_DIR, "policy.md");

const POLICY_TEMPLATE = `# Batch permissions policy

Everything in this file is sent to the labeller model as additional policy and
overrides its built-in defaults. Write plain-sentence rules about what this
machine and workflow consider safe, caution, or dangerous. While this file
contains only this header, the built-in defaults apply unchanged.
`;

const CONFIG_TEMPLATE = {
	timeoutMs: 20000,
	mode: "all",
	tools: ["bash"],
};

let hasSeededFreshConfig = false;

// Seeds the config folder on load: migrates the pre-folder single-file layout,
// then writes templates for anything missing so a fresh install has editable
// files. No "model" key in the template: /batchmodel sets it.
function ensureConfigFiles(): void {
	const legacy = join(homedir(), ".pi", "agent", "batch-permissions.json");
	if (existsSync(legacy) && !existsSync(CONFIG_PATH)) {
		mkdirSync(CONFIG_DIR, { recursive: true });
		renameSync(legacy, CONFIG_PATH);
	}
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
	tools?: string[];
};

function readConfig(): Config {
	try {
		// Safe cast: every field is optional, and each consumer validates the
		// value it reads (isPermissionMode, string patterns, /batchmodel).
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

function getCurrentMode(): PermissionMode {
	return normalizeMode(readConfig().mode);
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

Respond with ONLY a JSON array in input order, no markdown fences:
[{"danger":"safe","purpose":"..."}]`;

type Decision = { isAllowed: boolean; assessment: Assessment };

const decisions = new Map<string, Decision>();

type GatedCall = {
	id: string;
	tool: string;
	args: Record<string, unknown>;
};

async function classifyCalls(
	calls: GatedCall[],
	taskContext: string,
	ctx: ExtensionContext,
): Promise<Assessment[]> {
	const { model: spec, timeoutMs = 20000 } = readConfig();
	const system = withPolicy(CLASSIFIER_SYSTEM, readPolicy());
	const inputs = calls.map((c) => ({ tool: c.tool, input: describeCall(c.tool, c.args) }));
	const model = findModel(spec, ctx);
	if (!model) return inputs.map((i) => getHeuristicAssessment(i.tool, i.input));

	const user: UserMessage = {
		role: "user",
		content: [{ type: "text", text: `Task context:\n${taskContext || "(none)"}\n\nTool calls:\n${JSON.stringify(inputs)}` }],
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
		if (parsed) return parsed;
	} catch {}
	return inputs.map((i) => getHeuristicAssessment(i.tool, i.input));
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

async function approveBatch(
	entries: GatedCall[],
	taskContext: string,
	ctx: ExtensionContext,
): Promise<void> {
	const mode = getCurrentMode();
	if (mode === "off") return;
	const assessments = await classifyCalls(entries, taskContext, ctx);
	const displays = entries.map((e) => describeCall(e.tool, e.args));
	let isAllowed: boolean;
	if (mode === "auto" && assessments.every((a) => a.danger !== "dangerous")) {
		isAllowed = true;
	} else if (ctx.hasUI) {
		isAllowed =
			(await ctx.ui.select(
				formatBatch(displays, assessments, getDialogStyle(ctx)),
				["Approve all", "Reject all"],
			)) === "Approve all";
	} else {
		// no UI: fail-safe, only clearly safe calls pass without a human
		isAllowed = assessments.every((a) => a.danger === "safe");
	}
	for (const [i, entry] of entries.entries()) {
		decisions.set(entry.id, { isAllowed, assessment: assessments[i] });
	}
}

export default function (pi: ExtensionAPI) {
	ensureConfigFiles();

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
		if (getCurrentMode() === "off") return;
		const taskContext = message.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.slice(0, 800);
		await approveBatch(calls, taskContext, ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!matchesTool(getGatedTools(), event.toolName)) return undefined;
		if (getCurrentMode() === "off") return undefined;
		if (!decisions.has(event.toolCallId)) {
			// Nested or otherwise unseen call (for example a codemode script): approve it on its own
			const entry: GatedCall = { id: event.toolCallId, tool: event.toolName, args: getCallArgs(event.input) };
			const [assessment] = await classifyCalls([entry], "", ctx);
			let isAllowed: boolean;
			if (getCurrentMode() === "auto" && assessment.danger !== "dangerous") {
				isAllowed = true;
			} else if (ctx.hasUI) {
				isAllowed = await ctx.ui.confirm(
					"Allow tool call?",
					formatSingle(describeCall(entry.tool, entry.args), assessment, getDialogStyle(ctx)),
				);
			} else {
				isAllowed = assessment.danger === "safe";
			}
			decisions.set(event.toolCallId, { isAllowed, assessment });
		}
		const decision = decisions.get(event.toolCallId);
		decisions.delete(event.toolCallId);
		// A missing decision is unreachable; blocking is the fail-safe default.
		if (!decision?.isAllowed) {
			return {
				block: true,
				reason: `User rejected this ${event.toolName} call: ${describeCall(event.toolName, getCallArgs(event.input))}`,
			};
		}
		return undefined;
	});

	pi.registerCommand("batchmodel", {
		description: "Show or set the model that labels tool calls for batch approval",
		handler: async (args, ctx) => {
			const current = readConfig().model ?? "(none, using local heuristics)";
			let value = args.trim();
			if (!value) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Classifier model: ${current}. Usage: /batchmodel provider/model-id`, "info");
					return;
				}
				const options = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
				if (options.length === 0) {
					ctx.ui.notify("No models available", "error");
					return;
				}
				const choice = await ctx.ui.select(
					`Batch-approval classifier (current: ${current}). Pick a model:`,
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
			ctx.ui.notify(`Batch-approval labels now use ${model.name} (${value})`, "info");
		},
	});

	const MODE_HINTS = {
		all: "every chain of gated tool calls needs one approval",
		auto: "auto-approve unless a call is dangerous",
		off: "no approval requests",
	} satisfies Record<PermissionMode, string>;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const mode = getCurrentMode();
		const color = mode === "all" ? "accent" : mode === "auto" ? "success" : "dim";
		const text =
			ctx.mode === "tui" ? ctx.ui.theme.fg(color, `perm:${mode}`) : `perm:${mode}`;
		ctx.ui.setStatus("batch-permissions", text);
	}

	pi.on("session_start", (_event, ctx) => {
		updateStatus(ctx);
		if (hasSeededFreshConfig && ctx.hasUI) {
			ctx.ui.notify(
				"batch-permissions: no labeller model set, using local heuristics. Pick one with /batchmodel.",
				"info",
			);
		}
	});

	pi.registerShortcut("alt+b", {
		description: "Cycle batch-permission mode (all, auto, off)",
		handler: (ctx) => {
			const mode = nextMode(getCurrentMode());
			writeConfig({ ...readConfig(), mode });
			updateStatus(ctx);
			if (ctx.hasUI) ctx.ui.notify(`Batch permissions: ${mode} (${MODE_HINTS[mode]})`, "info");
		},
	});
}
