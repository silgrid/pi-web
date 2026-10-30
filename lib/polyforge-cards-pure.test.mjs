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
