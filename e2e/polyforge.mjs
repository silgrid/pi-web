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
const SECRETS = ["E2E_ENV_NAME_SENTINEL", "/srv/e2e-secret-workspace", "E2E-SECRET-WORKER-COMMAND", "E2E-SECRET-EVENT-BODY", "fp-secret-session"];
const QUESTION = "E2E-PENDING-QUESTION-TEXT which colour?";
const LONG_CANDIDATE = "claude:claude-opus-5-5-extended-context-e2e";
const job = (id, slug, status, spawn, step, idle, candidate, owner) => ({ work_item_id: id, slug, status, spawn_n: spawn,
  session_fingerprint: "fp-secret-session", step_age_sec: step, last_work_ago_sec: idle, candidate, origin: { kind: "chat", owner } });
const JOBS = [
  job("wi_E2Eaaaa0001", "pi#108", "running", 3, 7325, 4337, LONG_CANDIDATE, "u_alice"),
  job("wi_E2Ebbbb0002", "demo#7", "running", 1, 61, 5, "pi:glm-e2e", "u_bob"),
  job("wi_E2Ecccc0003", "pi#109", "needs_input", 2, 900, 880, "codex:gpt-e2e", "svc_ci"),
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
  progress: { command: "E2E-SECRET-WORKER-COMMAND --flag", tool_calls: 9 },
  events: Array.from({ length: 60 }, (_, i) => ({ at: at(i + 1), kind: i % 2 ? "published" : "step_started", work_item: "wi_E2Eaaaa0001",
    body: { step: "kilo-author", spawn_n: 3, detail: `E2E-SECRET-EVENT-BODY-${i + 1}` }, seq: i + 1 })), last_seq: 60 };
const WATCH_109 = { work_item: "wi_E2Ecccc0003", slug: "pi#109", known: true, job: { status: "needs_input" },
  execution: { workflow_status: "blocked", current_step: "zulu-grill", updated_at: at(3), pending_question: QUESTION,
    steps: { "zulu-grill": { status: "blocked", started_at: "2026-10-18T09:00:00Z" } } },
  events: [{ at: at(3), kind: "needs_input", work_item: "wi_E2Ecccc0003", body: { question: QUESTION, step: "zulu-grill" }, seq: 3 }], last_seq: 3 };
const stubDir = join(work, "stub-bin");
mkdirSync(stubDir);
const stateFile = join(stubDir, "state.json");
const argvLog = join(stubDir, "argv.log");
const setState = (patch) => writeFileSync(stateFile, JSON.stringify({ mode: "ok", ops: ops(JOBS), watch: { "pi#108": WATCH_108,
  wi_E2Eaaaa0001: WATCH_108, "pi#109": WATCH_109, wi_E2Ecccc0003: WATCH_109 }, ...patch }));
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
  AC5: "AC5: Selected WI shows header, ordered step chips and the last 40 events",
  AC6: "AC6: Selected WI stays selected after it leaves the job list",
  AC7: "AC7: Blocked WI shows its status only, never the pending-question text",
  AC8: "AC8: Routes validate refs before argv, time out to unavailable and leak no env values or hidden fields",
  AC9: "AC9: Panel docks 340px right on desktop / 62% bottom sheet on mobile, sharing the bg-tasks slot",
  AC10: "AC10: Panel strings are localized in zh-CN and zh-TW",
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
  });
  await withPage(T.AC5, "detail panel", {}, async (page) => {
    const panel = await openPanel(page);
    await panel.getByText("pi#108", { exact: true }).first().click();
    await panel.getByText("zulu-grill").first().waitFor();
    const text = await panel.innerText();
    const idx = STEP_ORDER.map((s) => text.indexOf(s));
    assert.ok(idx.every((i) => i >= 0), `step chips missing: ${JSON.stringify(idx)}`);
    assert.ok(idx[0] < idx[1] && idx[1] < idx[2], "step chips not in execution order");
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
  await withPage(T.AC9, "desktop dock + mutual exclusion", {}, async (page) => {
    const box = await (await openPanel(page)).boundingBox();
    assert.ok(Math.abs(box.width - 340) <= 2, `desktop dock is ${box.width}px wide`);
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
