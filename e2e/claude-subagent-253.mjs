// carries: lib/claude-adapter.ts, lib/claude-config-dir.ts, lib/claude-session.ts, lib/claude-subagent-view.ts, lib/message-display.ts
// carries: app/api/agent/*, app/api/sessions/*, hooks/useAgentSession.ts
// carries: components/ChatWindow*, components/MessageView*, components/ClaudeSubagentRow*, lib/i18n/messages/*
// — first-class claude subagent rendering. Authored against
// artifacts/spec.md and artifacts/plan.md before `code`: the contract scenarios
// read the real 2.1.312 recording under lib/__fixtures__/claude-2.1.312/subagent/,
// and the browser scenarios drive the existing claude session surfaces with a
// PATH-injected stub that replays it (e2e/claude-stub/claude-subagent.mjs). No
// symbol that does not exist on the pre-code tree is imported; pre-implementation
// the suite fails at assertion level. The fold-exception state (parent turn folded
// while the subagent runs) is document-only: the real stdin recording emits the
// parent's result after the subagent finishes (see artifacts/e2e-scenarios.md).
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = process.env.PI_WEB_DIST_DIR || ".next";
assert.ok(!existsSync(join(root, distDir, "dev/lock")), "Use a checkout without an active dev server");
const fixtureDir = join(root, "lib/__fixtures__/claude-2.1.312/subagent");
const fixture = (name) => readFileSync(join(fixtureDir, name), "utf8");
const fixtureLines = (name) => fixture(name).split("\n").filter(Boolean);
const jiti = createJiti(import.meta.url, { alias: { "@": root }, interopDefault: true });
const adapter = await jiti.import(join(root, "lib/claude-adapter.ts"));
const parse = (name) => adapter.parseClaudeTranscript(fixture(name));

const AGENT_TOOL_ID = "toolu_01F1YZd2Gseivs4hckhQVw5s";
const READ_TOOL_ID = "toolu_012N7brUKegpGiA36sdi1ApH";
const AGENT_ID = "a9fb2ff3aa8e8ff40";
// The sidecar's own entries (the prompt entry c281353e is the row's prompt, not a timeline entry).
const SIDECAR_ENTRY_IDS = [
  "989c7aa3-823f-4e39-b826-7a4fa64b76cc",
  "9e9ed764-c94f-4c81-9581-cf1ff958eb80",
  "95f1af84-d81a-4ab5-adfd-e41b2d9a338b",
];
const TOKEN = "SUBAGENT_PROBE_TOKEN_253";
const AGENT_DESCRIPTION = "Read note.txt first line";
const SUBAGENT_PROMPT = "Read the file note.txt in the current directory";
const MAIN_USER_TEXT = "Use the Agent tool exactly once to launch a general-purpose subagent";
const PROMPT = JSON.parse(fixtureLines("transcript.jsonl")[0]).message.content;
// The history path reads the sidecar beside the transcript, keyed by claude's agent id
// (owner ruling s14#2/#3): the main transcript alone cannot carry the sidecar's entries.
const sidecars = () => ({
  [AGENT_ID]: {
    entries: parse(`subagents/agent-${AGENT_ID}.jsonl`),
    meta: JSON.parse(fixture(`subagents/agent-${AGENT_ID}.meta.json`)),
  },
});
const historyOf = () => adapter.claudeTranscriptToMessages(parse("transcript.jsonl"), sidecars());

const TITLES = {
  C1: "The live stream attaches the subagent's Read, result and text to the Agent run, never to the main conversation",
  C2: "History rebuilds the same subagent entries from the sidecar and keeps them out of the main message list",
  C3: "Live and history produce the same subagent entries without duplicates",
  C4: "The task notification is a hidden turn anchor in history, not a user message",
  S1: "The Agent row header shows the type badge, description and live status",
  S2: "Expanding the Agent row while the subagent runs shows the prompt, its Read row and result; collapsing mounts nothing",
  S3: "The row expands by default while running, and a manual toggle wins over later state changes",
  S4: "The async launch receipt is not completion; task events set the final status and statistics",
  S5: "Progress updates change only the row header, adding no timeline line",
  S6: "Expanding or collapsing the Agent row leaves the main conversation and composer unchanged",
  S7: "The lease reports an unsettled subagent run while it runs",
  S8: "Reloading after completion shows the same entries once from the sidecar, with the follow-up reply as its own turn",
  S3b: "A manual expansion survives the settled state change",
  S4b: "Task events set the settled status and statistics after the follow-up turn",
  S7b: "The lease stops reporting an unsettled run after the last follow-up turn",
};
const failures = [];
async function scenario(id, fn) {
  try {
    await fn();
    console.log(`PASS ${id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${id}: ${message}`);
    console.log(`FAIL ${id} (${TITLES[id]}): ${message}`);
  }
}

function translated(recorded) {
  const translator = new adapter.ClaudeStreamTranslator(() => 1000);
  const events = [];
  for (const event of recorded) events.push(...translator.push(event).events);
  return events;
}
const has = (value, needle) => JSON.stringify(value ?? null).includes(needle);
const toolIds = (value) => [...new Set(String(JSON.stringify(value ?? null)).match(/toolu_[A-Za-z0-9]+/g) ?? [])].sort();
const entryIds = (entries) => entries.map((entry) => entry?.id).filter((id) => typeof id === "string" && id);
const uniqueSorted = (list) => [...new Set(list)].sort();
const noDuplicateIds = (ids, what) => assert.equal(new Set(ids).size, ids.length, `${what} contains a duplicate id: ${ids.join(", ")}`);
const isSubagentEvent = (event) => String(event?.type) === "claude_subagent";

await scenario("C1", async () => {
  const events = translated(parse("stream.jsonl"));
  const subagentEvents = events.filter(isSubagentEvent);
  assert.ok(subagentEvents.length > 0, `no claude_subagent event is emitted (types: ${[...new Set(events.map((event) => event.type))].join(", ")})`);
  // The subagent's own ids, not the probe token: claude's follow-up reply legitimately quotes the token (owner ruling s14#1).
  const ownIds = [READ_TOOL_ID, ...SIDECAR_ENTRY_IDS];
  const carriers = events.filter((event) => ownIds.some((id) => has(event, id)));
  assert.ok(carriers.length > 0, "no stream event carries the subagent's own Read id or entry ids");
  for (const event of carriers) assert.ok(isSubagentEvent(event), `the subagent's own id leaked into a ${event.type} event`);
  assert.ok(has(subagentEvents, READ_TOOL_ID), "the subagent event carries no Read id");
  assert.ok(has(subagentEvents, TOKEN), "the subagent event carries no subagent text");
  const main = events.filter((event) => /^(message_|tool_execution_|agent_end$)/.test(String(event.type)));
  assert.ok(ownIds.every((id) => !has(main, id)), "a subagent entry id or tool id appears in a main-conversation event");
  assert.ok(has(subagentEvents, AGENT_TOOL_ID), "the subagent event is not linked to the Agent tool call");
});

await scenario("C2", async () => {
  const history = historyOf();
  assert.ok(Array.isArray(history.subagents) && history.subagents.length === 1, `history exposes ${history.subagents === undefined ? "no" : history.subagents.length} subagent runs`);
  for (const needle of [AGENT_TOOL_ID, READ_TOOL_ID, TOKEN, AGENT_DESCRIPTION]) {
    assert.ok(has(history.subagents, needle), `the history subagent run does not carry ${needle}`);
  }
  assert.ok(has(history.messages, AGENT_TOOL_ID), "the Agent tool call is missing from the main message list");
  // The main list keeps none of the subagent's own ids; the token may appear in the follow-up reply (s14#2).
  assert.ok(!has(history.messages, READ_TOOL_ID), "the subagent's Read id still appears in the main message list");
  for (const id of SIDECAR_ENTRY_IDS) assert.ok(!has(history.messages, id), `the sidecar entry ${id} appears in the main message list`);
});

await scenario("C3", async () => {
  const liveEntries = translated(parse("stream.jsonl"))
    .filter(isSubagentEvent)
    .flatMap((event) => (Array.isArray(event.run?.entries) ? event.run.entries : []));
  const liveIds = entryIds(liveEntries);
  noDuplicateIds(liveIds, "the live subagent entries");
  const history = historyOf();
  const historyRuns = Array.isArray(history.subagents) ? history.subagents : [];
  const historyEntries = historyRuns.flatMap((run) => (Array.isArray(run.entries) ? run.entries : []));
  const historyIds = entryIds(historyEntries);
  noDuplicateIds(historyIds, "the history subagent entries");
  assert.ok(historyIds.length > 0, "history carries no subagent entry ids");
  assert.deepEqual(uniqueSorted(liveIds), uniqueSorted(historyIds), `live subagent entries ${uniqueSorted(liveIds).join(",")} differ from history ${uniqueSorted(historyIds).join(",")}`);
  // Compare ids, not JSON substrings: the Read result, the text entry and the notification each carry the token.
  const liveTools = toolIds(liveEntries).filter((id) => id !== AGENT_TOOL_ID);
  const historyTools = toolIds(historyEntries).filter((id) => id !== AGENT_TOOL_ID);
  assert.deepEqual(liveTools, historyTools, `live subagent tool ids ${liveTools.join(",")} differ from history ${historyTools.join(",")}`);
  assert.ok(liveTools.includes(READ_TOOL_ID), "the subagent's Read tool id is missing from the live and history entries");
});

await scenario("C4", async () => {
  const history = adapter.claudeTranscriptToMessages(parse("transcript.jsonl"));
  const notificationUsers = history.messages.filter((message) => message.role === "user" && has(message, "<task-notification>"));
  assert.equal(notificationUsers.length, 0, "the task notification is rendered as a user message");
  const anchors = history.messages.filter((message) => message.role !== "user" && has(message, "task-notification"));
  assert.ok(anchors.length >= 1, "no hidden turn anchor carries the task notification");
  assert.ok(has(history.messages, "The subagent finished and reported"), "the follow-up reply is missing from history");
});

const artifacts = join(root, "test-results/e2e");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "pi-web-claude-subagent-e2e-"));
const agentDir = join(scratch, "agent");
const project = join(scratch, "project");
const stubDir = join(scratch, "bin");
const stubLog = join(scratch, "claude-stub.jsonl");
const claudeDir = join(agentDir, "claude");
mkdirSync(project, { recursive: true });
mkdirSync(agentDir, { recursive: true });
mkdirSync(stubDir, { recursive: true });
mkdirSync(claudeDir, { recursive: true });
writeFileSync(join(project, "note.txt"), `${TOKEN}\nsecond line of the note\n`);
copyFileSync(join(root, "e2e/claude-stub/claude-subagent.mjs"), join(stubDir, "claude"));
chmodSync(join(stubDir, "claude"), 0o755);

let stopServer = async () => {};
let browser;
let page;
let base;
let sessionId;
let leaseWhileRunning;

const stubLaunches = () => (existsSync(stubLog) ? readFileSync(stubLog, "utf8").split("\n").filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
}).filter((entry) => entry.kind === "launch") : []);

async function waitFor(predicate, timeoutMs, message, stepMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); } catch { last = undefined; }
    if (last) return last;
    await delay(stepMs);
  }
  assert.ok(false, message);
}
async function getJson(pathname, init) {
  const response = await fetch(`${base}${pathname}`, { ...init, signal: AbortSignal.timeout(60_000) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
async function openSession() {
  await page.goto(`${base}/?session=${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded", timeout: 480_000 });
  await page.locator(".chat-input-textarea").waitFor({ state: "visible", timeout: 180_000 });
}
const agentText = () => page.getByText(AGENT_DESCRIPTION, { exact: true }).first();
// The Agent row's own container (components/ClaudeSubagentRow.tsx): the token/progress
// counts stay inside it, so the follow-up reply's inline token cannot inflate them.
const agentRow = () => page.locator(`[data-claude-subagent="${AGENT_TOOL_ID}"]`).first();
async function agentButton() {
  await agentText().waitFor({ state: "visible", timeout: 30_000 });
  const button = agentText().locator("xpath=ancestor::button[1]");
  if (await button.count()) return button;
  return agentText().locator("xpath=ancestor::*[@role='button'][1]");
}
async function headerText() {
  return (await (await agentButton()).textContent()) ?? "";
}
async function toggleRow() {
  await (await agentButton()).click({ timeout: 10_000 });
  await delay(150);
}
async function expandProcessDetails() {
  const folded = page.locator('button[aria-expanded="false"][aria-label^="Process details"]');
  for (let i = 0; i < 20; i += 1) {
    if (!(await folded.count())) break;
    await folded.first().click({ timeout: 5_000 }).catch(() => {});
    await delay(120);
  }
}
const tokenCount = () => agentRow().getByText(TOKEN, { exact: true }).count();
const pageTokenCount = () => page.getByText(TOKEN, { exact: true }).count();
const promptVisible = () => agentRow().getByText(SUBAGENT_PROMPT, { exact: false }).count();
const progressCount = () => agentRow().getByText("Reading note.txt", { exact: true }).count();
async function waitFollowUp() {
  await page.getByText("The subagent finished and reported", { exact: false }).first().waitFor({ timeout: 70_000 });
}
async function waitStats() {
  await waitFor(async () => /1\s*tools?|completed|finished/i.test(await headerText()), 20_000, "the finished row shows no status or tool statistics");
}
function leasePath() {
  return `/api/agent/${encodeURIComponent(sessionId)}/lease?holder=e2e-lease`;
}

try {
  const { startNextServer } = await import("./next-server.mjs");
  const started = await startNextServer({
    name: "claude-subagent-253",
    mode: process.env.E2E_SERVER_MODE || "dev",
    logFile: join(artifacts, "claude-subagent-253-server.log"),
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      CLAUDE_CONFIG_DIR: claudeDir,
      PI_WEB_PASSWORD: "",
      PI_WEB_ALLOWED_ROOT_PREFIXES: scratch,
      PATH: `${stubDir}:${process.env.PATH ?? ""}`,
      PI_E2E_CLAUDE_STUB_LOG: stubLog,
      PI_E2E_CLAUDE_FIXTURE_DIR: fixtureDir,
      PI_E2E_SUBAGENT_HOLD_MS: "30000",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  stopServer = started.stop;
  base = started.base;
  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", baseURL: base });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("pi-web:split-view-enabled", "false");
      window.localStorage.setItem("pi-web:session-age-filter-days", "0");
    } catch {}
  });
  page = await context.newPage();
  page.setDefaultTimeout(30_000);

  // The session is created without a prompt (the recording's prompt is sent from
  // the composer) so the page can attach its stream before the subagent starts.
  const created = await getJson("/api/agent/new", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: project, type: "ensure_session", harness: "claude", modelAlias: "haiku", model: "claude-haiku-5-5", claudePreset: "read-only" }),
  });
  assert.ok(created.status === 200, `POST /api/agent/new failed: ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  sessionId = created.body.sessionId;
  assert.ok(typeof sessionId === "string" && sessionId.length > 0, "the create route returned no session id");
  const launch = await waitFor(() => stubLaunches()[0], 30_000, "no claude child was launched");
  assert.equal(launch.sessionId, sessionId, "the child's session id differs from the session id pi-web returned");
  await openSession();
  await page.locator(".chat-input-textarea").fill(PROMPT);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await waitFor(async () => (await agentText().count()) > 0, 30_000, "the chat rendered no Agent row");
  await waitFor(async () => (await pageTokenCount()) >= 1, 20_000, "the subagent's text entry never arrived on the stream");

  await scenario("S1", async () => {
    const header = await headerText();
    assert.match(header, /general-purpose/i, `the header carries no subagent type badge: ${header}`);
    assert.match(header, /Read note\.txt first line/i, `the header carries no description: ${header}`);
    assert.match(header, /running/i, `the header carries no live status: ${header}`);
  });

  await scenario("S2", async () => {
    assert.equal(await tokenCount(), 1, "the running row is not expanded by default");
    await toggleRow();
    assert.equal(await tokenCount(), 0, "collapsing the row kept the subagent timeline mounted");
    assert.equal(await promptVisible(), 0, "collapsing the row kept the subagent prompt mounted");
    await toggleRow();
    await waitFor(async () => (await tokenCount()) === 1, 5_000, "expanding the row did not reveal the subagent text");
    assert.equal(await promptVisible(), 1, "the expanded body shows no subagent prompt");
    await page.getByRole("button", { name: /read/i }).first().waitFor({ state: "visible", timeout: 10_000 });
  });

  // Running-state facts come first, inside the stub's 30 s hold window (owner ruling s14#5).
  await scenario("S4", async () => {
    const header = await headerText();
    assert.match(header, /running/i, "the async launch receipt already ended the run");
    assert.doesNotMatch(header, /completed|finished|done/i, "the async launch receipt was treated as completion");
  });

  await scenario("S5", async () => {
    await waitFor(async () => /Reading note\.txt/i.test(await headerText()), 15_000, "the progress description never reached the header");
    assert.equal(await progressCount(), 1, "the progress description appears outside the Agent row header");
    assert.equal(await tokenCount(), 1, "a progress update replaced the already-rendered subagent entry");
    await page.getByRole("button", { name: /read/i }).first().waitFor({ state: "visible", timeout: 10_000 });
  });

  await scenario("S7", async () => {
    const running = await getJson(leasePath(), { method: "POST" });
    assert.equal(running.status, 200, `lease failed: ${running.status}`);
    assert.equal(running.body.subagentsActive, true, "the lease does not report the running subagent run");
    leaseWhileRunning = running.body;
  });

  await scenario("S6", async () => {
    const textarea = page.locator(".chat-input-textarea");
    await textarea.fill("draft survives the toggle");
    await textarea.focus();
    const mainUserCount = await page.getByText(MAIN_USER_TEXT, { exact: false }).count();
    const lastReplyCount = await page.getByText("The agent was launched.", { exact: true }).count();
    assert.equal(await tokenCount(), 1, "the row is not expanded before the toggle");
    await toggleRow();
    await toggleRow();
    assert.equal(await tokenCount(), 1, "the row did not reopen after toggling");
    assert.equal(await promptVisible(), 1, "the row shows no subagent prompt after toggling");
    assert.equal(await page.getByText(MAIN_USER_TEXT, { exact: false }).count(), mainUserCount, "toggling changed the main conversation");
    assert.equal(await page.getByText("The agent was launched.", { exact: true }).count(), lastReplyCount, "toggling changed the last reply");
    assert.equal(await textarea.inputValue(), "draft survives the toggle", "toggling changed the composer draft");
    assert.equal(await textarea.evaluate((element) => document.activeElement === element), true, "toggling took focus away from the composer");
  });

  await scenario("S3", async () => {
    assert.equal(await tokenCount(), 1, "the running row is not expanded by default");
    await toggleRow();
    assert.equal(await tokenCount(), 0, "the manual collapse did not close the row");
    await waitFor(async () => /Reading note\.txt/i.test(await headerText()), 15_000, "the header never showed the progress description");
    assert.equal(await tokenCount(), 0, "a later progress update reopened the manually collapsed row");
    await toggleRow();
    assert.equal(await tokenCount(), 1, "the manual expand did not open the row");
  });

  // Every running-state assertion has now run inside the hold window: wait for claude's follow-up turn.
  await waitFollowUp();
  await expandProcessDetails();

  await scenario("S3b", async () => {
    assert.equal(await tokenCount(), 1, "the finished row discarded the user's manual expansion");
  });

  await scenario("S4b", async () => {
    await waitStats();
    const header = await headerText();
    assert.doesNotMatch(header, /running/i, `the settled header still reports running: ${header}`);
    assert.match(header, /1\s*tools?/i, `the finished header shows no tool count: ${header}`);
    assert.match(header, /10[,.]?379|10\.4k/i, `the finished header shows no recorded token count: ${header}`);
  });

  await scenario("S7b", async () => {
    assert.equal(leaseWhileRunning?.subagentsActive, true, "the lease never reported the run while it was running, so the settled check would be vacuous");
    const settled = await getJson(leasePath(), { method: "POST" });
    assert.equal(typeof settled.body.subagentsActive, "boolean", "the lease reply carries no subagentsActive field");
    await waitFor(async () => {
      const idle = await getJson(leasePath(), { method: "POST" });
      return idle.body.subagentsActive === false;
    }, 30_000, "the lease still reports an unsettled run after the last follow-up turn");
  });

  await scenario("S8", async () => {
    const live = { token: await tokenCount(), prompt: await promptVisible() };
    assert.deepEqual(live, { token: 1, prompt: 1 }, "the live row did not show exactly one prompt and one text entry");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 480_000 });
    await page.locator(".chat-input-textarea").waitFor({ state: "visible", timeout: 180_000 });
    assert.equal(await page.getByText("<task-notification>", { exact: false }).count(), 0, "the task notification rendered as a user message");
    await page.getByText("The subagent finished and reported", { exact: false }).first().waitFor({ timeout: 30_000 });
    await expandProcessDetails();
    if ((await tokenCount()) === 0) await toggleRow();
    assert.equal(await tokenCount(), 1, "the history row shows the subagent text zero times or more than once");
    assert.equal(await promptVisible(), 1, "the history body shows no subagent prompt");
    await page.getByRole("button", { name: /read/i }).first().waitFor({ state: "visible", timeout: 10_000 });
  });
} catch (error) {
  console.error(error);
  failures.push(`setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (page) await page.screenshot({ path: join(artifacts, "claude-subagent-253.png") }).catch(() => {});
  await browser?.close().catch(() => {});
  await stopServer();
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length) {
  console.log(`FAIL claude-subagent-253: ${failures.length} scenario(s) failed`);
  process.exitCode = 1;
}
