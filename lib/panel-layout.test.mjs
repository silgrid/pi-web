import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clampPanelWidth,
  getDefaultRightPanelWidth,
  getPolyforgeDockMaxWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  POLYFORGE_DOCK_DEFAULT_WIDTH,
  POLYFORGE_DOCK_MAX_WIDTH,
  POLYFORGE_DOCK_MIN_WIDTH,
} = await jiti.import("./panel-layout.ts");

test("clamps panel widths to finite bounds", () => {
  assert.equal(clampPanelWidth(420.4, 180, 480), 420);
  assert.equal(clampPanelWidth(120, 180, 480), 180);
  assert.equal(clampPanelWidth(600, 180, 480), 480);
  assert.equal(clampPanelWidth(Number.NaN, 180, 480), 180);
  assert.equal(clampPanelWidth(200, 300, 250), 300);
});

test("keeps the responsive right panel default within useful limits", () => {
  assert.equal(getDefaultRightPanelWidth(700), 360);
  assert.equal(getDefaultRightPanelWidth(1366), 574);
  assert.equal(getDefaultRightPanelWidth(1920), 640);
});

test("polyforge dock (pi#117): 460 default, 340 min, 90vw live max", () => {
  assert.equal(POLYFORGE_DOCK_DEFAULT_WIDTH, 460, "the dock opens at 460 by default");
  assert.equal(POLYFORGE_DOCK_MIN_WIDTH, 340, "the drag clamp never narrows below 340");
  assert.equal(getPolyforgeDockMaxWidth(1280), 1152, "90vw at 1280");
  assert.equal(getPolyforgeDockMaxWidth(1920), 1728, "90vw at 1920");
  // The static cap only bounds aria-valuemax before mount; it must never
  // bind tighter than the live 90vw max on any real viewport.
  assert.ok(POLYFORGE_DOCK_MAX_WIDTH >= getPolyforgeDockMaxWidth(7680), "the cap stays at or above 90vw at 8K");
  assert.equal(clampPanelWidth(700, POLYFORGE_DOCK_MIN_WIDTH, getPolyforgeDockMaxWidth(1280)), 700);
  assert.equal(clampPanelWidth(2000, POLYFORGE_DOCK_MIN_WIDTH, getPolyforgeDockMaxWidth(1280)), 1152, "an oversized drag clamps to 90vw");
  assert.equal(clampPanelWidth(100, POLYFORGE_DOCK_MIN_WIDTH, getPolyforgeDockMaxWidth(1280)), 340, "an undersized drag clamps to 340");
});

test("reserves chat space while split panels are visible", () => {
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 700,
    rightPanelOpen: true,
    rightPanelWidth: 560,
  }), 380);
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 1366,
    rightPanelOpen: true,
    rightPanelWidth: 686,
  }), 260);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1024,
    sidebarOpen: true,
    sidebarWidth: 260,
  }), 344);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1366,
    sidebarOpen: true,
    sidebarWidth: 260,
  }), 686);
});

test("does not rewrite desktop widths while the file panel is in overlay mode", () => {
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 900,
    sidebarOpen: true,
    sidebarWidth: 480,
  }), 1200);
});
