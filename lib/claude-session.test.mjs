import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

// A scratch agent dir (config dir + index) and a PATH whose `claude` is the stub.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-session-"));
const agentDir = path.join(scratch, "agent");
const binDir = path.join(scratch, "bin");
const workDir = path.join(scratch, "work");
const stubLog = path.join(scratch, "stub.jsonl");
fs.mkdirSync(agentDir);
fs.mkdirSync(binDir);
fs.mkdirSync(workDir);
fs.copyFileSync(new URL("./__fixtures__/claude-stub/claude.mjs", import.meta.url), path.join(binDir, "claude"));
fs.chmodSync(path.join(binDir, "claude"), 0o755);
// The stub reads the recordings next to its own file.
fs.symlinkSync(fileURLToPathSafe(new URL("./__fixtures__/claude-2.1.312", import.meta.url)), path.join(scratch, "claude-2.1.312"));
function fileURLToPathSafe(url) {
  return decodeURIComponent(url.pathname);
}
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
process.env.PI_TEST_CLAUDE_STUB_LOG = stubLog;
process.env.PI_WEB_PASSWORD = "not-for-the-child";
process.env.ANTHROPIC_API_KEY = "not-for-the-child";
process.env.CLAUDE_INHERITED_SENTINEL = "not-for-the-child";
process.env.PI_WEB_IDLE_TIMEOUT_MS = "0";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const claude = await jiti.import("./claude-session.ts");
const index = await jiti.import("./claude-index.ts");

test.after(async () => {
  await claude.shutdownAllClaudeSessions();
  fs.rmSync(scratch, { recursive: true, force: true });
});

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(25);
  }
  assert.fail(message);
}

const records = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const launches = () => records().filter((entry) => entry.kind === "launch");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function newRecord(extra = {}) {
  const record = {
    id: randomUUID(),
    cwd: workDir,
    modelAlias: "sonnet",
    preset: "read-only",
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    firstMessage: "",
    usage: { ...index.EMPTY_CLAUDE_USAGE },
    ...extra,
  };
  await index.upsertClaudeSessionRecord(record);
  return record;
}

function collect(session) {
  const events = [];
  session.onEvent((event) => events.push(event));
  return events;
}

test("findClaudeBinary resolves claude from PATH only", () => {
  assert.equal(claude.findClaudeBinary(), path.join(binDir, "claude"));
  assert.equal(claude.findClaudeBinary(path.join(scratch, "nowhere")), null);
  assert.equal(claude.findClaudeBinary(""), null);
});

test("a read-only session launches with the exact argv, the sanitized env and the config dir", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const before = launches().length;
  const session = claude.startClaudeSession(record);
  const launch = await waitFor(() => launches()[before], 5_000, "the stub recorded no launch");
  assert.deepEqual(launch.argv, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--bare", "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
    "--model", "sonnet", "--session-id", record.id,
  ]);
  assert.equal(fs.realpathSync(launch.cwd), fs.realpathSync(workDir));
  assert.equal(launch.configDir, path.join(agentDir, "claude"));
  assert.ok(launch.envKeys.includes("CLAUDE_CONFIG_DIR"));
  for (const name of ["PI_WEB_PASSWORD", "ANTHROPIC_API_KEY", "CLAUDE_INHERITED_SENTINEL"]) assert.ok(!launch.envKeys.includes(name), name);
  assert.equal(fs.readFileSync(path.join(agentDir, "claude", "settings.json"), "utf8"), "{}\n");
  assert.equal(claude.startClaudeSession(record), session, "a live child is reused");
  await session.shutdown();
});

test("writable and claude-default launch with their argv", async () => {
  const record = await newRecord({ preset: "writable", modelAlias: "claude-default" });
  const before = launches().length;
  const session = claude.startClaudeSession(record);
  const launch = await waitFor(() => launches()[before], 5_000, "the stub recorded no launch");
  assert.deepEqual(launch.argv, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-mode", "acceptEdits", "--permission-prompts", "none",
    "--tools", "Read,Glob,Grep,Edit,Write,Bash", "--allowedTools", "Read,Glob,Grep,Edit,Write",
    "--session-id", record.id,
  ]);
  assert.ok(!launch.argv.includes("--model"));
  await session.shutdown();
});

test("a prompt reaches stdin and the reply streams through the adapter; usage comes from the result", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  assert.equal(await session.send({ type: "prompt", message: "read the notes" }), null);
  assert.equal(session.isRunning(), true);
  await assert.rejects(session.send({ type: "prompt", message: "again" }), /already running/);
  await waitFor(() => events.some((event) => event.type === "prompt_done"), 10_000, "the turn never ended");
  const stdin = records().filter((entry) => entry.kind === "stdin" && entry.pid === session.pid).map((entry) => JSON.parse(entry.line));
  assert.deepEqual(stdin, [{ type: "user", message: { role: "user", content: "read the notes" } }]);
  const types = events.map((event) => event.type);
  assert.equal(types[0], "agent_start");
  assert.ok(types.includes("message_update"));
  assert.deepEqual(types.slice(-3), ["agent_end", "agent_settled", "prompt_done"]);
  const ended = events.filter((event) => event.type === "message_end").map((event) => event.message.role);
  assert.deepEqual(ended, ["user", "assistant", "toolResult", "assistant"]);
  assert.equal(session.isRunning(), false);
  await waitFor(() => index.getClaudeSessionRecord(record.id).usage.output === 283, 5_000, "usage was not recorded");
  const saved = index.getClaudeSessionRecord(record.id);
  assert.equal(saved.firstMessage, "read the notes");
  const stats = await session.send({ type: "get_session_stats" });
  assert.equal(stats.tokens.output, 283);
  assert.equal(stats.toolCalls, 1);
  const state = await session.send({ type: "get_state" });
  assert.deepEqual(state.model, { id: "sonnet", provider: "claude" });
  await assert.rejects(session.send({ type: "fork", entryId: "x" }), /not available for claude sessions/);
  await session.shutdown();
});

test("Stop sends the interrupt, keeps the partial reply and leaves the session usable", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "hang";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  await session.send({ type: "prompt", message: "long" });
  await waitFor(() => events.some((event) => event.type === "message_update"), 5_000, "nothing streamed");
  await session.send({ type: "abort" });
  await waitFor(() => events.some((event) => event.type === "prompt_done"), 5_000, "the stop did not end the turn");
  const interrupt = records().filter((entry) => entry.kind === "stdin" && entry.pid === session.pid).map((entry) => JSON.parse(entry.line)).at(-1);
  assert.equal(interrupt.type, "control_request");
  assert.equal(interrupt.request.subtype, "interrupt");
  assert.ok(events.some((event) => event.type === "message_end" && event.message.content?.[0]?.text === "partial answ"));
  assert.ok(events.some((event) => event.type === "prompt_done" && event.aborted === true));
  assert.ok(!events.some((event) => event.type === "prompt_error"), "a stop is not an error");
  assert.equal(session.isAlive(), true);
  await session.send({ type: "prompt", message: "next" });
  assert.equal(session.isRunning(), true, "the next send starts a new turn");
  await session.shutdown();
});

test("an exit mid-turn ends the turn with claude's error and the config dir", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "exit";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  await session.send({ type: "prompt", message: "x" });
  await waitFor(() => events.some((event) => event.type === "session_shutdown"), 5_000, "the exit was not noticed");
  const error = events.find((event) => event.type === "prompt_error");
  assert.match(error.errorMessage, /code 3/);
  assert.ok(error.errorMessage.includes(path.join(agentDir, "claude")));
  assert.equal(claude.getClaudeSession(record.id), undefined);
});

test("idle expiry kills the whole process group, and the next start resumes the same id", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  process.env.PI_TEST_CLAUDE_STUB_GRANDCHILD = "1";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  await session.send({ type: "prompt", message: "first" });
  await waitFor(() => events.some((event) => event.type === "prompt_done"), 10_000, "the turn never ended");
  const grandchild = await waitFor(() => records().find((entry) => entry.kind === "grandchild" && entry.pid === session.pid), 5_000, "no grandchild");
  delete process.env.PI_TEST_CLAUDE_STUB_GRANDCHILD;
  process.env.PI_WEB_IDLE_TIMEOUT_MS = "200";
  session.renewIdleTimer();
  await waitFor(() => !session.isAlive(), 5_000, "the idle timer did not end the child");
  process.env.PI_WEB_IDLE_TIMEOUT_MS = "0";
  await waitFor(() => !alive(session.pid) && !alive(grandchild.grandchildPid), 5_000, "a process of the group survived");
  assert.ok(events.some((event) => event.type === "session_shutdown"));

  const before = launches().length;
  const resumed = claude.startClaudeSession(record);
  assert.notEqual(resumed, session);
  const launch = await waitFor(() => launches()[before], 5_000, "no relaunch");
  assert.deepEqual(launch.argv.slice(-2), ["--resume", record.id]);
  assert.ok(!launch.argv.includes("--session-id"));
  await resumed.shutdown();
});

test("PI_WEB_IDLE_TIMEOUT_MS=0 keeps the child", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  process.env.PI_WEB_IDLE_TIMEOUT_MS = "0";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  session.renewIdleTimer();
  await delay(300);
  assert.equal(session.isAlive(), true);
  assert.deepEqual(claude.getRunningClaudeSessionIds().includes(record.id), false);
  await claude.shutdownAllClaudeSessions();
  assert.equal(session.isAlive(), false);
});

test("history and stats read claude's transcript; usage is the index's result totals", () => {
  const record = { id: "5b203fcd-56c9-4d0c-b700-749b82c41afb", usage: { input: 6, output: 283, cacheRead: 840, cacheWrite: 1102, cost: 0.00028825 } };
  const dir = path.join(agentDir, "claude", "projects", "-x");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(new URL("./__fixtures__/claude-2.1.312/transcript.jsonl", import.meta.url), path.join(dir, `${record.id}.jsonl`));
  const history = claude.readClaudeHistory(record.id);
  assert.equal(history.messages.length, 4);
  const stats = claude.claudeSessionStats(record, history.messages);
  assert.deepEqual(stats.tokens, { input: 6, output: 283, cacheRead: 840, cacheWrite: 1102, total: 2231 });
  assert.equal(stats.cost, 0.00028825);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.userMessages, 1);
});
