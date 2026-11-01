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
    modelAlias: "sonnet",
    preset: "read-only",
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
  assert.deepEqual(live.state.model, { id: "sonnet", provider: "claude" });
  const agentState = await (await command.GET(new Request(`http://localhost/api/agent/${record.id}`), params(record.id))).json();
  assert.equal(agentState.running, true);
  await claude.getClaudeSession(record.id).shutdown();
  assert.deepEqual(await (await state.GET(new Request("http://localhost"), params(record.id))).json(), { running: false });
});

test("pi-only commands are refused for a claude id and start nothing", async () => {
  const record = await newRecord();
  const before = launches().length;
  for (const type of ["fork", "set_model", "compact", "steer", "navigate_tree"]) {
    const response = await send(record.id, { type });
    assert.equal(response.status, 400, type);
    assert.match((await response.json()).error, /not available for claude sessions/);
  }
  assert.equal(launches().length, before);
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
