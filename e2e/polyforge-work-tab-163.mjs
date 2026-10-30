// — Polyforge dock: the carried Work-tab base (Jobs + Tasks,
// sub-tabs, badges, durations, filters, empty states, anchors) plus the owner's
// card-form ruling: compact side-by-side job/task grids, key-information job
// cards with no step information, the needs-input marker, and the DAG step
// graph (states, durations, reruns) in the opened job detail.
//
// Authored pre-code against artifacts/spec.md and the carried
// artifacts/carried-163/e2e-scenarios.md; the capsule's artifacts/e2e-scenarios.md
// carries the GIVEN/WHEN/THEN blocks, the scenario titles and the baseline
// evidence. The suite starts its own `next dev` on a stub `pf` and a throwaway
// daemon data root holding the job/capsule/transcript fixtures; every pf argv
// is appended to a ledger, so read discipline is asserted, not assumed.
//
// Baseline posture: the baseline a7dc872e predates the #163 carry, so there is
// no Work tab, no sub-tab rail, no card grid and no detail step graph yet;
// every kept scenario is assertion-level RED. Each passing scenario prints
// `PASS S<n>` (the binding marker).
//
//   node --experimental-strip-types e2e/polyforge-work-tab-163.mjs
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
const work = mkdtempSync(join(tmpdir(), "pi-web-pf-work-e2e-"));
const home = join(work, "home");
const agentDir = join(home, ".pi", "agent");
const project = join(work, "project");
const dataRoot = join(home, ".local", "share", "polyforge");
const SESSION = "e2e-pf-work-session";
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project);
mkdirSync(dataRoot, { recursive: true });
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), [
  { type: "session", version: 3, id: SESSION, timestamp: "2026-10-30T02:00:00.000Z", cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: "2026-10-30T02:00:00.000Z", message: { role: "user", content: "E2E pf work host session" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

// ---- daemon jobs: two cards, one narrated (A), one narration-free (B) ----
const A = { wi: "wi_E2EworkTabA1", slug: "" };
const B = { wi: "wi_E2EworkTabB1", slug: "" };
const GOAL = `E2E-GOAL-START-${"G".repeat(40)}-GOALTAIL`;
const EPOCH = "2026-10-30T02:00:00.000Z";
const at = (min) => new Date(Date.parse(EPOCH) + min * 60_000).toISOString();
const capsule = (j) => join(work, "capsules", j.wi);
const pi = (id, content) => ({ type: "message", id, parentId: null, timestamp: EPOCH, message: { role: "assistant", content } });
const result = (id, text) => ({ type: "message", id, parentId: null, timestamp: EPOCH, message: { role: "toolResult", content: [{ type: "text", text }], toolName: "bash" } });
const prompt = (id, text) => ({ type: "message", id, parentId: null, timestamp: EPOCH, message: { role: "user", content: text } });

function writeCapsule(j, { goal, steps, statuses, current, transcript }) {
  const dir = capsule(j);
  mkdirSync(join(dir, "runtime-state"), { recursive: true });
  mkdirSync(join(dir, "workflows", "feature-full"), { recursive: true });
  mkdirSync(join(dir, "session"), { recursive: true });
  writeFileSync(join(dir, "capsule.json"), `${JSON.stringify({ work_item_id: j.wi, bundle_name: "feature-full", project: "workbench" })}\n`);
  writeFileSync(join(dir, "workflows", "feature-full", "workflow.md"), `---\nname: feature-full\nsteps:\n${steps.map((id) => `  - { id: ${id} }`).join("\n")}\n---\n`);
  writeFileSync(join(dir, "runtime-state", "work-item.json"), `${JSON.stringify({ id: j.wi, slug: j.slug, project: "workbench", goal })}\n`);
  writeFileSync(join(dir, "runtime-state", "execution.json"), `${JSON.stringify({ current_step: current, workflow_status: "running", steps: statuses })}\n`);
  const transcriptPath = join(dir, "session", "session-e2e.jsonl");
  writeFileSync(transcriptPath, transcript.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"),
    `${JSON.stringify({ at: at(0.55), work_item: j.wi, step_id: current, started_at: at(0.55), transcript: transcriptPath, harness: "pi", spawn_n: 1 })}\n`);
  return transcriptPath;
}

const A_STEPS = ["step-grill", "step-spec", "step-code", "step-review", "step-skip", "step-mystery"];
const stepStartedAt = (offsetSec) => new Date(Date.now() + offsetSec * 1_000).toISOString();
const aTranscript = writeCapsule(A, {
  goal: GOAL, steps: A_STEPS, current: "step-code",
  statuses: { "step-grill": { status: "done", step_started_at: stepStartedAt(-300) }, "step-spec": { status: "done", step_started_at: stepStartedAt(-240) },
    "step-code": { status: "in_progress", step_started_at: stepStartedAt(-5) }, "step-review": { status: "pending" },
    "step-skip": { status: "skipped" }, "step-mystery": { status: "mystery" } },
  transcript: [pi("a1", [{ type: "text", text: "A-PROGRESS-001" }]), pi("a2", [{ type: "text", text: "A-PROGRESS-002" }]),
    pi("a3", [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "printf --token=PI-SECRET-TOKEN" } }]), result("a4", "PI-SECRET-TOOL-RESULT"),
    pi("a5", [{ type: "thinking", thinking: "PI-SECRET-THINKING" }]), prompt("a6", "PI-SECRET-USER-PROMPT"), pi("a7", [{ type: "text", text: "A-PROGRESS-LAST" }])],
});
const bTranscript = writeCapsule(B, {
  goal: "E2E-B-GOAL", steps: ["step-code"], current: "step-code", statuses: { "step-code": { status: "in_progress", step_started_at: stepStartedAt(-10) } },
  transcript: [pi("b1", [{ type: "toolCall", id: "tc2", name: "edit", arguments: { path: "/tmp/E2E-COMMAND-ARG" } }]),
    pi("b2", [{ type: "thinking", thinking: "B-SECRET-THINKING" }]), prompt("b3", "B-SECRET-PROMPT")],
});
const ev = (j, min, kind, body) => ({ at: at(min), kind, work_item: j.wi, body, seq: 1 });
// The watch snapshot the detail reads: declared order, per-step state, a
// skipped step, an unknown status, a rerun (two step-spec runs), a rewind and
// live per-step start times (the running step is 5 s old at seed time, so its
// duration advances at second granularity on the next watch refresh).
function watchFixture() {
  const now = Date.now();
  const started = (offsetSec) => new Date(now + offsetSec * 1_000).toISOString();
  const events = [
    { at: at(0), kind: "job_started" },
    { at: at(0.1), kind: "step_started", step: "step-grill" }, { at: at(0.2), kind: "step_done", step: "step-grill" },
    { at: at(0.3), kind: "step_started", step: "step-spec" }, { at: at(0.4), kind: "step_done", step: "step-spec" },
    { at: at(0.45), kind: "step_started", step: "step-spec" }, { at: at(0.5), kind: "step_done", step: "step-spec" },
    { at: at(0.55), kind: "step_started", step: "step-code" },
    { at: at(0.8), kind: "rewind", body: { gate: "step-review", target: "step-spec" } }, // pf nests gate/target in body (D4)
  ];
  return {
    [A.wi]: { known: true, work_item: A.wi, slug: A.slug, execution: { workflow_status: "running", current_step: "step-code", updated_at: new Date(now).toISOString(),
      steps: { "step-grill": { status: "done", started_at: started(-300) }, "step-spec": { status: "done", started_at: started(-240) },
        "step-code": { status: "in_progress", started_at: started(-5) }, "step-review": { status: "pending" },
        "step-skip": { status: "skipped" }, "step-mystery": { status: "mystery" } },
      declared_steps: A_STEPS.map((id) => ({ id })) }, events },
    [B.wi]: { known: true, work_item: B.wi, slug: B.slug, execution: { workflow_status: "needs_input", current_step: "step-code", updated_at: new Date(now).toISOString(),
      steps: { "step-code": { status: "in_progress", started_at: started(-10) } }, declared_steps: [{ id: "step-code" }] }, events: [] },
  };
}
mkdirSync(join(dataRoot, "events"), { recursive: true });
writeFileSync(join(dataRoot, "events", `wi-${A.wi}.jsonl`), [
  ev(A, 0, "job_started", { spawn_n: 1 }), ev(A, 0.1, "step_started", { step: "step-grill" }), ev(A, 0.2, "step_done", { step: "step-grill" }),
  ev(A, 0.3, "step_started", { step: "step-spec" }), ev(A, 0.4, "step_done", { step: "step-spec" }),
  ev(A, 0.45, "step_started", { step: "step-spec" }), ev(A, 0.5, "step_done", { step: "step-spec" }),
  ev(A, 0.55, "step_started", { step: "step-code" }),
].map((row) => JSON.stringify(row)).join("\n") + "\n");
writeFileSync(join(dataRoot, "events", `wi-${B.wi}.jsonl`), `${JSON.stringify(ev(B, 1, "job_started", { spawn_n: 1 }))}\n`);
writeFileSync(join(dataRoot, "runtime-state.json"), `${JSON.stringify({ version: 1, jobs: [
  { work_item_id: A.wi, project: "workbench", slug: A.slug, state: "running", capsule_dir: capsule(A), bundle_name: "feature-full", spawn_n: 1, transcript: aTranscript },
  { work_item_id: B.wi, project: "workbench", slug: B.slug, state: "running", capsule_dir: capsule(B), bundle_name: "feature-full", spawn_n: 1, transcript: bTranscript },
] })}\n`);

// ---- tasks, memory and messages fixtures ----
const T1 = "task_00000000000000a1", T2 = "task_00000000000000b2", T3 = "task_00000000000000c3";
// The block locators: a task block must show its prompt summary, not its id.
const M1 = "TASK-ONE-ALPHA", M2 = "TASK-TWO-BRAVO", M3 = "TASK-THREE-CHARLIE";
const ENDED = new Date(Date.now() - 120_000).toISOString();
const task = (id, projectName, state, summary, extra = {}) => ({
  id, spec: { project: projectName, max_duration_ns: 1_200_000_000_000, max_tokens: 1_000_000, prompt: `PROMPT-${id}` },
  state, prompt_summary: summary, candidate: "pi:e2e/task-model", created_at: EPOCH, tokens_consumed: 12_345, delivered: false,
  started_at: extra.started_at, ended_at: extra.ended_at, wall_consumed_ns: extra.wall_consumed_ns ?? 0,
});
// Fresh per seed: the running task started five seconds ago, so the block's
// client tick is visible at second granularity in any duration format.
const taskRows = () => {
  const started = new Date(Date.now() - 5_000).toISOString();
  return [
    task(T1, "workbench", "running", `${M1} run the long job`, { started_at: started }),
    task(T2, "polyforge", "completed", `${M2} finished report`, { started_at: EPOCH, ended_at: ENDED, wall_consumed_ns: 42_000_000_000 }),
    task(T3, "workbench", "failed", `${M3} broke`, { started_at: EPOCH, ended_at: ENDED, wall_consumed_ns: 10_000_000_000 }),
  ];
};
const TASK_DETAIL = {
  ...taskRows()[1], spec: { ...taskRows()[1].spec, prompt: "TASK-DETAIL-PROMPT", candidates: ["pi:e2e/task-model"] },
  report: "TASK-DETAIL-REPORT", report_len: 18, truncated: false,
};
const MEMORY = { id: "mem_E2EworkAnchor01", project_id: "prj_e2e", owner_user_id: "u_peer", work_item_id: A.wi, type: "doc.note",
  title: "E2E-ANCHOR-MEMORY", visibility: "project", tags: [], related: [], status: "active", created_at: EPOCH, updated_at: EPOCH,
  content_len: 18, content: "E2E memory anchor" };
const CONVERSATION = { id: "conv_e2e0001", kind: "direct", members: ["u_e2e", "u_peer"], member_names: { u_peer: "E2E-PEER" }, last_seq: 1, unread: 0, created_at: EPOCH };
const MESSAGES = [{ id: "msg_e2e0001", seq: 1, text: "E2E-ANCHOR-MESSAGE", about_wi: A.wi, sender_id: "u_peer", created_at: EPOCH }];
const STATUS_JOBS = [
  { work_item_id: A.wi, slug: A.slug, status: "running", spawn_n: 3, step_age_sec: 125, last_work_ago_sec: 4, candidate: "pi:e2e/model-a" },
  { work_item_id: B.wi, slug: B.slug, status: "needs_input", spawn_n: 1, step_age_sec: 61, last_work_ago_sec: 9, candidate: "pi:e2e/model-b" },
];

// ---- stub pf ----
const stubDir = join(work, "stub-bin");
mkdirSync(stubDir);
const stateFile = join(stubDir, "state.json");
const argvLog = join(stubDir, "argv.log");
const fixture = (patch = {}) => ({ version: "v2.20.12", ws: project, jobs: STATUS_JOBS, queue: { running: 3, max_concurrent: 6 },
  tasks: { running: 1, completed: 2, capped: 0, failed: 1, interrupted: 0 }, taskRows: taskRows(), taskDetail: TASK_DETAIL, watch: watchFixture(),
  memories: [{ ...MEMORY, content_excerpt: MEMORY.content.slice(0, 80) }], memoryDetail: MEMORY, conversations: [CONVERSATION],
  messages: MESSAGES, ...patch });
const seed = (patch = {}) => { writeFileSync(stateFile, JSON.stringify(fixture(patch))); writeFileSync(argvLog, ""); };
const update = (patch = {}) => writeFileSync(stateFile, JSON.stringify(fixture(patch)));
seed();
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
if (rest[0] === "ops" && rest[1] === "status") out({ machine_id: "m-e2e", workspaces: [s.ws], jobs: s.jobs, queue: s.queue, tasks: s.tasks });
if (rest[0] === "config" && rest[1] === "workspace") out(flag("--cwd") === s.ws ? { mapped: true, workspace: s.ws } : { mapped: false, workspace: null });
if (rest[0] === "config" && rest[1] === "list") out({ items: [{ key: "user_id", value: "u_e2e", source: "file" }, { key: \`[workspace."\${s.ws}"]\`, value: "workbench", source: "file" }] });
if (rest[0] === "msg" && rest[1] === "list") out(flag("--conversation") ? { messages: s.messages, last_seq: 1 } : { conversations: s.conversations });
if (rest[0] === "msg" && rest[1] === "contacts") out({ contacts: [] });
if (rest[0] === "recall") out({ items: s.memories, total: s.memories.length });
if (rest[0] === "memory" && rest[1] === "show") out(s.memoryDetail);
if (rest[0] === "task" && rest[1] === "list") out({ tasks: s.taskRows, now: new Date().toISOString() });
if (rest[0] === "task" && rest[1] === "show") out(s.taskDetail);
if (rest[0] === "watch") out(s.watch[rest[1]] ?? Object.values(s.watch).find((w) => w.slug === rest[1])); // a card selects by slug (D3)
process.stderr.write("pf: unknown command\\n"); process.exit(2);
`);
chmodSync(join(stubDir, "pf"), 0o755);
const calls = () => readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).filter((a) => a !== "--json"));
const taskLists = () => calls().filter((a) => a[0] === "task" && a[1] === "list");

// ---- scenario bookkeeping and helpers ----
const failures = [];
async function check(id, fn) {
  try { await fn(); console.log(`PASS ${id}`); }
  catch (error) { failures.push(id); console.log(`FAIL ${id}: ${String(error?.message ?? error).split("\n")[0]}`); }
}
const RE_MEMORY = /记忆|memory/i, RE_MESSAGES = /消息|messages/i, RE_WORK = /工单|work/i, RE_JOBS = /作业|jobs/i, RE_TASKS = /任务|tasks/i;
const errors = [];
let browser; let base; let stop = async () => {};
async function openPage({ viewport = { width: 1280, height: 800 }, storage = {} } = {}) {
  const context = await browser.newContext({ viewport, locale: "zh-CN" });
  await context.addInitScript(({ prefs }) => {
    try { localStorage.setItem("pi-web:split-view-enabled", "false"); localStorage.setItem("pi-locale", "zh-CN");
      for (const [key, value] of Object.entries(prefs)) localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  }, { prefs: storage });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  page.__cards = []; page.__pf = [];
  await page.route((url) => url.pathname === BARRIER, (route) => route.fulfill({ status: 204 }));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/polyforge/cards") page.__cards.push(Date.now());
    if (pathname.startsWith("/api/polyforge/")) page.__pf.push(pathname);
  });
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.getByText("E2E pf work host session").first().waitFor({ state: "attached", timeout: 90_000 });
  return page;
}
const withPage = async (opts, fn) => { const page = await openPage(opts); try { return await fn(page); } finally { await page.context().close(); } };
const dock = (page) => page.locator("#polyforge-dock").or(page.getByRole("dialog", { name: /polyforge/i })).first();
const pfButton = (page) => page.getByRole("button", { name: /^(?!.*close).*polyforge/i }).first();
const topTabs = (page) => dock(page).locator('[role="tablist"]').first().getByRole("tab");
const topTab = (page, re) => topTabs(page).filter({ hasText: re }).first();
const subTab = (page, re) => dock(page).getByRole("tab", { name: re }).or(dock(page).getByRole("button", { name: re })).last();
const card = (page, wi) => dock(page).locator(`[data-pf-card-wi="${wi}"]`);
async function openDock(page) {
  // At ≤480px the app folds the Polyforge button behind the toolbar's More toggle.
  const more = page.locator('[data-mobile-toolbar-more="true"]');
  if ((await pfButton(page).count()) === 0 && (await more.count()) > 0 && (await more.getAttribute("aria-expanded")) !== "true") await more.click();
  await pfButton(page).click(); await dock(page).waitFor({ timeout: 20_000 }); return dock(page);
}
async function openWork(page, sub) {
  await openDock(page);
  await waitFor(async () => (await topTab(page, RE_WORK).count()) > 0, "a 工单 (Work) top-level tab exists", 20_000);
  await topTab(page, RE_WORK).click();
  if (sub) {
    await waitFor(async () => (await subTab(page, sub).count()) > 0, "the Work sub-tab control exists", 15_000);
    await subTab(page, sub).click();
  }
  return dock(page);
}
async function waitFor(fn, label, ms = 15_000) {
  const deadline = Date.now() + ms; let last;
  while (Date.now() < deadline) { try { last = await fn(); if (last) return last; } catch (error) { last = error.message; } await delay(200); }
  throw new Error(`${label} (last: ${last})`);
}
/**
 * bounded conditions instead of fixed absence windows. A
 * page-side ordering barrier (the e2e/machine-load.mjs pattern): the page
 * fetches a stubbed marker URL, so every request it issued before the marker
 * has been logged once the call returns.
 */
const BARRIER = "/__e2e_request_barrier";
const requestBarrier = (page) => page.evaluate(async (url) => { await fetch(url, { cache: "no-store" }); }, BARRIER);
const statusPolls = (page) => page.__pf.filter((pathname) => pathname === "/api/polyforge/status").length;
const taskListRequests = (page) => page.__pf.filter((pathname) => pathname === "/api/polyforge/tasks").length;
/**
 * Waits (bounded) for `n` more status polls, then the barrier. The open dock
 * polls status every 3 s, the default cards cadence too, so two more status
 * ticks span at least one full cards/status interval of page time: a read
 * a surface owed on that cadence would have been issued and logged by then.
 */
async function afterStatusPolls(page, n, label) {
  const seen = statusPolls(page);
  await waitFor(() => statusPolls(page) >= seen + n, `${label}: ${n} more status poll(s)`, 15_000);
  await requestBarrier(page);
}
/**
 * The page-side request log is complete up to the barrier; the stub's argv
 * ledger is written by the server's pf spawn, so it is read after the page
 * shows the request (bounded) or, for an absence, after the barrier proved
 * the page issued none.
 */
async function assertTaskListReads(page, expected, message) {
  assert.equal(taskListRequests(page), expected, `${message} (page requests)`);
  await waitFor(() => taskLists().length >= expected, `${message}: the pf ledger records ${expected} read(s)`, 10_000);
  assert.equal(taskLists().length, expected, message);
}
const isActive = async (locator) => (await locator.getAttribute("aria-selected")) === "true";
async function railBox(page) {
  const boxes = [await subTab(page, RE_JOBS).boundingBox(), await subTab(page, RE_TASKS).boundingBox()];
  if (boxes.some((box) => !box)) return null;
  const [a, b] = boxes;
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x),
    height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) };
}
// A task block is the clickable `data-pf-task` button (carried #163 convention).
const taskBlock = (page, id) => dock(page).locator(`[data-pf-task="${id}"]`).first();
async function block(page, id) {
  // Callers pass a task id or its prompt-summary text; the block is the
  // data-pf-task button holding that text (owner-authorized fix D1).
  const node = dock(page).locator("[data-pf-task]").filter({ hasText: id }).first();
  if (!(await node.count())) return null;
  const rect = await node.boundingBox();
  if (!rect) return null;
  return node.evaluate((el, rect) => {
    const summary = [...el.querySelectorAll("*")].find((child) => child.children.length === 0 && child.textContent.trim().startsWith("TASK-"));
    const style = summary ? getComputedStyle(summary) : null;
    const lineHeight = summary ? (parseFloat(style.lineHeight) || 16) : 0;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2,
      text: el.innerText, icon: Boolean(el.querySelector("svg,img,[role='img'],[aria-hidden='true']")),
      summaryLines: summary ? Math.round(summary.getBoundingClientRect().height / lineHeight) : 0 };
  }, rect);
}
const blockList = async (page, ids) => { const out = []; for (const id of ids) out.push(await block(page, id)); return out; };
const sameRow = (a, b) => Boolean(a && b) && Math.abs(a.y - b.y) < 4;
const gapX = (a, b) => Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
const overlap = (p, q) => p.x < q.x + q.width - 1 && q.x < p.x + p.width - 1 && p.y < q.y + q.height - 1 && q.y < p.y + p.height - 1;
// Computed-style rows of every leaf whose text matches `pattern`, used to
// prove the needs-input marker is visually distinct (not another dim status).
const labelStyles = (page, wi, pattern) => card(page, wi).evaluate((el, source) => {
  const re = new RegExp(source, "i");
  return [...el.querySelectorAll("*")].filter((node) => node.children.length === 0 && re.test((node.textContent ?? "").trim()))
    .map((node) => { const style = getComputedStyle(node); return { text: node.textContent.trim(), color: style.color,
      background: style.backgroundColor, weight: style.fontWeight, size: parseFloat(style.fontSize) }; });
}, pattern);
const firstOptionTexts = (select) => select.locator("option").allInnerTexts().then((rows) => rows.map((row) => row.trim()));
// Per-step duration row in the detail: the line naming `id` and carrying a `+<n>` duration.
const timingLine = (text, id) => text.split("\n").map((line) => line.trim()).find((line) => line.includes(id) && /\+\s*\d/.test(line)) ?? "";
// The visible marker node's box, constrained to its card (width/height > 0 and inside the card).
const markerBox = (page, wi, pattern) => card(page, wi).evaluate((el, source) => {
  const re = new RegExp(source, "i");
  const node = [...el.querySelectorAll("*")].find((child) => child.children.length === 0 && re.test((child.textContent ?? "").trim()));
  if (!node) return null;
  const box = node.getBoundingClientRect(); const parent = el.getBoundingClientRect();
  return { width: box.width, height: box.height, inside: box.x >= parent.x - 1 && box.x + box.width <= parent.x + parent.width + 1
    && box.y >= parent.y - 1 && box.y + box.height <= parent.y + parent.height + 1 };
}, pattern);

try {
  browser = await chromium.launch();
  const distDir = process.env.PI_WEB_DIST_DIR || ".next/e2e/polyforge-work-tab-163";
  rmSync(join(root, distDir), { force: true, recursive: true });
  const started = await startNextServer({ name: "polyforge-work-tab-163", logFile: join(work, "server.log"), env: { ...process.env,
    PI_WEB_DIST_DIR: distDir, PATH: `${stubDir}${delimiter}${process.env.PATH}`, HOME: home, POLYFORGE_DATA_DIR: dataRoot,
    PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_ALLOWED_ROOT_PREFIXES: work, POLYFORGE_V1_API_KEY: "" } });
  base = started.base; stop = started.stop;

  await check("S1", () => withPage({}, async (page) => {
    seed(); await openDock(page); await topTabs(page).first().waitFor({ timeout: 20_000 });
    const labels = (await topTabs(page).allInnerTexts()).map((text) => text.trim().split(/\s/)[0]);
    assert.equal(labels.length, 3, `exactly three top-level tabs, got ${JSON.stringify(labels)}`);
    // (owner 2026-10-30, intentional change, not a relaxation): 工单 | 记忆 | 消息.
    assert.ok(RE_WORK.test(labels[0]) && RE_MEMORY.test(labels[1]) && RE_MESSAGES.test(labels[2]), `DOM order 工单 | 记忆 | 消息: ${JSON.stringify(labels)}`);
    assert.equal(await topTabs(page).filter({ hasText: RE_JOBS }).count(), 0, "no 作业 top-level tab");
    assert.equal(await topTabs(page).filter({ hasText: RE_TASKS }).count(), 0, "no 任务 top-level tab");
  }));

  await check("S2", () => withPage({}, async (page) => {
    seed(); await openWork(page);
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    assert.ok(await isActive(topTab(page, RE_WORK)), "工单 is the active top-level tab");
    assert.equal(await dock(page).getByText(M1).count(), 0, "the task surface is not the default (作业 is)");
    await subTab(page, RE_TASKS).click(); await dock(page).getByText(M1).waitFor({ timeout: 30_000 });
    await dock(page).getByRole("button", { name: /close|关闭/i }).first().click();
    await waitFor(() => dock(page).isVisible().then((value) => !value), "the dock closes");
    await openDock(page);
    assert.ok(await isActive(topTab(page, RE_WORK)), "工单 is still active after a close/reopen");
    await dock(page).getByText(M1).waitFor({ timeout: 20_000 });
    assert.equal(await card(page, A.wi).count(), 0, "任务 is still the selected sub-tab");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("E2E pf work host session").first().waitFor({ state: "attached", timeout: 90_000 });
    await openWork(page);
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    assert.equal(await dock(page).getByText(M1).count(), 0, "a reload returns to the 作业 sub-tab");
  }));

  await check("S3", () => withPage({ storage: { "pi-web:polyforge-dock-width": "340" } }, async (page) => {
    seed(); await openWork(page); await card(page, A.wi).waitFor({ timeout: 30_000 });
    const rail = await railBox(page); const main = await card(page, A.wi).locator("xpath=..").boundingBox(); const dockBox = await dock(page).boundingBox(); // main = the card grid, not one card (D2)
    assert.ok(rail && main && dockBox, "the rail, main area and dock render");
    assert.ok(rail.width >= 48 && rail.width <= 100, `the rail is compact (~72px), got ${rail.width}`);
    assert.ok(rail.x >= main.x + main.width - 2, `the rail sits right of the main area (rail ${rail.x}, main end ${main.x + main.width})`);
    assert.ok(main.width >= dockBox.width * 0.55, `the main area keeps the remaining width (${main.width}/${dockBox.width})`);
    await withPage({ viewport: { width: 375, height: 800 } }, async (mobile) => {
      seed(); await openWork(mobile); await card(mobile, A.wi).waitFor({ timeout: 30_000 });
      const bar = await railBox(mobile); const content = await card(mobile, A.wi).boundingBox(); const sheet = await dock(mobile).boundingBox();
      assert.ok(bar && content && sheet, "the switch bar and main area render at 375px");
      assert.ok(bar.width >= sheet.width * 0.6, `the two segments form a top bar, not a right rail (${bar.width}/${sheet.width})`);
      assert.ok(bar.y + bar.height <= content.y + 2, `the bar sits above the main area (bar end ${bar.y + bar.height}, content ${content.y})`);
      assert.ok(bar.height <= 48, `the switch bar is a horizontal segment bar (${bar.height}px)`);
      // the documented DOM order — the Work sub-tab strip
      // comes AFTER the main area in the DOM and column-reverse lifts it
      // visually above (asserted just above). Pinned as documented in
      // docs/agents/polyforge-panel.md; the reading order (strip after the
      // content it controls) is a known a11y follow-up, not changed here.
      const stripAfterMain = await dock(mobile).locator('[data-pf-tabstrip="work"]').evaluate((strip, wi) => {
        const main = strip.closest("#polyforge-dock,[role=dialog]")?.querySelector(`[data-pf-card-wi="${wi}"]`);
        return Boolean(main) && Boolean(main.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING) && !strip.contains(main);
      }, A.wi);
      assert.ok(stripAfterMain, "at 375px the Work sub-tab strip follows the main area in the DOM");
    });
  }));

  await check("S4", () => withPage({}, async (page) => {
    seed(); await openWork(page);
    await waitFor(async () => /\b3\b/.test(await subTab(page, RE_JOBS).innerText()), "the 作业 badge shows queue.running = 3");
    assert.match(await subTab(page, RE_TASKS).innerText(), /\b1\b/, "the 任务 badge shows tasks.running = 1");
    assert.doesNotMatch(await topTab(page, RE_WORK).innerText(), /\d/, "工单 carries no count badge");
    const live = await dock(page).evaluate((el) => [...el.querySelectorAll('[role="tab"],button')].filter((node) => /作业|jobs/i.test(node.innerText.trim())).sort((a, b) => a.innerText.length - b.innerText.length)[0]?.innerText ?? "");
    assert.match(live, /\b3\b/, `the 作业 sub-tab control carries the count: ${live}`);
    // Read before the update: the same snapshot sets tasks.running to 0.
    const nonZero = await subTab(page, RE_TASKS).evaluate((el) => {
      const nodes = [...el.querySelectorAll("*"), el].filter((node) => node.textContent.trim() === "1" && ![...node.children].some((child) => child.textContent.trim() === "1"));
      return nodes[0] ? getComputedStyle(nodes[0]).color : null;
    });
    update({ queue: { running: 0, max_concurrent: 6 }, tasks: { running: 0, completed: 2, capped: 0, failed: 1, interrupted: 0 } });
    await waitFor(async () => /\b0\b/.test(await subTab(page, RE_JOBS).innerText()), "the badge follows the next status snapshot");
    const zero = await subTab(page, RE_JOBS).evaluate((el) => {
      const nodes = [...el.querySelectorAll("*"), el].filter((node) => node.textContent.trim() === "0" && ![...node.children].some((child) => child.textContent.trim() === "0"));
      return nodes[0] ? getComputedStyle(nodes[0]).color : null;
    });
    assert.ok(zero, "the zero badge is rendered (not hidden, not omitted)");
    assert.ok(nonZero && zero !== nonZero, `the zero badge is de-emphasized (zero ${zero}, non-zero ${nonZero})`);
  }));

  await check("S5", () => withPage({}, async (page) => {
    seed(); await openWork(page);
    await waitFor(async () => /\b3\b/.test(await subTab(page, RE_JOBS).innerText()), "the first badge value");
    const reads = taskLists().length;
    update({ queue: { running: 4, max_concurrent: 6 }, tasks: { running: 2, completed: 2, capped: 0, failed: 1, interrupted: 0 } });
    await waitFor(async () => /\b4\b/.test(await subTab(page, RE_JOBS).innerText()), "the badge follows the status poll");
    assert.equal(taskLists().length, reads, "the badge is not sourced from a task list read");
    const routes = new Set(page.__pf);
    for (const route of routes) assert.ok(["/api/polyforge/status", "/api/polyforge/cards", "/api/polyforge/messages", "/api/polyforge/detect",
      "/api/polyforge/config", "/api/polyforge/watch", "/api/polyforge/tasks"].includes(route), `no new polling route (${route})`);
    assert.ok(routes.has("/api/polyforge/status"), "the badge rides the existing status poll");
  }));

  await check("S6", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page);
    const a = card(page, A.wi); await a.waitFor({ timeout: 30_000 });
    const b = card(page, B.wi); await b.waitFor({ timeout: 30_000 });
    const text = await a.innerText();
    assert.ok(text.includes(A.slug) && text.includes("E2E-GOAL-START") && !text.includes("GOALTAIL") && /…/.test(text), `the card keeps slug + truncated goal: ${text.slice(0, 160)}`);
    assert.match(text, /running|运行/i, "the status label is shown");
    assert.ok(text.includes("A-PROGRESS-LAST"), "the narration is still on the card");
    for (const step of A_STEPS) assert.ok(!text.includes(step), `no step name on the card (${step})`);
    assert.doesNotMatch(text, /×\s*\d+|未知|unknown|—/, `no rerun/unknown/unstarted step text on the card: ${text.slice(0, 200)}`);
    assert.equal(await a.locator("[data-pf-step-phase]").count(), 0, "no step-phase styling on the card");
    assert.ok(!/bash|edit|E2E-COMMAND-ARG|token=/.test(text), "no tool name or command on the card");
    const boxA = await a.boundingBox(); const boxB = await b.boundingBox(); const dockBox = await dock(page).boundingBox();
    assert.ok(boxA && boxB && dockBox, "both cards and the dock measure");
    assert.ok(sameRow(boxA, boxB), `the two job cards share a row (${boxA.y}/${boxB.y})`);
    assert.ok(gapX(boxA, boxB) >= 6, `a visible gap between the cards (${gapX(boxA, boxB)})`);
    assert.ok(boxA.width < dockBox.width * 0.6, `a card never spans the dock as a full-width block (${boxA.width}/${dockBox.width})`);
  }));

  await check("S7", () => withPage({}, async (page) => {
    seed(); await openWork(page); const a = card(page, A.wi); await a.waitFor({ timeout: 30_000 });
    const text = await a.innerText();
    assert.ok(!text.includes("pi:e2e/model-a"), `the model is not on the card: ${text.slice(0, 200)}`);
    assert.doesNotMatch(text, /步龄|空闲|step age|idle age/i, "the step/idle age is not on the card");
    await a.click();
    await dock(page).getByRole("button", { name: /返回|back|deselect/i }).first().waitFor({ timeout: 15_000 });
    const detail = await dock(page).innerText();
    assert.ok(detail.includes("pi:e2e/model-a"), "the model stays available in the job detail");
    // Two precise labels with their ages: the 当前步骤 header
    // alone can no longer satisfy this.
    assert.match(detail, /步骤\s*\d+[smh]/, "the step age stays available in the job detail");
    assert.match(detail, /空闲\s*\d+[smh]/, "the idle age stays available in the job detail");
  }));

  await check("S8", () => withPage({}, async (page) => {
    seed(); await openWork(page); await card(page, A.wi).waitFor({ timeout: 30_000 });
    const response = await fetch(`${base}/api/polyforge/cards`, { signal: AbortSignal.timeout(30_000) });
    const body = await response.text(); assert.equal(response.status, 200);
    const entries = (JSON.parse(body).cards ?? []).flatMap((item) => item.progress?.entries ?? []);
    assert.equal(entries.filter((entry) => entry.kind === "tool").length, 0, `no tool entry in the response: ${JSON.stringify(entries.slice(0, 4))}`);
    for (const secret of ["bash", "edit", "PI-SECRET-TOKEN", "PI-SECRET-TOOL-RESULT", "PI-SECRET-THINKING", "PI-SECRET-USER-PROMPT", "E2E-COMMAND-ARG", "B-SECRET"]) {
      assert.ok(!body.includes(secret), `the cards response leaks ${secret}`);
    }
    assert.ok(body.includes("A-PROGRESS-LAST"), "the narration still flows");
    const dom = `${await card(page, A.wi).innerText()}\n${await card(page, B.wi).innerText()}`;
    assert.ok(!/bash|edit|E2E-COMMAND-ARG|token=/.test(dom), `neither the tool name nor a command appears in the card DOM: ${dom.slice(0, 200)}`);
  }));

  await check("S9", () => withPage({}, async (page) => {
    seed(); await openWork(page);
    const b = card(page, B.wi); await b.waitFor({ timeout: 30_000 });
    await waitFor(async () => /暂无进度消息/.test(await b.innerText()), "the narration-free card shows 暂无进度消息");
    assert.ok((await card(page, A.wi).innerText()).includes("A-PROGRESS-LAST"), "a narrated card still shows its narration");
  }));

  await check("S10", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page, RE_TASKS); await dock(page).getByText(M1).waitFor({ timeout: 30_000 });
    const text = await dock(page).innerText();
    assert.ok(text.includes("正在运行") && text.includes("全部"), "the running/all headings are kept");
    assert.ok(await dock(page).getByRole("searchbox").or(dock(page).getByPlaceholder(/搜索|search/i)).first().count() > 0, "the search box is kept");
    const boxes = await blockList(page, [M1, M2, M3]); const surface = await dock(page).boundingBox();
    assert.ok(boxes.every(Boolean) && surface, "three task blocks and the dock measure");
    for (const box of boxes) assert.ok(box.width <= surface.width - 12, `a block is discrete, not a full-row entry (${box.width}/${surface.width})`);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]), `blocks ${i}/${j} do not overlap`);
    assert.ok(sameRow(boxes[1], boxes[2]) && gapX(boxes[1], boxes[2]) >= 6, `at 460px two task blocks share a row with a gap (${boxes[1].y}/${boxes[2].y}, gap ${gapX(boxes[1], boxes[2])})`);
    await withPage({ viewport: { width: 375, height: 800 } }, async (mobile) => {
      seed(); await openWork(mobile, RE_TASKS); await taskBlock(mobile, T1).waitFor({ timeout: 30_000 });
      const narrow = await blockList(mobile, [M1, M2, M3]);
      assert.ok(narrow.every(Boolean) && sameRow(narrow[1], narrow[2]) && gapX(narrow[1], narrow[2]) >= 4,
        `at 375px two task blocks still share a row (${JSON.stringify(narrow.map((box) => box && [box.y, box.width]))})`);
    });
    await withPage({ storage: { "pi-web:polyforge-dock-width": "340" } }, async (tight) => {
      seed(); await openWork(tight, RE_TASKS); await taskBlock(tight, T1).waitFor({ timeout: 30_000 });
      const narrow = await blockList(tight, [M1, M2, M3]);
      assert.ok(narrow.every(Boolean) && sameRow(narrow[1], narrow[2]) && gapX(narrow[1], narrow[2]) >= 4,
        `at 340px two task blocks still share a row (${JSON.stringify(narrow.map((box) => box && [box.y, box.width]))})`);
    });
  }));

  await check("S11", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page, RE_TASKS); await dock(page).getByText(M2).waitFor({ timeout: 30_000 });
    const info = await block(page, M2);
    assert.ok(info, "the task block renders");
    assert.ok(info.text.includes("TASK-TWO-BRAVO") && info.text.includes("polyforge"), `project + prompt summary: ${info.text.slice(0, 160)}`);
    assert.ok(info.text.includes(T2), `the task id is a secondary label: ${info.text.slice(0, 160)}`);
    assert.match(info.text, /completed|完成/i, "the state text is shown");
    assert.match(info.text, /42/, "the duration is shown");
    assert.ok(info.icon, "the state icon is shown");
    assert.ok(info.summaryLines <= 2, `the prompt summary is capped at two lines (${info.summaryLines})`);
    await page.mouse.click(info.cx, info.cy);
    await dock(page).getByText("TASK-DETAIL-PROMPT").waitFor({ timeout: 20_000 });
    await dock(page).getByRole("button", { name: /返回|back/i }).first().click();
    await dock(page).getByText(M2).waitFor({ timeout: 20_000 });
    assert.ok(await block(page, M2), "the back control returns to the block grid");
  }));

  await check("S12", () => withPage({}, async (page) => {
    seed(); await openWork(page, RE_TASKS); await dock(page).getByText(M1).waitFor({ timeout: 30_000 });
    const reads = taskLists().length;
    const before = await block(page, M1);
    await delay(1_500);
    const after = await block(page, M1);
    assert.notEqual(before.text, after.text, `the running duration ticks from started_at (${before.text.slice(-40)} -> ${after.text.slice(-40)})`);
    assert.equal(taskLists().length, reads, "the client tick needs no extra server read");
    const done = await block(page, M2);
    assert.match(done.text, /42/, `the finished task shows wall_consumed_ns (42s): ${done.text.slice(0, 160)}`);
    assert.match(done.text, /前|ago/i, "the finished task shows how long ago it ended");
  }));

  await check("S13", async () => {
    seed();
    const response = await fetch(`${base}/api/polyforge/tasks`, { signal: AbortSignal.timeout(30_000) });
    const rows = (await response.json()).tasks;
    const one = rows.find((row) => row.id === T1); const done = rows.find((row) => row.id === T2);
    assert.ok(one && typeof one.started_at === "string", "the list forwards started_at");
    assert.ok(done && typeof done.ended_at === "string", "the list forwards ended_at");
    assert.equal(done.wall_consumed_ns, 42_000_000_000, "the list forwards wall_consumed_ns");
    const allowed = new Set(["id", "project", "state", "prompt_summary", "started_at", "ended_at", "wall_consumed_ns"]);
    for (const row of rows) for (const key of Object.keys(row)) assert.ok(allowed.has(key), `raw field ${key} stays unfowarded`);
  });

  await check("S14", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page, RE_TASKS); await dock(page).getByText(M1).waitFor({ timeout: 30_000 });
    const selects = dock(page).getByRole("combobox");
    await waitFor(async () => (await selects.count()) >= 2, "the project and state filters exist");
    let project = null; let state = null;
    for (let index = 0; index < await selects.count(); index++) {
      const labels = await firstOptionTexts(selects.nth(index));
      if (labels.includes("全部项目")) project = selects.nth(index);
      if (labels.includes("已封顶")) state = selects.nth(index);
    }
    assert.ok(project && state, "the project and state filters are rendered as selects");
    const projects = await firstOptionTexts(project);
    assert.equal(projects[0], "全部项目", `the project filter starts with 全部项目: ${JSON.stringify(projects)}`);
    assert.ok(projects.includes("workbench") && projects.includes("polyforge"), `the project options come from the list: ${JSON.stringify(projects)}`);
    const states = await firstOptionTexts(state);
    assert.equal(states.length, 6, `six state options: ${JSON.stringify(states)}`);
    for (const label of ["全部", "运行中", "已完成", "已封顶", "失败", "中断"]) assert.ok(states.includes(label), `state option ${label} is offered: ${JSON.stringify(states)}`);
    const reads = taskLists().length;
    await project.selectOption({ label: "polyforge" });
    await dock(page).getByText(M2).waitFor({ timeout: 10_000 });
    assert.equal(await dock(page).getByText(M1).count(), 0, "the project filter hides the other project");
    await state.selectOption({ label: "已完成" });
    await dock(page).getByText(M2).waitFor({ timeout: 10_000 });
    assert.equal(await dock(page).getByText(M3).count(), 0, "the state filter hides other states");
    const search = dock(page).getByRole("searchbox").or(dock(page).getByPlaceholder(/搜索|search/i)).first();
    await search.fill("BRAVO");
    await dock(page).getByText(M2).waitFor({ timeout: 10_000 });
    assert.equal(await dock(page).getByText(M1).count() + await dock(page).getByText(M3).count(), 0, "project + state + search combine");
    assert.equal(taskLists().length, reads, "filtering the already-read list spawns no new pf call");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("E2E pf work host session").first().waitFor({ state: "attached", timeout: 90_000 });
    await openWork(page, RE_TASKS);
    for (const marker of [M1, M2, M3]) await dock(page).getByText(marker).waitFor({ timeout: 20_000 });
    assert.equal(await project.evaluate((el) => el.selectedIndex), 0, "filters are not persisted: the project filter resets");
  }));

  await check("S15", () => withPage({}, async (page) => {
    seed(); await openWork(page);
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    assert.equal(taskLists().length, 0, "the jobs sub-page spawns no task list read");
    update({ tasks: { running: 2, completed: 2, capped: 0, failed: 1, interrupted: 0 } });
    // The page has the new count once the 任务 badge shows it; the barrier
    // then proves no read followed the change.
    await waitFor(async () => /\b2\b/.test(await subTab(page, RE_TASKS).innerText()), "the 任务 badge shows the new count (2)");
    await requestBarrier(page);
    await assertTaskListReads(page, 0, "a task-count change while 作业 is visible spawns no read");
    await subTab(page, RE_TASKS).click(); await dock(page).getByText(M1).waitFor({ timeout: 30_000 });
    await waitFor(() => taskLists().length >= 1, "entering 任务 reads the list");
    assert.equal(taskLists().length, 1, "entering 任务 issues exactly one list read");
    update({ tasks: { running: 3, completed: 2, capped: 0, failed: 1, interrupted: 0 } });
    await waitFor(() => taskLists().length === 2, "a count change while 任务 is visible re-reads once");
    await afterStatusPolls(page, 2, "after the re-read");
    await assertTaskListReads(page, 2, "exactly one re-read, no timer of its own");
    await topTab(page, RE_MEMORY).click();
    await afterStatusPolls(page, 2, "on the 记忆 tab");
    await assertTaskListReads(page, 2, "another top-level tab reads no task list");
    await topTab(page, RE_WORK).click();
    await waitFor(() => taskLists().length === 3, "re-entering 任务 takes the next read");
  }));

  await check("S16", () => withPage({}, async (page) => {
    seed({ jobs: [], queue: { running: 0, max_concurrent: 6 }, taskRows: [] });
    await page.evaluate(() => {
      window.__sawLoading = false;
      const scan = () => {
        const surface = [...document.querySelectorAll("#polyforge-dock,[role=dialog]")].find((node) => /polyforge/i.test(node.getAttribute("aria-label") || ""));
        if (surface && /Loading|加载中/.test(surface.innerText)) window.__sawLoading = true;
      };
      new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
      scan();
    });
    await openWork(page);
    await waitFor(async () => /暂无在跑作业/.test(await dock(page).innerText()), "zero jobs shows 暂无在跑作业");
    assert.equal(await page.evaluate(() => window.__sawLoading), false, "zero jobs never flashes a Loading state");
    assert.doesNotMatch(await dock(page).innerText(), /暂无 Polyforge 任务/, "the jobs empty state no longer calls jobs 任务");
    await subTab(page, RE_TASKS).click();
    await waitFor(async () => /暂无任务/.test(await dock(page).innerText()), "zero tasks shows 暂无任务");
    const lines = (await dock(page).innerText()).split("\n").map((line) => line.trim()).filter(Boolean);
    const index = lines.findIndex((line) => line.includes("暂无任务"));
    const heading = /^(正在运行|全部|running|all)$/i;
    const explained = index >= 0 && (lines[index].replace("暂无任务", "").trim().length >= 4
      || lines.slice(index + 1).some((line) => !heading.test(line)));
    assert.ok(explained, `暂无任务 carries one explanation line: ${JSON.stringify(lines)}`);
    assert.doesNotMatch(lines.join("\n"), /没有任务。/, "the old task empty wording is gone");
  }));

  await check("S17", () => withPage({}, async (page) => {
    seed(); await openDock(page);
    await topTab(page, RE_MESSAGES).click();
    await dock(page).getByText("E2E-PEER").first().click();
    await dock(page).getByText("E2E-ANCHOR-MESSAGE").waitFor({ timeout: 20_000 });
    await dock(page).getByRole("button", { name: A.wi }).click();
    await waitFor(async () => isActive(topTab(page, RE_WORK)), "the message anchor lands on 工单");
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    assert.equal(await card(page, A.wi).getAttribute("aria-pressed"), "true", "the message anchor lands on 作业 with the work item selected");
    await topTab(page, RE_MEMORY).click();
    await dock(page).getByText("E2E-ANCHOR-MEMORY").waitFor({ timeout: 20_000 });
    await dock(page).getByText("E2E-ANCHOR-MEMORY").first().click();
    await dock(page).getByRole("button", { name: A.wi }).waitFor({ timeout: 20_000 });
    await dock(page).getByRole("button", { name: A.wi }).click();
    await waitFor(async () => isActive(topTab(page, RE_WORK)), "the memory anchor lands on 工单");
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    assert.equal(await card(page, A.wi).getAttribute("aria-pressed"), "true", "the memory anchor lands on 作业 with the work item selected");
  }));

  await check("S18", () => withPage({}, async (page) => {
    seed();
    // Provably ready with the dock closed: the mount status read landed (the
    // topbar badge shows queue.running), so the cards effect has seen pf
    // present; the barrier then proves no cards read was issued.
    await waitFor(async () => /\b3\b/.test(await pfButton(page).innerText()), "the closed dock's mount status read landed");
    await requestBarrier(page);
    assert.equal(page.__cards.length, 0, "a closed dock issues zero cards reads");
    assert.equal(taskLists().length, 0, "a closed dock reads no task list");
    await openWork(page);
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    await waitFor(() => page.__cards.length >= 1, "the open 作业 sub-page polls the cards face");
    await subTab(page, RE_TASKS).click(); await dock(page).getByText(M1).waitFor({ timeout: 30_000 });
    await requestBarrier(page);
    const cards = page.__cards.length;
    await afterStatusPolls(page, 2, "on the 任务 sub-page");
    assert.equal(page.__cards.length, cards, "the 任务 sub-page does not poll the cards face");
    await subTab(page, RE_JOBS).click();
    await waitFor(() => page.__cards.length > cards, "returning to 作业 resumes the cards poll");
    // The resumed read plus two cadence ticks (the window the old 7 s sleep
    // covered), then the same count and gap assertions.
    await waitFor(() => page.__cards.length >= cards + 3, "the resumed cards poll ticks on its cadence", 20_000);
    const ticks = page.__cards.slice(cards);
    assert.ok(ticks.length >= 2, `the cards poll keeps its cadence (${ticks.length} ticks)`);
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] - ticks[i - 1] >= 600, `no new faster polling loop (gaps ${ticks.slice(1).map((t, i) => t - ticks[i])})`);
  }));
  await check("S19", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page);
    const a = card(page, A.wi); const b = card(page, B.wi);
    await a.waitFor({ timeout: 30_000 }); await b.waitFor({ timeout: 30_000 });
    const boxA = await a.boundingBox(); const boxB = await b.boundingBox(); const dockBox = await dock(page).boundingBox();
    assert.ok(boxA && boxB && dockBox, "the two job cards and the dock measure");
    assert.ok(sameRow(boxA, boxB), `at 460px the job cards sit side by side (${boxA.y}/${boxB.y})`);
    assert.ok(gapX(boxA, boxB) >= 6, `a visible gap between the job cards (${gapX(boxA, boxB)})`);
    assert.ok(boxA.width < dockBox.width * 0.6, `a job card is narrower than the main area (${boxA.width}/${dockBox.width})`);
    assert.ok(!overlap(boxA, boxB), "the job cards do not overlap");
    await subTab(page, RE_TASKS).click(); await taskBlock(page, T2).waitFor({ timeout: 30_000 });
    const m2 = await block(page, M2); const m3 = await block(page, M3);
    assert.ok(m2 && m3, "task blocks render");
    assert.ok(sameRow(m2, m3) && gapX(m2, m3) >= 6, `at 460px two task blocks share a row with a gap (${m2.y}/${m3.y}, gap ${gapX(m2, m3)})`);
    assert.ok(m2.width < dockBox.width * 0.6, `a task block is narrower than the main width (${m2.width}/${dockBox.width})`);
  }));

  await check("S20", async () => {
    const measure = (opts, label) => withPage(opts, async (page) => {
      seed(); await openWork(page);
      const a = await card(page, A.wi).boundingBox(); const b = await card(page, B.wi).boundingBox();
      assert.ok(a && b && sameRow(a, b) && gapX(a, b) >= 4, `${label}: the job cards stay side by side (${a?.y}/${b?.y})`);
      await subTab(page, RE_TASKS).click(); await taskBlock(page, T2).waitFor({ timeout: 30_000 });
      const m2 = await block(page, M2); const m3 = await block(page, M3);
      assert.ok(m2 && m3 && sameRow(m2, m3) && gapX(m2, m3) >= 4, `${label}: two task blocks stay side by side (${m2?.y}/${m3?.y})`);
    });
    await measure({ viewport: { width: 375, height: 800 } }, "375px");
    await measure({ storage: { "pi-web:polyforge-dock-width": "340" } }, "340px");
  });

  await check("S21", async () => {
    const marker = /等待输入|需要人输入|needs input/i;
    await withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
      seed(); await openWork(page);
      const b = card(page, B.wi); await b.waitFor({ timeout: 30_000 });
      assert.match(await b.innerText(), marker, `the needs_input card names the state: ${(await b.innerText()).slice(0, 200)}`);
      assert.ok(!marker.test(await card(page, A.wi).innerText()), "the running card does not carry the marker");
      const marks = await labelStyles(page, B.wi, "等待输入|需要人输入|needs input");
      const running = await labelStyles(page, A.wi, "运行中|running");
      assert.ok(marks.length > 0, "a needs-input marker element exists");
      const emphasized = marks.filter((mark) => Number(mark.weight) >= 600 || mark.background !== "rgba(0, 0, 0, 0)"
        || (running.length > 0 && mark.color !== running[0].color));
      assert.ok(emphasized.length > 0, `the marker is visually emphasized, not another dim status text: ${JSON.stringify(marks)}`);
    });
    for (const [opts, label] of [[{ viewport: { width: 375, height: 800 } }, "375px"], [{ storage: { "pi-web:polyforge-dock-width": "340" } }, "340px"]]) {
      await withPage(opts, async (page) => {
        seed(); await openWork(page);
        await card(page, B.wi).waitFor({ timeout: 30_000 });
        const box = await markerBox(page, B.wi, "等待输入|需要人输入|needs input");
        assert.ok(box && box.width > 0 && box.height > 0 && box.inside, `${label}: the marker stays visible and legible inside the card (${JSON.stringify(box)})`);
      });
    }
  });

  await check("S22", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page);
    const a = card(page, A.wi); await a.waitFor({ timeout: 30_000 });
    const marker = /等待输入|需要人输入|needs input/i;
    assert.ok(!marker.test(await a.innerText()), "the job starts as running without the marker");
    const cardsBefore = page.__cards.length;
    update({ jobs: STATUS_JOBS.map((job) => (job.work_item_id === A.wi ? { ...job, status: "needs_input" } : job)) });
    await waitFor(async () => marker.test(await a.innerText()), "the marker appears on the next status/cards read", 15_000);
    assert.ok(page.__cards.length > cardsBefore, "the marker rode the existing cards poll, no new request needed");
    const routes = new Set(page.__pf);
    for (const route of routes) assert.ok(["/api/polyforge/status", "/api/polyforge/cards", "/api/polyforge/messages", "/api/polyforge/detect",
      "/api/polyforge/config", "/api/polyforge/watch", "/api/polyforge/tasks"].includes(route), `no new polling route (${route})`);
    const verbs = new Set(["ops", "config", "msg", "recall", "memory", "task", "watch"]);
    assert.equal(calls().filter((argv) => !verbs.has(argv[0])).length, 0, "no new pf verb was spawned to detect the state");
  }));

  await check("S23", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page);
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    await card(page, A.wi).click();
    await dock(page).getByRole("button", { name: /返回|back|deselect/i }).first().waitFor({ timeout: 15_000 });
    const items = dock(page).getByRole("listitem");
    await waitFor(async () => (await items.count()) >= A_STEPS.length, "the detail renders the step graph nodes", 15_000);
    const labels = (await items.allInnerTexts()).map((text) => text.trim());
    const positions = A_STEPS.map((id) => labels.findIndex((text) => text.includes(id)));
    assert.ok(positions.every((index) => index >= 0), `every declared step has a node: ${JSON.stringify(labels)}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `the graph follows the declared order: ${JSON.stringify(positions)}`);
    assert.match(await dock(page).innerText(), /当前步骤[：:]\s*step-code|step-code\s*·\s*进行中|in progress[^\n]*step-code/i, "the current step is recognizable in the detail");
  }));

  await check("S24", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page);
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    await card(page, A.wi).click();
    await dock(page).getByRole("button", { name: /返回|back|deselect/i }).first().waitFor({ timeout: 15_000 });
    const stateText = async (id) => {
      const node = dock(page).getByRole("listitem").filter({ hasText: id }).first();
      await node.waitFor({ timeout: 15_000 });
      return (await node.innerText()).trim();
    };
    const states = [];
    for (const id of ["step-grill", "step-code", "step-review", "step-skip", "step-mystery"]) {
      const text = await stateText(id);
      const remainder = text.replace(id, "").trim();
      assert.ok(remainder.length > 0, `the step state is visible text, not only a tooltip (${text})`);
      states.push(text);
    }
    assert.equal(new Set(states).size, states.length, `completed/current/not-started/skipped/unknown are distinguishable: ${JSON.stringify(states)}`);
    const skipped = await stateText("step-skip");
    assert.match(skipped, /已跳过|skipped/i, `a skipped step is labelled skipped: ${skipped}`);
    assert.doesNotMatch(skipped, /未知|unknown|—/, `a skipped step is not shown as unknown/unstarted: ${skipped}`);
  }));

  await check("S25", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page);
    await card(page, A.wi).waitFor({ timeout: 30_000 });
    await card(page, A.wi).click();
    await dock(page).getByRole("button", { name: /返回|back|deselect/i }).first().waitFor({ timeout: 15_000 });
    await waitFor(async () => {
      const text = await dock(page).innerText();
      return ["step-grill", "step-spec", "step-code"].every((id) => timingLine(text, id));
    }, "the detail shows per-step durations", 15_000);
    const detail = await dock(page).innerText();
    for (const id of ["step-grill", "step-spec", "step-code"]) assert.ok(timingLine(detail, id), `the started step ${id} keeps its duration`);
    assert.match(timingLine(detail, "step-spec"), /×\s*2/, `the rerun marker ×2 is visible on the detail's step row: ${timingLine(detail, "step-spec")}`);
    assert.match(detail, /step-review\s*→\s*step-spec/, "the rewind marker stays visible in the detail");
    const before = timingLine(detail, "step-code");
    await waitFor(async () => {
      const line = timingLine(await dock(page).innerText(), "step-code");
      return line && line !== before;
    }, "the running step's duration advances with the detail's refresh", 12_000);
  }));

  await check("S26", () => withPage({ storage: { "pi-web:polyforge-dock-width": "460" } }, async (page) => {
    seed(); await openWork(page);
    const a = card(page, A.wi); await a.waitFor({ timeout: 30_000 });
    const before = await a.boundingBox();
    const extra = Array.from({ length: 80 }, (_, index) => pi(`a-extra-${index}`, [{ type: "text", text: `A-PROGRESS-EXTRA-${String(index).padStart(3, "0")}` }]));
    appendFileSync(aTranscript, extra.map((row) => JSON.stringify(row)).join("\n") + "\n");
    await waitFor(async () => (await a.innerText()).includes("A-PROGRESS-EXTRA-079"), "the long narration reaches the card", 20_000);
    const after = await a.boundingBox();
    assert.ok(before && after && Math.abs(after.height - before.height) <= 2, `long narration does not grow the card beyond its frame (${before?.height} -> ${after?.height})`);
    const text = await a.innerText();
    assert.ok(!text.includes("pi:e2e/model-a") && !/步龄|空闲|step age|idle age/i.test(text), "no model or step/idle age on the card");
    for (const step of A_STEPS) assert.ok(!text.includes(step), `no step information on the card after a long narration (${step})`);
  }));

  await check("S27", async () => {
    const measure = (opts) => withPage(opts, async (page) => {
      seed(); await openWork(page, RE_TASKS); await taskBlock(page, T2).waitFor({ timeout: 30_000 });
      const m1 = await taskBlock(page, T1).last().boundingBox(); const m2 = await block(page, M2); const m3 = await block(page, M3);
      const cards = [m1, m2, m3].filter(Boolean);
      // Columns of the 全部 grid (D5): its two blocks cannot show a wider row by counting.
      const row = await taskBlock(page, T2).evaluate((el) => getComputedStyle(el.parentElement).gridTemplateColumns.split(" ").filter(Boolean).length);
      const heading = await dock(page).locator("div, span").filter({ hasText: /^正在运行$/ }).first().boundingBox();
      const allHeading = await dock(page).locator("div, span").filter({ hasText: /^全部$/ }).first().boundingBox();
      return { row, cards, heading, allHeading };
    });
    const narrow = await measure({ storage: { "pi-web:polyforge-dock-width": "340" } });
    const wide = await measure({ storage: { "pi-web:polyforge-dock-width": "700" }, viewport: { width: 1600, height: 900 } });
    assert.ok(narrow.row >= 2, `the 340px dock keeps two cards per row (${narrow.row})`);
    assert.ok(wide.row > narrow.row, `a wider main area adds columns (${narrow.row} -> ${wide.row})`);
    assert.ok(wide.heading && wide.cards[0] && wide.heading.y + wide.heading.height <= wide.cards[0].y + 2, "正在运行 stays above the running grid");
    assert.ok(wide.allHeading && wide.cards[0] && wide.allHeading.y + wide.allHeading.height <= wide.cards[1].y + 2, "全部 stays above its grid"); // its first block (D6)
  });

} catch (error) {
  failures.push("suite");
  console.log(`FAIL suite: ${String(error?.message ?? error).split("\n")[0]}`);
} finally {
  try { await browser?.close(); } catch { /* already closed */ }
  await stop();
  if (failures.length) console.log(`\nFAILED ${failures.join(", ")} — ${failures.length} scenario(s) red`);
  else console.log("\nPASS all authored Work-tab scenarios");
  console.log(`server log: ${join(work, "server.log")}`);
}
if (failures.length) process.exitCode = 1;