// — Settings › Polyforge configuration page LAYOUT acceptance.
//
// Authored as the reproduction for the owner's second photo review: #88 made the
// rows a five-column subgrid inside each card, which leaves every card with its
// own column template (so value columns do not line up), keeps an always-empty
// daemon column in cli.toml, parks each Save button at the row's far right and
// renders pf's reload classes as bare English. This suite measures the rendered
// page at the owner's desktop width (1100px) and at the phone breakpoint, with
// the config read mocked so the fixture is the page's data, not pf's.
//
//   node e2e/polyforge-config-layout.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startNextServer } from "./next-server.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(!existsSync(join(root, process.env.PI_WEB_DIST_DIR || ".next", "dev/lock")), "Run in a checkout without an active dev server");
const work = mkdtempSync(join(tmpdir(), "pi-web-pf-layout-e2e-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
const SESSION = "e2e-pf-layout-session";
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project, { recursive: true });
const ts = "2026-10-29T00:00:00.000Z";
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), [
  { type: "session", version: 3, id: SESSION, timestamp: ts, cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: "E2E polyforge layout host session" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

const WS = `[workspace."${project}"]`;
const MODELS = ["pi:zeta", "pi:alpha", "pi:beta"];
const CONFIG = {
  pfPresent: true,
  pfVersion: "v2.20.11",
  capable: true,
  file: { sha256: "e2e-cli", exists: true },
  mapped: true,
  daemonReachable: true,
  reload: { pending: [], overridden: [] },
  workspaceFile: { sha256: "e2e-yaml", exists: true },
  items: [
    { key: "server", value: "http://127.0.0.1:1", source: "file", class: "restart-only" },
    { key: "api_key", set: true, source: "file", class: "restart-only" },
    { key: "daemon_socket", value: "/run/pf.sock", source: "file", class: "restart-only" },
    { key: "user_id", value: "usr_root", source: "file", class: "cli-only" },
    { key: "claude_bin", value: "/usr/local/bin/claude", source: "file", class: "live" },
    { key: "future_knob", value: "x", source: "file", class: "brand-new-class" },
    { key: "harness_root", value: "/opt/pf", source: "file", class: "restart-only" },
    { key: "operator_agent_dir", value: "/home/op/.pi", source: "file", class: "restart-only" },
    { key: "step_timeout", value: "30m0s", source: "file", class: "live", schema: { kind: "duration" }, daemon: { value: "30m0s" } },
    { key: "stall_window", value: "10m0s", source: "file", class: "live", schema: { kind: "duration" }, daemon: { value: "10m0s" } },
    { key: "max_concurrent_jobs", value: 6, source: "file", class: "live", schema: { kind: "int", min: 1 }, daemon: { value: 6 } },
    { key: WS, value: "e2e-project", source: "file", class: "restart-only", section: true },
    { key: "summarize.models", value: MODELS, source: "file", class: "live", schema: { kind: "model-list" } },
    { key: "summarize.language", value: "English", source: "file", class: "live", schema: { kind: "string" } },
    { key: "summarize.interval_sec", value: 30, source: "file", class: "live", schema: { kind: "int", min: 10, max: 3600 } },
  ],
  steps: [{ project: "e2e", step: "fix", declared: true, models: MODELS }, { project: "e2e", step: "code", declared: false, models: null }],
  steps_complete: true,
};

const failures = [];
let checks = 0;
async function check(label, fn) {
  checks += 1;
  try { await fn(); console.log(`PASS ${label}`); }
  catch (error) {
    const message = String(error?.message ?? error).split("\n").slice(0, 8).join(" | ");
    failures.push(`${label}: ${message}`);
    console.log(`FAIL ${label}: ${message}`);
  }
}

let browser;
let stop = async () => {};
let base;
try {
  const started = await startNextServer({
    name: "polyforge-config-layout",
    logFile: join(work, "server.log"),
    env: { ...process.env, HOME: work, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
  });
  base = started.base;
  stop = started.stop;
  browser = await chromium.launch();

  const open = async ({ width = 1100, height = 980, locale = "en" } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "en-US" });
    await context.addInitScript((selected) => {
      try {
        window.localStorage.setItem("pi-locale", selected);
        window.localStorage.setItem("pi-web:session-age-filter-days", "0");
      } catch { /* storage unavailable */ }
    }, locale);
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.route("**/api/polyforge/config/history", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) }));
    await page.route("**/api/polyforge/config?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CONFIG) }));
    await page.route("**/api/polyforge/detect*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      pfPresent: true, pfVersion: "v2.20.11", pfVersionBelowMinimum: false, line: "internal",
      piSkillInstalled: true, piSkillEnabled: true, claudeSkillsSymlink: true, claudeSessionStartHook: true,
      daemon: { reachable: true },
    }) }));
    await page.route("**/api/plugins?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      packages: [{ scope: "global", packageName: "polyforge", source: "/opt/polyforge" }],
    }) }));
    await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.getByText("E2E polyforge layout host session").first().waitFor({ state: "attached", timeout: 60_000 });
    const show = page.locator('button[aria-label="Show sidebar"], button[aria-label="显示侧边栏"]').first();
    if (await show.isVisible().catch(() => false)) await show.click();
    await page.locator('button[aria-label="Settings"], button[aria-label="设置"]').first().click();
    const dialog = page.locator('[role="dialog"][aria-label="Settings"], [role="dialog"][aria-label="设置"]').first();
    await dialog.getByRole("button", { name: "Polyforge", exact: true }).click();
    const flatLabel = locale === "zh-CN" ? "cli.toml" : "cli.toml";
    await dialog.locator(`[aria-label="${flatLabel}"]`).first().waitFor({ state: "attached", timeout: 30_000 });
    return { context, page, dialog };
  };

  const cards = (dialog) => ({
    flat: dialog.locator('[aria-label="cli.toml"]').first(),
    daemon: dialog.locator('[aria-label="cli.toml · [daemon]"]').first(),
    workspace: dialog.locator('[aria-label="Workspace mapping"]').first(),
    summarize: dialog.locator('[aria-label="Summarize (.polyforge.yaml)"]').first(),
  });
  const centerY = (box) => box.y + box.height / 2;
  const saveGap = async (card, label) => {
    const input = card.locator(`input[aria-label="${label}"]`).first();
    const box = await input.boundingBox();
    assert.ok(box, `no input for ${label}`);
    const saves = card.getByRole("button", { name: "Save", exact: true });
    const count = await saves.count();
    assert.ok(count > 0, `no Save button in the ${label} row's card`);
    let nearest = null;
    for (let i = 0; i < count; i++) {
      const button = saves.nth(i);
      const b = await button.boundingBox();
      if (!b) continue;
      const distance = Math.abs(centerY(b) - centerY(box));
      if (!nearest || distance < nearest.distance) nearest = { distance, box: b };
    }
    assert.ok(nearest && nearest.distance <= 24, `${label}'s Save button is not on the input's row (nearest row distance ${nearest?.distance?.toFixed?.(1) ?? "?"}px)`);
    return { input: box, button: nearest.box, gap: nearest.box.x - (box.x + box.width) };
  };

  const desktop = await open();

  await check("the value column starts at the same x in every configuration card", async () => {
    const { dialog } = desktop;
    const all = cards(dialog);
    for (const [name, card] of Object.entries(all)) assert.equal(await card.count(), 1, `${name} card is missing`);
    const xs = [];
    for (const [name, card] of [["cli.toml", all.flat], ["[daemon]", all.daemon], ["summarize", all.summarize]]) {
      const input = card.locator("input").first();
      const box = await input.boundingBox();
      assert.ok(box, `${name} has no editable value in its value column`);
      xs.push({ name, x: box.x });
    }
    const min = Math.min(...xs.map((entry) => entry.x));
    const max = Math.max(...xs.map((entry) => entry.x));
    assert.ok(max - min <= 2, `value columns are not aligned: ${xs.map((entry) => `${entry.name} x=${entry.x.toFixed(1)}`).join(", ")}`);
  });

  await check("cli.toml renders no daemon column, while [daemon] keeps it", async () => {
    const { dialog } = desktop;
    const all = cards(dialog);
    assert.equal(await all.flat.getByText("Daemon value", { exact: true }).count(), 0, "cli.toml still shows a Daemon value column");
    assert.equal(await all.flat.getByText("— (not set)", { exact: true }).count(), 0, "cli.toml still renders daemon-column placeholders");
    assert.ok(await all.daemon.getByText("Daemon value", { exact: true }).count() >= 1, "[daemon] lost its daemon column");
  });

  await check("every writable row's Save button sits in or beside its input cell", async () => {
    const { dialog } = desktop;
    const all = cards(dialog);
    const probes = [
      [all.flat, "api_key"],
      [all.daemon, "max_concurrent_jobs"],
      [all.summarize, "summarize.models"],
      [all.summarize, "summarize.interval_sec"],
    ];
    const gaps = [];
    for (const [card, label] of probes) {
      const measured = await saveGap(card, label);
      gaps.push(`${label} gap=${measured.gap.toFixed(1)}px`);
      assert.ok(measured.gap <= 24, `${label}'s Save button is ${measured.gap.toFixed(1)}px past its input (limit 24px)`);
    }
    console.log(`  save gaps: ${gaps.join(", ")}`);
  });

  await check("pf's reload classes never render as bare English text (en)", async () => {
    const { dialog } = desktop;
    assert.equal(await dialog.getByText(/^(restart-only|cli-only|live|next-claim)$/).count(), 0,
      "a bare reload class is still a text node");
  });

  await check("summarize.models renders as individual chips, not one comma string", async () => {
    const card = cards(desktop.dialog).summarize;
    for (const model of MODELS) {
      assert.ok(await card.getByText(model, { exact: true }).count() >= 1, `${model} is not its own chip`);
    }
    const rows = await card.locator("body *").evaluateAll((nodes) => nodes
      .filter((node) => node.children.length === 0)
      .map((node) => (node.textContent ?? "").trim())
      .filter((text) => (text.match(/,/g) ?? []).length >= 2));
    assert.deepEqual(rows, [], `summarize still has a comma-joined long value: ${rows.join(" / ")}`);
  });

  const zh = await open({ locale: "zh-CN" });
  await check("pf's reload classes never render as bare English text (zh-CN)", async () => {
    assert.equal(await zh.dialog.getByText(/^(restart-only|cli-only|live|next-claim)$/).count(), 0,
      "a bare reload class is still a text node under zh-CN");
  });
  await zh.context.close();

  await check("phones stack the cards with no horizontal overflow and no column headers", async () => {
    const { page, dialog } = desktop;
    await page.setViewportSize({ width: 390, height: 844 });
    const all = cards(dialog);
    const card = all.summarize;
    const overflow = await card.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, `summarize card overflows horizontally: ${overflow.scrollWidth} > ${overflow.clientWidth}`);
    const body = await dialog.evaluate((node) => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
    assert.ok(body.scrollWidth <= body.clientWidth + 1, `settings dialog overflows horizontally: ${body.scrollWidth} > ${body.clientWidth}`);
    const header = all.daemon.getByText("Daemon value", { exact: true }).first();
    assert.equal(await header.isVisible().catch(() => false), false, "column header is still visible on a phone");
  });

  await desktop.context.close();
} catch (error) {
  console.error(`ABORT ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stop();
}

console.log(`\n${checks - failures.length}/${checks} layout checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} layout check(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
