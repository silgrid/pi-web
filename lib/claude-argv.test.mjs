import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { buildClaudeArgv, buildClaudeEnv, claudePresetTools } = await jiti.import("./claude-argv.ts");
const { claudeModelFlag, isClaudeModelAlias, isClaudeToolPreset, CLAUDE_MODEL_ALIASES } = await jiti.import("./claude-shared.ts");

const STREAM = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];

test("the read-only preset's exact argv: bare, strict MCP, no slash commands, dontAsk, Read/Glob/Grep", () => {
  assert.deepEqual(buildClaudeArgv({ sessionId: "s-1", resume: false, modelAlias: "sonnet", preset: "read-only" }), [
    ...STREAM,
    "--bare", "--strict-mcp-config", "--disable-slash-commands",
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
    "--model", "sonnet",
    "--session-id", "s-1",
  ]);
});

test("the read-only argv names no Bash, Edit, Write, web tool or Agent", () => {
  const joined = buildClaudeArgv({ sessionId: "s", resume: false, modelAlias: "opus", preset: "read-only" }).join(" ");
  for (const tool of ["Bash", "Edit", "Write", "WebSearch", "WebFetch", "Agent"]) {
    assert.doesNotMatch(joined, new RegExp(`\\b${tool}\\b`));
  }
});

test("the writable preset's exact argv: acceptEdits, Bash available but not pre-approved, no bare / strict MCP", () => {
  const argv = buildClaudeArgv({ sessionId: "s-2", resume: false, modelAlias: "haiku", preset: "writable" });
  assert.deepEqual(argv, [
    ...STREAM,
    "--permission-mode", "acceptEdits", "--permission-prompts", "none",
    "--tools", "Read,Glob,Grep,Edit,Write,Bash", "--allowedTools", "Read,Glob,Grep,Edit,Write",
    "--model", "haiku",
    "--session-id", "s-2",
  ]);
  assert.ok(!argv.includes("--bare"));
  assert.ok(!argv.includes("--strict-mcp-config"));
});

test("claude-default passes no --model; each other alias passes exactly itself", () => {
  const argv = buildClaudeArgv({ sessionId: "s", resume: false, modelAlias: "claude-default", preset: "read-only" });
  assert.ok(!argv.includes("--model"));
  assert.equal(claudeModelFlag("claude-default"), undefined);
  for (const alias of ["sonnet", "opus", "haiku"]) {
    const flags = buildClaudeArgv({ sessionId: "s", resume: false, modelAlias: alias, preset: "writable" });
    assert.equal(flags[flags.indexOf("--model") + 1], alias);
    assert.equal(flags.filter((flag) => flag === "--model").length, 1);
  }
});

test("the first launch carries --session-id, a restart --resume with the same id and never both", () => {
  const first = buildClaudeArgv({ sessionId: "abc", resume: false, modelAlias: "sonnet", preset: "read-only" });
  const again = buildClaudeArgv({ sessionId: "abc", resume: true, modelAlias: "sonnet", preset: "read-only" });
  assert.deepEqual(first.slice(-2), ["--session-id", "abc"]);
  assert.ok(!first.includes("--resume"));
  assert.deepEqual(again.slice(-2), ["--resume", "abc"]);
  assert.ok(!again.includes("--session-id"));
});

test("the child env drops PI_WEB_PASSWORD, ANTHROPIC_* and CLAUDE_*, sets CLAUDE_CONFIG_DIR and leaves the base untouched", () => {
  const base = {
    PATH: "/bin",
    HOME: "/home/u",
    PI_WEB_PASSWORD: "x",
    ANTHROPIC_API_KEY: "x",
    ANTHROPIC_BASE_URL: "x",
    CLAUDE_CONFIG_DIR: "/elsewhere",
    CLAUDE_CODE_SIMPLE: "1",
    CLAUDECODE: "1",
    PI_WEB_IDLE_TIMEOUT_MS: "5",
  };
  const snapshot = { ...base };
  const env = buildClaudeEnv(base, "/agent/claude");
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/u", PI_WEB_IDLE_TIMEOUT_MS: "5", CLAUDE_CONFIG_DIR: "/agent/claude" });
  assert.deepEqual(base, snapshot);
});

test("validators accept exactly the fixed sets; preset tools follow the preset", () => {
  assert.deepEqual([...CLAUDE_MODEL_ALIASES], ["sonnet", "opus", "haiku", "claude-default"]);
  assert.ok(isClaudeModelAlias("haiku"));
  assert.ok(!isClaudeModelAlias("claude-opus-4"));
  assert.ok(isClaudeToolPreset("writable"));
  assert.ok(!isClaudeToolPreset("full"));
  assert.deepEqual([...claudePresetTools("read-only")], ["Read", "Glob", "Grep"]);
  assert.deepEqual([...claudePresetTools("writable")], ["Read", "Glob", "Grep", "Edit", "Write", "Bash"]);
});
