import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const pure = await jiti.import("./polyforge-cards-pure.ts");

const job = (wi, slug = wi) => ({ wi, slug, status: "running", stepAgeSec: 1, idleAgeSec: 1, candidate: "pi:m", spawnN: 1 });
const entry = (id, text = id) => ({ id, text });
const card = (wi, progress, extra = {}) => ({ job: job(wi), steps: [], progress, ...extra });

test("the module stays client-safe: no node: import", async () => {
  const source = await readFile(new URL("./polyforge-cards-pure.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:/);
  assert.doesNotMatch(source, /^import\s+(?!type\b)/m, "only type imports");
});

test("bounds are the documented ones", () => {
  assert.equal(pure.CARD_ENTRY_MAX, 400);
  assert.equal(pure.CARD_FIRST_PAGE, 20);
  assert.equal(pure.CARD_POLL_PAGE, 20);
  assert.equal(pure.CARD_RESPONSE_MAX_ENTRIES, 200);
  assert.equal(pure.CARD_RESPONSE_MAX_BYTES, 128 * 1024);
  assert.equal(pure.CARD_CLIENT_MAX_ENTRIES, 200);
});

test("cursors are a closed opaque shape, never a path", () => {
  const cursor = pure.formatCardCursor("0123456789abcdef", 42);
  assert.equal(cursor, "c1.0123456789abcdef.42");
  assert.deepEqual(pure.parseCardCursor(cursor), { identity: "0123456789abcdef", offset: 42 });
  for (const bad of ["../etc/passwd", "c1.0123.4", "c1.0123456789ABCDEF.1", "c1.0123456789abcdef.-1", "c1.0123456789abcdef.1/x", 7, null]) {
    assert.equal(pure.isPolyforgeCardCursor(bad), false, String(bad));
    assert.equal(pure.parseCardCursor(bad), null);
  }
});

test("the cursors query keeps only wi-id keys with cursor values; malformed input reads as empty", () => {
  const good = pure.formatCardCursor("0123456789abcdef", 9);
  const map = pure.parseCardCursors(JSON.stringify({ wi_abc123: good, "../x": good, wi_ok: "../y", wi_num: 5 }));
  assert.deepEqual([...map], [["wi_abc123", good]]);
  for (const raw of [null, "", "not-json", "[1,2]", "\"str\"", "null"]) assert.equal(pure.parseCardCursors(raw).size, 0);
});

test("cards sort by earliest start, ties by wi id, unknown starts last by wi id", () => {
  const cards = [
    card("wi_D", { available: false, entries: [] }),
    card("wi_C", { available: false, entries: [] }, { startedAt: "2026-10-30T01:02:00Z" }),
    card("wi_B2", { available: false, entries: [] }, { startedAt: "2026-10-30T01:01:00Z" }),
    card("wi_A", { available: false, entries: [] }, { startedAt: "2026-10-30T01:00:00Z" }),
    card("wi_B1", { available: false, entries: [] }, { startedAt: "2026-10-30T01:01:00Z" }),
    card("wi_0", { available: false, entries: [] }, { startedAt: "not-a-time" }),
  ];
  assert.deepEqual(pure.sortPolyforgeCards(cards).map((c) => c.job.wi), ["wi_A", "wi_B1", "wi_B2", "wi_C", "wi_0", "wi_D"]);
  assert.deepEqual(pure.sortPolyforgeCards([...cards].reverse()).map((c) => c.job.wi), ["wi_A", "wi_B1", "wi_B2", "wi_C", "wi_0", "wi_D"], "input order never matters");
});

test("the tool-name cap is gone: entries are narration only", () => {
  assert.equal("CARD_TOOL_NAME_MAX" in pure, false);
});

test("the card step-phase helper is gone with the on-card segment bar; the wire steps stay", async () => {
  assert.equal("cardStepPhase" in pure, false, "no card renders a step segment any more");
  const source = await readFile(new URL("./polyforge-cards-pure.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /PolyforgeCardStepPhase/);
  assert.match(source, /export interface PolyforgeCardStep\b/, "the cards read face keeps its step payload for the detail");
});

test("titles truncate by code point with an ellipsis; a short goal stays whole", () => {
  assert.equal(pure.truncateCardTitle("short goal", 30), "short goal");
  assert.equal(pure.truncateCardTitle("x".repeat(30), 30), "x".repeat(30));
  assert.equal(pure.truncateCardTitle("x".repeat(31), 30), `${"x".repeat(30)}…`);
  assert.equal(pure.truncateCardTitle("界".repeat(12), 10), `${"界".repeat(10)}…`);
  assert.equal(pure.truncateCardTitle("😀".repeat(12), 10), `${"😀".repeat(10)}…`, "a surrogate pair is never split");
});

test("durations always show seconds and never NaN or a negative", () => {
  assert.equal(pure.formatCardDuration(5), "5s");
  assert.equal(pure.formatCardDuration(185), "3m 05s");
  assert.equal(pure.formatCardDuration(7385), "2h 03m 05s");
  for (const bad of [Number.NaN, -3, Infinity]) assert.equal(pure.formatCardDuration(bad), "0s");
});

test("a running card's label suffix is whole minutes, never hours", () => {
  const start = "2026-10-30T01:00:00.000Z";
  const minute = 60_000;
  assert.equal(pure.cardRunningMinutes(start, Date.parse(start) + 59_999), 0, "under a minute is 0m");
  assert.equal(pure.cardRunningMinutes(start, Date.parse(start) + minute), 1);
  assert.equal(pure.cardRunningMinutes(start, Date.parse(start) + 23 * minute + 59_999), 23);
  assert.equal(pure.cardRunningMinutes(start, Date.parse(start) + 125 * minute), 125, "an hour or more stays in minutes");
  assert.equal(pure.cardRunningMinutes(start, Date.parse(start) - 5 * minute), 0, "clock skew clamps to 0m");
  assert.equal(pure.cardRunningMinutes(undefined, Date.parse(start)), null, "no startedAt → the bare label");
  assert.equal(pure.cardRunningMinutes("not-a-date", Date.parse(start)), null, "unparsable startedAt → the bare label");
});

test("progress merge: reset replaces, ids dedupe replays, the newest 200 are kept, unavailable holds none", () => {
  const first = pure.mergeCardProgress([], { available: true, reset: true, entries: [entry("a"), entry("b")] });
  assert.deepEqual(first.map((e) => e.id), ["a", "b"]);
  const replay = pure.mergeCardProgress(first, { available: true, entries: [entry("a"), entry("b")] });
  assert.equal(replay, first, "a replayed response changes nothing");
  const more = pure.mergeCardProgress(first, { available: true, entries: [entry("b"), entry("c")] });
  assert.deepEqual(more.map((e) => e.id), ["a", "b", "c"]);
  const reset = pure.mergeCardProgress(more, { available: true, reset: true, entries: [entry("z")] });
  assert.deepEqual(reset.map((e) => e.id), ["z"]);
  let held = [];
  for (let i = 0; i < 12; i++) {
    held = pure.mergeCardProgress(held, { available: true, entries: Array.from({ length: 20 }, (_, j) => entry(`e${i * 20 + j}`)) });
  }
  assert.equal(held.length, 200);
  assert.equal(held[0].id, "e40", "the oldest are evicted");
  assert.equal(held.at(-1).id, "e239");
  assert.deepEqual(pure.mergeCardProgress(held, { available: false, entries: [] }), []);
});

test("snapshot: a failed or degraded tick keeps the last cards; a successful empty list clears them", () => {
  const previous = pure.nextCardSnapshot(null, { cards: [card("wi_A", { available: true, reset: true, entries: [entry("a")], cursor: "c1.0123456789abcdef.1" })] });
  assert.equal(previous.length, 1);
  assert.equal(pure.nextCardSnapshot(previous, null), previous);
  assert.equal(pure.nextCardSnapshot(previous, { pfPresent: true, cards: null, error: "down" }), previous);
  assert.equal(pure.nextCardSnapshot(previous, { pfPresent: true }), previous);
  assert.deepEqual(pure.nextCardSnapshot(previous, { pfPresent: true, cards: [] }), []);
  const next = pure.nextCardSnapshot(previous, { cards: [card("wi_A", { available: true, entries: [entry("b")], cursor: "c1.0123456789abcdef.2" })] });
  assert.deepEqual(next[0].progress.entries.map((e) => e.id), ["a", "b"], "progress merges into what the card held");
  assert.deepEqual(pure.cardCursors(next), { wi_A: "c1.0123456789abcdef.2" });
  assert.deepEqual(pure.cardCursors(null), {});
});

// ---- the job detail's short title ----

test("the current-step tail API is retired with its only callers", () => {
  for (const name of ["nextProgressTail", "PROGRESS_MAX_ENTRIES", "PROGRESS_MAX_BYTES"]) assert.equal(name in pure, false, name);
});

test("the short title is the goal's first clause without a conventional-commit prefix", () => {
  assert.equal(pure.shortJobTitle("feat: pi-web 作业卡片详情区重构——自上而下三段、无嵌套滚动与实时进度"), "pi-web 作业卡片详情区重构", "the ticket's own example");
  assert.equal(pure.shortJobTitle("fix: plain whole goal without a clause boundary"), "plain whole goal without a clause boundary", "no boundary keeps the whole clause");
  assert.equal(pure.shortJobTitle("fix(ui)!: tidy the dock — then the rest"), "tidy the dock");
  assert.equal(pure.shortJobTitle("chore(deps): bump：next"), "bump");
  assert.equal(pure.shortJobTitle("重做配置页。其余不变"), "重做配置页");
  assert.equal(pure.shortJobTitle("first line\nsecond line"), "first line");
  assert.equal(pure.shortJobTitle("  no prefix here  "), "no prefix here");
  for (const none of [undefined, null, "", "   ", "feat:", "feat: ——rest", 42]) {
    assert.equal(pure.shortJobTitle(none), undefined, `no invented title for ${JSON.stringify(none)}`);
  }
});

// ---- the whole-job progress line model ----

const MASK = (text) => text.replace(/token=\S+/g, "token=***");
const AT = "2026-11-01T10:00:05.000Z";
const CLOCK = (() => { const d = new Date(AT); const p = (n) => String(n).padStart(2, "0"); return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; })();
const compose = (kind, body = {}, extra = {}) => pure.composeProgressEventLine("e1", { at: AT, kind, body, ...extra }, MASK);

test("the whole-job stream has no line bound and no per-line length caps", () => {
  for (const name of ["PROGRESS_MAX_LINES", "PROGRESS_EVENT_MAX", "PROGRESS_TOOL_MAX"]) assert.equal(name in pure, false, name);
});

test("the progress clock is local HH:MM:SS, and an unreadable time never throws", () => {
  assert.equal(pure.formatProgressClock(AT), CLOCK);
  assert.match(pure.formatProgressClock(Date.parse(AT)), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(pure.formatProgressClock("not-a-time"), "--:--:--");
});

test("each retained lifecycle kind is one glyph line with its ruled tone and the raw kind", () => {
  const cases = [
    ["step_started", { step: "grill", spawn_n: 1, model: "pi:e2e/model" }, {}, `${CLOCK} ▶ grill #1 · pi:e2e/model`, "accent"],
    ["step_done", { step: "grill", spawn_n: 1 }, { durationSec: 15 }, `${CLOCK} ■ grill +15s`, "dim"],
    ["step_done", { step: "spec" }, { durationSec: 185 }, `${CLOCK} ■ spec +3m 05s`, "dim"],
    ["step_done", { step: "spec" }, {}, `${CLOCK} ■ spec`, "dim"],
    ["step_failed", { step: "spec", cause: "gate-failed" }, {}, `${CLOCK} ✕ spec · gate-failed`, "red"],
    ["step_dead", { step: "plan", cause: "timeout-after-3-retries" }, {}, `${CLOCK} ✕ plan · timeout-after-3-retries`, "red"],
    ["needs_input", { step: "grill", question: "SECRET-QUESTION" }, {}, `${CLOCK} ? grill`, "amber"],
    ["answered", { step: "grill", answered_by: "SECRET-WHO" }, {}, `${CLOCK} ✓ grill`, undefined],
    ["gate_verdict", { step: "review", files: ["SECRET-FILE"] }, {}, `${CLOCK} ◆ review`, undefined],
    ["rewind", { gate: "spec-review", target: "spec", reason: "SECRET-REASON" }, {}, `${CLOCK} ↺ spec-review → spec`, undefined],
    ["terminal", { status: "completed" }, {}, `${CLOCK} ⏹ completed`, "green"],
    ["terminal", { status: "failed" }, {}, `${CLOCK} ⏹ failed`, "red"],
    ["terminal", { status: "cancelled" }, {}, `${CLOCK} ⏹ cancelled`, undefined],
    ["job_stopped", { spawn_n: 2 }, {}, `${CLOCK} ⏸`, undefined],
    ["needs_recovery", { reason: "recovery reason", detail: "recovery token=SECRET-TOKEN" }, {}, `${CLOCK} ⚠ recovery reason · recovery token=***`, "red"],
    ["push_failed", { error: "push error\n token=SECRET-TOKEN", version: 7 }, {}, `${CLOCK} ⚠ push error token=***`, "red"],
  ];
  for (const [kind, body, extra, text, tone] of cases) {
    const line = compose(kind, body, extra);
    // owner 有意变更 every composed line also carries its event time `at` (epoch ms).
    assert.deepEqual(line, { id: "e1", kind: "event", text, ...(tone ? { tone } : {}), event: kind, at: Date.parse(AT) }, kind);
    assert.ok(!JSON.stringify(line).includes("SECRET"), `${kind} leaks a non-whitelisted field`);
  }
});

test("the dropped kinds and every unknown kind produce no line", () => {
  for (const kind of ["published", "transcript_missing", "exec_init", "job_started", "candidate_switched",
    "envelope_rejected", "authored_tests_rebaselined", "future_kind", ""]) {
    assert.equal(compose(kind, { step: "x", detail: "E2E" }), null, kind);
  }
});

test("a composed event line is masked first and keeps its full length", () => {
  const line = compose("push_failed", { error: `token=${"S".repeat(50)} ${"界".repeat(900)}` });
  assert.ok(line.text.length > 900, `${line.text.length} code points kept`);
  assert.ok(line.text.startsWith(`${CLOCK} ⚠ token=*** 界`), line.text);
  assert.equal(Array.from(line.text).filter((c) => c === "界").length, 900, "no event cap");
  assert.equal(compose("step_started", { step: { nested: true }, model: 5 }).text, `${CLOCK} ▶ · 5`, "a non-string field reads as absent");
});

test("a composed line carries its event time only when the time is readable", () => {
  assert.equal(compose("step_started", { step: "code" }).at, Date.parse(AT));
  const unreadable = pure.composeProgressEventLine("e2", { at: "not-a-time", kind: "step_started", body: { step: "code" } }, MASK);
  assert.equal("at" in unreadable, false, "no invented time");
  assert.equal(unreadable.text, "--:--:-- ▶ code");
});

test("the snapshot merge keeps a line's at and light tool fields, and refuses malformed ones", () => {
  const tool = { id: "t", kind: "tool", text: "bash: ls", tool: { name: "bash", argument: "ls", status: "ok", durationMs: 1000 } };
  const running = { id: "r", kind: "tool", text: "read", tool: { name: "read", status: "running" } };
  const started = { id: "e.0", kind: "event", text: "00:00:01 ▶ code", event: "step_started", tone: "accent", at: 1_000 };
  const body = { available: true, lines: [started, tool, running], omitted: 0 };
  assert.deepEqual(pure.nextProgressSnapshot(null, body), body, "at and the four tool fields survive");
  const extra = pure.nextProgressSnapshot(null, { available: true, lines: [{ ...tool, tool: { ...tool.tool, input: "FULL", output: "FULL" } }], omitted: 0 });
  assert.deepEqual(extra.lines[0].tool, tool.tool, "only the four light tool fields are kept: no input or output rides the snapshot");
  const held = pure.nextProgressSnapshot(null, body);
  for (const bad of [
    { ...tool, tool: { name: "bash", status: "done" } },
    { ...tool, tool: { name: 5, status: "ok" } },
    { ...tool, tool: { name: "bash", status: "ok", durationMs: -1 } },
    { ...tool, tool: { name: "bash", status: "ok", argument: 3 } },
    { ...tool, tool: "bash" },
    { ...tool, at: 5 },
    { id: "n", kind: "narration", text: "n", tool: tool.tool },
    { id: "n", kind: "narration", text: "n", at: 5 },
    { ...started, at: "soon" },
    { ...started, tool: tool.tool },
  ]) {
    assert.equal(pure.nextProgressSnapshot(held, { available: true, lines: [bad], omitted: 0 }), held, `malformed line refused: ${JSON.stringify(bad)}`);
  }
});

test("the snapshot merge keeps the last good snapshot on a failed or degraded read and replaces it on a usable one", () => {
  const narration = (id, text = id) => ({ id, kind: "narration", text });
  const event = (id, text, kind, tone) => ({ id, kind: "event", text, event: kind, ...(tone ? { tone } : {}) });
  const thinking = (id, text = id) => ({ id, kind: "narration", text, variant: "thinking" });
  const first = pure.nextProgressSnapshot(null, { available: true, lines: [narration("a"), thinking("t", "THINK"), { id: "b", kind: "tool", text: "bash: ls" }, event("c", "00:00:01 ▶ x", "step_started", "accent")], omitted: 0 });
  assert.deepEqual(first, { available: true, lines: [narration("a"), thinking("t", "THINK"), { id: "b", kind: "tool", text: "bash: ls" }, event("c", "00:00:01 ▶ x", "step_started", "accent")], omitted: 0 });
  for (const failed of [null, undefined, "x", {}, { error: "boom" }, { available: true }, { available: true, lines: [] },
    { available: true, lines: [], omitted: -1 }, { available: true, lines: [], omitted: 1.5 },
    { available: true, lines: [{ id: "x", kind: "thinking", text: "t" }], omitted: 0 },
    { available: true, lines: [{ id: "x", kind: "event", text: "t", tone: "purple" }], omitted: 0 },
    { available: true, lines: [{ id: "x", kind: "narration", text: "t", tone: "red" }], omitted: 0 },
    { available: true, lines: [{ id: "x", kind: "narration", text: "t", variant: "secret" }], omitted: 0 },
    { available: true, lines: [{ id: "x", kind: "tool", text: "t", variant: "thinking" }], omitted: 0 },
    { available: true, entries: [narration("a")] }]) {
    assert.equal(pure.nextProgressSnapshot(first, failed), first, `a failed read keeps the snapshot: ${JSON.stringify(failed)}`);
  }
  assert.equal(pure.nextProgressSnapshot(first, { available: false, lines: [], omitted: 0 }), first, "a degraded read keeps the snapshot");
  assert.deepEqual(pure.nextProgressSnapshot(null, { available: false, lines: [], omitted: 0 }), { available: false, lines: [], omitted: 0 }, "nothing held: the unavailable state");
  assert.equal(pure.nextProgressSnapshot(null, null), null, "nothing held and a failed read: still nothing");
  const unavailable = pure.nextProgressSnapshot(null, { available: false, lines: [], omitted: 0 });
  assert.deepEqual(pure.nextProgressSnapshot(unavailable, { available: true, lines: [narration("z")], omitted: 3 }), { available: true, lines: [narration("z")], omitted: 3 }, "a later good read replaces the unavailable state");
  assert.deepEqual(pure.nextProgressSnapshot(first, { available: true, lines: [], omitted: 0 }), { available: true, lines: [], omitted: 0 }, "an empty usable snapshot clears it");
  const many = pure.nextProgressSnapshot(null, { available: true, lines: Array.from({ length: 2010 }, (_, i) => narration(`m${i}`)), omitted: 4 });
  assert.equal(many.lines.length, 2010, "every line is kept ( removed the 2000-line window)");
  assert.equal(many.lines[0].id, "m0");
  assert.equal(many.omitted, 4, "the server's omitted count is carried as sent");
  const extra = pure.nextProgressSnapshot(null, { available: true, lines: [{ ...narration("q"), path: "/etc/passwd" }], omitted: 0 });
  assert.deepEqual(extra.lines, [narration("q")], "only the wire fields are kept");
});

test("the event-log answer after the drop keeps the held narration and tool lines and appends the new event lines", () => {
  const narration = (id, text = id) => ({ id, kind: "narration", text });
  const tool = (id, text) => ({ id, kind: "tool", text });
  const event = (id, text, kind, tone) => ({ id, kind: "event", text, event: kind, ...(tone ? { tone } : {}) });
  const started = event("e.0", "00:00:01 ▶ code", "step_started", "accent");
  const done = event("e.90", "00:00:20 ✓ code", "step_done");
  const terminal = event("e.180", "00:00:30 ⏹ completed", "terminal", "green");
  const held = { available: true, lines: [started, narration("n1"), tool("t1", "bash: curl --token=***"), done], omitted: 5 };
  const merged = pure.nextProgressSnapshot(held, { available: true, lines: [started, done, terminal], omitted: 0 });
  assert.deepEqual(merged, { available: true, lines: [started, narration("n1"), tool("t1", "bash: curl --token=***"), done, terminal], omitted: 5 },
    "the held stream stays and only the event line after the newest shared one is appended");
  assert.equal(pure.nextProgressSnapshot(merged, { available: true, lines: [started, done, terminal], omitted: 0 }), merged, "nothing new keeps the held snapshot itself");
  assert.deepEqual(pure.nextProgressSnapshot(null, { available: true, lines: [started, done, terminal], omitted: 0 }), { available: true, lines: [started, done, terminal], omitted: 0 },
    "a job selected after the drop (nothing held) shows the event-log stream");
  assert.deepEqual(pure.nextProgressSnapshot({ available: true, lines: [started, done], omitted: 0 }, { available: true, lines: [started, done, terminal], omitted: 0 }), { available: true, lines: [started, done, terminal], omitted: 0 },
    "a held stream of event lines only is replaced as before");
  const full = { available: true, lines: [...Array.from({ length: 1999 }, (_, i) => narration(`m${i}`)), done], omitted: 2 };
  const grown = pure.nextProgressSnapshot(full, { available: true, lines: [done, terminal, event("e.200", "00:00:31 ⏸", "job_stopped")], omitted: 0 });
  assert.equal(grown.lines.length, 2002, "no line bound: the held stream plus the appended event lines");
  assert.equal(grown.lines[0].id, "m0");
  assert.deepEqual(grown.lines.slice(-2).map((line) => line.id), ["e.180", "e.200"]);
  assert.equal(grown.omitted, 2, "the held exact omitted count is carried");
});

test("spawn blocks cut at every step_started in stream order, leading lines stay unfolded, and the counts add up", () => {
  const narration = (id, text = id) => ({ id, kind: "narration", text });
  const event = (id, text, kind) => ({ id, kind: "event", text, event: kind });
  const start = (id, text) => event(id, text, "step_started");
  const lines = [
    narration("lead", "before the first spawn"),
    start("s1", "00:00:01 ▶ grill #1 · pi:e2e/model"),
    narration("n1", "grill narration"),
    event("d1", "00:00:02 ■ grill +15s", "step_done"),
    start("s2", "00:00:20 ▶ spec #1 · pi:e2e/model"),
    narration("n2", "spec narration"),
    event("f2", "00:00:30 ✕ spec · gate-failed", "step_failed"),
    start("s3", "00:00:40 ▶ spec #2 · claude:e2e-model"),
    event("i3", "00:00:50 ? spec", "needs_input"),
  ];
  const layout = pure.progressBlocks(lines);
  assert.equal(layout.leading, 1, "only the lines before the first start are leading");
  assert.deepEqual(layout.blocks.map((block) => [block.start, block.count, block.step, block.spawn, block.status]), [
    [1, 3, "grill", "1", "done"],
    [4, 3, "spec", "1", "failed"],
    [7, 2, "spec", "2", "needs_input"],
  ], "each rerun is its own block and its status comes from its own lifecycle lines");
  assert.equal(layout.leading + layout.blocks.reduce((sum, block) => sum + block.count, 0), lines.length, "leading plus every count is the stream length");
  assert.deepEqual(pure.progressBlocks([narration("a"), narration("b")]), { leading: 2, blocks: [] }, "no start line: every line leading, nothing folded");
  const one = pure.progressBlocks([start("s", "00:00:01 ▶ code"), narration("n"), event("d", "00:00:02 ■ code", "step_done")]);
  assert.deepEqual(one.blocks.map((block) => [block.step, block.spawn, block.status]), [["code", undefined, "done"]], "a start line without a spawn number is still one block");
});

test("each block names its absorbed terminal line and its times; a missing time is never invented", () => {
  const narration = (id) => ({ id, kind: "narration", text: id });
  const event = (id, kind, at) => ({ id, kind: "event", text: `${id} ${kind}`, event: kind, ...(at !== undefined ? { at } : {}) });
  const lines = [
    narration("lead"),
    event("s1", "step_started", 1_000), narration("n1"), event("d1", "step_done", 16_000),
    event("s2", "step_started", 20_000), event("f2", "step_failed", 25_000), event("x2", "step_dead", 27_000),
    event("s3", "step_started"), narration("n3"), event("d3", "step_done", 40_000),
    event("s4", "step_started", 50_000), event("i4", "needs_input", 51_000),
  ];
  const layout = pure.progressBlocks(lines);
  assert.deepEqual(layout.blocks.map(({ start, count, status, terminal, startAt, endAt, durationMs }) => ({ start, count, status, terminal, startAt, endAt, durationMs })), [
    { start: 1, count: 3, status: "done", terminal: 3, startAt: 1_000, endAt: 16_000, durationMs: 15_000 },
    { start: 4, count: 3, status: "failed", terminal: 6, startAt: 20_000, endAt: 27_000, durationMs: 7_000 },
    { start: 7, count: 3, status: "done", terminal: 9, startAt: undefined, endAt: 40_000, durationMs: undefined },
    { start: 10, count: 2, status: "needs_input", terminal: undefined, startAt: 50_000, endAt: undefined, durationMs: undefined },
  ], "the last terminal line is absorbed; a start without a time has no duration; an open block has none here");
  assert.equal(layout.leading + layout.blocks.reduce((sum, block) => sum + block.count, 0), lines.length, "counts still add up to the stream length");
  const reversed = pure.progressBlocks([event("s", "step_started", 9_000), event("d", "step_done", 1_000)]);
  assert.equal(reversed.blocks[0].durationMs, undefined, "an end before the start is no duration");
});

test("an unmarked block is running only while newest, and needs_input counts only as the last lifecycle line", () => {
  const start = (id, step) => ({ id, kind: "event", text: `00:00:01 ▶ ${step} #1 · pi:m`, event: "step_started" });
  const event = (id, kind) => ({ id, kind: "event", text: `00:00:02 ${kind}`, event: kind });
  const oldAndNew = pure.progressBlocks([start("s1", "a"), event("d1", "step_done"), start("s2", "b")]);
  assert.deepEqual(oldAndNew.blocks.map((block) => block.status), ["done", "running"], "the newest unmarked block is running");
  const older = pure.progressBlocks([start("s1", "a"), start("s2", "b"), event("x2", "step_done")]);
  assert.deepEqual(older.blocks.map((block) => block.status), ["none", "done"], "an older unmarked block carries no mark");
  const answered = pure.progressBlocks([start("s1", "a"), event("i1", "needs_input"), event("a1", "answered")]);
  assert.equal(answered.blocks[0].status, "running", "a needs_input followed by another lifecycle line is no longer the last one");
  const stopped = pure.progressBlocks([start("s1", "a"), event("j1", "job_stopped")]);
  assert.equal(stopped.blocks[0].status, "stopped", "job_stopped marks the block paused");
  const input = pure.progressBlocks([start("s1", "a"), event("i1", "needs_input")]);
  assert.equal(input.blocks[0].status, "needs_input", "a last needs_input marks the block");
});

test("the progress follow counts a region as pinned within 8 px of its bottom; unreadable numbers never pin", () => {
  const at = (scrollTop, scrollHeight = 1000, clientHeight = 400) => pure.isProgressPinnedToBottom({ scrollTop, scrollHeight, clientHeight });
  assert.equal(pure.PROGRESS_PIN_THRESHOLD_PX, 8);
  assert.equal(at(600), true, "at the bottom");
  assert.equal(at(593), true, "7 px away");
  assert.equal(at(592), true, "8 px away");
  assert.equal(at(591), false, "9 px away");
  assert.equal(at(0), false, "at the top of a long region");
  assert.equal(at(0, 300, 400), true, "content shorter than the viewport");
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.equal(pure.isProgressPinnedToBottom({ scrollTop: bad, scrollHeight: 1000, clientHeight: 400 }), false, String(bad));
    assert.equal(pure.isProgressPinnedToBottom({ scrollTop: 0, scrollHeight: bad, clientHeight: 400 }), false, String(bad));
  }
});
