// carries: components/Polyforge*, components/polyforge-*, hooks/usePolyforge*, lib/polyforge*, app/api/polyforge/*
// carries: components/AppShell*
// — Polyforge Jobs tab card stream: end-to-end acceptance pass.
//
// Authored pre-code against artifacts/spec.md. The suite drives the new
// surfaces only through the one read face the spec names (GET
// /api/polyforge/cards) and the Jobs tab's card markup (`data-pf-card`,
// `data-pf-card-wi`), with a stub `pf` and a throwaway daemon data root
// (`$HOME/.local/share/polyforge`) holding controlled event, capsule and
// transcript fixtures for both harness formats. Every scenario logs PASS/FAIL
// and the run exits 1 on any FAIL; at the pre-implementation baseline no card
// or route exists, so every kept scenario is assertion-level red.
//
//   node e2e/polyforge-cards.mjs
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startNextServer } from "./next-server.mjs";
import { openPolyforgeDock as openDock, polyforgeDock as dock, polyforgeToggle as pfButton } from "./polyforge-dock.mjs";
import { NAV_MS } from "./timeouts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(!existsSync(join(root, process.env.PI_WEB_DIST_DIR || ".next", "dev/lock")), "Run in a checkout without an active dev server");
const work = mkdtempSync(join(tmpdir(), "pi-web-pf-cards-e2e-"));
const home = join(work, "home");
const agentDir = join(home, ".pi", "agent");
const project = join(work, "project");
const dataRoot = join(home, ".local", "share", "polyforge");
const SESSION = "e2e-pf-cards-session";
const CARDS = "/api/polyforge/cards";
const STATUS = "/api/polyforge/status";
const BARRIER = "/__e2e_request_barrier";
const TITLE_KEY = "pi-web:polyforge-title-length";
const POLL_KEY = "pi-web:polyforge-poll-interval";
// the goal fixture is 84 code points, well past the new
// 60-code-point default, so "the default truncation hides the tail" keeps
// holding with room to spare (the allowlist maps the goal from the capsule
// fixture, so S3/S15/S16 read the same text).
const GOAL = `E2E-GOAL-START-${"G".repeat(60)}-GOALTAIL`;
const EPOCH = "2026-10-30T01:00:00.000Z";
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project);
mkdirSync(dataRoot, { recursive: true });
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), [
  { type: "session", version: 3, id: SESSION, timestamp: EPOCH, cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: EPOCH, message: { role: "user", content: "E2E pf cards host session" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

// ---- jobs and daemon records ----
const job = (wi, slug, status, spawn, step, idle, candidate) => ({ work_item_id: wi, slug, status, spawn_n: spawn,
  step_age_sec: step, last_work_ago_sec: idle, candidate, session_fingerprint: "fp-cards", origin: { kind: "chat", owner: "u_e2e" } });
const A = job("wi_E2EcardsA01", "task#9101", "running", 3, 125, 4, "pi:e2e/card-model");
const B = job("wi_E2EcardsB01", "task#9102", "needs_input", 1, 61, 9, "claude:e2e/card-model");
const T = job("wi_E2EcardsB02", "task#9105", "paused", 2, 900, 880, "codex:e2e/card-model");
const C = job("wi_E2EcardsC01", "task#9103", "queued", 0, 0, 12, "pi:e2e/c-model");
const D = job("wi_E2EcardsD01", "task#9104", "queued", 0, 0, 30, "pi:e2e/no-item");
const E = job("wi_E2EcardsE01", "task#9106", "running", 1, 5, 1, "pi:e2e/new");
const capsule = (wi) => join(work, "capsules", wi);
const pi = (id, content) => ({ type: "message", id, parentId: null, timestamp: EPOCH, message: { role: "assistant", content } });
const claude = (content) => ({ type: "assistant", timestamp: EPOCH, message: { role: "assistant", content } });
const piText = (marker) => pi(`pi-${marker}`, [{ type: "text", text: marker }]);
const piLines = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => piText(`A-PROGRESS-${String(from + i).padStart(3, "0")}`));
const at = (min, sec = 0) => new Date(Date.parse(EPOCH) + min * 60_000 + sec * 1_000).toISOString();
const ev = (wi, n, kind, body) => ({ at: at(n), kind, work_item: wi, body, seq: n + 1 });
const eventsA = [
  ev(A.work_item_id, 0, "job_started", { spawn_n: 1 }), ev(A.work_item_id, 30, "job_started", { spawn_n: 2 }),
  ev(A.work_item_id, 0.1, "step_started", { step: "step-grill" }), ev(A.work_item_id, 0.2, "step_done", { step: "step-grill" }),
  ev(A.work_item_id, 0.3, "step_started", { step: "step-spec" }), ev(A.work_item_id, 0.5, "step_done", { step: "step-spec" }),
  ev(A.work_item_id, 0.55, "step_started", { step: "step-plan" }), ev(A.work_item_id, 1.05, "step_done", { step: "step-plan" }),
  ev(A.work_item_id, 1.1, "step_started", { step: "step-plan" }), ev(A.work_item_id, 1.15, "step_done", { step: "step-plan" }),
];
const jobs = [A, B, T, C, D, E];

function writeCapsule(meta) {
  const dir = capsule(meta.wi);
  mkdirSync(join(dir, "runtime-state"), { recursive: true });
  mkdirSync(join(dir, "workflows", "feature-full"), { recursive: true });
  mkdirSync(join(dir, "session"), { recursive: true });
  writeFileSync(join(dir, "capsule.json"), `${JSON.stringify({ work_item_id: meta.wi, bundle_name: "feature-full", project: "workbench" }, null, 2)}\n`);
  writeFileSync(join(dir, "workflows", "feature-full", "workflow.md"),
    `---\nname: feature-full\nsteps:\n${meta.steps.map((id) => `  - { id: ${id} }`).join("\n")}\n---\n`);
  if (meta.goal !== null) {
    writeFileSync(join(dir, "runtime-state", "work-item.json"),
      `${JSON.stringify({ id: meta.wi, slug: meta.slug, project: "workbench", goal: meta.goal }, null, 2)}\n`);
    writeFileSync(join(dir, "runtime-state", "execution.json"), `${JSON.stringify({
      current_step: meta.current ?? meta.steps[0], workflow_status: "running", steps: meta.stepsStatus,
    }, null, 2)}\n`);
    writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"),
      `${JSON.stringify({ at: meta.journalAt, work_item: meta.wi, step_id: meta.current ?? meta.steps[0], spawn_token: "e2e#1",
        started_at: meta.journalAt, session_handle: "e2e", spawn_n: 1, resume: false, transcript: meta.transcript, harness: meta.harness })}\n`);
  }
}

const aPi = join(capsule(A.work_item_id), "session", "session-e2e#1.jsonl");
const bClaude = join(capsule(B.work_item_id), "session", "session-e2e#2.jsonl");
const cMissing = join(capsule(C.work_item_id), "session", "missing.jsonl");
const aStatus = { "step-grill": { status: "done" }, "step-spec": { status: "done" }, "step-plan": { status: "done" },
  "step-nostart": { status: "done" }, "step-skip": { status: "skipped" }, "step-code": { status: "in_progress", step_started_at: at(0.2) }, "step-review": { status: "pending" } };
writeCapsule({ wi: A.work_item_id, slug: A.slug, goal: GOAL, steps: ["step-grill", "step-spec", "step-plan", "step-nostart", "step-skip", "step-code", "step-review"],
  stepsStatus: aStatus, current: "step-code", transcript: aPi, harness: "pi", journalAt: at(0.2) });
writeCapsule({ wi: B.work_item_id, slug: B.slug, goal: "E2E-B-GOAL", steps: ["step-code"],
  stepsStatus: { "step-code": { status: "done" } }, current: "step-code", transcript: bClaude, harness: "claude", journalAt: at(1) });
writeCapsule({ wi: T.work_item_id, slug: T.slug, goal: "E2E-T-GOAL", steps: ["step-code"],
  stepsStatus: { "step-code": { status: "blocked" } }, current: "step-code", transcript: cMissing, harness: "pi", journalAt: at(1) });
writeCapsule({ wi: C.work_item_id, slug: C.slug, goal: "E2E-C-GOAL", steps: ["step-code"],
  stepsStatus: { "step-code": { status: "pending" } }, current: "step-code", transcript: cMissing, harness: "pi", journalAt: at(2) });
writeCapsule({ wi: E.work_item_id, slug: E.slug, goal: "E2E-E-GOAL appended", steps: ["step-code"],
  stepsStatus: { "step-code": { status: "in_progress" } }, current: "step-code", transcript: cMissing, harness: "pi", journalAt: at(3) });
writeCapsule({ wi: D.work_item_id, slug: D.slug, goal: null, steps: [] });

function writeIndex() {
  const records = jobs.map((j) => ({ work_item_id: j.work_item_id, project: "workbench", slug: j.slug, state: j.status === "paused" ? "paused" : "running",
    capsule_dir: capsule(j.work_item_id), bundle_name: "feature-full", spawn_n: j.spawn_n,
    transcript: j === A ? aPi : j === B ? bClaude : cMissing }));
  writeFileSync(join(dataRoot, "runtime-state.json"), `${JSON.stringify({ version: 1, jobs: records }, null, 2)}\n`);
}
function writeEvents() {
  mkdirSync(join(dataRoot, "events"), { recursive: true });
  writeFileSync(join(dataRoot, "events", `wi-${A.work_item_id}.jsonl`), eventsA.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const [j, minute] of [[B, 1], [T, 1], [C, 2], [E, 3]]) {
    writeFileSync(join(dataRoot, "events", `wi-${j.work_item_id}.jsonl`),
      `${JSON.stringify({ at: at(minute), kind: "job_started", work_item: j.work_item_id, body: { spawn_n: 1 }, seq: 1 })}\n`);
  }
  writeFileSync(join(dataRoot, "events", `wi-${D.work_item_id}.jsonl`), "");
}
function writeTranscripts() {
  const records = [...piLines(1, 240),
    pi("pi-tool", [{ type: "toolCall", id: "tc-pi", name: "bash", arguments: { command: "printf --token=PI-SECRET-TOKEN" } }]),
    { type: "message", id: "pi-result", parentId: null, timestamp: EPOCH, message: { role: "toolResult", content: [{ type: "text", text: "PI-SECRET-TOOL-RESULT" }], toolName: "bash" } },
    pi("pi-think", [{ type: "thinking", thinking: "PI-SECRET-THINKING" }]),
    { type: "message", id: "pi-user", parentId: null, timestamp: EPOCH, message: { role: "user", content: "PI-SECRET-USER-PROMPT" } }];
  writeFileSync(aPi, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const claudeRecords = [
    { type: "user", message: { role: "user", content: [{ type: "text", text: "CLAUDE-SECRET-PROMPT" }] } },
    claude([{ type: "text", text: "CLAUDE-VISIBLE-ASSISTANT" }, { type: "tool_use", id: "tu-1", name: "bash", input: { command: "printf --token=CLAUDE-SECRET-TOKEN" } }]),
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-1", content: "CLAUDE-SECRET-TOOL-RESULT" }] } },
    claude([{ type: "thinking", thinking: "CLAUDE-SECRET-THINKING" }, { type: "text", text: "CLAUDE-SECOND-VISIBLE" }]),
  ];
  writeFileSync(bClaude, claudeRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
const appendA = (lines) => appendFileSync(aPi, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

// ---- stub pf ----
const stubDir = join(work, "stub-bin");
mkdirSync(stubDir);
const stateFile = join(stubDir, "state.json");
const slugs = Object.fromEntries(jobs.map((j) => [j.work_item_id, j.slug]));
// the step facts left the card for the job detail, which reads
// them from `pf watch`. A's watch snapshot: the declared order, every step
// state (a done step with no start, a skipped one, the running one, a pending
// one) and fixed start times, so the running step's live age grows.
const A_STEP_IDS = ["step-grill", "step-spec", "step-plan", "step-nostart", "step-skip", "step-code", "step-review"];
// Rebuilt on every setOps, so the running step is seconds old when a
// scenario starts and its age shows at second granularity.
const watchA = (now = Date.now()) => {
  const startedAt = (sec) => new Date(now - 300_000 + sec * 1_000).toISOString();
  return { known: true, work_item: A.work_item_id, slug: A.slug, job: { status: "running" },
  execution: { workflow_status: "running", current_step: "step-code", steps: {
    "step-grill": { status: "done", started_at: startedAt(0) }, "step-spec": { status: "done", started_at: startedAt(60) },
    "step-plan": { status: "done", started_at: startedAt(120) }, "step-nostart": { status: "done" }, "step-skip": { status: "skipped" },
    "step-code": { status: "in_progress", started_at: startedAt(295) }, "step-review": { status: "pending" } },
  declared_steps: A_STEP_IDS.map((id) => ({ id })) },
  events: [{ at: startedAt(295), kind: "step_started", work_item: A.work_item_id, body: { step: "step-code" }, seq: 1 }], last_seq: 1 };
};
const setOps = (listed) => writeFileSync(stateFile, JSON.stringify({ mode: "ok", slugs, watchA: watchA(),
  ops: { machine_id: "m-e2e", workspaces: [work], workflows_dir: join(work, "wf"), env_names: ["E2E_ENV"], jobs: listed,
    queue: { pending: 0, running: 2, max_concurrent: 4 } } }));
writeFileSync(join(stubDir, "pf"), `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const dir = path.dirname(fs.realpathSync(__filename)); const args = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const out = (v) => { const b = Buffer.from(JSON.stringify(v) + "\\n"); let o = 0;
  while (o < b.length) { try { o += fs.writeSync(1, b, o); } catch (e) { if (e.code !== "EAGAIN") throw e; } } process.exit(0); };
if (args.includes("--version")) { process.stdout.write("v2.20.11\\n"); process.exit(0); }
const rest = args.filter((a) => a !== "--json");
if (rest[0] === "ops" && rest[1] === "status") { fs.appendFileSync(path.join(dir, "ops-status.log"), Date.now() + "\\n"); out(s.ops); }
if (rest[0] === "watch") {
  const wi = rest[1];
  if (wi === s.watchA.work_item || wi === s.watchA.slug) out(s.watchA);
  out({ work_item: wi, slug: s.slugs[wi] || wi, known: true, job: { status: "running" },
    execution: { workflow_status: "running", current_step: "step-code", steps: { "step-code": { status: "in_progress" } } },
    events: [{ at: new Date().toISOString(), kind: "step_started", work_item: wi, body: { step: "step-code" }, seq: 1 }], last_seq: 1 });
}
if (rest[0] === "msg") out({ conversations: [] });
if (rest[0] === "task" && rest[1] === "list") out({ tasks: [], now: new Date().toISOString() });
if (rest[0] === "config" && rest[1] === "list") out({ items: [] });
if (rest[0] === "config" && rest[1] === "workspace") out({ mapped: false, workspace: null });
if (rest[0] === "recall") out({ items: [], total: 0 });
if (rest[0] === "memory" && rest[1] === "show") { process.stderr.write("pf: not found\\n"); process.exit(4); }
process.stderr.write("pf: unknown command\\n"); process.exit(2);
`);
chmodSync(join(stubDir, "pf"), 0o755);
writeIndex(); writeEvents(); writeTranscripts(); setOps([T, C, B, A]); // ops order intentionally not the card order
const opsStatusLog = join(stubDir, "ops-status.log");
/** Start times (ms) of every `pf ops status` spawn the stub served. */
const opsSpawns = () => (existsSync(opsStatusLog) ? readFileSync(opsStatusLog, "utf8").split("\n").filter(Boolean).map(Number) : []);

// ---- scenario bookkeeping ----
const failures = [];
async function check(id, fn) {
  try { await fn(); console.log(`PASS ${id}`); }
  catch (error) { failures.push(id); console.log(`FAIL ${id}: ${String(error?.message ?? error).split("\n")[0]}`); }
}

const errors = [];
let browser; let base; let stop = async () => {};
async function openPage({ storage = {}, session = true, viewport = { width: 1280, height: 800 } } = {}) {
  const context = await browser.newContext({ viewport, locale: "en-US" });
  await context.addInitScript(({ loc, prefs }) => {
    try {
      localStorage.setItem("pi-web:split-view-enabled", "false"); localStorage.setItem("pi-locale", loc);
      for (const [key, value] of Object.entries(prefs)) localStorage.setItem(key, value);
    } catch { /* storage unavailable */ }
  }, { loc: "en", prefs: storage });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.__cardRequests = []; page.__cardResponses = []; page.__statusRequests = []; page.__barriers = 0;
  await page.route((url) => url.pathname === BARRIER, (route) => route.fulfill({ status: 204 }));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === CARDS) page.__cardRequests.push({ at: Date.now(), url: request.url() });
    else if (pathname === STATUS) page.__statusRequests.push({ at: Date.now() });
    else if (pathname === BARRIER) page.__barriers += 1;
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === CARDS) response.text().then((text) => page.__cardResponses.push({ at: Date.now(), status: response.status(), text })).catch(() => {});
  });
  await page.goto(session ? `${base}/?session=${SESSION}` : `${base}/`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await page.getByText("E2E pf cards host session").first().waitFor({ state: "attached", timeout: NAV_MS });
  return page;
}
const withPage = async (opts, fn) => { const page = await openPage(opts); try { return await fn(page); } finally { await page.context().close(); } };
const card = (page, wi) => dock(page).locator(`[data-pf-card-wi="${wi}"]`);
// the visible status element is the leaf carrying the full
// status as its title — the running card's text is its duration alone, so the
// title is `<status word> <n>m` and ends with the visible text.
const cardStatus = (page, wi) => card(page, wi).evaluate((el) => {
  const lf = [...el.querySelectorAll("[title]")].map((node) => ({ text: (node.textContent ?? "").trim(), title: node.getAttribute("title") ?? "" }))
    .find((entry) => entry.text && (entry.title === entry.text || entry.title.endsWith(` ${entry.text}`)));
  return { text: lf?.text ?? "", title: lf?.title ?? "", aria: el.getAttribute("aria-label") ?? "" };
});
const cardOrder = (page) => dock(page).locator("[data-pf-card-wi]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-pf-card-wi")));
async function waitFor(fn, label, ms = 12_000) {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) { try { last = await fn(); if (last) return last; } catch (error) { last = error.message; } await delay(200); }
  throw new Error(`${label} (last: ${last})`);
}
/**
 * instead of a wall-clock grace window, wait `ms` of PAGE time
 * (a page timer queued after every live poll interval's next due time, so a
 * still-running 1 s poll would have fired first), then fetch a stubbed
 * barrier URL and wait (bounded) until its request is logged. Requests are
 * logged in issue order, so the request log is complete up to the barrier.
 */
async function afterPageTime(page, ms) {
  const seen = page.__barriers;
  await page.evaluate(async ({ wait, url }) => {
    await new Promise((resolve) => setTimeout(resolve, wait));
    await fetch(url, { cache: "no-store" });
  }, { wait: ms, url: BARRIER });
  await waitFor(() => page.__barriers > seen, "the barrier request is logged", 5_000);
}
/**
 * the server reuses one `pf ops status` read for 1 s, so a
 * fixture change is served up to 1 s later. A scenario that changes the job
 * set waits (bounded) until the card route serves exactly that set before it
 * opens the dock, so its first read is never the previous fixture's snapshot.
 */
async function setOpsSettled(listed) {
  setOps(listed);
  const wanted = listed.map((j) => j.work_item_id).sort().join(",");
  await waitFor(async () => {
    const response = await fetch(`${base}${CARDS}`, { signal: AbortSignal.timeout(30_000) });
    const body = await response.json();
    return Array.isArray(body.cards) && body.cards.map((c) => c.job?.wi).sort().join(",") === wanted;
  }, "the card route serves the fixture's job set", 10_000);
}
const openSettings = async (page) => {
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await show.isVisible().catch(() => false)) await show.click();
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  return page.getByRole("dialog", { name: "Settings", exact: true });
};
const numberInputs = (dialog) => dialog.locator('input[type="number"]:visible').evaluateAll((nodes) => nodes.map((node) => ({
  value: node.value, min: node.getAttribute("min"), max: node.getAttribute("max"),
})));

try {
  browser = await chromium.launch();
  const logFile = join(work, "server.log");
  const distDir = process.env.PI_WEB_DIST_DIR || ".next/e2e/polyforge-cards";
  rmSync(join(root, distDir), { force: true, recursive: true });
  const started = await startNextServer({ name: "polyforge-cards", logFile, env: { ...process.env,
    PI_WEB_DIST_DIR: distDir, PATH: `${stubDir}${delimiter}${process.env.PATH}`, HOME: home, POLYFORGE_DATA_DIR: dataRoot,
    PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_ALLOWED_ROOT_PREFIXES: work, POLYFORGE_V1_API_KEY: "" } });
  base = started.base; stop = started.stop;

  await check("S1", () => withPage({}, async (page) => {
    setOps([T, C, B, A, D]); writeTranscripts();
    const panel = await openDock(page);
    await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    assert.equal(await panel.locator("[data-pf-card]").count(), 5, "one card per ops-status job");
    const expected = [[B.work_item_id, /needs input/i], [T.work_item_id, /paused/i], [C.work_item_id, /queued/i]];
    for (const [wi, label] of expected) assert.match((await cardStatus(page, wi)).text, label, `${wi} status label`);
    // owner 有意变更 a running card's visible status is the
    // duration alone; the status word stays in its aria-label/title.
    const runningStatus = await cardStatus(page, A.work_item_id);
    assert.match(runningStatus.text, /^\d+m$/, `the running card shows the duration alone (${runningStatus.text})`);
    assert.match(runningStatus.aria, new RegExp(`^${A.slug} · Running \\d+m$`), `the running aria-label keeps the full status (${runningStatus.aria})`);
  }));

  await check("S2", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    // (owner-approved intentional change ③): the model, spawn
    // count and step/idle age left line 1 for the job detail.
    const text = await card(page, A.work_item_id).innerText();
    assert.doesNotMatch(text, /#3/, "line 1 no longer carries the spawn count");
    assert.doesNotMatch(text, /pi:e2e\/card-model/, "line 1 no longer carries the candidate");
    assert.doesNotMatch(text, /\bidle\b/i, "line 1 no longer carries the idle age");
    await card(page, A.work_item_id).click();
    await dock(page).getByRole("button", { name: /back to job list|deselect/i }).waitFor({ timeout: 10_000 });
    const detail = await dock(page).innerText();
    assert.match(detail, /#3/, "the detail keeps the spawn count"); assert.match(detail, /pi:e2e\/card-model/, "the detail keeps the candidate");
    assert.match(detail, /step/i); assert.match(detail, /idle/i);
    // the card no longer lists step ids, so this now waits
    // (bounded) for the detail's own watch read instead of matching card text.
    await waitFor(async () => /step started|step-code/i.test(await dock(page).innerText()), "the existing detail and event tail open");
    await card(page, A.work_item_id).click();
    await waitFor(async () => (await dock(page).getByRole("button", { name: /back to job list|deselect/i }).count()) === 0, "second click deselects");
  }));

  await check("S3", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const node = card(page, A.work_item_id); await node.waitFor({ timeout: 30_000 });
    const text = await node.innerText();
    assert.ok(text.includes("E2E-GOAL-START"), "the goal head renders on line 1");
    assert.ok(Array.from(GOAL).length > 60, `the fixture is longer than the default 60 code points (${Array.from(GOAL).length})`);
    assert.ok(!text.includes("GOALTAIL"), `the default 60-code-point truncation hides the tail: ${text}`);
    assert.match(text, /…/, "a truncated goal ends with an ellipsis");
    const titles = [await node.getAttribute("title"), ...await node.locator("[title]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("title")))];
    assert.ok(titles.includes(GOAL), "the full goal is available on hover (title attribute)");
  }));

  await check("S4", () => withPage({}, async (page) => {
    writeTranscripts(); await setOpsSettled([T, C, B, A, D]);
    await openDock(page); await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    await waitFor(async () => (await cardOrder(page)).length === 5, "five cards");
    assert.deepEqual(await cardOrder(page), [A.work_item_id, B.work_item_id, T.work_item_id, C.work_item_id, D.work_item_id],
      "ascending earliest job_started, ties by wi id, no-start last");
  }));

  await check("S5", () => withPage({}, async (page) => {
    writeTranscripts(); await setOpsSettled([T, C, B, A]);
    await openDock(page); await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    const before = await cardOrder(page);
    assert.deepEqual(before, [A.work_item_id, B.work_item_id, T.work_item_id, C.work_item_id]);
    setOps([T, C, B, A, E]);
    await waitFor(async () => (await cardOrder(page)).length === 5, "the new job's card appears");
    assert.deepEqual(await cardOrder(page), [...before, E.work_item_id], "the new card appends at the bottom");
  }));

  await check("S6", () => withPage({}, async (page) => {
    writeTranscripts(); await setOpsSettled([T, C, B, A]);
    await openDock(page); await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    const before = await cardOrder(page); const ticks = page.__cardRequests.length;
    await waitFor(() => page.__cardRequests.length >= ticks + 2, "two poll ticks");
    assert.deepEqual(await cardOrder(page), before, "a poll never reorders the cards");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("E2E pf cards host session").first().waitFor({ state: "attached", timeout: NAV_MS });
    await openDock(page); await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    assert.deepEqual(await cardOrder(page), before, "a full reload shows the same order with no duplicate");
  }));

  await check("S7", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const node = card(page, A.work_item_id); await node.waitFor({ timeout: 30_000 });
    // (owner-ruled compact card): the card carries no step
    // information at all — every step fact below is asserted in the detail.
    const text = await node.innerText();
    for (const id of A_STEP_IDS) assert.ok(!text.includes(id), `the card carries no step id (${id})`);
    assert.equal(await node.locator("[data-pf-step-phase]").count(), 0, "no step segment on the card");
    assert.doesNotMatch(text, /×\d/, "no rerun marker on the card");
    await node.click();
    await dock(page).getByRole("button", { name: /back to job list|deselect/i }).waitFor({ timeout: 10_000 });
    const items = dock(page).getByRole("listitem");
    await waitFor(async () => (await items.count()) >= A_STEP_IDS.length, "the detail's step graph renders every declared step");
    // owner 有意变更: the node shows only the step
    // name and its dot; the status moved from visible text to title/aria-label,
    // so the status assertions below read the accessible name (same patterns).
    const nodes = (await items.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""))).map((value) => value.replace(/\s+/g, " ").trim());
    const titles = await items.evaluateAll((els) => els.map((el) => el.getAttribute("title") ?? ""));
    // owner 有意变更 the node title also carries the step's start time when it has one.
    titles.forEach((value, i) => {
      const title = value.replace(/\s+/g, " ").trim();
      assert.ok(title === nodes[i] || (title.startsWith(`${nodes[i]} · `) && /\d{2}:\d{2}/.test(title.slice(nodes[i].length))), `each node's title carries the same name + status as its aria-label, then at most the start time (${title})`);
    });
    const visible = (await items.allInnerTexts()).map((value) => value.replace(/\s+/g, " ").trim());
    let last = -1;
    for (const id of A_STEP_IDS) { const i = nodes.findIndex((value) => value.startsWith(id)); assert.ok(i > last, `the detail lists ${id} in workflow order`); last = i; }
    for (const id of A_STEP_IDS) assert.ok(visible.includes(id), `the ${id} node shows its name and no visible status text (got ${JSON.stringify(visible)})`);
    const nodeText = (id) => nodes.find((value) => value.startsWith(id)) ?? "";
    // + #173 (+ #213: via title/aria-label): a skipped step names skipped, never unknown/unstarted.
    assert.match(nodeText("step-skip"), /skipped|已跳过/i, `a skipped step names the skipped label (got ${JSON.stringify(nodeText("step-skip"))})`);
    // owner 有意变更: skipped is a hollow gray ring, pending a filled gray dot.
    const dotOf = (id) => items.filter({ hasText: id }).first().locator('span[aria-hidden="true"]').first().evaluate((el) => {
      const style = getComputedStyle(el);
      return { background: style.backgroundColor, border: parseFloat(style.borderTopWidth) || 0 };
    });
    const clear = (color) => color === "transparent" || /rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(color);
    const skipDot = await dotOf("step-skip"); const pendingDot = await dotOf("step-review");
    assert.ok(clear(skipDot.background) && skipDot.border >= 1, `the skipped dot is a hollow ring (${JSON.stringify(skipDot)})`);
    assert.ok(!clear(pendingDot.background), `the pending dot stays filled (${JSON.stringify(pendingDot)})`);
    assert.doesNotMatch(nodeText("step-skip"), /未知|unknown|—|pending/i, "a skipped step is neither unknown nor unstarted");
    assert.match(nodeText("step-review"), /pending/i, "a not-started step reads as such");
    assert.match(nodeText("step-code"), /in progress/i, "the current step is recognizable");
    // owner 有意变更 the timing row moved from the detail rows to the line under its DAG node
    // ([data-pf-step-timing]); the same guarantees are read there.
    const timingLine = async (id) => {
      const line = dock(page).locator(`[data-pf-step-timing="${id}"]`).first();
      return (await line.count()) ? (await line.innerText()).trim() : "";
    };
    await waitFor(async () => /\+\d/.test(await timingLine("step-code")) && await timingLine("step-code"), "the running step's timing line");
    assert.match(await timingLine("step-plan"), /×2/, "a rerun step carries the rerun marker on its timing line");
    assert.match(await timingLine("step-grill"), /\+\d/, "a done step carries its duration");
    assert.doesNotMatch(await timingLine("step-grill"), /×/, "a single-run step carries no rerun marker");
    assert.doesNotMatch(await timingLine("step-nostart"), /\+\d/, "a step with no readable start shows no fabricated duration");
    assert.doesNotMatch(await dock(page).innerText(), /NaN/, "no NaN duration");
    const first = await timingLine("step-code");
    await waitFor(async () => { const line = await timingLine("step-code"); return line && line !== first; },
      "the running step's duration grows with the detail's refresh", 12_000);
  }));

  await check("S8", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const aCard = card(page, A.work_item_id); const bCard = card(page, B.work_item_id);
    await aCard.waitFor({ timeout: 30_000 }); await bCard.waitFor({ timeout: 30_000 });
    // owner 有意变更 (reverses the 32px narration):
    // the card renders no narration any more, so the route's newest-page,
    // increment and whitelist semantics are asserted on its responses, and
    // the card DOM asserts that no narration reaches it.
    await waitFor(() => page.__cardResponses.find((response) => response.text.includes("A-PROGRESS-240")), "pi progress in the route response");
    await waitFor(() => page.__cardResponses.find((response) => response.text.includes("CLAUDE-VISIBLE-ASSISTANT")), "claude progress in the route response");
    appendA([piText("A-PROGRESS-BETA")]);
    const beta = await waitFor(() => page.__cardResponses.find((response) => response.text.includes("A-PROGRESS-BETA")), "the increment response");
    assert.ok(!beta.text.includes("A-PROGRESS-240"), "the increment response does not re-send earlier entries");
    const dom = `${await aCard.innerText()}\n${await bCard.innerText()}`;
    assert.doesNotMatch(dom, /A-PROGRESS(?:-\d{3}|-BETA)|CLAUDE-VISIBLE-ASSISTANT/, "the card shows no narration");
  }));

  await check("S9", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const bCard = card(page, B.work_item_id); await bCard.waitFor({ timeout: 30_000 });
    // (owner-approved intentional change ②): the card read face
    // carries assistant narration only — neither a tool name nor a
    // command/argument reaches it — and masking still holds.
    // owner 有意变更 (reverses the 32px narration):
    // those semantics now read on the route response; the card DOM shows none.
    appendA([piText("A-NARRATION token=PI-SECRET-TOKEN masked")]);
    const narration = await waitFor(() => page.__cardResponses.find((response) => response.text.includes("A-NARRATION")), "the credential-bearing narration in the route response");
    assert.match(narration.text, /token=\*\*\*/, "the credential in narration is masked");
    assert.doesNotMatch(narration.text, /bash|printf|"kind":"tool"/, "the response carries no tool entry, name or command");
    for (const secret of ["CLAUDE-SECRET-TOOL-RESULT", "CLAUDE-SECRET-THINKING", "CLAUDE-SECRET-PROMPT", "CLAUDE-SECRET-TOKEN",
      "PI-SECRET-TOOL-RESULT", "PI-SECRET-THINKING", "PI-SECRET-USER-PROMPT", "PI-SECRET-TOKEN"]) assert.ok(!narration.text.includes(secret), `the response leaks ${secret}`);
    // The whitelisted assistant text arrives on the card's first page, which is
    // what carries the Claude fixture; the increment above carries A only.
    const whitelisted = await waitFor(() => page.__cardResponses.find((response) => response.text.includes("CLAUDE-VISIBLE-ASSISTANT")), "the whitelisted assistant text");
    assert.ok(whitelisted.text.includes("CLAUDE-SECOND-VISIBLE"), "both visible assistant texts flow");
    const dom = `${await bCard.innerText()}\n${await card(page, A.work_item_id).innerText()}`;
    assert.doesNotMatch(dom, /A-PROGRESS|A-NARRATION|CLAUDE-VISIBLE-ASSISTANT|token=|bash|printf/, "no narration or tool text reaches the card");
    for (const secret of ["CLAUDE-SECRET-TOOL-RESULT", "CLAUDE-SECRET-THINKING", "CLAUDE-SECRET-PROMPT", "CLAUDE-SECRET-TOKEN",
      "PI-SECRET-TOOL-RESULT", "PI-SECRET-THINKING", "PI-SECRET-USER-PROMPT", "PI-SECRET-TOKEN"]) assert.ok(!dom.includes(secret), `the DOM leaks ${secret}`);
  }));

  await check("S10", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const node = card(page, C.work_item_id); await node.waitFor({ timeout: 30_000 });
    // owner 有意变更 (reverses the 32px narration):
    // an unreadable transcript now degrades only the route's progress payload;
    // the card keeps slug + status and shows no progress state.
    await waitFor(async () => {
      const response = await fetch(`${base}${CARDS}`, { signal: AbortSignal.timeout(30_000) });
      const body = await response.json();
      return body.cards?.find((item) => item.job?.wi === C.work_item_id)?.progress?.available === false;
    }, "the degraded route payload (progress unavailable)");
    const text = await node.innerText();
    assert.ok(text.includes(C.slug), "the rest of the card still renders");
    assert.doesNotMatch(text, /unavailable|不可用|A-PROGRESS/, "the card shows no progress state");
    const ticks = page.__cardRequests.length;
    await waitFor(() => page.__cardRequests.length >= ticks + 2, "two degraded polls");
    assert.deepEqual(errors.splice(0), [], "no console error on the degraded path");
    const response = await fetch(`${base}${CARDS}`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, "the degraded read answers 200");
  }));

  await check("S11", async () => {
    setOps([T, C, B, A]); writeTranscripts();
    const get = async (path) => { const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) }); return { status: response.status, text: await response.text() }; };
    const ok = await get(CARDS);
    assert.equal(ok.status, 200, "the card route answers 200"); assert.ok(JSON.parse(ok.text), "the body is decodable JSON");
    for (const query of ["?wi=../../etc/passwd", "?path=../../etc/passwd", "?cursors=not-json", `?cursors=${encodeURIComponent(JSON.stringify({ "../x": "../y" }))}`]) {
      const response = await get(`${CARDS}${query}`);
      assert.equal(response.status, 200, `malformed input answers 200 (${query})`);
      assert.ok(!response.text.includes("root:"), `no client-supplied path is read (${query})`);
    }
    for (const method of ["POST", "PUT"]) {
      const response = await fetch(`${base}${CARDS}`, { method, headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, 405, `${method} is refused with 405, got ${response.status}`);
    }
  });

  await check("S12", () => withPage({ storage: { [POLL_KEY]: "1" } }, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    const panel = await openDock(page); await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    const startedAt = Date.now();
    await waitFor(() => page.__cardRequests.filter((r) => r.at >= startedAt).length >= 3, "three one-second ticks", 8_000);
    const early = page.__cardRequests.filter((r) => r.at >= startedAt);
    assert.ok(early.every((r) => new URL(r.url).pathname === CARDS), "one card route serves every card");
    const groups = []; for (const request of early) { if (!groups.length || request.at - groups.at(-1).at(-1).at > 300) groups.push([request]); else groups.at(-1).push(request); }
    assert.ok(groups.every((group) => group.length === 1), `one request per tick, not per card: ${groups.map((g) => g.length)}`);
    // Jobs and Tasks are Work's sub-tabs.
    const tabs = panel.locator('[data-pf-tabstrip="work"] [role="tab"]');
    await tabs.filter({ hasText: /tasks/i }).first().click();
    await afterPageTime(page, 0);
    const offJobs = page.__cardRequests.length; await afterPageTime(page, 1_500); assert.equal(page.__cardRequests.length, offJobs, "no card requests off the Jobs sub-tab");
    await tabs.filter({ hasText: /jobs/i }).first().click(); await waitFor(() => page.__cardRequests.length > offJobs, "returning to the Jobs sub-tab takes a read", 2_000);
    await panel.getByRole("button", { name: /close/i }).first().click(); await dock(page).waitFor({ state: "hidden", timeout: 20_000 });
    await afterPageTime(page, 0);
    const closed = page.__cardRequests.length; await afterPageTime(page, 1_500); assert.equal(page.__cardRequests.length, closed, "no card requests while the dock is closed");
    await pfButton(page).click(); await dock(page).waitFor({ timeout: 20_000 });
    await waitFor(() => page.__cardRequests.length > closed, "reopening takes an immediate read", 2_000);
  }));

  await check("S13", () => withPage({ storage: { [POLL_KEY]: "1" } }, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const node = card(page, A.work_item_id); await node.waitFor({ timeout: 30_000 });
    // owner 有意变更 (reverses the 32px narration):
    // the card has no narration area, so the 32px self-scrolling region pin is
    // delete. The newest-page and increment semantics move to the route
    // responses, and the client's 200-entry merge cap stays covered by
    // lib/polyforge-cards-pure.test.mjs ("progress merge: ... the newest 200
    // are kept").
    const cardsOf = (response) => JSON.parse(response.text).cards ?? [];
    const progressOf = (response, wi) => cardsOf(response).find((item) => item.job?.wi === wi)?.progress ?? { entries: [] };
    const first = await waitFor(() => page.__cardResponses.find((response) => progressOf(response, A.work_item_id).entries.some((entry) => entry.text === "A-PROGRESS-240")), "the newest page in the route response");
    const firstEntries = progressOf(first, A.work_item_id).entries;
    assert.ok(firstEntries.length > 0 && firstEntries.length <= 20, `the first load carries the newest ~20 entries (${firstEntries.length})`);
    assert.ok(!firstEntries.some((entry) => entry.text === "A-PROGRESS-220"), "the first load starts at the newest ~20 entries");
    const region = await node.evaluate((el) => {
      for (const child of [el, ...el.querySelectorAll("*")]) {
        const style = getComputedStyle(child);
        if (/(auto|scroll)/.test(style.overflowY) && child.scrollHeight > child.clientHeight + 8) return { height: child.clientHeight, scroll: child.scrollHeight };
      }
      return null;
    });
    assert.equal(region, null, "the card has no narration scroll region any more");
    appendA(Array.from({ length: 220 }, (_, i) => piText(`A-PROGRESS-${String(241 + i).padStart(3, "0")}`)));
    const increments = await waitFor(() => {
      const found = page.__cardResponses.filter((response) => progressOf(response, A.work_item_id).entries.some((entry) => entry.text === "A-PROGRESS-460"));
      return found.length ? found : undefined;
    }, "the newest increment in a route response", 30_000);
    const increment = progressOf(increments.at(-1), A.work_item_id).entries;
    assert.ok(increment.length > 0 && increment.length <= 20, `a poll carries at most the 20 new entries (${increment.length})`);
    assert.ok(!increment.some((entry) => entry.text === "A-PROGRESS-240"), "an increment does not re-send the previous page");
    for (const response of page.__cardResponses) {
      const all = cardsOf(response).flatMap((item) => item.progress?.entries ?? []);
      assert.ok(all.length <= 200, `a response carries at most 200 entries (${all.length})`);
    }
  }));

  await check("S14", () => withPage({ storage: { [POLL_KEY]: "1" } }, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const node = card(page, A.work_item_id); await node.waitFor({ timeout: 30_000 });
    await node.evaluate((el) => { el.__e2eStamp = "same-node"; });
    const ticks = page.__cardRequests.length;
    await waitFor(() => page.__cardRequests.length >= ticks + 2, "two polls before the click");
    assert.equal(await node.evaluate((el) => el.__e2eStamp), "same-node", "the poll kept the card's DOM node");
    await node.click();
    await dock(page).getByRole("button", { name: /back to job list|deselect/i }).waitFor({ timeout: 10_000 });
  }));

  await check("S15", () => withPage({ storage: { [TITLE_KEY]: "bogus", [POLL_KEY]: "-5" } }, async (page) => {
    let dialog = await openSettings(page);
    await dialog.getByRole("button", { name: "Polyforge", exact: true }).click();
    await waitFor(async () => (await numberInputs(dialog)).length >= 2, "the two numeric controls");
    const controls = await numberInputs(dialog);
    assert.equal(controls.length, 2, "exactly the two new numeric controls");
    const title = controls.find((c) => c.min === "10" && c.max === "200");
    const poll = controls.find((c) => c.min === "1" && c.max === "60");
    assert.ok(title && poll, `the bounds 10–200 and 1–60 are declared: ${JSON.stringify(controls)}`);
    // the title-length default is 60 (was 30).
    assert.deepEqual([title.value, poll.value], ["60", "3"], "corrupt stored values fall back to the defaults");
    await page.evaluate(({ t, p }) => { localStorage.setItem(t, "999"); localStorage.setItem(p, "999"); }, { t: TITLE_KEY, p: POLL_KEY });
    await page.keyboard.press("Escape"); dialog = await openSettings(page);
    await dialog.getByRole("button", { name: "Polyforge", exact: true }).click();
    await waitFor(async () => (await numberInputs(dialog)).length >= 2, "the controls after reload");
    const clamped = await numberInputs(dialog);
    assert.deepEqual([clamped.find((c) => c.min === "10").value, clamped.find((c) => c.min === "1").value], ["200", "60"],
      "out-of-range stored values clamp to their bounds");
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-web:polyforge-poll-interval")), "999", "the setting is browser-stored only");
  }));

  await check("S16", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const node = card(page, A.work_item_id); await node.waitFor({ timeout: 30_000 });
    assert.ok(!(await node.innerText()).includes("GOALTAIL"), "default truncation hides the tail");
    const dialog = await openSettings(page);
    await dialog.getByRole("button", { name: "Polyforge", exact: true }).click();
    await waitFor(async () => (await numberInputs(dialog)).length >= 2, "the title-length control");
    const title = dialog.locator('input[type="number"][min="10"]').first();
    await title.fill("90");
    await title.locator("xpath=following::button[1]").click();
    await waitFor(async () => (await page.evaluate((key) => localStorage.getItem(key), TITLE_KEY)) === "90", "the title length is saved");
    await dialog.getByRole("button", { name: /^close$/i }).first().click();
    if (!(await dock(page).isVisible().catch(() => false))) await openDock(page);
    await waitFor(async () => (await card(page, A.work_item_id).innerText()).includes("GOALTAIL"), "the new length applies without a page reload", 8_000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("E2E pf cards host session").first().waitFor({ state: "attached", timeout: NAV_MS });
    await openDock(page); await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    assert.ok((await card(page, A.work_item_id).innerText()).includes("GOALTAIL"), "the stored value is used after a reload");
  }));

  // S17: at the default 3 s cadence one tick — the queue
  // line's status poll plus the card poll — spawns exactly one
  // `pf ops status`: the server shares one read between the two routes.
  await check("S17", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); await card(page, A.work_item_id).waitFor({ timeout: 30_000 });
    const since = Date.now();
    const ticksAfter = () => {
      const requests = [...page.__statusRequests.map((r) => ({ at: r.at, kind: "status" })), ...page.__cardRequests.map((r) => ({ at: r.at, kind: "cards" }))]
        .filter((r) => r.at >= since).sort((a, b) => a.at - b.at);
      const groups = [];
      for (const request of requests) { if (!groups.length || request.at - groups.at(-1).at(-1).at > 1_000) groups.push([request]); else groups.at(-1).push(request); }
      // A tick is complete when both polls fired and the spawn window after it has passed.
      return groups.filter((group) => group.some((r) => r.kind === "status") && group.some((r) => r.kind === "cards") && Date.now() - group[0].at > 1_500);
    };
    await waitFor(() => ticksAfter().length >= 3, "three complete 3 s ticks", 20_000);
    const ticks = ticksAfter();
    const spawns = opsSpawns();
    for (const tick of ticks) {
      assert.equal(tick.length, 2, `one status and one card request per tick: ${tick.map((r) => r.kind)}`);
      const inTick = spawns.filter((at) => at >= tick[0].at - 500 && at <= tick[0].at + 1_500);
      assert.equal(inTick.length, 1, `one pf ops status spawn per tick, got ${inTick.length}`);
    }
  }));

  // S18 ( review s14#3): the card title is legible, not merely
  // in the DOM (innerText also counts text an overflow:hidden box clips). At
  // the 460px dock, the 375px sheet and the 340px dock the slug element is
  // not clipped (scrollWidth <= clientWidth + 1, and no ancestor up to the
  // card cuts its box) and the goal span (its `title` is the full goal) shows
  // a visible box inside the card. owner 有意变更:
  // the Jobs stream is ONE row of fixed 150px cards that scrolls horizontally
  // (the grid `repeat(auto-fill, minmax(150px, 1fr))` is gone), so every width
  // shows the same one-row / 150px-card / scrollable shape; the card geometry
  // stays pinned (no narration, 43px + the measured slug row),
  // with the card-A height bound stated against the measured slug row because
  // a 150px card wraps a 14-character slug.
  for (const [opts, label, measureHeight] of [[{ storage: { "pi-web:polyforge-dock-width": "460" } }, "460px dock", true],
    [{ viewport: { width: 375, height: 800 } }, "375px sheet", false], [{ storage: { "pi-web:polyforge-dock-width": "340" } }, "340px dock", true]]) {
    await check(`S18 ${label}`, () => withPage(opts, async (page) => {
      writeTranscripts(); await setOpsSettled([T, C, B, A]);
      await openDock(page); const node = card(page, A.work_item_id); await node.waitFor({ timeout: 30_000 });
      await waitFor(async () => (await node.innerText()).includes("E2E-GOAL-START"), "the card read's goal renders", 30_000);
      const geometry = await node.evaluate((el, { slug, goal }) => {
        /** The part of `target`'s box no overflow-clipping ancestor up to the card cuts. */
        const visible = (target) => {
          const box = target.getBoundingClientRect();
          let left = box.left, right = box.right, top = box.top, bottom = box.bottom;
          for (let node = target.parentElement; node; node = node === el ? null : node.parentElement) {
            const style = getComputedStyle(node);
            if (style.overflowX === "visible" && style.overflowY === "visible") continue;
            const clip = node.getBoundingClientRect();
            left = Math.max(left, clip.left); right = Math.min(right, clip.right);
            top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom);
          }
          return { full: { width: box.width, height: box.height }, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
        };
        const slugNode = [...el.querySelectorAll("*")].find((child) => child.children.length === 0 && (child.textContent ?? "").trim() === slug);
        const goalNode = [...el.querySelectorAll("[title]")].find((child) => child.getAttribute("title") === goal);
        return {
          slug: slugNode ? { scrollWidth: slugNode.scrollWidth, clientWidth: slugNode.clientWidth, ...visible(slugNode) } : null,
          slugRow: slugNode?.parentElement ? slugNode.parentElement.getBoundingClientRect().height : null,
          goal: goalNode ? visible(goalNode) : null,
        };
      }, { slug: A.slug, goal: GOAL });
      assert.ok(geometry.slug, `${label}: the slug has an element of its own`);
      assert.ok(geometry.slug.scrollWidth <= geometry.slug.clientWidth + 1, `${label}: the slug element does not clip its text (${JSON.stringify(geometry.slug)})`);
      assert.ok(geometry.slug.width >= geometry.slug.full.width - 1 && geometry.slug.height >= geometry.slug.full.height - 1,
        `${label}: no ancestor cuts the slug (${JSON.stringify(geometry.slug)})`);
      assert.ok(geometry.goal, `${label}: the goal span renders`);
      assert.ok(geometry.goal.width > 0 && geometry.goal.height > 0, `${label}: the goal shows a visible box inside the card (${JSON.stringify(geometry.goal)})`);
      // the denser card, falsifiable on the old geometry (measured
      // at a63cedea: card A 112px, goal span 36px, needs_input badge 20.5px).
      // The goal span keeps its two 16px lines (+1px tolerance) — 32px now.
      assert.ok(geometry.goal.height <= 33, `${label}: the goal span is ${geometry.goal.height}px, over the 2×16px clamp (+1px) (${JSON.stringify(geometry.goal)})`);
      // A needs_input card's badge no longer inflates its slug row: 14px line
      // + 1px border = 16px (old badge: 11px × 1.5 + 2px padding + 2px border ≈ 20.5px).
      // The slug row itself is max(badge, the slug's own 16px lines); a fixed
      // card leaves the slug a narrow column beside the status label, so B's
      // 14-character slug may wrap to two 16px lines — inside the ≤33px
      // allowance for the card (one-column 340 dock included). owner 有意変更
      // the card is 180px now, so the slug has more room; the
      // bound follows the measured row either way.
      const needsB = await card(page, B.work_item_id).evaluate((el, slug) => {
        const box = (target) => (target ? target.getBoundingClientRect().height : null);
        const slugNode = [...el.querySelectorAll("*")].find((child) => child.children.length === 0 && (child.textContent ?? "").trim() === slug);
        return { row: box(slugNode?.parentElement ?? null), badge: box(el.querySelector("[data-pf-needs-input]")) };
      }, B.slug);
      assert.ok(needsB.row !== null, `${label}: the needs_input card's slug row renders`);
      assert.ok(needsB.badge !== null && needsB.badge <= 17, `${label}: the needs_input badge is ${needsB.badge}px, over the 17px bound`);
      // Measured at 150px cards: badge 16px, slug row 32px. a
      // running label with a 4-digit minute age narrows the slug beside it, so
      // card A's slug may wrap to a 3rd 16px line; the row stays a whole number
      // of 16px lines and the height bound below follows the measured row.
      assert.ok(needsB.row <= 33, `${label}: the needs_input slug row is ${needsB.row}px, over 33px (16px badge; one wrapped 2-line slug at a 150px card)`);
      assert.ok(geometry.slugRow >= 16 && geometry.slugRow % 16 === 0,
        `${label}: card A's slug row is a whole number of 16px lines (${geometry.slugRow})`);
      // a running card's age is whole minutes, computed from the
      // card's earliest job_started (A has a job_started at at(0)); ±1 absorbs a
      // minute rollover during the run. owner 有意变更 the
      // visible status text is the duration alone (`23m`, matching ^\d+m$ and
      // no status word); the full `<status word> <n>m` stays in the element's
      // title and the card's aria-label. A non-running card (B, needs_input)
      // keeps its status text and has no duration.
      const expectedMinutes = Math.floor((Date.now() - Date.parse(at(0))) / 60_000);
      const runningStatus = await cardStatus(page, A.work_item_id);
      assert.match(runningStatus.text, /^\d+m$/, `${label}: the running card's visible status is the duration alone (got ${JSON.stringify(runningStatus.text)})`);
      assert.doesNotMatch(runningStatus.text, /running|运行中/i, `${label}: no status word in the running card's visible status (got ${JSON.stringify(runningStatus.text)})`);
      const minutes = Number(runningStatus.text.slice(0, -1));
      assert.ok(Math.abs(minutes - expectedMinutes) <= 1,
        `${label}: the running label shows ${expectedMinutes}m from the fixture's job_started (got ${JSON.stringify(runningStatus.text)})`);
      assert.match(runningStatus.title, /^Running \d+m$/, `${label}: the status element's title carries the full status (${runningStatus.title})`);
      assert.match(runningStatus.aria, new RegExp(`^${A.slug} · Running \\d+m$`), `${label}: the card aria-label carries the full status (${runningStatus.aria})`);
      const nonRunningStatus = await cardStatus(page, B.work_item_id);
      assert.doesNotMatch(nonRunningStatus.text, /^\d+m$/, `${label}: a non-running card shows no duration (${JSON.stringify(nonRunningStatus.text)})`);
      if (measureHeight) {
        // The docks (460px and 340px) measure card A's whole height. owner 有意变更
        //（fix228-card-height， reverses the 32px
        // narration）: no narration area, card-only padding 4px and no slug/goal
        // gap, so — 2 border + 8 padding + slug row + 32 goal = 42 + slug row
        // (58px for a one-line slug, 74px for the wrapped two-line row) — the
        // bound is 43 + the measured slug row. The old 100px/117px card fails
        // it, and so does one that only removed the narration (64px/80px).
        const cardHeight = await node.evaluate((el) => el.offsetHeight);
        const bound = 43 + geometry.slugRow;
        assert.ok(cardHeight <= bound, `${label}: card A is ${cardHeight}px, over the ${bound}px card geometry (43px + its ${geometry.slugRow}px slug row)`);
      }
      // one row of fixed-width cards that scrolls left and right
      // (old: N tracks of `repeat(auto-fill, minmax(150px, 1fr))` per width).
      // owner 有意变更 that fixed width is 180px, decoupled from
      // the Tasks grid's own 150px column minimum.
      const row = await node.evaluate((el) => {
        const container = el.parentElement;
        const box = el.getBoundingClientRect();
        return { width: box.width, basis: getComputedStyle(el).flexBasis, gap: getComputedStyle(container).gap,
          clientWidth: container.clientWidth, scrollWidth: container.scrollWidth,
          overflowX: getComputedStyle(container).overflowX, scrollbarWidth: getComputedStyle(container).scrollbarWidth };
      });
      assert.ok(Math.abs(row.width - 180) <= 0.5, `${label}: a job card is a fixed 180px wide (${row.width}) (owner 有意变更)`);
      assert.equal(row.basis, "180px", `${label}: the card width is the 180px flex basis, not a stretched track (${row.basis}) (owner 有意变更)`);
      assert.equal(row.gap, "8px", `${label}: the card gap is the unchanged 8px (${row.gap})`);
      assert.equal(row.overflowX, "auto", `${label}: the card row scrolls horizontally (${row.overflowX})`);
      assert.equal(row.scrollbarWidth, "thin", `${label}: the row's scrollbar stays visible but thin (${row.scrollbarWidth})`);
      assert.ok(row.scrollWidth > row.clientWidth, `${label}: the row overflows and can be scrolled (${row.scrollWidth}/${row.clientWidth})`);
      const shape = await dock(page).locator("[data-pf-card-wi]").evaluateAll((nodes) => ({
        rows: new Set(nodes.map((el) => Math.round(el.getBoundingClientRect().y))).size,
        widths: nodes.map((el) => el.getBoundingClientRect().width),
        order: nodes.map((el) => el.getAttribute("data-pf-card-wi")),
      }));
      assert.equal(shape.rows, 1, `${label}: every job card sits on one row (${JSON.stringify(shape)})`);
      assert.ok(shape.widths.every((width) => Math.abs(width - 180) <= 0.5), `${label}: every card is 180px wide (${JSON.stringify(shape.widths)}) (owner 有意变更)`);
      assert.equal(new Set(shape.order).size, shape.order.length, `${label}: the cards keep one DOM node each (${JSON.stringify(shape.order)})`);
      // Scrolled to the row's end the last card is fully visible (its box inside
      // the row's viewport, nothing clipped) and the row has really moved.
      const end = await node.evaluate((el) => {
        const container = el.parentElement;
        container.scrollLeft = container.scrollWidth;
        const cards = [...container.querySelectorAll("[data-pf-card-wi]")];
        const last = cards.at(-1).getBoundingClientRect(); const clip = container.getBoundingClientRect();
        return { scrollLeft: container.scrollLeft, lastLeft: last.left, lastRight: last.right, clipLeft: clip.left, clipRight: clip.right };
      });
      assert.ok(end.scrollLeft > 0, `${label}: the card row scrolls to the end (${end.scrollLeft})`);
      assert.ok(end.lastRight <= end.clipRight + 1 && end.lastLeft >= end.clipLeft - 1,
        `${label}: scrolled to the end the last card is fully visible (${JSON.stringify(end)})`);
      // the 3 s card poll never resets the row's scroll position
      // (the cards keep their keys, so nothing re-mounts).
      const polls = page.__cardRequests.length;
      await waitFor(() => page.__cardRequests.length >= polls + 2, "two card polls after the scroll", 20_000);
      const after = await node.evaluate((el) => el.parentElement.scrollLeft);
      assert.ok(Math.abs(after - end.scrollLeft) <= 1, `${label}: a card poll keeps the scroll position (${after}/${end.scrollLeft})`);
    }));
  }
} catch (error) {
  failures.push("suite");
  console.log(`FAIL suite: ${String(error?.message ?? error).split("\n")[0]}`);
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  await stop();
  if (failures.length) console.log(`\nFAILED ${failures.join(", ")} — ${failures.length} scenario(s) red`);
  else console.log("\nPASS all authored card-stream scenarios");
  console.log(`server log: ${join(work, "server.log")}`);
}
if (failures.length) process.exitCode = 1;
