import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

// a session read whose answer was generated before the newest
// reply must not remove that reply from the view once the stream has delivered
// it. On a weak network a mid-run forced read is held back; the stream resumes
// and renders the reply; then the late answer lands. Two shapes are pinned:
//  - a newer read has already applied, so the late answer is older than the
//    view and must be dropped;
//  - nothing newer has applied yet, so the snapshot must keep the messages the
//    stream delivered after the read was issued.
const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const { deleteSessionViewSnapshot } = await jiti.import("@/lib/session-view-cache");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();
globalThis.requestAnimationFrame ??= () => 0;
globalThis.cancelAnimationFrame ??= () => {};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };
const until = async (predicate, message) => {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
};
const earlier = { role: "user", content: "earlier", timestamp: 1 };
const prompt = { role: "user", content: "first submission", timestamp: 10 };
const reply = (text, timestamp) => ({ role: "assistant", content: [{ type: "text", text }], model: "m", provider: "p", timestamp });
const replyText = "REPLY-LATE-177";
const isReply = (message) => message.role === "assistant" && message.content?.[0]?.text === replyText;

function deferred() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
}

async function setup() {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  const sources = [];
  const server = {
    context: { messages: [earlier], entryIds: ["e1"] },
    gate: null,
    reads: [],
    state: { running: true, state: { isStreaming: true, isPromptRunning: true } },
    statusGate: null,
    statusReads: [],
    statusState: { isStreaming: true, isPromptRunning: true },
    response: Promise.withResolvers(),
  };
  globalThis.EventSource = class {
    readyState = 0;
    onmessage = null;
    onerror = null;
    constructor(url) { this.url = url; sources.push(this); }
    close() { this.readyState = 2; }
    emit(event) {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify(event) });
    }
  };
  globalThis.fetch = async (requestUrl, init = {}) => {
    const url = requestUrl.replace("?systemPrompt=0", "");
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [] });
    if (url.startsWith("/api/sessions/A/context?")) return json({ context: { ...server.context, oldestEntryId: null, hasMore: false } });
    if (url.startsWith("/api/sessions/A?")) {
      // The answer is generated from the file now; only its delivery waits
      // behind the gate (a slow link's late response).
      const context = { messages: [...server.context.messages], entryIds: [...server.context.entryIds], oldestEntryId: null, hasMore: false };
      const snapshotRevision = `r:${context.entryIds.join(",")}`;
      const gate = server.gate;
      server.gate = null;
      server.reads.push({ revision: snapshotRevision, held: Boolean(gate) });
      const body = json({
        sessionId: "A",
        filePath: "/A.jsonl",
        leafId: null,
        tree: [],
        treeFormat: "summary",
        snapshotRevision,
        context,
      });
      if (gate) await gate.promise;
      return body;
    }
    if (url === "/api/sessions/A/state") return json(server.state);
    if (url === "/api/agent/A" && init.body) {
      await server.response.promise;
      return json({ success: true, data: null });
    }
    if (url === "/api/agent/A") {
      // The status answer is generated now; only its delivery can wait (a slow
      // link), so a setStatus event can land after the read began.
      const gate = server.statusGate;
      server.statusGate = null;
      server.statusReads.push({ held: Boolean(gate) });
      const body = json({ running: true, state: server.statusState });
      if (gate) await gate.promise;
      return body;
    }
    return json({});
  };
  const hook = renderHook(useAgentSession, {
    session: { id: "A", cwd: "/project", path: "/A.jsonl", name: "A" },
    newSessionCwd: null,
    newSessionDraftKey: null,
    t: (key) => key,
  });
  await settle();
  hook.flush();
  for (const source of sources) if (source.readyState === 0) source.emit({ type: "connected", sessionId: "A", isStreaming: false });
  await settle();
  hook.flush();
  const emit = async (event) => {
    sources.filter((source) => source.readyState === 1).at(-1)?.emit(event);
    await settle();
    hook.flush();
  };
  const sending = hook.result.handleSend("first submission");
  await settle();
  hook.flush();
  assert.equal(hook.result.agentRunning, true, "the run is active");
  return {
    hook,
    emit,
    server,
    sending,
    teardown: () => {
      hook.unmount();
      for (const source of sources) source.close();
      mock.timers.reset();
      deleteSessionViewSnapshot("A");
    },
  };
}

async function withSetup(body) {
  const originalError = console.error;
  console.error = () => {};
  const env = await setup();
  try {
    await body(env);
  } finally {
    console.error = originalError;
    env.server.response.resolve();
    await env.sending;
    env.teardown();
  }
}

// The mid-run read is answered from the file before the reply is written; its
// answer is held until the caller releases it.
async function holdMidRunRead(env) {
  const gate = deferred();
  env.server.gate = gate;
  env.server.context = { messages: [earlier, prompt], entryIds: ["e1", "e2"] };
  const held = env.hook.result.refreshFromDisk("A");
  await until(() => env.server.reads.length === 2, "the mid-run forced read was not issued");
  await settle();
  env.hook.flush();
  return { held, gate };
}

async function streamTheReply(env) {
  await env.emit({ type: "message_end", message: prompt });
  await env.emit({ type: "message_end", message: reply(replyText, 20) });
  assert.equal(env.hook.result.messages.filter(isReply).length, 1, "the stream rendered the reply");
}

test("a late read whose answer predates a newer applied read cannot remove the reply", async () => {
  await withSetup(async (env) => {
    const { held, gate } = await holdMidRunRead(env);
    await streamTheReply(env);

    // The run's end read is answered with the reply written, and applies first.
    env.server.context = { messages: [earlier, prompt, reply(replyText, 20)], entryIds: ["e1", "e2", "e3"] };
    await env.emit({ type: "agent_end" });
    await until(() => env.server.reads.length >= 3, "the end-of-run read was not issued");
    await settle();
    env.hook.flush();
    assert.equal(env.hook.result.messages.filter(isReply).length, 1, "the newer read applied with the reply");

    // The slow answer lands last: it is older than the view and must be dropped.
    gate.resolve();
    await held;
    await settle();
    env.hook.flush();

    const messages = env.hook.result.messages;
    assert.equal(messages.filter(isReply).length, 1, "the late read did not remove the reply");
    assert.equal(messages.filter((message) => message.role === "user" && message.content === "first submission").length, 1);
    assert.equal(messages.at(-1).content?.[0]?.text, replyText, "the reply is still the transcript's last message");
  });
});

test("a read answered before the reply was written keeps the reply the stream delivered after it was issued", async () => {
  await withSetup(async (env) => {
    const { held, gate } = await holdMidRunRead(env);
    await streamTheReply(env);

    // No newer read has applied: this answer is the first to land, but the
    // stream content after its issue is newer than its snapshot.
    gate.resolve();
    await held;
    await settle();
    env.hook.flush();

    const messages = env.hook.result.messages;
    assert.equal(messages.filter(isReply).length, 1, "the reply the stream delivered after the read was issued stayed");
    assert.equal(messages.filter((message) => message.role === "user" && message.content === "first submission").length, 1);
    assert.equal(messages.at(-1).content?.[0]?.text, replyText, "the reply is still the transcript's last message");
  });
});


// the review finding: the ordering that drops a stale snapshot must not
// drop the includeState half of that read. Its /state request is separate and
// later, and the fields it applies (here queuedMessages) are ordered on their
// own.
test("an includeState read overtaken by a newer read still applies its state", async () => {
  await withSetup(async (env) => {
    env.server.response.resolve();
    await env.sending;

    // /reload's read is answered but held: a slow link.
    const gate = deferred();
    env.server.gate = gate;
    const reload = env.hook.result.handleBuiltinSlashCommand("/reload");
    await until(() => env.server.reads.some((read) => read.held), "the /reload read was not issued");

    // A newer forced read applies while the /reload answer is still held.
    env.server.context = { messages: [earlier, prompt], entryIds: ["e1", "e2"] };
    await env.hook.result.refreshFromDisk("A");
    await settle();
    env.hook.flush();

    // The stale answer still reads and applies its state.
    env.server.state = {
      running: true,
      state: { isStreaming: true, isPromptRunning: true, queuedMessages: { steering: ["kept from the stale read"], followUp: [] } },
    };
    gate.resolve();
    await reload;
    await settle();
    env.hook.flush();

    assert.deepEqual(env.hook.result.queuedMessages.steering, ["kept from the stale read"],
      "the overtaken read's state half still applied");
  });
});

// the review finding: a status event newer than the read survives it, as
// widgets already do.
test("a status event that arrives after an agent_end read began survives its reply", async () => {
  await withSetup(async (env) => {
    env.server.response.resolve();
    await env.sending;

    const gate = deferred();
    env.server.statusState = { isStreaming: true, isPromptRunning: true, extensionStatuses: [{ key: "saved", text: "from the snapshot" }] };
    env.server.statusGate = gate;
    await env.emit({ type: "agent_end" });
    await until(() => env.server.statusReads.some((read) => read.held), "the end-of-run state read was not issued");

    await env.emit({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "late", statusText: "live after the read" });
    assert.equal(env.hook.result.extensionStatuses.some((status) => status.key === "late"), true,
      "the stream's status rendered before the read answered");

    gate.resolve();
    await settle();
    env.hook.flush();

    assert.deepEqual(env.hook.result.extensionStatuses.map((status) => status.key).sort(), ["late", "saved"],
      "the newer status event survived the read, and the other key took the snapshot");
  });
});
