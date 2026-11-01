// — the Work panel's third, read-only 工单列表 sub-tab.
//
// Authored pre-code against artifacts/spec.md (Requirements 1–11) and
// artifacts/plan.md; Requirement 12 (real-data reconciliation) is carried by
// the capsule-only replay documented in artifacts/e2e-scenarios.md because it
// needs the owner-captured snapshots, which never enter this repository.
//
// The suite starts its own `next dev` on a stub `pf` whose merged `queue` and
// `file show` answers copy the real field shapes (content, attrs, project_id,
// parent_id, seq, session_* included). Every pf argv is appended to a ledger,
// so the one-read and one-detail-read disciplines are asserted, not assumed.
//
// Baseline posture: the pre-change tree has no third sub-tab and no work-items
// routes, so every kept scenario is assertion-level RED. A passing scenario
// prints its binding marker `PASS S203-<n>`.
//
//   node e2e/polyforge-work-items-203.mjs
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startNextServer } from "./next-server.mjs";
import { COLD_MS, NAV_MS } from "./timeouts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const distDir = process.env.PI_WEB_DIST_DIR || ".next/e2e/polyforge-work-items-203";
assert.ok(!existsSync(join(root, distDir, "dev/lock")), "Run in a checkout without an active dev server");
rmSync(join(root, distDir), { force: true, recursive: true });

const work = mkdtempSync(join(tmpdir(), "pi-web-pf-items-e2e-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
const SESSION = "e2e-pf-items-session";
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project);
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), [
  { type: "session", version: 3, id: SESSION, timestamp: "2026-10-31T00:00:00.000Z", cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: "2026-10-31T00:00:00.000Z", message: { role: "user", content: "E2E pf items host session" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

// ---- fixtures: real pf queue/file-show field shapes plus dropped sentinels ----
const CONTENT_SENTINEL = "CONTENT-SENTINEL-203";
const ATTRS_SENTINEL = "ATTRS-SENTINEL-203";
const PROJECT_ID = "prj_SENTINEL_203";
const PARENT_ID = "wi_PARENT_SENTINEL_203";
const SESSION_SENTINEL = "SESSION-SENTINEL-203";
const REPO_SENTINEL = "REPO-SENTINEL-203";
const LABEL_SENTINEL = "LABEL-SENTINEL-203";
const at = (minute) => new Date(Date.UTC(2026, 9, 31, 0, minute)).toISOString();
const item = (n, projectName, status, minute, goal, extra = {}) => ({
  id: `wi_203E2E${String(n).padStart(4, "0")}`, slug: `${projectName}-p${String(n).padStart(4, "0")}`,
  project: projectName, status, priority: n % 2 ? "high" : "normal", bundle_name: n % 3 ? null : `feature-${n}`,
  goal, created_at: at(minute), content: `${CONTENT_SENTINEL} body ${n}`, attrs: { sentinel: ATTRS_SENTINEL },
  project_id: PROJECT_ID, parent_id: PARENT_ID, seq: n, clean_pause: false, repo_inventory: [REPO_SENTINEL],
  waiting_on: null, waiting_for: n === 2 ? [{ slug: "acme#1", status: "queued" }] : undefined,
  session_fingerprint: SESSION_SENTINEL, session_machine: "MACHINE-SENTINEL-203", session_started_at: at(minute),
  labels: [LABEL_SENTINEL], milestone: "MILESTONE-203", reporter: "alice", assignee: "bob",
  updated_at: at(minute), closed_at: null, ...extra,
});
const baseItems = () => [
  item(1, "workbench", "wrapped", 1, "GOAL-A wraps an old ticket"),
  item(2, "polyforge", "running", 2, "GOAL-B is running now"),
  item(3, "workbench", "queued", 3, "GOAL-C waits in the queue"),
  item(4, "acme", "failed", 4, "GOAL-D failed yesterday"),
  item(5, "workbench", "canceled", 5, "GOAL-E was canceled"),
  item(6, "polyforge", "paused", 6, "GOAL-F is paused"),
  item(7, "acme", "blocked", 7, "GOAL-G is blocked"),
];
const manyItems = () => Array.from({ length: 1162 }, (_, i) => {
  const projectName = i % 2 ? "acme" : "workbench";
  return item(1000 + i, projectName, i % 5 ? "wrapped" : "running", 0, `PERF-GOAL-${String(i + 1).padStart(4, "0")}`,
    { id: `wi_PERF${String(i + 1).padStart(4, "0")}`, slug: `${projectName}-perf-${String(i + 1).padStart(4, "0")}` });
});
const capItems = () => [
  ...Array.from({ length: 500 }, (_, i) => item(2000 + i, "acme", "wrapped", 0, `CAP-GOAL-${String(i + 1).padStart(3, "0")}`,
    { id: `wi_CAP${String(i + 1).padStart(4, "0")}`, slug: `internal-cap-${String(i + 1).padStart(4, "0")}` })),
  item(3001, "workbench", "running", 1, "CAP-WORKBENCH-ONE", { id: "wi_CAP9001", slug: "workbench-cap-1" }),
  item(3002, "polyforge", "queued", 2, "CAP-POLYFORGE-ONE", { id: "wi_CAP9002", slug: "polyforge-cap-1" }),
];
const longContent = "x".repeat(300_000) + "\nE2E-TAIL-AFTER-CAP";
const detail = (content = "Detail body of") => ({
  ...item(2, "polyforge", "running", 2, "GOAL-B is running now"),
  content, content_len: Buffer.byteLength(content, "utf8"),
  waiting_for: [{ slug: "acme#1", status: "queued" }], waiting_on: null,
  labels: [LABEL_SENTINEL], milestone: "MILESTONE-203", reporter: "alice", assignee: "bob", updated_at: at(2), closed_at: null,
});
const passportItems = () => [
  item(11, "workbench", "wrapped", 11, "PASSPORT-KEEP", { id: "wi_PASS0001", slug: "workbench-pass-1" }),
  item(12, "polyforge", "running", 12, "PASSPORT-DEGRADE", { id: "wi_PASS0002", slug: "polyforge-pass-2",
    goal: 42, created_at: 1234, status: null, bundle_name: { bad: true } }),
  item(13, "workbench", "queued", 13, "PASSPORT-BAD-SLUG", { id: "wi_PASS0003", slug: 13 }),
  item(14, "acme", "failed", 14, "PASSPORT-BAD-ID", { id: "not-a-work-item", slug: "internal-pass-4" }),
];

// ---- stub pf ----
const stubDir = join(work, "stub-bin");
mkdirSync(stubDir);
const stateFile = join(stubDir, "state.json");
const argvLog = join(stubDir, "argv.log");
const fixture = (patch = {}) => ({
  version: "v2.20.13", mode: "ok", detailMode: "ok", ws: project,
  queue: { running: 2, max_concurrent: 6 }, jobs: [],
  items: baseItems(), total: 7, detail: detail(), ...patch,
});
const seed = (patch = {}) => { writeFileSync(stateFile, JSON.stringify(fixture(patch))); writeFileSync(argvLog, ""); };
writeFileSync(join(stubDir, "pf"), `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const dir = path.dirname(fs.realpathSync(__filename)); const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
const s = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const out = (v) => { const b = Buffer.from(JSON.stringify(v) + "\\n"); let o = 0;
  while (o < b.length) { try { o += fs.writeSync(1, b, o); } catch (e) { if (e.code !== "EAGAIN") throw e; } } process.exit(0); };
if (args.includes("--version")) { process.stdout.write(s.version + "\\n"); process.exit(0); }
const rest = args.filter((a) => a !== "--json");
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
if (rest[0] === "ops" && rest[1] === "status") out({ machine_id: "m-e2e", workspaces: [s.ws], jobs: s.jobs, queue: s.queue, tasks: { running: 0, completed: 0 } });
if (rest[0] === "config" && rest[1] === "workspace") out(flag("--cwd") === s.ws ? { mapped: true, workspace: s.ws } : { mapped: false, workspace: null });
if (rest[0] === "config" && rest[1] === "list") out({ items: [{ key: "user_id", value: "u_e2e", source: "file" }] });
if (rest[0] === "msg" && rest[1] === "list") out({ conversations: [] });
if (rest[0] === "msg" && rest[1] === "contacts") out({ contacts: [] });
if (rest[0] === "recall") out({ items: [], total: 0 });
if (rest[0] === "task" && rest[1] === "list") out({ tasks: [], now: new Date().toISOString() });
if (rest[0] === "queue") {
  if (s.mode === "fail") { process.stderr.write("queue: project acme: do-not-show-half-the-table\\n"); process.exit(1); }
  if (s.mode === "nomap") { process.stderr.write("pf: no [workspace] mapping for this directory\\n"); process.exit(1); }
  if (s.mode === "malformed") { process.stdout.write("not a decodable queue document\\n"); process.exit(0); }
  out(s.total === null ? { items: s.items } : { items: s.items, total: s.total });
}
if (rest[0] === "file" && rest[1] === "show") {
  if (s.detailMode === "fail") { process.stderr.write("file show: daemon refused\\n"); process.exit(1); }
  out(s.detail);
}
process.stderr.write("pf: unknown command\\n"); process.exit(2);
`);
chmodSync(join(stubDir, "pf"), 0o755);
const calls = () => readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).filter((a) => a !== "--json"));
const queues = () => calls().filter((a) => a[0] === "queue");
const fileShows = () => calls().filter((a) => a[0] === "file" && a[1] === "show");
const itemVerbs = () => queues().length + fileShows().length;
const absentPath = (process.env.PATH || "").split(delimiter).map((dir, n) => {
  if (!existsSync(join(dir, "pf"))) return dir;
  const farm = join(work, `nopf-${n}`); mkdirSync(farm);
  for (const name of readdirSync(dir)) if (name !== "pf") symlinkSync(join(dir, name), join(farm, name));
  return farm;
}).join(delimiter);
const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
// ---- scenario bookkeeping and page helpers ----
const failures = [];
async function check(id, fn) {
  try { await fn(); console.log(`PASS ${id}`); }
  catch (error) { failures.push(id); console.log(`FAIL ${id}: ${String(error?.message ?? error).split("\n")[0]}`); }
}
const RE_WORK = /工单|工單|work/i, RE_TASKS = /任务|任務|tasks/i, RE_ITEMS = /工单列表|工單列表|work items/i;
const BARRIER = "/__e2e_request_barrier";
const errors = [];
let browser; let base; let stop = async () => {};
const dock = (page) => page.locator("#polyforge-dock").or(page.getByRole("dialog", { name: /polyforge/i })).first();
const pfButton = (page) => page.getByRole("button", { name: /^(?!.*close).*polyforge/i }).first();
const topTab = (page, re) => dock(page).locator('[data-pf-tabstrip="top"] [role="tab"]').filter({ hasText: re }).first();
const segments = (page) => dock(page).locator('[data-pf-tabstrip="work"] [role="tab"]');
const segment = (page, re) => segments(page).filter({ hasText: re }).first();
const optionTexts = (select) => select.locator("option").allInnerTexts().then((rows) => rows.map((row) => row.trim()));
const optionValues = (select) => select.locator("option").evaluateAll((rows) => rows.map((row) => row.value));
const selectedLabel = (select) => select.evaluate((el) => el.options[el.selectedIndex]?.textContent.trim() ?? "");
const row = (panel, text) => panel.getByText(text, { exact: true }).first();
const rowButton = (panel, text) => panel.getByRole("button").filter({ hasText: text }).first();
async function findSelect(panel, firstOption) {
  const selects = panel.getByRole("combobox");
  for (let index = 0; index < await selects.count(); index += 1) {
    if ((await optionTexts(selects.nth(index)))[0] === firstOption) return selects.nth(index);
  }
  return null;
}
async function openPage(opts = {}) {
  const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 }, locale: opts.locale ?? "zh-CN" });
  await context.addInitScript((locale) => {
    try { localStorage.setItem("pi-web:split-view-enabled", "false"); localStorage.setItem("pi-locale", locale); } catch { /* storage unavailable */ }
  }, opts.locale ?? "zh-CN");
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.__pf = [];
  await page.route((url) => url.pathname === BARRIER, (route) => route.fulfill({ status: 204 }));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/polyforge/")) page.__pf.push(url.pathname);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
  page.on("response", (response) => { if (response.url().startsWith(base) && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded", timeout: opts.warm ? COLD_MS : NAV_MS });
  await page.getByText("E2E pf items host session").first().waitFor({ state: "attached", timeout: opts.warm ? COLD_MS : NAV_MS });
  return page;
}
const withPage = async (opts, fn) => { const page = await openPage(opts); try { return await fn(page); } finally { await page.context().close(); } };
async function waitFor(fn, label, ms = 20_000) {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) { try { last = await fn(); if (last) return last; } catch (error) { last = error.message; } await delay(200); }
  throw new Error(`${label} (last: ${last})`);
}
async function openDock(page) {
  if ((await dock(page).count()) > 0 && await dock(page).isVisible().catch(() => false)) return dock(page);
  const more = page.locator('[data-mobile-toolbar-more="true"]');
  if ((await pfButton(page).count()) === 0 && (await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await pfButton(page).click(); await dock(page).waitFor({ timeout: 20_000 }); return dock(page);
}
async function openWork(page) {
  await openDock(page);
  await waitFor(async () => (await topTab(page, RE_WORK).count()) > 0, "a Work top-level tab exists", 20_000);
  await topTab(page, RE_WORK).click();
  await waitFor(async () => (await segments(page).count()) >= 2, "the Work sub-tab segments exist", 15_000);
  return dock(page);
}
const requestBarrier = (page) => page.evaluate(async (url) => { await fetch(url, { cache: "no-store" }); }, BARRIER);
const statusPolls = (page) => page.__pf.filter((pathname) => pathname === "/api/polyforge/status").length;
const listRequests = (page) => page.__pf.filter((pathname) => pathname === "/api/polyforge/work-items").length;
async function afterStatusPolls(page, n, label) {
  const seen = statusPolls(page);
  await waitFor(() => statusPolls(page) >= seen + n, `${label}: ${n} more status poll(s)`, 20_000);
  await requestBarrier(page);
}
async function openItems(page) {
  await openWork(page);
  const before = listRequests(page);
  const tab = segment(page, RE_ITEMS);
  await tab.waitFor({ timeout: 15_000 });
  await tab.click();
  await waitFor(() => listRequests(page) > before, "the items sub-tab issues its list read", 20_000);
  await requestBarrier(page);
  return dock(page);
}
const goalCount = (panel, re) => panel.getByText(re).count();
const rawGet = (path, host) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port: Number(new URL(base).port), path, headers: { Host: host }, setHost: false }, (res) => {
    const chunks = []; res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("error", reject); req.end();
});
const get = async (path) => {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(60_000) });
  return { status: response.status, text: await response.text() };
};
async function startServer(name, path = `${stubDir}${delimiter}${process.env.PATH}`) {
  const logFile = join(work, `server-${name}.log`);
  const dir = `${distDir}-${name}`; rmSync(join(root, dir), { force: true, recursive: true });
  const started = await startNextServer({ name, logFile, env: { ...process.env, PI_WEB_DIST_DIR: dir, PATH: path, HOME: work,
    PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_ALLOWED_ROOT_PREFIXES: work, POLYFORGE_V1_API_KEY: "" } });
  base = started.base; stop = started.stop;
}

try {
  browser = await chromium.launch();
  await startServer("main");
  await withPage({ warm: true }, async () => {});

  await check("S203-1", async () => {
    seed();
    await withPage({}, async (page) => {
      const panel = await openItems(page);
      assert.deepEqual((await segments(page).allInnerTexts()).map((t) => t.trim().split(/\s/)[0]), ["作业", "任务", "工单列表"], "the Work strip lists 作业, 任务, 工单列表 in order");
      await row(panel, "GOAL-B is running now").waitFor({ timeout: 20_000 });
      assert.equal(await segment(page, RE_TASKS).getAttribute("aria-selected"), "false", "selecting 工单列表 deselects 任务");
    });
    for (const [locale, label] of [["en", "Work items"], ["zh-TW", "工單列表"]]) {
      await withPage({ locale }, async (page) => {
        await openWork(page);
        // Owner ruling 2026-10-31 (authored-check-defects-203): compare the whole label line (the badge sits on its own line), not the first whitespace token.
        assert.equal((await segment(page, new RegExp(label, "i")).innerText()).trim().split("\n")[0].trim(), label, `${locale} labels the third sub-tab ${label}`);
      });
    }
    // owner 有意变更: at ≤640px the three sub-tabs
    // are a 40px vertical icon rail on the right (was a horizontal bar above
    // the main area), each button named by its tab copy (aria-label/title).
    await withPage({ viewport: { width: 600, height: 900 } }, async (page) => {
      const panel = await openWork(page);
      assert.equal(await segments(page).count(), 3, "at ≤640px the Work rail still carries three buttons");
      const strip = dock(page).locator('[data-pf-tabstrip="work"]');
      assert.equal(await strip.getAttribute("aria-orientation"), "vertical", "the mobile rail is vertical, not a horizontal bar");
      const names = await segments(page).evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("aria-label"), node.getAttribute("title")]));
      assert.deepEqual(names, [["作业", "作业"], ["任务", "任务"], ["工单列表", "工单列表"]], "the three rail buttons are named 作业, 任务, 工单列表 in order");
      const boxes = await segments(page).evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
      }));
      assert.ok(boxes.every((box) => Math.abs(box.x - boxes[0].x) < 2), `the three buttons form one vertical rail (${JSON.stringify(boxes)})`);
      assert.ok(boxes[0].y < boxes[1].y && boxes[1].y < boxes[2].y, `the rail stacks 作业, 任务, 工单列表 top to bottom (${JSON.stringify(boxes)})`);
      assert.ok(boxes.every((box) => box.width > 0 && box.height > 0), "all three buttons are rendered controls");
      const before = listRequests(page);
      const items = strip.getByRole("tab", { name: RE_ITEMS }).first();
      await items.click();
      await waitFor(() => listRequests(page) > before, "the mobile third rail button is selectable", 20_000);
      assert.equal(await items.getAttribute("aria-selected"), "true", "the mobile 工单列表 button is selected");
      const goal = await row(panel, "GOAL-B is running now").boundingBox();
      assert.ok(goal && goal.x + goal.width <= boxes[0].x + 2, `the rail sits right of the main work area (goal end ${goal ? goal.x + goal.width : null}, rail x ${boxes[0].x})`);
      const sheet = await dock(page).boundingBox();
      assert.ok(sheet && boxes[0].right >= sheet.x + sheet.width - 2, `the rail is on the sheet's right edge (rail end ${boxes[0].right}, sheet end ${sheet ? sheet.x + sheet.width : null})`);
    });
  });

  await check("S203-2", async () => {
    seed();
    await withPage({}, async (page) => {
      const panel = await openItems(page);
      await row(panel, "GOAL-B is running now").waitFor({ timeout: 20_000 });
      assert.equal(queues().length, 1, `the first open spawns exactly one queue read (ledger ${JSON.stringify(queues())})`);
      assert.deepEqual(queues()[0], ["queue"], "the read carries no --project, --status or --limit");
      await segment(page, RE_TASKS).click();
      await delay(1000);
      await segment(page, /作业|jobs/i).click();
      await requestBarrier(page);
      assert.equal(queues().length, 1, "showing Jobs or Tasks makes no work-item read");
      await segment(page, RE_ITEMS).click();
      await waitFor(() => queues().length === 2, "re-opening the sub-tab reads exactly once", 20_000);
      await requestBarrier(page);
      assert.equal(queues().length, 2, "the re-open makes exactly one more queue read");
    });
  });

  await check("S203-3", async () => {
    seed({ items: passportItems(), total: 99 });
    const response = await get("/api/polyforge/work-items");
    assert.equal(response.status, 200, `the list route answered ${response.status}`);
    const body = json(response.text); assert.ok(body, "the list route answers JSON");
    assert.equal(body.total, 99, "total is pf's total");
    assert.equal(body.items.length, 2, "a row without a usable id or slug is omitted");
    const allowed = ["bundle_name", "created_at", "goal", "id", "priority", "project", "slug", "status"];
    for (const kept of body.items) assert.deepEqual(Object.keys(kept).sort(), allowed, `a list row carries exactly the eight whitelisted keys, got ${Object.keys(kept)}`);
    const bySlug = Object.fromEntries(body.items.map((r) => [r.slug, r]));
    assert.equal(bySlug["workbench-pass-1"].goal, "PASSPORT-KEEP", "the usable row survives");
    assert.notEqual(bySlug["polyforge-pass-2"].goal, 42, "a wrong-typed goal is dropped or emptied, never coerced");
    assert.ok([null, "", undefined].includes(bySlug["polyforge-pass-2"].created_at), "a wrong-typed created_at is not coerced");
    for (const dropped of ["content", "attrs", "project_id", "session_fingerprint", "parent_id", "seq", "clean_pause", "repo_inventory", "waiting_for", "waiting_on"]) {
      for (const kept of body.items) assert.ok(!(dropped in kept), `the list passport drops ${dropped}`);
    }
    for (const sentinel of [CONTENT_SENTINEL, ATTRS_SENTINEL, PROJECT_ID, PARENT_ID, SESSION_SENTINEL, REPO_SENTINEL, LABEL_SENTINEL]) {
      assert.ok(!response.text.includes(sentinel), `the list response never carries ${sentinel}`);
    }
    seed({ items: passportItems(), total: null });
    const fallback = json((await get("/api/polyforge/work-items")).text);
    assert.equal(fallback.total, fallback.items.length, "an absent pf total falls back to the sanitized row count");
    assert.equal(fallback.items.length, 2, "wrong-typed fields do not resurrect omitted rows");
  });

  await check("S203-4", async () => {
    for (const [mode, reason] of [["fail", /queue: project acme/], ["nomap", /workspace|mapping/i], ["malformed", /decod|parse|unavailable|queue/i]]) {
      seed({ mode });
      const response = await get("/api/polyforge/work-items"); const body = json(response.text);
      assert.equal(response.status, 200, `${mode}: the list route answers 200, got ${response.status}`);
      assert.ok(body, `${mode}: the list route answers JSON`);
      assert.deepEqual(body.items, [], `${mode}: the whole table is empty, never a partial one`);
      assert.equal(body.total, 0, `${mode}: the total is zero`);
      assert.match(String(body.reason ?? body.error ?? ""), reason, `${mode}: carries pf's own bounded reason (got ${JSON.stringify(body.reason ?? body.error)})`);
      assert.ok(!response.text.includes("GOAL-B"), `${mode}: no successful project's rows leak through`);
    }
  });

  await check("S203-5", async () => {
    seed({ items: capItems(), total: 502 });
    await withPage({}, async (page) => {
      const panel = await openItems(page);
      await row(panel, "CAP-WORKBENCH-ONE").waitFor({ timeout: 30_000 });
      const text = await panel.innerText();
      assert.match(text, /\b502\b/, "the header shows the total");
      const newest = await row(panel, "CAP-POLYFORGE-ONE").boundingBox();
      const older = await row(panel, "CAP-WORKBENCH-ONE").boundingBox();
      assert.ok(newest && older && newest.y < older.y, "rows are globally created_at descending (newest first)");
      assert.ok(text.includes("仅显示最近 500 条"), "a project with exactly 500 rows triggers the cap hint");
      const option = await findSelect(panel, "全部项目");
      assert.ok(option, "the project filter renders");
      assert.ok((await optionTexts(option)).some((label) => label.includes("仅显示最近 500 条")), "the capped project's option carries the same hint");
    });
    seed({ items: capItems().filter((r) => r.project !== "acme").concat(
      Array.from({ length: 499 }, (_, i) => item(4000 + i, "acme", "wrapped", 0, `NOCAP-GOAL-${i}`,
        { id: `wi_NOCAP${i}`, slug: `internal-nocap-${i}` }))), total: 501 });
    await withPage({}, async (page) => {
      const panel = await openItems(page);
      await row(panel, "CAP-WORKBENCH-ONE").waitFor({ timeout: 30_000 });
      assert.ok(!(await panel.innerText()).includes("仅显示最近 500 条"), "499 rows do not trigger the cap hint");
    });
  });

  await check("S203-6", async () => {
    seed({ items: manyItems(), total: 1162 });
    await withPage({}, async (page) => {
      const panel = await openItems(page);
      await waitFor(async () => (await goalCount(panel, /^PERF-GOAL-\d{4}$/)) === 1162, "all 1162 rows render", 60_000);
      assert.equal(await goalCount(panel, /^PERF-GOAL-\d{4}$/), 1162, "the one scrolling list holds every row, no virtualisation");
      assert.equal(await panel.getByRole("button", { name: /next|load more|下一页|加载更多/i }).count(), 0, "no paging or load-more control exists");
      const read = queues().length;
      const project = await findSelect(panel, "全部项目");
      assert.ok(project, "the project filter renders at scale");
      await project.selectOption({ label: "acme" });
      assert.equal(await goalCount(panel, /^PERF-GOAL-\d{4}$/), 581, "filtering narrows the same rendered list");
      const search = panel.getByRole("searchbox").or(panel.getByPlaceholder(/搜索|search/i)).first();
      await search.fill("PERF-GOAL-1162");
      assert.equal(await goalCount(panel, /^PERF-GOAL-\d{4}$/), 1, "search narrows the large list");
      await requestBarrier(page);
      assert.equal(queues().length, read, "filtering and searching issue no pf read");
    });
  });

  await check("S203-7", async () => {
    seed();
    await withPage({}, async (page) => {
      const panel = await openItems(page);
      await row(panel, "GOAL-B is running now").waitFor({ timeout: 20_000 });
      const status = await findSelect(panel, "全部状态"); const project = await findSelect(panel, "全部项目");
      assert.ok(status && project, "status and project filters render");
      assert.equal((await optionTexts(status)).length, 8, "全部状态 plus the seven statuses");
      assert.deepEqual((await optionValues(status)).slice(1), ["queued", "running", "paused", "blocked", "wrapped", "failed", "canceled"], "the seven real statuses are offered");
      const projects = await optionTexts(project);
      assert.equal(projects[0], "全部项目", "project defaults to 全部项目");
      assert.deepEqual(projects.slice(1).sort(), ["acme", "polyforge", "workbench"], "the distinct projects of the loaded list");
      const read = queues().length;
      const search = panel.getByRole("searchbox").or(panel.getByPlaceholder(/搜索|search/i)).first();
      await search.fill(CONTENT_SENTINEL);
      assert.equal(await goalCount(panel, /^GOAL-/), 0, "a term occurring only in content matches no row");
      await search.fill("goal-c");
      assert.equal(await goalCount(panel, /^GOAL-/), 1, "slug/goal/project search is case-insensitive");
      await search.fill("workbench");
      assert.equal(await goalCount(panel, /^GOAL-/), 3, "a project name matches its rows");
      await project.selectOption({ label: "workbench" });
      await status.selectOption("canceled");
      assert.equal(await goalCount(panel, /^GOAL-/), 1, "status and project compose into one predicate");
      await requestBarrier(page);
      assert.equal(queues().length, read, "filtering and searching issue no request");
    });
  });

  await check("S203-8", async () => {
    seed({ queue: { running: 3, max_concurrent: 6 } });
    await withPage({}, async (page) => {
      await openWork(page);
      await afterStatusPolls(page, 2, "before opening the items tab");
      const badges = () => segments(page).evaluateAll((nodes) => nodes.flatMap((n) => [n, ...n.querySelectorAll("[aria-label]")])
        .map((node) => node.getAttribute("aria-label") ?? "").filter((name) => name.includes("运行中的工单")));
      assert.deepEqual(await badges(), [], "before the first list read the items badge is absent");
      await segment(page, RE_ITEMS).click();
      await waitFor(() => listRequests(page) > 0, "the first list read", 20_000);
      // Owner ruling 2026-10-31 (authored-check-defects-203): the badge is the count of status === "running" rows of the read (baseItems holds exactly one), not queue.running (3).
      await waitFor(async () => (await badges()).some((name) => name === "1 个运行中的工单"), "the badge shows the first read's running-row count (1)", 20_000);
      const reads = queues().length;
      // Owner ruling 2026-10-31 (authored-check-ledger-reset-203): change only the state; seed() would also empty the argv ledger.
      writeFileSync(stateFile, JSON.stringify(fixture({ queue: { running: 4, max_concurrent: 6 } })));
      await waitFor(() => queues().length === reads + 1, "a count-key change re-reads exactly once", 25_000);
      await requestBarrier(page);
      assert.equal(queues().length, reads + 1, "the count-key change does not cause a second read");
      await afterStatusPolls(page, 2, "after the count-key re-read");
      assert.equal(queues().length, reads + 1, "no polling read follows while nothing changes");
    });
  });

  await check("S203-9", async () => {
    seed();
    await withPage({}, async (page) => {
      const panel = await openItems(page);
      await row(panel, "GOAL-B is running now").waitFor({ timeout: 20_000 });
      const project = await findSelect(panel, "全部项目"); const search = panel.getByRole("searchbox").or(panel.getByPlaceholder(/搜索|search/i)).first();
      await project.selectOption({ label: "polyforge" }); await search.fill("GOAL-B");
      await rowButton(panel, "GOAL-B is running now").click();
      await waitFor(async () => (await panel.innerText()).includes("Detail body of"), "the detail read lands", 20_000);
      assert.deepEqual(fileShows().map((a) => a[2]), ["wi_203E2E0002"], "the selection spawns exactly one file show for that id");
      const text = await panel.innerText();
      for (const want of ["GOAL-B is running now", LABEL_SENTINEL, "MILESTONE-203", "alice", "bob", "acme#1"]) assert.ok(text.includes(want), `the detail shows ${want}`);
      const reads = queues().length;
      await panel.getByRole("button", { name: /返回|back|←/i }).first().click();
      await row(panel, "GOAL-B is running now").waitFor({ timeout: 20_000 });
      assert.equal(await selectedLabel(project), "polyforge", "back keeps the project filter");
      assert.equal(await search.inputValue(), "GOAL-B", "back keeps the search term");
      assert.equal(queues().length, reads, "back makes no new list read");
    });
  });

  await check("S203-10", async () => {
    seed({ detail: detail(longContent) });
    const response = await get("/api/polyforge/work-items/wi_203E2E0002");
    assert.equal(response.status, 200, `the detail route answered ${response.status}`);
    const body = json(response.text); assert.ok(body?.item, "the detail route answers its item");
    assert.ok(Buffer.byteLength(body.item.content, "utf8") <= 262144, "content is capped at 262144 UTF-8 bytes");
    assert.equal(body.item.content_len, Buffer.byteLength(longContent, "utf8"), "content_len is the uncut byte length");
    assert.ok(!body.item.content.includes("E2E-TAIL-AFTER-CAP"), "content is cut on a code-point boundary, never the tail");
    const allowed = ["assignee", "bundle_name", "closed_at", "content", "content_len", "created_at", "goal", "id", "labels", "milestone",
      "priority", "project", "reporter", "slug", "status", "updated_at", "waiting_for", "waiting_on"];
    assert.deepEqual(Object.keys(body.item).sort(), allowed, "the detail carries only the eighteen whitelisted keys");
    for (const dropped of ["attrs", "project_id", "parent_id", "seq", "clean_pause", "repo_inventory", "session_fingerprint"]) assert.ok(!(dropped in body.item), `drops ${dropped}`);
    for (const sentinel of [ATTRS_SENTINEL, PROJECT_ID, PARENT_ID, REPO_SENTINEL, SESSION_SENTINEL]) assert.ok(!response.text.includes(sentinel), `the detail response never carries ${sentinel}`);
    const before = itemVerbs();
    const malformed = await get("/api/polyforge/work-items/not-a-wi-id");
    assert.equal(malformed.status, 400, `a malformed id answers 400, got ${malformed.status}`);
    assert.equal(itemVerbs(), before, "a malformed id spawns no pf");
  });

  await check("S203-11", async () => {
    seed();
    const before = itemVerbs();
    for (const path of ["/api/polyforge/work-items", "/api/polyforge/work-items/wi_203E2E0002"]) {
      const post = await fetch(`${base}${path}`, { method: "POST", signal: AbortSignal.timeout(30_000) });
      assert.equal(post.status, 405, `POST ${path} must be refused as method-not-allowed, got ${post.status}`);
    }
    const put = await fetch(`${base}/api/polyforge/work-items`, { method: "PUT", signal: AbortSignal.timeout(30_000) });
    assert.equal(put.status, 405, `PUT must be refused as method-not-allowed, got ${put.status}`);
    for (const path of ["/api/polyforge/work-items", "/api/polyforge/work-items/wi_203E2E0002"]) {
      const refused = await rawGet(path, "e2e-evil.example.com");
      assert.equal(refused.status, 403, `a cross-host ${path} must answer 403, got ${refused.status}`);
      assert.ok(json(refused.text), "the 403 is JSON");
    }
    assert.equal(itemVerbs(), before, "a refused request spawns no pf");
    assert.ok(!errors.some((line) => /^5\d\d /.test(line)), `no route answers 5xx: ${errors.join(" | ")}`);
  });

  await check("S203-12", async () => {
    await stop();
    seed({ version: "v2.18.9" });
    await startServer("floor");
    const list = await get("/api/polyforge/work-items"); const item = await get("/api/polyforge/work-items/wi_203E2E0002");
    for (const [label, response] of [["list", list], ["detail", item]]) {
      assert.equal(response.status, 200, `below the floor the ${label} route answers 200, got ${response.status}`);
      const body = json(response.text); assert.ok(body, `below the floor the ${label} route answers JSON`);
      assert.equal(body.capable, false, `below the floor ${label} answers capable:false`);
      assert.match(String(body.reason ?? ""), /2\.19\.0/, `below the floor ${label} names the 2.19.0 reason`);
    }
    assert.equal(itemVerbs(), 0, "below the floor no queue or file verb is spawned");
    await stop();
    await startServer("absent", absentPath);
    const absent = await get("/api/polyforge/work-items");
    assert.equal(absent.status, 200, `without pf the list route answers 200, got ${absent.status}`);
    const body = json(absent.text); assert.ok(body, "without pf the list route answers JSON");
    assert.equal(body.pfPresent, false, "without pf the body says pfPresent:false");
    assert.ok(Array.isArray(body.items) && body.items.length === 0, "without pf the item list is empty");
    assert.equal(itemVerbs(), 0, "without pf no queue or file verb is spawned");
  });
} catch (error) {
  failures.push("suite");
  console.log(`FAIL suite: ${String(error?.message ?? error).split("\n")[0]}`);
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  await stop();
  if (failures.length) console.log(`\nFAILED ${failures.join(", ")} — ${failures.length} scenario(s) red`);
  else console.log("\nPASS all authored work-item scenarios");
  console.log(`server log: ${join(work, "server-main.log")}`);
}
if (failures.length) process.exitCode = 1;
