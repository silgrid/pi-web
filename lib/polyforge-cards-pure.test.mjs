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

// ---- the job detail's short title and progress tail ----

test("the progress bounds are the documented ones", () => {
  assert.equal(pure.PROGRESS_MAX_ENTRIES, 50);
  assert.equal(pure.PROGRESS_MAX_BYTES, 32 * 1024);
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

test("the progress tail keeps the last good tail on a failed or degraded read and replaces it on a usable one", () => {
  const tool = (id, text) => ({ id, kind: "tool", text });
  const narration = (id, text = id) => ({ id, kind: "narration", text });
  const first = pure.nextProgressTail(null, { available: true, entries: [narration("a"), tool("b", "bash: ls")] });
  assert.deepEqual(first, { available: true, entries: [narration("a"), tool("b", "bash: ls")] });
  for (const failed of [null, undefined, "x", {}, { error: "boom" }, { available: true }, { available: true, entries: [{ id: "x", kind: "thinking", text: "t" }] }]) {
    assert.equal(pure.nextProgressTail(first, failed), first, `a failed read keeps the tail: ${JSON.stringify(failed)}`);
  }
  assert.equal(pure.nextProgressTail(first, { available: false, entries: [] }), first, "a degraded read keeps the tail");
  assert.deepEqual(pure.nextProgressTail(null, { available: false, entries: [] }), { available: false, entries: [] }, "nothing held: the unavailable state");
  assert.equal(pure.nextProgressTail(null, null), null, "nothing held and a failed read: still nothing");
  const next = pure.nextProgressTail(first, { available: true, entries: [narration("z")] });
  assert.deepEqual(next.entries.map((e) => e.id), ["z"], "a new step's tail replaces the old one, never spliced");
  assert.deepEqual(pure.nextProgressTail(first, { available: true, entries: [] }), { available: true, entries: [] }, "an empty usable tail clears it");
  const many = pure.nextProgressTail(null, { available: true, entries: Array.from({ length: 60 }, (_, i) => narration(`m${i}`)) });
  assert.equal(many.entries.length, 50, "at most the newest 50 are kept");
  assert.equal(many.entries[0].id, "m10");
  const extra = pure.nextProgressTail(null, { available: true, entries: [{ ...narration("q"), path: "/etc/passwd" }] });
  assert.deepEqual(extra.entries, [narration("q")], "only the three wire fields are kept");
});
