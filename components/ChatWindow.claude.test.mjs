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

test("a claude session hides the pi model, reasoning, tools, compact, steer and built-in command controls", () => {
  for (const pattern of [
    /onModelChange=\{isClaudeSession \? undefined : handleModelChange\}/,
    /onCompact=\{\(session \|\| isNew\) && !isClaudeSession \? handleCompact : undefined\}/,
    /onToolPresetChange=\{\(session \|\| isNew\) && !isClaudeSession \? handleToolPresetChange : undefined\}/,
    /onThinkingLevelChange=\{\(session \|\| isNew\) && !isClaudeSession \? handleThinkingLevelChange : undefined\}/,
    /onSteer=\{isActivePane && agentRunning && !isClaudeSession \? handleSteer : undefined\}/,
    /onFollowUp=\{isActivePane && agentRunning && !isClaudeSession \? handleFollowUp : undefined\}/,
    /onBuiltinCommand=\{isClaudeSession \? undefined : handleBuiltinSlashCommand\}/,
    /claude=\{claudeComposer\}/,
  ]) assert.match(chatWindow, pattern);
});
