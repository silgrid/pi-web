// carries: components/Polyforge*, components/polyforge-*, hooks/usePolyforge*, lib/polyforge*, app/api/polyforge/*
// carries: components/SettingsPanel*, components/SettingsUi*, components/settings-ui-helpers*, lib/settings-navigation*, lib/package-settings*, app/api/plugins/*
// — Settings › Polyforge configuration page VIEWPORT acceptance.
//
// The owner's third photo review after #88 and #126 reports that the page still
// has no content padding, no visual grouping, and (the concrete one) cannot be
// scrolled to its bottom when the configuration is taller than the dialog. This
// suite pins the page's measured geometry: the content stays inset from the
// panel on all four edges, the grouped cards keep their titles, and the page
// offers one vertical scroll region that reaches scrollHeight - clientHeight so
// the last configured key is on screen.
// the card titles follow the merged 工作区 / Workspace card and
// the workflow card, and the bottom check targets the page's real last block
// (the footer) instead of a configured key, which no longer ends the page.
//
//   node e2e/polyforge-config-viewport.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startNextServer } from "./next-server.mjs";
import { NAV_MS } from "./timeouts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.ok(!existsSync(join(root, process.env.PI_WEB_DIST_DIR || ".next", "dev/lock")), "Run in a checkout without an active dev server");
const work = mkdtempSync(join(tmpdir(), "pi-web-pf-viewport-e2e-"));
const agentDir = join(work, "agent");
const project = join(work, "project");
const SESSION = "e2e-pf-viewport-session";
const PROBE = "summarize.zz_bottom_probe";
const PROBE_VALUE = "e2e-bottom-probe";
const CONTENT_ROOT = ".settings-polyforge";
// The shared detail pane keeps 20px of padding on every edge (.config-detail)
// and the page adds none of its own (a 24px page bottom padding
// made a 44px bottom gap), so every edge measures the token itself, ±1px.
const PANEL_PADDING = 20;
mkdirSync(join(agentDir, "sessions", "e2e"), { recursive: true });
mkdirSync(project, { recursive: true });
const ts = "2026-10-30T00:00:00.000Z";
writeFileSync(join(agentDir, "sessions", "e2e", `${SESSION}.jsonl`), [
  { type: "session", version: 3, id: SESSION, timestamp: ts, cwd: project },
  { type: "message", id: "m1", parentId: null, timestamp: ts, message: { role: "user", content: "E2E polyforge viewport host session" } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

const WS = `[workspace."${project}"]`;
const MODELS = ["pi:zeta", "pi:alpha"];
// Enough keys to exceed the dialog at 700px even before the cards' own padding.
const flat = Array.from({ length: 18 }, (_, index) => ({
  key: `e2e_key_${String(index + 1).padStart(2, "0")}`,
  value: `e2e-value-${index + 1}`,
  source: "file",
  class: index % 2 === 0 ? "restart-only" : "live",
}));
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
    ...flat,
    { key: "harness_root", value: "/opt/pf", source: "file", class: "restart-only" },
    { key: "operator_agent_dir", value: "/home/op/.pi", source: "file", class: "restart-only" },
    { key: "step_timeout", value: "30m0s", source: "file", class: "live", schema: { kind: "duration" }, daemon: { value: "30m0s" } },
    { key: "stall_window", value: "10m0s", source: "file", class: "live", schema: { kind: "duration" }, daemon: { value: "10m0s" } },
    { key: "max_concurrent_jobs", value: 6, source: "file", class: "live", schema: { kind: "int", min: 1 }, daemon: { value: 6 } },
    { key: WS, value: "e2e-project", source: "file", class: "restart-only", section: true },
    { key: "summarize.models", value: MODELS, source: "file", class: "live", schema: { kind: "model-list" } },
    { key: "summarize.language", value: "English", source: "file", class: "live", schema: { kind: "string" } },
    { key: "summarize.interval_sec", value: 30, source: "file", class: "live", schema: { kind: "int", min: 10, max: 3600 } },
    { key: PROBE, value: PROBE_VALUE, source: "file", class: "live", schema: { kind: "string" } },
  ],
  steps: [],
  steps_complete: true,
};

// the workflow card's read, fixed so the page is the fixture's
// (the card renders after the configuration cards whatever pf is installed).
const workflowsFixture = (project) => {
  const chain = (models, from) => ({ "e2e-project": { models, from } });
  return {
    pfPresent: true,
    pfVersion: "v2.20.16",
    capable: true,
    workflows: {
      workflows_dir: "/e2e/workflows", daemon_reachable: true, reason: "", workspace: project, projects: ["e2e-project"],
      write_capable: true, write_reason: "",
      bundles: [{
        name: "feature-full",
        defaults: { model_candidates: ["pi:ff-default"], effective: chain(["pi:ff-default"], "bundle feature-full defaults.model_candidates") },
        steps: [
          { id: "grill", model_candidates: ["pi:ff-grill"], attrs: [{ name: "question_batch_size", type: "int", default: 0 }],
            effective: chain(["pi:ff-grill"], "bundle feature-full step grill model_candidates") },
          { id: "code", model_candidates: ["pi:ff-code"], effective: chain(["pi:ff-code"], "bundle feature-full step code model_candidates") },
        ],
      }],
      bundle_errors: [],
    },
    workspace: { workspace: project, yaml: { sha256: "e2e-yaml", exists: true }, steps: { "e2e-project": {} } },
  };
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
    name: "polyforge-config-viewport",
    logFile: join(work, "server.log"),
    env: { ...process.env, HOME: work, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
  });
  base = started.base;
  stop = started.stop;
  browser = await chromium.launch();

  const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, locale: "en-US" });
  // The one browser-side finder for "the largest vertical scroll region inside
  // the section host that contains the configuration" (it was
  // copied into five call sites). Null when there is none.
  await context.addInitScript(() => {
    window.__pfLargestScrollRegion = (hostEl, rootSelector) => {
      const contentEl = hostEl.querySelector(rootSelector);
      if (!contentEl) return null;
      const candidates = [hostEl, ...hostEl.querySelectorAll("*")].filter((el) => {
        const style = getComputedStyle(el);
        return (style.overflowY === "auto" || style.overflowY === "scroll")
          && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1
          && el.contains(contentEl);
      });
      candidates.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      return candidates[0] ?? null;
    };
  });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem("pi-locale", "en");
      window.localStorage.setItem("pi-web:session-age-filter-days", "0");
    } catch { /* storage unavailable */ }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.route("**/api/polyforge/config/history", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ entries: [] }) }));
  await page.route("**/api/polyforge/config?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(CONFIG) }));
  await page.route("**/api/polyforge/workflows?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workflowsFixture(project)) }));
  await page.route("**/api/polyforge/detect*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    pfPresent: true, pfVersion: "v2.20.11", pfVersionBelowMinimum: false, line: "internal",
    piSkillInstalled: true, piSkillEnabled: true, claudeSkillsSymlink: true, claudeSessionStartHook: true,
    daemon: { reachable: true },
  }) }));
  await page.route("**/api/plugins?*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    packages: [{ scope: "global", packageName: "polyforge", source: "/opt/polyforge" }],
  }) }));
  await page.goto(`${base}/?session=${SESSION}`, { waitUntil: "domcontentloaded", timeout: NAV_MS });
  await page.getByText("E2E polyforge viewport host session").first().waitFor({ state: "attached", timeout: NAV_MS });
  const show = page.locator('button[aria-label="Show sidebar"], button[aria-label="显示侧边栏"]').first();
  if (await show.isVisible().catch(() => false)) await show.click();
  await page.locator('button[aria-label="Settings"], button[aria-label="设置"]').first().click();
  const dialog = page.locator('[role="dialog"][aria-label="Settings"], [role="dialog"][aria-label="设置"]').first();
  await dialog.getByRole("button", { name: "Polyforge", exact: true }).click();
  await dialog.locator(CONTENT_ROOT).first().waitFor({ state: "attached", timeout: 30_000 });
  const content = dialog.locator(CONTENT_ROOT).first();
  const hostLocator = dialog.locator(".settings-section-host:visible").first();
  // the page opens collapsed (detection details, the read-only
  // folds, the workspace card, the read-outs). Expand every region above the
  // probe first so the geometry below is measured on the configuration's full
  // height, the probe included. The install block (below the probe, collapsed
  // while pf is healthy) keeps its default state: the page tail after the
  // last configured key stays what the owner-confirmed order puts there.
  await content.locator(".polyforge-config-row:visible").first().waitFor({ state: "visible", timeout: NAV_MS });
  await content.locator(".polyforge-config-status [aria-expanded]").first().waitFor({ state: "visible", timeout: NAV_MS });
  const collapsed = content.locator('section:not(.polyforge-config-install) [aria-expanded="false"]:visible');
  for (let round = 0; round < 12 && await collapsed.count() > 0; round += 1) {
    await collapsed.first().click({ timeout: 20_000 });
  }
  assert.equal(await collapsed.count(), 0, "a disclosure region is still collapsed after expanding");
  const probe = content.getByText(PROBE, { exact: true }).first();
  await probe.waitFor({ state: "visible", timeout: 30_000 });

  const region = async () => hostLocator.evaluate((hostEl, rootSelector) => {
    const contentEl = hostEl.querySelector(rootSelector);
    if (!contentEl) return { error: `missing ${rootSelector}` };
    const el = window.__pfLargestScrollRegion(hostEl, rootSelector);
    return el ? {
      found: true,
      tag: el.tagName,
      className: typeof el.className === "string" ? el.className : "",
      overflowY: getComputedStyle(el).overflowY,
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    } : {
      found: false,
      contentScrollHeight: contentEl.scrollHeight,
      hostHeight: hostEl.clientHeight,
    };
  }, CONTENT_ROOT);

  // Padding is measured on the edge the user can reach: the top, left and right
  // at the region's top, the bottom at its maximum scroll.
  const scrollRegion = async (edge) => {
    await hostLocator.evaluate((hostEl, { rootSelector, edge }) => {
      const el = window.__pfLargestScrollRegion(hostEl, rootSelector);
      if (el) el.scrollTop = edge === "top" ? 0 : el.scrollHeight;
    }, { rootSelector: CONTENT_ROOT, edge });
  };

  await check("grouped configuration cards keep their titles", async () => {
    for (const title of ["cli.toml", "cli.toml · [daemon]", "Workspace", "Workflow"]) {
      assert.equal(await content.locator(`section[aria-label="${title}"] .polyforge-config-card-title`).first().innerText(), title, `missing group card title: ${title}`);
    }
    for (const gone of ["Workspace mapping", "Summarize (.polyforge.yaml)", "Declared step candidates"]) {
      assert.equal(await content.locator(`section[aria-label="${gone}"]`).count(), 0, `the retired card ${gone} still renders`);
    }
  });

  await check("the configuration page scrolls to its bottom (scrollTop = scrollHeight - clientHeight)", async () => {
    const before = await region();
    assert.ok(before.found, `${CONTENT_ROOT} has no vertical scroll region containing the configuration (content ${before.contentScrollHeight}px, host ${before.hostHeight}px)`);
    await hostLocator.evaluate((hostEl, rootSelector) => {
      const el = window.__pfLargestScrollRegion(hostEl, rootSelector);
      if (el) el.scrollTop = el.scrollHeight;
    }, CONTENT_ROOT);
    await page.waitForFunction((rootSelector) => {
      const hostEl = document.querySelector(rootSelector)?.closest(".settings-section-host");
      if (!hostEl) return false;
      const el = window.__pfLargestScrollRegion(hostEl, rootSelector);
      return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    }, CONTENT_ROOT, { timeout: 5_000 });
    const after = await region();
    assert.ok(after.found, "the scroll region disappeared after scrolling");
    assert.ok(after.scrollTop + after.clientHeight >= after.scrollHeight - 1,
      `scrollTop ${after.scrollTop} + clientHeight ${after.clientHeight} < scrollHeight ${after.scrollHeight}`);
    const host = await hostLocator.boundingBox();
    const last = content.locator(":scope > *").last();
    assert.equal(await last.evaluate((node) => node.className), "config-footer", "the page's last block is not its footer");
    const box = await last.boundingBox();
    assert.ok(host && box, "the page's last block or the section host has no box");
    assert.ok(box.y >= host.y - 1 && box.y + box.height <= host.y + host.height + 1,
      `the page's last block is outside the visible panel after scrolling to the bottom (block y=${box.y.toFixed(1)}..${(box.y + box.height).toFixed(1)}, panel y=${host.y.toFixed(1)}..${(host.y + host.height).toFixed(1)})`);
  });

  await check("the content keeps exactly the panel-standard padding on all four edges", async () => {
    const host = await hostLocator.boundingBox();
    assert.ok(host, "the Polyforge section host has no box");
    await scrollRegion("top");
    const first = await content.locator(":scope > *").first().boundingBox();
    assert.ok(first, "the configuration content has no first block");
    const left = first.x - host.x;
    const top = first.y - host.y;
    const right = (host.x + host.width) - (first.x + first.width);
    if ((await region()).found) {
      await scrollRegion("bottom");
      await page.waitForFunction((rootSelector) => {
        const hostEl = document.querySelector(rootSelector)?.closest(".settings-section-host");
        if (!hostEl) return false;
        const el = window.__pfLargestScrollRegion(hostEl, rootSelector);
        return !el || el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      }, CONTENT_ROOT, { timeout: 5_000 });
    }
    const last = await content.locator(":scope > *").last().boundingBox();
    assert.ok(last, "the configuration content has no last block");
    const bottom = (host.y + host.height) - (last.y + last.height);
    const gaps = { top, right, bottom, left };
    assert.ok(
      [top, right, bottom, left].every((gap) => gap >= PANEL_PADDING - 1 && gap <= PANEL_PADDING + 1),
      `content padding is not the ${PANEL_PADDING}px panel token (±1px) on every edge: ${Object.entries(gaps).map(([edge, gap]) => `${edge}=${gap.toFixed(1)}px`).join(", ")}`,
    );
  });

  await context.close();
} catch (error) {
  console.error(`ABORT ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stop();
}

console.log(`\n${checks - failures.length}/${checks} viewport checks passed`);
if (failures.length) {
  console.error(`\n${failures.length} viewport check(s) failed:`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
