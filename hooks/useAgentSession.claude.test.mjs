import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(pathToFileURL(shimPath).href);
const { useAgentSession, newSessionRequestBody } = await jiti.import("./useAgentSession.ts");

globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible" });
globalThis.window ??= new EventTarget();

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const settle = async () => { for (let index = 0; index < 10; index++) await new Promise((resolve) => setImmediate(resolve)); };

test("a pi create body is the one sent before claude existed", () => {
  const options = { cwd: "/p", harness: "pi", modelAlias: "sonnet", claudePreset: "writable" };
  assert.deepEqual(newSessionRequestBody(options), { cwd: "/p", type: "ensure_session" });
  assert.deepEqual(
    newSessionRequestBody({ ...options, toolNames: ["read"], model: { provider: "a", modelId: "b" }, thinkingLevel: "high" }),
    { cwd: "/p", type: "ensure_session", toolNames: ["read"], provider: "a", modelId: "b", thinkingLevel: "high" },
  );
});

test("a claude create body carries the harness, alias and preset and no pi model, reasoning or tools", () => {
  assert.deepEqual(
    newSessionRequestBody({ cwd: "/p", harness: "claude", modelAlias: "haiku", claudePreset: "read-only", toolNames: ["read"], model: { provider: "a", modelId: "b" }, thinkingLevel: "high" }),
    { cwd: "/p", type: "ensure_session", harness: "claude", modelAlias: "haiku", claudePreset: "read-only" },
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
    if (url === "/api/claude") return json({ available: true, configDir: "/agent/claude" });
    if (url.startsWith("/api/models")) return json({ models: {}, modelList: [], defaultModel: { provider: "p", modelId: "m" } });
    if (url === "/api/agent/new") return json({ success: true, sessionId: "c1", model: { provider: "claude", modelId: "opus" } });
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
  assert.deepEqual(hook.result.claudeAvailability, { available: true, configDir: "/agent/claude" });
  assert.equal(hook.result.newSessionHarness, "pi");
  assert.equal(hook.result.isClaudeSession, false);
  hook.result.setNewSessionHarness("claude");
  hook.result.setNewSessionModelAlias("opus");
  hook.flush();
  await settle();
  assert.equal(hook.result.isClaudeSession, true);
  assert.deepEqual(choices.at(-1), { model: null, thinkingLevel: null, harness: "claude", modelAlias: "opus", claudePreset: "read-only" });
  const originalError = console.error;
  console.error = () => {};
  try {
    await hook.result.handleSend("hello claude");
    await settle();
  } finally {
    console.error = originalError;
  }
  const create = requests.find((request) => request.url === "/api/agent/new");
  assert.deepEqual(create.body, { cwd: "/project", type: "ensure_session", harness: "claude", modelAlias: "opus", claudePreset: "read-only" });
  const commands = requests.filter((request) => request.url === "/api/agent/c1" && request.body).map((request) => request.body.type);
  assert.deepEqual(commands, ["prompt"]);
  hook.unmount();
});
