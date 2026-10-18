import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./PolyforgePanel.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/usePolyforge.ts", import.meta.url), "utf8");

test("the Polyforge button is gated on pf presence alone, independent of chat visibility", () => {
  assert.match(source, /const showChatActions = mobile \|\| showChat;/);
  assert.match(source, /if \(!showChatActions && !pfPresent\) return null;/);
  assert.match(source, /\{pfPresent && \(/, "the button renders iff pf is found");
  assert.match(source, /aria-label=\{translate\("polyforge\.open"\)\}/);
  // The chat actions (bg-tasks, history, …) keep their original gate.
  assert.match(source, /\{showChatActions && \(<>/);
});

test("the badge shows the queue running count and nothing while the daemon is down", () => {
  assert.match(source, /pfRunningCount !== null && pfRunningCount > 0/);
  assert.match(source, /\{pfRunningCount > 9 \? "9\+" : pfRunningCount\}/);
  assert.match(hookSource, /const runningCount = opsStatus \? opsStatus\.queue\.running : null;/);
});

test("the dock slot is mutually exclusive in both directions", () => {
  // Opening Polyforge closes bg-tasks…
  assert.match(source, /setPfPanelOpen\(\(open\) => \{\s*const next = !open;\s*if \(next\) setBgPanelOpen\(false\);\s*return next;\s*\}\);/);
  // …and opening bg-tasks closes Polyforge.
  assert.match(source, /setBgPanelOpen\(\(open\) => \{\s*const next = !open;\s*if \(next\) setPfPanelOpen\(false\);\s*return next;\s*\}\);/);
  // The bg-tasks toggle keeps its toggle semantics (open/close, nothing else).
  assert.doesNotMatch(source, /setBgPanelOpen\(\(open\) => !open\)/);
});

test("every path that opens bg-tasks closes the Polyforge panel (notification jump, B-2)", () => {
  // The bg-task terminal notification's onClick is the only bg-tasks-opening
  // path besides the toolbar toggle; it must not leave the pf dock covering
  // the panel the jump was meant to show (AC9 / AC12).
  const jumps = [];
  let index = source.indexOf("setBgPanelOpen(true)");
  while (index !== -1) {
    jumps.push(index);
    index = source.indexOf("setBgPanelOpen(true)", index + 1);
  }
  assert.ok(jumps.length > 0, "expected at least one direct setBgPanelOpen(true) (the notification jump)");
  for (const jump of jumps) {
    const context = source.slice(jump, jump + 90);
    assert.match(
      context,
      /setBgPanelOpen\(true\);\s*setPfPanelOpen\(false\);/,
      "a setBgPanelOpen(true) path does not close the Polyforge panel",
    );
  }
});

test("the panel mounts in the shared dock slot: 340px desktop right dock, 62% mobile sheet", () => {
  const pfDockStart = source.indexOf("{pfPanelOpen && (");
  const bgDockStart = source.indexOf("{bgPanelOpen && (");
  assert.ok(pfDockStart > bgDockStart, "the pf panel mounts in the same container as bg-tasks");
  const pfDock = source.slice(pfDockStart, source.indexOf(")", source.indexOf("width: 340", pfDockStart)));
  assert.match(pfDock, /role="dialog"/);
  assert.match(pfDock, /height: "62%"/);
  assert.match(pfDock, /aria-label=\{translate\("polyforge\.title"\)\}/);
  assert.match(pfDock, /width: 340/);
  assert.match(pfDock, /role="complementary"/);
  assert.match(pfDock, /<PolyforgePanel/);
  assert.match(pfDock, /onClose=\{\(\) => setPfPanelOpen\(false\)\}/);
});

test("the shell wires the hook's full state into the panel", () => {
  assert.match(source, /usePolyforge\(pfPanelOpen\)/);
  for (const prop of ["opsStatus={pfOpsStatus}", "opsError={pfOpsError}", "watchStatus={pfWatchStatus}",
    "selectedWi={pfSelectedWi}", "onSelect={selectPolyforgeJob}", "onRefresh={refreshPolyforgeStatus}"]) {
    assert.ok(source.includes(prop), `missing panel wiring: ${prop}`);
  }
});

test("no RegExp lookbehind anywhere in the new client sources", () => {
  for (const [name, src] of [["AppShell", source], ["PolyforgePanel", panelSource], ["usePolyforge", hookSource]]) {
    assert.doesNotMatch(src, /\(\?<[=!]/, `${name} uses a RegExp lookbehind (forbidden in client code)`);
  }
});
