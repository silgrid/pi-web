import assert from "node:assert/strict";
import test from "node:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./polyforge-cards.ts");
const pure = await jiti.import("./polyforge-cards-pure.ts");

const T0 = Date.parse("2026-10-30T01:00:00.000Z");
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const job = (wi, slug = wi, status = "running") => ({ wi, slug, status, stepAgeSec: 1, idleAgeSec: 2, candidate: "pi:m", spawnN: 1 });
const SECRETS = ["SECRET-TOOL-RESULT", "SECRET-THINKING", "SECRET-PROMPT", "SECRET-TOKEN", "SECRET-SYSTEM"];
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const piText = (id, text) => ({ type: "message", id, parentId: null, message: { role: "assistant", content: [{ type: "text", text }] } });

function fixture(t) {
  const work = mkdtempSync(join(tmpdir(), "pf-cards-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const root = join(work, "data");
  mkdirSync(join(root, "events"), { recursive: true });
  const records = [];
  const writeIndex = () => writeFileSync(join(root, "runtime-state.json"), JSON.stringify({ version: 1, jobs: records }));
  function capsule(wi, { steps = ["grill", "code"], goal = "goal", execution, journal, bundle = "feature-full" } = {}) {
    const dir = join(work, "capsules", wi);
    mkdirSync(join(dir, "runtime-state"), { recursive: true });
    mkdirSync(join(dir, "workflows", bundle), { recursive: true });
    mkdirSync(join(dir, "session"), { recursive: true });
    writeFileSync(join(dir, "capsule.json"), JSON.stringify({ bundle_name: bundle }));
    writeFileSync(join(dir, "workflows", bundle, "workflow.md"), `---\nname: x\nsteps:\n${steps.map((id) => `  - { id: ${id}, recall: true }`).join("\n")}\n---\nbody\n`);
    if (goal !== null) writeFileSync(join(dir, "runtime-state", "work-item.json"), JSON.stringify({ goal }));
    if (execution) writeFileSync(join(dir, "runtime-state", "execution.json"), JSON.stringify(execution));
    if (journal) writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl(journal));
    records.push({ work_item_id: wi, capsule_dir: dir, transcript: join(dir, "session", "job.jsonl") });
    writeIndex();
    return dir;
  }
  const events = (wi, list) => writeFileSync(join(root, "events", `wi-${wi}.jsonl`), jsonl(list.map(([sec, kind, step]) => ({ at: at(sec), kind, work_item: wi, body: step ? { step } : {} }))));
  return { work, root, capsule, events };
}

test("step durations: summed runs with ×N, live current step, unstarted and unknown, declared order", (t) => {
  const f = fixture(t);
  const wi = "wi_steps01";
  f.capsule(wi, {
    steps: ["grill", "spec", "plan", "ghost", "code", "review"],
    execution: { current_step: "code", steps: {
      grill: { status: "done" }, spec: { status: "done" }, plan: { status: "done" }, ghost: { status: "done" },
      code: { status: "in_progress", step_started_at: at(100) }, review: { status: "pending" } } },
  });
  f.events(wi, [[0, "job_started"], [50, "job_started"], [1, "step_started", "grill"], [11, "step_done", "grill"],
    [12, "step_started", "spec"], [20, "step_started", "spec"], [30, "step_done", "spec"],
    [31, "step_started", "plan"], [41, "step_done", "plan"], [42, "step_started", "plan"], [47, "step_done", "plan"]]);
  const [card] = lib.readPolyforgeCards([job(wi)], new Map(), T0 + 160_000, f.root);
  assert.equal(card.startedAt, at(0), "earliest job_started");
  assert.equal(card.goal, "goal");
  assert.deepEqual(card.steps, [
    { id: "grill", state: "timed", durationSec: 10, runs: 1 },
    { id: "spec", state: "timed", durationSec: 18, runs: 2 },
    { id: "plan", state: "timed", durationSec: 15, runs: 2 },
    { id: "ghost", state: "unknown", runs: 0 },
    { id: "code", state: "timed", durationSec: 60, runs: 1 },
    { id: "review", state: "unstarted", runs: 0 },
  ]);
  const later = lib.readPolyforgeCards([job(wi)], new Map(), T0 + 170_000, f.root)[0];
  assert.equal(later.steps[4].durationSec, 70, "the running step grows with now");
  assert.equal(card.currentStep, "code", "the card carries execution.json's current_step");
});

test("currentStep is present only when execution.json names one", (t) => {
  const f = fixture(t);
  f.capsule("wi_nocur01", { execution: { steps: { grill: { status: "done" } } } });
  f.capsule("wi_noexec1");
  const cards = lib.readPolyforgeCards([job("wi_nocur01"), job("wi_noexec1")], new Map(), T0, f.root);
  for (const card of cards) assert.equal("currentStep" in card, false, `${card.job.wi}: no current step, no field`);
});

test("an open run closes at now only for the current in-progress step", () => {
  const events = [{ at: at(0), kind: "step_started", step: "a" }, { at: at(5), kind: "step_started", step: "b" }];
  const execution = { currentStep: "b", steps: new Map([["a", { status: "failed" }], ["b", { status: "in_progress" }]]) };
  const steps = lib.computeCardSteps(["a", "b", "c"], events, execution, T0 + 25_000);
  assert.deepEqual(steps, [
    { id: "a", state: "unknown", runs: 1 },
    { id: "b", state: "timed", durationSec: 20, runs: 1 },
    { id: "c", state: "unstarted", runs: 0 },
  ]);
});

test("a skipped step with no run renders as skipped, not unknown", () => {
  const execution = { currentStep: "c", steps: new Map([["a", { status: "skipped" }], ["b", { status: "done" }], ["c", { status: "pending" }]]) };
  assert.deepEqual(lib.computeCardSteps(["a", "b", "c"], [], execution, T0), [
    { id: "a", state: "skipped", runs: 0 },
    { id: "b", state: "unknown", runs: 0 },
    { id: "c", state: "unstarted", runs: 0 },
  ]);
});

test("without a readable workflow the order falls back to observed starts, then the record's keys", () => {
  const events = [{ at: at(0), kind: "step_started", step: "y" }, { at: at(1), kind: "step_started", step: "x" }];
  const execution = { steps: new Map([["x", { status: "done" }], ["z", { status: "pending" }], ["y", { status: "done" }]]) };
  assert.deepEqual(lib.cardStepOrder(undefined, events, execution), ["y", "x", "z"]);
  assert.deepEqual(lib.cardStepOrder(["a"], events, execution), ["a"]);
});

test("pi transcript: first load is the newest 20 whitelisted entries; the cursor then returns only the increment", (t) => {
  const f = fixture(t);
  const wi = "wi_pitrans1";
  const dir = f.capsule(wi, { execution: { current_step: "code", steps: { code: { status: "in_progress" } } } });
  const transcript = join(dir, "session", "s.jsonl");
  writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ step_id: "code", transcript, harness: "pi" }]));
  writeFileSync(transcript, jsonl([
    { type: "session", id: "s" },
    { type: "message", id: "u", message: { role: "user", content: "SECRET-PROMPT" } },
    ...Array.from({ length: 30 }, (_, i) => piText(`p${i}`, `PROGRESS-${String(i).padStart(2, "0")}`)),
    { type: "message", id: "tc", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-THINKING" }, { type: "toolCall", id: "c", name: "bash", arguments: { command: "curl --token=SECRET-TOKEN x" } }] } },
    { type: "message", id: "tr", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "SECRET-TOOL-RESULT" }] } },
  ]));
  const [first] = lib.readPolyforgeCards([job(wi)], new Map(), T0, f.root);
  assert.equal(first.progress.available, true);
  assert.equal(first.progress.reset, true);
  assert.equal(first.progress.entries.length, 20);
  assert.equal(first.progress.entries[0].text, "PROGRESS-10");
  // narration only — the tool call yields no entry at all.
  assert.deepEqual(first.progress.entries.at(-1), { id: first.progress.entries.at(-1).id, text: "PROGRESS-29" });
  for (const entry of first.progress.entries) assert.deepEqual(Object.keys(entry).sort(), ["id", "text"], "an entry is {id, text}");
  const body = JSON.stringify(first);
  for (const secret of [...SECRETS, "bash", "curl", "token="]) assert.ok(!body.includes(secret), `leaked ${secret}`);
  assert.ok(pure.isPolyforgeCardCursor(first.progress.cursor));

  const same = lib.readPolyforgeCards([job(wi)], new Map([[wi, first.progress.cursor]]), T0, f.root)[0];
  assert.deepEqual(same.progress.entries, [], "nothing new, nothing re-sent");
  assert.equal(same.progress.cursor, first.progress.cursor);
  assert.notEqual(same.progress.reset, true);

  appendFileSync(transcript, jsonl([piText("n1", "NEW-ONE"), piText("n2", "NEW-TWO")]));
  const next = lib.readPolyforgeCards([job(wi)], new Map([[wi, first.progress.cursor]]), T0, f.root)[0];
  assert.deepEqual(next.progress.entries.map((e) => e.text), ["NEW-ONE", "NEW-TWO"], "only the increment");

  appendFileSync(transcript, jsonl(Array.from({ length: 45 }, (_, i) => piText(`m${i}`, `MORE-${i}`))));
  const page = lib.readPolyforgeCards([job(wi)], new Map([[wi, next.progress.cursor]]), T0, f.root)[0];
  assert.equal(page.progress.entries.length, 20, "a poll returns at most 20 entries");
  assert.equal(page.progress.entries[0].text, "MORE-0");
  const page2 = lib.readPolyforgeCards([job(wi)], new Map([[wi, page.progress.cursor]]), T0, f.root)[0];
  assert.equal(page2.progress.entries[0].text, "MORE-20", "the cursor continues exactly after the page");

  writeFileSync(transcript, jsonl([piText("r", "REPLACED")]));
  const replaced = lib.readPolyforgeCards([job(wi)], new Map([[wi, page2.progress.cursor]]), T0, f.root)[0];
  assert.equal(replaced.progress.reset, true, "a truncated transcript re-sends the newest page");
  assert.deepEqual(replaced.progress.entries.map((e) => e.text), ["REPLACED"]);
});

test("claude transcript: assistant text only; tool_use, api-request-blob, tool results, thinking and prompts never", (t) => {
  const f = fixture(t);
  const wi = "wi_claude01";
  const dir = f.capsule(wi);
  const transcript = join(dir, "session", "c.jsonl");
  writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ step_id: "code", transcript, harness: "claude" }]));
  writeFileSync(transcript, jsonl([
    { type: "queue-operation", operation: "enqueue", content: "SECRET-PROMPT" },
    { type: "user", message: { role: "user", content: [{ type: "text", text: "SECRET-PROMPT" }] } },
    { type: "api-request-blob", message: { role: "assistant", content: [{ type: "text", text: "SECRET-SYSTEM" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET-THINKING" }, { type: "text", text: "VISIBLE\n  text" }, { type: "tool_use", id: "t", name: "Bash", input: { command: "echo FOO_API_KEY=SECRET-TOKEN" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "SECRET-TOOL-RESULT" }] } },
  ]));
  const [card] = lib.readPolyforgeCards([job(wi)], new Map(), T0, f.root);
  assert.deepEqual(card.progress.entries.map(({ text }) => text), ["VISIBLE text"], "the tool_use block yields no entry");
  const body = JSON.stringify(card);
  for (const secret of [...SECRETS, "Bash", "echo FOO_API_KEY"]) assert.ok(!body.includes(secret), `leaked ${secret}`);
});

test("narration keeps its credential mask", (t) => {
  const f = fixture(t);
  const wi = "wi_mask01";
  const dir = f.capsule(wi);
  const transcript = join(dir, "session", "s.jsonl");
  writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ step_id: "code", transcript, harness: "pi" }]));
  writeFileSync(transcript, jsonl([piText("n", "calling with token=SECRET-TOKEN now")]));
  const [card] = lib.readPolyforgeCards([job(wi)], new Map(), T0, f.root);
  assert.deepEqual(card.progress.entries.map(({ text }) => text), ["calling with token=*** now"]);
});

test("entries are capped at 400 code points after masking", (t) => {
  const f = fixture(t);
  const wi = "wi_cap01";
  const dir = f.capsule(wi);
  const transcript = join(dir, "session", "s.jsonl");
  writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ transcript, harness: "pi" }]));
  writeFileSync(transcript, jsonl([piText("a", "界".repeat(900))]));
  const [card] = lib.readPolyforgeCards([job(wi)], new Map(), T0, f.root);
  assert.equal(Array.from(card.progress.entries[0].text).length, 400);
});

test("a large transcript is never replayed whole: the first load reads only the tail window", (t) => {
  const f = fixture(t);
  const wi = "wi_large01";
  const dir = f.capsule(wi);
  const transcript = join(dir, "session", "s.jsonl");
  writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ transcript, harness: "pi" }]));
  writeFileSync(transcript, jsonl(Array.from({ length: 5000 }, (_, i) => piText(`l${i}`, `LINE-${i} ${"x".repeat(80)}`))));
  const [card] = lib.readPolyforgeCards([job(wi)], new Map(), T0, f.root);
  assert.equal(card.progress.entries.length, 20);
  assert.ok(card.progress.entries.at(-1).text.startsWith("LINE-4999 "));
  const offset = pure.parseCardCursor(card.progress.cursor).offset;
  assert.ok(offset > lib.TRANSCRIPT_WINDOW_BYTES, "the cursor points at the end, not the start");
});

test("the per-response budget caps entries across cards and keeps a starved card's cursor", (t) => {
  const f = fixture(t);
  const jobs = [];
  const cursors = new Map();
  for (let i = 0; i < 12; i++) {
    const wi = `wi_budget${String(i).padStart(2, "0")}`;
    const dir = f.capsule(wi);
    const transcript = join(dir, "session", "s.jsonl");
    writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ transcript, harness: "pi" }]));
    writeFileSync(transcript, jsonl(Array.from({ length: 30 }, (_, j) => piText(`e${j}`, `E${i}-${j}`))));
    f.events(wi, [[i, "job_started"]]);
    jobs.push(job(wi));
    if (i === 11) cursors.set(wi, pure.formatCardCursor("0123456789abcdef", 0));
  }
  const cards = lib.readPolyforgeCards(jobs, cursors, T0, f.root);
  const total = cards.reduce((sum, c) => sum + c.progress.entries.length, 0);
  assert.equal(total, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(cards)) < 200 * 1024);
  assert.deepEqual(cards[10].progress, { available: true, entries: [] }, "a starved first load leaves no cursor");
  assert.deepEqual(cards[11].progress, { available: true, entries: [], cursor: cursors.get("wi_budget11") }, "a starved card keeps its cursor");
});

test("missing, unknown-harness, unrecognised and outside-root transcripts degrade to unavailable", (t) => {
  const f = fixture(t);
  const make = (wi, journal, content) => {
    const dir = f.capsule(wi);
    const transcript = journal.transcript ?? join(dir, "session", "s.jsonl");
    writeFileSync(join(dir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ ...journal, transcript }]));
    if (content !== undefined) writeFileSync(transcript, content);
    return dir;
  };
  make("wi_missing1", { harness: "pi" });
  make("wi_codex01", { harness: "codex" }, jsonl([piText("a", "x")]));
  make("wi_unrec01", { harness: "claude" }, jsonl([piText("a", "x")]));
  make("wi_empty01", { harness: "pi" }, "");
  const outside = join(f.work, "outside.jsonl");
  writeFileSync(outside, jsonl([piText("a", "OUTSIDE")]));
  const records = JSON.parse(readFileSync(join(f.root, "runtime-state.json"), "utf8"));
  records.jobs = records.jobs.map((r) => (r.work_item_id === "wi_missing1" ? { ...r, transcript: outside } : r));
  writeFileSync(join(f.root, "runtime-state.json"), JSON.stringify(records));
  make("wi_outside1", { harness: "pi", transcript: outside });
  const wis = ["wi_missing1", "wi_codex01", "wi_unrec01", "wi_empty01", "wi_outside1"];
  const cards = lib.readPolyforgeCards(wis.map((wi) => job(wi)), new Map(), T0, f.root);
  for (const card of cards) {
    assert.deepEqual(card.progress, { available: false, entries: [] }, card.job.wi);
    assert.ok(!JSON.stringify(card).includes("OUTSIDE"));
  }
});

test("the harness's live session file comes first; the job record's transcript is never a progress source", (t) => {
  const f = fixture(t);
  // pi: the newest step-agent session written since the step started wins over the capsule copy.
  const piWi = "wi_livepi01";
  const piDir = f.capsule(piWi);
  const copy = join(piDir, "session", "copy.jsonl");
  writeFileSync(copy, jsonl([{ type: "session", id: "s" }, piText("c", "CAPSULE-COPY")]));
  writeFileSync(join(piDir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ step_id: "code", started_at: new Date(Date.now() - 1000).toISOString(), transcript: copy, harness: "pi" }]));
  const sessions = join(f.root, "step-agent-sessions", lib.encodePiSessionDir(piDir));
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "old.jsonl"), jsonl([piText("o", "OLDER-STEP")]));
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(join(sessions, "old.jsonl"), old, old);
  writeFileSync(join(sessions, "new.jsonl"), jsonl([piText("n", "LIVE-PI")]));
  // claude: the harness_session file under claude-config wins.
  const clWi = "wi_liveclaude";
  const clDir = f.capsule(clWi);
  writeFileSync(join(clDir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ step_id: "code", harness: "claude", harness_session: "11bff798-b38a-4b0b-9601-814d9e471ff4", transcript: join(clDir, "session", "not-yet.jsonl") }]));
  const projects = join(f.root, "claude-config", "projects", lib.encodeClaudeProjectDir(clDir));
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, "11bff798-b38a-4b0b-9601-814d9e471ff4.jsonl"), jsonl([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "LIVE-CLAUDE" }] } }]));
  // A step whose live file is not there yet: only an older pi session exists → the capsule copy.
  const oldWi = "wi_stalepi01";
  const oldDir = f.capsule(oldWi);
  const oldCopy = join(oldDir, "session", "copy.jsonl");
  writeFileSync(oldCopy, jsonl([{ type: "session", id: "s" }, piText("c", "STEP-COPY")]));
  writeFileSync(join(oldDir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ step_id: "code", started_at: new Date().toISOString(), transcript: oldCopy, harness: "pi" }]));
  const oldSessions = join(f.root, "step-agent-sessions", lib.encodePiSessionDir(oldDir));
  mkdirSync(oldSessions, { recursive: true });
  writeFileSync(join(oldSessions, "prev.jsonl"), jsonl([piText("p", "PREVIOUS-STEP")]));
  utimesSync(join(oldSessions, "prev.jsonl"), old, old);
  // The job record's transcript (the job's first step) is ignored when the journal's path is gone.
  const recWi = "wi_recordonly";
  const recDir = f.capsule(recWi);
  writeFileSync(join(recDir, "session", "job.jsonl"), jsonl([piText("j", "FIRST-STEP")]));
  writeFileSync(join(recDir, "runtime-state", "spawn-journal.jsonl"), jsonl([{ step_id: "code", transcript: join(recDir, "session", "gone.jsonl"), harness: "pi" }]));

  const cards = lib.readPolyforgeCards([job(piWi), job(clWi), job(oldWi), job(recWi)], new Map(), T0, f.root);
  const texts = Object.fromEntries(cards.map((c) => [c.job.wi, c.progress.entries.map((e) => e.text)]));
  assert.deepEqual(texts[piWi], ["LIVE-PI"]);
  assert.deepEqual(texts[clWi], ["LIVE-CLAUDE"]);
  assert.deepEqual(texts[oldWi], ["STEP-COPY"], "a session file older than the step is not the current step's");
  assert.deepEqual(cards.find((c) => c.job.wi === recWi).progress, { available: false, entries: [] });
  assert.equal(lib.encodePiSessionDir("/root/a/b-c"), "--root-a-b-c--");
  assert.equal(lib.encodeClaudeProjectDir("/root/a/b_c.d"), "-root-a-b-c-d");
});

test("unknown, malformed and record-less jobs keep their job facts and never throw", (t) => {
  const f = fixture(t);
  f.capsule("wi_known01", { goal: null, steps: [] });
  f.events("wi_known01", [[5, "job_started"]]);
  const jobs = [job("../../etc/passwd", "evil#1"), job("", "noid#2"), job("wi_notindex", "x#3"), job("wi_known01", "k#4")];
  const cards = lib.readPolyforgeCards(jobs, new Map([["wi_known01", "c1.0123456789abcdef.99999999"]]), T0, f.root);
  assert.deepEqual(cards.map((c) => c.job.slug), ["k#4", "evil#1", "noid#2", "x#3"], "known start first, then by key");
  const known = cards[0];
  assert.equal(known.goal, undefined, "a missing work item renders the slug alone");
  assert.deepEqual(known.steps, []);
  for (const card of cards.slice(1)) {
    assert.deepEqual(card.steps, []);
    assert.deepEqual(card.progress, { available: false, entries: [] });
  }
  assert.deepEqual(lib.readPolyforgeCards([job("wi_x")], new Map(), T0, join(f.work, "absent-root"))[0].progress, { available: false, entries: [] });
});

test("an oversized event file is read as a bounded head and tail", (t) => {
  const f = fixture(t);
  const wi = "wi_bigevents";
  f.capsule(wi, { steps: ["code"], execution: { current_step: "code", steps: { code: { status: "done" } } } });
  const filler = Array.from({ length: 9000 }, (_, i) => [1 + i / 1000, "published"]);
  f.events(wi, [[0, "job_started"], ...filler, [100, "step_started", "code"], [130, "step_done", "code"]]);
  const [card] = lib.readPolyforgeCards([job(wi)], new Map(), T0, f.root);
  assert.equal(card.startedAt, at(0));
  assert.deepEqual(card.steps, [{ id: "code", state: "timed", durationSec: 30, runs: 1 }]);
});
