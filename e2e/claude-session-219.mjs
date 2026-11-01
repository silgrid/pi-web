// carries: lib/claude-*, app/api/claude/*, e2e/claude-stub/*, instrumentation-node.ts, lib/types.ts
// carries: components/ChatWindow*, components/ChatInput*, components/SessionSidebar*, components/AppShell*, hooks/useAgentSession*, app/api/agent/*, app/api/sessions/*, lib/i18n/*
// — pi-web claude code session type: end-to-end acceptance pass.
//
// Authored against artifacts/spec.md's `## Acceptance criteria` and the
// Requirement scenario blocks, BEFORE the implementation exists. Every step
// drives the spec'd behaviour through interfaces that already exist on the
// pre-code tree — `POST /api/agent/new` (the existing create route, extended by
// the spec with a harness choice), `GET /api/sessions`, the sidebar session
// rows, the composer and the chat view — and matches new surfaces only by
// user-visible text/roles. The only new surface assumed is the one the spec
// requires ("New authenticated routes behind the existing password and the
// existing cwd registration guard") plus the create request's harness fields;
// see artifacts/e2e-scenarios.md for the recorded spec under-specifications.
// Pre-implementation this suite therefore fails at assertion level (no claude
// child is spawned, no claude row exists), never at build level: no symbol that
// does not exist today is imported.
//
// The child is a PATH-injected stub (e2e/claude-stub/claude.mjs, a separate
// non-suite file) that speaks the stream-json dialect recorded from the real
// `claude 2.1.312` and writes a real-shaped jsonl transcript, so the resume
// proof is a real process exit (idle expiry, never `PI_WEB_IDLE_TIMEOUT_MS=0`)
// followed by a second launch whose argv carries `--resume <id from the first
// launch>`.
//
// Each scenario is individually guarded: a failing one logs FAIL and sets the
// exit code without stopping the remaining scenarios, so one baseline run lays
// the pre-code bar for every criterion.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = process.env.PI_WEB_DIST_DIR || ".next";
assert.ok(!existsSync(join(root, distDir, "dev/lock")), "Use a checkout without an active dev server");

const artifacts = join(root, "test-results/e2e");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "pi-web-claude-e2e-"));
const agentDir = join(scratch, "agent");
const project = join(scratch, "project");
const stubDir = join(scratch, "bin");
const stubLog = join(scratch, "claude-stub.jsonl");
const claudeDir = join(agentDir, "claude");
mkdirSync(project, { recursive: true });
mkdirSync(stubDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(project, "e2e-probe.txt"), "E2E_TOOL_CONTENT\n");
// The stub is copied (0755) onto the server's PATH as `claude`; the committed
// fixture stays untouched and the scratch tree owns the executable.
copyFileSync(join(root, "e2e/claude-stub/claude.mjs"), join(stubDir, "claude"));
chmodSync(join(stubDir, "claude"), 0o755);

const FIRST = "E2E first message";
const SECOND = "E2E second message";
const THIRD = "E2E third message";
const TITLES = {
  S1: "Create a claude session with an explicit alias and preset",
  S2: "Sidebar shows a claude session with its harness marker",
  S3: "Message round trip renders through the adapter",
  S4: "Reopening a claude session shows its history",
  S5: "Idle expiry then reopen resumes the conversation",
  S6: "First claude session creates a credential-free config dir",
};

let server;
let stopServer = async () => {};
let browser;
let context;
let page;
let base;
let sessionId;
let firstLaunch;

const failures = [];
async function scenario(id, fn) {
  const title = TITLES[id];
  try {
    await fn();
    console.log(`PASS ${id} ${title}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${id}: ${message}`);
    console.log(`FAIL ${id} ${title}: ${message}`);
  }
}

const delayMs = (ms) => delay(ms);
const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

function stubRecords() {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}
const stubLaunches = () => stubRecords().filter((entry) => entry.kind === "launch");

async function waitFor(predicate, timeoutMs, message, stepMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
    } catch {
      last = undefined;
    }
    if (last) return last;
    await delayMs(stepMs);
  }
  assert.ok(false, message);
}

function argvValue(argv, flag) {
  const equals = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (equals) return equals.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function getJson(pathname) {
  const response = await fetch(`${base}${pathname}`, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, `GET ${pathname} -> ${response.status}`);
  return response.json();
}

async function newPage() {
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", baseURL: base });
  // The classic single-chat layout (tab mode's default-on split is a separate
  // surface) and the sidebar's 7-day age filter, which would hide nothing here
  // but is disabled for determinism (the same seed e2e/run.mjs uses).
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("pi-web:split-view-enabled", "false");
      window.localStorage.setItem("pi-web:session-age-filter-days", "0");
    } catch {}
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await context.tracing.start({ screenshots: true, snapshots: true });
}

async function openSession() {
  await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded", timeout: 480_000 });
  await page.locator(".chat-input-textarea").waitFor({ state: "visible", timeout: 180_000 });
}

/**
 * Asserts a reopened turn the way the existing chat view shows it (owner-approved
 * rebaseline, review round 1 finding #4): the final reply is visible, an
 * answered turn folds its process details, so the toggle is clicked open before the
 * intermediate text and the tool row are asserted.
 */
async function assertReopenedTurn(message) {
  await page.getByText(`E2E final reply to ${message}`, { exact: true }).first().waitFor({ timeout: 60_000 });
  const folded = page.locator('button[aria-expanded="false"][aria-label^="Process details"]');
  await waitFor(() => folded.count(), 30_000, "the answered turn shows no process-details toggle", 250);
  for (let i = 0; i < 10 && (await folded.count()); i++) await folded.first().click({ timeout: 5_000 });
  await page.getByText(`E2E streamed reply to ${message}`, { exact: true }).first().waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: /read/i }).first().waitFor({ state: "visible", timeout: 30_000 });
}

const sendButton = () => page.getByRole("button", { name: "Send", exact: true });
const stopButton = () => page.getByRole("button", { name: "Stop agent", exact: true });

async function sendMessage(text) {
  const textarea = page.locator(".chat-input-textarea");
  await textarea.fill(text);
  await sendButton().click();
}

/** True when the session row (found by its title) shows a visible claude marker. */
async function rowHasHarnessMarker() {
  const row = page.locator(`[title="${FIRST}"]`).first();
  await row.waitFor({ state: "attached", timeout: 60_000 });
  return row.evaluate((start) => {
    const marker = /(^|[^a-z])claude([^a-z]|$)/i;
    const labelled = (node) => {
      const values = [node.getAttribute("title"), node.getAttribute("aria-label"), node.getAttribute("alt")]
        .filter(Boolean)
        .join(" ");
      const harness = node.getAttribute("data-harness");
      return marker.test(values) || (harness ?? "").toLowerCase() === "claude";
    };
    if (labelled(start)) return true;
    // The marker may sit on the row itself or beside the title, not on the
    // title node; climb a few levels, stopping once the ancestor already holds
    // another session row (so a neighbour's marker cannot satisfy this one).
    let node = start;
    for (let level = 0; level < 5 && node; level += 1, node = node.parentElement) {
      if ([...node.querySelectorAll("[title],[aria-label],[alt],[data-harness]")].some(labelled)) return true;
      if (marker.test(node.textContent ?? "")) return true;
      if ([...node.children].some((child) => child !== start && child.querySelector?.("a[href*='session=']"))) break;
    }
    return false;
  });
}

const interrupt = () => {
  process.exitCode = 1;
  server?.kill("SIGTERM");
  void browser?.close().catch(() => {});
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

try {
  const { startNextServer } = await import("./next-server.mjs");
  const started = await startNextServer({
    name: "claude-session-219",
    mode: process.env.E2E_SERVER_MODE || "dev",
    logFile: join(artifacts, "claude-session-219-server.log"),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_PASSWORD: "",
      // The scratch tree lives under os.tmpdir(), which the registrable-root
      // guard does not trust by default (pi#55's operator prefix).
      PI_WEB_ALLOWED_ROOT_PREFIXES: scratch,
      // Force a real idle exit during the run; `0` is never used for the
      // resume proof (the spec's lifecycle semantics).
      PI_WEB_IDLE_TIMEOUT_MS: "12000",
      // Only the stub, on PATH. `claude` is resolved from PATH alone.
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      PI_E2E_CLAUDE_STUB_LOG: stubLog,
      // Sentinels the child must never inherit (names only are asserted).
      ANTHROPIC_API_KEY: "e2e-dummy-not-a-credential",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
      CLAUDE_TEST_INHERITED: "e2e-dummy-not-a-credential",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  server = started.server;
  stopServer = started.stop;
  base = started.base;

  const { chromium } = await import("playwright");
  browser = await chromium.launch();

  // S1 — new-behaviour criterion: "New-session surface offers harness pi /
  // claude; claude requires a model alias … and a preset (read-only default);
  // harness, alias and preset are fixed for the session."
  await scenario("S1", async () => {
    const response = await fetch(`${base}/api/agent/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: project,
        type: "prompt",
        message: FIRST,
        harness: "claude",
        modelAlias: "sonnet",
        claudePreset: "read-only",
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.json().catch(() => ({}));
    assert.ok(response.ok, `POST /api/agent/new with harness "claude" failed: ${response.status} ${JSON.stringify(body).slice(0, 400)}`);
    sessionId = body.sessionId ?? body.id;
    assert.ok(typeof sessionId === "string" && sessionId.length > 0, "the create route returned no session id for the claude session");

    firstLaunch = await waitFor(
      () => stubLaunches()[0] ?? false,
      30_000,
      "no claude child process was launched: the PATH stub recorded no launch (harness claude not wired to a child process)",
    );
    assert.equal(argvValue(firstLaunch.argv, "--model"), "sonnet", `the claude child's argv carries no "--model sonnet": ${firstLaunch.argv.join(" ")}`);
    assert.equal(argvValue(firstLaunch.argv, "--permission-mode"), "dontAsk", `the read-only preset's child is not in dontAsk mode: ${firstLaunch.argv.join(" ")}`);
    const joined = firstLaunch.argv.join(" ");
    for (const tool of ["Read", "Glob", "Grep"]) assert.ok(new RegExp(`\\b${tool}\\b`).test(joined), `the read-only tool set does not name ${tool}: ${joined}`);
    for (const tool of ["Bash", "Edit", "Write", "WebSearch", "WebFetch", "Agent"]) {
      assert.ok(!new RegExp(`\\b${tool}\\b`).test(joined), `the read-only tool set must not name ${tool}: ${joined}`);
    }
    // The session id the child reports is the one the index/list must carry.
    if (firstLaunch.sessionId) assert.ok(typeof firstLaunch.sessionId === "string", "the child reported no session id");

    const list = await getJson("/api/sessions?summary=1");
    assert.ok(Array.isArray(list.sessions), "GET /api/sessions returned no session list");
    const listed = list.sessions.some((session) => session.id === sessionId
      || (session.cwd === project && String(session.firstMessage ?? "").includes(FIRST)));
    assert.ok(listed, `the claude session ${sessionId} is not listed by GET /api/sessions (ids: ${list.sessions.map((session) => session.id).join(", ")})`);
  });

  await newPage();

  // S2 — sidebar harness marker (same flow as the resume proof, per the
  // ticket's acceptance).
  await scenario("S2", async () => {
    assert.ok(sessionId, "prerequisite: S1 did not create a claude session");
    await openSession();
    const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
    if (await showSidebar.isVisible().catch(() => false)) await showSidebar.click();
    assert.ok(await rowHasHarnessMarker(), "the claude session's sidebar row shows no visible harness marker");
    await page.screenshot({ path: join(artifacts, "claude-219-sidebar.png") });
  });

  // S3 — message round trip through the adapter: user message, streamed
  // assistant text, tool call/result rows, send unavailable while the turn runs.
  await scenario("S3", async () => {
    assert.ok(sessionId, "prerequisite: S1 did not create a claude session");
    if (!page) await newPage();
    const streamed = `E2E streamed reply to ${SECOND}`;
    await sendMessage(SECOND);
    await stopButton().waitFor({ state: "visible", timeout: 30_000 });
    const sendUsable = await sendButton().isEnabled().catch(() => false);
    assert.ok(!sendUsable, "Send stays usable while a claude turn runs (no queue, no steer)");
    await page.waitForFunction((prefix) => document.body.innerText.includes(prefix), streamed.slice(0, 20), { timeout: 20_000, polling: 50 });
    assert.equal(await stopButton().isVisible(), true, "the reply's partial text arrived only after the turn ended (no token-level streaming)");
    await page.getByText(streamed, { exact: true }).first().waitFor({ timeout: 30_000 });
    // An answered turn folds its process details (as for pi): after the final
    // reply, open them, then the turn's Read row, and assert its tool result
    // (owner-approved rebaseline, answer verify1-s3-rebaseline A).
    await page.getByText(`E2E final reply to ${SECOND}`, { exact: true }).first().waitFor({ timeout: 30_000 });
    await stopButton().waitFor({ state: "hidden", timeout: 30_000 });
    const folded = page.locator('button[aria-expanded="false"][aria-label^="Process details"]');
    await waitFor(() => folded.count(), 30_000, "the answered turn shows no process-details toggle", 250);
    for (let i = 0; i < 10 && (await folded.count()); i++) await folded.first().click({ timeout: 5_000 });
    const toolOutput = `E2E tool output: ${SECOND}`;
    const toolRow = page.getByRole("button", { name: /read/i }).last();
    await toolRow.waitFor({ state: "visible", timeout: 30_000 });
    if (!(await page.getByText(toolOutput, { exact: true }).count())) await toolRow.click({ timeout: 5_000 });
    await waitFor(
      () => page.getByText(toolOutput, { exact: true }).count(),
      30_000,
      "the chat rendered no tool result row for the turn's Read call",
      500,
    );
    await page.getByText(SECOND, { exact: true }).first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(artifacts, "claude-219-round-trip.png") });
  });

  // S4 — reopening renders history from claude's own jsonl transcript, and no
  // parallel pi session file is stored for the claude session.
  await scenario("S4", async () => {
    assert.ok(sessionId, "prerequisite: S1 did not create a claude session");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 180_000 });
    await page.locator(".chat-input-textarea").waitFor({ state: "visible", timeout: 180_000 });
    await page.getByText(FIRST, { exact: true }).first().waitFor({ timeout: 60_000 });
    await assertReopenedTurn(SECOND);
    const transcript = join(claudeDir, "projects");
    assert.ok(existsSync(transcript), "the claude transcript directory was never created under the config dir");
    const copied = existsSync(join(agentDir, "sessions"))
      ? readdirSync(join(agentDir, "sessions"), { recursive: true }).filter((name) => String(name).includes(sessionId))
      : [];
    assert.deepEqual(copied, [], "pi-web stored a parallel pi session copy of the claude session's events");
  });

  // S5 — forced real process exit (idle expiry) then reopen: a new child with
  // `--resume <id from the first launch>`, history rendered, conversation
  // continued. The oracle is the stub's recorded argv plus the browser render.
  await scenario("S5", async () => {
    assert.ok(sessionId, "prerequisite: S1 did not create a claude session");
    assert.ok(stubLaunches().length > 0, "no claude child process was ever launched, so the forced-exit-then-resume flow does not exist");
    assert.ok(firstLaunch, "prerequisite: the first claude launch was not recorded by S1");
    if (page) await page.screenshot({ path: join(artifacts, "claude-219-before-exit.png") });
    await context?.close().catch(() => {});
    context = undefined;
    page = undefined;
    const launched = stubLaunches();
    await waitFor(
      () => launched.every((launch) => !pidAlive(launch.pid)),
      45_000,
      "the claude child processes did not exit after the page stopped renewing the lease (idle expiry)",
    );
    const launchesBefore = stubLaunches().length;
    await newPage();
    await openSession();
    await page.getByText(FIRST, { exact: true }).first().waitFor({ timeout: 60_000 });
    const resumed = await waitFor(
      () => stubLaunches().slice(launchesBefore).find((launch) => launch.resumed || argvValue(launch.argv, "--resume")) ?? false,
      45_000,
      "reopening the session started no child with --resume (a fresh conversation was launched)",
    );
    assert.equal(argvValue(resumed.argv, "--resume"), firstLaunch.sessionId, `the resumed child must carry --resume <id from the first launch>: ${resumed.argv.join(" ")}`);
    await assertReopenedTurn(SECOND);
    await sendMessage(THIRD);
    await page.getByText(`E2E final reply to ${THIRD}`, { exact: true }).first().waitFor({ timeout: 60_000 });
    await page.screenshot({ path: join(artifacts, "claude-219-resumed.png") });
  });

  // S6 — first claude session creates a credential-free config dir, and the
  // child env drops PI_WEB_PASSWORD and every inherited ANTHROPIC_* / CLAUDE_*.
  await scenario("S6", async () => {
    const settingsPath = join(claudeDir, "settings.json");
    assert.ok(existsSync(settingsPath), `the first claude session did not create ${settingsPath}`);
    assert.ok(firstLaunch, "prerequisite: no claude child process was launched, so its environment cannot be checked");
    const settings = readFileSync(settingsPath, "utf8");
    const parsed = JSON.parse(settings);
    assert.ok(!/key|token|secret|password|credential/i.test(JSON.stringify(parsed)), "the default settings.json carries credential-looking keys or values");
    assert.equal(argvValue(firstLaunch.argv, "--model"), "sonnet", "prerequisite: the recorded first launch is not the claude session's child");
    assert.equal(resolve(String(firstLaunch.configDir)), resolve(claudeDir), `CLAUDE_CONFIG_DIR must point at <pi agent dir>/claude, got ${String(firstLaunch.configDir)}`);
    assert.ok(firstLaunch.envKeys.includes("CLAUDE_CONFIG_DIR"), "the child environment has no CLAUDE_CONFIG_DIR");
    assert.ok(!firstLaunch.envKeys.includes("PI_WEB_PASSWORD"), "the child environment inherited PI_WEB_PASSWORD");
    assert.ok(!firstLaunch.envKeys.includes("ANTHROPIC_API_KEY"), "the child environment inherited ANTHROPIC_API_KEY");
    assert.ok(!firstLaunch.envKeys.includes("ANTHROPIC_BASE_URL"), "the child environment inherited ANTHROPIC_BASE_URL");
    assert.ok(!firstLaunch.envKeys.includes("CLAUDE_TEST_INHERITED"), "the child environment inherited a CLAUDE_* variable");
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  failures.push(`setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (page) await page.screenshot({ path: join(artifacts, "failure.png") }).catch(() => {});
  if (context) await context.tracing.stop({ path: join(artifacts, "claude-219-trace.zip") }).catch(() => {});
  await browser?.close().catch(() => {});
  await stopServer();
  rmSync(scratch, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}

if (failures.length) {
  console.log(`FAIL claude-session-219: ${failures.length} scenario(s) failed`);
  process.exitCode = 1;
}