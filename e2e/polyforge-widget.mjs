// pi#111 (wi_1L8cqUGexPVb) — the pf-chat `polyforge` widget never renders in
// the chat pane's bottom extension shelf (the dock panel and topbar badge
// carry that progress; see e2e/polyforge.mjs for those). Standalone, like
// e2e/polyforge.mjs: it starts its own dev server with a stub `pf` first on
// PATH and a stub pi extension in a temporary PI_CODING_AGENT_DIR. The
// extension's `/e2e-widgets` command emits the exact `polyforge` widget the
// real pf-chat writes plus a control widget, so the run asserts through the
// real SSE → useAgentSession → ExtensionStatusBar path. Each scenario logs
// PASS/FAIL and the run exits 1 on any FAIL. No model credentials needed:
// an extension command runs without an LLM call.
//
//   node e2e/polyforge-widget.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(!existsSync(join(root, ".next/dev/lock")), "Run in a checkout without an active dev server");
const work = mkdtempSync(join(tmpdir(), "pi-web-pf-widget-e2e-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project);
const SESSION = "e2e-pf-widget-session";
const ts = "2026-10-18T00:00:00.000Z";
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), [
  { type: "session", version: 3, id: SESSION, timestamp: ts, cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: "E2E pf widget host session" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

// ---- stub extension: the widget set pf-chat writes, plus a control widget ----
// Modes: default/`both` sets both widgets; `pf-only` leaves only `polyforge`
// (the shelf must then not render at all).
writeFileSync(join(agentDir, "extensions", "e2e-widget.js"), `export default function (pi) {
  pi.registerCommand("e2e-widgets", {
    handler: async (args, ctx) => {
      const mode = String(args || "").trim();
      ctx.ui.setWidget("usage", mode === "pf-only" ? undefined : ["E2E control widget line"]);
      ctx.ui.setWidget("polyforge", ["E2E-PF-SENTINEL pi#111 fix running"]);
      ctx.ui.notify("E2E widgets set " + (mode || "both"));
    },
  });
};
`);

// ---- stub pf (ops status only; the badge and panel need nothing else) ----
const JOB = { work_item_id: "wi_E2Epfw001", slug: "pi#111", status: "running", spawn_n: 3,
  session_fingerprint: "fp-e2e", step_age_sec: 61, last_work_ago_sec: 5, candidate: "pi:glm-e2e",
  origin: { kind: "chat", owner: "u_e2e" } };
const ops = { machine_id: "m-e2e", workspaces: [work], workflows_dir: join(work, "wf"), env_names: [],
  jobs: [JOB], queue: { pending: 0, running: 1, max_concurrent: 4 } };
const stubDir = join(work, "stub-bin");
mkdirSync(stubDir);
writeFileSync(join(stubDir, "pf"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("pf 0.0.0-e2e"); process.exit(0); }
const rest = args.filter((a) => a !== "--json");
if (rest[0] === "ops" && rest[1] === "status") {
  process.stdout.write(${JSON.stringify(JSON.stringify(ops))} + "\\n");
  process.exit(0);
}
process.stderr.write("pf: unknown command\\n"); process.exit(2);
`);
chmodSync(join(stubDir, "pf"), 0o755);

// ---- scenario bookkeeping ----
const T = {
  S1: "S1: pf-chat polyforge widget never renders in the shelf; other widgets do",
  S2: "S2: the shelf is not rendered when the polyforge widget is its only content",
  S3: "S3: Polyforge topbar badge and dock panel still work",
  S4: "S4: mobile viewport hides the polyforge widget too",
  S5: "S5: no 5xx responses or browser console errors",
};
const failures = new Map(Object.values(T).map((title) => [title, []]));
const ran = new Set();
async function check(title, label, fn) {
  ran.add(title);
  try { await fn(); } catch (error) { failures.get(title).push(`${label}: ${String(error?.message ?? error).split("\n")[0]}`); }
}

let server; let browser; let base;
const errors = [];
async function startServer() {
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  base = `http://127.0.0.1:${port}`;
  const log = createWriteStream(join(work, "server.log"));
  server = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PATH: `${stubDir}${delimiter}${process.env.PATH}`, PI_CODING_AGENT_DIR: agentDir,
      PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1", PI_WEB_ALLOWED_ROOT_PREFIXES: work },
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
  try { if (JSON.parse((await import("node:fs")).readFileSync(lock, "utf8")).pid === server.pid) rmSync(lock); } catch {}
}
async function openPage({ viewport = { width: 1280, height: 800 } } = {}) {
  const context = await browser.newContext({ viewport, locale: "en-US" });
  await context.addInitScript(() => {
    try { localStorage.setItem("pi-web:split-view-enabled", "false"); } catch {}
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (event) => { if (event.type() === "error") errors.push(event.text()); });
  page.on("response", (r) => { if (r.url().startsWith(base) && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded" });
  // Locale- and viewport-independent readiness: the host session's first
  // message is mounted (the sidebar row is hidden behind the drawer on mobile).
  await page.getByText("E2E pf widget host session").first().waitFor({ state: "attached", timeout: 60_000 });
  return page;
}
const shelf = (page) => page.locator(".extension-status-shelf");
const pfButton = (page) => page.getByRole("button", { name: /^(?!.*close).*polyforge/i }).first();
const pfPanel = (page) => page.getByRole("complementary", { name: /polyforge/i }).or(page.getByRole("dialog", { name: /polyforge/i }));

// Sends the stub extension's command and waits for its completion notice.
async function sendWidgetsCommand(page, mode = "") {
  await page.mouse.move(0, 0);
  await page.locator("[data-minimap-preview-box]").waitFor({ state: "hidden" });
  const input = page.locator("textarea").last();
  await input.fill(`/e2e-widgets${mode ? ` ${mode}` : ""}`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(`E2E widgets set ${mode || "both"}`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Stop agent", exact: true }).waitFor({ state: "hidden" });
  // The widget events ride the same SSE stream as the notice; let them land.
  await delay(500);
}

async function assertShelfHidesPolyforge(page, title) {
  await shelf(page).waitFor();
  await check(title, "shelf shows control only", async () => {
    const text = await shelf(page).innerText();
    assert.match(text, /usage/, "control widget trigger missing from the shelf");
    assert.doesNotMatch(text, /polyforge/i, "shelf shows a polyforge line");
    assert.equal(await shelf(page).locator(".extension-widget-key").filter({ hasText: /polyforge/i }).count(), 0);
  });
  await check(title, "polyforge content never reaches the DOM", async () => {
    assert.equal(await page.getByText("E2E-PF-SENTINEL").count(), 0);
  });
  await check(title, "remaining widget still expands", async () => {
    await shelf(page).getByText("usage", { exact: true }).click();
    const panel = page.locator(".extension-widget-panel");
    await panel.waitFor();
    assert.match(await panel.innerText(), /E2E control widget line/);
    assert.doesNotMatch(await panel.innerText(), /polyforge/i);
  });
}

try {
  browser = await chromium.launch();
  await startServer();
  const page = await openPage();
  try {
    await check(T.S3, "badge", async () => {
      await pfButton(page).waitFor();
      assert.match(await pfButton(page).innerText(), /1/, "badge must show queue running 1");
    });

    await sendWidgetsCommand(page);
    await assertShelfHidesPolyforge(page, T.S1);

    await sendWidgetsCommand(page, "pf-only");
    await check(T.S2, "shelf not rendered", async () => {
      await shelf(page).waitFor({ state: "detached" });
      assert.equal(await shelf(page).count(), 0);
    });

    await check(T.S3, "panel", async () => {
      await pfButton(page).click();
      await pfPanel(page).first().waitFor();
      const text = await pfPanel(page).first().innerText();
      assert.ok(text.includes("pi#111"), `panel does not show the running job: ${text.slice(0, 120)}`);
    });
  } finally {
    await page.context().close();
  }

  // 600px: inside the app's mobile breakpoint (<= 640px) but above the narrow
  // (<= 480px) layout that tucks toolbar actions behind a "more" menu.
  const mobile = await openPage({ viewport: { width: 600, height: 900 } });
  try {
    await sendWidgetsCommand(mobile);
    await assertShelfHidesPolyforge(mobile, T.S4);
  } finally {
    await mobile.context().close();
  }

  await check(T.S5, "error signals", async () => assert.deepEqual(errors.splice(0), []));
  await stopServer();
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
