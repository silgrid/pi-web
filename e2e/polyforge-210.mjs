// — Polyforge job detail re-layout: title row, DAG timings, live progress.
//
// Authored PRE-CODE against artifacts/spec.md (Acceptance criteria + `####
// Scenario` blocks). The suite drives the panel through the existing Jobs tab
// (`[data-pf-card-wi]`, the deselect control) and the new read face at
// `GET /api/polyforge/progress?wi=`; the exact route path and the four
// `data-pf-*` test hooks are the deterministic interfaces `plan.md` pinned
// (the spec leaves them to plan). Existing /api/polyforge/{status,cards,watch}
// reads are mocked with their documented wire shapes for the UI scenarios;
// the new route is exercised against a throwaway daemon data root so its
// whitelist, id/path containment and step tail are real.
//
// At the pre-implementation tree every kept scenario is assertion-level RED:
// no title row, no DAG timing line, no progress block, and the new route
// answers 404. Every scenario prints `PASS S210-<n>` on success (its binding
// marker).
//
//   node e2e/polyforge-210.mjs
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
process.env.PI_WEB_DIST_DIR ||= ".next/e2e/polyforge-210";
if (process.env.PI_WEB_DIST_DIR.startsWith(".next/e2e/")) rmSync(join(root, process.env.PI_WEB_DIST_DIR), { recursive: true, force: true });
assert.ok(!existsSync(join(root, process.env.PI_WEB_DIST_DIR, "dev/lock")), "Run in a checkout without an active dev server");

const work = mkdtempSync(join(tmpdir(), "pi-web-pf-210-e2e-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
const dataRoot = join(work, "data");
const SESSION = "e2e-pf-210-session";
const ROUTE = "/api/polyforge/progress";
const POLL_KEY = "pi-web:polyforge-poll-interval";
const EPOCH = "2026-10-31T00:00:00.000Z";
const GOAL = "feat: pi-web 作业卡片详情区重构——自上而下三段、无嵌套滚动与实时进度";
const SHORT = "pi-web 作业卡片详情区重构";
const NO_BOUNDARY = "fix: plain whole goal without a clause boundary";
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project);
mkdirSync(dataRoot, { recursive: true });
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), jsonl([
  { type: "session", version: 3, id: SESSION, timestamp: EPOCH, cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: EPOCH, message: { role: "user", content: "E2E pf 210 host session" } },
]));

// ── UI fixture: documented wire shapes of the existing reads ───────────────
const job = (wi, slug, status, stepAgeSec = 30) => ({ wi, slug, status, stepAgeSec, idleAgeSec: 2, candidate: "pi:e2e/model", spawnN: 1 });
const A = job("wi_E2E210A01", "task#9210", "running", 125);
const B = job("wi_E2E210B01", "task#9211", "needs_input", 61);
const C = job("wi_E2E210C01", "task#9212", "paused", 900);
const step = (id, durationSec, runs) => ({ id, state: "timed", durationSec, runs });
const A_STEPS = ["step-grill", "step-spec", "step-plan", "step-fail", "step-code", "step-review"];
const cards = [
  { job: A, goal: GOAL, startedAt: EPOCH, steps: [step("step-grill", 15, 1), step("step-spec", 45, 1), step("step-plan", 35, 2), { id: "step-fail", state: "unknown", runs: 0 }, step("step-code", 7, 1), { id: "step-review", state: "unstarted", runs: 0 }], currentStep: "step-code", progress: { available: false, entries: [] } },
  { job: B, goal: null, startedAt: EPOCH, steps: [], currentStep: "step-code", progress: { available: false, entries: [] } },
  { job: C, goal: NO_BOUNDARY, startedAt: EPOCH, steps: [], currentStep: "step-code", progress: { available: false, entries: [] } },
];
const status = { pfPresent: true, status: { queue: { running: 1, max: 4 }, jobs: [A, B, C], tasks: { running: 0, completed: 0 } } };
const started = Date.now() - 300_000;
const at = (sec) => new Date(started + sec * 1_000).toISOString();
const watchA = () => ({ status: {
  wi: A.wi, slug: A.slug, workflowStatus: "running", currentStep: "step-code", updatedAt: EPOCH,
  steps: [
    { name: "step-grill", status: "done", startedAt: at(0) }, { name: "step-spec", status: "done", startedAt: at(15) },
    { name: "step-plan", status: "done", startedAt: at(60) }, { name: "step-fail", status: "failed", startedAt: at(95) },
    { name: "step-code", status: "in_progress", startedAt: at(120) }, { name: "step-review", status: "pending" },
  ],
  declared_steps: A_STEPS.map((id) => ({ id })),
  events: [{ at: at(0), kind: "job_started", work_item: A.wi, body: {}, seq: 1 }],
  summary: "E2E-SUMMARY", summary_age_sec: 3,
  progress: { command: "E2E-command --token=SECRET", command_age_sec: 5, tool_calls: 2, recent_files: ["e2e/recent.ts"] },
  origin: { chat_id: "conv_e2e210", owner: "u_e2e210" },
} });
const watchB = () => ({ status: { wi: B.wi, slug: B.slug, workflowStatus: "needs_input", currentStep: "step-code", updatedAt: EPOCH,
  steps: [{ name: "step-code", status: "pending" }], declared_steps: [{ id: "step-code" }], events: [] } });
const watchC = () => ({ status: { wi: C.wi, slug: C.slug, workflowStatus: "paused", currentStep: "step-code", updatedAt: EPOCH,
  steps: [{ name: "step-code", status: "blocked", startedAt: at(0) }], declared_steps: [{ id: "step-code" }], events: [] } });
const entry = (n, text, kind = "narration") => ({ id: `e${n}`, kind, text });
const defaultProgress = () => ({ available: true, entries: [
  entry(1, "E2E-STEP-CODE-NARRATION"),
  entry(2, "bash: curl --token=*** https://e2e.invalid", "tool"),
] });

// ── real read-face fixture: one daemon data root, capsule transcripts ──────
const routeWi = (n) => `wi_E2E210Route${n}`;
const caps = {};
for (const n of [1, 2, 3, 4, 5]) {
  const wi = routeWi(n);
  caps[wi] = join(work, "capsules", wi);
  mkdirSync(join(caps[wi], "runtime-state"), { recursive: true });
  mkdirSync(join(caps[wi], "session"), { recursive: true });
}
const piText = (id, text) => ({ type: "message", id, parentId: null, timestamp: EPOCH, message: { role: "assistant", content: [{ type: "text", text }] } });
const pi = (id, content) => ({ type: "message", id, parentId: null, timestamp: EPOCH, message: { role: "assistant", content } });
const routePi = join(caps[routeWi(1)], "session", "pi.jsonl");
writeFileSync(routePi, jsonl([
  { type: "session", id: "s", timestamp: EPOCH },
  { type: "message", id: "u", parentId: null, timestamp: EPOCH, message: { role: "user", content: "SECRET-PROMPT" } },
  piText("n", "E2E-ROUTE-NARRATION token=SECRET-TOKEN"),
  pi("tc", [{ type: "thinking", thinking: "SECRET-THINKING" }, { type: "toolCall", id: "c", name: "bash", arguments: { command: "curl --token=SECRET-TOKEN https://e2e.invalid" } }]),
  { type: "message", id: "tr", parentId: null, timestamp: EPOCH, message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "SECRET-TOOL-RESULT" }] } },
]));
const manyPi = join(caps[routeWi(5)], "session", "many.jsonl");
writeFileSync(manyPi, jsonl([...Array.from({ length: 60 }, (_, i) => piText(`m${i}`, `E2E-MANY-${String(i + 1).padStart(2, "0")}`))]));
const partialPi = join(caps[routeWi(4)], "session", "partial.jsonl");
writeFileSync(partialPi, '{"type":"message","id":"half","message":{"role":"assistant","content":[{"type":"text","text":"E2E-HALF"');
const journal = (wi, transcript, stepId = "code") => writeFileSync(join(caps[wi], "runtime-state", "spawn-journal.jsonl"), jsonl([{ at: EPOCH, work_item: wi, step_id: stepId, started_at: EPOCH, transcript, harness: "pi" }]));
journal(routeWi(1), routePi);
journal(routeWi(2), "/etc/passwd");
journal(routeWi(3), join(caps[routeWi(3)], "session", "missing.jsonl"));
journal(routeWi(4), partialPi);
journal(routeWi(5), manyPi);
writeFileSync(join(dataRoot, "runtime-state.json"), JSON.stringify({ version: 1, jobs: [1, 2, 3, 4, 5].map((n) => ({
  work_item_id: routeWi(n), capsule_dir: caps[routeWi(n)], transcript: n === 3 ? join(caps[routeWi(3)], "session", "missing.jsonl") : undefined,
})) }));

// ── scenario bookkeeping and browser helpers ───────────────────────────────
const failures = [];
async function check(id, fn) {
  try { await fn(); console.log(`PASS ${id}`); }
  catch (error) { failures.push(id); console.log(`FAIL ${id}: ${String(error?.message ?? error).split("\n")[0]}`); }
}
const errors = [];
let browser; let base; let stop = async () => {};
const dock = (page) => page.locator("#polyforge-dock").or(page.getByRole("dialog", { name: /polyforge/i })).first();
const pfButton = (page) => page.getByRole("button", { name: /^(?!.*close).*polyforge/i }).first();
const card = (page, wi) => dock(page).locator(`[data-pf-card-wi="${wi}"]`);
const progressRequests = (page) => page.__progressRequests;
async function openPage({ clock = false, storage = {} } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript(({ prefs }) => {
    try { localStorage.setItem("pi-web:split-view-enabled", "false"); localStorage.setItem("pi-locale", "en"); for (const [k, v] of Object.entries(prefs)) localStorage.setItem(k, v); } catch { /* storage unavailable */ }
  }, { prefs: storage });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const progress = { status: 200, body: defaultProgress(), hits: [] };
  page.__progress = progress;
  page.__progressRequests = [];
  page.route((url) => url.pathname.startsWith("/api/polyforge/"), (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/polyforge/status") return route.fulfill({ json: status });
    if (path === "/api/polyforge/cards") return route.fulfill({ json: { pfPresent: true, cards } });
    if (path === "/api/polyforge/watch") {
      const wi = new URL(route.request().url()).searchParams.get("wi");
      const body = wi === B.wi || wi === B.slug ? watchB() : wi === C.wi || wi === C.slug ? watchC() : watchA();
      return route.fulfill({ json: body });
    }
    if (path === ROUTE) {
      progress.hits.push(Date.now());
      if (progress.status !== 200) return route.fulfill({ status: progress.status, json: { error: "E2E stub failure" } });
      return route.fulfill({ json: progress.body });
    }
    return route.fulfill({ json: {} });
  });
  page.on("request", (request) => { if (new URL(request.url()).pathname === ROUTE) page.__progressRequests.push(Date.now()); });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await page.getByText("E2E pf 210 host session").first().waitFor({ state: "attached", timeout: NAV_MS });
  if (clock) { await page.clock.install({ time: new Date() }); await page.clock.pauseAt(new Date(Date.now() + 2000)); }
  return page;
}
const withPage = async (opts, fn) => { const page = await openPage(opts); try { return await fn(page); } finally { await page.context().close(); } };
async function openDock(page) {
  const more = page.locator('[data-mobile-toolbar-more="true"]');
  if ((await pfButton(page).count()) === 0 && (await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await pfButton(page).click(); await dock(page).waitFor({ timeout: 20_000 }); return dock(page);
}
async function openA(page) {
  await openDock(page); await card(page, A.wi).waitFor({ timeout: 30_000 }); await card(page, A.wi).click();
  await dock(page).getByRole("button", { name: /back to job list|deselect/i }).waitFor({ timeout: 10_000 });
}
async function waitFor(fn, label, ms = 12_000) {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) { try { last = await fn(); if (last) return last; } catch (error) { last = error.message; } await delay(150); }
  throw new Error(`${label} (last: ${last})`);
}
const tick = (page, ms) => (ms > 0 ? page.clock.runFor(ms) : Promise.resolve());
const detail = (page) => dock(page).locator("[data-pf-detail-title]").first();
const progressBlock = (page) => dock(page).locator("[data-pf-progress]").first();
const timing = (page, id) => dock(page).locator(`[data-pf-step-timing="${id}"]`).first();
const titleText = async (page) => (await detail(page).innerText()).replace(/\s+/g, " ").trim();
async function order(page, labels) {
  return dock(page).evaluate((scope, wanted) => {
    const leaf = (text) => [...scope.querySelectorAll("*")].find((el) => el.children.length === 0 && (el.textContent || "").trim().startsWith(text));
    const title = scope.querySelector("[data-pf-detail-title]");
    const dag = scope.querySelector('[role="list"]');
    const progress = scope.querySelector("[data-pf-progress]");
    const found = { title, dag, progress };
    for (const label of wanted) found[label] = leaf(label);
    const follows = (a, b) => Boolean(a && b && a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { present: Object.fromEntries(Object.entries(found).map(([k, v]) => [k, Boolean(v)])),
      order: { dag: follows(title, dag), progress: follows(dag, progress), facts: follows(progress, found.Model),
        summary: follows(found.Model, found.Summary), command: follows(found.Summary, found.Command),
        tools: follows(found.Command, found["Tool calls"]), recent: follows(found["Tool calls"], found["Recent files"]),
        origin: follows(found["Recent files"], found.Origin), events: follows(found.Origin, found["Job started"]) } };
  }, labels);
}

try {
  const logFile = join(work, "server.log");
  const s = await startNextServer({ name: "polyforge-210", logFile, env: { ...process.env, PI_WEB_DIST_DIR: process.env.PI_WEB_DIST_DIR,
    PI_CODING_AGENT_DIR: agentDir, POLYFORGE_DATA_DIR: dataRoot, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1",
    PI_WEB_ALLOWED_ROOT_PREFIXES: work } });
  base = s.base; stop = s.stop;
  browser = await chromium.launch();

  await check("S210-01", () => withPage({}, async (page) => {
    await openA(page); await detail(page).waitFor({ timeout: 10_000 });
    const result = await order(page, ["Model", "Summary", "Command", "Tool calls", "Recent files", "Origin", "Job started"]);
    for (const [key, present] of Object.entries(result.present)) assert.ok(present, `${key} is rendered`);
    for (const [key, ok] of Object.entries(result.order)) assert.ok(ok, `the detail block order holds at ${key}: ${JSON.stringify(result)}`);
  }));

  await check("S210-02", () => withPage({}, async (page) => {
    await openA(page); await detail(page).waitFor({ timeout: 10_000 });
    const text = await titleText(page);
    assert.ok(text.includes(A.slug), `the title row carries the slug: ${text}`);
    assert.ok(text.includes(SHORT), `the title row carries the heuristic short title: ${text}`);
    assert.ok(text.includes("Running"), `the title row carries the localized job status: ${text}`);
    assert.doesNotMatch(text, /feat:|自上而下/, "the prefix and the later clauses are not in the short title");
    const deselect = await detail(page).getByRole("button", { name: /back to job list|deselect/i }).count();
    assert.equal(deselect, 1, "the deselect control sits in the title row");
    const hover = await detail(page).getAttribute("title");
    assert.ok(hover?.includes(GOAL), `the hover carries the full goal: ${hover}`);
    assert.ok(hover?.includes("Current step") && hover.includes("step-code"), `the hover carries the current step: ${hover}`);
    const style = await detail(page).evaluate((scope, short) => {
      const el = [...scope.querySelectorAll("*")].find((node) => node.children.length === 0 && (node.textContent || "").trim() === short);
      if (!el) return null;
      const s = getComputedStyle(el); return { whiteSpace: s.whiteSpace, overflow: s.overflow, textOverflow: s.textOverflow };
    }, SHORT);
    assert.ok(style, "the short title has its own element");
    assert.ok(style.whiteSpace === "nowrap" && /hidden/.test(style.overflow) && style.textOverflow === "ellipsis", `one-line ellipsis: ${JSON.stringify(style)}`);
  }));

  await check("S210-03", () => withPage({}, async (page) => {
    await openDock(page); await card(page, C.wi).click();
    await dock(page).getByRole("button", { name: /back to job list|deselect/i }).waitFor({ timeout: 10_000 });
    const text = await titleText(page);
    assert.ok(text.includes("plain whole goal without a clause boundary"), `the boundary-free goal stays whole: ${text}`);
    assert.ok(!text.includes("fix:"), "the conventional-commit prefix is stripped");
    await dock(page).getByRole("button", { name: /back to job list|deselect/i }).click();
    await card(page, B.wi).click();
    await dock(page).getByRole("button", { name: /back to job list|deselect/i }).waitFor({ timeout: 10_000 });
    const fallback = await titleText(page);
    assert.ok(fallback.includes(B.slug) && fallback.includes("Needs input"), `the no-goal title row carries slug + status: ${fallback}`);
    assert.ok(!/undefined|null|E2E/i.test(fallback), `no invented title is rendered: ${fallback}`);
  }));

  await check("S210-04", () => withPage({}, async (page) => {
    await openA(page); await timing(page, "step-grill").waitFor({ timeout: 10_000 });
    assert.equal((await timing(page, "step-grill").innerText()).trim(), "+15s", "a done step shows its start-to-next-start duration");
    assert.equal((await timing(page, "step-spec").innerText()).trim(), "+45s", "the next done step keeps the same semantics");
    assert.match(await timing(page, "step-plan").innerText(), /×2/, "a rerun step keeps its rerun count on the timing line");
    const node = dock(page).getByRole("listitem").filter({ hasText: "step-grill" }).first();
    assert.match(await node.getAttribute("title"), /\d{2}:\d{2}:\d{2}/, "the node hover carries the start time");
  }));

  await check("S210-05", () => withPage({ clock: true }, async (page) => {
    await openA(page); await timing(page, "step-code").waitFor({ timeout: 10_000 });
    const first = (await timing(page, "step-code").innerText()).trim();
    assert.match(first, /^\+\d+[smh]/, `the in-progress step shows a live age: ${first}`);
    await tick(page, 3000); await delay(200);
    const second = (await timing(page, "step-code").innerText()).trim();
    assert.notEqual(second, first, "the live age grows with the watch poll");
    for (const id of ["step-fail", "step-review"]) {
      const line = (await timing(page, id).innerText()).trim();
      assert.equal(line, "", `${id} keeps an empty timing line (${line})`);
    }
    const all = await dock(page).innerText();
    assert.doesNotMatch(all, /NaN|-\d+[smh]/, "no NaN or negative timing is rendered");
  }));

  await check("S210-06", () => withPage({ clock: true }, async (page) => {
    await openA(page); await progressBlock(page).waitFor({ timeout: 10_000 });
    await waitFor(async () => /E2E-STEP-CODE-NARRATION/.test(await progressBlock(page).innerText()), "the narration entry");
    const kinds = await progressBlock(page).locator("[data-pf-progress-kind]").evaluateAll((els) => els.map((el) => el.getAttribute("data-pf-progress-kind")));
    assert.ok(kinds.includes("narration") && kinds.includes("tool"), `both whitelisted kinds render: ${JSON.stringify(kinds)}`);
    assert.match(await progressBlock(page).innerText(), /bash: curl --token=\*\*\*/, "the tool line carries the masked command");
    page.__progress.body = { available: true, entries: [entry(9, "E2E-STEP-REVIEW-NARRATION")] };
    await tick(page, 2000); await delay(200);
    await waitFor(async () => /E2E-STEP-REVIEW-NARRATION/.test(await progressBlock(page).innerText()), "the new step tail");
    assert.doesNotMatch(await progressBlock(page).innerText(), /E2E-STEP-CODE-NARRATION/, "the previous step's tail is not spliced in");
  }));

  await check("S210-07", () => withPage({}, async (page) => {
    page.__progress.body = { available: false, entries: [] };
    await openA(page); await progressBlock(page).waitFor({ timeout: 10_000 });
    await waitFor(async () => /unavailable|no progress|empty|不可用|无进度/i.test(await progressBlock(page).innerText()), "the localized unavailable state");
    assert.doesNotMatch(await progressBlock(page).innerText(), /E2E-STEP|bash:/, "no fabricated line is shown");
  }));

  await check("S210-08", async () => {
    const response = await fetch(`${base}${ROUTE}?wi=${routeWi(1)}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, "a valid wi answers 200");
    const text = await response.text(); const body = JSON.parse(text);
    assert.equal(body.available, true, "the tail is available");
    assert.ok(Array.isArray(body.entries) && body.entries.length > 0, "the tail carries entries");
    assert.ok(body.entries.some((e) => e.kind === "narration" && e.text.includes("E2E-ROUTE-NARRATION token=***")), `narration is shown masked: ${text}`);
    assert.ok(body.entries.some((e) => e.kind === "tool" && /bash: curl --token=\*\*\*/.test(e.text)), `one tool line is shown masked: ${text}`);
    for (const secret of ["SECRET-TOOL-RESULT", "SECRET-THINKING", "SECRET-PROMPT", "SECRET-TOKEN"]) assert.ok(!text.includes(secret), `the response leaks ${secret}`);
    for (const kind of ["toolResult", "thinking", "user", "system"]) assert.ok(!text.includes(kind), `the response carries no ${kind} record`);
  });

  await check("S210-09", () => withPage({ clock: true, storage: { [POLL_KEY]: "1" } }, async (page) => {
    await openA(page); await progressBlock(page).waitFor({ timeout: 10_000 });
    await waitFor(() => progressRequests(page).length >= 1, "the immediate read");
    await tick(page, 1900); await delay(200);
    assert.equal(progressRequests(page).length, 1, "no request before the fixed 2 s window elapses");
    await tick(page, 300); await delay(300);
    await waitFor(() => progressRequests(page).length >= 2, "the first 2 s tick");
    const beforeHide = progressRequests(page).length;
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await tick(page, 6000); await delay(200);
    assert.equal(progressRequests(page).length, beforeHide, "a hidden page issues no progress request");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => progressRequests(page).length > beforeHide, "becoming visible reads immediately");
    await dock(page).getByRole("button", { name: /back to job list|deselect/i }).click();
    await card(page, B.wi).click();
    await waitFor(() => progressRequests(page).length > beforeHide + 1, "a non-running selection reads once", 5_000);
    const once = progressRequests(page).length;
    await tick(page, 6000); await delay(200);
    assert.equal(progressRequests(page).length, once, "a non-running selection is never polled");
  }));

  await check("S210-10", async () => {
    const response = await fetch(`${base}${ROUTE}?wi=${routeWi(5)}`, { signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.entries.length, 50, "the read face keeps the newest 50 entries");
    assert.ok(body.entries.some((e) => e.text === "E2E-MANY-60"), "the newest entry is present");
    assert.ok(!body.entries.some((e) => e.text === "E2E-MANY-10"), "the oldest entries are evicted");
    await withPage({}, async (page) => {
      page.__progress.body = { available: true, entries: Array.from({ length: 50 }, (_, i) => entry(i, `E2E-LINE-${String(i + 1).padStart(2, "0")}`)) };
      await openA(page); await progressBlock(page).waitFor({ timeout: 10_000 });
      await waitFor(async () => (await progressBlock(page).locator("[data-pf-progress-kind]").count()) === 50, "all 50 entries render");
      const first = progressBlock(page).locator("[data-pf-progress-kind]").first();
      assert.equal(await first.getAttribute("title"), "E2E-LINE-01", "each line carries its full text on hover");
      const nested = await progressBlock(page).evaluate((scope) => [scope, ...scope.querySelectorAll("*")].some((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)));
      assert.equal(nested, false, "the progress area has no inner vertical scroller");
    });
  });

  await check("S210-11", () => withPage({ clock: true }, async (page) => {
    await openA(page); await progressBlock(page).waitFor({ timeout: 10_000 });
    await waitFor(async () => /E2E-STEP-CODE-NARRATION/.test(await progressBlock(page).innerText()), "the first good tail");
    page.__progress.status = 500;
    await tick(page, 2000); await delay(300);
    assert.match(await progressBlock(page).innerText(), /E2E-STEP-CODE-NARRATION/, "a failed read keeps the previous tail");
    page.__progress.status = 200; page.__progress.body = { available: false, entries: [] };
    await tick(page, 2000); await delay(300);
    assert.match(await progressBlock(page).innerText(), /E2E-STEP-CODE-NARRATION/, "a degraded read keeps the previous tail too");
    assert.doesNotMatch(await progressBlock(page).innerText(), /error|failed/i, "no extra error readout is rendered");
  }));

  await check("S210-12", async () => {
    const get = async (path, init = {}) => { const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000), ...init }); return { status: response.status, text: await response.text() }; };
    for (const query of ["", "?wi=", "?wi=../../etc/passwd", "?wi=wi_E2E210Unknown1"]) {
      const bad = await get(`${ROUTE}${query}`);
      assert.equal(bad.status, 400, `a wrong-shaped or unknown wi is refused before any transcript read (${query || "no wi"})`);
      assert.ok(!bad.text.includes("root:"), "no transcript content leaves a refused request");
    }
    const outside = await get(`${ROUTE}?wi=${routeWi(2)}`);
    assert.equal(outside.status, 200, "a transcript outside the capsule/data root degrades with 200");
    assert.equal(JSON.parse(outside.text).available, false, "the outside path is not read");
    assert.ok(!outside.text.includes("root:"), "the outside file's content never leaves");
    const partial = await get(`${ROUTE}?wi=${routeWi(4)}`);
    assert.equal(partial.status, 200, "a partially written transcript answers 200, never 5xx");
    assert.ok(Array.isArray(JSON.parse(partial.text).entries), "the degraded body still carries an entries array");
    const gated = await get(`${ROUTE}?wi=${routeWi(1)}`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(gated.status, 403, "the new route sits behind the existing /api gate");
    const post = await get(`${ROUTE}?wi=${routeWi(1)}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(post.status, 405, "the read face is GET only");
  });

  await check("S210-13", async () => {
    await withPage({}, async (page) => {
      await openA(page); await detail(page).waitFor({ timeout: 10_000 });
      const result = await order(page, ["Model", "Summary", "Command", "Tool calls", "Recent files", "Origin", "Job started"]);
      for (const [key, ok] of Object.entries(result.order)) assert.ok(ok, `existing block order holds at ${key}: ${JSON.stringify(result)}`);
    });
    const button = await withPage({}, async (page) => {
      await openA(page); await detail(page).waitFor({ timeout: 10_000 });
      const toggle = await dock(page).getByRole("button", { name: /simple|verbose/i }).count();
      const timingLabel = await dock(page).getByText("Step timing", { exact: true }).count();
      return { toggle, timingLabel };
    });
    assert.equal(button.toggle, 1, "the event-mode toggle remains");
    assert.equal(button.timingLabel, 0, "the step-timing block has left the detail rows for the DAG");
  });

  await check("S210-14", async () => {
    const docs = await import("node:fs/promises").then((fs) => fs.readFile(join(root, "docs/agents/polyforge-panel.md"), "utf8"));
    assert.match(docs, /polyforge\/progress|progress area|Execution progress/i, "the panel note documents the progress face");
    assert.match(docs, /2 s|2s|whitelist|progress/i, "the panel note covers the progress whitelist and cadence");
    const map = await import("node:fs/promises").then((fs) => fs.readFile(join(root, "AGENTS.md"), "utf8"));
    assert.match(map, /polyforge\/progress/, "the file map names the new route");
    const locales = await Promise.all(["en", "zh-CN", "zh-TW"].map((name) => import("node:fs/promises").then((fs) => fs.readFile(join(root, `lib/i18n/messages/${name}.ts`), "utf8"))));
    for (const source of locales) {
      assert.ok(!source.includes("polyforge.stepTiming"), "the dead step-timing key leaves every locale");
      assert.match(source, /progress/i, "each locale carries the progress-area vocabulary");
    }
  });
} catch (error) {
  failures.push("suite");
  console.log(`FAIL suite: ${String(error?.message ?? error).split("\n")[0]}`);
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  await stop();
  if (failures.length) console.log(`\nFAILED ${failures.join(", ")} — ${failures.length} scenario(s) red`);
  else console.log("\nPASS all authored scenarios");
  console.log(`server log: ${join(work, "server.log")}`);
}
if (failures.length) process.exitCode = 1;
