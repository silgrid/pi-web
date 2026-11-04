import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession, newSessionRequestBody, foldClaudeSubagents } = await jiti.import("./useAgentSession.ts");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

test("a pi create body is the one sent before claude existed", () => {
  const options = { cwd: "/p", harness: "pi", claudeModel: "claude-sonnet-5-5" };
  assert.deepEqual(newSessionRequestBody(options), { cwd: "/p", type: "ensure_session" });
  assert.deepEqual(
    newSessionRequestBody({ ...options, toolNames: ["read"], model: { provider: "a", modelId: "b" }, thinkingLevel: "high" }),
    { cwd: "/p", type: "ensure_session", toolNames: ["read"], provider: "a", modelId: "b", thinkingLevel: "high" },
  );
});

test("a claude create body carries the harness and the full model name, and no preset, pi model, reasoning or tools", () => {
  assert.deepEqual(
    newSessionRequestBody({ cwd: "/p", harness: "claude", claudeModel: "claude-haiku-5-5", toolNames: ["read"], model: { provider: "a", modelId: "b" }, thinkingLevel: "high" }),
    { cwd: "/p", type: "ensure_session", harness: "claude", model: "claude-haiku-5-5" },
  );
});

test("a fresh composer set to claude creates a claude session, sends no set_model and reports its choices", async () => {
  const requests = [];
  const choices = [];
  globalThis.EventSource = class {
    readyState = 0;
    constructor(url) { this.url = url; queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, body });
    if (url === "/api/claude") return json({ available: true });
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [], defaultModel: { provider: "p", modelId: "m" } });
    if (url === "/api/agent/new") return json({ success: true, sessionId: "c1", model: { provider: "claude", modelId: "claude-haiku-5-5" } });
    if (url === "/api/agent/c1") return json({ success: true, data: null });
    return json({});
  };
  const hook = renderHook(useAgentSession, {
    session: null,
    newSessionCwd: "/project",
    newSessionDraftKey: "new:draft",
    onNewSessionChoicesChange: (value) => choices.push(value),
    t: (key) => key,
  });
  await settle();
  hook.flush();
  assert.deepEqual(hook.result.claudeAvailability, { available: true });
  assert.equal(hook.result.newSessionHarness, "pi");
  assert.equal(hook.result.isClaudeSession, false);
  hook.result.chooseNewSessionHarness("claude");
  hook.flush();
  assert.equal(hook.result.newSessionClaudeModel, "claude-opus-5-5", "claude starts at its default full name");
  hook.result.setNewSessionClaudeModel("claude-haiku-5-5");
  hook.flush();
  await settle();
  assert.equal(hook.result.isClaudeSession, true);
  assert.deepEqual(choices.at(-1), { model: null, thinkingLevel: null, harness: "claude", claudeModel: "claude-haiku-5-5", claudeEffort: "default" });
  const originalError = console.error;
  console.error = () => {};
  try {
    await hook.result.handleSend("hello claude");
    await settle();
  } finally {
    console.error = originalError;
  }
  const create = requests.find((request) => request.url === "/api/agent/new");
  assert.deepEqual(create.body, { cwd: "/project", type: "ensure_session", harness: "claude", model: "claude-haiku-5-5" });
  const commands = requests.filter((request) => request.url === "/api/agent/c1" && request.body).map((request) => request.body.type);
  assert.deepEqual(commands, ["prompt"]);
  hook.unmount();
});

test("an image-only claude send reports [Image] as the new session's first message", async () => {
  const requests = [];
  const created = [];
  globalThis.EventSource = class {
    readyState = 0;
    constructor(url) { this.url = url; queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ url, body });
    if (url === "/api/claude") return json({ available: true });
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [], defaultModel: { provider: "p", modelId: "m" } });
    if (url === "/api/agent/new") return json({ success: true, sessionId: "c9", model: { provider: "claude", modelId: "claude-opus-5-5" } });
    if (url === "/api/agent/c9") return json({ success: true, data: null });
    return json({});
  };
  const hook = renderHook(useAgentSession, {
    session: null,
    newSessionCwd: "/project",
    newSessionDraftKey: "new:image-only",
    onSessionCreated: (info) => created.push(info),
    t: (key) => key,
  });
  await settle();
  hook.flush();
  hook.result.chooseNewSessionHarness("claude");
  hook.flush();
  await settle();
  const originalError = console.error;
  console.error = () => {};
  try {
    await hook.result.handleSend("", [{ data: "aW1hZ2U=", mimeType: "image/png", previewUrl: "blob:x" }]);
    await settle();
  } finally {
    console.error = originalError;
  }
  const prompt = requests.find((request) => request.url === "/api/agent/c9" && request.body?.type === "prompt");
  assert.deepEqual(prompt.body, { type: "prompt", message: "", images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] });
  assert.equal(created.at(-1)?.firstMessage, "[Image]");
  hook.unmount();
});

test("switching the harness resets the destination's model: claude to claude-opus-5-5, pi to its default (no override)", async () => {
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  const modelList = [{ provider: "p", id: "m0", name: "Model 0" }, { provider: "p", id: "m1", name: "Model 1" }];
  globalThis.fetch = async (url) => {
    if (url === "/api/claude") return json({ available: true, models: [], defaultModel: "claude-opus-5-5" });
    if (url.startsWith("/api/models")) return json({ models: { "p/m0": "Model 0", "p/m1": "Model 1" }, modelList, defaultModel: { provider: "p", modelId: "m0" } });
    return json({});
  };
  const hook = renderHook(useAgentSession, { session: null, newSessionCwd: "/project", newSessionDraftKey: "new:switch", t: (key) => key });
  await settle();
  hook.flush();
  await hook.result.handleModelChange("p", "m1");
  hook.flush();
  assert.deepEqual(hook.result.displayModel, { provider: "p", modelId: "m1" });
  hook.result.chooseNewSessionHarness("claude");
  hook.flush();
  hook.result.setNewSessionClaudeModel("claude-haiku-5-5");
  hook.flush();
  assert.equal(hook.result.newSessionClaudeModel, "claude-haiku-5-5");
  hook.result.chooseNewSessionHarness("pi");
  hook.flush();
  assert.equal(hook.result.newSessionHarness, "pi");
  assert.equal(hook.result.newSessionModel, null, "no pi override is kept");
  assert.equal(hook.result.isAutoModelSelection, true);
  assert.deepEqual(hook.result.displayModel, { provider: "p", modelId: "m0" }, "pi's default model again");
  hook.result.chooseNewSessionHarness("claude");
  hook.flush();
  assert.equal(hook.result.newSessionClaudeModel, "claude-opus-5-5", "claude resets to its default full name");
  hook.unmount();
});

// the claude subagent run map.
const sdkCall = (id, text) => ({ id, message: { role: "assistant", content: [{ type: "toolCall", id: `toolu_${id}`, name: "Read", arguments: { file_path: text } }] } });
const subRun = (entries, over = {}) => ({ toolCallId: "toolu_agent", background: true, status: "running", entries, ...over });

test("history seeds the run map, live deltas merge by entry id, and a mid-run reload shows each entry once", () => {
  let state = { sessionId: null, runs: {} };
  state = foldClaudeSubagents(state, "c2", [subRun([sdkCall("e1", "a")])], "history");
  assert.deepEqual(state.runs.toolu_agent.entries[0].message.content[0], { type: "toolCall", toolCallId: "toolu_e1", toolName: "Read", input: { file_path: "a" } }, "entries take the chat's tool call shape");
  state = foldClaudeSubagents(state, "c2", [subRun([sdkCall("e2", "b")], { progress: "Reading" })], "live");
  state = foldClaudeSubagents(state, "c2", [subRun([sdkCall("e2", "b")])], "live");
  assert.deepEqual(state.runs.toolu_agent.entries.map((entry) => entry.id), ["e1", "e2"], "a repeated live entry is not added twice");
  // A reload mid-run: the read holds e1 and e2 on disk, then the stream brings e3.
  state = foldClaudeSubagents(state, "c2", [subRun([sdkCall("e1", "a"), sdkCall("e2", "b")])], "history");
  state = foldClaudeSubagents(state, "c2", [subRun([sdkCall("e3", "c")], { status: "completed" })], "live");
  assert.deepEqual(state.runs.toolu_agent.entries.map((entry) => entry.id), ["e1", "e2", "e3"]);
  assert.equal(state.runs.toolu_agent.status, "completed");
  assert.equal(state.runs.toolu_agent.progress, "Reading");
  const same = foldClaudeSubagents(state, "c2", undefined, "history");
  assert.equal(same, state, "a detail without claudeSubagents changes nothing");
  assert.deepEqual(foldClaudeSubagents(state, "other", undefined, "history").runs, {}, "another session starts empty");
});

test("the hook exposes the session's runs from history and merges claude_subagent events; a session without any stays empty", async () => {
  const sources = [];
  globalThis.EventSource = class {
    readyState = 0;
    constructor(url) { this.url = url; sources.push(this); queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  const detail = (id, claudeSubagents) => ({
    sessionId: id, filePath: "", totalActiveMs: 0, tree: [], leafId: null, snapshotRevision: null, toolNames: [],
    info: { id, path: "", cwd: "/project", created: "", modified: "", messageCount: 0, firstMessage: "", harness: "claude", claude: { model: "claude-haiku-5-5" } },
    context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "off", model: null },
    ...(claudeSubagents ? { claudeSubagents } : {}),
  });
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("/api/sessions/c3")) return json(detail("c3", [subRun([sdkCall("e1", "a")])]));
    if (String(url).startsWith("/api/sessions/c4")) return json(detail("c4"));
    if (String(url).startsWith("/api/models")) return json({ models: {}, modelList: [], defaultModel: null });
    return json({});
  };
  const session = { id: "c3", path: "", cwd: "/project", created: "", modified: "", messageCount: 0, firstMessage: "", harness: "claude", claude: { model: "claude-haiku-5-5" } };
  const hook = renderHook(useAgentSession, { session, newSessionCwd: null, newSessionDraftKey: null, t: (key) => key });
  await settle();
  hook.flush();
  assert.deepEqual(Object.keys(hook.result.claudeSubagents), ["toolu_agent"]);
  sources.at(-1).onmessage?.({ data: JSON.stringify({ type: "claude_subagent", run: subRun([sdkCall("e2", "b")], { status: "completed" }) }) });
  await settle();
  hook.flush();
  assert.deepEqual(hook.result.claudeSubagents.toolu_agent.entries.map((entry) => entry.id), ["e1", "e2"]);
  assert.equal(hook.result.claudeSubagents.toolu_agent.status, "completed");
  assert.equal(hook.result.messages.length, 0, "a subagent event adds no main message");
  hook.unmount();

  const plain = renderHook(useAgentSession, { session: { ...session, id: "c4" }, newSessionCwd: null, newSessionDraftKey: null, t: (key) => key });
  await settle();
  plain.flush();
  assert.deepEqual(plain.result.claudeSubagents, {});
  plain.unmount();
});

// claude's effort in the create body, and an open session's model / effort switches.
test("a claude create body carries a picked effort and never the default entry", () => {
  const options = { cwd: "/p", harness: "claude", claudeModel: "claude-opus-5-5" };
  assert.deepEqual(newSessionRequestBody({ ...options, claudeEffort: "medium" }), { cwd: "/p", type: "ensure_session", harness: "claude", model: "claude-opus-5-5", effort: "medium" });
  assert.deepEqual(newSessionRequestBody({ ...options, claudeEffort: "default" }), { cwd: "/p", type: "ensure_session", harness: "claude", model: "claude-opus-5-5" });
});

test("a fresh claude composer's effort seeds the created session; it sends no set_model or set_effort", async () => {
  const requests = [];
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url === "/api/claude") return json({ available: true });
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [], defaultModel: null });
    if (url === "/api/agent/new") return json({ success: true, sessionId: "c7" });
    if (url === "/api/agent/c7") return json({ success: true, data: null });
    return json({});
  };
  const hook = renderHook(useAgentSession, { session: null, newSessionCwd: "/project", newSessionDraftKey: "new:effort", t: (key) => key });
  await settle();
  hook.flush();
  hook.result.chooseNewSessionHarness("claude");
  hook.flush();
  hook.result.handleClaudeEffortChange("high");
  hook.flush();
  assert.equal(hook.result.newSessionClaudeEffort, "high");
  const originalError = console.error;
  console.error = () => {};
  try {
    await hook.result.handleSend("seeded");
    await settle();
  } finally {
    console.error = originalError;
  }
  assert.equal(requests.find((request) => request.url === "/api/agent/new").body.effort, "high");
  assert.deepEqual(requests.filter((request) => request.url === "/api/agent/c7" && request.body).map((request) => request.body.type), ["prompt"]);
  hook.unmount();
});

test("an open claude session shows a switch only once claude accepted it; a refusal is one localized line the next success clears", async () => {
  const answers = [
    { success: true, data: { model: "claude-opus-5-5", rejected: true, error: "API error · model not changed", errorCode: "check_failed" } },
    { success: true, data: { model: "claude-fable-5-1" } },
    { success: true, data: { effort: "max" } },
  ];
  const commands = [];
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { queueMicrotask(() => { this.readyState = 1; this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }); }); }
    close() { this.readyState = 2; }
  };
  const info = { id: "c5", path: "", cwd: "/project", created: "", modified: "", messageCount: 0, firstMessage: "", harness: "claude", claude: { model: "claude-opus-5-5", effort: "default" } };
  globalThis.fetch = async (url, init = {}) => {
    if (url === "/api/agent/c5" && init.body) {
      commands.push(JSON.parse(init.body));
      return json(answers.shift());
    }
    if (String(url).startsWith("/api/sessions/c5")) {
      return json({ sessionId: "c5", filePath: "", totalActiveMs: 0, tree: [], leafId: null, snapshotRevision: null, toolNames: [], info, context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, turnsBefore: 0, thinkingLevel: "off", model: null } });
    }
    if (String(url).startsWith("/api/models")) return json({ models: {}, modelList: [], defaultModel: null });
    return json({});
  };
  const t = (key, params = {}) => (key === "claude.switchModelError" ? `Could not switch model: ${params.error}` : key);
  const hook = renderHook(useAgentSession, { session: info, newSessionCwd: null, newSessionDraftKey: null, t });
  await settle();
  hook.flush();
  hook.result.handleClaudeModelChange("claude-haiku-5-5");
  await settle();
  hook.flush();
  assert.equal(hook.result.claudeSessionChoices.model, "claude-opus-5-5", "a refused switch keeps the old model");
  assert.equal(hook.result.claudeSwitchError, "Could not switch model: API error · model not changed");
  hook.result.handleClaudeModelChange("claude-fable-5-1");
  await settle();
  hook.flush();
  assert.equal(hook.result.claudeSessionChoices.model, "claude-fable-5-1");
  assert.equal(hook.result.claudeSwitchError, null, "the next success replaces the line");
  hook.result.handleClaudeEffortChange("max");
  await settle();
  hook.flush();
  assert.equal(hook.result.claudeSessionChoices.effort, "max");
  assert.deepEqual(commands, [{ type: "set_model", model: "claude-haiku-5-5" }, { type: "set_model", model: "claude-fable-5-1" }, { type: "set_effort", effort: "max" }]);
  hook.unmount();
});
