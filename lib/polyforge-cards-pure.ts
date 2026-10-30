import type { PolyforgeJob } from "./polyforge-status";

/**
 * Client-safe model of the Polyforge Jobs-tab card stream:
 * the wire types `GET /api/polyforge/cards` answers with, its bounds, the
 * opaque progress cursor, title truncation, step-duration text and the two
 * client merges (progress entries, last-good snapshot). No Node import may
 * enter this file: the panel and the hook load it in the browser.
 */

/** Per progress entry: the assistant's narration text, masked. */
export const CARD_ENTRY_MAX = 400;
/** First load (no/invalid/stale cursor): the newest complete entries. */
export const CARD_FIRST_PAGE = 20;
/** A later poll: at most this many new entries per card. */
export const CARD_POLL_PAGE = 20;
/** Per response, across every card. */
export const CARD_RESPONSE_MAX_ENTRIES = 200;
export const CARD_RESPONSE_MAX_BYTES = 128 * 1024;
/** Entries the client keeps per card (oldest evicted). */
export const CARD_CLIENT_MAX_ENTRIES = 200;
/** Cards a request may carry cursors for. */
export const CARD_CURSORS_MAX = 200;

/** `c1.<16 hex transcript identity>.<byte offset>` — opaque, never a path. */
const CURSOR_PATTERN = /^c1\.([0-9a-f]{16})\.(\d{1,15})$/;
/** The daemon's work-item id shape; the only key a cursor map may carry. */
const WI_ID_PATTERN = /^wi_[A-Za-z0-9]{1,64}$/;

export function isPolyforgeWorkItemId(value: unknown): value is string {
  return typeof value === "string" && WI_ID_PATTERN.test(value);
}

export function isPolyforgeCardCursor(value: unknown): value is string {
  return typeof value === "string" && CURSOR_PATTERN.test(value);
}

export function formatCardCursor(identity: string, offset: number): string {
  return `c1.${identity}.${offset}`;
}

export function parseCardCursor(value: unknown): { identity: string; offset: number } | null {
  if (typeof value !== "string") return null;
  const match = CURSOR_PATTERN.exec(value);
  if (!match) return null;
  const offset = Number(match[2]);
  return Number.isSafeInteger(offset) ? { identity: match[1], offset } : null;
}

/** The `cursors` query (a JSON map wi → cursor). Anything malformed — bad
 *  JSON, a non-object, a key that is not a wi id, a value that is not a
 *  cursor — is dropped, so it reads as "no cursor" (a first load). */
export function parseCardCursors(raw: string | null): Map<string, string> {
  const cursors = new Map<string, string>();
  if (!raw || raw.length > CARD_CURSORS_MAX * 128) return cursors;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return cursors;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return cursors;
  for (const [wi, cursor] of Object.entries(value)) {
    if (cursors.size >= CARD_CURSORS_MAX) break;
    if (isPolyforgeWorkItemId(wi) && isPolyforgeCardCursor(cursor)) cursors.set(wi, cursor);
  }
  return cursors;
}

// ---- wire shapes ----

/** `timed`: `durationSec` summed over every run; `unstarted`: never ran ("—");
 *  `skipped`: the execution record says `skipped` and it never ran
 *  ("skipped"/"已跳过",); `unknown`: started, but no readable
 *  start time ("未知"). */
export type PolyforgeCardStepState = "timed" | "unstarted" | "skipped" | "unknown";

export interface PolyforgeCardStep {
  id: string;
  state: PolyforgeCardStepState;
  /** Present only for `timed`: a finite, non-negative whole second count. */
  durationSec?: number;
  /** Runs seen (`step_started` count); the card marks ×N when > 1. */
  runs: number;
}

/** One progress entry: assistant narration only. A tool
 *  call, its command/argument, a tool result, thinking or a prompt never
 *  becomes an entry. */
export interface PolyforgeCardEntry {
  /** Unique within its transcript; makes replays idempotent. */
  id: string;
  /** Assistant text, credential-masked (≤ CARD_ENTRY_MAX code points). */
  text: string;
}

export interface PolyforgeCardProgress {
  /** False: no readable/recognised transcript for the current step. */
  available: boolean;
  entries: PolyforgeCardEntry[];
  /** Absent when there is nothing to continue from. */
  cursor?: string;
  /** True: `entries` is a fresh newest page and replaces what the client holds. */
  reset?: boolean;
}

export interface PolyforgeCard {
  job: PolyforgeJob;
  /** The work item's goal; absent when its record is not readable. */
  goal?: string;
  /** Earliest `job_started`; absent sorts the card last. */
  startedAt?: string;
  /** One entry per declared step, in declaration order. */
  steps: PolyforgeCardStep[];
  /** `execution.json`'s `current_step`; absent when unreadable. */
  currentStep?: string;
  progress: PolyforgeCardProgress;
}

export interface PolyforgeCardsResponse {
  pfPresent?: boolean;
  /** Null on a degraded read (pf absent, daemon down): keep the last cards. */
  cards?: PolyforgeCard[] | null;
  error?: string;
}

/** React key and cursor key of a card. */
export function polyforgeCardKey(card: PolyforgeCard): string {
  return card.job.wi || card.job.slug;
}

// ---- ordering ----

/** Ascending earliest `job_started`, ties by wi id; a card with no readable
 *  start sorts after every known start, by wi id. Deterministic, so a poll
 *  and a full reload give the same order. Pure. */
export function sortPolyforgeCards(cards: PolyforgeCard[]): PolyforgeCard[] {
  const startMs = (card: PolyforgeCard) => {
    const ms = card.startedAt ? Date.parse(card.startedAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : null;
  };
  const byId = (a: PolyforgeCard, b: PolyforgeCard) => {
    const x = polyforgeCardKey(a);
    const y = polyforgeCardKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return [...cards].sort((a, b) => {
    const x = startMs(a);
    const y = startMs(b);
    if (x !== null && y !== null && x !== y) return x - y;
    if (x !== null && y === null) return -1;
    if (x === null && y !== null) return 1;
    return byId(a, b);
  });
}

// ---- display helpers ----

/** Truncate to `length` code points with a trailing `…`; a goal no longer
 *  than `length` is returned whole. */
export function truncateCardTitle(goal: string, length: number): string {
  const points = Array.from(goal);
  if (points.length <= length) return goal;
  return `${points.slice(0, Math.max(0, length)).join("")}…`;
}

/** Truncate to `max` code points (no ellipsis; the server-side entry cap). */
export function capCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join("");
}

/** Whole seconds → `45s`, `3m 05s`, `2h 03m 05s`. Seconds are always shown,
 *  so a running step visibly grows between polls. Never NaN/negative: an
 *  invalid value reads as `0s`. */
export function formatCardDuration(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

// ---- client merges ----

/** Merge one response's progress into the entries a card holds: `reset`
 *  replaces, otherwise new ids append (a replayed response adds nothing);
 *  at most CARD_CLIENT_MAX_ENTRIES newest are kept. An unavailable
 *  transcript holds no entries. Pure. */
export function mergeCardProgress(
  previous: PolyforgeCardEntry[],
  progress: PolyforgeCardProgress,
): PolyforgeCardEntry[] {
  if (!progress.available) return [];
  const base = progress.reset ? [] : previous;
  const seen = new Set(base.map((entry) => entry.id));
  const merged = [...base];
  for (const entry of progress.entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  if (!progress.reset && merged.length === previous.length) return previous;
  return merged.length > CARD_CLIENT_MAX_ENTRIES ? merged.slice(-CARD_CLIENT_MAX_ENTRIES) : merged;
}

/** The cards to render after a poll. A failed request (`body` null) or a
 *  degraded body (`cards` not an array) keeps the previous cards, order and
 *  lines; a successful body replaces them (an empty list clears them, since
 *  the daemon says the jobs are gone), merging each card's progress into
 *  what that card already held. Pure. */
export function nextCardSnapshot(
  previous: PolyforgeCard[] | null,
  body: PolyforgeCardsResponse | null,
): PolyforgeCard[] | null {
  if (!body || !Array.isArray(body.cards)) return previous;
  const held = new Map((previous ?? []).map((card) => [polyforgeCardKey(card), card]));
  return body.cards.map((card) => {
    const before = held.get(polyforgeCardKey(card));
    const entries = mergeCardProgress(before?.progress.entries ?? [], card.progress);
    return { ...card, progress: { ...card.progress, entries, reset: undefined } };
  });
}

/** The cursor map the next request sends (wi → cursor). */
export function cardCursors(cards: PolyforgeCard[] | null): Record<string, string> {
  const cursors: Record<string, string> = {};
  for (const card of cards ?? []) {
    if (isPolyforgeWorkItemId(card.job.wi) && card.progress.cursor) cursors[card.job.wi] = card.progress.cursor;
  }
  return cursors;
}
