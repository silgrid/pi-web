import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// GET /api/polyforge/progress?wi= — the job detail's
// execution-progress read face. The handler runs for real (jiti) against a
// throwaway daemon data root; the source pins cover what a run cannot (no
// other handler, no log/env/write).
const source = readFileSync(new URL("./progress/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("./progress/route.ts");

const BASE = "http://127.0.0.1:30141/api/polyforge/progress";
const SECRETS = ["SECRET-TOOL-RESULT", "SECRET-THINKING", "SECRET-PROMPT", "SECRET-TOKEN", "SECRET-SYSTEM"];
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

function fixture(t) {
  const work = mkdtempSync(join(tmpdir(), "pf-progress-route-"));
  const previous = process.env.POLYFORGE_DATA_DIR;
  const root = join(work, "data");
  mkdirSync(root, { recursive: true });
  process.env.POLYFORGE_DATA_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.POLYFORGE_DATA_DIR;
    else process.env.POLYFORGE_DATA_DIR = previous;
    rmSync(work, { recursive: true, force: true });
  });
  const jobs = [];
  const capsule = (wi, transcript, content) => {
    const dir = join(work, "capsules", wi);
    mkdirSync(join(dir, "runtime-state"), { recursive: true });
    mkdirSync(join(dir, "session"), { recursive: true });
    const path = transcript ?? join(dir, "session", "s.jsonl");
    writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ step_id: "code", transcript: path, harness: "pi" }]));
    if (content !== undefined) writeFileSync(path, content);
    jobs.push({ work_item_id: wi, capsule_dir: dir });
    writeFileSync(join(root, "runtime-state.json"), JSON.stringify({ version: 1, jobs }));
    return dir;
  };
  return { work, root, capsule };
}

const get = async (query, init = {}) => {
  // The gate trusts a loopback Host header (as a local browser sends).
  const headers = { host: "127.0.0.1:30141", ...init.headers };
  const response = await GET(new Request(`${BASE}${query}`, { ...init, headers }));
  return { status: response.status, text: await response.text() };
};

test("the progress route is GET-only, gated in-route, dynamic, and never logs, reads env directly or writes", () => {
  const handlers = [...source.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(handlers, ["GET"], "only GET (any other method is 405)");
  assert.match(source, /if \(!isApiRequestAllowed\(request\)\)/);
  assert.match(source, /NextResponse\.json\(\{ error: "Forbidden" \}, \{ status: 403 \}\)/);
  assert.match(source, /export const dynamic = "force-dynamic"/);
  const statuses = [...source.matchAll(/status: (\d{3})/g)].map((m) => Number(m[1])).sort();
  assert.deepEqual(statuses, [400, 400, 403], "only the two 400s and the gate's 403");
  assert.doesNotMatch(source, /console\.(log|error|warn)|process\.env|request\.json|formData|writeFile|appendFile/);
  const params = [...source.matchAll(/searchParams\.get\("(\w+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(params, ["wi"], "no path/file query is read");
});

test("end to end — narration + one masked tool line; no tool result, thinking, prompt or raw credential", async (t) => {
  const f = fixture(t);
  const dir = f.capsule("wi_route210a", undefined, jsonl([
    { type: "session", id: "s" },
    { type: "message", id: "u", message: { role: "user", content: "SECRET-PROMPT" } },
    { type: "message", id: "n", message: { role: "assistant", content: [{ type: "text", text: "ROUTE-NARRATION token=SECRET-TOKEN" }] } },
    { type: "message", id: "tc", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-THINKING" }, { type: "toolCall", id: "c", name: "bash", arguments: { command: "curl --token=SECRET-TOKEN https://x.invalid" } }] } },
    { type: "message", id: "tr", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "SECRET-TOOL-RESULT" }] } },
  ]));
  const { status, text } = await get("?wi=wi_route210a");
  assert.equal(status, 200);
  const body = JSON.parse(text);
  assert.equal(body.available, true);
  assert.deepEqual(body.entries.map(({ kind, text: line }) => [kind, line]), [
    ["narration", "ROUTE-NARRATION token=***"],
    ["tool", "bash: curl --token=*** https://x.invalid"],
  ]);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `the response leaks ${secret}`);
  for (const word of ["toolResult", "thinking", "user", "system", dir, f.root]) assert.ok(!text.includes(word), `the response carries ${word}`);
});

test("a wrong-shaped or unknown wi is a 400 before any transcript read; no path leaves", async (t) => {
  const f = fixture(t);
  f.capsule("wi_route210b", undefined, jsonl([{ type: "message", id: "n", message: { role: "assistant", content: [{ type: "text", text: "KNOWN-ONLY" }] } }]));
  for (const query of ["", "?wi=", "?wi=../../etc/passwd", "?wi=wi_route210b/../x", "?wi=workbench%23210", "?wi=wi_route210unknown"]) {
    const { status, text } = await get(query);
    assert.equal(status, 400, `refused: ${query || "no wi"}`);
    assert.ok(!text.includes("KNOWN-ONLY") && !text.includes(f.root), `nothing read or named for ${query}`);
  }
  rmSync(join(f.root, "runtime-state.json"));
  assert.equal((await get("?wi=wi_route210b")).status, 400, "an unreadable job index finds no record");
});

test("an outside, missing or partial transcript, or a record without a capsule, degrades to 200 available:false", async (t) => {
  const f = fixture(t);
  const outside = join(f.work, "outside.jsonl");
  writeFileSync(outside, jsonl([{ type: "message", id: "o", message: { role: "assistant", content: [{ type: "text", text: "OUTSIDE" }] } }]));
  f.capsule("wi_route210c", outside);
  f.capsule("wi_route210d");
  f.capsule("wi_route210e", undefined, '{"type":"message","id":"half","message":{"role":"assistant","content":[{"type":"text","text":"HALF"');
  const records = JSON.parse(readFileSync(join(f.root, "runtime-state.json"), "utf8"));
  records.jobs.push({ work_item_id: "wi_route210f" });
  writeFileSync(join(f.root, "runtime-state.json"), JSON.stringify(records));
  for (const wi of ["wi_route210c", "wi_route210d", "wi_route210e", "wi_route210f"]) {
    const { status, text } = await get(`?wi=${wi}`);
    assert.equal(status, 200, wi);
    assert.deepEqual(JSON.parse(text), { available: false, entries: [] }, wi);
    assert.ok(!text.includes("OUTSIDE") && !text.includes("HALF"), wi);
  }
});

test("a cross-site request is refused by the existing gate with 403", async (t) => {
  const f = fixture(t);
  f.capsule("wi_route210g", undefined, jsonl([{ type: "message", id: "n", message: { role: "assistant", content: [{ type: "text", text: "GATED" }] } }]));
  const { status, text } = await get("?wi=wi_route210g", { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(status, 403);
  assert.ok(!text.includes("GATED"));
});
