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
const GOAL = `E2E-GOAL-START-${"G".repeat(40)}-GOALTAIL`;
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
const A = job("wi_E2EcardsA01", "", "running", 3, 125, 4, "pi:e2e/card-model");
const B = job("wi_E2EcardsB01", "", "needs_input", 1, 61, 9, "claude:e2e/card-model");
const T = job("wi_E2EcardsB02", "", "paused", 2, 900, 880, "codex:e2e/card-model");
const C = job("wi_E2EcardsC01", "", "queued", 0, 0, 12, "pi:e2e/c-model");
const D = job("wi_E2EcardsD01", "", "queued", 0, 0, 30, "pi:e2e/no-item");
const E = job("wi_E2EcardsE01", "", "running", 1, 5, 1, "pi:e2e/new");
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
  await page.goto(session ? `${base}/?session=${SESSION}` : `${base}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByText("E2E pf cards host session").first().waitFor({ state: "attached", timeout: 90_000 });
  return page;
}
const withPage = async (opts, fn) => { const page = await openPage(opts); try { return await fn(page); } finally { await page.context().close(); } };
const dock = (page) => page.locator("#polyforge-dock").or(page.getByRole("dialog", { name: /polyforge/i })).first();
const pfButton = (page) => page.getByRole("button", { name: /^(?!.*close).*polyforge/i }).first();
const openDock = async (page) => {
  // At ≤480px the app folds the Polyforge button behind the toolbar's More toggle.
  const more = page.locator('[data-mobile-toolbar-more="true"]');
  if ((await pfButton(page).count()) === 0 && (await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await pfButton(page).click(); await dock(page).waitFor({ timeout: 20_000 }); return dock(page);
};
const card = (page, wi) => dock(page).locator(`[data-pf-card-wi="${wi}"]`);
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
    const expected = [[A.work_item_id, /running/i], [B.work_item_id, /needs input/i],
      [T.work_item_id, /paused/i], [C.work_item_id, /queued/i]];
    for (const [wi, label] of expected) assert.match(await card(page, wi).innerText(), label, `${wi} status label`);
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
    assert.ok(!text.includes("GOALTAIL"), `the default 30-character truncation hides the tail: ${text}`);
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
    await page.getByText("E2E pf cards host session").first().waitFor({ state: "attached", timeout: 90_000 });
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
    const nodes = (await items.allInnerTexts()).map((value) => value.replace(/\s+/g, " ").trim());
    let last = -1;
    for (const id of A_STEP_IDS) { const i = nodes.findIndex((value) => value.startsWith(id)); assert.ok(i > last, `the detail lists ${id} in workflow order`); last = i; }
    const nodeText = (id) => nodes.find((value) => value.startsWith(id)) ?? "";
    // + #173: a skipped step reads skipped as visible text, never unknown/unstarted.
    assert.match(nodeText("step-skip"), /skipped|已跳过/i, `a skipped step shows the skipped label (got ${JSON.stringify(nodeText("step-skip"))})`);
    assert.doesNotMatch(nodeText("step-skip"), /未知|unknown|—|pending/i, "a skipped step is neither unknown nor unstarted");
    assert.match(nodeText("step-review"), /pending/i, "a not-started step reads as such");
    assert.match(nodeText("step-code"), /in progress/i, "the current step is recognizable");
    const timingLine = (value, id) => value.split("\n").map((line) => line.trim()).find((line) => line.startsWith(id) && /\+\d/.test(line)) ?? "";
    await waitFor(async () => timingLine(await dock(page).innerText(), "step-code"), "the running step's timing row");
    const detail = await dock(page).innerText();
    assert.match(timingLine(detail, "step-plan"), /×2/, "a rerun step carries the rerun marker on its detail row");
    assert.doesNotMatch(timingLine(detail, "step-grill"), /×/, "a single-run step carries no rerun marker");
    assert.ok(!detail.split("\n").some((line) => line.trim().startsWith("step-nostart") && /\+\d/.test(line)), "a step with no readable start shows no fabricated duration");
    assert.doesNotMatch(detail, /NaN/, "no NaN duration");
    const first = timingLine(detail, "step-code");
    await waitFor(async () => { const line = timingLine(await dock(page).innerText(), "step-code"); return line && line !== first; },
      "the running step's duration grows with the detail's refresh", 12_000);
  }));

  await check("S8", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const aCard = card(page, A.work_item_id); const bCard = card(page, B.work_item_id);
    await aCard.waitFor({ timeout: 30_000 }); await bCard.waitFor({ timeout: 30_000 });
    await waitFor(async () => (await aCard.innerText()).includes("A-PROGRESS-240"), "pi progress");
    await waitFor(async () => (await bCard.innerText()).includes("CLAUDE-VISIBLE-ASSISTANT"), "claude progress");
    appendA([piText("A-PROGRESS-BETA")]);
    await waitFor(async () => (await aCard.innerText()).includes("A-PROGRESS-BETA"), "the appended entry reaches the card");
    const beta = await waitFor(() => page.__cardResponses.find((response) => response.text.includes("A-PROGRESS-BETA")), "the increment response");
    assert.ok(!beta.text.includes("A-PROGRESS-240"), "the increment response does not re-send earlier entries");
  }));

  await check("S9", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const bCard = card(page, B.work_item_id); await bCard.waitFor({ timeout: 30_000 });
    // (owner-approved intentional change ②): the card shows
    // assistant narration only — neither a tool name nor a command/argument
    // reaches the DOM or the response; masking still holds for narration.
    appendA([piText("A-NARRATION token=PI-SECRET-TOKEN masked")]);
    await waitFor(async () => (await card(page, A.work_item_id).innerText()).includes("A-NARRATION"), "the credential-bearing narration reaches the card");
    const dom = `${await bCard.innerText()}\n${await card(page, A.work_item_id).innerText()}`;
    assert.ok(dom.includes("CLAUDE-VISIBLE-ASSISTANT"), "assistant text is shown");
    assert.doesNotMatch(dom, /bash|printf/, "neither the tool name nor its command is shown");
    assert.match(dom, /token=\*\*\*/, "the credential in narration is masked");
    for (const secret of ["CLAUDE-SECRET-TOOL-RESULT", "CLAUDE-SECRET-THINKING", "CLAUDE-SECRET-PROMPT", "CLAUDE-SECRET-TOKEN",
      "PI-SECRET-TOOL-RESULT", "PI-SECRET-THINKING", "PI-SECRET-USER-PROMPT", "PI-SECRET-TOKEN"]) assert.ok(!dom.includes(secret), `the DOM leaks ${secret}`);
    const response = await fetch(`${base}${CARDS}`, { signal: AbortSignal.timeout(30_000) });
    const text = await response.text(); assert.equal(response.status, 200);
    for (const secret of ["CLAUDE-SECRET-TOOL-RESULT", "CLAUDE-SECRET-THINKING", "CLAUDE-SECRET-PROMPT", "CLAUDE-SECRET-TOKEN",
      "PI-SECRET-TOOL-RESULT", "PI-SECRET-THINKING", "PI-SECRET-USER-PROMPT", "PI-SECRET-TOKEN"]) assert.ok(!text.includes(secret), `the route leaks ${secret}`);
    assert.ok(text.includes("CLAUDE-VISIBLE-ASSISTANT") && text.includes("token=***"), "the same fixture still shows the whitelisted content");
    assert.ok(!/bash|printf|"kind":"tool"/.test(text), "the route carries no tool entry, name or command");
  }));

  await check("S10", () => withPage({}, async (page) => {
    setOps([T, C, B, A]); writeTranscripts();
    await openDock(page); const node = card(page, C.work_item_id); await node.waitFor({ timeout: 30_000 });
    await waitFor(async () => /unavailable|不可用/i.test(await node.innerText()), "the localized unavailable state");
    assert.ok((await node.innerText()).includes(C.slug), "the rest of the card still renders");
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
    await waitFor(async () => (await node.innerText()).includes("A-PROGRESS-240"), "the newest page");
    let text = await node.innerText();
    assert.ok(!text.includes("A-PROGRESS-220"), "the first load starts at the newest ~20 entries");
    const region = await node.evaluate((el) => {
      for (const child of [el, ...el.querySelectorAll("*")]) {
        const style = getComputedStyle(child);
        if (/(auto|scroll)/.test(style.overflowY) && child.scrollHeight > child.clientHeight + 8) return { height: child.clientHeight, scroll: child.scrollHeight };
      }
      return null;
    });
    assert.ok(region, "the progress area scrolls on its own"); assert.ok(region.height <= 96, `the progress area is about three lines (${region.height}px)`);
    appendA(Array.from({ length: 220 }, (_, i) => piText(`A-PROGRESS-${String(241 + i).padStart(3, "0")}`)));
    await waitFor(async () => (await node.innerText()).includes("A-PROGRESS-460"), "the newest increment", 25_000);
    // a bounded wait for the retention predicate, not a fixed window.
    await waitFor(async () => {
      const current = await node.innerText();
      const seen = current.match(/A-PROGRESS-\d{3}/g) ?? [];
      return seen.length > 0 && seen.length <= 200 && !current.includes("A-PROGRESS-221");
    }, "the retained window settles at ≤200 entries with the oldest evicted", 25_000);
    text = await node.innerText();
    const markers = text.match(/A-PROGRESS-\d{3}/g) ?? [];
    assert.ok(markers.length > 0 && markers.length <= 200, `at most 200 entries are retained (${markers.length})`);
    assert.equal(new Set(markers).size, markers.length, "no duplicate entry");
    assert.ok(!text.includes("A-PROGRESS-221"), "the oldest entries are evicted");
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
    assert.deepEqual([title.value, poll.value], ["30", "3"], "corrupt stored values fall back to the defaults");
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
    await page.getByText("E2E pf cards host session").first().waitFor({ state: "attached", timeout: 90_000 });
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
  // a visible box inside the card.
  for (const [opts, label] of [[{ storage: { "pi-web:polyforge-dock-width": "460" } }, "460px dock"],
    [{ viewport: { width: 375, height: 800 } }, "375px sheet"], [{ storage: { "pi-web:polyforge-dock-width": "340" } }, "340px dock"]]) {
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
          goal: goalNode ? visible(goalNode) : null,
        };
      }, { slug: A.slug, goal: GOAL });
      assert.ok(geometry.slug, `${label}: the slug has an element of its own`);
      assert.ok(geometry.slug.scrollWidth <= geometry.slug.clientWidth + 1, `${label}: the slug element does not clip its text (${JSON.stringify(geometry.slug)})`);
      assert.ok(geometry.slug.width >= geometry.slug.full.width - 1 && geometry.slug.height >= geometry.slug.full.height - 1,
        `${label}: no ancestor cuts the slug (${JSON.stringify(geometry.slug)})`);
      assert.ok(geometry.goal, `${label}: the goal span renders`);
      assert.ok(geometry.goal.width > 0 && geometry.goal.height > 0, `${label}: the goal shows a visible box inside the card (${JSON.stringify(geometry.goal)})`);
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
