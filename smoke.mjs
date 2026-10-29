import assert from "node:assert/strict";
import {
	describeCall,
	matchesTool,
	parseAssessments,
	formatBatch,
	formatSingle,
	formatUnlabeled,
	normalizeMode,
	normalizeShortcut,
	isPermissionMode,
	nextMode,
	withPolicy,
} from "./core.ts";

// permission modes
assert.equal(normalizeMode(undefined), "fastened");
assert.equal(normalizeMode("fastened"), "fastened");
assert.equal(normalizeMode("auto"), "auto");
assert.equal(normalizeMode("unfastened"), "unfastened");
// pre-rename values are no longer valid and fall back to the default
assert.equal(normalizeMode("all"), "fastened");
assert.equal(normalizeMode("off"), "fastened");
assert.equal(normalizeMode("nonsense"), "fastened");
assert.equal(nextMode("fastened"), "auto");
assert.equal(nextMode("auto"), "unfastened");
assert.equal(nextMode("unfastened"), "fastened");
assert.ok(isPermissionMode("fastened"));
assert.ok(isPermissionMode("auto"));
assert.ok(isPermissionMode("unfastened"));
assert.ok(!isPermissionMode("all"));
assert.ok(!isPermissionMode("off"));
assert.ok(!isPermissionMode("nonsense"));
assert.ok(!isPermissionMode(undefined));

// shortcut normalization
assert.equal(normalizeShortcut(undefined), "alt+b");
assert.equal(normalizeShortcut(null), "alt+b");
assert.equal(normalizeShortcut(42), "alt+b");
assert.equal(normalizeShortcut(""), "alt+b");
assert.equal(normalizeShortcut("   "), "alt+b");
assert.equal(normalizeShortcut("alt b"), "alt+b");
assert.equal(normalizeShortcut("alt+b"), "alt+b");
assert.equal(normalizeShortcut("  ctrl+shift+b  "), "ctrl+shift+b");
assert.equal(normalizeShortcut("f9"), "f9");

// policy merge
assert.equal(withPolicy("BASE", ""), "BASE");
assert.equal(withPolicy("BASE", "  \n\t"), "BASE");
assert.equal(
	withPolicy("BASE", "docker commands are dangerous"),
	"BASE\n\nThe user's own policy below overrides the defaults above:\n\ndocker commands are dangerous",
);

// tool matching
assert.ok(matchesTool(["bash"], "bash"));
assert.ok(!matchesTool(["bash"], "read"));
assert.ok(matchesTool(["bash", "write"], "write"));
assert.ok(matchesTool(["mcp__slack__*"], "mcp__slack__send_message"));
assert.ok(!matchesTool(["mcp__slack__*"], "mcp__github__create_issue"));
assert.ok(matchesTool(["*"], "anything"));
assert.ok(matchesTool(["mcp__atlassian__*"], "mcp__atlassian__jira_create_issue"));

// call description
assert.equal(describeCall("bash", { command: "ls -la", timeout: 5 }), "ls -la");
assert.equal(describeCall("read", { path: "a.txt" }), 'read {"path":"a.txt"}');
assert.equal(describeCall("ls", {}), "ls");
assert.ok(describeCall("write", { path: "a", content: "x".repeat(600) }).includes("…(truncated)"));

// parser
assert.deepEqual(
	parseAssessments('[{"danger":"safe","purpose":"list files","risk":""}]', 1),
	[{ danger: "safe", purpose: "list files", risk: "" }],
);
assert.equal(
	parseAssessments('[{"danger":"dangerous","purpose":"x","risk":"destroys data"}]', 1)?.[0].risk,
	"destroys data",
);
assert.deepEqual(parseAssessments('[{"danger":"safe"}]', 1), [
	{ danger: "safe", purpose: "(no purpose given)", risk: "" },
]);
assert.equal(parseAssessments('```json\n[{"danger":"caution","purpose":"x"}]\n```', 1)?.[0].danger, "caution");
assert.equal(parseAssessments('[{"danger":"weird","purpose":"x"}]', 1), undefined);
assert.equal(parseAssessments('[{"danger":"safe"}, {"danger":"safe"}]', 1), undefined);
assert.equal(parseAssessments("[]", 1), undefined);
assert.equal(parseAssessments("no json here", 1), undefined);
assert.deepEqual(
	parseAssessments('[{"danger":"safe","purpose":"a"},{"danger":"dangerous","purpose":"b"}]', 2).map(
		(a) => a.danger,
	),
	["safe", "dangerous"],
);

// formatting
const batch = formatBatch(
	["ls -la", "rm -rf /tmp/batch-demo"],
	[
		{ danger: "safe", purpose: "list files", risk: "" },
		{ danger: "dangerous", purpose: "remove the demo directory", risk: "recursive delete, cannot be undone" },
	],
);
assert.match(batch, /Approve 2 tool calls\?/);
assert.match(batch, /1\s+✓ safe$/m);
assert.match(batch, /2\s+✗ DANGEROUS$/m);
assert.match(batch, /> ls -la/);
assert.match(batch, /> rm -rf \/tmp\/batch-demo/);
assert.match(batch, /What it does: list files/);
assert.match(batch, /What it does: remove the demo directory/);
assert.match(batch, /Why it's dangerous: recursive delete, cannot be undone/);
assert.ok(!batch.includes("Why it's dangerous: list files"));
assert.match(batch, /One approval covers every tool call/);
const single = formatBatch(["ls"], [{ danger: "safe", purpose: "x", risk: "" }]);
assert.match(single, /Approve this tool call\?/);
assert.match(single, /> ls/);
assert.ok(!single.includes(" 1  "));
assert.ok(!single.includes("One approval covers"));
assert.match(
	formatSingle("rm -rf /", { danger: "dangerous", purpose: "delete everything", risk: "irreversible" }),
	/✗ DANGEROUS\n\s+> rm -rf \/\n\s+What it does: delete everything\n\s+Why it's dangerous: irreversible/,
);
// plain style passes fragments through untouched
assert.doesNotMatch(formatBatch(["ls"], [{ danger: "safe", purpose: "x", risk: "" }]), /\u001b\[/);

// unlabeled dialog when the classifier fails
const unlabeledSingle = formatUnlabeled(["ls -la"]);
assert.match(unlabeledSingle, /Approve this tool call\?/);
assert.match(unlabeledSingle, /! classifier unavailable: these calls could not be labeled/);
assert.match(unlabeledSingle, /> ls -la/);
assert.ok(!unlabeledSingle.includes("One approval covers"));
assert.ok(!unlabeledSingle.includes("What it does:"));
const unlabeledBatch = formatUnlabeled(["ls -la", "rm -rf /tmp/batch-demo"]);
assert.match(unlabeledBatch, /Approve 2 tool calls\?/);
assert.match(unlabeledBatch, /> ls -la/);
assert.match(unlabeledBatch, /> rm -rf \/tmp\/batch-demo/);
assert.match(unlabeledBatch, /One approval covers every tool call/);
assert.ok(!unlabeledBatch.includes("What it does:"));
assert.ok(!unlabeledBatch.includes("DANGEROUS"));

console.log("pi-seatbelt core: all checks passed");
