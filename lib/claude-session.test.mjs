import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

// A scratch agent dir (index), an inherited claude config dir, a scratch HOME and a
// PATH whose `claude` is the stub: nothing here touches the operator's ~/.claude.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-session-"));
const agentDir = path.join(scratch, "agent");
const configDir = path.join(scratch, "claude-config");
const homeDir = path.join(scratch, "home");
const binDir = path.join(scratch, "bin");
const workDir = path.join(scratch, "work");
const stubLog = path.join(scratch, "stub.jsonl");
fs.mkdirSync(agentDir);
fs.mkdirSync(binDir);
fs.mkdirSync(workDir);
fs.mkdirSync(homeDir);
fs.copyFileSync(new URL("./__fixtures__/claude-stub/claude.mjs", import.meta.url), path.join(binDir, "claude"));
fs.chmodSync(path.join(binDir, "claude"), 0o755);
// The stub reads the recordings next to its own file.
fs.symlinkSync(fileURLToPathSafe(new URL("./__fixtures__/claude-2.1.312", import.meta.url)), path.join(scratch, "claude-2.1.312"));
function fileURLToPathSafe(url) {
  return decodeURIComponent(url.pathname);
}
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = homeDir;
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
process.env.PI_TEST_CLAUDE_STUB_LOG = stubLog;
process.env.PI_WEB_PASSWORD = "not-for-the-child";
process.env.CLAUDECODE = "1";
process.env.ANTHROPIC_API_KEY = "inherited-by-the-child";
process.env.CLAUDE_INHERITED_SENTINEL = "inherited-by-the-child";
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
    model: "claude-sonnet-5-5",
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

test("a session launches with the reduced argv and its full model name, the inherited env minus PI_WEB_PASSWORD/CLAUDECODE, and creates no config dir", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const before = launches().length;
  const session = claude.startClaudeSession(record);
  const launch = await waitFor(() => launches()[before], 5_000, "the stub recorded no launch");
  assert.deepEqual(launch.argv, [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--model", "claude-sonnet-5-5", "--permission-prompts", "none", "--session-id", record.id,
  ]);
  assert.ok(!launch.argv.includes("--cwd"), "the folder is the spawn's cwd, not a flag");
  assert.equal(fs.realpathSync(launch.cwd), fs.realpathSync(workDir));
  // CLAUDE_CONFIG_DIR is the child's only because pi-web inherited it (this test set it).
  assert.equal(launch.configDir, configDir);
  for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_INHERITED_SENTINEL", "CLAUDE_CONFIG_DIR"]) assert.ok(launch.envKeys.includes(name), name);
  for (const name of ["PI_WEB_PASSWORD", "CLAUDECODE"]) assert.ok(!launch.envKeys.includes(name), name);
  assert.equal(fs.existsSync(path.join(agentDir, "claude")), false, "no dedicated config dir is created");
  assert.equal(fs.existsSync(path.join(homeDir, ".pi", "agent", "claude")), false);
  assert.equal(claude.startClaudeSession(record), session, "a live child is reused");
  await session.shutdown();
});

test("a legacy #219 index record launches with its alias's full name and no preset flag", async () => {
  const record = await newRecord();
  // As #219 wrote it: alias + preset, no model.
  const file = index.claudeIndexPath();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  parsed.sessions = parsed.sessions.map((entry) => (entry.id === record.id ? { ...entry, model: undefined, modelAlias: "haiku", preset: "writable" } : entry));
  fs.writeFileSync(file, JSON.stringify(parsed));
  const legacy = index.getClaudeSessionRecord(record.id);
  const before = launches().length;
  const session = claude.startClaudeSession(legacy);
  const launch = await waitFor(() => launches()[before], 5_000, "the stub recorded no launch");
  assert.equal(launch.argv[launch.argv.indexOf("--model") + 1], "claude-haiku-5-5");
  for (const flag of ["--permission-mode", "--tools", "--allowedTools", "--bare"]) assert.ok(!launch.argv.includes(flag), flag);
  assert.deepEqual(await session.send({ type: "get_tools" }), [], "pi-web lists no claude tools");
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
  assert.deepEqual(state.model, { id: "claude-sonnet-5-5", provider: "claude" });
  await assert.rejects(session.send({ type: "fork", entryId: "x" }), /not available for claude sessions/);
  await session.shutdown();
});

// images travel to the child in the one stdin line, unchanged.
const PNG = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==", mimeType: "image/png" };

test("a prompt's images reach stdin as base64 image blocks in one line, and the live user message carries them", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  assert.equal(await session.send({ type: "prompt", message: "what is this?", images: [PNG] }), null);
  await waitFor(() => events.some((event) => event.type === "prompt_done"), 10_000, "the turn never ended");
  const stdin = records().filter((entry) => entry.kind === "stdin" && entry.pid === session.pid).map((entry) => JSON.parse(entry.line));
  assert.deepEqual(stdin, [{ type: "user", message: { role: "user", content: [
    { type: "text", text: "what is this?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
  ] } }]);
  const user = events.find((event) => event.type === "message_end" && event.message.role === "user").message;
  assert.deepEqual(user.content, [{ type: "text", text: "what is this?" }, { type: "image", data: PNG.data, mimeType: "image/png" }]);
  await waitFor(() => index.getClaudeSessionRecord(record.id).firstMessage === "what is this?", 5_000, "firstMessage was not recorded");
  await session.shutdown();
});

test("an image-only prompt is a turn: images alone on stdin, firstMessage [Image]; no text and no image is still refused", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  await assert.rejects(session.send({ type: "prompt", message: "  " }), /A claude prompt needs text/);
  await assert.rejects(session.send({ type: "prompt", message: "", images: [] }), /A claude prompt needs text/);
  assert.equal(await session.send({ type: "prompt", message: "", images: [PNG] }), null);
  await waitFor(() => events.some((event) => event.type === "prompt_done"), 10_000, "the turn never ended");
  const stdin = records().filter((entry) => entry.kind === "stdin" && entry.pid === session.pid).map((entry) => JSON.parse(entry.line));
  assert.deepEqual(stdin, [{ type: "user", message: { role: "user", content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.data } },
  ] } }]);
  await waitFor(() => index.getClaudeSessionRecord(record.id).firstMessage === "[Image]", 5_000, "firstMessage was not [Image]");
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
  assert.ok(error.errorMessage.includes(configDir));
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

const subagentText = (event) => event.type === "claude_subagent" && event.run.entries.some((entry) => entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "text"));
const count = (events, type) => events.filter((event) => event.type === type).length;

test("a background subagent keeps the session unsettled until claude's follow-up turn ends, which ends the turn once", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "subagent";
  process.env.PI_TEST_CLAUDE_STUB_HOLD_MS = "400";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  await session.send({ type: "prompt", message: "launch it" });
  await waitFor(() => events.some(subagentText), 10_000, "the subagent's text never arrived");
  assert.equal(session.hasUnsettledSubagents(), true, "the running background subagent is unsettled");
  assert.ok(claude.getClaudeSessionIdsWithUnsettledSubagents().includes(record.id));
  await waitFor(() => events.some((event) => event.type === "prompt_done"), 10_000, "the turn never ended");
  delete process.env.PI_TEST_CLAUDE_STUB_HOLD_MS;
  assert.equal(session.hasUnsettledSubagents(), false);
  assert.equal(count(events, "agent_start"), 1, "the follow-up came while the turn ran: no second start");
  assert.equal(count(events, "prompt_done"), 1, "one completion, after the last follow-up result");
  const done = events.find((event) => event.type === "agent_settled");
  assert.equal(done.subagentsActive, undefined, "settled: nothing holds the announcement");
  const anchor = events.find((event) => event.type === "message_end" && event.message.role === "custom");
  assert.equal(anchor.message.customType, "claude:task-notification");
  const reply = events.findIndex((event) => event.type === "message_end" && event.message.role === "assistant" && /^The subagent finished/.test(event.message.content[0]?.text ?? ""));
  assert.ok(events.indexOf(anchor) < reply, "the follow-up reply comes after its anchor");
  assert.ok(!events.some((event) => /^(message_|tool_execution_)/.test(event.type) && JSON.stringify(event).includes("toolu_012N7brUKegpGiA36sdi1ApH")), "the subagent's Read is no main event");
  await session.shutdown();
});

test("a parent turn answered while its subagent runs reports subagentsActive; claude's follow-up is its own turn and the last one announces", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "subagent-early";
  process.env.PI_TEST_CLAUDE_STUB_HOLD_MS = "600";
  process.env.PI_WEB_IDLE_TIMEOUT_MS = "100";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  await session.send({ type: "prompt", message: "launch it" });
  await waitFor(() => events.some((event) => event.type === "prompt_done"), 10_000, "the parent turn never ended");
  const first = events.find((event) => event.type === "prompt_done");
  assert.equal(first.subagentsActive, true, "the parent's end holds the announcement");
  assert.equal(session.isRunning(), false);
  assert.equal(session.hasUnsettledSubagents(), true);
  await delay(300);
  assert.equal(session.isAlive(), true, "no idle reap while the subagent is unsettled");
  await waitFor(() => count(events, "prompt_done") === 2, 10_000, "claude's follow-up turn never ended");
  delete process.env.PI_TEST_CLAUDE_STUB_HOLD_MS;
  const types = events.map((event) => event.type);
  assert.equal(count(events, "agent_start"), 2, "the follow-up turn starts on its own, without a prompt");
  const secondStart = types.lastIndexOf("agent_start");
  assert.equal(events[secondStart + 1].type, "message_start");
  assert.equal(events[secondStart + 1].message.customType, "claude:task-notification", "it opens with the hidden anchor");
  assert.ok(!events.slice(secondStart).some((event) => event.type === "message_end" && event.message.role === "user"), "no user bubble starts it");
  const last = events.filter((event) => event.type === "prompt_done").at(-1);
  assert.equal(last.subagentsActive, undefined, "the last follow-up end announces");
  await waitFor(() => !session.isAlive(), 5_000, "once settled the idle timer ends the child again");
  process.env.PI_WEB_IDLE_TIMEOUT_MS = "0";
});

test("a session without Agent calls reports no unsettled subagent", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  await session.send({ type: "prompt", message: "plain" });
  await waitFor(() => events.some((event) => event.type === "prompt_done"), 10_000, "the turn never ended");
  assert.equal(session.hasUnsettledSubagents(), false);
  assert.equal(events.find((event) => event.type === "prompt_done").subagentsActive, undefined);
  assert.ok(!events.some((event) => event.type === "claude_subagent"));
  await session.shutdown();
});

test("history and stats read claude's transcript; usage is the index's result totals", () => {
  const record = { id: "5b203fcd-56c9-4d0c-b700-749b82c41afb", usage: { input: 6, output: 283, cacheRead: 840, cacheWrite: 1102, cost: 0.00028825 } };
  const dir = path.join(configDir, "projects", "-x");
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

test("history carries the subagent runs rebuilt from the sidecars; an unreadable sidecar degrades silently", () => {
  const id = "44444444-4444-4444-8444-444444444444";
  const dir = path.join(configDir, "projects", "-sub");
  const sidecars = path.join(dir, id, "subagents");
  fs.mkdirSync(sidecars, { recursive: true });
  const recording = new URL("./__fixtures__/claude-2.1.312/subagent/", import.meta.url);
  fs.copyFileSync(new URL("transcript.jsonl", recording), path.join(dir, `${id}.jsonl`));
  for (const name of ["agent-a9fb2ff3aa8e8ff40.jsonl", "agent-a9fb2ff3aa8e8ff40.meta.json"]) {
    fs.copyFileSync(new URL(`subagents/${name}`, recording), path.join(sidecars, name));
  }
  const history = claude.readClaudeHistory(id);
  assert.equal(history.subagents.length, 1);
  assert.equal(history.subagents[0].entries.length, 3);
  assert.equal(history.subagents[0].agentType, "general-purpose");
  fs.rmSync(path.join(sidecars, "agent-a9fb2ff3aa8e8ff40.jsonl"));
  fs.mkdirSync(path.join(sidecars, "agent-a9fb2ff3aa8e8ff40.jsonl"));
  const degraded = claude.readClaudeHistory(id);
  assert.equal(degraded.subagents.length, 1, "the run is still there");
  assert.deepEqual(degraded.subagents[0].entries, [], "without its entries");
  assert.equal(degraded.messages.length, history.messages.length);
});

test("without an inherited CLAUDE_CONFIG_DIR the child gets none and its transcript is read from ~/.claude", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const record = await newRecord();
    const before = launches().length;
    const session = claude.startClaudeSession(record);
    const events = collect(session);
    const launch = await waitFor(() => launches()[before], 5_000, "the stub recorded no launch");
    assert.ok(!launch.envKeys.includes("CLAUDE_CONFIG_DIR"), "no CLAUDE_CONFIG_DIR is injected");
    await session.send({ type: "prompt", message: "home dir" });
    await waitFor(() => events.some((event) => event.type === "prompt_done"), 10_000, "the turn never ended");
    const history = claude.readClaudeHistory(record.id);
    assert.ok(history.file?.startsWith(path.join(homeDir, ".claude", "projects")), String(history.file));
    assert.ok(history.messages.length > 0);
    await session.shutdown();
  } finally {
    process.env.CLAUDE_CONFIG_DIR = configDir;
  }
});

test("every spawn carries the record's effort; a default record has none; state reports the index's model and effort", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const plain = await newRecord();
  let before = launches().length;
  const first = claude.startClaudeSession(plain);
  assert.ok(!(await waitFor(() => launches()[before], 5_000, "no launch")).argv.includes("--effort"));
  assert.equal((await first.send({ type: "get_state" })).claudeEffort, "default");
  await first.shutdown();

  const record = await newRecord({ effort: "xhigh" });
  before = launches().length;
  const session = claude.startClaudeSession(record);
  const launch = await waitFor(() => launches()[before], 5_000, "no launch");
  assert.equal(launch.argv[launch.argv.indexOf("--effort") + 1], "xhigh");
  await index.updateClaudeSessionRecord(record.id, (entry) => ({ ...entry, model: "claude-haiku-5-5", effort: "low" }));
  const state = await session.send({ type: "get_state" });
  assert.deepEqual(state.model, { id: "claude-haiku-5-5", provider: "claude" });
  assert.equal(state.claudeEffort, "low");
  assert.deepEqual(claude.claudeSessionInfo(index.getClaudeSessionRecord(record.id)).claude, { model: "claude-haiku-5-5", effort: "low" });
  await session.shutdown();
  before = launches().length;
  const resumed = claude.startClaudeSession(index.getClaudeSessionRecord(record.id));
  const again = await waitFor(() => launches()[before], 5_000, "no resume launch");
  assert.equal(again.argv[again.argv.indexOf("--effort") + 1], "low");
  assert.equal(again.argv[again.argv.indexOf("--model") + 1], "claude-haiku-5-5");
  await resumed.shutdown();
});

const stdinOf = (pid) => records().filter((entry) => entry.kind === "stdin" && entry.pid === pid).map((entry) => JSON.parse(entry.line));

test("a live model switch is claude's set_model on the same child; the index records it and the next spawn carries it", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  await waitFor(() => launches().some((entry) => entry.pid === session.pid), 5_000, "no launch");
  const before = launches().length;
  assert.deepEqual(await session.send({ type: "set_model", model: "claude-haiku-5-5" }), { model: "claude-haiku-5-5" });
  assert.equal(launches().length, before, "no new launch");
  assert.ok(session.isAlive());
  const request = stdinOf(session.pid).find((line) => line.type === "control_request");
  assert.deepEqual(request.request, { subtype: "set_model", model: "claude-haiku-5-5" });
  assert.equal(index.getClaudeSessionRecord(record.id).model, "claude-haiku-5-5");
  await session.shutdown();
  const next = claude.startClaudeSession(index.getClaudeSessionRecord(record.id));
  const launch = await waitFor(() => launches()[before], 5_000, "no relaunch");
  assert.equal(launch.argv[launch.argv.indexOf("--model") + 1], "claude-haiku-5-5");
  await next.shutdown();
});

test("a switch claude refuses (the recorded check_failed) keeps the old model and the child", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "switch";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  // The model-switch recording answers its first request with claude's refusal.
  const refused = await session.send({ type: "set_model", model: "claude-opus-5-5" });
  assert.equal(refused.rejected, true);
  assert.equal(refused.model, "claude-sonnet-5-5");
  assert.equal(refused.errorCode, "check_failed");
  assert.match(refused.error, /model not changed/);
  assert.equal(index.getClaudeSessionRecord(record.id).model, "claude-sonnet-5-5");
  assert.ok(session.isAlive());
  assert.deepEqual(await session.send({ type: "set_model", model: "claude-opus-5-5" }), { model: "claude-sonnet-5-5" }, "the recorded success names the model claude reports");
  await session.shutdown();
});

test("a child that exits while a switch waits records it; the next spawn carries the new --model and --effort", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "hang";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  await waitFor(() => launches().some((entry) => entry.pid === session.pid), 5_000, "no launch");
  const switching = session.send({ type: "set_model", model: "claude-haiku-5-5" });
  await waitFor(() => stdinOf(session.pid).some((line) => line.type === "control_request"), 5_000, "set_model never reached stdin");
  process.kill(session.pid, "SIGKILL");
  assert.deepEqual(await switching, { model: "claude-haiku-5-5", pending: true });
  assert.equal(index.getClaudeSessionRecord(record.id).model, "claude-haiku-5-5");

  const second = claude.startClaudeSession(index.getClaudeSessionRecord(record.id));
  await waitFor(() => launches().some((entry) => entry.pid === second.pid), 5_000, "no relaunch");
  const effort = second.send({ type: "set_effort", effort: "high" });
  await waitFor(() => stdinOf(second.pid).some((line) => line.type === "control_request"), 5_000, "set_effort never reached stdin");
  process.kill(second.pid, "SIGKILL");
  assert.deepEqual(await effort, { effort: "high", pending: true });

  const before = launches().length;
  const next = claude.startClaudeSession(index.getClaudeSessionRecord(record.id));
  const launch = await waitFor(() => launches()[before], 5_000, "no relaunch");
  assert.equal(launch.argv[launch.argv.indexOf("--model") + 1], "claude-haiku-5-5");
  assert.equal(launch.argv[launch.argv.indexOf("--effort") + 1], "high");
  await next.shutdown();
});

test("an effort change: a level goes to the live child as apply_flag_settings; the default ends the idle child; pre-#272 reads default", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  assert.equal(index.getClaudeSessionRecord(record.id).effort, "default");
  const session = claude.startClaudeSession(record);
  await waitFor(() => launches().some((entry) => entry.pid === session.pid), 5_000, "no launch");
  const before = launches().length;
  assert.deepEqual(await session.send({ type: "set_effort", effort: "max" }), { effort: "max" });
  assert.deepEqual(stdinOf(session.pid).find((line) => line.type === "control_request").request, { subtype: "apply_flag_settings", settings: { effortLevel: "max" } });
  assert.ok(session.isAlive());
  assert.equal(launches().length, before);
  assert.equal(index.getClaudeSessionRecord(record.id).effort, "max");
  assert.deepEqual(await session.send({ type: "set_effort", effort: "default" }), { effort: "default", pending: true });
  assert.equal(session.isAlive(), false, "the default entry ends the idle child");
  const next = claude.startClaudeSession(index.getClaudeSessionRecord(record.id));
  const launch = await waitFor(() => launches()[before], 5_000, "no relaunch");
  assert.ok(!launch.argv.includes("--effort"));
  await next.shutdown();
});

test("a running turn refuses a switch and changes nothing", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "hang";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  await session.send({ type: "prompt", message: "long" });
  await assert.rejects(session.send({ type: "set_model", model: "claude-haiku-5-5" }), /turn is running/);
  await assert.rejects(session.send({ type: "set_effort", effort: "low" }), /turn is running/);
  assert.ok(!stdinOf(session.pid).some((line) => line.type === "control_request"));
  assert.equal(index.getClaudeSessionRecord(record.id).model, "claude-sonnet-5-5");
  await session.shutdown();
});

test("compact sends /compact once as a guarded turn and resolves with claude's pre-compaction tokens; the next prompt is taken", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  const outcome = session.send({ type: "compact" });
  assert.equal((await session.send({ type: "get_state" })).isCompacting, true);
  await assert.rejects(session.send({ type: "prompt", message: "meanwhile" }), /already running/);
  await assert.rejects(session.send({ type: "set_model", model: "claude-haiku-5-5" }), /turn is running/);
  assert.deepEqual(await outcome, { tokensBefore: 16739 });
  const lines = stdinOf(session.pid).filter((line) => line.type === "user");
  assert.deepEqual(lines, [{ type: "user", message: { role: "user", content: "/compact" } }]);
  const types = events.map((event) => event.type);
  assert.deepEqual(types.filter((type) => type.startsWith("compaction")), ["compaction_start", "compaction_end"]);
  assert.deepEqual(events.find((event) => event.type === "compaction_end").result, { tokensBefore: 16739 });
  assert.ok(!types.includes("agent_start") && !types.includes("message_end"), "a compaction is no reply");
  assert.equal((await session.send({ type: "get_state" })).isCompacting, false);
  assert.ok(claude.readClaudeHistory(record.id).messages.some((message) => message.customType === "compaction"));
  await session.send({ type: "prompt", message: "after" });
  await waitFor(() => !session.isRunning(), 5_000, "the prompt after the compaction did not finish");
  await session.shutdown();
});

test("Stop during a compaction ends it as stopped without a marker; a failed one rejects with claude's error", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "hang";
  const record = await newRecord();
  const session = claude.startClaudeSession(record);
  const events = collect(session);
  const outcome = session.send({ type: "compact" });
  await waitFor(() => stdinOf(session.pid).length > 0, 5_000, "/compact never reached stdin");
  await session.send({ type: "abort" });
  assert.deepEqual(await outcome, { aborted: true });
  assert.equal(events.find((event) => event.type === "compaction_end").aborted, true);
  assert.equal(claude.readClaudeHistory(record.id).messages.filter((message) => message.customType === "compaction").length, 0);
  assert.ok(session.isAlive());
  await session.shutdown();

  process.env.PI_TEST_CLAUDE_STUB_MODE = "exit";
  const failing = claude.startClaudeSession(await newRecord());
  await assert.rejects(failing.send({ type: "compact" }), /claude config dir/);
});

const INSTRUCTION = "Use Simplified Chinese (简体中文) for replies, narration and reports. Keep code, code comments, commit messages, files you write, technical terms and identifiers as they are, or as the project's conventions require. Thinking in Chinese is best effort only.";

test("a 中文 record's every spawn carries --append-system-prompt with the fixed text; an English or pre-feature record's carries none", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const zh = await newRecord({ agentLanguage: "zh-CN" });
  let before = launches().length;
  const first = claude.startClaudeSession(index.getClaudeSessionRecord(zh.id));
  const launch = await waitFor(() => launches()[before], 5_000, "no launch");
  assert.equal(launch.argv[launch.argv.indexOf("--append-system-prompt") + 1], INSTRUCTION);
  await first.shutdown();
  before = launches().length;
  const resumed = claude.startClaudeSession(index.getClaudeSessionRecord(zh.id));
  const again = await waitFor(() => launches()[before], 5_000, "no resume launch");
  assert.equal(again.argv[again.argv.indexOf("--append-system-prompt") + 1], INSTRUCTION);
  await resumed.shutdown();

  for (const extra of [{ agentLanguage: "en" }, {}]) {
    const record = await newRecord(extra);
    before = launches().length;
    const session = claude.startClaudeSession(index.getClaudeSessionRecord(record.id));
    const english = await waitFor(() => launches()[before], 5_000, "no launch");
    assert.ok(!english.argv.includes("--append-system-prompt"));
    assert.ok(!english.argv.includes(INSTRUCTION));
    await session.shutdown();
  }
});
