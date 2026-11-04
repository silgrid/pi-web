import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_IDLE_TIMEOUT_MS = "0";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-routes-"));
const agentDir = path.join(scratch, "agent");
const binDir = path.join(scratch, "bin");
const project = path.join(scratch, "project");
const stubLog = path.join(scratch, "stub.jsonl");
fs.mkdirSync(binDir);
fs.mkdirSync(project);
fs.copyFileSync(new URL("../../../lib/__fixtures__/claude-stub/claude.mjs", import.meta.url), path.join(binDir, "claude"));
fs.chmodSync(path.join(binDir, "claude"), 0o755);
fs.symlinkSync(decodeURIComponent(new URL("../../../lib/__fixtures__/claude-2.1.312", import.meta.url).pathname), path.join(scratch, "claude-2.1.312"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// The inherited claude config dir the stub writes its transcripts under: never the operator's.
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, "claude-config");
const originalPath = process.env.PATH;
process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
process.env.PI_TEST_CLAUDE_STUB_LOG = stubLog;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const command = await jiti.import("./[id]/route.ts");
const events = await jiti.import("./[id]/events/route.ts");
const lease = await jiti.import("./[id]/lease/route.ts");
const running = await jiti.import("./running/route.ts");
const state = await jiti.import("../sessions/[id]/state/route.ts");
const index = await jiti.import("../../../lib/claude-index.ts");
const claude = await jiti.import("../../../lib/claude-session.ts");

test.after(async () => {
  await claude.shutdownAllClaudeSessions();
  process.env.PATH = originalPath;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const params = (id) => ({ params: Promise.resolve({ id }) });
const launches = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === "launch") : []);

async function newRecord() {
  const record = {
    id: randomUUID(),
    cwd: project,
    model: "claude-sonnet-5-5",
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    firstMessage: "",
    usage: { ...index.EMPTY_CLAUDE_USAGE },
  };
  await index.upsertClaudeSessionRecord(record);
  return record;
}

const send = (id, body) => command.POST(new Request(`http://localhost/api/agent/${id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}), params(id));

/** Reads an events stream until `until` matches a data event (or the deadline), then cancels it. */
async function readEvents(id, until, timeoutMs = 10_000) {
  const controller = new AbortController();
  const response = await events.GET(new Request(`http://localhost/api/agent/${id}/events`, { signal: controller.signal }), params(id));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const seen = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([reader.read(), delay(deadline - Date.now()).then(() => ({ done: true }))]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (!chunk.startsWith("data: ")) continue;
        const event = JSON.parse(chunk.slice(6));
        seen.push(event);
        if (until(event, seen)) return seen;
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  assert.fail(`the stream ended without the expected event: ${seen.map((event) => event.type).join(",")}`);
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(25);
  }
  assert.fail(message);
}

test("a claude id round trip: the events stream starts the child, a prompt streams back to agent_settled", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const stream = readEvents(record.id, (event) => event.type === "prompt_done");
  await waitFor(() => claude.getClaudeSession(record.id), 5_000, "opening the stream started no child");
  const response = await send(record.id, { type: "prompt", message: "hello" });
  assert.equal(response.status, 200);
  const seen = await stream;
  const types = seen.map((event) => event.type);
  assert.equal(types[0], "connected");
  assert.ok(types.includes("agent_start"));
  assert.ok(types.includes("message_update"));
  assert.ok(types.indexOf("agent_settled") > types.indexOf("agent_end"));
  const ended = seen.filter((event) => event.type === "message_end").map((event) => event.message.role);
  assert.deepEqual(ended, ["user", "assistant", "toolResult", "assistant"]);
  const live = await (await state.GET(new Request("http://localhost"), params(record.id))).json();
  assert.equal(live.running, true);
  assert.deepEqual(live.state.model, { id: "claude-sonnet-5-5", provider: "claude" });
  const agentState = await (await command.GET(new Request(`http://localhost/api/agent/${record.id}`), params(record.id))).json();
  assert.equal(agentState.running, true);
  await claude.getClaudeSession(record.id).shutdown();
  assert.deepEqual(await (await state.GET(new Request("http://localhost"), params(record.id))).json(), { running: false });
});

test("pi-only commands are refused for a claude id and start nothing; a malformed switch is 400 too", async () => {
  const record = await newRecord();
  const before = launches().length;
  for (const type of ["fork", "steer", "navigate_tree", "set_thinking_level", "set_tools", "follow_up", "reload"]) {
    const response = await send(record.id, { type });
    assert.equal(response.status, 400, type);
    assert.match((await response.json()).error, /not available for claude sessions/);
  }
  // rewrote #250's "set_model is refused": a switch must name a full model / a claude effort.
  for (const body of [{ type: "set_model", model: "opus" }, { type: "set_model", provider: "e2e", modelId: "model-0" }, { type: "set_effort", effort: "off" }, { type: "set_effort" }]) {
    assert.equal((await send(record.id, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(launches().length, before);
  assert.equal(claude.getClaudeSession(record.id), undefined, "a refused command launches no child");
  assert.equal(index.getClaudeSessionRecord(record.id).model, "claude-sonnet-5-5");
});

test("with no live child set_model / set_effort only write the index and spawn nothing", async () => {
  const record = await newRecord();
  const before = launches().length;
  const model = await send(record.id, { type: "set_model", provider: "claude", modelId: "claude-haiku-5-5", model: "claude-haiku-5-5" });
  assert.equal(model.status, 200);
  assert.deepEqual((await model.json()).data, { model: "claude-haiku-5-5", pending: true });
  const effort = await send(record.id, { type: "set_effort", effort: "high" });
  assert.deepEqual((await effort.json()).data, { effort: "high", pending: true });
  assert.equal(launches().length, before, "the switch spawned a child");
  const stored = index.getClaudeSessionRecord(record.id);
  assert.equal(stored.model, "claude-haiku-5-5");
  assert.equal(stored.effort, "high");
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  await readEvents(record.id, (event) => event.type === "connected");
  const launch = await waitFor(() => launches()[before], 5_000, "opening the stream started no child");
  assert.equal(launch.argv[launch.argv.indexOf("--model") + 1], "claude-haiku-5-5");
  assert.equal(launch.argv[launch.argv.indexOf("--effort") + 1], "high");
  await claude.getClaudeSession(record.id)?.shutdown();
});

test("a live set_model is claude's answer: accepted switches in place, a running turn refuses it", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  await readEvents(record.id, (event) => event.type === "connected");
  const session = await waitFor(() => claude.getClaudeSession(record.id), 5_000, "no child");
  await waitFor(() => launches().some((entry) => entry.pid === session.pid), 5_000, "no launch");
  const before = launches().length;
  const switched = await send(record.id, { type: "set_model", model: "claude-fable-5-1" });
  assert.equal(switched.status, 200);
  assert.deepEqual((await switched.json()).data, { model: "claude-fable-5-1" });
  assert.equal(launches().length, before, "the switch restarted the child");
  assert.equal(claude.getClaudeSession(record.id), session);
  assert.equal(index.getClaudeSessionRecord(record.id).model, "claude-fable-5-1");
  const live = await (await command.GET(new Request(`http://localhost/api/agent/${record.id}`), params(record.id))).json();
  assert.deepEqual(live.state.model, { id: "claude-fable-5-1", provider: "claude" });
  const effort = await send(record.id, { type: "set_effort", effort: "max" });
  assert.deepEqual((await effort.json()).data, { effort: "max" });
  assert.equal(index.getClaudeSessionRecord(record.id).effort, "max");
  await session.shutdown();

  process.env.PI_TEST_CLAUDE_STUB_MODE = "hang";
  const busy = await newRecord();
  await send(busy.id, { type: "prompt", message: "long" });
  const hanging = claude.getClaudeSession(busy.id);
  for (const body of [{ type: "set_model", model: "claude-haiku-5-5" }, { type: "set_effort", effort: "low" }]) {
    const refused = await send(busy.id, body);
    assert.notEqual(refused.status, 200, JSON.stringify(body));
    assert.match((await refused.json()).error, /turn is running/);
  }
  const stored = index.getClaudeSessionRecord(busy.id);
  assert.equal(stored.model, "claude-sonnet-5-5");
  assert.equal(stored.effort, "default");
  const stdin = fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === "stdin" && entry.pid === hanging.pid);
  assert.ok(!stdin.some((entry) => entry.line.includes("control_request")), "a mid-turn switch reached stdin");
  await hanging.shutdown();
});

test("abort interrupts the turn and the session takes the next prompt; running ids include it meanwhile", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "hang";
  const record = await newRecord();
  await send(record.id, { type: "prompt", message: "long" });
  const session = claude.getClaudeSession(record.id);
  assert.ok(session);
  const runningIds = await (await running.GET()).json();
  assert.ok(runningIds.runningSessionIds.includes(record.id));
  const leaseReply = await (await lease.POST(new Request("http://localhost"), params(record.id))).json();
  assert.deepEqual(leaseReply, { success: true, running: true, awaitingInput: false, subagentsActive: false });
  assert.equal((await send(record.id, { type: "abort" })).status, 200);
  await waitFor(() => !session.isRunning(), 5_000, "abort did not end the turn");
  assert.equal(session.isAlive(), true);
  assert.equal((await send(record.id, { type: "prompt", message: "again" })).status, 200);
  assert.equal(session.isRunning(), true);
  await session.shutdown();
});

test("the lease and the running snapshot report a claude session's unsettled background subagent", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "subagent-early";
  process.env.PI_TEST_CLAUDE_STUB_HOLD_MS = "500";
  const record = await newRecord();
  const stream = readEvents(record.id, (event) => event.type === "prompt_done" && event.subagentsActive !== true);
  await waitFor(() => claude.getClaudeSession(record.id), 5_000, "opening the stream started no child");
  await send(record.id, { type: "prompt", message: "launch it" });
  const session = claude.getClaudeSession(record.id);
  await waitFor(() => !session.isRunning() && session.hasUnsettledSubagents(), 10_000, "the parent turn never ended with the subagent running");
  const held = await (await lease.POST(new Request("http://localhost"), params(record.id))).json();
  assert.deepEqual(held, { success: true, running: false, awaitingInput: false, subagentsActive: true });
  assert.ok((await (await running.GET()).json()).subagentsActiveSessionIds.includes(record.id));
  await stream;
  delete process.env.PI_TEST_CLAUDE_STUB_HOLD_MS;
  const settled = await (await lease.POST(new Request("http://localhost"), params(record.id))).json();
  assert.equal(settled.subagentsActive, false, "settled after the last follow-up turn");
  assert.ok(!(await (await running.GET()).json()).subagentsActiveSessionIds.includes(record.id));
  await session.shutdown();
});

test("a lease on an idle claude id renews nothing and spawns nothing", async () => {
  const record = await newRecord();
  const before = launches().length;
  const reply = await (await lease.POST(new Request("http://localhost"), params(record.id))).json();
  assert.equal(reply.running, false);
  await delay(100);
  assert.equal(launches().length, before);
  assert.equal(claude.getClaudeSession(record.id), undefined);
});

test("after the child exits, opening the stream starts one with --resume <same id>", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  await send(record.id, { type: "prompt", message: "first" });
  const first = claude.getClaudeSession(record.id);
  await waitFor(() => !first.isRunning(), 10_000, "the first turn never ended");
  await first.shutdown();
  const before = launches().length;
  await readEvents(record.id, (event) => event.type === "connected");
  const launch = await waitFor(() => launches()[before], 5_000, "no relaunch");
  assert.deepEqual(launch.argv.slice(-2), ["--resume", record.id]);
  await claude.shutdownAllClaudeSessions();
});

test("a pi id still takes the pi path", async () => {
  const id = randomUUID();
  const response = await events.GET(new Request(`http://localhost/api/agent/${id}/events`), params(id));
  assert.equal(response.status, 404);
  assert.deepEqual(await (await command.GET(new Request("http://localhost"), params(id))).json(), { running: false });
  assert.equal((await state.GET(new Request("http://localhost"), params(id))).status, 404);
});

// a claude prompt's images are validated before any child starts or stdin write.
const PNG = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==", mimeType: "image/png" };
const stdinLines = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === "stdin") : []);

test("invalid claude images are refused with 400 and a reason before a child starts or stdin is written", async () => {
  const record = await newRecord();
  const oversized = "AAAA".repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3));
  const before = { launches: launches().length, stdin: stdinLines().length };
  for (const [images, reason] of [
    [[{ ...PNG, data: "not base64!" }], /valid base64/],
    [Array.from({ length: 11 }, () => PNG), /at most 10/],
    [[{ ...PNG, data: oversized }], /10MB/],
    [[{ ...PNG, mimeType: "image/svg+xml" }], /PNG, JPEG, GIF and WebP/],
  ]) {
    const response = await send(record.id, { type: "prompt", message: "look", images });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, reason);
    assert.equal(body.code, "prompt_rejected");
    assert.equal(body.accepted, false);
  }
  assert.equal(claude.getClaudeSession(record.id), undefined, "no child for a refused prompt");
  assert.deepEqual({ launches: launches().length, stdin: stdinLines().length }, before);
});

test("a valid claude image prompt is written to stdin once with the exact base64 and media type", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const record = await newRecord();
  const before = stdinLines().length;
  const response = await send(record.id, { type: "prompt", message: "look", images: [{ ...PNG, mimeType: "image/webp" }] });
  assert.equal(response.status, 200);
  const session = claude.getClaudeSession(record.id);
  await waitFor(() => !session.isRunning(), 10_000, "the turn never ended");
  const written = stdinLines().slice(before).map((entry) => JSON.parse(entry.line));
  assert.deepEqual(written, [{ type: "user", message: { role: "user", content: [
    { type: "text", text: "look" },
    { type: "image", source: { type: "base64", media_type: "image/webp", data: PNG.data } },
  ] } }]);
  await claude.shutdownAllClaudeSessions();
});

test("compact on a claude id is accepted while idle, reports isCompacting meanwhile, and a mid-turn compact changes nothing", async () => {
  process.env.PI_TEST_CLAUDE_STUB_MODE = "hang";
  const record = await newRecord();
  await readEvents(record.id, (event) => event.type === "connected");
  const session = await waitFor(() => claude.getClaudeSession(record.id), 5_000, "no child");
  const pending = send(record.id, { type: "compact" });
  await waitFor(async () => (await (await command.GET(new Request(`http://localhost/api/agent/${record.id}`), params(record.id))).json()).state?.isCompacting === true, 5_000, "get_state never reported the compaction");
  const again = await send(record.id, { type: "compact" });
  assert.notEqual(again.status, 200, "a second compact during the first one was accepted");
  assert.equal((await send(record.id, { type: "abort" })).status, 200);
  const stopped = await pending;
  assert.equal(stopped.status, 200);
  assert.deepEqual((await stopped.json()).data, { aborted: true });
  await session.shutdown();

  process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";
  const idle = await newRecord();
  const done = await send(idle.id, { type: "compact" });
  assert.equal(done.status, 200);
  assert.deepEqual((await done.json()).data, { tokensBefore: 16739 });
  await claude.getClaudeSession(idle.id)?.shutdown();
});
