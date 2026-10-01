import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setImmediate as nextMacrotask, setTimeout as delay } from "node:timers/promises";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  McpHost,
  resolveMcpIdleMs,
  untrustedProjectServerNames,
  watchConnection,
  withReachableExposure,
} = await jiti.import("./mcp-host.ts");
const { loadPiSdkInternals } = await jiti.import("./pi-sdk-internals.ts");

class FakeTransport {
  sent = [];
  messageListeners = new Set();
  closeListeners = new Set();
  async send(message) {
    this.sent.push(message);
  }
  onMessage(listener) {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }
  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  receive(message) {
    for (const listener of this.messageListeners) listener(message);
  }
  close() {
    for (const listener of this.closeListeners) listener();
  }
  /** The client side of a handshake: initialize answered, then initialized sent. */
  async handshake(capabilities) {
    this.receive({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", capabilities } });
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
}

test("PI_WEB_MCP_IDLE_MS defaults to 10 minutes and 0 keeps servers connected", (t) => {
  t.mock.method(console, "warn", () => {});
  assert.equal(resolveMcpIdleMs(undefined), 600_000);
  assert.equal(resolveMcpIdleMs(" "), 600_000);
  assert.equal(resolveMcpIdleMs("0"), 0);
  assert.equal(resolveMcpIdleMs("1500"), 1500);
  assert.equal(resolveMcpIdleMs("soon"), 600_000);
  assert.equal(resolveMcpIdleMs("-1"), 600_000);
});

test("without a codemode sandbox, script-only tools are offered through tool_search", () => {
  const config = { command: "srv", toolExposure: { a: "codemode-deferred", b: "direct", c: "codemode" } };
  assert.equal(withReachableExposure(config, true), config);
  assert.deepEqual(withReachableExposure(config, false), {
    command: "srv",
    exposure: "deferred",
    toolExposure: { a: "deferred", b: "direct", c: "deferred" },
  });
  assert.deepEqual(withReachableExposure({ url: "https://x", exposure: "direct" }, false), { url: "https://x", exposure: "direct" });
  assert.deepEqual(withReachableExposure({ url: "https://x", exposure: "hidden" }, false), { url: "https://x", exposure: "hidden" });
});

function watched(transport) {
  const outcomes = [];
  watchConnection(transport, (outcome) => outcomes.push(outcome));
  return outcomes;
}

test("a connection is ready once its tool lists are answered, every page of them", async () => {
  const transport = new FakeTransport();
  const outcomes = watched(transport);
  await transport.handshake({ tools: {} });
  await nextMacrotask();
  assert.deepEqual(outcomes, [], "tools are expected but not listed yet");

  await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  transport.receive({ jsonrpc: "2.0", id: 1, result: { tools: [], nextCursor: "2" } });
  // The client asks for the next page in the microtasks that follow the answer.
  await Promise.resolve();
  await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: "2" } });
  await nextMacrotask();
  assert.deepEqual(outcomes, []);

  // A server-initiated request is not an answer.
  transport.receive({ jsonrpc: "2.0", id: 7, method: "roots/list" });
  transport.receive({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
  await nextMacrotask();
  assert.deepEqual(outcomes, ["ready"]);
  transport.close();
  assert.deepEqual(outcomes, ["ready"]);
});

test("a server without lists is ready after the handshake, and a closed one is not", async () => {
  const bare = new FakeTransport();
  const bareOutcomes = watched(bare);
  await bare.handshake({ prompts: {} });
  await nextMacrotask();
  assert.deepEqual(bareOutcomes, ["ready"]);

  const closed = new FakeTransport();
  const closedOutcomes = watched(closed);
  closed.close();
  await closed.handshake({});
  await nextMacrotask();
  assert.deepEqual(closedOutcomes, ["closed"]);
});

// ---------------------------------------------------------------------------

const MCP_COMMAND = { name: "mcp", sourceInfo: { path: "builtin:mcp" } };

function entry(name, config, scope = "global") {
  return { name, config, source: `/agent/${scope}.json`, scope };
}

/**
 * A pi whose MCP extension connects what is registered through the host's
 * transport factory, when the test says so.
 */
function setup({ servers = [], commands = [MCP_COMMAND], codemodeAvailable = true, projectTrusted = true, ...options } = {}) {
  const handlers = new Map();
  const log = [];
  const registered = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getCommands: () => commands,
    registerMcpServer(name, config) {
      if (name === "taken") throw new Error(`MCP server "taken" is registered by /ext/other.ts`);
      registered.set(name, config);
      log.push(`register ${name}`);
    },
    unregisterMcpServer(name) {
      registered.delete(name);
      log.push(`unregister ${name}`);
    },
  };
  const config = { servers };
  const loads = [];
  const trustReads = [];
  const host = new McpHost({
    agentDir: "/agent",
    internals: {
      loadMcpConfig: (loadOptions) => {
        loads.push(loadOptions);
        return { servers: config.servers, errors: [] };
      },
    },
    codemodeAvailable: () => codemodeAvailable,
    mayReadProjectConfig: (cwd) => {
      trustReads.push(cwd);
      return projectTrusted;
    },
    promptWaitMs: 5_000,
    idleMs: 0,
    ...options,
  });
  host.extension().factory(pi);
  // The wrapper's snapshot; the host must not read it.
  const ctx = {
    cwd: "/project",
    isProjectTrusted: () => {
      throw new Error("the host read the wrapper's trust snapshot");
    },
    isIdle: () => true,
  };
  const emit = (event) => {
    for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx);
  };
  emit("session_start");
  const transports = new Map();
  const factory = host.wrapTransportFactory((serverEntry) => {
    if (serverEntry.config.command === "broken") throw new Error("env \"TOKEN\" references PI_WEB_PASSWORD");
    const transport = new FakeTransport();
    transports.set(serverEntry.name, transport);
    return transport;
  });
  /** What the MCP extension does for a registered server: open its transport. */
  const connect = (name) => factory({ name, config: registered.get(name), source: "<inline:pi-web-mcp-host>", scope: "extension" }, "/project", undefined);
  return { host, log, registered, config, loads, trustReads, emit, ctx, transports, connect };
}

test("nothing is registered until a prompt, then only the servers that may connect", async () => {
  const { host, log, registered } = setup({
    servers: [
      entry("docs", { url: "https://docs.example/mcp" }),
      entry("off", { command: "srv", enabled: false }),
      entry("repo", { command: "repo-srv" }, "project"),
      entry("taken", { command: "srv" }),
    ],
    // Nothing connects here, so the prompt would wait the whole time.
    promptWaitMs: 10,
  });
  assert.deepEqual(log, []);

  await host.prepareForPrompt(new AbortController().signal);
  assert.deepEqual(log, ["register docs", "register repo"]);
  assert.deepEqual([...registered.keys()], ["docs", "repo"]);
  assert.deepEqual(host.serverStates(), [
    { name: "docs", scope: "global", state: "connecting" },
    { name: "repo", scope: "project", state: "connecting" },
    { name: "taken", scope: "global", state: "not-registered", error: "MCP server \"taken\" is registered by /ext/other.ts" },
  ]);
});

test("project entries follow the project's trust, which the SDK applies when it reads mcp.json", async () => {
  const trusted = setup({ promptWaitMs: 10 });
  await trusted.host.prepareForPrompt(new AbortController().signal);
  assert.deepEqual(trusted.loads, [{ agentDir: "/agent", cwd: "/project", projectTrusted: true }]);
  assert.deepEqual(trusted.trustReads, ["/project"]);

  const untrusted = setup({ projectTrusted: false, promptWaitMs: 10 });
  await untrusted.host.prepareForPrompt(new AbortController().signal);
  assert.deepEqual(untrusted.loads, [{ agentDir: "/agent", cwd: "/project", projectTrusted: false }]);
  // Asked again on every sync, never cached.
  await untrusted.host.prepareForPrompt(new AbortController().signal);
  assert.deepEqual(untrusted.trustReads, ["/project", "/project"]);
});

test("a prompt waits for servers still connecting, until they are ready", async () => {
  const { host, connect, transports } = setup({ servers: [entry("docs", { command: "docs-srv" })] });
  let prepared = false;
  const preparing = host.prepareForPrompt(new AbortController().signal).then(() => {
    prepared = true;
  });
  await delay(10);
  connect("docs");
  await delay(10);
  assert.equal(prepared, false);
  await transports.get("docs").handshake({});
  await preparing;
  assert.deepEqual(host.serverStates(), [{ name: "docs", scope: "global", state: "ready" }]);
});

test("Stop ends the wait at once", async () => {
  const { host, connect } = setup({ servers: [entry("slow", { command: "slow-srv" })] });
  const controller = new AbortController();
  const started = Date.now();
  const preparing = host.prepareForPrompt(controller.signal);
  await delay(10);
  connect("slow");
  controller.abort();
  await preparing;
  assert.ok(Date.now() - started < 1_000);
});

test("a server that outlasted one wait does not hold up the next prompt", async () => {
  const { host, connect } = setup({ servers: [entry("slow", { command: "slow-srv" })], promptWaitMs: 40 });
  const first = host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  connect("slow");
  const firstStarted = Date.now();
  await first;
  assert.ok(Date.now() - firstStarted >= 25);
  const secondStarted = Date.now();
  await host.prepareForPrompt(new AbortController().signal);
  assert.ok(Date.now() - secondStarted < 25);
});

test("a server whose transport cannot be built fails without a wait", async () => {
  const { host, connect } = setup({ servers: [entry("leaky", { command: "broken" })] });
  const preparing = host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  assert.throws(() => connect("leaky"), /PI_WEB_PASSWORD/);
  await preparing;
  assert.deepEqual(host.serverStates(), [{
    name: "leaky",
    scope: "global",
    state: "failed",
    error: "env \"TOKEN\" references PI_WEB_PASSWORD",
  }]);
});

test("a changed entry is replaced only once the extension has opened its connection", async () => {
  const { host, log, config, connect, transports } = setup({ servers: [entry("docs", { command: "v1" })] });
  // Registered, but the extension has not opened a connection yet.
  void host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  config.servers = [entry("docs", { command: "v2" })];
  const second = host.prepareForPrompt(new AbortController().signal);
  await delay(30);
  // Unregistering now would leave the extension nothing to close; it would connect v1 anyway.
  assert.deepEqual(log, ["register docs"]);
  connect("docs");
  await transports.get("docs").handshake({});
  await delay(5);
  assert.deepEqual(log, ["register docs", "unregister docs", "register docs"]);
  connect("docs");
  await transports.get("docs").handshake({});
  await second;

  config.servers = [];
  await host.prepareForPrompt(new AbortController().signal);
  assert.deepEqual(log, ["register docs", "unregister docs", "register docs", "unregister docs"]);
  assert.deepEqual(host.serverStates(), []);
});

test("an unchanged entry is left connected, however its file orders the keys", async () => {
  const { host, log, config, connect, transports } = setup({ servers: [entry("docs", { command: "srv", args: ["-v"] })] });
  const first = host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  connect("docs");
  await transports.get("docs").handshake({});
  await first;
  config.servers = [entry("docs", { args: ["-v"], command: "srv" })];
  await host.prepareForPrompt(new AbortController().signal);
  assert.deepEqual(log, ["register docs"]);
});

test("servers are registered with the exposure codemode can serve", async () => {
  const { host, registered } = setup({ servers: [entry("docs", { command: "srv" })], codemodeAvailable: false });
  void host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  assert.deepEqual(registered.get("docs"), { command: "srv", exposure: "deferred" });
});

test("the host stays out of the way when another extension owns /mcp", async () => {
  const { host, log } = setup({
    servers: [entry("docs", { command: "srv" })],
    commands: [{ name: "mcp", sourceInfo: { path: "/ext/other-mcp.ts" } }],
  });
  await host.prepareForPrompt(new AbortController().signal);
  assert.deepEqual(log, []);
});

test("an idle host unregisters its servers, but not while a run is going", async () => {
  const { host, log, emit, ctx, connect, transports } = setup({ servers: [entry("docs", { command: "srv" })], idleMs: 20 });
  const preparing = host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  connect("docs");
  await transports.get("docs").handshake({});
  await preparing;
  emit("agent_start");
  await delay(50);
  assert.deepEqual(log, ["register docs"], "a run keeps its servers");

  let idle = false;
  ctx.isIdle = () => idle;
  emit("agent_end");
  await delay(50);
  assert.deepEqual(log, ["register docs"], "a run pi still reports busy keeps its servers");

  idle = true;
  emit("agent_end");
  emit("agent_start");
  await delay(50);
  assert.deepEqual(log, ["register docs"], "a new run cancels the idle timer");

  emit("agent_end");
  await delay(50);
  assert.deepEqual(log, ["register docs", "unregister docs"]);
  // The next prompt connects them again.
  void host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  assert.deepEqual(log, ["register docs", "unregister docs", "register docs"]);
});

test("servers registered for a prompt that starts no run still idle out", async () => {
  // Stop during the wait, a slash command, a rejected preflight: no agent_end follows.
  const { host, log, connect, transports } = setup({ servers: [entry("docs", { command: "srv" })], idleMs: 20 });
  const preparing = host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  connect("docs");
  await transports.get("docs").handshake({});
  await preparing;
  await delay(50);
  assert.deepEqual(log, ["register docs", "unregister docs"]);
});

test("a sync that finishes after Stop gave up on it still lets its servers idle out", async () => {
  const { host, log, config, connect, transports } = setup({ servers: [entry("docs", { command: "v1" })], idleMs: 20 });
  // v1 is registered, but the extension has not opened its connection yet...
  void host.prepareForPrompt(new AbortController().signal);
  await delay(5);
  // ...so replacing it waits, and Stop ends the prompt while the sync is still queued.
  config.servers = [entry("docs", { command: "v2" })];
  const controller = new AbortController();
  const stopped = host.prepareForPrompt(controller.signal);
  await delay(5);
  controller.abort();
  await stopped;
  assert.deepEqual(log, ["register docs"]);

  connect("docs");
  await transports.get("docs").handshake({});
  await delay(5);
  assert.deepEqual(log, ["register docs", "unregister docs", "register docs"]);
  // The extension opens v2's connection in turn; the idle timer then releases it.
  connect("docs");
  await transports.get("docs").handshake({});
  await delay(50);
  assert.deepEqual(log, ["register docs", "unregister docs", "register docs", "unregister docs"]);
});

test("the idle timer does not run while a prompt waits for its servers", async () => {
  const { host, log, connect, transports } = setup({ servers: [entry("docs", { command: "srv" })], idleMs: 20 });
  let prepared = false;
  const preparing = host.prepareForPrompt(new AbortController().signal).then(() => {
    prepared = true;
  });
  await delay(5);
  connect("docs");
  await delay(60);
  assert.equal(prepared, false);
  assert.deepEqual(log, ["register docs"]);
  await transports.get("docs").handshake({});
  await preparing;
  await delay(50);
  assert.deepEqual(log, ["register docs", "unregister docs"]);
});

// ---------------------------------------------------------------------------
// Project trust, read from real files on every sync
// ---------------------------------------------------------------------------

/**
 * A host over real `mcp.json` files and a real `trust.json`, in a folder that
 * needed no trust when its session started. Every server the host registers
 * connects at once, so a sync never waits.
 */
async function trustFixture(t, { globalServers = { docs: { url: "https://docs.example/mcp" } }, beforeLoad } = {}) {
  const sdk = await loadPiSdkInternals();
  assert.equal(sdk.ok, true, sdk.reason);
  const internals = {
    loadMcpConfig(options) {
      beforeLoad?.(options);
      return sdk.loadMcpConfig(options);
    },
  };
  const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-host-trust-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const parent = join(root, "work");
  const cwd = join(parent, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: globalServers }));

  const handlers = new Map();
  const log = [];
  const registered = new Map();
  let factory;
  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getCommands: () => [MCP_COMMAND],
    registerMcpServer(name, config) {
      registered.set(name, config);
      log.push(`register ${name}`);
      // The extension opens the connection and the server answers.
      void factory({ name, config, source: "<inline:pi-web-mcp-host>", scope: "extension" }, cwd, undefined).handshake({});
    },
    unregisterMcpServer(name) {
      registered.delete(name);
      log.push(`unregister ${name}`);
    },
  };
  // No mayReadProjectConfig option: the host reads the folder and trust.json itself.
  const host = new McpHost({ agentDir, internals, codemodeAvailable: () => true, promptWaitMs: 2_000, idleMs: 0 });
  host.extension().factory(pi);
  factory = host.wrapTransportFactory(() => new FakeTransport());
  // What a wrapper built for a folder that needed no trust reports for the rest of its life.
  const ctx = { cwd, isProjectTrusted: () => true, isIdle: () => true };
  for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start" }, ctx);

  return {
    agentDir,
    parent,
    cwd,
    host,
    log,
    registered,
    trust: new ProjectTrustStore(agentDir),
    prompt: () => host.prepareForPrompt(new AbortController().signal),
    async writeProjectServers(servers) {
      await mkdir(join(cwd, ".pi"), { recursive: true });
      await writeFile(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: servers }));
    },
  };
}

test("a project's mcp.json that appears after the session started connects only once the project is trusted", async (t) => {
  const { cwd, host, log, registered, trust, prompt, writeProjectServers } = await trustFixture(t);
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs"]);

  // git pull, `pi mcp add -l`, or the model's write tool: the folder now requires trust.
  await writeProjectServers({ repo: { command: "repo-srv" } });
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs"], "the wrapper's stale snapshot does not count");
  assert.deepEqual(host.serverStates(), [
    { name: "docs", scope: "global", state: "ready" },
    { name: "repo", scope: "project", state: "not-trusted" },
  ]);

  trust.set(cwd, true);
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs", "repo"]);
  assert.deepEqual(host.serverStates(), [
    { name: "docs", scope: "global", state: "ready" },
    { name: "repo", scope: "project", state: "ready" },
  ]);

  // Revoked anywhere, the CLI included: the server goes at the next prompt.
  trust.set(cwd, false);
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs"]);
  assert.deepEqual(host.serverStates().map((server) => `${server.name}:${server.state}`), ["docs:ready", "repo:not-trusted"]);
  assert.deepEqual(log, ["register docs", "register repo", "unregister repo"], "the global server is left alone");
});

test("trust inherited from a parent folder connects a project's servers, and an exact false beneath it does not", async (t) => {
  const { cwd, parent, log, registered, trust, prompt, writeProjectServers } = await trustFixture(t);
  await writeProjectServers({ repo: { command: "repo-srv" } });
  trust.set(parent, true);
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs", "repo"]);

  trust.set(cwd, false);
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs"]);
  assert.deepEqual(log, ["register docs", "register repo", "unregister repo"]);
});

test("an untrusted project entry named like a global one leaves the global one connected", async (t) => {
  const { host, registered, prompt, writeProjectServers } = await trustFixture(t);
  await writeProjectServers({ docs: { command: "repo-docs" } });
  await prompt();
  assert.deepEqual(registered.get("docs"), { url: "https://docs.example/mcp" });
  assert.deepEqual(host.serverStates(), [
    { name: "docs", scope: "global", state: "ready" },
    { name: "docs", scope: "project", state: "not-trusted" },
  ]);
});

test("an unreadable trust.json counts as untrusted, with one warning", async (t) => {
  const { agentDir, cwd, registered, trust, prompt, writeProjectServers } = await trustFixture(t);
  await writeProjectServers({ repo: { command: "repo-srv" } });
  trust.set(cwd, true);
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs", "repo"]);

  const warn = t.mock.method(console, "warn", () => {});
  await writeFile(join(agentDir, "trust.json"), "{ not json");
  await prompt();
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs"]);
  const trustWarnings = warn.mock.calls.filter((call) => String(call.arguments[0]).includes("project trust"));
  assert.equal(trustWarnings.length, 1);
  assert.match(String(trustWarnings[0].arguments[0]), /trust\.json/);
});

test("a trust.json still locked by another process counts as untrusted", async (t) => {
  const { agentDir, cwd, log, registered, trust, prompt, writeProjectServers } = await trustFixture(t);
  await writeProjectServers({ repo: { command: "repo-srv" } });
  trust.set(cwd, true);
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs", "repo"]);

  const warn = t.mock.method(console, "warn", () => {});
  // proper-lockfile's lock is a directory beside the file; a fresh one is never stale.
  const lock = join(agentDir, "trust.json.lock");
  await mkdir(lock);
  t.after(() => rm(lock, { recursive: true, force: true }));
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs"]);
  assert.deepEqual(log, ["register docs", "register repo", "unregister repo"], "the global server is left alone");
  const trustWarnings = warn.mock.calls.filter((call) => String(call.arguments[0]).includes("project trust"));
  assert.equal(trustWarnings.length, 1);
  assert.match(String(trustWarnings[0].arguments[0]), /trust\.json/);
});

test("a project's mcp.json that lands between the trust read and the SDK's read is not read", async (t) => {
  // The folder needs no trust when its trust is read; the file lands before the SDK opens it.
  let land;
  const { host, registered, prompt } = await trustFixture(t, { beforeLoad: (options) => land?.(options) });
  land = ({ cwd }) => {
    land = undefined;
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { repo: { command: "repo-srv" } } }));
  };
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs"]);
  // Reported at once: the names are read after the SDK's read.
  assert.deepEqual(host.serverStates(), [
    { name: "docs", scope: "global", state: "ready" },
    { name: "repo", scope: "project", state: "not-trusted" },
  ]);
});

test("mcp.json errors are logged once each instead of dropped", async (t) => {
  const { registered, prompt } = await trustFixture(t, {
    globalServers: { docs: { url: "https://docs.example/mcp" }, broken: { url: "ftp://docs.example" } },
  });
  const warn = t.mock.method(console, "warn", () => {});
  await prompt();
  await prompt();
  assert.deepEqual([...registered.keys()], ["docs"]);
  const configWarnings = warn.mock.calls.map((call) => String(call.arguments[0])).filter((line) => line.includes("MCP config"));
  assert.equal(configWarnings.length, 1);
  assert.match(configWarnings[0], /mcp\.json: server "broken": url must be an http or https URL/);
});

test("an untrusted project's server names are read only from a regular file inside the project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-host-names-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = (name) => join(root, name);
  const configPath = (name) => join(root, name, ".pi", "mcp.json");
  for (const name of ["plain", "shapeless", "huge", "inside-link", "outside-link", "folder", "fifo"]) {
    await mkdir(join(project(name), ".pi"), { recursive: true });
  }

  await writeFile(configPath("plain"), JSON.stringify({ mcpServers: { a: { command: "x" }, "b c": 1 } }));
  assert.deepEqual(untrustedProjectServerNames(project("plain")), ["a", "b c"], "names only, nothing validated");
  assert.deepEqual(untrustedProjectServerNames(project("missing")), []);

  await writeFile(configPath("shapeless"), JSON.stringify({ mcpServers: ["a"] }));
  assert.deepEqual(untrustedProjectServerNames(project("shapeless")), []);

  await writeFile(configPath("huge"), JSON.stringify({ mcpServers: { a: {} }, pad: "x".repeat(1024 * 1024) }));
  assert.deepEqual(untrustedProjectServerNames(project("huge")), []);

  await mkdir(configPath("folder"));
  assert.deepEqual(untrustedProjectServerNames(project("folder")), []);

  try {
    await writeFile(join(project("inside-link"), "servers.json"), JSON.stringify({ mcpServers: { linked: {} } }));
    await symlink(join(project("inside-link"), "servers.json"), configPath("inside-link"), "file");
    await writeFile(join(root, "elsewhere.json"), JSON.stringify({ mcpServers: { secret: {} } }));
    await symlink(join(root, "elsewhere.json"), configPath("outside-link"), "file");
  } catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }
  assert.deepEqual(untrustedProjectServerNames(project("inside-link")), ["linked"]);
  assert.deepEqual(untrustedProjectServerNames(project("outside-link")), [], "a repository's link never reads a file elsewhere");

  if (process.platform !== "win32") {
    // Opening a FIFO for reading would block until something writes to it.
    execFileSync("mkfifo", [configPath("fifo")]);
    assert.deepEqual(untrustedProjectServerNames(project("fifo")), []);
  }
});
