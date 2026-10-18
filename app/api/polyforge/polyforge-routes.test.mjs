import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const statusSource = await readFile(new URL("./status/route.ts", import.meta.url), "utf8");
const watchSource = await readFile(new URL("./watch/route.ts", import.meta.url), "utf8");
const libSource = await readFile(new URL("../../../lib/polyforge-status.ts", import.meta.url), "utf8");

test("both routes re-check isApiRequestAllowed in-route (audit pattern) and are GET-only", () => {
  for (const [name, source] of [["status", statusSource], ["watch", watchSource]]) {
    assert.match(source, /export async function GET\(request: Request\)/, `${name} exports GET`);
    assert.doesNotMatch(source, /export async function (POST|PUT|DELETE|PATCH)/, `${name} must stay read-only`);
    assert.match(source, /isApiRequestAllowed\(request\)/, `${name} re-checks the host/origin gate in-route`);
    assert.match(source, /\{ error: "Forbidden" \}, \{ status: 403 \}/, `${name} answers 403 JSON on refusal`);
  }
});

test("degradation-first: no 5xx path, every failure answers decodable JSON with a null status", () => {
  for (const [name, source] of [["status", statusSource], ["watch", watchSource]]) {
    assert.match(source, /NextResponse\.json\(\{ pfPresent: false, status: null \}\)|NextResponse\.json\(\{ status: null, error/, `${name} has the 200-null degradation path`);
    assert.doesNotMatch(source, /status: 5\d\d/, `${name} must never answer 5xx (the e2e suite treats any 5xx as a browser error)`);
    assert.doesNotMatch(source, /throw new Error/, `${name} must not bare-throw`);
  }
  // pf absence is distinguishable from daemon-down only on the status route
  // (pfPresent), so the client can stop polling a pf-less install.
  assert.match(statusSource, /pfPresent: false/);
  assert.match(statusSource, /pfPresent: true/);
});

test("the watch route validates wi before any subprocess argv", () => {
  assert.match(watchSource, /searchParams\.get\("wi"\)/);
  assert.match(watchSource, /isPolyforgeWiRef\(wi\)/, "validation happens before getPolyforgeWatch");
  assert.match(watchSource, /\{ error: "wi must be a slug \(pi#107\) or id \(wi_…\)" \},\s*\{ status: 400 \}/, "malformed wi answers a field-level 400");
  // The validation must precede the spawn call in the file.
  assert.ok(
    watchSource.indexOf("isPolyforgeWiRef(wi)") < watchSource.indexOf("getPolyforgeWatch(wi)"),
    "the ref check must come before the pf call",
  );
});

test("the lib spawns the one-shot watcher with a 40-event tail", () => {
  assert.match(libSource, /"--once"/, "--once is mandatory: the resident watcher would stream forever");
  assert.match(libSource, /"--events", String\(EVENT_TAIL\)/);
  assert.equal(EVENT_TAIL_VALUE(), 40);
});

function EVENT_TAIL_VALUE() {
  const match = libSource.match(/const EVENT_TAIL = (\d+)/);
  assert.ok(match, "EVENT_TAIL constant");
  return Number(match[1]);
}
