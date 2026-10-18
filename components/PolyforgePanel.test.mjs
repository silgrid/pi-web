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
