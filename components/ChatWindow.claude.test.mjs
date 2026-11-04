import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatWindow = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const hook = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");

test("a claude session offers no fork, edit-from-here, ask-in-new-chat or compaction recovery", () => {
  assert.match(chatWindow, /onFork=\{bashRunning \|\| isNew \|\| isClaudeSession \? undefined : handleFork\}/);
  assert.match(hook, /handleEditContent: isClaudeSession \? undefined : handleEditContent/);
  assert.match(chatWindow, /onAskInNewChat && !isClaudeSession && quotedSelection\.sourceEntryId/);
  assert.match(chatWindow, /onCompact=\{options\.recoverTruncation && !isClaudeSession \? handleCompact : undefined\}/);
});

// rewrote #250's "hides the pi model, reasoning and compact controls": claude gets
// its own model / effort handlers (through `claude`) and compacts in an open session.
test("a claude session gets claude's model, effort and compact handlers; still no pi model, reasoning, tools, steer or built-in commands", () => {
  for (const pattern of [
    /onModelChange=\{isClaudeSession \? undefined : handleModelChange\}/,
    /onCompact=\{\(session \|\| isNew\) && !\(isNew && isClaudeSession\) \? handleCompact : undefined\}/,
    /onAbortCompaction=\{isClaudeSession \? handleAbort : handleAbortCompaction\}/,
    /onToolPresetChange=\{\(session \|\| isNew\) && !isClaudeSession \? handleToolPresetChange : undefined\}/,
    /onThinkingLevelChange=\{\(session \|\| isNew\) && !isClaudeSession \? handleThinkingLevelChange : undefined\}/,
    /onSteer=\{isActivePane && agentRunning && !isClaudeSession \? handleSteer : undefined\}/,
    /onFollowUp=\{isActivePane && agentRunning && !isClaudeSession \? handleFollowUp : undefined\}/,
    /onBuiltinCommand=\{isClaudeSession \? undefined : handleBuiltinSlashCommand\}/,
    /claude=\{claudeComposer\}/,
  ]) assert.match(chatWindow, pattern);
});

test("a fresh composer passes the harness switch (with its model reset), the claude model and effort; an open claude session switches model and effort, never the harness", () => {
  const block = chatWindow.slice(chatWindow.indexOf("const claudeComposer = useMemo"), chatWindow.indexOf("// External-write signal"));
  const fresh = block.slice(block.indexOf("if (isNew)"), block.indexOf("if (!isClaudeSession)"));
  assert.match(fresh, /choosing: true/);
  assert.match(fresh, /model: newSessionClaudeModel/);
  assert.match(fresh, /onHarnessChange: chooseNewSessionHarness/);
  assert.match(fresh, /onModelChange: setNewSessionClaudeModel/);
  assert.match(fresh, /effort: newSessionClaudeEffort/);
  assert.match(fresh, /onEffortChange: handleClaudeEffortChange/);
  const open = block.slice(block.indexOf("if (!isClaudeSession)"));
  assert.match(open, /choosing: false/);
  assert.match(open, /model: normalizeClaudeModel\(claudeSessionChoices\?\.model\)/);
  assert.match(open, /effort: normalizeClaudeEffort\(claudeSessionChoices\?\.effort\)/);
  assert.match(open, /onModelChange: handleClaudeModelChange/);
  assert.match(open, /onEffortChange: handleClaudeEffortChange/);
  assert.match(open, /switchError: claudeSwitchError/);
  assert.doesNotMatch(open, /onHarnessChange/, "an open claude session gets no harness switch");
  assert.match(hook, /const chooseNewSessionHarness = useCallback/);
});

test("the chat hands a claude session's subagent runs to every Agent row, listed or streamed", () => {
  assert.match(chatWindow, /claudeAvailability, claudeSubagents,\n  \} = useAgentSession\(/);
  assert.match(chatWindow, /<ClaudeSubagentContext\.Provider value=\{claudeSubagents\}>/);
  const provider = chatWindow.indexOf("<ClaudeSubagentContext.Provider");
  assert.ok(provider < chatWindow.indexOf("<StreamingReply store="), "the streaming reply is inside the provider");
  assert.ok(provider < chatWindow.indexOf("key={`${keyPrefix}-view-${messageKey}`}"), "the listed messages are inside the provider");
  assert.match(hook, /claudeSubagents: claudeSubagentState\.sessionId !== null/);
});

test("a running background Agent step renders outside the folded process details, after them, and nothing else leaves the fold", () => {
  assert.match(chatWindow, /if \(processIdx !== finalAssistantIdx && isRunningBackgroundAgentMessage\(blocks, claudeSubagents\)\) \{\n\s*runningSubagentViews\.push\(renderMessage\(processIdx, \{ attachRef: false, keyPrefix: "subagent", showTimestamp: false \}\)\);\n\s*continue;\n\s*\}/);
  const group = chatWindow.indexOf("<ProcessDetailsGroup key={answered");
  const outside = chatWindow.indexOf("rendered.push(...runningSubagentViews);");
  assert.ok(group > 0 && outside > group, "the running row follows the fold, at the turn's top level");
  assert.ok(outside < chatWindow.indexOf("const writtenFiles = keepWrittenFiles"), "before the final answer");
  assert.equal(chatWindow.split("isRunningBackgroundAgentMessage(").length - 1, 1, "one fold exception");
});
