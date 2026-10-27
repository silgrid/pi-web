// — pi-web Messages tab: dual-user stateful pf-stub end-to-end pass.
//
// Authored pre-code against artifacts/spec.md (+ artifacts/plan.md decisions);
// the capsule's artifacts/e2e-scenarios.md mirrors its scenario blocks
// (PM1..PM8). The suite starts its own `next dev` on a stub `pf` first on
// PATH. The stub is a real state machine for TWO human users: it keeps each
// conversation's messages and per-user unread, records every send/ack/analyze
// argv in a ledger, and can switch the acting identity (`self`), so the suite
// drives both sides of one conversation through the UI alone.
//
// Baseline posture: the Messages surface does not exist yet, so every scenario
// is an assertion-level red (no Messages tab, no conversations, no ack in the
// ledger) — never a build or fixture error.
//
//   node e2e/polyforge-messages.mjs
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startNextServer } from "./next-server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(!existsSync(join(root, process.env.PI_WEB_DIST_DIR || ".next", "dev/lock")), "Run in a checkout without an active dev server");
const work = mkdtempSync(join(tmpdir(), "pi-web-pf-messages-e2e-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
const cliDir = join(work, ".config", "polyforge");
for (const dir of [join(agentDir, "sessions", "e2e"), project, cliDir]) mkdirSync(dir, { recursive: true });
const SESSION = "e2e-pf-messages-session";
const sessionFile = join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`);
const ts = "2026-10-18T00:00:00.000Z";
const writeSession = (body) => writeFileSync(sessionFile, [
  { type: "session", version: 3, id: SESSION, timestamp: ts, cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: body } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
writeSession("E2E pf messages host session");

// Sentinels: the operator identity, credential, server address and an
// environment name must never leave the server; a message body must never
// reach the pi-web server log.
const KEY_SENTINEL = "E2E-PF-API-KEY-SENTINEL-56";
const USER_SENTINEL = "u_e2e_sentinel_self";
const PEER = "u_e2e_peer";
const SERVER_SENTINEL = "http://10.9.9.56:8420";
const ENV_SENTINEL = "E2E_ENV_NAME_SENTINEL_56";
const BODY_SENTINEL = "E2E-BODY-SENTINEL-56";
const SECRET_SENTINEL = "AKIAE2ESECRETSENTINEL56";
const ANALYSIS_SENTINEL = "E2E-ANALYSIS-SENTINEL-56";
writeFileSync(join(cliDir, "cli.toml"), `server = "${SERVER_SENTINEL}"\napi_key = "${KEY_SENTINEL}"\nuser_id = "${USER_SENTINEL}"\n`);

// ---- stateful dual-user pf stub (state.json + argv.log in its own dir) ----
const stubDir = join(work, "stub-bin");
mkdirSync(stubDir);
const stateFile = join(stubDir, "state.json");
const argvLog = join(stubDir, "argv.log");
const msg = (seq, sender, text, extra = {}) => ({ id: `msg_${seq}_${sender}`, seq, sender, text, about_wi: "", reply_to: "", ...extra });
const conversation = (id, peer, messages) => ({ id, peer, messages, lastSeq: messages[messages.length - 1].seq });
const PAGED = conversation("conv_paged", "u_e2e_paged_peer", Array.from({ length: 120 }, (_, i) =>
  // Numbered globally (not 1001..1120 per conversation) so paging cannot
  // pass by assuming a conversation's first seq is 1 (the review finding).
  msg(1001 + i, i % 2 ? "peer" : "self", `MSG-${String(i + 1).padStart(3, "0")}`)));
const ANCHOR = conversation("conv_anchor", PEER, [
  msg(1, "peer", "ANCHOR-ONE", { about_wi: "task-42" }),
  msg(2, "peer", "ANCHOR-DEEP", { about_wi: "task-42/artifacts/spec.md" }),
  msg(3, "peer", BODY_SENTINEL + " UNANCHORED-ONE"),
  msg(4, "self", "OWN-MESSAGE"),
]);
const baseState = () => ({
  version: "v2.20.7", mode: "ok", self: USER_SENTINEL, running: 2, blocked: false, sendError: "",
  conversations: [
    conversation("conv_dot", "u_e2e_dot_peer", [msg(1, "peer", "DOT-UNREAD-ONE")]),
    PAGED,
    ANCHOR,
  ],
  acked: { conv_paged: 120, conv_anchor: 4 },
  sends: [], analyses: [],
});
const write = (state) => writeFileSync(stateFile, JSON.stringify(state));
const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
const seed = (patch = {}) => {
  const next = { ...baseState(), ...patch };
  write(next);
  writeFileSync(argvLog, "");
  return next;
};
seed();
const watchDetail = { work_item: "wi_e2e_39", slug: "task-42", known: true, job: { status: "running" },
  execution: { workflow_status: "running", current_step: "WATCH-DETAIL-39", updated_at: ts,
    steps: { "WATCH-DETAIL-39": { status: "in_progress", started_at: ts } } }, events: [], last_seq: 0 };
writeFileSync(join(stubDir, "state-watch.json"), JSON.stringify(watchDetail));
writeFileSync(join(stubDir, "pf"), `#!${process.execPath}
const fs = require("fs"); const path = require("path");
const dir = path.dirname(fs.realpathSync(__filename));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "argv.log"), JSON.stringify(args) + "\\n");
const s = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const save = () => fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(s));
const out = (v) => { process.stdout.write(JSON.stringify(v) + "\\n"); process.exit(0); };
const die = (code, text) => { process.stderr.write(text + "\\n"); process.exit(code); };
const fail = (code, detail) => { process.stderr.write(JSON.stringify({ code, detail }) + "\\n"); process.exit(4); };
if (args.includes("--version")) { process.stdout.write(s.version + "\\n"); process.exit(0); }
const rest = args.filter((a) => a !== "--json");
const at = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const conv = (id) => s.conversations.find((c) => c.id === id);
const listRow = (c) => ({
  id: c.id, kind: "direct", members: [s.self, c.peer], peer: c.peer, created_at: "2026-10-18T00:00:00Z",
  last_seq: c.lastSeq, unread: c.messages.filter((m) => m.sender !== s.self && m.seq > (s.acked[c.id] || 0)).length,
});
if (rest[0] === "ops" && rest[1] === "status") {
  if (s.mode === "down") die(1, "pf: daemon not reachable (connection refused)");
  const jobs = [{ work_item_id: "wi_e2e_39", slug: "task-42", status: "running", spawn_n: 1, step_age_sec: 30, last_work_ago_sec: 3, candidate: "pi:e2e" }];
  if (s.blocked) jobs.push({ work_item_id: "wi_e2e_blocked", slug: "blocked-job", status: "needs_input", spawn_n: 1, step_age_sec: 900, last_work_ago_sec: 880, candidate: "pi:e2e" });
  out({ machine_id: "m-e2e", workspaces: ["/srv/e2e-workspace"], workflows_dir: "/srv/e2e-workspace/wf",
    env_names: ["${ENV_SENTINEL}"], jobs, queue: { pending: 0, running: s.running, max_concurrent: 4 } });
}
if (rest[0] === "config" && rest[1] === "list") out({ items: [
  { key: "server", value: "${SERVER_SENTINEL}", source: "file" }, { key: "api_key", set: true, source: "file" },
  { key: "user_id", value: "${USER_SENTINEL}", source: "file" }] });
if (rest[0] === "watch") out(JSON.parse(fs.readFileSync(path.join(dir, "state-watch.json"), "utf8")));
if (rest[0] === "msg") {
  if (rest[1] === "analyze") {
    if (s.mode === "analyzeFail") fail("DAEMON-500", "analyzer is not assembled on this machine");
    out({ message_id: rest[2], conclusion: "${ANALYSIS_SENTINEL} the peer asks for a review", model: "stub" });
  }
  if (rest[1] === "ack") {
    const c = conv(rest[2]);
    if (!c) fail("CORE-404", "conversation " + rest[2] + " is unknown");
    const asked = at("--seq") !== undefined ? Number(at("--seq")) : c.lastSeq;
    if (asked <= 0 || asked > c.lastSeq) fail("CORE-400", "seq " + asked + " is outside 1.." + c.lastSeq);
    s.acked[c.id] = Math.max(s.acked[c.id] || 0, asked);
    save(); out({ ok: true });
  }
  if (rest[1] === "send") {
    if (s.sendError) fail(s.sendError, "message refused: secret-shaped content (aws_key) is never stored or sent");
    const to = at("--to"); const text = at("--text");
    if (!to || !text) fail("CORE-400", "--to and --text are required");
    let c = s.conversations.find((x) => x.peer === to);
    if (!c) { c = { id: "conv_new_" + Date.now(), peer: to, messages: [], lastSeq: 0 }; s.conversations.push(c); }
    const row = { id: "msg_sent_" + (c.lastSeq + 1), seq: c.lastSeq + 1, sender: "self", text,
      about_wi: at("--about-wi") || "", reply_to: at("--reply-to") || "" };
    c.messages.push(row); c.lastSeq = row.seq; s.sends.push({ to, text, aboutWi: row.about_wi, replyTo: row.reply_to });
    save(); out({ id: row.id, seq: row.seq, conversation_id: c.id, sender_id: s.self, text: row.text,
      about_wi: row.about_wi, reply_to: row.reply_to });
  }
  if (rest[1] === "list" && at("--conversation")) {
    const c = conv(at("--conversation"));
    if (!c) fail("CORE-404", "conversation is unknown");
    const before = Number(at("--before") || 0); const after = Number(at("--after") || 0); const limit = Number(at("--limit") || 50);
    const cap = s.historyCap === undefined ? Infinity : s.historyCap;
    let rows = c.messages.filter((m) => m.seq <= cap && (!before || m.seq < before) && (!after || m.seq > after));
    if (before) rows = rows.slice(-limit); else rows = rows.slice(0, limit);
    out({ messages: rows.map((m) => ({
      id: m.id, seq: m.seq, conversation_id: c.id,
      sender_id: m.sender === "self" ? s.self : c.peer,
      text: m.text, about_wi: m.about_wi, reply_to: m.reply_to,
      created_at: "2026-10-18T00:00:00Z",
    })), last_seq: c.lastSeq });
  }
  if (rest[1] === "list") out({ conversations: s.conversations.map(listRow) });
  fail("CORE-400", "msg: unknown action " + rest[1]);
}
die(2, "pf: unknown command");
`);
chmodSync(join(stubDir, "pf"), 0o755);
const calls = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean)
  .map((line) => JSON.parse(line).filter((part) => part !== "--json")) : []);
const msgCalls = () => calls().filter((a) => a[0] === "msg");
const acks = () => msgCalls().filter((a) => a[1] === "ack");
const sends = () => msgCalls().filter((a) => a[1] === "send");
const argAfter = (argv, name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

// ---- scenario bookkeeping ----
const T = {
  PM1: "PM1: the Messages tab shows an unread dot beside the unchanged running-count badge, and no dot at zero unread",
  PM2: "PM2: opening a conversation shows the newest page at the bottom and scroll-up prepends the page immediately above with no gap or duplicate, stopping at the oldest message",
  PM3: "PM3: a visible conversation acks exactly the newest displayed sequence once and clears unread, and a newer unseen sequence is never the acked one",
  PM4: "PM4: a hidden conversation and a locally blocked job suppress automatic ack, and an explicit conversation click acks the newest displayed sequence",
  PM5: "PM5: a send spawns exactly one pf msg send (with its anchor), a reply passes --reply-to and quotes the loaded original, and a refused send answers a 4xx with the documented text",
  PM6: "PM6: a work-item anchor opens the existing Jobs detail through the watch read, a deep reference exposes only its work-item part, the analyzer appears only on received messages and its conclusion is transient, and incoming messages never enter chat or the composer",
  PM7: "PM7: no messages route response or server log carries the operator key, identity, server address or a message body, and a CORE-422-refused send leaves no trace",
  PM8: "PM8: below the pf Messages floor the tab shows an upgrade-needed state and spawns no message verb",
};
const failures = new Map(Object.values(T).map((title) => [title, []]));
async function check(title, label, fn) {
  try { await fn(); console.log(`PASS ${label}`); }
  catch (error) { failures.get(title).push(`${label}: ${String(error?.message ?? error).split("\n")[0]}`); console.log(`FAIL ${label}: ${error?.message ?? error}`); }
}

const errors = [];
const serverLogs = [];
let browser; let base; let stop = async () => {};
async function startServer(name, version) {
  const state = readState(); if (version) { state.version = version; write(state); }
  const logFile = join(work, `server-${name}.log`); serverLogs.push(logFile);
  const started = await startNextServer({
    name, logFile,
    env: { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH}`, HOME: work, PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_ALLOWED_ROOT_PREFIXES: work,
      POLYFORGE_V1_API_KEY: KEY_SENTINEL, [ENV_SENTINEL]: KEY_SENTINEL },
  });
  base = started.base; stop = started.stop;
}
async function openPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => { try { localStorage.setItem("pi-web:split-view-enabled", "false"); localStorage.setItem("pi-locale", "en"); } catch {} });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
  page.on("response", (r) => { if (r.url().startsWith(base) && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.getByText("E2E pf messages host session").first().waitFor({ state: "attached", timeout: 60_000 });
  return page;
}
const get = (path) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(60_000) }).then(async (r) => ({ status: r.status, text: await r.text() }));
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(60_000) })
  .then(async (r) => ({ status: r.status, text: await r.text() }));
const withPage = async (fn) => { const page = await openPage(); try { return await fn(page); } finally { await page.context().close(); } };
const pfButton = (page) => page.getByRole("button", { name: /^(?!.*close).*polyforge/i }).first();
const dock = (page) => page.locator("#polyforge-dock");
const tab = (page, name) => dock(page).getByRole("tab", { name }).or(dock(page).getByRole("button", { name })).first();
const unreadDots = (root) => root.locator('[aria-label*="unread" i], [title*="unread" i], [data-testid="unread-dot"], [data-unread-dot]');
async function openDock(page) { await pfButton(page).click(); await dock(page).waitFor(); return dock(page); }
async function messagesTab(page) { const t = tab(page, /^messages/i); await t.waitFor({ timeout: 15_000 }); await t.click(); return t; }
async function openConversation(page, conv) {
  const panel = dock(page);
  const needle = conv.messages[conv.messages.length - 1].text;
  // A direct conversation is identified by its peer (one per user pair); the
  // list no longer carries a message preview to match on. Retry the click: a
  // list poll may replace the row between locating it and clicking it.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    // If a previously opened conversation is still showing, return to the list
    // first: the header also carries the peer text, which is not a list row.
    const back = panel.getByRole("button", { name: /←/ }).first();
    if (await back.count()) await back.click().catch(() => {});
    for (const want of [conv.peer, needle]) {
      const item = panel.getByText(want, { exact: false }).first();
      try { await item.waitFor({ timeout: 5000 }); } catch { continue; }
      await item.click({ timeout: 5000 }).catch(() => {});
      try {
        await panel.getByText(needle, { exact: false }).last().waitFor({ timeout: 5000 });
        return;
      } catch {
        // The click was lost to a list refresh; retry below.
      }
    }
  }
  throw new Error(`conversation ${conv.id} is not in the Messages list`);
}
// The history scroll region: the deepest scrollable element containing the newest text.
const historyInfo = (panel, needle) => panel.evaluate((root, needle) => {
  const candidates = [...root.querySelectorAll("*")].filter((el) => {
    const cs = getComputedStyle(el);
    return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20 && (el.textContent || "").includes(needle);
  });
  if (!candidates.length) return null;
  const el = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
  return { text: el.textContent || "", top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight };
}, needle);
async function scrollHistoryTop(panel, needle) {
  await panel.evaluate((root, needle) => {
    const candidates = [...root.querySelectorAll("*")].filter((el) => {
      const cs = getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20 && (el.textContent || "").includes(needle);
    });
    const el = candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0];
    if (el) { el.scrollTop = 0; el.dispatchEvent(new Event("scroll", { bubbles: true })); }
  }, needle);
}
// Visual de-emphasis: contrast to the nearest opaque background × product of opacity.
const emphasis = (panel, needle) => panel.evaluate((root, needle) => {
  const lum = (color) => { const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/.exec(String(color)); return !m || (m[4] !== undefined && Number(m[4]) === 0) ? null : (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255; };
  const el = [...root.querySelectorAll("*")].find((node) => (node.textContent || "").includes(needle) && ![...node.children].some((child) => (child.textContent || "").includes(needle)));
  if (!el) return null;
  let bg = 0.5; for (let node = el; node; node = node.parentElement) { const l = lum(getComputedStyle(node).backgroundColor); if (l !== null) { bg = l; break; } }
  let opacity = 1; for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity || 1);
  const fg = lum(getComputedStyle(el).color); return fg === null ? null : Math.abs(fg - bg) * opacity;
}, needle);

try {
  browser = await chromium.launch();
  await startServer("main");

  await check(T.PM1, "PM1 dot beside the running badge", () => withPage(async (page) => {
    seed();
    await openDock(page);
    const button = pfButton(page);
    assert.ok((await button.textContent() || "").includes("2"), "the topbar button must still show the running count 2");
    const messages = await messagesTab(page);
    assert.ok((await unreadDots(messages).count()) >= 1 || /unread/i.test(await messages.getAttribute("aria-label") || ""), "the Messages tab must show an unread dot");
    assert.ok((await unreadDots(button).count()) >= 1, "the topbar button must show the unread dot beside the running count");
    assert.ok((await button.textContent() || "").includes("2"), "the unread dot must not replace the running-count badge");
    // Zero unread: a fresh page with the dot's conversation acknowledged.
    const state = readState(); state.acked.conv_dot = 1; write(state);
    await page.context().close();
    const page2 = await openPage();
    try {
      await openDock(page2);
      const messages2 = await messagesTab(page2);
      assert.equal(await unreadDots(messages2).count(), 0, "zero unread must show no dot on the tab");
      assert.equal(await unreadDots(pfButton(page2)).count(), 0, "zero unread must show no dot on the topbar button");
    } finally { await page2.context().close(); }
  }));

  await check(T.PM2, "PM2 newest page then scroll-up paging", () => withPage(async (page) => {
    seed();
    await openDock(page); await messagesTab(page); await openConversation(page, PAGED);
    const panel = dock(page);
    await panel.getByText("MSG-120", { exact: false }).first().waitFor({ timeout: 20_000 });
    let info = await historyInfo(panel, "MSG-120");
    assert.ok(info, "the conversation history must be a scrollable region");
    assert.ok(info.top + info.client >= info.height - 24, `opening must be positioned at the bottom (${info.top}/${info.height - info.client})`);
    assert.ok(info.text.includes("MSG-071"), "the newest page must start at MSG-071");
    assert.ok(!info.text.includes("MSG-070"), "MSG-070 belongs to the next page and must not be loaded yet");

    await scrollHistoryTop(panel, "MSG-120");
    await panel.getByText("MSG-070", { exact: false }).first().waitFor({ timeout: 20_000 });
    info = await historyInfo(panel, "MSG-120");
    assert.ok(info.text.includes("MSG-021"), "the page below 71 must start at MSG-021");
    assert.ok(!info.text.includes("MSG-020"), "MSG-020 belongs to the third page");
    assert.equal((info.text.match(/MSG-071/g) || []).length, 1, "the page boundary must not duplicate MSG-071");
    assert.ok(msgCalls().some((a) => a[1] === "list" && argAfter(a, "--before") === "1071"), "scroll-up must request --before 1071");

    await scrollHistoryTop(panel, "MSG-120");
    await panel.getByText("MSG-001", { exact: false }).first().waitFor({ timeout: 20_000 });
    const beforeCount = msgCalls().filter((a) => a[1] === "list" && argAfter(a, "--before")).length;
    await scrollHistoryTop(panel, "MSG-120");
    await delay(1500);
    assert.equal(msgCalls().filter((a) => a[1] === "list" && argAfter(a, "--before")).length, beforeCount, "the oldest message must end paging");
  }));

  await check(T.PM3, "PM3 visible auto-ack names the newest displayed seq", () => withPage(async (page) => {
    seed({ conversations: [conversation("conv_ack", PEER, [msg(1, "self", "ACK-ONE"), msg(2, "self", "ACK-TWO"), msg(3, "peer", "ACK-THREE")])],
      acked: { conv_ack: 2 } });
    await openDock(page); await messagesTab(page); await openConversation(page, readState().conversations[0]);
    for (let i = 0; i < 20 && !acks().length; i++) await delay(500);
    const first = acks();
    assert.equal(first.length, 1, `exactly one automatic ack must be sent, got ${JSON.stringify(first)}`);
    assert.equal(argAfter(first[0], "--seq"), "3", "the ack must name the newest displayed sequence 3");
    assert.equal(readState().acked.conv_ack, 3, "the ack must be recorded server-side");
    for (let i = 0; i < 12 && await unreadDots(dock(page)).count(); i++) await delay(500);
    assert.equal(await unreadDots(dock(page)).count(), 0, "unread must clear after the ack");

    // A newer message the user has not seen yet: the history page still ends at 3.
    const state = readState();
    state.conversations[0].messages.push(msg(4, "peer", "ACK-FOUR"));
    state.conversations[0].lastSeq = 4; state.historyCap = 3; write(state);
    await delay(4200);
    assert.ok(!acks().some((a) => argAfter(a, "--seq") === "4"), "a sequence the user has not seen must never be acked");
    state.historyCap = undefined; state.conversations[0].lastSeq = 4; write(state);
    for (let i = 0; i < 20 && !acks().some((a) => argAfter(a, "--seq") === "4"); i++) await delay(500);
    assert.ok(acks().some((a) => argAfter(a, "--seq") === "4"), "once sequence 4 is displayed it must be acked");
  }));

  await check(T.PM4, "PM4 hidden and blocked suppress auto-ack", () => withPage(async (page) => {
    seed({ conversations: [conversation("conv_hidden", PEER, [msg(1, "self", "HIDDEN-ONE"), msg(2, "peer", "HIDDEN-TWO")])], acked: { conv_hidden: 1 } });
    await openDock(page);
    // The panel is open but the Messages tab is not active: arrivals never ack.
    let state = readState(); state.conversations[0].messages.push(msg(3, "peer", "HIDDEN-THREE")); state.conversations[0].lastSeq = 3; write(state);
    await delay(4200);
    assert.equal(acks().length, 0, "another tab must not acknowledge an arrival");
    // Panel closed: still nothing.
    await page.getByRole("button", { name: /close polyforge/i }).first().click();
    state = readState(); state.conversations[0].messages.push(msg(4, "peer", "HIDDEN-FOUR")); state.conversations[0].lastSeq = 4; write(state);
    await delay(4200);
    assert.equal(acks().length, 0, "a closed panel must not acknowledge an arrival");
    // Visible, but a local job is blocked: still no automatic ack or auto-switch.
    state = readState(); state.blocked = true; write(state);
    await openDock(page); await messagesTab(page); await openConversation(page, state.conversations[0]);
    await delay(4200);
    assert.equal(acks().length, 0, "a blocked local job must suppress automatic acknowledgment");
    assert.ok(await dock(page).getByText("HIDDEN-FOUR", { exact: false }).count() > 0, "the panel must not switch tabs or drop the conversation");
    // An explicit user action acknowledges the newest displayed sequence.
    await dock(page).getByText("HIDDEN-FOUR", { exact: false }).last().click();
    for (let i = 0; i < 20 && !acks().length; i++) await delay(500);
    assert.equal(acks().length, 1, "an explicit click must send the acknowledgment");
    assert.equal(argAfter(acks()[0], "--seq"), "4", "the explicit ack must name the newest displayed sequence");
    assert.equal(readState().acked.conv_hidden, 4, "the explicit ack must clear unread");
  }));

  await check(T.PM4, "PM4 arrival while visible and blocked keeps unread and scroll", () => {
    const blockedConversation = conversation("conv_blocked", PEER, Array.from({ length: 60 }, (_, i) =>
      msg(i + 1, i % 2 ? "peer" : "self", `BLOCKED-${String(i + 1).padStart(3, "0")}`)));
    seed({ conversations: [blockedConversation], acked: { conv_blocked: 60 }, blocked: true });
    return withPage(async (page) => {
    await openDock(page); await messagesTab(page); await openConversation(page, blockedConversation);
    const panel = dock(page);
    await panel.getByText("BLOCKED-060", { exact: false }).first().waitFor({ timeout: 20_000 });
    const before = await historyInfo(panel, "BLOCKED-060");
    assert.ok(before && before.height > before.client + 20, "the blocked conversation needs an overflowing history");

    // A new message arrives while that overflowing conversation is visible and
    // a local job is blocked: no ack and no auto-scroll.
    const state = readState();
    state.conversations[0].messages.push(msg(61, "peer", "BLOCKED-061"));
    state.conversations[0].lastSeq = 61;
    write(state);
    await delay(4200);
    assert.equal(acks().length, 0, "a blocked arrival while visible must not be acknowledged");
    // Seed acked conv_blocked at 60, so the blocked arrival takes unread from
    // 0 to 1: this sub-case must prove the unread growth, not just the no-ack.
    const listed = JSON.parse((await get("/api/polyforge/messages")).text);
    assert.equal(listed.conversations.find((row) => row.id === "conv_blocked")?.unread, 1,
      "the blocked arrival must remain unread (unread count rises from 0 to 1)");
    const after = await historyInfo(panel, "BLOCKED-060");
    assert.ok(after, "the history must stay rendered");
    assert.equal(after.top, before.top, "a blocked job must suppress auto-scroll");
    });
  });

  await check(T.PM5, "PM5 list-view new message starts a conversation", () => withPage(async (page) => {
    const FIRST_PEER = "u_e2e_first_peer";
    seed({ conversations: [], acked: {} });
    await openDock(page); await messagesTab(page);
    const panel = dock(page);
    // The empty list still carries the new-message entry: a user with no
    // conversation can send the first message.
    await panel.getByText(/no conversations/i).first().waitFor({ timeout: 15_000 });
    const to = panel.getByLabel(/recipient|^to\b/i).or(panel.getByPlaceholder(/user|recipient/i)).first();
    const text = panel.getByLabel(/^message|message text/i).or(panel.getByPlaceholder(/message|write/i)).first();
    const anchor = panel.getByLabel(/work item|anchor/i).or(panel.getByPlaceholder(/workitem|work item|anchor/i)).first();
    await to.fill(FIRST_PEER);
    await text.fill("FIRST-MESSAGE");
    if (await anchor.count()) await anchor.fill("task-42");
    await panel.getByRole("button", { name: /^send/i }).first().click();
    for (let i = 0; i < 20 && !sends().length; i++) await delay(500);
    assert.equal(sends().length, 1, `a list-view send must spawn exactly one pf msg send, got ${JSON.stringify(sends())}`);
    assert.equal(argAfter(sends()[0], "--to"), FIRST_PEER);
    assert.equal(argAfter(sends()[0], "--text"), "FIRST-MESSAGE");
    assert.equal(argAfter(sends()[0], "--about-wi"), "task-42");
    assert.equal(readState().sends.length, 1, "the stub ledger must record exactly one send");
    // The code opens the conversation the send created; its history carries
    // the message, and the refreshed list carries the new conversation row.
    await panel.getByText("FIRST-MESSAGE", { exact: false }).first().waitFor({ timeout: 15_000 });
    await panel.getByRole("button", { name: /←/ }).first().click();
    await panel.getByText(FIRST_PEER, { exact: false }).first().waitFor({ timeout: 15_000 });
    const created = readState().conversations.find((conversation) => conversation.peer === FIRST_PEER);
    assert.ok(created, "the stub must have created the direct conversation");
    assert.ok(await panel.getByText(FIRST_PEER, { exact: false }).count() >= 1,
      "the new conversation row must appear in the list");
    // Reopening the row shows the sent message as its history.
    await openConversation(page, created);
    await panel.getByText("FIRST-MESSAGE", { exact: false }).first().waitFor({ timeout: 15_000 });
  }));

  await check(T.PM5, "PM5 one send, reply id, documented refusal", () => withPage(async (page) => {
    seed({ conversations: [conversation("conv_anchor", PEER, ANCHOR.messages)], acked: { conv_anchor: 4 } });
    await openDock(page); await messagesTab(page); await openConversation(page, ANCHOR);
    const panel = dock(page);
    const to = panel.getByLabel(/recipient|^to\b/i).or(panel.getByPlaceholder(/user|recipient/i)).first();
    const text = panel.getByLabel(/^message|message text/i).or(panel.getByPlaceholder(/message|write/i)).first();
    const anchor = panel.getByLabel(/work item|anchor/i).or(panel.getByPlaceholder(/workitem|work item|anchor/i)).first();
    await to.fill(PEER);
    await text.fill("SENT-ONE");
    if (await anchor.count()) await anchor.fill("task-42");
    await panel.getByRole("button", { name: /^send/i }).first().click();
    for (let i = 0; i < 20 && !sends().length; i++) await delay(500);
    assert.equal(sends().length, 1, `a send must spawn exactly one pf msg send, got ${JSON.stringify(sends())}`);
    assert.equal(argAfter(sends()[0], "--to"), PEER);
    assert.equal(argAfter(sends()[0], "--text"), "SENT-ONE");
    assert.equal(argAfter(sends()[0], "--about-wi"), "task-42");
    assert.equal(readState().sends.length, 1, "the stub ledger must record exactly one send");
    // Wait for the send to settle (the composer clears) before starting the
    // reply; the ledger records the spawn, not the route's completion.
    await panel.getByText("SENT-ONE", { exact: false }).first().waitFor({ timeout: 15_000 });
    for (let i = 0; i < 20 && (await text.inputValue()) !== ""; i++) await delay(250);
    assert.equal(await text.inputValue(), "", "the composer must clear after a successful send");

    // Reply to a loaded original: the original is quoted and its id is passed.
    await panel.getByRole("button", { name: /reply/i }).first().click();
    const original = panel.getByText("ANCHOR-ONE", { exact: false });
    assert.ok(await original.count() >= 2, "a loaded original must render as a quote while replying");
    const composer = panel.getByLabel(/^message|message text/i).or(panel.getByPlaceholder(/message|write/i)).last();
    await composer.fill("REPLY-ONE");
    await panel.getByRole("button", { name: /^send/i }).first().click();
    for (let i = 0; i < 20 && sends().length < 2; i++) await delay(500);
    const reply = sends()[1] || [];
    assert.equal(argAfter(reply, "--reply-to"), "msg_1_peer", "a reply must pass --reply-to <original id>");
    await panel.getByText("REPLY-ONE", { exact: false }).last().waitFor({ timeout: 15_000 });
    assert.ok(await panel.getByText("ANCHOR-ONE", { exact: false }).count() >= 2, "the history must render the loaded original as a quote");

    // A refused send: 4xx with pf's documented text, never a 5xx route.
    const state = readState(); state.sendError = "CORE-422"; write(state);
    const refused = await post("/api/polyforge/messages", { to: PEER, text: `refused ${SECRET_SENTINEL}` });
    assert.ok(refused.status >= 400 && refused.status < 500, `a refused send must answer 4xx, got ${refused.status}`);
    assert.match(refused.text, /CORE-422|secret-shaped/i, "the refusal must surface pf's documented text");
  }));

  await check(T.PM6, "PM6 anchor, analyzer, chat discipline", () => withPage(async (page) => {
    seed({ conversations: [conversation("conv_anchor", PEER, ANCHOR.messages)], acked: { conv_anchor: 4 } });
    const beforeSession = readFileSync(sessionFile, "utf8");
    await openDock(page); await messagesTab(page); await openConversation(page, ANCHOR);
    const panel = dock(page);
    // Analyzer: one control per received message, none on the user's own message.
    const analyze = panel.getByRole("button", { name: /analy/i });
    assert.equal(await analyze.count(), 3, "the analyzer control must appear only on the three received messages");
    assert.equal(await panel.getByText("OWN-MESSAGE", { exact: false }).count() > 0, true);
    await analyze.first().click();
    await panel.getByText(ANALYSIS_SENTINEL, { exact: false }).first().waitFor({ timeout: 10_000 });
    for (const store of ["localStorage", "sessionStorage"]) {
      const dump = await page.evaluate((s) => JSON.stringify(globalThis[s]), store);
      assert.ok(!dump.includes(ANALYSIS_SENTINEL), `the transient conclusion must not be written to ${store}`);
    }
    const written = readdirSync(agentDir, { recursive: true }).filter((f) => typeof f === "string")
      .map((f) => join(agentDir, f)).filter((p) => { try { return readFileSync(p, "utf8").includes(ANALYSIS_SENTINEL); } catch { return false; } });
    assert.deepEqual(written, [], "the conclusion must not be written to disk");
    // Transient: closing and reopening the dock drops the conclusion.
    await page.getByRole("button", { name: /close polyforge/i }).first().click();
    await openDock(page); await messagesTab(page); await openConversation(page, ANCHOR);
    assert.equal(await panel.getByText(ANALYSIS_SENTINEL, { exact: false }).count(), 0, "the conclusion must not persist across a reopen");

    // Incoming messages never enter the chat session or the composer.
    assert.equal(readFileSync(sessionFile, "utf8"), beforeSession, "an incoming message must not be written into the chat session");
    const composers = await panel.locator("textarea").evaluateAll((els) => els.map((el) => el.value));
    for (const value of composers) assert.ok(!value.includes(BODY_SENTINEL), "an incoming message must not be written into the composer");

    // A work-item anchor switches to Jobs and runs the existing watch read.
    await panel.getByRole("button", { name: /task-42/ }).or(panel.getByRole("link", { name: /task-42/ })).first().click();
    await panel.getByText("WATCH-DETAIL-39", { exact: false }).first().waitFor({ timeout: 15_000 });
    assert.ok(calls().some((a) => a[0] === "watch" && a[1] === "task-42"), "the anchor must run the existing watch read for task-42");
    // The deep reference exposes only its work-item part.
    await messagesTab(page); await openConversation(page, ANCHOR);
    assert.ok(await panel.getByText("task-42/artifacts/spec.md", { exact: false }).count() > 0, "the deep reference must render");
    assert.equal(await panel.getByRole("link", { name: /artifacts\/spec\.md/ }).count(), 0, "the artifact path must not be clickable");
    assert.equal(await panel.getByRole("button", { name: /artifacts\/spec\.md/ }).count(), 0, "the artifact path must not be clickable");
    // Unanchored messages keep chronological order but are de-emphasized.
    const order = await panel.evaluate((root) => ["ANCHOR-DEEP", "UNANCHORED-ONE", "OWN-MESSAGE"].map((needle) =>
      [...root.querySelectorAll("*")].find((el) => (el.textContent || "").includes(needle) && ![...el.children].some((c) => (c.textContent || "").includes(needle)))?.getBoundingClientRect().top ?? -1));
    assert.ok(order[0] < order[1] && order[1] < order[2], `messages must stay chronological, got tops ${order}`);
    const anchored = await emphasis(panel, "ANCHOR-ONE"); const unanchored = await emphasis(panel, "UNANCHORED-ONE");
    assert.ok(anchored !== null && unanchored !== null && unanchored < anchored, `the unanchored message must be de-emphasized (${unanchored} !< ${anchored})`);
  }));

  await check(T.PM7, "PM7 sentinels", () => withPage(async (page) => {
    seed();
    const listed = await get("/api/polyforge/messages");
    assert.equal(listed.status, 200, `the messages list route answered ${listed.status}: ${listed.text.slice(0, 160)}`);
    for (const sentinel of [KEY_SENTINEL, USER_SENTINEL, SERVER_SENTINEL, ENV_SENTINEL]) {
      assert.ok(!listed.text.includes(sentinel), `the messages route must not carry ${sentinel}`);
    }
    const history = await get("/api/polyforge/messages/conv_anchor?before=999");
    assert.equal(history.status, 200, `the conversation history route answered ${history.status}`);
    // A refused secret-shaped send leaves the sentinel out of the answer.
    const state = readState(); state.sendError = "CORE-422"; write(state);
    const refused = await post("/api/polyforge/messages", { to: PEER, text: `leak ${SECRET_SENTINEL}` });
    assert.ok(refused.status >= 400 && refused.status < 500, `the refusal must answer 4xx, got ${refused.status}`);
    assert.ok(!refused.text.includes(SECRET_SENTINEL), "the refused body sentinel must not appear in the answer");
    // Message bodies and credentials never reach the pi-web server log.
    await openDock(page); await messagesTab(page); await openConversation(page, ANCHOR);
    await dock(page).getByRole("button", { name: /analy/i }).first().click().catch(() => {});
    await delay(500);
    for (const logFile of serverLogs) {
      const log = readFileSync(logFile, "utf8");
      for (const sentinel of [KEY_SENTINEL, USER_SENTINEL, SERVER_SENTINEL, ENV_SENTINEL, BODY_SENTINEL, SECRET_SENTINEL]) {
        assert.ok(!log.includes(sentinel), `the pi-web server log must not carry ${sentinel}`);
      }
    }
    assert.ok(!errors.some((line) => /^5\d\d /.test(line) || /Internal Server Error/.test(line)), `no route may answer 5xx: ${errors.join(" | ")}`);
  }));

  await check(T.PM8, "PM8 below-floor upgrade state", async () => {
    // A fresh server process re-probes pf, so the floor is seen (the probe is
    // cached per process); no message verb may be spawned below it.
    await stop();
    writeFileSync(argvLog, "");
    await startServer("floor", "v2.20.6");
    const floor = await get("/api/polyforge/messages");
    assert.equal(floor.status, 200, `the below-floor messages route answered ${floor.status}`);
    assert.match(floor.text, /"capable"\s*:\s*false/, "below the floor the route must report capable:false");
    assert.match(floor.text, /2\.20\.7|upgrade/i, "below the floor the reason must name the upgrade");
    assert.equal(msgCalls().length, 0, "below the floor no message verb may be spawned");
    const page3 = await openPage();
    try {
      await openDock(page3); await messagesTab(page3);
      assert.ok(await dock(page3).getByText(/upgrade/i).count() > 0, "below the floor the tab must show the upgrade-needed state");
    } finally { await page3.context().close(); }
  });
} catch (error) {
  console.error(error);
  for (const [title, list] of failures) if (!list.length) failures.set(title, [`suite: ${error?.message ?? error}`]);
} finally {
  if (browser) await browser.close().catch(() => {});
  await stop().catch(() => {});
}

let failed = 0;
console.log("\n=== scenarios ===");
for (const [title, list] of failures) {
  if (list.length) { failed++; console.log(`FAIL ${title}`); for (const line of list) console.log(`     ${line}`); }
  else console.log(`PASS ${title}`);
}
rmSync(work, { force: true, recursive: true });
process.exit(failed ? 1 : 0);
