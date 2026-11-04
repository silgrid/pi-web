// carries: lib/claude-*, lib/types.ts, lib/i18n/*, e2e/claude-stub/*
// carries: app/api/claude/*, app/api/agent/*, app/api/sessions/*, hooks/useAgentSession*
// carries: components/ChatInput*, components/ChatWindow*, components/SessionSidebar*
// carries: components/HarnessSelector*, components/SettingsPanel*
// — claude sessions phase two: end-to-end acceptance pass.
//
// Authored against artifacts/spec.md's `## Acceptance criteria` and the
// Requirement `#### Scenario` blocks, BEFORE the implementation exists, so the
// assertions describe the spec's intent and never an imagined implementation.
// Every step drives surface that already exists pre-code: `POST
// /api/agent/new` (extended by the spec with `{ harness: "claude", model }`),
// `GET /api/claude`, `GET /api/sessions`, `GET /api/sessions/[id]`, `DELETE
// /api/sessions/[id]`, the fresh composer, Settings › General, and the stub
// child's recorded argv/environment. The new surfaces are matched only by the
// user-visible facts the spec names (the harness selector beside the model
// selector, the four full model names, the three hint wordings, the full model
// name in the read-only line); no symbol that does not exist today is imported,
// so a pre-code run fails at assertion level, never at build level. The suite
// runs on an isolated HOME, PI_CODING_AGENT_DIR and CLAUDE_CONFIG_DIR: the
// operator's real `~/.claude` is never written.
//
// Each scenario is individually guarded: a failing one logs FAIL and sets the
// exit code without stopping the rest, and every kept scenario prints one
// `PASS S250-nn` marker line on success.
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ACTION_MS, COLD_MS, NAV_MS } from "./timeouts.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = process.env.PI_WEB_DIST_DIR || ".next";
assert.ok(!existsSync(join(root, distDir, "dev/lock")), "Use a checkout without an active dev server");

const artifacts = join(root, "test-results/e2e");
mkdirSync(artifacts, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "pi-web-claude-250-"));
const home = join(scratch, "home");
const agentDir = join(home, ".pi", "agent");
const project = join(scratch, "project");
const stubDir = join(scratch, "bin");
const stubLog = join(scratch, "claude-stub.jsonl");
// The inherited config dir the spec's transcript lookup follows when pi-web has one.
const configDir = join(scratch, "claude-config");
for (const dir of [home, agentDir, project, stubDir, configDir]) mkdirSync(dir, { recursive: true });
copyFileSync(join(root, "e2e/claude-stub/claude.mjs"), join(stubDir, "claude"));
chmodSync(join(stubDir, "claude"), 0o755);

// The contract the spec fixes, authored from the spec alone (never imported from lib/).
const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
const PASSWORD_VARS = ["PI_WEB_PASSWORD", "CLAUDECODE"];
const INHERITED_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_TEST_INHERITED"];
const FORBIDDEN_CLAUDECODE_FLAGS = [
  "--bare", "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "--tools", "--allowedTools", "--cwd",
];
const RETIRED_TEXT = [
  "claude config dir:",
  "Credentials belong in this directory's settings.json env",
  "Read-only: only the Read tool",
  "Writable: edits are accepted automatically",
];
const HINTS = {
  en: "Uses the system claude; if something goes wrong, adjust claude from the pi-web terminal.",
  "zh-CN": "使用系统 claude；如有问题，请在 pi-web 终端手动调整 claude",
  "zh-TW": "使用系統 claude；如有問題，請在 pi-web 終端手動調整 claude",
};

let server;
let stopServer = async () => {};
let browser;
let context;
let page;
let base;
let firstLoad = true;
const sessionIds = {};
let firstLaunch;
const failures = [];

async function scenario(id, fn) {
  try {
    await fn();
    console.log(`PASS ${id}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${id}: ${message}`);
    console.log(`FAIL ${id}: ${message}`);
  }
}

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
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch {
      // not ready yet
    }
    await delay(stepMs);
  }
  assert.ok(false, message);
}

function flagValue(argv, flag) {
  const equals = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (equals) return equals.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
const flagCount = (argv, flag) => argv.filter((arg) => arg === flag || arg.startsWith(`${flag}=`)).length;

async function apiFetch(pathname, init = {}) {
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(init.timeout ?? 60_000),
  });
}
async function getJson(pathname) {
  const response = await apiFetch(pathname);
  assert.equal(response.status, 200, `GET ${pathname} -> ${response.status}`);
  return response.json();
}
async function postJson(pathname, body) {
  const response = await apiFetch(pathname, { method: "POST", body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
async function createClaudeSession({ message, model, extra = {} }) {
  const created = await postJson("/api/agent/new", {
    cwd: project, type: "prompt", message, harness: "claude", model, ...extra,
  });
  assert.equal(created.status, 200, `POST /api/agent/new (harness claude, model ${model}) -> ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
  const id = created.body.sessionId ?? created.body.id;
  assert.ok(typeof id === "string" && id.length > 0, "the create route returned no claude session id");
  return id;
}

function findTranscript(id) {
  let dirs = [];
  try {
    dirs = readdirSync(join(configDir, "projects"));
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(configDir, "projects", dir, `${id}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

const indexPath = () => join(agentDir, "claude-sessions.json");
function readIndex() {
  try {
    return JSON.parse(readFileSync(indexPath(), "utf8"));
  } catch {
    return { version: 1, sessions: [] };
  }
}
function appendIndex(records) {
  const index = readIndex();
  index.sessions = [...(index.sessions ?? []), ...records];
  writeFileSync(indexPath(), `${JSON.stringify(index, null, 2)}\n`);
}
const seedRecord = (id, extra) => ({
  id,
  cwd: project,
  created: new Date(0).toISOString(),
  modified: new Date(0).toISOString(),
  firstMessage: id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
  ...extra,
});
const userLine = (id, text) => ({
  type: "user",
  message: { role: "user", content: text },
  uuid: `${id}-uuid`,
  sessionId: id,
  cwd: project,
  version: "2.1.312",
  timestamp: new Date().toISOString(),
});

const bottomBar = () => page.locator(".chat-input-controls");
const composer = () => page.locator(".chat-input-controls").locator("xpath=..");
const modelTrigger = () => page.locator(".chat-input-controls .model-selector > button");
const triggerText = async () => (await modelTrigger().innerText()).trim();

async function closeMenu() {
  await page.keyboard.press("Escape").catch(() => {});
  await page.locator('[role="listbox"]').last().waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
}

async function modelMenu() {
  await modelTrigger().click({ timeout: ACTION_MS });
  const listbox = page.locator('[role="listbox"]').last();
  await listbox.waitFor({ state: "visible", timeout: 10_000 });
  const texts = (await listbox.locator('[role="option"]').allInnerTexts()).map((text) => text.trim()).filter(Boolean);
  return { listbox, texts };
}

async function clickOption(listbox, name) {
  const options = listbox.locator('[role="option"]');
  const rows = [];
  for (let i = 0, n = await options.count(); i < n; i += 1) {
    const option = options.nth(i);
    const label = (await option.innerText()).trim();
    rows.push(label);
    if (label.toLowerCase() === name.toLowerCase()) {
      await option.click({ timeout: ACTION_MS });
      return;
    }
  }
  assert.ok(false, `no "${name}" row in the selector (rows: ${rows.join(", ")})`);
}

async function tryHarnessTrigger(trigger) {
  try {
    await trigger.click({ timeout: 5_000 });
    const listbox = page.locator('[role="listbox"]').last();
    await listbox.waitFor({ state: "visible", timeout: 5_000 });
    const texts = (await listbox.locator('[role="option"]').allInnerTexts()).map((text) => text.trim().toLowerCase());
    if (texts.includes("pi") && texts.includes("claude")) return { trigger, listbox };
  } catch {
    // not a selector menu
  }
  await closeMenu();
  return null;
}

/** The harness selector: a bottom-bar popover (not the model selector) whose rows are pi and claude. */
async function harnessControl() {
  const bar = bottomBar();
  const candidates = bar.locator('button[aria-haspopup="listbox"]');
  for (let i = 0, n = await candidates.count(); i < n; i += 1) {
    const candidate = candidates.nth(i);
    if (await candidate.evaluate((element) => Boolean(element.closest(".model-selector")))) continue;
    const found = await tryHarnessTrigger(candidate);
    if (found) return found;
  }
  // Fallback for a toolbar button that shows the current harness as its value.
  const byValue = bar.locator("button").filter({ hasText: /^(pi|claude)$/i }).first();
  if ((await byValue.count()) > 0) return tryHarnessTrigger(byValue);
  return null;
}

async function chooseHarness(name) {
  const control = await harnessControl();
  assert.ok(control, "the composer's bottom bar offers no harness selector (no control beside the model selector lists pi and claude)");
  await clickOption(control.listbox, name);
  await page.locator('[role="listbox"]').last().waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
}

async function assertSideBySide(harnessTrigger) {
  const barBox = await bottomBar().boundingBox();
  const harnessBox = await harnessTrigger.boundingBox();
  const modelBox = await modelTrigger().boundingBox();
  assert.ok(barBox && harnessBox && modelBox, "the harness/model controls have no layout box");
  const inside = (box) => box.y + box.height > barBox.y - 2
    && box.y < barBox.y + barBox.height + 2
    && box.x + box.width > barBox.x - 2
    && box.x < barBox.x + barBox.width + 2;
  assert.ok(inside(harnessBox), "the harness selector is not inside the composer's bottom bar");
  assert.ok(inside(modelBox), "the model selector is not inside the composer's bottom bar");
  const center = (box) => box.y + box.height / 2;
  assert.ok(Math.abs(center(harnessBox) - center(modelBox)) <= 16, "the harness and model selectors are not side by side on one row");
}

async function openFreshComposer(locale = "en") {
  await page.goto(`${base}/?cwd=${encodeURIComponent(project)}`, { waitUntil: "domcontentloaded", timeout: firstLoad ? COLD_MS : NAV_MS });
  firstLoad = false;
  await page.locator(".chat-input-textarea").waitFor({ state: "visible", timeout: NAV_MS });
  if (await page.evaluate(() => localStorage.getItem("pi-locale")) !== locale) {
    await page.evaluate((value) => localStorage.setItem("pi-locale", value), locale);
    await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_MS });
    await page.locator(".chat-input-textarea").waitFor({ state: "visible", timeout: NAV_MS });
  }
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
  const env = {
    ...process.env,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    // The repo's e2e convention (#219): the web password gate is off so the
    // shared server helper's unauthenticated readiness probe can answer. The
    // name stays in pi-web's environment (empty) and must still be withheld.
    PI_WEB_PASSWORD: "",
    CLAUDECODE: "1",
    ANTHROPIC_API_KEY: "e2e-dummy-not-a-credential",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
    CLAUDE_TEST_INHERITED: "e2e-dummy-not-a-credential",
    CLAUDE_CONFIG_DIR: configDir,
    PI_WEB_ALLOWED_ROOT_PREFIXES: scratch,
    // A real idle exit for the resume proof; 0 is never used.
    PI_WEB_IDLE_TIMEOUT_MS: "5000",
    PATH: `${stubDir}:${process.env.PATH ?? ""}`,
    PI_E2E_CLAUDE_STUB_LOG: stubLog,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const started = await startNextServer({
    name: "claude-250",
    mode: process.env.E2E_SERVER_MODE || "dev",
    logFile: join(artifacts, "claude-250-server.log"),
    env,
  });
  server = started.server;
  stopServer = started.stop;
  base = started.base;

  const { chromium } = await import("playwright");
  browser = await chromium.launch();
  context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
    baseURL: base,
  });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("pi-web:split-view-enabled", "false");
      window.localStorage.setItem("pi-web:session-age-filter-days", "0");
    } catch {}
  });
  // A synthetic pi catalog: the pi side of the linked selector needs options, and
  // none of these names can collide with the claude full names.
  const models = [
    { provider: "e2e", id: "model-0", name: "Model 0" },
    { provider: "e2e", id: "model-1", name: "Model 1" },
  ];
  await context.route(/\/api\/models(?:\?|$)/, (route) => route.fulfill({
    json: {
      models: Object.fromEntries(models.map((model) => [`${model.provider}/${model.id}`, model.name])),
      modelList: models,
      defaultModel: { provider: "e2e", modelId: "model-0" },
      defaultThinkingLevel: "medium",
      savedDefaultThinkingLevel: null,
      thinkingLevels: {},
      thinkingLevelMaps: {},
      thinkingLevelPins: {},
    },
  }));
  page = await context.newPage();
  page.setDefaultTimeout(ACTION_MS);
  await context.tracing.start({ screenshots: true, snapshots: true });

  // S250-01 — acceptance: harness selector and model selector side by side in
  // the bottom bar, harness selector styled like the model selector (same
  // popover row family), no tool-preset selector.
  await scenario("S250-01", async () => {
    await openFreshComposer();
    const control = await harnessControl();
    assert.ok(control, "the harness selector is not in the composer's bottom bar beside the model selector");
    await closeMenu();
    await assertSideBySide(control.trigger);
    assert.equal(await composer().locator("select").count(), 0, "the composer still renders <select> controls (the retired harness/alias/preset pickers)");
    const text = await composer().innerText();
    for (const retired of RETIRED_TEXT) assert.ok(!text.includes(retired), `the composer still shows retired claude text: ${retired}`);
    assert.ok((await page.locator(".model-selector").count()) >= 1, "the composer has no model selector beside the harness selector");
  });

  // S250-02 — acceptance: switching the harness swaps the model list and resets
  // the selection to that harness's default (claude -> claude-opus-5-5).
  await scenario("S250-02", async () => {
    await openFreshComposer();
    await chooseHarness("claude");
    assert.equal(await triggerText(), DEFAULT_CLAUDE_MODEL, "choosing claude does not select claude-opus-5-5");
    let menu = await modelMenu();
    assert.deepEqual([...menu.texts].sort(), [...CLAUDE_MODELS].sort(), `the claude model list is not the four full names: ${menu.texts.join(", ")}`);
    await clickOption(menu.listbox, "claude-haiku-5-5");
    await closeMenu();
    assert.equal(await triggerText(), "claude-haiku-5-5", "the claude model list did not select the clicked model");
    await chooseHarness("pi");
    assert.equal(await triggerText(), "Model 0", "switching back to pi did not select pi's default model");
    await chooseHarness("claude");
    assert.equal(await triggerText(), DEFAULT_CLAUDE_MODEL, "switching back to claude did not reset the model to claude-opus-5-5");
    menu = await modelMenu();
    assert.deepEqual([...menu.texts].sort(), [...CLAUDE_MODELS].sort(), "the claude model list changed on a second switch");
    await closeMenu();
  });

  // S250-03 — acceptance: exactly the four full names, no bare alias, no
  // "claude default" entry, opus initially.
  await scenario("S250-03", async () => {
    await openFreshComposer();
    await chooseHarness("claude");
    const menu = await modelMenu();
    assert.deepEqual([...menu.texts].sort(), [...CLAUDE_MODELS].sort(), `the claude model list is not exactly the four full names: ${menu.texts.join(", ")}`);
    for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
      assert.ok(!menu.texts.some((text) => text.toLowerCase() === alias), `the claude model list still offers the bare alias ${alias}`);
    }
    assert.ok(!menu.texts.some((text) => /default/i.test(text)), `the claude model list still offers a claude default entry: ${menu.texts.join(", ")}`);
    assert.equal(await triggerText(), DEFAULT_CLAUDE_MODEL, "claude-opus-5-5 is not selected initially");
    await closeMenu();
  });

  // S250-04 — acceptance: the recorded first-launch argv is the reduced set with
  // the full model name, no preset flag and no --cwd; the child's cwd is the session's.
  // The session is at claude's default effort, so its argv carries no --effort and stays
  // 13 words; a picked level adds `--effort <level>` (claude-composer-272.mjs).
  await scenario("S250-04", async () => {
    const id = await createClaudeSession({ message: "E2E 250 argv one", model: "claude-haiku-5-5" });
    sessionIds.argv = id;
    const launch = await waitFor(
      () => stubLaunches().find((entry) => entry.sessionId === id) ?? false,
      30_000,
      "no claude child was launched for the created session (harness claude with a full model name is not wired to a child)",
    );
    firstLaunch = launch;
    const argv = launch.argv;
    const joined = argv.join(" ");
    for (const flag of FORBIDDEN_CLAUDECODE_FLAGS) {
      assert.ok(!argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`)), `the claude child's argv still carries ${flag}: ${joined}`);
    }
    assert.equal(flagCount(argv, "--model"), 1, `the claude child's argv must carry exactly one --model: ${joined}`);
    assert.equal(flagValue(argv, "--model"), "claude-haiku-5-5", `the child's --model is not the session's full model name: ${joined}`);
    assert.equal(flagValue(argv, "--session-id"), id, `the first launch does not carry --session-id <the session id>: ${joined}`);
    assert.equal(flagValue(argv, "--resume"), undefined, `a first launch must not carry --resume: ${joined}`);
    assert.equal(flagValue(argv, "--input-format"), "stream-json", `no --input-format stream-json: ${joined}`);
    assert.equal(flagValue(argv, "--output-format"), "stream-json", `no --output-format stream-json: ${joined}`);
    assert.equal(flagValue(argv, "--permission-prompts"), "none", `no --permission-prompts none: ${joined}`);
    for (const flag of ["-p", "--verbose", "--include-partial-messages"]) {
      assert.ok(argv.includes(flag), `the reduced argv lacks ${flag}: ${joined}`);
    }
    assert.equal(argv.length, 13, `the claude child's argv carries more than the reduced set: ${joined}`);
    assert.equal(resolve(launch.cwd), resolve(project), "the claude child's working directory is not the session's cwd");
  });

  // S250-05 — acceptance: a restart passes --resume <same id> with the same full
  // model name, continues the same transcript, and carries no --session-id.
  await scenario("S250-05", async () => {
    const id = await createClaudeSession({ message: "E2E 250 resume one", model: "claude-sonnet-5-5" });
    await waitFor(() => findTranscript(id) ?? false, 30_000, "the claude child wrote no transcript under the inherited config dir");
    await waitFor(
      // GET /api/agent/<id> answers 200 { running: false } once no child is live
      // (it never answers 404); the owner answer (A).
      async () => {
        const response = await apiFetch(`/api/agent/${id}`);
        return response.status === 200 && (await response.json()).running === false;
      },
      60_000,
      "the claude child did not exit after its turn (idle expiry), so a restart cannot be observed",
      500,
    );
    const before = stubLaunches().length;
    const sent = await postJson(`/api/agent/${id}`, { type: "prompt", message: "E2E 250 resume two" });
    assert.equal(sent.status, 200, `sending a follow-up after the child exited -> ${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);
    const resumed = await waitFor(
      () => stubLaunches().slice(before).find((entry) => entry.resumed && entry.sessionId === id) ?? false,
      30_000,
      "reopening the session started no child with --resume (a fresh conversation was launched)",
    );
    assert.equal(flagValue(resumed.argv, "--resume"), id, `the resumed child must carry --resume <the session id>: ${resumed.argv.join(" ")}`);
    assert.equal(flagValue(resumed.argv, "--session-id"), undefined, "the resumed child still carries --session-id");
    assert.equal(flagValue(resumed.argv, "--model"), "claude-sonnet-5-5", "the resumed child does not use the session's full model name");
    await waitFor(
      () => readFileSync(findTranscript(id), "utf8").includes("E2E 250 resume two"),
      30_000,
      "the follow-up turn did not continue the same transcript",
      500,
    );
  });

  // S250-06 — acceptance: the child's env lacks PI_WEB_PASSWORD and CLAUDECODE,
  // keeps inherited ANTHROPIC_*/CLAUDE_* and the inherited CLAUDE_CONFIG_DIR, and
  // no dedicated config dir is created beside the pi agent dir.
  await scenario("S250-06", async () => {
    assert.ok(firstLaunch, "prerequisite: no claude child was launched, so its environment cannot be checked");
    const names = firstLaunch.envKeys;
    for (const name of PASSWORD_VARS) assert.ok(!names.includes(name), `the claude child inherited ${name}`);
    for (const name of INHERITED_VARS) assert.ok(names.includes(name), `the claude child did not inherit ${name}`);
    assert.ok(names.includes("CLAUDE_CONFIG_DIR"), "the child has no CLAUDE_CONFIG_DIR although pi-web inherited one");
    assert.equal(resolve(String(firstLaunch.configDir)), resolve(configDir), `the child's config dir is not the inherited one: ${String(firstLaunch.configDir)}`);
    assert.ok(!existsSync(join(agentDir, "claude")), `pi-web created the retired dedicated config dir ${join(agentDir, "claude")}`);
    assert.ok(!existsSync(join(home, ".pi", "agent", "claude")), "pi-web created ~/.pi/agent/claude");
  });

  // S250-07 — acceptance: history comes from the inherited CLAUDE_CONFIG_DIR
  // transcript; DELETE removes that session's child, transcript and index entry
  // and nothing else; only indexed sessions are listed; the retired dedicated
  // dir's transcripts are not read.
  await scenario("S250-07", async () => {
    const doomed = await createClaudeSession({ message: "E2E 250 delete A", model: "claude-haiku-5-5" });
    const kept = await createClaudeSession({ message: "E2E 250 keep B", model: "claude-sonnet-5-5" });
    sessionIds.kept = kept;
    await waitFor(() => findTranscript(doomed) && findTranscript(kept), 30_000, "the stub wrote no transcript for a created session");
    mkdirSync(join(configDir, "projects", "stray"), { recursive: true });
    writeFileSync(join(configDir, "projects", "stray", "s250-stray.jsonl"), `${JSON.stringify(userLine("s250-stray", "STRAY TRANSCRIPT"))}\n`);
    const listed = await getJson("/api/sessions?summary=1&force=1");
    const ids = listed.sessions.map((session) => session.id);
    assert.ok(ids.includes(doomed) && ids.includes(kept), `created claude sessions are missing from GET /api/sessions: ${ids.join(", ")}`);
    assert.ok(!ids.includes("s250-stray"), "a transcript pi-web never indexed is listed as a claude session");
    const detail = await getJson(`/api/sessions/${doomed}`);
    assert.ok((detail.context?.messages ?? []).length > 0, "the session history is empty though its transcript is under the inherited config dir");
    assert.equal(resolve(String(detail.filePath)), resolve(findTranscript(doomed)), "the history was not read from the inherited CLAUDE_CONFIG_DIR transcript");
    const deleted = await apiFetch(`/api/sessions/${doomed}`, { method: "DELETE" });
    assert.equal(deleted.status, 200, `DELETE /api/sessions/${doomed} -> ${deleted.status}`);
    assert.ok(!findTranscript(doomed), "DELETE left the session's own transcript behind");
    assert.ok(findTranscript(kept), "DELETE removed another session's transcript");
    const after = await getJson("/api/sessions?summary=1&force=1");
    assert.ok(!after.sessions.some((session) => session.id === doomed), "DELETE left the deleted session's index entry");
    assert.ok(after.sessions.some((session) => session.id === kept), "DELETE removed another session's index entry");
    // The retired dedicated directory is not read: a record whose only transcript
    // sits under <pi agent dir>/claude reads as historyless.
    appendIndex([seedRecord("s250-old-dir", { modelAlias: "sonnet", preset: "read-only" })]);
    const old = join(agentDir, "claude", "projects", "old");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "s250-old-dir.jsonl"), `${JSON.stringify(userLine("s250-old-dir", "OLD DEDICATED DIR HISTORY"))}\n`);
    const oldDetail = await getJson("/api/sessions/s250-old-dir");
    assert.deepEqual(oldDetail.context?.messages ?? [], [], "the retired ~/.pi/agent/claude transcript was used as the session history");
    assert.equal(oldDetail.filePath ?? "", "", "the detail still points at the retired ~/.pi/agent/claude transcript");
  });

  // S250-08 — acceptance: the reader keeps every legacy record (legacy alias ->
  // full name, claude-default -> claude-opus-5-5, preset ignored, unrecognized
  // model -> default) and a new record stores the full name with no preset.
  await scenario("S250-08", async () => {
    appendIndex([
      seedRecord("s250-legacy-sonnet", { modelAlias: "sonnet", preset: "read-only" }),
      seedRecord("s250-legacy-default", { modelAlias: "claude-default", preset: "writable" }),
      seedRecord("s250-legacy-unknown", { model: "not-a-claude-model" }),
    ]);
    const list = await getJson("/api/sessions?summary=1&force=1");
    const row = (id) => list.sessions.find((session) => session.id === id);
    for (const id of ["s250-legacy-sonnet", "s250-legacy-default", "s250-legacy-unknown"]) {
      assert.ok(row(id), `legacy/unrecognized index record ${id} is no longer listed`);
    }
    assert.equal(row("s250-legacy-sonnet").claude?.model, "claude-sonnet-5-5", "a legacy sonnet alias is not listed with its full model name");
    assert.equal(row("s250-legacy-default").claude?.model, "claude-opus-5-5", "a legacy claude-default record is not listed with claude-opus-5-5");
    assert.equal(row("s250-legacy-unknown").claude?.model, "claude-opus-5-5", "a record with an unrecognized model value is not listed with the default full name");
    assert.equal(row("s250-legacy-sonnet").claude?.preset, undefined, "a legacy preset still reaches the session list");
    const index = readIndex();
    const created = (index.sessions ?? []).find((record) => record.id === sessionIds.argv);
    assert.ok(created, "the newly created claude session has no index record");
    assert.equal(created.model, "claude-haiku-5-5", "a new index record does not store the full model name");
    assert.ok(!("preset" in created), "a new index record still stores a tool preset");
    assert.ok(!("modelAlias" in created), "a new index record still stores a model alias");
  });

  // S250-09 — acceptance: the preset selector/descriptions, the composer config-dir
  // line/note and Settings › General's claude section are gone; GET /api/claude
  // offers the four models but no config dir or presets; a create needs a full
  // model name and a supplied preset never creates a preset-based child.
  await scenario("S250-09", async () => {
    await openFreshComposer();
    await chooseHarness("claude");
    assert.equal(await composer().locator("select").count(), 0, "the fresh claude composer still renders <select> controls (the preset picker)");
    const text = await composer().innerText();
    for (const retired of RETIRED_TEXT) assert.ok(!text.includes(retired), `the composer still shows retired claude text: ${retired}`);
    await page.getByRole("button", { name: "Settings", exact: true }).click({ timeout: ACTION_MS });
    await page.locator(".settings-dialog-surface").waitFor({ state: "visible", timeout: 30_000 });
    const settingsText = await page.locator(".settings-dialog-main").innerText();
    assert.ok(!/claude config dir:/i.test(settingsText), "Settings still shows a claude config-dir line");
    assert.ok(!/credentials belong in this directory/i.test(settingsText), "Settings still shows the claude config-dir note");
    assert.equal(await page.locator(".settings-claude-section").count(), 0, "Settings › General still renders the claude config-dir section");
    const availability = await getJson("/api/claude");
    assert.equal(availability.available, true, "GET /api/claude does not report claude on PATH");
    assert.deepEqual(availability.models, CLAUDE_MODELS, `GET /api/claude does not offer the four full model names: ${JSON.stringify(availability.models)}`);
    assert.equal(availability.defaultModel, DEFAULT_CLAUDE_MODEL, "GET /api/claude reports no/wrong default model");
    for (const retired of ["configDir", "presets", "defaultPreset", "modelAliases"]) {
      assert.equal(availability[retired], undefined, `GET /api/claude still reports ${retired}`);
    }
    const before = stubLaunches().length;
    const id = await createClaudeSession({ message: "E2E 250 preset ignored", model: "claude-haiku-5-5", extra: { claudePreset: "writable" } });
    const launch = await waitFor(
      () => stubLaunches().slice(before).find((entry) => entry.sessionId === id) ?? false,
      30_000,
      "the create with a supplied preset launched no child",
    );
    for (const flag of ["--permission-mode", "--tools", "--allowedTools", "--bare", "--strict-mcp-config", "--disable-slash-commands"]) {
      assert.ok(!launch.argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`)), `a supplied claudePreset still reached the child's argv as ${flag}`);
    }
    const refused = await postJson("/api/agent/new", { cwd: project, type: "prompt", message: "x", harness: "claude", model: "sonnet" });
    assert.equal(refused.status, 400, `POST /api/agent/new accepted a bare alias as the claude model: ${refused.status}`);
    assert.equal(stubLaunches().length, before + 1, "a refused claude create launched a child");
  });

  // S250-10 — acceptance: the system-claude hint appears under the selectors when
  // claude is chosen, in each language's exact wording, and not for pi.
  await scenario("S250-10", async () => {
    for (const [locale, hint] of Object.entries(HINTS)) {
      await openFreshComposer(locale);
      await chooseHarness("claude");
      const text = await composer().innerText();
      assert.ok(text.includes(hint), `${locale}: the system-claude hint line is missing or differs: ${text.slice(-400)}`);
    }
    await openFreshComposer("en");
    await chooseHarness("claude");
    await chooseHarness("pi");
    assert.ok(!(await composer().innerText()).includes(HINTS.en), "the system-claude hint stays visible after switching back to pi");
  });

  // S250-11 — acceptance (rewritten by, which reversed #250's "model fixed for
  // the session"): an existing claude session shows its full model name in pi's model
  // selector beside the effort and compact controls, still offers no harness selector and no
  // "fixed for this session" line, and a set_model to another full name is claude's to answer.
  await scenario("S250-11", async () => {
    const id = sessionIds.kept;
    assert.ok(id, "prerequisite: no claude session exists to reopen");
    await page.goto(`${base}/?session=${encodeURIComponent(id)}`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
    await page.locator(".chat-input-textarea").waitFor({ state: "visible", timeout: NAV_MS });
    const bar = bottomBar();
    assert.equal(await bar.locator(".model-selector").count(), 1, "an existing claude session offers no model selector");
    assert.equal((await modelTrigger().innerText()).trim(), "claude-sonnet-5-5", "the model selector does not show the session's full model name");
    assert.ok(await bar.locator('button[aria-label="Change reasoning level"]').count() > 0, "an existing claude session offers no effort control");
    assert.ok(await bar.locator('button[aria-label="Compact context"]').count() > 0, "an existing claude session offers no compact control");
    assert.equal(await harnessControl(), null, "an existing claude session still offers a harness selector");
    const text = await composer().innerText();
    assert.ok(!/fixed for this session/i.test(text), `the existing session still shows the fixed-for-this-session line: ${text.slice(-300)}`);
    await waitFor(async () => {
      const state = await getJson(`/api/agent/${encodeURIComponent(id)}`);
      return !state.state?.isStreaming;
    }, 60_000, "the existing session's turn never ended");
    const before = stubLaunches().length;
    const changed = await postJson(`/api/agent/${id}`, { type: "set_model", provider: "claude", model: "claude-opus-5-5" });
    assert.equal(changed.status, 200, `a set_model request to a full name was not taken: ${changed.status} ${JSON.stringify(changed.body).slice(0, 200)}`);
    assert.equal(changed.body.data?.rejected, undefined, `the stub claude refused a full model name: ${JSON.stringify(changed.body)}`);
    assert.equal(changed.body.data?.model, "claude-opus-5-5", "the switch does not report the new model");
    assert.equal(readIndex().sessions.find((record) => record.id === id)?.model, "claude-opus-5-5", "the index does not record the accepted switch");
    assert.equal(stubLaunches().length, before, "the model switch launched a new child");
    const refused = await postJson(`/api/agent/${id}`, { type: "set_model", provider: "claude", model: "opus" });
    assert.equal(refused.status, 400, `a set_model to a bare alias was not refused: ${refused.status}`);
    assert.equal(readIndex().sessions.find((record) => record.id === id)?.model, "claude-opus-5-5", "a refused switch changed the index");
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  failures.push(`setup: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (page) await page.screenshot({ path: join(artifacts, "claude-250-failure.png") }).catch(() => {});
  if (context) await context.tracing.stop({ path: join(artifacts, "claude-250-trace.zip") }).catch(() => {});
  await browser?.close().catch(() => {});
  await stopServer();
  // Every child the suite started is inside the server's process group tree;
  // kill any stub pid still alive, bounded, then remove the scratch tree.
  for (const launch of stubLaunches()) {
    if (pidAlive(launch.pid)) {
      try { process.kill(launch.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}

if (failures.length) {
  console.log(`FAIL claude-250: ${failures.length} scenario(s) failed`);
  process.exitCode = 1;
}