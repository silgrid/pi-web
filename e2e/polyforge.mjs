// pi#108 (wi_y3y9SMz4IXKg) — Polyforge dock panel: end-to-end acceptance pass.
//
// Authored pre-code against artifacts/spec.md (AC1–AC10; AC11's e2e half is this
// file running against a stub `pf` on PATH; AC12 is regression-only and stays with
// e2e/run.mjs). Standalone, like e2e/terminal.mjs: it starts its own dev server
// twice — phase A with no `pf` reachable on PATH, phase B with a stub `pf` first
// on PATH — and matches the new surfaces only by HTTP routes named in the spec and
// by user-visible roles/text ("Polyforge" button/panel, mirroring bg-tasks markup).
// Each scenario is self-guarding: it logs PASS/FAIL and the run exits 1 on any FAIL.
//
//   node e2e/polyforge.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(!existsSync(join(root, ".next/dev/lock")), "Run in a checkout without an active dev server");
const work = mkdtempSync(join(tmpdir(), "pi-web-pf-e2e-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project);
const SESSION = "e2e-polyforge-session";
const ts = "2026-10-18T00:00:00.000Z";
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), [
  { type: "session", version: 3, id: SESSION, timestamp: ts, cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: "E2E polyforge host session" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

// ---- stub pf (state.json + argv.log next to it; absolute node shebang) ----
const STALE_KEY = "e2e-stale-key-SECRETVALUE-7731";
const QUESTION = "E2E-PENDING-QUESTION-TEXT which colour?";
const LONG_CANDIDATE = "claude:claude-opus-5-5-extended-context-e2e";
// pi#112 (wi_5qd5PgbQT1Gw) — readable event tail. A second watch fixture whose
// 25-event tail exercises every whitelisted kind/field, noise runs of 5 and 1,
// every severity kind, an unknown kind, and a sentinel in every NON-whitelisted
// body field (the owner-approved never-leaks list).
const SLUG112 = "pi#112";
const WI112 = "wi_E2Edddd0004";
const MODEL112 = "sub2api-glm/glm-5.3-extended-thinking-very-long-e2e-suffix-abcdef0123456789abcdef0123456789";
const SHORT_MODEL112 = "pi:glm-5.3-short";
const FROM112 = "pi:glm-e2e-old-777";
const TO112 = "claude:opus-e2e-new-888";
const SECRETS112 = [
  "E2E-SECRET-QUESTION-112", "E2E-SECRET-DETAIL-112", "E2E-SECRET-EVIDENCE-112",
  "E2E-SECRET-PUSH-ERROR-112", "E2E-SECRET-ANSWERED-BY-112", "E2E-SECRET-LOCAL-COMMIT-112",
  "E2E-SECRET-FILES-112", "E2E-SECRET-ARCHIVED-112", "E2E-SECRET-REASON-112",
  "E2E-SECRET-CS-CAUSE-112", "E2E-SECRET-FROM-MODEL-112", "E2E-SECRET-TO-MODEL-112",
  "E2E-SECRET-DISPOSITION-112", "E2E-SECRET-WORKER-COMMAND-112", "fp-secret-session-112",
];
const SECRETS = ["E2E_ENV_NAME_SENTINEL", "/srv/e2e-secret-workspace", "E2E-SECRET-WORKER-COMMAND", "E2E-SECRET-EVENT-BODY", "fp-secret-session", ...SECRETS112];
const job = (id, slug, status, spawn, step, idle, candidate, owner) => ({ work_item_id: id, slug, status, spawn_n: spawn,
  session_fingerprint: "fp-secret-session", step_age_sec: step, last_work_ago_sec: idle, candidate, origin: { kind: "chat", owner } });
const JOBS = [
  job("wi_E2Eaaaa0001", "pi#108", "running", 3, 7325, 4337, LONG_CANDIDATE, "u_alice"),
  job("wi_E2Ebbbb0002", "demo#7", "running", 1, 61, 5, "pi:glm-e2e", "u_bob"),
  job("wi_E2Ecccc0003", "pi#109", "needs_input", 2, 900, 880, "codex:gpt-e2e", "svc_ci"),
  { work_item_id: WI112, slug: SLUG112, status: "running", spawn_n: 2, step_age_sec: 42, last_work_ago_sec: 9,
    candidate: "codex:e2e-watch", session_fingerprint: "fp-secret-session-112", origin: { kind: "chat", owner: "u_e2e" } },
];
const ops = (jobs, running = 2) => ({ machine_id: "m-e2e", workspaces: ["/srv/e2e-secret-workspace"], workflows_dir: "/srv/e2e-secret-workspace/wf",
  env_names: ["POLYFORGE_V1_API_KEY", "E2E_ENV_NAME_SENTINEL"], jobs, queue: { pending: 0, running, max_concurrent: 4 } });
const at = (n) => `2026-10-18T10:${String(n - 1).padStart(2, "0")}:00Z`;
// Execution order differs from alphabetical order on purpose.
const STEP_ORDER = ["zulu-grill", "mike-spec", "alpha-plan", "kilo-author", "bravo-code"];
const WATCH_108 = { work_item: "wi_E2Eaaaa0001", slug: "pi#108", known: true, job: { status: "running", origin: { owner: "u_alice" } },
  execution: { workflow_status: "running", current_step: "kilo-author", updated_at: at(60), steps: {
    "alpha-plan": { status: "done", started_at: "2026-10-18T08:10:00Z" }, "bravo-code": { status: "pending" },
    "kilo-author": { status: "in_progress", started_at: "2026-10-18T08:15:00Z" },
    "mike-spec": { status: "done", started_at: "2026-10-18T08:05:00Z" }, "zulu-grill": { status: "done", started_at: "2026-10-18T08:00:00Z" } } },
  progress: { command: "worker run --token=E2E-SECRET-WORKER-COMMAND-0123456789 --flag", tool_calls: 9 },
  events: Array.from({ length: 60 }, (_, i) => ({ at: at(i + 1), kind: i % 2 ? "published" : "step_started", work_item: "wi_E2Eaaaa0001",
    body: { step: "kilo-author", spawn_n: 3, detail: `E2E-SECRET-EVENT-BODY-${i + 1}` }, seq: i + 1 })), last_seq: 60 };
const WATCH_109 = { work_item: "wi_E2Ecccc0003", slug: "pi#109", known: true, job: { status: "needs_input" },
  execution: { workflow_status: "blocked", current_step: "zulu-grill", updated_at: at(3), pending_question: QUESTION,
    steps: { "zulu-grill": { status: "blocked", started_at: "2026-10-18T09:00:00Z" } } },
  events: [{ at: at(3), kind: "needs_input", work_item: "wi_E2Ecccc0003", body: { question: QUESTION, step: "zulu-grill" }, seq: 3 }], last_seq: 3 };
// pi#112 tail (newest last): a step_started, a 5-event noise run
// (published/transcript_missing/exec_init/published/published), 13 consecutive
// meaningful events covering every whitelisted field, an isolated noise event,
// three terminal statuses, and an unknown kind. Bodies mirror the live pf shapes
// (grill-qa evidence table) with sentinels in every non-whitelisted field.
const at2 = (n) => `2026-10-18T11:${String(n - 1).padStart(2, "0")}:00Z`;
const ev112 = (n, kind, body) => ({ at: at2(n), kind, work_item: WI112, body, seq: 100 + n });
const published112 = (n) => ev112(n, "published", { version: 9, local_commit: "E2E-SECRET-LOCAL-COMMIT-112", commit_ms: 10, push_ms: 5, pushed: true });
const EVENTS_112 = [
  ev112(1, "step_started", { step: "zulu-grill", model: SHORT_MODEL112, effort: "high", resume: false, spawn_n: 2 }),
  published112(2),
  ev112(3, "transcript_missing", { detail: "E2E-SECRET-DETAIL-112", spawn_n: 2 }),
  ev112(4, "exec_init", { spawn_n: 2, steps: ["E2E-SECRET-ARCHIVED-112"] }),
  published112(5),
  published112(6),
  ev112(7, "step_started", { step: "kilo-author", model: MODEL112, effort: "high", resume: false, spawn_n: 2 }),
  ev112(8, "candidate_switched", { step: "alpha-plan", from: FROM112, to: TO112, cause: "E2E-SECRET-CS-CAUSE-112" }),
  ev112(9, "step_failed", { step: "bravo-code", cause: "agent-exit-13", detail: "E2E-SECRET-DETAIL-112", disposition: "E2E-SECRET-DISPOSITION-112", failure_count: 2, from_model: "E2E-SECRET-FROM-MODEL-112", to_model: "E2E-SECRET-TO-MODEL-112", spawn_n: 2 }),
  ev112(10, "step_dead", { step: "mike-spec", cause: "timeout-after-3-retries", evidence: "E2E-SECRET-EVIDENCE-112", spawn_n: 2 }),
  ev112(11, "needs_input", { step: "zulu-grill", question: "E2E-SECRET-QUESTION-112", question_id: "q112", spawn_n: 2 }),
  ev112(12, "answered", { step: "zulu-grill", question_id: "q112", answered_by: "E2E-SECRET-ANSWERED-BY-112", spawn_n: 2 }),
  ev112(13, "gate_verdict", { step: "alpha-plan", spawn_n: 2 }),
  ev112(14, "rewind", { gate: "spec-review", target: "kilo-author", archived: ["E2E-SECRET-ARCHIVED-112"], spawn_n: 2 }),
  ev112(15, "envelope_rejected", { step: "bravo-code", detail: "E2E-SECRET-DETAIL-112", spawn_n: 2 }),
  ev112(16, "needs_recovery", { reason: "E2E-SECRET-REASON-112", detail: "E2E-SECRET-DETAIL-112", spawn_n: 2 }),
  ev112(17, "push_failed", { error: "E2E-SECRET-PUSH-ERROR-112 git@10.0.0.5:internal/e2e.git", version: 9 }),
  ev112(18, "job_started", { spawn_n: 2 }),
  ev112(19, "job_stopped", { spawn_n: 2 }),
  ev112(20, "authored_tests_rebaselined", { step: "kilo-author", files: ["E2E-SECRET-FILES-112"], spawn_n: 2 }),
  ev112(21, "transcript_missing", { detail: "E2E-SECRET-DETAIL-112", spawn_n: 2 }),
  ev112(22, "terminal", { status: "completed", reason: "E2E-SECRET-REASON-112", spawn_n: 2 }),
  ev112(23, "terminal", { status: "failed", reason: "E2E-SECRET-REASON-112", spawn_n: 2 }),
  ev112(24, "terminal", { status: "cancelled", reason: "E2E-SECRET-REASON-112", spawn_n: 2 }),
  ev112(25, "future_kind_e2e", { step: "kilo-author", detail: "E2E-SECRET-DETAIL-112", spawn_n: 2 }),
];
const WATCH_112 = { work_item: WI112, slug: SLUG112, known: true, job: { status: "running" },
  execution: { workflow_status: "running", current_step: "kilo-author", updated_at: at2(25),
    steps: { "zulu-grill": { status: "done", started_at: "2026-10-18T09:00:00Z" },
      "mike-spec": { status: "done", started_at: "2026-10-18T09:10:00Z" },
      "alpha-plan": { status: "done", started_at: "2026-10-18T09:20:00Z" },
      "kilo-author": { status: "in_progress", started_at: "2026-10-18T09:30:00Z" },
      "bravo-code": { status: "pending" } } },
  progress: { command: "worker run --token=E2E-SECRET-WORKER-COMMAND-112-0123456789 --flag", tool_calls: 3 },
  events: EVENTS_112, last_seq: 125 };
const stubDir = join(work, "stub-bin");
mkdirSync(stubDir);
const stateFile = join(stubDir, "state.json");
const argvLog = join(stubDir, "argv.log");
const setState = (patch) => writeFileSync(stateFile, JSON.stringify({ mode: "ok", ops: ops(JOBS), watch: { "pi#108": WATCH_108,
  wi_E2Eaaaa0001: WATCH_108, "pi#109": WATCH_109, wi_E2Ecccc0003: WATCH_109, [SLUG112]: WATCH_112, [WI112]: WATCH_112 }, ...patch }));
setState({});
writeFileSync(join(stubDir, "pf"), `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const dir = path.dirname(fs.realpathSync(__filename)); const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
if (args.includes("--version")) { console.log("pf 0.0.0-e2e"); process.exit(0); }
const s = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const out = (v) => { process.stdout.write(JSON.stringify(v) + "\\n"); process.exit(0); };
const run = () => {
  if (s.mode === "down") { process.stderr.write("pf: daemon not reachable (connection refused)\\n"); process.exit(1); }
  if (s.mode === "auth") { process.stderr.write("pf: 401 unauthorized (invalid api key)\\n"); process.exit(1); }
  const rest = args.filter((a) => a !== "--json");
  if (rest[0] === "ops" && rest[1] === "status") out(s.ops);
  if (rest[0] === "watch") {
    const i = rest.indexOf("--events"); const n = i >= 0 ? Number(rest[i + 1]) : 8;
    const w = s.watch[rest[1]] || { work_item: rest[1], known: false, events: [], last_seq: 0 };
    out({ ...w, events: (w.events || []).slice(-n) });
  }
  process.stderr.write("pf: unknown command\\n"); process.exit(2);
};
if (s.mode === "hang") setTimeout(run, 30000); else run();
`);
chmodSync(join(stubDir, "pf"), 0o755);
// Phase A PATH: every PATH dir holding a pf is replaced by a symlink farm without it.
const absentPath = (process.env.PATH || "").split(delimiter).map((dir, n) => {
  if (!existsSync(join(dir, "pf"))) return dir;
  const farm = join(work, `nopf-${n}`);
  mkdirSync(farm);
  for (const name of readdirSync(dir)) if (name !== "pf") symlinkSync(join(dir, name), join(farm, name));
  return farm;
}).join(delimiter);

// ---- scenario bookkeeping ----
const T = {
  AC1: "AC1: Topbar Polyforge button renders iff the server finds pf",
  AC2: "AC2: Badge polls every 3s open / 30s closed, only with pf, no badge when daemon down",
  AC3: "AC3: Unavailable answers 200 {status:null}, malformed ?wi= answers 400, no 5xx or console errors",
  AC4: "AC4: Job list shows every job on the machine with its fields and the queue badge",
  AC5: "AC5: Selected WI shows header, ordered steps and the last 40 events",
  AC6: "AC6: Selected WI stays selected after it leaves the job list",
  AC7: "AC7: Blocked WI shows its status only, never the pending-question text",
  AC8: "AC8: Routes validate refs before argv, time out to unavailable and leak no env values or hidden fields",
  AC9: "AC9: Panel docks 460px (resizable) right on desktop / 62% bottom sheet on mobile, sharing the bg-tasks slot",
  AC10: "AC10: Panel strings are localized in zh-CN and zh-TW",
  // pi#112 (wi_5qd5PgbQT1Gw) — readable event tail, authored pre-code against
  // artifacts/spec.md. One scenario per new-behaviour acceptance criterion.
  N1: "N1: Server whitelist exposes per-kind body fields, never non-whitelisted values",
  N2: "N2: Key event rows render readable with whitelisted context (en)",
  N3: "N3: Friendly labels localized in zh-CN and zh-TW with interpolated fields",
  N4: "N4: Dead kind labels and i18n keys removed from all three locales",
  N5: "N5: Simple mode collapses noise runs into one gray sync row",
  N6: "N6: Verbose mode shows every event row, noise grayed, raw kind inline",
  N7: "N7: Raw kind on hover title in both modes",
  N8: "N8: Severity emphasis: amber, red, green, neutral",
  N9: "N9: Mode toggle defaults to simple, persists across reload, issues no request",
  N10: "N10: Sanitization docs describe the shipped per-kind whitelist",
};
const failures = new Map(Object.values(T).map((title) => [title, []]));
const ran = new Set();
async function check(title, label, fn) {
  ran.add(title);
  try { await fn(); } catch (error) { failures.get(title).push(`${label}: ${String(error?.message ?? error).split("\n")[0]}`); }
}
// A check that drives its own fresh browser page (a failure stays local to the scenario).
const withPage = (title, label, opts, fn) => check(title, label, async () => {
  const page = await openPage(opts);
  try { await fn(page); } finally { await page.context().close(); }
});

let server; let browser; let base; const serverLogs = [];
async function startServer(name, path) {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const logFile = join(work, `server-${name}.log`); serverLogs.push(logFile);
  const log = createWriteStream(logFile);
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: path, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1",
      PI_WEB_ALLOWED_ROOT_PREFIXES: work, POLYFORGE_V1_API_KEY: STALE_KEY },
  });
  server.stdout.pipe(log); server.stderr.pipe(log);
  for (let i = 0; ; i++) {
    if ((await fetch(`${base}/api/sessions`).catch(() => null))?.ok) break;
    assert.ok(i < 240 && server.exitCode === null, "Server did not become ready");
    await delay(500);
  }
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit"); server.kill("SIGTERM"); await exited;
  // A SIGTERM'd `next dev` can leave its lock behind; drop it only if it is this server's.
  const lock = join(root, ".next/dev/lock");
  try { if (JSON.parse(readFileSync(lock, "utf8")).pid === server.pid) rmSync(lock); } catch {}
}
async function get(path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: response.status, text, json };
}
const errors = [];
const statusRequests = [];
async function openPage({ viewport = { width: 1280, height: 800 }, locale } = {}) {
  const context = await browser.newContext({ viewport, locale: "en-US" });
  await context.addInitScript((loc) => {
    try { localStorage.setItem("pi-web:split-view-enabled", "false"); if (loc) localStorage.setItem("pi-locale", loc); } catch {}
  }, locale ?? null);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
  page.on("response", (r) => { if (r.url().startsWith(base) && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/polyforge/status") statusRequests.push(Date.now()); });
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded" });
  // Locale-independent readiness: the host session's first message is mounted.
  await page.getByText("E2E polyforge host session").first().waitFor({ state: "attached", timeout: 60_000 });
  return page;
}
const pfButton = (page) => page.getByRole("button", { name: /^(?!.*close).*polyforge/i }).first();
const pfPanel = (page) => page.getByRole("complementary", { name: /polyforge/i }).or(page.getByRole("dialog", { name: /polyforge/i }));
const bgPanel = (page) => page.getByRole("complementary", { name: "Background tasks" }).or(page.getByRole("dialog", { name: "Background tasks" }));
async function openPanel(page) { await pfButton(page).click(); await pfPanel(page).first().waitFor(); return pfPanel(page).first(); }
const countSince = (t0) => statusRequests.filter((t) => t >= t0).length;
function arrayOf(value, pred) { // first array (deep) whose object items satisfy pred
  if (Array.isArray(value) && value.length && value.every((item) => item && typeof item === "object" && pred(item))) return value;
  for (const child of value && typeof value === "object" ? Object.values(value) : []) { const hit = arrayOf(child, pred); if (hit) return hit; }
  return null;
}
const values = (o) => (o && typeof o === "object" ? Object.values(o).flatMap(values) : [o]);
const argvCalls = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// ---- pi#112 event-row helpers: the tail is driven only through what a user
// sees (row text, hover titles, computed colour) — never through markup the
// implementation happens to build. A row is anchored by its spec-pinned hover
// title (raw kind) and bounded by subtree size, not by structure. ----
const rowText = (panel, kind, index = 0) => panel.first().evaluate((root, { kind, index }) => {
  const el = [...root.querySelectorAll(`[title*="${kind}"]`)][index];
  if (!el) return null;
  let node = el;
  let row = el;
  while (node && node !== root && node.querySelectorAll("*").length <= 20) { row = node; node = node.parentElement; }
  return (row.textContent || "").trim();
}, { kind, index });
const rowFamilies = (panel, kind) => panel.first().evaluate((root, kind) => {
  const family = (color) => {
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(color));
    if (!m) return null;
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 25) return "gray";
    if (r >= max && r > b + 40 && g > b + 20 && r > g + 25) return "amber";
    if (r >= max && r > g + 40 && r > b + 40) return "red";
    if (g >= max && g > r + 25) return "green";
    return "other";
  };
  return [...root.querySelectorAll(`[title*="${kind}"]`)].map((el) => {
    const families = new Set();
    let node = el;
    while (node && node !== root && node.querySelectorAll("*").length <= 20) {
      const cs = getComputedStyle(node);
      for (const c of [cs.color, cs.backgroundColor, cs.borderLeftColor, cs.borderRightColor]) {
        const f = family(c);
        if (f) families.add(f);
      }
      node = node.parentElement;
    }
    return [...families];
  });
}, kind);
// Luminance distance between a needle's text colour and the nearest opaque
// background — lower means visually de-emphasized (gray).
const textContrast = (panel, needle) => panel.first().evaluate((root, needle) => {
  const lum = (color) => {
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(String(color));
    if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null;
    return (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
  };
  const smallest = [...root.querySelectorAll("*")].find((el) => (el.textContent || "").includes(needle)
    && ![...el.children].some((child) => (child.textContent || "").includes(needle)));
  if (!smallest) return null;
  let bg = 0.5;
  for (let node = smallest; node; node = node.parentElement) {
    const l = lum(getComputedStyle(node).backgroundColor);
    if (l !== null) { bg = l; break; }
  }
  const fg = lum(getComputedStyle(smallest).color);
  return fg === null ? null : Math.abs(fg - bg);
}, needle);
// en label for a polyforge event kind, read from the message source so the
// contrast checks below compare like with like (label span vs label span)
// without hardcoding wording.
const enKindLabel = (kind) => {
  const source = readFileSync(join(root, "lib", "i18n", "messages", "en.ts"), "utf8");
  const m = new RegExp(`"polyforge\\.eventKind\\.${kind}":\\s*"([^"]+)"`).exec(source);
  assert.ok(m, `en label for ${kind} not found`);
  return m[1];
};
async function ensureDetail112(page) {
  // The pi#112 detail is showing iff its tail renders the raw kind
  // `future_kind_e2e` (unique to this fixture, raw before and after the change
  // alike). The job row TOGGLES selection, so never blind-click it: verify
  // first, click only when the detail is absent, retry bounded (a click during
  // a select-fetch gap deselects; the next attempt re-selects).
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await pfPanel(page).count()) === 0) { await openPanel(page); continue; }
    const panel = pfPanel(page).first();
    if ((await panel.getByText("future_kind_e2e").count()) > 0) return panel;
    if ((await panel.getByText(SLUG112, { exact: true }).count()) === 0) { await delay(500); continue; }
    await panel.getByText(SLUG112, { exact: true }).first().click().catch(() => {});
    await delay(500);
  }
  throw new Error("the pi#112 detail did not render");
}
// Wording-independent discovery of the mode toggle: click panel controls
// (repairing state after each) until the tail flips between collapsed
// (simple) and per-event (verbose) rows; the control that flips verbosity
// while the detail stays put is the toggle. Candidates are re-queried
// positionally each round, so a remounted panel is still covered. Returns the
// toggle locator with the tail left in SIMPLE mode, or null.
async function findEventModeToggle(page) {
  const selector = 'button, [role="button"], [role="switch"], [role="checkbox"], [aria-pressed]';
  const verbose = async () => (await pfPanel(page).count()) > 0
    && (await pfPanel(page).first().locator('[title*="exec_init"]').count()) > 0;
  const detailShowing = async () => (await pfPanel(page).count()) > 0
    && (await pfPanel(page).first().getByText("future_kind_e2e").count()) > 0;
  await ensureDetail112(page);
  // Phase 1: flip simple → verbose by trying every control.
  for (let round = 0; round < 3 && !(await verbose()); round++) {
    const panel = pfPanel(page).first();
    const count = await panel.locator(selector).count();
    for (let i = 0; i < count && !(await verbose()); i++) {
      await panel.locator(selector).nth(i).click({ timeout: 2000 }).catch(() => {});
      await delay(250);
      await ensureDetail112(page);
    }
  }
  if (!(await verbose())) return null;
  // Phase 2: flip verbose → simple; the control that does it without losing
  // the detail is the toggle.
  for (let round = 0; round < 3 && (await verbose()); round++) {
    const panel = pfPanel(page).first();
    const count = await panel.locator(selector).count();
    for (let i = 0; i < count && (await verbose()); i++) {
      const candidate = panel.locator(selector).nth(i);
      await candidate.click({ timeout: 2000 }).catch(() => {});
      await delay(250);
      if ((await detailShowing()) && !(await verbose())) return candidate;
      await ensureDetail112(page);
    }
  }
  return null;
}

try {
  browser = await chromium.launch();
  // ================= Phase A: no pf on PATH =================
  await startServer("absent", absentPath);
  let absentBody = null;
  await check(T.AC3, "pf absent: status route", async () => {
    const r = await get("/api/polyforge/status");
    assert.equal(r.status, 200, `status route answered ${r.status}`); assert.equal(r.json?.status, null); absentBody = r.json;
  });
  await check(T.AC3, "pf absent: watch route", async () => {
    const r = await get("/api/polyforge/watch?wi=pi%23108");
    assert.equal(r.status, 200, `watch route answered ${r.status}`); assert.equal(r.json?.status, null);
  });
  await withPage(T.AC1, "pf absent: page", {}, async (page) => {
    const t0 = Date.now();
    await delay(33_000);
    await check(T.AC1, "pf absent: button", async () => assert.equal(await pfButton(page).count(), 0, "button rendered without pf"));
    await check(T.AC2, "pf absent: polling", async () => assert.ok(countSince(t0) <= 1, `${countSince(t0)} status requests in 33s without pf (one mount probe allowed)`));
  });
  await check(T.AC3, "pf absent: error signals", async () => assert.deepEqual(errors.splice(0), []));
  await stopServer();

  // ================= Phase B: stub pf first on PATH =================
  await startServer("stub", `${stubDir}${delimiter}${process.env.PATH}`);
  await withPage(T.AC1, "pf present: button opens the panel", {}, async (page) => { await openPanel(page); });

  // AC2 — cadence and badge
  await withPage(T.AC2, "cadence and badge", {}, async (page) => {
    await pfButton(page).waitFor();
    assert.match(await pfButton(page).innerText(), /2/, "closed badge must show queue running 2");
    let t0 = Date.now(); await delay(35_000);
    const closed = countSince(t0);
    assert.ok(closed >= 1 && closed <= 2, `closed panel: ${closed} polls in 35s (want 30s cadence)`);
    await openPanel(page);
    t0 = Date.now(); await delay(10_000);
    const open = countSince(t0);
    assert.ok(open >= 2 && open <= 5, `open panel: ${open} polls in 10s (want 3s cadence)`);
    setState({ ops: ops(JOBS, 3) });
    await pfButton(page).filter({ hasText: "3" }).waitFor({ timeout: 8_000 });
  });
  setState({});

  // AC4 — job list
  await check(T.AC4, "status route fields", async () => {
    const r = await get("/api/polyforge/status");
    assert.equal(r.status, 200); assert.ok(r.json?.status, "status must be non-null with the daemon up");
    const leaves = values(r.json);
    for (const j of JOBS) for (const v of [j.slug, j.status, j.spawn_n, j.step_age_sec, j.last_work_ago_sec, j.candidate]) {
      assert.ok(leaves.includes(v), `status route lacks ${j.slug} field value ${v}`);
    }
    assert.ok(leaves.includes(2) && leaves.includes(4), "status route lacks queue running/max");
  });
  await withPage(T.AC4, "panel list", {}, async (page) => {
    const panel = await openPanel(page);
    await panel.getByText("demo#7").first().waitFor();
    const text = await panel.innerText();
    for (const j of JOBS) assert.ok(text.includes(j.slug), `list lacks ${j.slug} (owner ${j.origin.owner})`);
    assert.ok(text.includes(`${LONG_CANDIDATE.slice(0, 24)}…`) && !text.includes(LONG_CANDIDATE), "candidate not shortened to 24 chars + …");
    for (const v of ["needs_input|needs input", "running"]) assert.match(text, new RegExp(v, "i"));
    assert.match(text, /2\s*\/\s*4/, "queue running/max badge 2/4 missing");
  });

  // AC5 — watch route and detail
  await check(T.AC5, "watch route", async () => {
    const r = await get("/api/polyforge/watch?wi=pi%23108");
    assert.equal(r.status, 200); assert.ok(r.json?.status, "watch status must be non-null");
    const steps = arrayOf(r.json, (s) => values(s).some((v) => STEP_ORDER.includes(v)));
    assert.deepEqual(steps?.map((s) => values(s).find((v) => STEP_ORDER.includes(v))), STEP_ORDER, "steps not in execution order");
    const events = arrayOf(r.json, (e) => values(e).some((v) => typeof v === "string" && v.startsWith("2026-10-18T10:")));
    assert.equal(events?.length, 40, `events tail has ${events?.length} entries, want 40`);
    const times = values(events);
    assert.ok(times.includes(at(60)) && times.includes(at(21)) && !times.includes(at(20)), "tail is not the newest 40");
    const call = argvCalls().findLast((a) => a.includes("watch"));
    assert.ok(call && call[call.indexOf("--events") + 1] === "40", `pf watch argv ${JSON.stringify(call)} does not ask for 40 events`);
    // pi#119: every watch read arms the summarize lane — --demand is always
    // on the argv (the stub pf ignores it; the route never omits it).
    assert.ok(call?.includes("--demand"), `pf watch argv ${JSON.stringify(call)} does not arm the summarize lane (--demand)`);
  });
  await withPage(T.AC5, "detail panel", {}, async (page) => {
    const panel = await openPanel(page);
    await panel.getByText("pi#108", { exact: true }).first().click();
    await panel.getByText("zulu-grill").first().waitFor();
    // pi#114/#116: the step names render only as flow-graph nodes (no step-chip
    // row in any mode), so this order check guards the graph; the strict
    // node-order/edge contract lives in e2e/polyforge-graph.mjs.
    const text = await panel.innerText();
    const idx = STEP_ORDER.map((s) => text.indexOf(s));
    assert.ok(idx.every((i) => i >= 0), `steps missing: ${JSON.stringify(idx)}`);
    assert.ok(idx[0] < idx[1] && idx[1] < idx[2], "steps not in execution order");
  });

  // AC6 — selection persists
  await withPage(T.AC6, "selection persists", {}, async (page) => {
    const panel = await openPanel(page);
    await panel.getByText("pi#108", { exact: true }).first().click();
    await panel.getByText("zulu-grill").first().waitFor();
    const watch = JSON.parse(readFileSync(stateFile, "utf8")).watch;
    delete watch["pi#108"]; delete watch.wi_E2Eaaaa0001;
    setState({ ops: ops(JOBS.slice(1), 1), watch });
    await delay(9_000);
    const text = await panel.innerText();
    assert.ok(text.includes("pi#108") && text.includes("zulu-grill") && text.includes("mike-spec"), "selected WI snapshot dropped after it left the list");
  });
  setState({});

  // AC7 — blocked WI
  await withPage(T.AC7, "blocked detail", {}, async (page) => {
    const r = await get("/api/polyforge/watch?wi=pi%23109");
    assert.equal(r.status, 200); assert.ok(r.json?.status, "watch status must be non-null");
    assert.ok(!r.text.includes("E2E-PENDING-QUESTION-TEXT"), "watch route leaks the pending question");
    const panel = await openPanel(page);
    await panel.getByText("pi#109", { exact: true }).first().click();
    await panel.getByText(/blocked/i).first().waitFor();
    assert.ok(!(await panel.innerText()).includes("E2E-PENDING-QUESTION-TEXT"), "panel shows the pending question");
  });

  // AC8 — argv safety, hidden fields, env leakage, timeout
  await check(T.AC8, "bad ref never reaches argv", async () => {
    const before = argvCalls().length;
    for (const bad of ["pi%23108%20--chat%20x", "--help", "wi_x%3Brm%20-rf"]) {
      const r = await get(`/api/polyforge/watch?wi=${bad}`);
      assert.equal(r.status, 400, `?wi=${bad} answered ${r.status}`);
    }
    assert.deepEqual(argvCalls().slice(before).filter((a) => a.includes("watch")), [], "a malformed ref reached pf argv");
  });
  await check(T.AC8, "hidden fields", async () => {
    const s = await get("/api/polyforge/status"); const w = await get("/api/polyforge/watch?wi=pi%23108");
    assert.ok(s.json?.status && w.json?.status, "routes must answer non-null status with the daemon up");
    for (const secret of SECRETS) assert.ok(!s.text.includes(secret) && !w.text.includes(secret), `response leaks ${secret}`);
  });
  await check(T.AC8, "stale key auth failure", async () => {
    setState({ mode: "auth" });
    const r = await get("/api/polyforge/status");
    assert.equal(r.status, 200); assert.equal(r.json?.status, null);
    assert.match(String(r.json?.error), /401 unauthorized/, "pf's own stderr must surface");
    assert.ok(!r.text.includes(STALE_KEY), "response leaks an env value");
  });
  await check(T.AC8, "hang times out to unavailable", async () => {
    setState({ mode: "hang" });
    const t0 = Date.now(); const r = await get("/api/polyforge/status");
    assert.ok(r.status === 200 && r.json && r.json.status === null, `hang answered ${r.status} ${r.text.slice(0, 80)}`);
    assert.ok(Date.now() - t0 < 20_000, `hang took ${Date.now() - t0}ms (want ~10s timeout)`);
  });

  // AC3/AC2 — daemon down
  setState({ mode: "down" });
  await check(T.AC3, "daemon down routes", async () => {
    const s = await get("/api/polyforge/status"); const w = await get("/api/polyforge/watch?wi=pi%23108");
    assert.ok(s.status === 200 && s.json && s.json.status === null && s.json.error, `status route: ${s.status} ${s.text.slice(0, 80)}`);
    assert.ok(w.status === 200 && w.json && w.json.status === null && w.json.error, `watch route: ${w.status} ${w.text.slice(0, 80)}`);
    assert.notDeepEqual(s.json, absentBody, "pf presence is not distinguishable from pf absence");
  });
  await check(T.AC3, "malformed wi 400", async () => {
    const r = await get("/api/polyforge/watch?wi=not%20a%20ref");
    assert.equal(r.status, 400); assert.ok(r.json?.error, "400 needs a field-level error body");
  });
  await withPage(T.AC2, "no badge when daemon down", {}, async (page) => {
    await pfButton(page).waitFor(); await delay(3_000);
    assert.doesNotMatch(await pfButton(page).innerText(), /\d/, "badge shown while the daemon is down");
    await openPanel(page);
  });
  setState({});

  // AC9 — dock slot
  // pi#117: the desktop dock opens at 460 by default (resizable via its
  // left-edge handle; the e2e asserts the default width only — the clamp,
  // persistence and dismissal-exemption contracts are pinned by unit tests).
  await withPage(T.AC9, "desktop dock + mutual exclusion", {}, async (page) => {
    const box = await (await openPanel(page)).boundingBox();
    assert.ok(Math.abs(box.width - 460) <= 2, `desktop dock is ${box.width}px wide`);
    await page.getByRole("button", { name: "Background tasks", exact: true }).first().click();
    await bgPanel(page).first().waitFor();
    assert.equal(await pfPanel(page).count(), 0, "opening bg-tasks must close the Polyforge panel");
    await pfButton(page).click(); await pfPanel(page).first().waitFor();
    assert.equal(await bgPanel(page).count(), 0, "opening Polyforge must close bg-tasks");
  });
  // 600px: inside the app's mobile breakpoint (<= 640px) but above the narrow
  // (<= 480px) layout that tucks toolbar actions behind a "more" menu.
  await withPage(T.AC9, "mobile sheet", { viewport: { width: 600, height: 900 } }, async (page) => {
    const panel = await openPanel(page);
    const ratio = await panel.evaluate((el) => el.getBoundingClientRect().height / el.offsetParent.getBoundingClientRect().height);
    assert.ok(ratio > 0.3 && ratio <= 0.63, `mobile sheet covers ${ratio} of the height`);
  });

  // AC10 — locales
  for (const locale of ["zh-CN", "zh-TW"]) {
    await withPage(T.AC10, locale, { locale }, async (page) => {
      const text = await (await openPanel(page)).innerText();
      assert.match(text, /[一-鿿]/, `${locale} panel has no translated strings`);
      assert.doesNotMatch(text, /polyforge\.[a-z]/i, `${locale} panel shows a raw i18n key`);
    });
  }

  // ================= pi#112 (wi_5qd5PgbQT1Gw): readable event tail =================
  // Authored pre-code against artifacts/spec.md's Acceptance criteria. The
  // pi#112 stub watch tail (EVENTS_112) drives every new behaviour; the
  // pi#108 fixtures above are untouched, so the existing scenarios keep
  // guarding the pi#108 bar (including the E2E-SECRET-EVENT-BODY sentinel —
  // now also enforced for the widened pi#112 bodies via SECRETS112).

  // N1 — server-side whitelist: per-kind body fields pass, nothing else.
  await check(T.N1, "watch route whitelist", async () => {
    const r = await get(`/api/polyforge/watch?wi=pi%23112`);
    assert.equal(r.status, 200, `watch route answered ${r.status}`);
    assert.ok(r.json?.status, "watch status must be non-null for pi#112");
    const events = arrayOf(r.json, (e) => values(e).some((v) => typeof v === "string" && v.startsWith("2026-10-18T11:")));
    assert.ok(events, "no events array in the watch response");
    const eventsJson = JSON.stringify(events);
    for (const v of [MODEL112, FROM112, TO112, "agent-exit-13", "timeout-after-3-retries", "spec-review", "kilo-author", "completed", "failed", "cancelled", "future_kind_e2e"]) {
      assert.ok(eventsJson.includes(v), `events lack whitelisted value ${JSON.stringify(v)}`);
    }
    for (const kind of ["answered", "authored_tests_rebaselined", "future_kind_e2e"]) {
      const event = events.find((e) => e && e.kind === kind);
      assert.ok(event, `${kind} event missing from the tail`);
      assert.ok(JSON.stringify(event).includes("zulu-grill") || JSON.stringify(event).includes("kilo-author"), `${kind} event lost its step`);
    }
    const switchedEvent = events.find((e) => e && e.kind === "candidate_switched");
    assert.ok(switchedEvent && JSON.stringify(switchedEvent).includes("alpha-plan"), "candidate_switched.step is not exposed by the watch route");
    for (const secret of SECRETS112) assert.ok(!r.text.includes(secret), `watch response leaks ${secret}`);
  });

  // N2 — readable rows (en): friendly label + whitelisted context, model
  // ellipsized with the full value on hover, nothing else rendered.
  await withPage(T.N2, "readable rows", {}, async (page) => {
    const panel = await ensureDetail112(page);
    assert.ok((await panel.locator(`[title*="${MODEL112}"]`).count()) >= 1, "no hover title carries the full model string");
    assert.ok((await panel.getByText("sub2api-glm/glm").count()) >= 1, "the step_started row does not show the model");
    assert.equal(await panel.getByText(MODEL112).count(), 0, "the long model is not ellipsized in the row text");
    const started = await rowText(panel, "step_started", 0);
    assert.ok(started?.includes("zulu-grill") && started.includes(SHORT_MODEL112), `step_started row lacks step/model: ${JSON.stringify(started)}`);
    const started2 = await rowText(panel, "step_started", 1);
    assert.ok(started2?.includes("kilo-author"), `second step_started row lacks its step: ${JSON.stringify(started2)}`);
    const switched = await rowText(panel, "candidate_switched");
    assert.ok(switched?.includes("alpha-plan"), `candidate_switched row lacks its step: ${JSON.stringify(switched)}`);
    assert.ok(switched?.includes(FROM112) && switched.includes(TO112), `candidate_switched row lacks from/to: ${JSON.stringify(switched)}`);
    assert.match(switched ?? "", /→|->/, "candidate_switched row shows no from → to form");
    const failed = await rowText(panel, "step_failed");
    assert.ok(failed?.includes("bravo-code") && failed.includes("agent-exit-13"), `step_failed row lacks step/cause: ${JSON.stringify(failed)}`);
    const dead = await rowText(panel, "step_dead");
    assert.ok(dead?.includes("mike-spec") && dead.includes("timeout-after-3-retries"), `step_dead row lacks step/cause: ${JSON.stringify(dead)}`);
    const rewind = await rowText(panel, "rewind");
    assert.ok(rewind?.includes("spec-review") && rewind.includes("kilo-author"), `rewind row lacks gate/target: ${JSON.stringify(rewind)}`);
    const terminals = await Promise.all([0, 1, 2].map((i) => rowText(panel, "terminal", i)));
    assert.match(terminals[0] ?? "", /completed|complete/i, `terminal completed row lacks its status: ${JSON.stringify(terminals[0])}`);
    assert.match(terminals[1] ?? "", /failed/i, `terminal failed row lacks its status: ${JSON.stringify(terminals[1])}`);
    assert.match(terminals[2] ?? "", /cancelled|canceled/i, `terminal cancelled row lacks its status: ${JSON.stringify(terminals[2])}`);
    const text = await panel.innerText();
    for (const secret of SECRETS112) assert.ok(!text.includes(secret), `panel leaks ${secret}`);
  });

  // N3 — friendly labels exist for the new kinds in zh-CN and zh-TW, with the
  // whitelisted fields interpolated; no raw polyforge.* key anywhere.
  for (const locale of ["zh-CN", "zh-TW"]) {
    await withPage(T.N3, locale, { locale }, async (page) => {
      const panel = await ensureDetail112(page);
      for (const kind of ["candidate_switched", "step_dead", "rewind", "terminal", "push_failed"]) {
        const row = await rowText(panel, kind);
        assert.ok(row, `${locale}: no row carries the raw kind ${kind} on hover`);
        assert.match(row, /[一-鿿]/, `${locale}: ${kind} row has no translated label`);
      }
      const switched = await rowText(panel, "candidate_switched");
      assert.ok(switched?.includes(FROM112) && switched.includes(TO112), `${locale}: candidate_switched row lost from/to`);
      assert.doesNotMatch(await panel.innerText(), /polyforge\.[a-z]/i, `${locale} panel shows a raw i18n key`);
    });
  }

  // N4 — the three never-occurring kind labels and their i18n keys are gone.
  await check(T.N4, "message files", async () => {
    for (const loc of ["en", "zh-CN", "zh-TW"]) {
      const source = readFileSync(join(root, "lib", "i18n", "messages", `${loc}.ts`), "utf8");
      for (const kind of ["step_blocked", "job_done", "job_blocked"]) {
        assert.ok(!source.includes(`polyforge.eventKind.${kind}`), `${loc} still ships the dead label ${kind}`);
      }
    }
  });

  // N5 — simple mode (the default): noise runs collapse to one gray sync row,
  // lone noise too (sync ×1); meaningful events never collapse.
  await withPage(T.N5, "simple mode", {}, async (page) => {
    const panel = await ensureDetail112(page);
    assert.equal(await panel.getByText(/sync\s*[×x]\s*5/i).count(), 1, "a 5-event noise run did not collapse to one 'sync ×5' row");
    assert.equal(await panel.getByText(/sync\s*[×x]\s*1\b/i).count(), 1, "a lone noise event did not render as one 'sync ×1' row");
    assert.equal(await panel.getByText("transcript_missing").count(), 0, "noise events render individually in simple mode");
    assert.equal(await panel.getByText("exec_init").count(), 0, "noise events render individually in simple mode");
    assert.equal(await panel.locator('[title*="terminal"]').count(), 3, "terminal events collapsed (meaningful events must never collapse)");
    assert.equal(await panel.locator('[title*="step_started"]').count(), 2, "step_started events collapsed (meaningful events must never collapse)");
    assert.equal(await panel.locator('[title*="job_started"]').count(), 1, "job_started event collapsed (meaningful events must never collapse)");
    // pi#114: the old "zulu-grill" anchor matched a step chip (now a status-coloured
    // graph node), not an event row; compare like with like (row label vs row label).
    const syncContrast = await textContrast(panel, "sync");
    const anchorContrast = await textContrast(panel, enKindLabel("gate_verdict"));
    assert.ok(syncContrast !== null && anchorContrast !== null && syncContrast < anchorContrast,
      `the sync row is not de-emphasized (gray) against a meaningful row (sync ${syncContrast}, anchor ${anchorContrast})`);
  });

  // N6 — verbose mode: every event its own row, noise grayed individually,
  // raw kind inline, no collapsing.
  await withPage(T.N6, "verbose mode", {}, async (page) => {
    const toggle = await findEventModeToggle(page); // leaves the tail in simple mode
    assert.ok(toggle, "no control in the panel switches the event tail to verbose mode");
    await toggle.click();
    await delay(300);
    const panel = pfPanel(page).first();
    assert.equal(await panel.locator('[title*="published"]').count(), 3, "verbose mode must render every published event");
    assert.equal(await panel.locator('[title*="transcript_missing"]').count(), 2, "verbose mode must render every transcript_missing event");
    assert.equal(await panel.locator('[title*="exec_init"]').count(), 1, "verbose mode must render every exec_init event");
    assert.equal(await panel.locator('[title*="step_started"]').count(), 2, "verbose mode must render every step_started event");
    assert.equal(await panel.locator('[title*="terminal"]').count(), 3, "verbose mode must render every terminal event");
    assert.equal(await panel.getByText(/sync\s*[×x]\s*\d/i).count(), 0, "verbose mode must not collapse noise runs");
    const pushed = await rowText(panel, "push_failed");
    assert.ok(pushed?.includes("push_failed"), `the raw kind is not shown inline on verbose rows: ${JSON.stringify(pushed)}`);
    // Like-with-like: compare the noise row's friendly label against a
    // meaningful neutral row's label (the raw-kind spans are dim on every
    // verbose row, so comparing those would pass even without noise styling).
    const noiseContrast = await textContrast(panel, enKindLabel("exec_init"));
    const anchorContrast = await textContrast(panel, enKindLabel("gate_verdict"));
    assert.ok(noiseContrast !== null && anchorContrast !== null && noiseContrast < anchorContrast,
      `verbose noise rows are not grayed (noise ${noiseContrast}, anchor ${anchorContrast})`);
  });

  // N7 — the raw kind is one hover away in both modes (touch screens).
  await withPage(T.N7, "hover titles", {}, async (page) => {
    const panel = await ensureDetail112(page); // simple mode (the default)
    for (const kind of ["step_started", "candidate_switched", "step_failed", "step_dead", "needs_input", "rewind", "terminal", "answered", "gate_verdict", "future_kind_e2e"]) {
      assert.ok((await panel.locator(`[title*="${kind}"]`).count()) >= 1, `simple mode: no hover title carries the raw kind ${kind}`);
    }
    const toggle = await findEventModeToggle(page);
    assert.ok(toggle, "no mode toggle found");
    await toggle.click();
    await delay(300);
    const panel2 = pfPanel(page).first();
    for (const kind of ["published", "transcript_missing", "exec_init"]) {
      assert.ok((await panel2.locator(`[title*="${kind}"]`).count()) >= 1, `verbose mode: no hover title carries the raw kind ${kind}`);
    }
  });

  // N8 — severity: needs_input amber; failures red; terminal completed green;
  // terminal failed red; terminal cancelled and everything else neutral.
  await withPage(T.N8, "severity", {}, async (page) => {
    const panel = await ensureDetail112(page);
    const first = async (kind) => (await rowFamilies(panel, kind))[0] ?? [];
    assert.ok((await first("needs_input")).includes("amber"), "the needs_input row is not amber");
    for (const kind of ["step_failed", "step_dead", "push_failed", "envelope_rejected", "needs_recovery"]) {
      assert.ok((await first(kind)).includes("red"), `the ${kind} row is not red`);
    }
    const terminals = await rowFamilies(panel, "terminal");
    assert.equal(terminals.length, 3, `expected 3 terminal rows, found ${terminals.length}`);
    assert.ok(terminals[0].includes("green") && !terminals[0].includes("red"), "the terminal completed row is not green");
    assert.ok(terminals[1].includes("red"), "the terminal failed row is not red");
    assert.ok(!terminals[2].some((f) => ["red", "amber", "green"].includes(f)), "the terminal cancelled row is not neutral");
    for (const kind of ["answered", "gate_verdict", "rewind"]) {
      assert.ok(!(await first(kind)).some((f) => ["red", "amber", "green"].includes(f)), `the ${kind} row is not neutral`);
    }
  });

  // N9 — the mode toggle: default simple on a first visit, no request when
  // toggled, and the preference survives a reload.
  await withPage(T.N9, "toggle", {}, async (page) => {
    const watchHits = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/polyforge/watch") watchHits.push(Date.now()); });
    const panel = await ensureDetail112(page);
    assert.equal(await panel.getByText(/sync\s*[×x]\s*5/i).count(), 1, "first visit is not simple mode (no collapsed noise row)");
    assert.equal(await panel.locator('[title*="exec_init"]').count(), 0, "first visit renders per-event noise rows (default must be simple)");
    const toggle = await findEventModeToggle(page); // leaves the tail in simple mode
    assert.ok(toggle, "no mode-toggle control in the event-tail area");
    // Flip simple → verbose, synchronized just after a watch poll: the next
    // cadence poll is ~3s away, so any request before it is the toggle's own
    // network I/O (the spec forbids any).
    await page.waitForRequest((r) => new URL(r.url()).pathname === "/api/polyforge/watch", { timeout: 9000 });
    await delay(100);
    const lastPoll = watchHits.at(-1);
    await delay(300);
    await toggle.click();
    await delay(3500);
    const early = watchHits.filter((t) => t > (lastPoll ?? 0) + 300 && t < (lastPoll ?? 0) + 2500);
    assert.deepEqual(early, [], `the mode toggle issued ${early.length} server request(s)`);
    assert.ok((await pfPanel(page).first().locator('[title*="exec_init"]').count()) >= 1, "the toggle did not switch to verbose mode");
    await toggle.click();
    await delay(300);
    assert.equal(await panel.getByText(/sync\s*[×x]\s*5/i).count(), 1, "the toggle did not switch back to simple mode");
    await toggle.click();
    await delay(300);
    assert.ok((await pfPanel(page).first().locator('[title*="exec_init"]').count()) >= 1, "the toggle did not switch back to verbose mode");
    // Persisted globally in localStorage: a reload restores verbose without
    // re-toggling.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("E2E polyforge host session").first().waitFor({ state: "attached", timeout: 60_000 });
    const panel2 = await ensureDetail112(page);
    assert.ok((await panel2.locator('[title*="exec_init"]').count()) >= 1, "the verbose preference did not survive a reload");
  });

  // N10 — the Sanitization docs change with the code: the per-kind whitelist
  // (and the never-leaks list) is described, and the old "bodies are dropped
  // wholesale" wording is gone.
  await check(T.N10, "sanitization docs", async () => {
    const doc = readFileSync(join(root, "docs", "agents", "polyforge-panel.md"), "utf8");
    const section = /## Sanitization[\s\S]*?(?=\n## |$)/.exec(doc)?.[0] ?? "";
    assert.ok(section.length > 0, "the doc has no Sanitization section");
    for (const word of ["step_started", "model", "candidate_switched", "terminal", "status", "question", "error"]) {
      assert.ok(new RegExp(word, "i").test(section), `the Sanitization section does not mention ${word}`);
    }
  });

  // N11 — DELETED before completion: "N11: Unknown kind renders its raw kind
  // string" PASSED on the pre-implementation tree (pi#108's eventKindLabel
  // already passes unknown kinds through raw) — existing behaviour, recorded
  // as already_satisfied. Its never-a-raw-polyforge.*-key half stays guarded
  // by the AC10 locale checks, which now also cover the pi#112 kinds.
  await check(T.AC3, "pf present: no 5xx or console errors", async () => assert.deepEqual(errors.splice(0), []));
  await stopServer();
  await check(T.AC8, "no env value in server logs", async () => {
    for (const file of serverLogs) assert.ok(!readFileSync(file, "utf8").includes(STALE_KEY), `${file} contains an env value`);
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopServer().catch(() => {});
  for (const [title, list] of failures) {
    if (!ran.has(title)) list.push("scenario not reached");
    console.log(list.length ? `FAIL: ${title}\n  - ${list.join("\n  - ")}` : `PASS: ${title}`);
    if (list.length) process.exitCode = 1;
  }
  if (process.exitCode) console.log(`Artifacts kept: ${work}`); else rmSync(work, { recursive: true, force: true });
}
