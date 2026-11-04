import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const view = await jiti.import("./claude-subagent-view.ts");

const entry = (id, text) => ({ id, message: { role: "assistant", content: [{ type: "text", text }] } });
const run = (over = {}) => ({ toolCallId: "toolu_a", background: true, status: "running", entries: [], ...over });

test("merging keeps one copy per entry id and appends new ids once, in order", () => {
  const history = run({ entries: [entry("e1", "one"), entry("e2", "two")] });
  const merged = view.mergeClaudeSubagentRun(history, run({ entries: [entry("e2", "two"), entry("e3", "three")] }));
  assert.deepEqual(merged.entries.map((item) => item.id), ["e1", "e2", "e3"]);
  const again = view.mergeClaudeSubagentRun(merged, run({ entries: [entry("e1", "one"), entry("e2", "two"), entry("e3", "three")] }));
  assert.deepEqual(again.entries.map((item) => item.id), ["e1", "e2", "e3"], "a reload of the same entries adds nothing");
});

test("header fields take the incoming value, and a settled status never returns to running", () => {
  const settled = view.mergeClaudeSubagentRun(run({ progress: "Reading" }), run({ status: "completed", usage: { totalTokens: 5, toolUses: 1, durationMs: 9 } }));
  assert.equal(settled.status, "completed");
  assert.equal(settled.progress, "Reading", "an absent field keeps the held one");
  const stale = view.mergeClaudeSubagentRun(settled, run({ status: "running" }));
  assert.equal(stale.status, "completed", "a later running copy (an older read) does not reopen the run");
  assert.deepEqual(stale.usage, { totalTokens: 5, toolUses: 1, durationMs: 9 });
});

test("merging a run list builds a map by tool call id and returns the same map for nothing", () => {
  const empty = {};
  assert.equal(view.mergeClaudeSubagentRuns(empty, []), empty);
  const runs = view.mergeClaudeSubagentRuns(empty, [run({ entries: [entry("e1", "x")] }), run({ toolCallId: "toolu_b" })]);
  assert.deepEqual(Object.keys(runs), ["toolu_a", "toolu_b"]);
});

test("a row opens by default while running, failed or interrupted and stays closed once completed; a manual toggle wins", () => {
  assert.equal(view.isClaudeSubagentExpandedByDefault("running"), true);
  assert.equal(view.isClaudeSubagentExpandedByDefault("failed"), true);
  assert.equal(view.isClaudeSubagentExpandedByDefault("completed"), false);
  assert.equal(view.isClaudeSubagentExpandedByDefault("stopped"), true, "an interrupted run stays open like an error");
  assert.equal(view.isClaudeSubagentExpanded({ toolCallId: "toolu_manual", status: "running" }), true);
  view.setClaudeSubagentManualExpansion("toolu_manual", false);
  assert.equal(view.isClaudeSubagentExpanded({ toolCallId: "toolu_manual", status: "running" }), false, "collapsed by hand stays collapsed");
  view.setClaudeSubagentManualExpansion("toolu_manual", true);
  assert.equal(view.isClaudeSubagentExpanded({ toolCallId: "toolu_manual", status: "completed" }), true, "expanded by hand stays open after finishing");
});

test("header statistics show only known parts, tokens with grouping", () => {
  assert.deepEqual(view.claudeSubagentStatParts(undefined), {});
  assert.deepEqual(view.claudeSubagentStatParts({ totalTokens: 10379, toolUses: 1, durationMs: 1906 }), { toolUses: 1, durationMs: 1906, totalTokens: 10379 });
  assert.deepEqual(view.claudeSubagentStatParts({ totalTokens: 0, toolUses: 0, durationMs: 0 }), {});
  assert.equal(view.formatClaudeSubagentTokens(10379, "en"), "10,379");
  assert.equal(view.CLAUDE_SUBAGENT_PAGE_SIZE, 25);
  assert.equal(view.isClaudeSubagentToolName("Agent"), true);
  assert.equal(view.isClaudeSubagentToolName("Task"), true);
  assert.equal(view.isClaudeSubagentToolName("Read"), false);
});

test("a history read wins for the entry ids it carries and keeps the later live ones", () => {
  const live = view.mergeClaudeSubagentRuns({}, [run({ entries: [entry("e1", "streamed"), entry("e2", "two"), entry("e3", "after the read")] })]);
  const merged = view.mergeClaudeSubagentHistory(live, [run({ status: "running", entries: [entry("e1", "stored"), entry("e2", "two")] })]);
  assert.deepEqual(merged.toolu_a.entries.map((item) => [item.id, item.message.content[0].text]), [["e1", "stored"], ["e2", "two"], ["e3", "after the read"]]);
  assert.equal(view.mergeClaudeSubagentHistory(live, undefined), live, "a detail without the field changes nothing");
});

test("the body keeps tool results out of the steps and shows the final reply once, as the Result", () => {
  const call = { id: "c1", message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "t", toolName: "Read", input: {} }] } };
  const result = { id: "r1", message: { role: "toolResult", toolCallId: "t", content: [] } };
  const running = view.claudeSubagentBody(run({ entries: [call, result, entry("e1", "TOKEN")] }));
  assert.deepEqual(running.steps.map((item) => item.id), ["c1", "e1"]);
  assert.equal(running.settled, false);
  const done = view.claudeSubagentBody(run({ status: "completed", result: "TOKEN", entries: [call, result, entry("e1", "TOKEN")] }));
  assert.deepEqual(done.steps.map((item) => item.id), ["c1"]);
  assert.equal(done.result, "TOKEN");
  const other = view.claudeSubagentBody(run({ status: "completed", result: "summary", entries: [entry("e1", "TOKEN")] }));
  assert.deepEqual(other.steps.map((item) => item.id), ["e1"], "a different last reply stays a step");
  assert.equal(view.claudeSubagentBody(run({ status: "failed" })).result, null, "no result: the row says so");
});

test("only a step made solely of running background Agent calls stays out of the fold", () => {
  const call = (toolCallId, toolName = "Agent") => ({ type: "toolCall", toolCallId, toolName });
  const runs = {
    bg: run({ toolCallId: "bg" }),
    fg: run({ toolCallId: "fg", background: false }),
    done: run({ toolCallId: "done", status: "completed" }),
  };
  assert.equal(view.isRunningBackgroundAgentMessage([call("bg")], runs), true);
  assert.equal(view.isRunningBackgroundAgentMessage([call("bg", "Task")], runs), true);
  assert.equal(view.isRunningBackgroundAgentMessage([call("done")], runs), false, "settled: back into the fold");
  assert.equal(view.isRunningBackgroundAgentMessage([call("fg")], runs), false, "a foreground call is an ordinary step");
  assert.equal(view.isRunningBackgroundAgentMessage([call("bg"), { type: "text", text: "x" }], runs), false, "a step with anything else folds");
  assert.equal(view.isRunningBackgroundAgentMessage([call("bg", "Read")], runs), false);
  assert.equal(view.isRunningBackgroundAgentMessage([call("missing")], runs), false, "no run (a pi session): unchanged");
  assert.equal(view.isRunningBackgroundAgentMessage([], runs), false);
});
