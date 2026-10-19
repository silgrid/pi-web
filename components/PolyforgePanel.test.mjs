import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = await readFile(new URL("./PolyforgePanel.tsx", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhCNSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
const zhTWSource = await readFile(new URL("../lib/i18n/messages/zh-TW.ts", import.meta.url), "utf8");

function extractPureFunction(name) {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} must be exported`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `${name} body`);
  return source.slice(start, end + 2);
}

test("candidate shortening: >24 chars become the first 24 + ellipsis, nothing else changes", () => {
  const context = vm.createContext({});
  vm.runInContext(
    "const CANDIDATE_MAX = 24;\n" + stripTypeScriptTypes(
      extractPureFunction("shortenCandidate").replace(/export /g, "")
      + "\n" + stripTypeScriptTypes(extractPureFunction("formatAge").replace(/export /g, "")),
    ),
    context,
  );
  const long = "claude:claude-opus-5-5-extended-context-e2e";
  assert.equal(context.shortenCandidate(long), `${long.slice(0, 24)}…`);
  assert.equal(context.shortenCandidate("pi:glm-e2e"), "pi:glm-e2e", "24 chars and under pass through");
  assert.equal(context.shortenCandidate("x".repeat(24)), "x".repeat(24));
  assert.equal(context.shortenCandidate("x".repeat(25)), `x`.repeat(24) + "…");
  // Ages render compactly for the job list.
  assert.equal(context.formatAge(61), "1m");
  assert.equal(context.formatAge(7325), "2h 2m");
  assert.equal(context.formatAge(-1), "—");
});

test("job rows show slug, status label, spawn number, candidate, ages, and the queue badge", () => {
  assert.match(source, /\{job\.slug\}/);
  assert.match(source, /jobStatusLabel\(job\.status\)/);
  assert.match(source, /#\{job\.spawnN\}/);
  assert.match(source, /shortenCandidate\(job\.candidate\)/);
  assert.match(source, /formatAge\(job\.stepAgeSec\)/);
  assert.match(source, /formatAge\(job\.idleAgeSec\)/);
  assert.match(source, /\{opsStatus\.queue\.running\} \/ \{opsStatus\.queue\.max\}/, "queue running/max as 2/4");
  // All jobs, no owner filter: the sanitizer output is rendered wholesale.
  assert.doesNotMatch(source, /owner/i);
});

test("the detail shows the ordered step chips, event tail, and status-only blocked rendering", () => {
  assert.match(source, /watchStatus\.steps\.map\(\(step\) =>/);
  assert.match(source, /stepStatusLabel\(step\.status\)/);
  assert.match(source, /watchStatus\.events\.map\(\(event, index\) =>/);
  assert.match(source, /eventKindLabel\(event\.kind\)/);
  assert.match(source, /workflowStatusLabel\(watchStatus\.workflowStatus\)/, "a blocked WI shows its status");
  // No question text exists anywhere in the client: the only data source is
  // the sanitized watch snapshot, and the panel never references one.
  assert.doesNotMatch(source, /question/i);
});

test("empty, loading, and unavailable states are explicit", () => {
  assert.match(source, /\{t\("polyforge\.unavailable"\)\}/);
  assert.match(source, /\{t\("polyforge\.empty"\)\}/);
  assert.match(source, /\{t\("polyforge\.loading"\)\}/);
  assert.match(source, /\{t\("polyforge\.selectJob"\)\}/);
});

test("the selected detail carries an explicit deselect control (AC6 once the job leaves the list)", () => {
  // The detail header's back button calls onSelect(null) — the only gesture
  // that survives the selected job leaving the list (its row is gone) or the
  // watch snapshot still loading (header hoisted over the watchStatus split).
  assert.match(source, /onClick=\{\(\) => onSelect\(null\)\}/, "detail must have a deselect gesture outside the job rows");
  assert.match(source, /aria-label=\{t\("polyforge\.deselect"\)\}/, "accessible name via polyforge.deselect");
  // The header shows the selected ref even while the snapshot loads, so the
  // stale detail is always dismissable without a reload.
  assert.match(source, /\{watchStatus\?\.slug \?\? selectedWi\}/);
  // The key is translated in all three locales (fallback would be a raw key).
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    assert.match(localeSource, /"polyforge\.deselect": "\S/, `${name} must translate polyforge.deselect`);
  }
  // Accessible name must not collide with the topbar button locator, whose
  // name carries "Polyforge" (see e2e/polyforge.mjs pfButton).
  const enMatch = enSource.match(/"polyforge\.deselect": "([^"]+)"/);
  assert.ok(enMatch && !/polyforge/i.test(enMatch[1]), "deselect label must not contain Polyforge");
});

test("every user-facing string goes through i18n, with raw fallback for unknown values", () => {
  const usedKeys = [...source.matchAll(/t\("([a-zA-Z.]+)"\)/g)].map((m) => m[1]);
  assert.ok(usedKeys.length >= 4, `expected i18n keys, got ${usedKeys.length}`);
  for (const key of usedKeys) {
    assert.ok(key.startsWith("polyforge."), `unnamespaced key: ${key}`);
  }
  // Unknown statuses pass through raw instead of a missing-key warning.
  assert.match(source, /JOB_STATUS_KEYS\.has\(status\) \? t\(`polyforge\.jobStatus\.\$\{status\}`\) : status/);
  assert.match(source, /STEP_STATUS_KEYS\.has\(status\) \? t\(`polyforge\.stepStatus\.\$\{status\}`\) : status/);
  assert.match(source, /EVENT_KIND_KEYS\.has\(kind\) \? t\(`polyforge\.eventKind\.\$\{kind\}`\) : kind/);
});

test("all three locales carry the polyforge keys in parity", () => {
  const keyOf = (localeSource) => [
    ...localeSource.matchAll(/^\s*"((?:polyforge|bgTasks)\.[a-zA-Z._]+)":/gm),
  ].map((m) => m[1]).filter((key) => key.startsWith("polyforge."));
  const enKeys = keyOf(enSource);
  assert.ok(enKeys.length >= 40, `expected the full polyforge key set in en, got ${enKeys.length}`);
  for (const [name, localeSource] of [["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    const keys = keyOf(localeSource);
    assert.deepEqual(keys, enKeys, `${name} must carry the exact en key set in order`);
    assert.ok(!localeSource.includes("polyforge.queue\": \"Queue\""), `${name} must actually translate, not copy en`);
  }
});

test("pi#112: EVENT_KIND_KEYS covers exactly the 19 live kinds with raw fallback", () => {
  const match = source.match(/const EVENT_KIND_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(match, "EVENT_KIND_KEYS set literal");
  const kinds = [...match[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const expected = [
    "published", "transcript_missing", "exec_init", "step_started", "step_done",
    "step_failed", "step_dead", "candidate_switched", "needs_input", "answered",
    "gate_verdict", "rewind", "envelope_rejected", "needs_recovery", "push_failed",
    "job_started", "job_stopped", "terminal", "authored_tests_rebaselined",
  ];
  assert.equal(kinds.length, 19, `expected 19 kinds, got ${kinds.length}`);
  assert.deepEqual(kinds.slice().sort(), expected.slice().sort());
  assert.match(source, /EVENT_KIND_KEYS\.has\(kind\) \? t\(`polyforge\.eventKind\.\$\{kind\}`\) : kind/, "unknown kinds must render raw");
});

test("pi#112: collapseNoiseRuns collapses noise runs to one marker, meaningful events never collapse", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("collapseNoiseRuns").replace(/export /g, "")), context);
  const ev = (kind, i) => ({ at: `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`, kind });
  // JSON round-trip normalizes cross-realm object prototypes from the vm.
  const rows = JSON.parse(JSON.stringify(context.collapseNoiseRuns([
    ev("step_started", 0),
    ev("published", 1), ev("transcript_missing", 2), ev("exec_init", 3), ev("published", 4), ev("published", 5),
    ev("step_failed", 6),
    ev("transcript_missing", 7),
    ev("terminal", 8),
  ])));
  assert.deepEqual(rows, [
    { noise: false, event: ev("step_started", 0) },
    { noise: true, count: 5 },
    { noise: false, event: ev("step_failed", 6) },
    { noise: true, count: 1 },
    { noise: false, event: ev("terminal", 8) },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.collapseNoiseRuns([]))), [], "empty tail yields no rows");
});

test("pi#112: eventSeverity map is amber/red/green/neutral including terminal statuses", () => {
  const context = vm.createContext({});
  vm.runInContext(stripTypeScriptTypes(extractPureFunction("eventSeverity").replace(/export /g, "")), context);
  assert.equal(context.eventSeverity({ kind: "needs_input" }), "amber");
  for (const kind of ["step_failed", "step_dead", "push_failed", "envelope_rejected", "needs_recovery"]) {
    assert.equal(context.eventSeverity({ kind }), "red", kind);
  }
  assert.equal(context.eventSeverity({ kind: "terminal", status: "completed" }), "green");
  assert.equal(context.eventSeverity({ kind: "terminal", status: "failed" }), "red");
  assert.equal(context.eventSeverity({ kind: "terminal", status: "cancelled" }), null, "cancelled terminal is neutral");
  assert.equal(context.eventSeverity({ kind: "terminal" }), null, "terminal without status is neutral");
  for (const kind of ["answered", "gate_verdict", "rewind"]) {
    assert.equal(context.eventSeverity({ kind }), null, `${kind} is neutral`);
  }
});

test("pi#112: event mode toggle defaults simple, persists via localStorage, issues no request", () => {
  assert.match(source, /const EVENT_MODE_STORAGE_KEY = "pi-web:polyforge-event-mode"/, "global localStorage key");
  assert.match(source, /useState<EventMode>\("simple"\)/, "defaults to simple");
  assert.match(source, /window\.localStorage\.getItem\(EVENT_MODE_STORAGE_KEY\)/, "preference read");
  assert.match(source, /window\.localStorage\.setItem\(EVENT_MODE_STORAGE_KEY, next\)/, "preference written on toggle");
  const start = source.indexOf("const toggleEventMode = useCallback");
  assert.ok(start >= 0, "toggleEventMode exists");
  const end = source.indexOf("}, [eventMode]);", start);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /fetch|XMLHttpRequest|api\//i, "toggle click path must issue no request");
  assert.match(source, /onClick=\{toggleEventMode\}/, "toggle is wired to a control");
});

test("pi#112: mode toggle strings and eventSync word are translated in all three locales", () => {
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const key of ["polyforge.eventMode.simple", "polyforge.eventMode.verbose", "polyforge.eventSync"]) {
      assert.match(localeSource, new RegExp(`"${key.replace(/\./g, "\\.")}": "\\S`), `${name} must translate ${key}`);
    }
  }
});

test("pi#112: dead event-kind labels removed from all three locales", () => {
  for (const [name, localeSource] of [["en", enSource], ["zh-CN", zhCNSource], ["zh-TW", zhTWSource]]) {
    for (const kind of ["step_blocked", "job_done", "job_blocked"]) {
      assert.ok(!localeSource.includes(`polyforge.eventKind.${kind}`), `${name} still ships the dead label ${kind}`);
    }
  }
});
