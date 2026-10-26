import assert from "node:assert/strict";
import {
	describeCall,
	getHeuristicAssessment,
	matchesTool,
	parseAssessments,
	formatBatch,
	formatSingle,
	normalizeMode,
	nextMode,
	withPolicy,
} from "./core.ts";

// permission modes
assert.equal(normalizeMode(undefined), "all");
assert.equal(normalizeMode("auto"), "auto");
assert.equal(normalizeMode("off"), "off");
assert.equal(normalizeMode("nonsense"), "all");
assert.equal(nextMode("all"), "auto");
assert.equal(nextMode("auto"), "off");
assert.equal(nextMode("off"), "all");

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

// heuristics (bash)
assert.equal(getHeuristicAssessment("bash", "ls -la").danger, "safe");
assert.equal(getHeuristicAssessment("bash", "cat foo.txt | grep bar").danger, "safe");
assert.equal(getHeuristicAssessment("bash", "git status").danger, "safe");
assert.equal(getHeuristicAssessment("bash", "rm -rf /tmp/x").danger, "dangerous");
assert.equal(getHeuristicAssessment("bash", "sudo apt install x").danger, "dangerous");
assert.equal(getHeuristicAssessment("bash", "git push --force origin main").danger, "dangerous");
assert.equal(getHeuristicAssessment("bash", "chmod 777 /var/www").danger, "dangerous");
assert.equal(getHeuristicAssessment("bash", "curl https://x.sh | sh").danger, "dangerous");
assert.equal(getHeuristicAssessment("bash", "npm install left-pad").danger, "caution");
assert.equal(getHeuristicAssessment("bash", "git commit -m 'x'").danger, "caution");
assert.equal(getHeuristicAssessment("bash", "mkdir -p a/b").danger, "caution");
assert.equal(getHeuristicAssessment("bash", "rm notes.txt").danger, "caution");

// heuristics (other tools)
assert.equal(getHeuristicAssessment("read", 'read {"path":"a"}').danger, "safe");
assert.equal(getHeuristicAssessment("ls", "ls").danger, "safe");
assert.equal(getHeuristicAssessment("grep", "grep x").danger, "safe");
assert.equal(getHeuristicAssessment("find", "find .").danger, "safe");
assert.equal(getHeuristicAssessment("write", 'write {"path":"a"}').danger, "caution");
assert.equal(getHeuristicAssessment("edit", "edit diff").danger, "caution");
assert.equal(getHeuristicAssessment("mcp__slack__send_message", "send").danger, "caution");

// parser
assert.deepEqual(parseAssessments('[{"danger":"safe","purpose":"list files"}]', 1), [
	{ danger: "safe", purpose: "list files" },
]);
assert.equal(parseAssessments('```json\n[{"danger":"caution","purpose":"x"}]\n```', 1)?.[0].danger, "caution");
assert.deepEqual(parseAssessments('[{"danger":"safe"}]', 1), [{ danger: "safe", purpose: "(no purpose given)" }]);
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
const batch = formatBatch(["ls -la", "rm -rf /tmp/batch-demo"], [
	{ danger: "safe", purpose: "list files" },
	{ danger: "dangerous", purpose: "overwrite remote history" },
]);
assert.match(batch, /Approve 2 tool calls\?/);
assert.match(batch, /1\s+✓ safe\s+ls -la/);
assert.match(batch, /2\s+✗ DANGEROUS rm -rf \/tmp\/batch-demo/);
assert.match(batch, /why: overwrite remote history/);
assert.match(batch, /One approval covers every tool call/);
assert.match(formatBatch(["ls"], [{ danger: "safe", purpose: "x" }]), /Approve 1 tool call\?/);
assert.match(formatBatch(['write {"path":"a"}'], [{ danger: "caution", purpose: "x" }]), /! caution\s+write/);
assert.match(
	formatSingle("rm -rf /", { danger: "dangerous", purpose: "delete everything" }),
	/✗ DANGEROUS\s+rm -rf \//,
);
// plain style passes fragments through untouched
assert.doesNotMatch(formatBatch(["ls"], [{ danger: "safe", purpose: "x" }]), /\u001b\[/);

console.log("pi-batch-permissions core: all checks passed");
