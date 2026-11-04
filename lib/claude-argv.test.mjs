import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const argvModule = await jiti.import("./claude-argv.ts");
const { buildClaudeArgv, buildClaudeEnv } = argvModule;

const STREAM = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
const RETIRED_FLAGS = ["--bare", "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "--tools", "--allowedTools", "--cwd"];

test("the first launch's exact reduced argv: stream-json, the full model name, no prompts, --session-id", () => {
  assert.deepEqual(buildClaudeArgv({ sessionId: "s-1", resume: false, model: "claude-haiku-5-5" }), [
    ...STREAM,
    "--model", "claude-haiku-5-5",
    "--permission-prompts", "none",
    "--session-id", "s-1",
  ]);
});

test("a restart carries --resume with the same id and model, never --session-id", () => {
  const first = buildClaudeArgv({ sessionId: "abc", resume: false, model: "claude-sonnet-5-5" });
  const again = buildClaudeArgv({ sessionId: "abc", resume: true, model: "claude-sonnet-5-5" });
  assert.deepEqual(again, [...STREAM, "--model", "claude-sonnet-5-5", "--permission-prompts", "none", "--resume", "abc"]);
  assert.ok(!first.includes("--resume"));
  assert.ok(!again.includes("--session-id"));
});

test("no preset, tool or permission-mode flag and no --cwd; exactly one --model with the full name", () => {
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) {
    for (const resume of [false, true]) {
      const argv = buildClaudeArgv({ sessionId: "s", resume, model });
      for (const flag of RETIRED_FLAGS) assert.ok(!argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`)), flag);
      assert.equal(argv.filter((arg) => arg === "--model").length, 1);
      assert.equal(argv[argv.indexOf("--model") + 1], model);
      assert.equal(argv.length, 13);
    }
  }
  for (const name of ["claudePresetTools", "CLAUDE_READ_ONLY_TOOLS", "CLAUDE_WRITABLE_TOOLS", "CLAUDE_WRITABLE_ALLOWED_TOOLS"]) {
    assert.equal(argvModule[name], undefined, name);
  }
});

test("the child env inherits ANTHROPIC_* and CLAUDE_*, drops only PI_WEB_PASSWORD and CLAUDECODE, injects nothing and leaves the base untouched", () => {
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
    UNSET: undefined,
  };
  const snapshot = { ...base };
  const env = buildClaudeEnv(base);
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/home/u",
    ANTHROPIC_API_KEY: "x",
    ANTHROPIC_BASE_URL: "x",
    CLAUDE_CONFIG_DIR: "/elsewhere",
    CLAUDE_CODE_SIMPLE: "1",
    PI_WEB_IDLE_TIMEOUT_MS: "5",
  });
  assert.deepEqual(base, snapshot);
});

test("without an inherited CLAUDE_CONFIG_DIR the child gets none", () => {
  const env = buildClaudeEnv({ PATH: "/bin", HOME: "/home/u", PI_WEB_PASSWORD: "" });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/u" });
  assert.ok(!("CLAUDE_CONFIG_DIR" in env));
  assert.ok(!("PI_WEB_PASSWORD" in env), "withheld by name, even when empty");
});

test("the default effort keeps today's argv; a level adds exactly --effort <level> after --model", () => {
  const plain = buildClaudeArgv({ sessionId: "s", resume: false, model: "claude-opus-5-5" });
  assert.deepEqual(buildClaudeArgv({ sessionId: "s", resume: false, model: "claude-opus-5-5", effort: "default" }), plain);
  assert.ok(!plain.includes("--effort"));
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    for (const resume of [false, true]) {
      const argv = buildClaudeArgv({ sessionId: "s", resume, model: "claude-opus-5-5", effort });
      assert.deepEqual(argv.slice(STREAM.length, STREAM.length + 6), ["--model", "claude-opus-5-5", "--effort", effort, "--permission-prompts", "none"]);
      assert.equal(argv.filter((arg) => arg === "--effort").length, 1);
      assert.equal(argv.length, 15);
      for (const flag of RETIRED_FLAGS) assert.ok(!argv.includes(flag), flag);
    }
  }
});

const INSTRUCTION = "Use Simplified Chinese (简体中文) for replies, narration and reports. Keep code, code comments, commit messages, files you write, technical terms and identifiers as they are, or as the project's conventions require. Thinking in Chinese is best effort only.";

test("English or absent Agent language keeps the exact pre-feature argv; 中文 adds --append-system-prompt <fixed text> before --permission-prompts on every launch", () => {
  for (const resume of [false, true]) {
    const tail = resume ? ["--resume", "s"] : ["--session-id", "s"];
    const plain = [...STREAM, "--model", "claude-haiku-5-5", "--permission-prompts", "none", ...tail];
    assert.deepEqual(buildClaudeArgv({ sessionId: "s", resume, model: "claude-haiku-5-5" }), plain);
    assert.deepEqual(buildClaudeArgv({ sessionId: "s", resume, model: "claude-haiku-5-5", agentLanguage: "en" }), plain);
    const zh = buildClaudeArgv({ sessionId: "s", resume, model: "claude-haiku-5-5", agentLanguage: "zh-CN" });
    assert.deepEqual(zh, [...STREAM, "--model", "claude-haiku-5-5", "--append-system-prompt", INSTRUCTION, "--permission-prompts", "none", ...tail]);
    const withEffort = buildClaudeArgv({ sessionId: "s", resume, model: "claude-opus-5-5", effort: "high", agentLanguage: "zh-CN" });
    assert.deepEqual(withEffort.slice(STREAM.length, STREAM.length + 8), ["--model", "claude-opus-5-5", "--effort", "high", "--append-system-prompt", INSTRUCTION, "--permission-prompts", "none"]);
    for (const flag of RETIRED_FLAGS) assert.ok(!zh.includes(flag), flag);
    assert.equal(zh.filter((arg) => arg === "--append-system-prompt").length, 1);
  }
});
