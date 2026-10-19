import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = await readFile(new URL("./usePolyforge.ts", import.meta.url), "utf8");

function extractPureFunction(name) {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `${name} must be exported`);
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, `${name} body`);
  return source.slice(start, end + 2);
}

test("a degraded watch response keeps the previous snapshot (selection persistence)", () => {
  const context = vm.createContext({});
  vm.runInContext(
    stripTypeScriptTypes(extractPureFunction("nextWatchSnapshot").replace(/export /g, "")),
    context,
  );
  const snapshot = { wi: "wi_x", slug: "pi#108", workflowStatus: "running", steps: [], events: [] };
  assert.equal(context.nextWatchSnapshot(snapshot, { status: null }), snapshot, "null status keeps the snapshot");
  assert.equal(context.nextWatchSnapshot(snapshot, null), snapshot, "no body keeps the snapshot");
  assert.equal(context.nextWatchSnapshot(snapshot, {}), snapshot, "missing status keeps the snapshot");
  const next = { ...snapshot, workflowStatus: "done" };
  assert.equal(context.nextWatchSnapshot(snapshot, { status: next }), next, "a real snapshot replaces it");
});

test("one fetch at mount decides presence; a pf-less install never polls again", () => {
  assert.match(source, /useEffect\(\(\) => \{\s*refreshStatus\(\);/);
  assert.match(source, /return \(\) => \{\s*\+\+statusSeq\.current;/);
  assert.match(source, /if \(!probed \|\| !pfPresent\) return;/, "the cadence effect gates on presence");
});

test("effect cleanups advance the guard counters; they never rewind to an observation + 1", () => {
  assert.match(source, /return \(\) => \{\s*\+\+watchSeq\.current;\s*clearInterval\(interval\);/);
  assert.doesNotMatch(source, /seqAt\w+ \+ 1/, "a counter reset to seqAtX + 1 rewinds after interval polls");
});

test("cadence: 3s while the panel is open, 30s while closed", () => {
  assert.match(source, /const OPEN_STATUS_POLL_MS = 3000;/);
  assert.match(source, /const CLOSED_STATUS_POLL_MS = 30000;/);
  assert.match(source, /panelOpen \? OPEN_STATUS_POLL_MS : CLOSED_STATUS_POLL_MS/);
});

test("the watch poll runs every 3s while open with a selection", () => {
  assert.match(source, /if \(!panelOpen \|\| !selectedWi\) return;/);
  assert.match(source, /const OPEN_WATCH_POLL_MS = 3000;/);
});

test("the watch URL encodes the ref and stale fetches are dropped by sequence", () => {
  assert.match(source, /\/api\/polyforge\/watch\?wi=\$\{encodeURIComponent\(wi\)\}/);
  assert.match(source, /if \(seq !== statusSeq\.current\) return;/);
  assert.match(source, /if \(seq !== watchSeq\.current\) return;/);
});

test("selecting replaces the snapshot; the running count is null while unknown", () => {
  assert.match(source, /setWatchStatus\(null\);/);
  assert.match(source, /const runningCount = opsStatus \? opsStatus\.queue\.running : null;/, "no badge while the daemon is down");
});

test("pi#113: refreshStatus returns its settle promise for the manual-refresh feedback", () => {
  assert.match(source, /return fetch\("\/api\/polyforge\/status"\)/, "the fetch chain is returned");
  // The promise resolves on both success and failure paths (the .catch arm).
  const start = source.indexOf("const refreshStatus = useCallback");
  const end = source.indexOf("}, []);", start);
  const body = source.slice(start, end);
  assert.match(body, /\.catch\(\(\) => \{/);
  assert.match(body, /return fetch\("\/api\/polyforge\/status"\)/);
});
