// — pi-web UI polish batch acceptance pass (five items).
//
// Authored PRE-CODE from artifacts/spec.md (Requirements + `#### Scenario`)
// and never from `code`'s implementation. Every locator drives behaviour
// through surfaces that already exist on base 4b000b22 (session fixtures,
// the Session-info popover, the Debug panel, the chat's floating button, the
// Polyforge config page and Jobs dock) and matches new behaviour only through
// user-visible text or the spec's geometry predicates. On 4b000b22 each
// scenario is assertion-level red: the popover still mounts machine load,
// the Debug section sits above `.debug-cols`, the toolbar still owns ↻, the
// floating fetch form does not exist, the config badge is on its own row, the
// Jobs track is 112px, the card status is its own row and progress is 48px.
//
// Each passing scenario prints its own `PASS S<n>` line (the verification
// marker); on the baseline it prints `FAIL S<n>` and no marker matches.
//
//   node e2e/ui-polish-198.mjs
//   npm run test:e2e:all -- ui-polish-198.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startNextServer } from "./next-server.mjs";
import { NAV_MS } from "./timeouts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.env.PI_WEB_DIST_DIR ||= ".next/e2e/ui-polish-198";
if (process.env.PI_WEB_DIST_DIR.startsWith(".next/e2e/")) {
  rmSync(join(root, process.env.PI_WEB_DIST_DIR), { recursive: true, force: true });
}
assert.ok(!existsSync(join(root, process.env.PI_WEB_DIST_DIR || ".next", "dev/lock")), "Run in a checkout without an active dev server");

const work = mkdtempSync(join(tmpdir(), "pi-web-ui-polish-198-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project, { recursive: true });
const TS = "2026-10-31T00:00:00.000Z";
const MAIN = "e2e-polish-main";
const SCROLL = "e2e-polish-scroll";
const writeSession = (id, messages) => writeFileSync(join(agentDir, "sessions", "e2e", `${id}.jsonl`), [
  { type: "session", version: 3, id, timestamp: TS, cwd: project },
  ...messages.map((message, index) => ({ type: "message", id: `m${index}`, parentId: index ? `m${index - 1}` : null, timestamp: TS, message })),
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
writeSession(MAIN, [
  { role: "user", content: "E2E ui polish host session" },
  { role: "assistant", content: "E2E ui polish reply" },
]);
writeSession(SCROLL, Array.from({ length: 160 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  content: `SCROLL message ${String(index).padStart(3, "0")}`,
})));

// S12 (the owner answer): a second long saved session for the right split pane.
const RIGHT = "e2e-polish-right";
writeSession(RIGHT, Array.from({ length: 160 }, (_, index) => ({
  role: index % 2 ? "assistant" : "user",
  content: `RIGHT message ${String(index).padStart(3, "0")}`,
})));

const BARRIER = "/__e2e_request_barrier";
const ML = { cpu: "12.3%", cores: "8", loadavg: "0.42 / 0.51 / 0.63", memory: "5.2 / 16.0 GiB" };
const ML_VALUES = Object.values(ML);
const mlPayload = () => ({ metrics: { cpuPercent: 12.3, coreCount: 8, loadavg: [0.42, 0.51, 0.63], memoryUsedBytes: 5583457485, memoryTotalBytes: 17179869184 } });
/** 150.5px measured on 4b000b22 with this suite's card fixture and 460px dock. */
const CARD_HEIGHT_BASE_460 = 150.5;

const failures = [];
async function check(id, title, fn) {
  try {
    await fn();
    console.log(`PASS ${id}`);
  } catch (error) {
    failures.push(id);
    console.log(`FAIL ${id}: ${String(error?.message ?? error).split("\n")[0]}`);
    console.error(`  ${title}: ${String(error?.message ?? error)}`);
  }
}

let browser;
let base;
let stop = async () => {};
const openContexts = new Set();
const visible = (locator) => locator.first().isVisible().catch(() => false);
async function waitFor(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await predicate(); if (last) return last; } catch (error) { last = error.message; }
    await delay(100);
  }
  throw new Error(`${label} (last: ${last})`);
}

async function openPage({ session = MAIN, marker = "E2E ui polish reply", viewport = { width: 1440, height: 900 }, storage = {}, routes = [], clock = false } = {}) {
  const context = await browser.newContext({ viewport, locale: "en-US" });
  openContexts.add(context);
  await context.addInitScript(({ prefs }) => {
    try {
      localStorage.setItem("pi-web:split-view-enabled", "false");
      localStorage.setItem("pi-locale", "en");
      localStorage.setItem("pi-web:session-age-filter-days", "0");
      for (const [key, value] of Object.entries(prefs)) localStorage.setItem(key, value);
    } catch { /* storage unavailable */ }
  }, { prefs: storage });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const state = { context, page, requests: [], mlHits: 0, mlMode: "ok" };
  page.on("request", (request) => {
    const url = new URL(request.url());
    state.requests.push(url.pathname + url.search);
    if (/\/api\/machine-load$/.test(url.pathname)) state.mlHits += 1;
  });
  page.on("pageerror", (error) => { state.pageError = error.message; });
  page.on("console", (event) => { if (event.type() === "error") state.consoleError = event.text(); });
  await page.route((url) => url.pathname === BARRIER, (route) => route.fulfill({ status: 204 }));
  page.route(/\/api\/machine-load(\?|$)/, (route) => state.mlMode === "null-metrics"
    ? route.fulfill({ json: { metrics: null } })
    : route.fulfill({ json: mlPayload() }));
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  await page.goto(`${base}/?session=${session}`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await page.getByText(marker, { exact: true }).first().waitFor({ state: "attached", timeout: NAV_MS });
  if (clock) {
    await page.clock.install({ time: new Date() });
    await page.clock.pauseAt(new Date(Date.now() + 2000));
  }
  return state;
}
async function closePage(state) {
  openContexts.delete(state.context);
  await state.context.close().catch(() => {});
}
const openDebug = async (state) => {
  const button = state.page.locator('button[aria-label="Debug"]:visible').first();
  await button.click();
  await state.page.locator(".debug-panel").first().waitFor({ state: "visible", timeout: 20_000 });
};
const closeDebug = async (state) => {
  await state.page.locator('button[aria-label="Debug"]:visible').first().click();
  await state.page.locator(".debug-panel").first().waitFor({ state: "hidden", timeout: 20_000 });
};
const machineSection = (state) => state.page.evaluate((values) => {
  const holds = (node) => (node.innerText ?? "").includes("Machine load") && values.every((value) => (node.innerText ?? "").includes(value));
  const holders = [...document.querySelectorAll("*")].filter(holds);
  if (holders.length === 0) return null;
  const depth = (node) => { let level = 0; for (let current = node; current; current = current.parentElement) level += 1; return level; };
  let scope = holders.reduce((best, node) => (depth(node) > depth(best) ? node : best));
  const grid = document.querySelector(".debug-cols");
  // Every ancestor up to <html> holds the text: stop below the column grid (the owner answer).
  while (scope.parentElement && scope.parentElement !== grid && holds(scope.parentElement)) scope = scope.parentElement;
  const box = scope.getBoundingClientRect();
  const gridBox = grid?.getBoundingClientRect();
  const style = grid ? getComputedStyle(grid) : null;
  const innerLeft = gridBox && style ? gridBox.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth) : null;
  const innerRight = gridBox && style ? gridBox.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth) : null;
  return {
    found: true,
    inGrid: Boolean(grid?.contains(scope)),
    text: scope.innerText ?? "",
    left: box.left, right: box.right, top: box.top,
    gridLeft: innerLeft, gridRight: innerRight,
    panelWidth: document.querySelector(".debug-panel")?.getBoundingClientRect().width ?? null,
    columnBottoms: [...document.querySelectorAll(".debug-col")].map((column) => column.getBoundingClientRect().bottom),
  };
}, ML_VALUES);

async function scrollList(page, where) {
  await page.evaluate((target) => {
    const list = document.querySelector('[data-chat-focused="true"]') ?? document.querySelector(".scrollbar-subtle.overflow-y-auto");
    if (!list) throw new Error("no chat scroll list");
    if (target === "top") list.scrollTop = 0;
    else if (target === "bottom") list.scrollTop = list.scrollHeight;
    else list.scrollTop = Math.max(0, Math.floor((list.scrollHeight - list.clientHeight) / 2));
  }, where);
}
async function listAtBottom(page) {
  return page.evaluate(() => {
    const list = document.querySelector('[data-chat-focused="true"]') ?? document.querySelector(".scrollbar-subtle.overflow-y-auto");
    return Boolean(list) && list.scrollTop + list.clientHeight >= list.scrollHeight - 6;
  });
}
const floating = (page) => page.locator(".chat-scroll-to-bottom").first();
const forceReads = (state, since = 0) => state.requests.filter((request, index) => index >= since && request.startsWith(`/api/sessions/${SCROLL}?`) && request.includes("force=1")).length;
const forceIndex = (state) => state.requests.length;

// Polyforge config-page fixture (same shape as e2e/polyforge-config-layout.mjs).
const WS = `[workspace."${project}"]`;
const CONFIG = {
  pfPresent: true, pfVersion: "v2.20.11", capable: true, file: { sha256: "e2e-cli", exists: true }, mapped: true,
  daemonReachable: true, reload: { pending: [], overridden: [] }, workspaceFile: { sha256: "e2e-yaml", exists: true },
  items: [
    { key: "server", value: "http://127.0.0.1:1", source: "file", class: "restart-only" },
    { key: WS, value: "e2e-project", source: "file", class: "restart-only", section: true },
    { key: "step_timeout", value: "30m0s", source: "file", class: "live", schema: { kind: "duration" }, daemon: { value: "30m0s" } },
    { key: "stall_window", value: "10m0s", source: "file", class: "live", schema: { kind: "duration" }, daemon: { value: "10m0s" } },
  ],
  steps: [], steps_complete: true,
};
const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const configRoutes = [
  ["**/api/polyforge/config/history", (route) => route.fulfill(json({ entries: [] }))],
  ["**/api/polyforge/config?*", (route) => route.fulfill(json(CONFIG))],
  ["**/api/polyforge/detect*", (route) => route.fulfill(json({ pfPresent: true, pfVersion: "v2.20.11", pfVersionBelowMinimum: false, line: "internal", piSkillInstalled: true, piSkillEnabled: true, claudeSkillsSymlink: true, claudeSessionStartHook: true, daemon: { reachable: true } }))],
  ["**/api/plugins?*", (route) => route.fulfill(json({ packages: [{ scope: "global", packageName: "polyforge", source: "/opt/polyforge" }] }))],
];

// Polyforge Jobs fixture (drive the one card route the tab reads).
const GOAL = `E2E-GOAL-START-${"G".repeat(40)}-GOALTAIL`;
const JOBS = [
  { wi: "wi_E2E198A", slug: "task#9181", status: "running", stepAgeSec: 5, idleAgeSec: 1, candidate: "pi:e2e/model", spawnN: 1 },
  { wi: "wi_E2E198B", slug: "task#9182", status: "needs_input", stepAgeSec: 6, idleAgeSec: 2, candidate: "claude:e2e/model", spawnN: 1 },
];
const CARD = (job) => ({
  job, goal: job.status === "running" ? GOAL : "E2E-B-GOAL", startedAt: TS,
  steps: [], progress: { available: true, entries: Array.from({ length: 12 }, (_, index) => ({ id: `${job.wi}-${index}`, text: `NARRATION-${job.wi}-${index}` })) },
});
const OPS = { queue: { running: 2, max: 4 }, jobs: JOBS, tasks: { running: 0, completed: 0 } };
const jobsRoutes = [
  ["**/api/polyforge/status", (route) => route.fulfill(json({ pfPresent: true, status: OPS }))],
  ["**/api/polyforge/cards*", (route) => route.fulfill(json({ pfPresent: true, cards: JOBS.map(CARD) }))],
  ["**/api/polyforge/messages", (route) => route.fulfill(json({ pfPresent: true, capable: true, conversations: [], contacts: [] }))],
];
const jobsDock = (page) => page.locator("#polyforge-dock").or(page.getByRole("dialog", { name: /polyforge/i })).first();
async function openJobsDock(page) {
  const more = page.locator('[data-mobile-toolbar-more="true"]');
  const pf = page.getByRole("button", { name: /^(?!.*close).*polyforge/i }).first();
  if ((await pf.count()) === 0 && (await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
  if ((await pf.count()) === 0) throw new Error("Polyforge button not found");
  await pf.click();
  const dock = jobsDock(page);
  await dock.waitFor({ timeout: 20_000 });
  await page.locator("[data-pf-card-wi]").first().waitFor({ timeout: 30_000 });
  return dock;
}
const cardNode = (page, wi) => page.locator(`[data-pf-card-wi="${wi}"]`).first();
async function cardGeometry(page, wi, slug, statusText) {
  return cardNode(page, wi).evaluate((el, { slugText, status }) => {
    const leaf = (text) => [...el.querySelectorAll("*")].find((node) => node.children.length === 0 && (node.textContent ?? "").trim() === text) ?? null;
    const box = (node) => { const r = node?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null; };
    const style = getComputedStyle(el);
    const contentRight = el.getBoundingClientRect().right - parseFloat(style.paddingRight);
    const slugNode = leaf(slugText);
    // a running card's status label is `Running <n>m`, so the
    // status element is matched by its prefix.
    const statusNode = [...el.querySelectorAll("*")].find((node) => node.children.length === 0 && (node.textContent ?? "").trim().startsWith(status)) ?? null;
    const goalNode = [...el.querySelectorAll("[title]")].find((node) => (node.getAttribute("title") ?? "").startsWith("E2E-")) ?? null;
    let progress = null;
    for (const child of [el, ...el.querySelectorAll("*")]) {
      const s = getComputedStyle(child);
      if (/(auto|scroll)/.test(s.overflowY) && child.scrollHeight > child.clientHeight + 8) {
        progress = { height: child.clientHeight, scrollHeight: child.scrollHeight };
        break;
      }
    }
    return { card: box(el), contentRight, slug: box(slugNode), status: box(statusNode), goal: box(goalNode), progress };
  }, { slugText: slug, status: statusText });
}

try {
  const started = await startNextServer({
    name: "ui-polish-198",
    logFile: join(work, "server.log"),
    env: {
      ...process.env,
      HOME: work,
      PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_PASSWORD: "",
      NEXT_TELEMETRY_DISABLED: "1",
      PI_WEB_ALLOWED_ROOT_PREFIXES: work,
      PI_WEB_DIST_DIR: process.env.PI_WEB_DIST_DIR,
    },
  });
  base = started.base;
  stop = started.stop;
  browser = await chromium.launch();

  // Warm the fixture page once so the per-scenario waits do not pay a cold compile.
  {
    const warm = await openPage();
    await closePage(warm);
  }

  // S1 — spec Req 1 / AC 1: the Session-info popover no longer carries machine load.
  await check("S1", "Session-info popover renders no machine load and issues no request", async () => {
    const state = await openPage({ session: MAIN, marker: "E2E ui polish reply" });
    try {
      const before = state.mlHits;
      await state.page.getByRole("button", { name: /^(Session info|会话信息)$/ }).first().click();
      await state.page.locator(".session-info-popover").first().waitFor({ state: "visible", timeout: 20_000 });
      await state.page.evaluate(async (url) => { await fetch(url, { cache: "no-store" }); }, BARRIER);
      assert.equal(state.mlHits, before, `opening the popover issued /api/machine-load (${state.mlHits - before})`);
      const popover = await state.page.locator(".session-info-popover").first().innerText();
      assert.ok(!popover.includes("Machine load"), "the popover still has a Machine load heading");
      // The bare cores value "8" is skipped: the popover's session path (/tmp/pi-web-ui-polish-198-…) holds an 8.
      for (const value of ML_VALUES.filter((item) => item !== ML.cores)) assert.ok(!popover.includes(value), `the popover still renders ${value}`);
    } finally { await closePage(state); }
  });

  // S2 — spec Req 2 / AC 2: last grid area of `.debug-cols`, full width at all three layouts.
  await check("S2", "Debug machine load is the last full-width .debug-cols row at wide, <=1239 and <=760", async () => {
    const state = await openPage({ session: MAIN, marker: "E2E ui polish reply" });
    try {
      await openDebug(state);
      await waitFor(() => state.mlHits >= 1, "the Debug panel's first machine-load request");
      await waitFor(async () => (await machineSection(state))?.text.includes(ML.memory), "the section's values");
      const widths = [];
      // 1600px: with the 260px sidebar a 1440px viewport leaves a 1180px (<=1239) panel.
      for (const width of [1600, 1100, 700]) {
        await state.page.setViewportSize({ width, height: 900 });
        await state.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const section = await machineSection(state);
        assert.ok(section, `no Machine load section at ${width}px`);
        assert.ok(section.inGrid, `at ${width}px the section is outside .debug-cols`);
        assert.ok(Math.abs(section.left - section.gridLeft) <= 1, `at ${width}px left edge ${section.left} is not on the grid edge ${section.gridLeft}`);
        assert.ok(Math.abs(section.right - section.gridRight) <= 1, `at ${width}px right edge ${section.right} is not on the grid edge ${section.gridRight}`);
        assert.ok(section.columnBottoms.length >= 1, `at ${width}px no other column is rendered`);
        assert.ok(section.columnBottoms.every((bottom) => section.top >= bottom - 1), `at ${width}px the section's top ${section.top} is above a column bottom ${Math.max(...section.columnBottoms)}`);
        widths.push({ width, panel: Math.round(section.panelWidth) });
      }
      assert.ok(widths[0].panel > 1239, `the wide case measured ${widths[0].panel}px, not above the 1239 breakpoint: ${JSON.stringify(widths)}`);
      assert.ok(widths[1].panel <= 1239 && widths[1].panel > 760, `the middle case measured ${widths[1].panel}px, not 761..1239: ${JSON.stringify(widths)}`);
      assert.ok(widths[2].panel <= 760, `the narrow case measured ${widths[2].panel}px, not <=760: ${JSON.stringify(widths)}`);
    } finally { await closePage(state); }
  });

  // S3 — spec Req 3 / AC 3: the moved Debug mount keeps one fetch on open, a 2 s
  // tick, zero closed requests, last-good on a failed tick and one refetch on reopen.
  await check("S3", "Machine-load polling survives the move: open, tick, closed, failed tick, reopen", async () => {
    const state = await openPage({ session: MAIN, marker: "E2E ui polish reply", clock: true });
    try {
      await openDebug(state);
      await waitFor(() => state.mlHits === 1, "exactly one request on open");
      await waitFor(async () => (await machineSection(state))?.inGrid, "the moved section inside .debug-cols");
      await waitFor(async () => (await machineSection(state))?.text.includes(ML.memory), "the first values");
      await state.page.clock.runFor(2000);
      await waitFor(() => state.mlHits === 2, "one request per 2 s tick");
      const good = (await machineSection(state)).text;
      state.mlMode = "null-metrics";
      await state.page.clock.runFor(2000);
      await waitFor(() => state.mlHits === 3, "the failed tick's request");
      assert.equal((await machineSection(state)).text, good, "a failed tick flashed a placeholder instead of keeping the last good values");
      await closeDebug(state);
      const closed = state.mlHits;
      await state.page.clock.runFor(6000);
      assert.equal(state.mlHits, closed, `a closed panel issued ${state.mlHits - closed} request(s) over three ticks`);
      state.mlMode = "ok";
      await openDebug(state);
      await waitFor(() => state.mlHits === closed + 1, "exactly one immediate request on reopen");
    } finally { await closePage(state); }
  });

  // S4 — spec Req 4 / AC 4: no ↻ in the desktop top bar, phone toolbar or More overlay.
  await check("S4", "No manual-fetch control remains in the toolbar or the phone More overlay", async () => {
    const toolbarRefresh = (page) => page.evaluate(() => {
      const isVisible = (el) => Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      const text = (el) => `${el.innerText ?? ""} ${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`;
      const stats = document.querySelector('button[data-mobile-toolbar-stats="true"]')
        ?? [...document.querySelectorAll("button")].find((b) => /Session info|会话信息/.test(b.getAttribute("aria-label") ?? ""));
      let scope = stats;
      for (let depth = 0; scope && depth < 4; depth += 1) {
        // The chat's floating button (the spec's ↻ at the tail) is not a toolbar control.
        const found = [...scope.querySelectorAll("button")].filter((b) => b !== stats && isVisible(b) && !b.classList.contains("chat-scroll-to-bottom")).find((b) => /↻|⟳|Fetch latest|刷新最新|刷新|拉取/.test(text(b)));
        if (found) return text(found).trim();
        scope = scope.parentElement;
      }
      return null;
    });
    const desktop = await openPage({ session: MAIN });
    try {
      assert.equal(await toolbarRefresh(desktop.page), null, "the desktop top bar still offers a manual-fetch control");
    } finally { await closePage(desktop); }
    const phone = await openPage({ session: MAIN, viewport: { width: 390, height: 844 } });
    try {
      assert.equal(await toolbarRefresh(phone.page), null, "the phone toolbar still offers a manual-fetch control");
      const more = phone.page.locator('[data-mobile-toolbar-more="true"]');
      if (await more.count()) {
        if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
        // The same exclusion as the toolbar search: the chat's floating ↻ is not an overlay control.
        const overlayText = await phone.page.evaluate(() => {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const texts = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.parentElement?.closest(".chat-scroll-to-bottom")) texts.push(node.textContent ?? "");
          }
          return texts.join(" ");
        });
        assert.ok(!/↻|⟳/.test(overlayText), "the phone More overlay still renders a manual-fetch glyph");
      }
    } finally { await closePage(phone); }
  });

  // S5 — spec Req 5 / AC 5: one floating button, two forms by scroll position.
  await check("S5", "Floating button is refresh at the tail and scroll-to-bottom when scrolled up", async () => {
    const state = await openPage({ session: SCROLL, marker: "SCROLL message 159", viewport: { width: 1280, height: 800 } });
    try {
      await scrollList(state.page, "bottom");
      const button = floating(state.page);
      await button.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await button.getAttribute("aria-label"), "Fetch latest", "at the tail the floating button is not the refresh form");
      const first = forceIndex(state);
      await button.click();
      await waitFor(() => forceReads(state, first) === 1, "one forced fresh read from the floating refresh form");
      await waitFor(() => listAtBottom(state.page), "the list stayed at the bottom after the fetch");
      // The page's own post-load forced read (refreshFromDisk) is not the ↓ form's: wait until forced reads are stable for 2 s.
      let stableCount = forceReads(state);
      let stableSince = Date.now();
      await waitFor(() => {
        const current = forceReads(state);
        if (current !== stableCount) { stableCount = current; stableSince = Date.now(); }
        return Date.now() - stableSince >= 2000;
      }, "forced reads settled for 2 s");
      await scrollList(state.page, "middle");
      await waitFor(async () => (await button.getAttribute("aria-label")) === "Scroll to latest", "the scrolled-up form is scroll-to-latest");
      const beforeScroll = forceIndex(state);
      await button.click();
      await waitFor(() => listAtBottom(state.page), "the scroll form reached the bottom");
      await waitFor(async () => (await button.getAttribute("aria-label")) === "Fetch latest", "the button did not become the refresh form at the bottom");
      assert.equal(forceReads(state, beforeScroll), 0, "the scroll-to-bottom form performed a fetch");
    } finally { await closePage(state); }
  });

  // S6 — spec Req 6 / AC 6: the refresh form spins busy, joins an in-flight
  // fetch on a re-click and stays at the bottom.
  await check("S6", "Floating refresh shows busy, joins a re-click into one fetch and one notice", async () => {
    const state = await openPage({ session: SCROLL, marker: "SCROLL message 159", viewport: { width: 1280, height: 800 } });
    try {
      await state.page.route(/\/api\/sessions\/[^/]+\?.*force=1/, async (route) => { await delay(1200); await route.continue().catch(() => {}); });
      await scrollList(state.page, "bottom");
      const button = floating(state.page);
      await button.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await button.getAttribute("aria-label"), "Fetch latest", "the refresh form is missing at the tail");
      const first = forceIndex(state);
      await button.click();
      await waitFor(async () => (await button.getAttribute("aria-busy")) === "true", "the busy state (aria-busy)");
      const busyText = `${await button.innerText()} ${await button.getAttribute("aria-label")}`;
      assert.match(busyText, /Fetching latest|正在拉取|正在擷取/, "the busy label is missing");
      await button.click();
      await waitFor(() => forceReads(state, first) === 1, "a re-click issued a second forced read");
      await waitFor(async () => (await button.getAttribute("aria-busy")) !== "true", "the busy state did not clear");
      const notices = await state.page.locator(".notice-shelf-item").evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()));
      assert.equal(notices.filter((notice) => /Already up to date|Updated to|Fetch failed/.test(notice)).length, 1, `expected exactly one fetch notice, got ${JSON.stringify(notices)}`);
      assert.ok(await listAtBottom(state.page), "the fetch left the reader away from the newest message");
    } finally { await closePage(state); }
  });

  // S7 — spec Req 7 / AC 7: at <=640px key and class badge share one row, values below.
  await check("S7", "At <=640px the config class badge shares the key's row and values span below", async () => {
    const state = await openPage({ session: MAIN, marker: "E2E ui polish reply", viewport: { width: 1100, height: 980 }, routes: configRoutes });
    try {
      const { page } = state;
      const show = page.getByRole("button", { name: "Show sidebar", exact: true });
      if (await visible(show)) await show.click();
      await page.getByRole("button", { name: "Settings", exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
      await dialog.getByRole("button", { name: "Polyforge", exact: true }).click();
      await dialog.locator('[aria-label="cli.toml · [daemon]"]').first().waitFor({ state: "attached", timeout: 30_000 });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".polyforge-config-row")];
        const row = rows.find((node) => (node.querySelector(".polyforge-config-key")?.textContent ?? "").trim() === "step_timeout");
        if (!row) return null;
        const rect = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
        const style = getComputedStyle(row);
        const contentLeft = row.getBoundingClientRect().left + parseFloat(style.paddingLeft);
        const contentRight = row.getBoundingClientRect().right - parseFloat(style.paddingRight);
        return {
          key: rect(row.querySelector(".polyforge-config-key")),
          badge: rect(row.querySelector(".polyforge-config-class .polyforge-config-badge")),
          file: rect(row.querySelector(".polyforge-config-file")),
          daemon: rect(row.querySelector(".polyforge-config-daemon")),
          contentLeft, contentRight,
        };
      });
      assert.ok(geometry, "the badged daemon row did not render");
      const { key, badge, file, daemon, contentLeft, contentRight } = geometry;
      assert.ok(Math.abs(badge.top - key.top) <= 2, `the badge is not on the key's row (key ${key.top}, badge ${badge.top})`);
      assert.ok(Math.abs(badge.right - contentRight) <= 1, `the badge is not right-aligned (badge ${badge.right}, row ${contentRight})`);
      assert.ok(key.left < badge.left, "the key is not left of the badge");
      assert.ok(file.top >= Math.max(key.bottom, badge.bottom) - 1, "the file value is not below the key/badge row");
      assert.ok(Math.abs(file.width - (contentRight - contentLeft)) <= 1, `the file value does not span the row (${file.width} vs ${contentRight - contentLeft})`);
      assert.ok(daemon.top >= Math.max(key.bottom, badge.bottom) - 1, "the daemon value is not below the key/badge row");
      assert.ok(Math.abs(daemon.width - (contentRight - contentLeft)) <= 1, `the daemon value does not span the row (${daemon.width} vs ${contentRight - contentLeft})`);
    } finally { await closePage(state); }
  });

  // S8 — spec Req 8 / AC 8: the Jobs cards are one row of fixed 150px cards.
  // owner 有意变更: the shared Jobs/Tasks minimum is
  // 150px (was 160px). owner 有意变更 the Jobs stream is one
  // horizontally scrolling row, so the two cards share one row at every width
  // (they were two columns at 460/375 and stacked at 340) and the row scrolls
  // once the cards no longer fit (the 340px dock).
  await check("S8", "Jobs cards are one row of fixed 150px cards at 460/375/340", async () => {
    const cases = [
      [{ width: 460, storage: { "pi-web:polyforge-dock-width": "460" } }, "460 dock", false],
      [{ width: 375, storage: {} }, "375 sheet", false],
      [{ width: 340, storage: { "pi-web:polyforge-dock-width": "340" } }, "340 dock", true],
    ];
    for (const [opts, label, overflows] of cases) {
      const state = await openPage({ session: MAIN, marker: "E2E ui polish reply", viewport: { width: opts.width, height: 800 }, storage: opts.storage, routes: jobsRoutes });
      try {
        await openJobsDock(state.page);
        const measured = await state.page.evaluate(() => {
          const card = document.querySelector("[data-pf-card-wi]");
          const row = card?.parentElement;
          if (!row) return null;
          const style = getComputedStyle(row);
          const cards = [...row.querySelectorAll("[data-pf-card-wi]")].map((node) => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), width: r.width }; });
          return { cards, width: row.getBoundingClientRect().width, clientWidth: row.clientWidth, scrollWidth: row.scrollWidth,
            overflowX: style.overflowX, scrollbarWidth: style.scrollbarWidth };
        });
        assert.ok(measured, `${label}: the card row did not render`);
        assert.equal(measured.cards.length, 2, `${label}: expected two cards`);
        const rows = new Set(measured.cards.map((card) => card.top));
        assert.equal(rows.size, 1, `${label}: the cards share one row (${JSON.stringify(measured.cards)})`);
        assert.ok(measured.cards.every((card) => Math.abs(card.width - 150) <= 0.5),
          `${label}: each card is a fixed 150px wide (${JSON.stringify(measured.cards.map((card) => card.width))})`);
        assert.ok(measured.cards[1].left - (measured.cards[0].left + measured.cards[0].width) >= 6,
          `${label}: the two cards keep the 8px gap (${JSON.stringify(measured.cards)})`);
        assert.equal(measured.overflowX, "auto", `${label}: the card row scrolls horizontally (${measured.overflowX})`);
        assert.equal(measured.scrollbarWidth, "thin", `${label}: the row's scrollbar stays visible but thin (${measured.scrollbarWidth})`);
        if (overflows) assert.ok(measured.scrollWidth > measured.clientWidth,
          `${label}: two 150px cards exceed the ${measured.clientWidth}px row and it scrolls (${measured.scrollWidth})`);
        else assert.ok(measured.scrollWidth <= measured.clientWidth,
          `${label}: two 150px cards fit the ${measured.clientWidth}px row with free space at the right (${measured.scrollWidth})`);
      } finally { await closePage(state); }
    }
  });

  // S9 — spec Req 9 / AC 10: status on the title row's right end. owner 有意变更
  // (reverses the 32px narration): the card has no
  // progress region any more.
  await check("S9", "Jobs card status shares the slug row at the right and has no progress region", async () => {
    const state = await openPage({ session: MAIN, marker: "E2E ui polish reply", viewport: { width: 460, height: 800 }, storage: { "pi-web:polyforge-dock-width": "460" }, routes: jobsRoutes });
    try {
      await openJobsDock(state.page);
      const running = await cardGeometry(state.page, "wi_E2E198A", "task#9181", "Running");
      assert.ok(running.slug && running.status && running.goal, "the running card's slug, status and goal did not render");
      assert.ok(Math.abs(running.status.top - running.slug.top) <= 2, `status is not on the slug's row (slug ${running.slug.top}, status ${running.status.top})`);
      assert.ok(Math.abs(running.status.right - running.contentRight) <= 2, `status is not at the card's right edge (${running.status.right} vs ${running.contentRight})`);
      assert.ok(running.status.left > running.slug.left, "status is not right of the slug");
      assert.ok(running.goal.top >= Math.max(running.slug.bottom, running.status.bottom) - 1, "the goal is not below slug and status");
      // owner 有意变更 (reverses the 32px narration):
      // nothing in the card scrolls on its own — the narration area is gone.
      assert.equal(running.progress, null, "the running card has no progress region");
      const needs = await cardGeometry(state.page, "wi_E2E198B", "task#9182", "Needs input");
      assert.ok(needs.slug && needs.status, "the needs_input card's slug and badge did not render");
      assert.ok(Math.abs(needs.status.top - needs.slug.top) <= 2, `the needs_input badge is not on the slug's row (slug ${needs.slug.top}, badge ${needs.status.top})`);
      assert.ok(await state.page.locator('[data-pf-card-wi="wi_E2E198B"] [data-pf-needs-input]').count() === 1, "the needs_input badge lost its emphasized form");
    } finally { await closePage(state); }
  });

  // S10 — spec Req 10 / AC 14: the card is strictly shorter than the 4b000b22
  // measurement, taken with this fixture and viewport (see the constant above).
  await check("S10", "Jobs card is shorter than the 4b000b22 baseline measured with the same fixture", async () => {
    const state = await openPage({ session: MAIN, marker: "E2E ui polish reply", viewport: { width: 460, height: 800 }, storage: { "pi-web:polyforge-dock-width": "460" }, routes: jobsRoutes });
    try {
      await openJobsDock(state.page);
      const height = await cardNode(state.page, "wi_E2E198A").evaluate((node) => node.getBoundingClientRect().height);
      assert.ok(CARD_HEIGHT_BASE_460 > 0, "the 4b000b22 card-height baseline constant is not set");
      assert.ok(height <= CARD_HEIGHT_BASE_460 - 4, `the card is ${height.toFixed(1)}px, not strictly shorter than the ${CARD_HEIGHT_BASE_460}px 4b000b22 baseline`);
    } finally { await closePage(state); }
  });

  // S12 — spec scenario "Each split pane acts on its own session" (added per
  // the owner answer): with two panes on two different
  // saved sessions, the right pane's floating refresh reads only the right
  // session (one forced read) and nothing happens in the left pane.
  await check("S12", "Each split pane's floating refresh acts only on its own session", async () => {
    const state = await openPage({ session: SCROLL, marker: "SCROLL message 159", viewport: { width: 2560, height: 1200 }, storage: { "pi-web:split-view-enabled": "true", "pi-chat-content-width": "820" } });
    try {
      const { page } = state;
      const paneArea = page.locator("[data-split-pane-area]");
      const panes = paneArea.locator("> div");
      await page.locator('[title="RIGHT message 000"]').first().click();
      await waitFor(async () => (await panes.count()) === 2, "a second split pane opened for the right session");
      const left = panes.nth(0);
      const right = panes.nth(1);
      await left.getByText("SCROLL message 159", { exact: true }).first().waitFor({ state: "attached" });
      await right.getByText("RIGHT message 159", { exact: true }).first().waitFor({ state: "attached" });
      for (const pane of [left, right]) {
        await pane.evaluate((node) => {
          const list = node.querySelector(".scrollbar-subtle.overflow-y-auto");
          if (!list) throw new Error("no chat scroll list in the pane");
          list.scrollTop = list.scrollHeight;
        });
      }
      const rightButton = right.locator(".chat-scroll-to-bottom").first();
      await rightButton.waitFor({ state: "visible", timeout: 20_000 });
      assert.equal(await rightButton.getAttribute("aria-label"), "Fetch latest", "the right pane's floating button is not the refresh form at the tail");
      // The page's own post-load forced reads are not the button's: wait until they are stable for 2 s.
      const allForced = () => state.requests.filter((request) => request.startsWith("/api/sessions/") && request.includes("force=1")).length;
      let stableCount = allForced();
      let stableSince = Date.now();
      await waitFor(() => {
        const current = allForced();
        if (current !== stableCount) { stableCount = current; stableSince = Date.now(); }
        return Date.now() - stableSince >= 2000;
      }, "forced reads settled for 2 s");
      const fetchNotices = (pane) => pane.locator(".notice-shelf-item").evaluateAll((nodes) => nodes.map((node) => node.innerText.trim()).filter((text) => /Already up to date|Updated to|Fetch failed/.test(text)));
      const leftNoticesBefore = (await fetchNotices(left)).length;
      const since = forceIndex(state);
      const forcedFor = (id) => state.requests.filter((request, index) => index >= since && request.startsWith(`/api/sessions/${id}?`) && request.includes("force=1")).length;
      await rightButton.click();
      await waitFor(async () => (await fetchNotices(right)).length === 1, "the right pane shows its fetch notice");
      await delay(1500);
      assert.equal(forcedFor(RIGHT), 1, "the right pane's refresh did not issue exactly one forced read of the right session");
      assert.equal(forcedFor(SCROLL), 0, "the right pane's refresh read the left pane's session");
      assert.equal(allForced() - stableCount, 1, "the right pane's refresh issued forced reads beyond its own session");
      assert.equal((await fetchNotices(left)).length, leftNoticesBefore, "a fetch notice appeared in the left pane");
    } finally { await closePage(state); }
  });
} catch (error) {
  failures.push("suite");
  console.error(`FAIL suite: ${String(error?.stack ?? error)}`);
} finally {
  for (const context of [...openContexts]) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await stop();
  console.log(`\n${failures.length ? `FAILED ${failures.join(", ")}` : "PASS all authored UI-polish scenarios"}`);
  console.log(`server log: ${join(work, "server.log")}`);
}
if (failures.length) process.exitCode = 1;
