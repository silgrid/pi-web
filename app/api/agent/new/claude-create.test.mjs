import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";

// Under os.tmpdir(), registrable through the operator prefix (as route.test.mjs does).
process.env.PI_WEB_ALLOWED_ROOT_PREFIXES = os.tmpdir();
process.env.PI_WEB_IDLE_TIMEOUT_MS = "0";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-claude-create-"));
const agentDir = path.join(scratch, "agent");
const binDir = path.join(scratch, "bin");
const project = path.join(scratch, "project");
const stubLog = path.join(scratch, "stub.jsonl");
fs.mkdirSync(binDir);
fs.mkdirSync(project);
fs.copyFileSync(new URL("../../../../lib/__fixtures__/claude-stub/claude.mjs", import.meta.url), path.join(binDir, "claude"));
fs.chmodSync(path.join(binDir, "claude"), 0o755);
fs.symlinkSync(decodeURIComponent(new URL("../../../../lib/__fixtures__/claude-2.1.312", import.meta.url).pathname), path.join(scratch, "claude-2.1.312"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const originalPath = process.env.PATH;
process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
process.env.PI_TEST_CLAUDE_STUB_LOG = stubLog;
process.env.PI_TEST_CLAUDE_STUB_MODE = "replay";

const startRpcCalls = [];
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
  virtualModules: {
    "@/lib/rpc-manager": {
      startRpcSession: async (key, _id, cwd) => {
        startRpcCalls.push({ key, cwd });
        return { session: { send: async () => ({ model: { id: "m", provider: "p" }, thinkingLevel: "off" }) }, realSessionId: "pi-session" };
      },
    },
  },
});
const { POST } = await jiti.import("./route.ts");
const index = await jiti.import("../../../../lib/claude-index.ts");
const claude = await jiti.import("../../../../lib/claude-session.ts");

test.after(async () => {
  await claude.shutdownAllClaudeSessions();
  process.env.PATH = originalPath;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const post = (body) => POST(new Request("http://localhost/api/agent/new", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));
const launches = () => (fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === "launch") : []);

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(25);
  }
  assert.fail(message);
}

test("an unregistrable cwd is refused with the pi route's reason before any side effect", async () => {
  const response = await post({ cwd: path.parse(path.resolve(os.tmpdir())).root, type: "prompt", message: "hi", harness: "claude", modelAlias: "sonnet" });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.reason, "outsideRegistrationPrefix");
  assert.equal(body.code, "prompt_rejected");
  assert.equal(fs.existsSync(agentDir), false, "no config dir, no index");
  assert.equal(launches().length, 0, "no claude process");
  assert.equal(startRpcCalls.length, 0);
});

test("alias and preset are validated; other commands are refused for claude", async () => {
  for (const body of [
    { harness: "claude", modelAlias: "gpt" },
    { harness: "claude" },
    { harness: "claude", modelAlias: "sonnet", claudePreset: "full" },
    { harness: "codex", modelAlias: "sonnet" },
    { harness: "claude", modelAlias: "sonnet", type: "bash", command: "ls" },
  ]) {
    const response = await post({ cwd: project, type: "prompt", message: "hi", ...body });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.existsSync(agentDir), false);
  assert.equal(launches().length, 0);
});

test("claude missing from PATH is refused without an index entry or a config dir", async () => {
  process.env.PATH = path.join(scratch, "empty");
  try {
    const response = await post({ cwd: project, type: "prompt", message: "hi", harness: "claude", modelAlias: "sonnet" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /claude was not found on PATH/);
  } finally {
    process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  }
  assert.equal(fs.existsSync(agentDir), false);
});

test("a claude create writes the index entry and the config dir, spawns --session-id with the chosen flags and sends the prompt", async () => {
  const response = await post({ cwd: project, type: "prompt", message: "first words", harness: "claude", modelAlias: "haiku", claudePreset: "writable" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.deepEqual(body.model, { provider: "claude", modelId: "haiku" });
  const record = index.getClaudeSessionRecord(body.sessionId);
  assert.equal(record.cwd, fs.realpathSync(project));
  assert.equal(record.modelAlias, "haiku");
  assert.equal(record.preset, "writable");
  assert.equal(record.firstMessage, "first words");
  assert.equal(fs.readFileSync(path.join(agentDir, "claude", "settings.json"), "utf8"), "{}\n");
  const launch = await waitFor(() => launches()[0], 5_000, "no claude launch");
  assert.deepEqual(launch.argv.slice(-4), ["--model", "haiku", "--session-id", body.sessionId]);
  assert.ok(launch.argv.includes("acceptEdits"));
  const stdin = await waitFor(
    () => fs.readFileSync(stubLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.kind === "stdin"),
    5_000,
    "the prompt never reached stdin",
  );
  assert.equal(JSON.parse(stdin.line).message.content, "first words");
  assert.equal(startRpcCalls.length, 0, "no pi session for a claude create");
});

test("ensure_session with the default preset creates a read-only session and sends nothing", async () => {
  const before = launches().length;
  const response = await post({ cwd: project, type: "ensure_session", harness: "claude", modelAlias: "claude-default" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data, null);
  assert.equal(index.getClaudeSessionRecord(body.sessionId).preset, "read-only");
  const launch = await waitFor(() => launches()[before], 5_000, "no claude launch");
  assert.ok(!launch.argv.includes("--model"));
  assert.ok(launch.argv.includes("--bare"));
});

test("without a harness (or with pi) the pi path runs unchanged and spawns no claude", async () => {
  const before = launches().length;
  for (const extra of [{}, { harness: "pi" }]) {
    startRpcCalls.length = 0;
    const response = await post({ cwd: project, type: "ensure_session", ...extra });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, sessionId: "pi-session", data: null, model: { provider: "p", modelId: "m" }, thinkingLevel: "off" });
    assert.equal(startRpcCalls.length, 1);
  }
  await delay(100);
  assert.equal(launches().length, before);
});
