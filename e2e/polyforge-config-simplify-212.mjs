// carries: components/Polyforge*, components/polyforge-*, hooks/usePolyforge*, lib/polyforge*, app/api/polyforge/*
// carries: components/SettingsPanel*, components/SettingsUi*, components/settings-ui-helpers*, lib/settings-navigation*, lib/package-settings*, app/api/plugins/*
// — Settings › Polyforge simplification acceptance (authored pre-code).
//
// The owner asked for progressive disclosure on the Settings › Polyforge page:
// a one-line detection summary, only the seven common writable keys visible by
// default, counted read-only folds, a whole-card workspace fold, default-collapsed
// read-out blocks and per-row feedback. Every scenario below asserts the spec's
// outcome through the page the browser renders, with `/api/polyforge/**` and
// `/api/plugins` stubbed exactly as e2e/polyforge-config-layout.mjs does.
// replaced (never stacked) the card-structure pins: one 工作区 /
// Workspace card (its summarize rows common, its mapping and memory_policy rows
// folded, the legend and column header above the fold), the workflow card after
// the configuration cards, and no declared-candidates card. Every count is read
// from its own element (a fold toggle, a card title), never a card's whole text.
//
//   node e2e/polyforge-config-simplify-212.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startNextServer } from "./next-server.mjs";
import { NAV_MS } from "./timeouts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(!existsSync(join(root, process.env.PI_WEB_DIST_DIR || ".next", "dev/lock")), "Run in a checkout without an active dev server");
const work = mkdtempSync(join(tmpdir(), "pi-web-pf-simplify-212-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
const SESSION = "e2e-pf-simplify-212";
const SESSION_TEXT = "E2E polyforge simplify host session";
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project, { recursive: true });
const ts = "2026-10-31T00:00:00.000Z";
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), [
  { type: "session", version: 3, id: SESSION, timestamp: ts, cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: SESSION_TEXT } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

const WS = `[workspace."${project}"]`;
const MODELS = ["pi:zeta", "pi:alpha", "pi:beta"];
const COMMON = ["max_concurrent_jobs", "step_timeout", "stall_window", "api_key", "summarize.models", "summarize.language", "summarize.interval_sec"];
const CONFIG = {
  pfPresent: true,
  pfVersion: "v2.20.11",
  capable: true,
  file: { sha256: "e2e-cli", exists: true },
  mapped: true,
  daemonReachable: true,
  reload: { pending: [], overridden: [] },
  workspaceFile: { sha256: "e2e-yaml", exists: true },
  items: [
    { key: "server", value: "http://127.0.0.1:1", source: "file", class: "restart-only" },
    { key: "api_key", set: true, source: "file", class: "restart-only" },
    { key: "daemon_socket", value: "/run/pf.sock", source: "file", class: "restart-only" },
    { key: "user_id", value: "usr_root", source: "file", class: "cli-only" },
    { key: "claude_bin", value: "/usr/local/bin/claude", source: "file", class: "live" },
    { key: "future_knob", value: "x", source: "file", class: "brand-new-class" },
    { key: "harness_root", value: "/opt/pf", source: "file", class: "restart-only" },
    { key: "operator_agent_dir", value: "/home/op/.pi", source: "file", class: "restart-only" },
    { key: "step_timeout", value: "30m0s", source: "file", class: "live", schema: { kind: "duration" }, daemon: { value: "30m0s" } },
    { key: "stall_window", value: "10m0s", source: "file", class: "live", schema: { kind: "duration" }, daemon: { value: "10m0s" } },
    { key: "max_concurrent_jobs", value: 6, source: "file", class: "live", schema: { kind: "int", min: 1 }, daemon: { value: 6 } },
    { key: WS, value: "e2e-project", source: "file", class: "restart-only", section: true },
    { key: "summarize.models", value: MODELS, source: "file", class: "live", schema: { kind: "model-list" } },
    { key: "summarize.language", value: "English", source: "file", class: "live", schema: { kind: "string" } },
    { key: "summarize.interval_sec", value: 30, source: "file", class: "live", schema: { kind: "int", min: 10, max: 3600 } },
  ],
  steps: [{ project: "e2e", step: "fix", declared: true, models: MODELS }, { project: "e2e", step: "code", declared: false, models: null }],
  steps_complete: true,
  memoryPolicy: {
    source: "file", class: "next-claim", appendToDefault: true,
    default: { record: ["base-record"], skip: ["base-skip"], declared: true },
    projects: { "e2e-project": { record: ["project-record"], skip: [], declared: true } },
  },
};
// The memory_policy rows the 工作区 card folds (the default entry, then each project).
const MEMORY_KEYS = ["memory_policy.default", "memory_policy.e2e-project"];
// the workflow card's read, fixed so the page is the fixture's
// (the card renders after the configuration cards whatever pf is installed).
const workflowsFixture = (project) => {
  const chain = (models, from) => ({ "e2e-project": { models, from } });
  return {
    pfPresent: true,
    pfVersion: "v2.20.16",
    capable: true,
    workflows: {
      workflows_dir: "/e2e/workflows", daemon_reachable: true, reason: "", workspace: project, projects: ["e2e-project"],
      write_capable: true, write_reason: "",
      bundles: [{
        name: "feature-full",
        defaults: { model_candidates: ["pi:ff-default"], effective: chain(["pi:ff-default"], "bundle feature-full defaults.model_candidates") },
        steps: [
          { id: "grill", model_candidates: ["pi:ff-grill"], attrs: [{ name: "question_batch_size", type: "int", default: 0 }],
            effective: chain(["pi:ff-grill"], "bundle feature-full step grill model_candidates") },
          { id: "code", model_candidates: ["pi:ff-code"], effective: chain(["pi:ff-code"], "bundle feature-full step code model_candidates") },
        ],
      }],
      bundle_errors: [],
    },
    workspace: { workspace: project, yaml: { sha256: "e2e-yaml", exists: true }, steps: { "e2e-project": {} } },
  };
};

const HEALTHY_DETECT = {
  pfPresent: true, pfVersion: "v2.20.11", pfVersionBelowMinimum: false, line: "internal",
  piSkillInstalled: true, piSkillEnabled: true, claudeSkillsSymlink: true, claudeSessionStartHook: true,
  daemon: { reachable: true },
};
const ABSENT_DETECT = {
  pfPresent: false, pfVersion: null, pfVersionBelowMinimum: false, line: "unknown",
  piSkillInstalled: false, piSkillEnabled: false, claudeSkillsSymlink: false, claudeSessionStartHook: false,
  daemon: null,
};
const HISTORY_ENTRY = { id: "h1", key: "step_timeout", old: "20m0s", new: "30m0s", rollbackable: true };
const DETAIL_LABELS = ["Version", "Line", "pi skill package (global)", "Claude Code skill symlink", "Claude Code SessionStart hook", "Daemon"];
const failures = [];
let checks = 0;
async function check(label, fn) {
  checks += 1;
  try { await fn(); console.log(`PASS ${label}`); }
  catch (error) {
    const message = String(error?.message ?? error).split("\n").slice(0, 8).join(" | ");
    failures.push(`${label}: ${message}`);
    console.log(`FAIL ${label}: ${message}`);
  }
}
let browser;
let base;
let stop = async () => {};
async function openSettings(page) {
  const show = page.locator('button[aria-label="Show sidebar"], button[aria-label="显示侧边栏"]').first();
  if (await show.isVisible().catch(() => false)) await show.click();
  await page.locator('button[aria-label="Settings"], button[aria-label="设置"]').first().click({ timeout: NAV_MS });
  const dialog = page.locator('[role="dialog"][aria-label="Settings"], [role="dialog"][aria-label="设置"]').first();
  await dialog.waitFor({ timeout: NAV_MS });
  await dialog.getByRole("button", { name: "Polyforge", exact: true }).click({ timeout: NAV_MS });
  await dialog.locator(".polyforge-config-row").first().waitFor({ state: "visible", timeout: NAV_MS });
  return dialog;
}
async function openPage({ width = 1100, height = 980, detect = HEALTHY_DETECT } = {}) {
  const state = { history: [{ ...HISTORY_ENTRY }], posts: [], requests: [], historyReads: 0 };
  const context = await browser.newContext({ viewport: { width, height }, locale: "en-US" });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("pi-locale", "en");
      window.localStorage.setItem("pi-web:session-age-filter-days", "0");
    } catch { /* storage unavailable */ }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/polyforge/")) return;
    state.requests.push({ method: request.method(), url: url.pathname + url.search, body: request.postData() ?? "" });
  });
  await page.route("**/api/polyforge/**", (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/api/polyforge/config/history") {
      if (request.method() === "POST") return json({ message: "E2E-ROLLBACK-OK-212" });
      state.historyReads += 1;
      return json({ entries: state.history });
    }
    if (path === "/api/polyforge/config") {
      if (request.method() === "POST") {
        const body = JSON.parse(request.postData() || "{}");
        state.posts.push(body);
        state.history = [{ id: `save-${state.posts.length}`, key: body.key, old: 6, new: body.value, rollbackable: true }, ...state.history];
        return json({ message: "E2E-SAVE-OK-212" });
      }
      return json(CONFIG);
    }
    if (path === "/api/polyforge/workflows") return json(workflowsFixture(project));
    if (path === "/api/polyforge/detect") return json(detect);
    if (path === "/api/polyforge/detect?force=1") return json(detect);
    return json({ error: `unexpected e2e path ${path}` });
  });
  await page.route("**/api/plugins?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    packages: [{ scope: "global", packageName: "polyforge", source: "/opt/polyforge" }],
  }) }));
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await page.getByText(SESSION_TEXT).first().waitFor({ state: "attached", timeout: NAV_MS });
  const dialog = await openSettings(page);
  return { context, page, dialog, state };
}

const card = (dialog, label) => dialog.locator(`section[aria-label="${label}"]`).first();
// A row's key: the key cell's text without its source-file tag.
const rowKey = (row) => row.locator(".polyforge-config-key").evaluate((cell) => {
  const copy = cell.cloneNode(true);
  copy.querySelectorAll(".polyforge-config-file-tag").forEach((tag) => tag.remove());
  return (copy.textContent ?? "").trim();
});
const visibleRowKeys = async (scope) => {
  const rows = scope.locator(".polyforge-config-row:visible");
  const keys = [];
  for (let index = 0; index < await rows.count(); index += 1) keys.push(await rowKey(rows.nth(index)));
  return keys.sort();
};
// A fold's count is read from that fold's own toggle, never a card's whole text.
const foldCount = async (section) => {
  const text = (await section.locator(".polyforge-disclosure-toggle").first().innerText()).trim();
  const match = /\((\d+)\)/.exec(text);
  assert.ok(match, `the fold toggle states no count: ${text}`);
  return Number(match[1]);
};
async function expandAll(dialog) {
  const target = '[aria-expanded="false"]:visible, details:not([open]) > summary:visible';
  for (let round = 0; round < 12; round += 1) {
    const remaining = await dialog.locator(target).count();
    if (!remaining) return;
    for (let index = 0; index < remaining; index += 1) await dialog.locator(target).nth(0).click({ timeout: 4_000 }).catch(() => {});
    if (await dialog.locator(target).count() === 0) return;
  }
}
async function waitUntil(predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}
async function top(locator, name) {
  const box = await locator.first().boundingBox();
  assert.ok(box, `${name} is not visible`);
  return box.y;
}
try {
  const started = await startNextServer({
    name: "polyforge-config-simplify-212",
    logFile: join(work, "server.log"),
    env: { ...process.env, HOME: work, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
  });
  base = started.base;
  stop = started.stop;
  browser = await chromium.launch();

  await check("S212-1 default collapsed configuration set at 1100px", async () => {
    const { context, dialog } = await openPage();
    try {
      assert.deepEqual(await visibleRowKeys(dialog), [...COMMON].sort(),
        "the default page does not show exactly the seven common writable keys");
      assert.equal(await foldCount(card(dialog, "cli.toml")), 5, "cli.toml's read-only toggle does not state its 5 hidden rows");
      assert.equal(await foldCount(card(dialog, "cli.toml · [daemon]")), 2, "[daemon]'s read-only toggle does not state its 2 hidden rows");
      const workspace = card(dialog, "Workspace");
      assert.deepEqual(await visibleRowKeys(workspace), ["summarize.interval_sec", "summarize.language", "summarize.models"],
        "the 工作区 card's visible rows are not exactly its summarize keys");
      assert.equal(await foldCount(workspace), 1 + MEMORY_KEYS.length, "the 工作区 fold does not count its mapping and memory_policy rows");
      // The legend and the column header stay outside the fold: visible while it is collapsed.
      assert.equal(await workspace.locator(".polyforge-disclosure-toggle").first().getAttribute("aria-expanded"), "false");
      assert.ok(await workspace.locator(".polyforge-config-legend").first().isVisible(), "the legend is hidden inside the collapsed fold");
      assert.ok(await workspace.locator(".polyforge-config-grid-header").first().isVisible(), "the column header is hidden inside the collapsed fold");
      // Every 工作区 row names its own file.
      for (const row of await workspace.locator(".polyforge-config-row").all()) {
        const mapping = await row.locator(".polyforge-config-workspace-path").count() > 0;
        const tag = (await row.locator(".polyforge-config-file-tag").textContent() ?? "").trim();
        assert.equal(tag, mapping ? "cli.toml" : ".polyforge.yaml", `${await rowKey(row)} carries the wrong file tag ${tag}`);
      }
    } finally { await context.close(); }
  });

  await check("S212-2 expanding every disclosure keeps the whole key inventory reachable", async () => {
    const { context, dialog } = await openPage();
    try {
      assert.ok(await dialog.locator('[aria-expanded="false"]:visible, details:not([open]) > summary:visible').count() > 0,
        "the page renders no default-collapsed disclosure at all");
      await expandAll(dialog);
      const keys = await visibleRowKeys(dialog);
      assert.equal(keys.length, CONFIG.items.length + MEMORY_KEYS.length, `expanded rows ${keys.length}, stub items ${CONFIG.items.length} + memory rows ${MEMORY_KEYS.length}`);
      for (const key of [...CONFIG.items.filter((entry) => !entry.section).map((entry) => entry.key), ...MEMORY_KEYS]) {
        assert.equal(keys.filter((entry) => entry === key).length, 1, `${key} does not have exactly one row`);
      }
      for (const key of MEMORY_KEYS) {
        const row = dialog.locator(".polyforge-config-row").filter({ has: dialog.page().getByText(key, { exact: true }) }).first();
        assert.equal(await row.locator("input, textarea, button").count(), 0, `${key} is not read-only`);
      }
      for (const key of COMMON) {
        const input = dialog.locator(`input[aria-label="${key}"]`).first();
        assert.ok(await input.isEnabled(), `${key} has no enabled write input after expanding`);
        const row = dialog.locator(`.polyforge-config-row:has(input[aria-label="${key}"])`).first();
        assert.ok(await row.getByRole("button", { name: "Save", exact: true }).count() >= 1, `${key} has no Save control after expanding`);
      }
      assert.ok(await card(dialog, "cli.toml").getByText(/Other \(brand-new-class\)/).count() >= 1,
        "the unknown key lost its fallback class label");
    } finally { await context.close(); }
  });

  await check("S212-3 read-only rows share one muted presentation across cards", async () => {
    const { context, dialog } = await openPage();
    try {
      await expandAll(dialog);
      const rows = dialog.locator(".polyforge-config-row.is-readonly");
      assert.ok(await rows.count() >= 4, "no read-only rows rendered after expanding");
      const colours = await rows.evaluateAll((nodes) => nodes.map((row) => {
        const leaf = row.querySelector(".polyforge-config-value, .polyforge-config-workspace-path, .polyforge-config-chips, .polyforge-config-empty");
        return leaf ? getComputedStyle(leaf).color : null;
      }));
      assert.ok(colours.every(Boolean), "a read-only row has no value element");
      assert.equal(new Set(colours).size, 1, `read-only values use different colours: ${[...new Set(colours)].join(" / ")}`);
      assert.equal(await rows.locator("input, button").count(), 0, "a read-only row renders a write control");
    } finally { await context.close(); }
  });

  await check("S212-4 the page order is the confirmed top-to-bottom one", async () => {
    const { context, dialog } = await openPage();
    try {
      const landmarks = [
        ["machine status", dialog.getByText("Machine status", { exact: true }).first()],
        ["cli.toml", dialog.getByText("cli.toml", { exact: true }).first()],
        ["cli.toml · [daemon]", dialog.getByText("cli.toml · [daemon]", { exact: true }).first()],
        ["workspace", card(dialog, "Workspace").locator(".polyforge-config-card-title").first()],
        ["workflow", card(dialog, "Workflow").locator(".polyforge-config-card-title").first()],
        ["package switch", dialog.getByText("Polyforge package (global)", { exact: true }).first()],
        ["Jobs card stream", dialog.getByText("Jobs card stream", { exact: true }).first()],
        ["history", dialog.getByText(/^Recent panel writes/).first()],
        ["install command", dialog.getByText("Install / upgrade command", { exact: true }).first()],
        ["footer", dialog.getByRole("button", { name: "Re-detect", exact: true }).first()],
      ];
      const ys = [];
      for (const [name, locator] of landmarks) ys.push({ name, y: await top(locator, name) });
      for (let index = 1; index < ys.length; index += 1) {
        assert.ok(ys[index].y >= ys[index - 1].y - 1,
          `${ys[index].name} renders above ${ys[index - 1].name}: ${ys[index].y.toFixed(1)} < ${ys[index - 1].y.toFixed(1)}`);
      }
    } finally { await context.close(); }
  });

  await check("S212-5 detection collapses to one summary line and names abnormal state", async () => {
    const healthy = await openPage();
    try {
      const status = card(healthy.dialog, "Machine status");
      for (const label of DETAIL_LABELS) {
        assert.equal(await status.getByText(label, { exact: true }).first().isVisible().catch(() => false), false,
          `${label} is visible while detection is collapsed`);
      }
      assert.match(await status.innerText(), /v2\.20\.11/, "the collapsed summary does not name the detected version");
      const toggle = status.locator('[aria-expanded="false"]:visible, summary:visible').first();
      assert.ok(await toggle.count() > 0, "the detection region has no summary toggle");
      await toggle.click({ timeout: 10_000 });
      for (const label of DETAIL_LABELS) {
        assert.ok(await status.getByText(label, { exact: true }).first().isVisible().catch(() => false),
          `${label} is not visible after expanding detection`);
      }
    } finally { await healthy.context.close(); }

    const absent = await openPage({ detect: ABSENT_DETECT });
    try {
      const status = card(absent.dialog, "Machine status");
      for (const label of DETAIL_LABELS) {
        assert.equal(await status.getByText(label, { exact: true }).first().isVisible().catch(() => false), false,
          `${label} is visible while abnormal detection is collapsed`);
      }
      assert.ok(await absent.dialog.getByText("Polyforge is not installed on this machine.", { exact: true }).first().isVisible(),
        "the absent state is not visible text on the collapsed page");
    } finally { await absent.context.close(); }
  });

  await check("S212-6 read-out blocks are collapsed with counts and the install command is visible when pf is absent", async () => {
    const healthy = await openPage();
    try {
      // the declared-candidates read-out is gone (the workflow card carries the steps).
      assert.equal(await card(healthy.dialog, "Declared step candidates").count(), 0, "the declared-candidates card still renders");
      assert.equal(await healthy.dialog.getByText(/^Declared step candidates/).count(), 0, "the declared-candidates title still renders");
      assert.equal(await healthy.dialog.locator(".polyforge-config-history-row:visible").count(), 0,
        "history entries are visible in the default state");
      const history = healthy.dialog.locator('section[aria-label="Recent panel writes"]').first();
      const historyCount = (await history.locator(".polyforge-config-candidate-count").first().innerText()).trim();
      assert.match(historyCount, /^\D*1\D*$/, `the history title's own count does not state its 1 entry: ${historyCount}`);
      assert.equal(await healthy.dialog.getByText(/tools\/install\.sh/).first().isVisible().catch(() => false), false,
        "the install command is visible although detection is healthy");
      await expandAll(healthy.dialog);
      assert.ok(await healthy.dialog.locator(".polyforge-config-history-row:visible").count() > 0, "expanding history reveals no entries");
      assert.ok(await healthy.dialog.getByText(/tools\/install\.sh/).first().isVisible(), "expanding the install block reveals no command");
    } finally { await healthy.context.close(); }

    const absent = await openPage({ detect: ABSENT_DETECT });
    try {
      assert.ok(await absent.dialog.getByText(/tools\/install\.sh/).first().isVisible(),
        "the install command is not visible without an extra disclosure when pf is absent");
      const copy = absent.dialog.getByRole("button", { name: "Copy install command", exact: true }).first();
      assert.ok(await copy.isVisible(), "the install copy control is not visible when pf is absent");
    } finally { await absent.context.close(); }
  });

  await check("S212-7 each region's open state survives a reload", async () => {
    const { context, page, dialog, state } = await openPage();
    try {
      const detectToggle = card(dialog, "Machine status").locator('[aria-expanded="false"]:visible, summary:visible').first();
      assert.ok(await detectToggle.count() > 0, "detection has no open/closed toggle");
      await detectToggle.click({ timeout: 10_000 });
      const workspaceToggle = card(dialog, "Workspace").locator('[aria-expanded="false"]:visible, summary:visible').first();
      assert.ok(await workspaceToggle.count() > 0, "the workspace card has no open/closed toggle");
      await workspaceToggle.click({ timeout: 10_000 });
      assert.ok(await dialog.locator(".polyforge-config-row:visible .polyforge-config-workspace-path").first().isVisible(),
        "the workspace rows did not open");
      const stored = await page.evaluate(() => Object.keys(localStorage).filter((key) => /polyforge/i.test(key)));
      assert.ok(stored.length >= 1, "no browser key holds the open/closed state");
      assert.ok(state.requests.every((request) => request.method === "GET" || !/disclosure|collapsed/.test(request.body)),
        "a request carried the collapse state");
      await page.reload({ waitUntil: "domcontentloaded", timeout: NAV_MS });
      await page.getByText(SESSION_TEXT).first().waitFor({ state: "attached", timeout: NAV_MS });
      const reopened = await openSettings(page);
      const status = card(reopened, "Machine status");
      for (const label of DETAIL_LABELS) {
        assert.ok(await status.getByText(label, { exact: true }).first().isVisible().catch(() => false),
          `${label} did not reopen from the stored detection state`);
      }
      assert.ok(await reopened.locator(".polyforge-config-row:visible .polyforge-config-workspace-path").first().isVisible(),
        "the workspace card did not reopen from the stored state");
    } finally { await context.close(); }
  });

  await check("S212-8 per-key save and validation feedback render under their row", async () => {
    const { context, page, dialog, state } = await openPage();
    try {
      const input = dialog.locator('input[aria-label="max_concurrent_jobs"]').first();
      const row = dialog.locator('.polyforge-config-row:has(input[aria-label="max_concurrent_jobs"])').first();
      const footer = dialog.locator(".config-footer").first();
      const rowBefore = await row.innerText();
      const footerBefore = await footer.innerText();
      const historyReadsBefore = state.historyReads;
      await input.fill("7");
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith("/api/polyforge/config") && response.request().method() === "POST", { timeout: 20_000 }),
        row.getByRole("button", { name: "Save", exact: true }).click(),
      ]);
      assert.ok(await waitUntil(async () => (await row.innerText()) !== rowBefore), "the save result is not under the max_concurrent_jobs row");
      assert.equal(await footer.innerText(), footerBefore, "the footer duplicates or replaces its page-level status with the row's save result");
      assert.equal(state.posts.length, 1, `the save issued ${state.posts.length} config writes`);
      assert.ok(await waitUntil(() => state.historyReads > historyReadsBefore), "the change history was not re-read after the save");
      await expandAll(dialog);
      const historyRows = await dialog.locator(".polyforge-config-history-row").allInnerTexts();
      assert.ok(historyRows.length >= 2, `the change history did not gain the save entry (${historyRows.length} rows)`);
      assert.ok(historyRows.some((text) => text.includes("max_concurrent_jobs") && text.includes("7")),
        "the change history has no entry for the saved max_concurrent_jobs value");

      await input.fill("0");
      await row.getByRole("button", { name: "Save", exact: true }).click();
      const alert = row.locator('[role="alert"]').first();
      await alert.waitFor({ state: "visible", timeout: 10_000 });
      assert.ok((await alert.innerText()).trim().length > 0, "the validation error has no text");
      assert.equal(state.posts.length, 1, "an invalid value reached the write path");
    } finally { await context.close(); }
  });
} catch (error) {
  console.error(`ABORT ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stop();
}

console.log(`\n${checks - failures.length}/${checks} simplification checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} simplification check(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
