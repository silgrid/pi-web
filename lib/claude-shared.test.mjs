import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const shared = await jiti.import("./claude-shared.ts");
const { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL, isClaudeModel, normalizeClaudeModel } = shared;

test("the claude models are the four full names claude 2.1.312 offers, opus the default", () => {
  assert.deepEqual([...CLAUDE_MODELS], ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
  assert.equal(DEFAULT_CLAUDE_MODEL, "claude-opus-5-5");
});

test("only a full name is a claude model; a bare alias or the old default entry is not", () => {
  for (const model of CLAUDE_MODELS) assert.ok(isClaudeModel(model), model);
  for (const value of ["opus", "sonnet", "haiku", "fable", "claude-default", "claude-opus-4", "", null, undefined, 5]) {
    assert.ok(!isClaudeModel(value), String(value));
  }
});

test("legacy index values map to full names; anything else reads as the default and never throws", () => {
  assert.equal(normalizeClaudeModel("opus"), "claude-opus-5-5");
  assert.equal(normalizeClaudeModel("claude-default"), "claude-opus-5-5");
  assert.equal(normalizeClaudeModel("sonnet"), "claude-sonnet-5-5");
  assert.equal(normalizeClaudeModel("haiku"), "claude-haiku-5-5");
  for (const model of CLAUDE_MODELS) assert.equal(normalizeClaudeModel(model), model);
  for (const value of ["not-a-claude-model", "toString", "__proto__", "", undefined, null, 1, {}]) {
    assert.equal(normalizeClaudeModel(value), DEFAULT_CLAUDE_MODEL, String(value));
  }
});

test("the alias, preset and flag helpers of #219 are gone", () => {
  for (const name of ["CLAUDE_MODEL_ALIASES", "CLAUDE_TOOL_PRESETS", "DEFAULT_CLAUDE_MODEL_ALIAS", "DEFAULT_CLAUDE_TOOL_PRESET", "isClaudeModelAlias", "isClaudeToolPreset", "claudeModelFlag"]) {
    assert.equal(shared[name], undefined, name);
  }
});

test("claudeFirstMessage: the typed text as is, else [Image] with images, else empty", () => {
  assert.equal(shared.CLAUDE_IMAGE_FIRST_MESSAGE, "[Image]");
  assert.equal(shared.claudeFirstMessage("hello ", 2), "hello ");
  assert.equal(shared.claudeFirstMessage("", 1), "[Image]");
  assert.equal(shared.claudeFirstMessage("  ", 1), "[Image]");
  assert.equal(shared.claudeFirstMessage("", 0), "");
});

test("claude's effort levels are exactly low/medium/high/xhigh/max plus the default entry", () => {
  assert.deepEqual([...shared.CLAUDE_EFFORT_LEVELS], ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(shared.CLAUDE_EFFORT_DEFAULT, "default");
  for (const level of shared.CLAUDE_EFFORT_LEVELS) assert.ok(shared.isClaudeEffort(level) && shared.isClaudeEffortLevel(level), level);
  assert.ok(shared.isClaudeEffort("default") && !shared.isClaudeEffortLevel("default"));
  for (const invented of ["off", "minimal", "auto", "", null, undefined, 3]) assert.ok(!shared.isClaudeEffort(invented), String(invented));
});

test("a stored effort reads tolerantly: a level stays, anything else is the default entry", () => {
  for (const level of shared.CLAUDE_EFFORT_LEVELS) assert.equal(shared.normalizeClaudeEffort(level), level);
  for (const value of [undefined, null, "default", "off", "minimal", "auto", "MAX", 7, {}]) assert.equal(shared.normalizeClaudeEffort(value), "default", String(value));
});

test("no effort level is hidden without a recording of claude refusing it", () => {
  assert.deepEqual(shared.CLAUDE_EFFORT_EXCLUSIONS, {});
});
