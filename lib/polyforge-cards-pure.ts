import type { PolyforgeJob } from "./polyforge-status";

/**
 * Client-safe model of the Polyforge Jobs-tab card stream:
 * the wire types `GET /api/polyforge/cards` answers with, its bounds, the
 * opaque progress cursor, title truncation, step-duration text and the two
 * client merges (progress entries, last-good snapshot); plus the job
 * detail's short title and its whole-job execution-progress
 * line model, lifecycle-line composer and snapshot merge. No Node import may
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

/** A running job's card-label suffix: the job's age in whole
 *  minutes since its earliest `job_started` —
 *  floor((now − startedAt) / 60s), never hours (`125m`). `0m` under a minute
 *  and for a negative age (clock skew); a missing or unparsable `startedAt`
 *  yields null, so the caller shows the bare status label. */
export function cardRunningMinutes(startedAt: string | undefined, now: number): number | null {
  if (!startedAt) return null;
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return null;
  return Math.max(0, Math.floor((now - startedMs) / 60_000));
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

/** A conventional-commit `type(scope)!:` prefix (`feat:`, `fix(ui)!:`). */
const COMMIT_PREFIX = /^[A-Za-z]+(?:\([^)\n]*\))?!?:\s*/;
/** The first clause boundary: `——`, ` — `, `：`, `:`, `。` or a newline. */
const CLAUSE_BOUNDARY = /——| — |：|:|。|\n/;

/** The job detail's short title: a pure first-clause
 *  heuristic over the goal — strip a conventional-commit prefix, cut at the
 *  first clause boundary, trim. No model, no server title; the one-line fit
 *  is CSS ellipsis. Undefined when nothing readable remains (the title row
 *  then shows the slug alone, never an invented title). */
export function shortJobTitle(goal: string | null | undefined): string | undefined {
  if (typeof goal !== "string") return undefined;
  const body = goal.trim().replace(COMMIT_PREFIX, "");
  const cut = CLAUSE_BOUNDARY.exec(body);
  const title = (cut ? body.slice(0, cut.index) : body).trim();
  return title || undefined;
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

// ---- the whole-job execution progress ----

/** The newest stream lines one progress snapshot carries; `omitted` counts
 *  the earlier ones exactly. No byte cap: under the bound every line shows. */
export const PROGRESS_MAX_LINES = 2000;
/** A lifecycle line's cap, in code points after masking (narration's too). */
export const PROGRESS_EVENT_MAX = 400;

/** An event line's colour; absent = neutral (`var(--text-muted)`). */
export type PolyforgeProgressTone = "accent" | "dim" | "red" | "amber" | "green";

/** One line of the whole-job stream: assistant narration, one masked tool
 *  call (`<name>: <primary argument>`), or one server-composed lifecycle
 *  line (`event`, with its raw daemon kind in `event` for the hover title). */
export interface PolyforgeProgressLine {
  /** Unique within the snapshot; never a path. */
  id: string;
  kind: "narration" | "tool" | "event";
  text: string;
  /** Event lines only; absent = neutral. */
  tone?: PolyforgeProgressTone;
  /** Event lines only: the raw daemon kind. */
  event?: string;
}

/** `GET /api/polyforge/progress?wi=` — the whole job's stream, oldest first,
 *  bounded to the newest PROGRESS_MAX_LINES; a fresh snapshot each time. */
export interface PolyforgeProgressSnapshot {
  /** False: no job record/capsule, nothing readable, or the read failed. */
  available: boolean;
  lines: PolyforgeProgressLine[];
  /** The exact count of earlier lines left out by the bound. */
  omitted: number;
}

/** One daemon event as the composer sees it: its time, kind and raw body
 *  (only the whitelisted fields below are ever read from it), plus the
 *  `step_done` duration the server pairs from the same log. */
export interface PolyforgeProgressEventInput {
  at: string;
  kind: string;
  body: Record<string, unknown>;
  durationSec?: number;
}

/** `HH:MM:SS` in the reader's local time (the server's, for composed lines);
 *  `--:--:--` for an unreadable time. */
export function formatProgressClock(at: string | number): string {
  const date = new Date(typeof at === "number" ? at : Date.parse(at));
  if (!Number.isFinite(date.getTime())) return "--:--:--";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const PROGRESS_TONES = new Set<string>(["accent", "dim", "red", "amber", "green"]);

/** A whitelisted body field as one-line text; anything else reads as absent. */
function eventField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  return text || undefined;
}

/**
 * The one lifecycle line of a daemon event, composed
 * server-side as `<HH:MM:SS> <glyph> <fields…>` — glyphs, no per-kind words:
 *
 * | kind | line | tone |
 * |---|---|---|
 * | step_started | `▶ <step> #<spawn_n> · <model>` | accent |
 * | step_done | `■ <step> +<duration>` | dim |
 * | step_failed / step_dead | `✕ <step> · <cause>` | red |
 * | needs_input | `? <step>` | amber |
 * | answered / gate_verdict | `✓ <step>` / `◆ <step>` | neutral |
 * | rewind | `↺ <gate> → <target>` | neutral |
 * | terminal | `⏹ <status>` | green completed, red failed, else neutral |
 * | job_stopped | `⏸` | neutral |
 * | needs_recovery | `⚠ <reason> · <detail>` | red |
 * | push_failed | `⚠ <error>` | red |
 *
 * Every other kind — `published`, `transcript_missing`, `exec_init`,
 * `job_started`, `candidate_switched`, `envelope_rejected`,
 * `authored_tests_rebaselined` and any unknown kind — is dropped (`null`),
 * with no aggregate row. Only the fields named above are read (`step`,
 * `model`, `spawn_n`, `cause`, `gate`, `target`, `status`, `reason`,
 * `detail`, `error`); the composed text goes through `mask` (the server's
 * credential mask — this module stays Node-free) and is capped at
 * PROGRESS_EVENT_MAX code points. Pure.
 */
export function composeProgressEventLine(
  id: string,
  event: PolyforgeProgressEventInput,
  mask: (text: string) => string,
): PolyforgeProgressLine | null {
  const field = (key: string) => eventField(event.body, key);
  const join = (separator: string, ...parts: (string | undefined)[]) => parts.filter(Boolean).join(separator);
  const step = field("step");
  let body: string;
  let tone: PolyforgeProgressTone | undefined;
  switch (event.kind) {
    case "step_started": {
      const spawn = field("spawn_n");
      body = join(" · ", join(" ", "▶", step, spawn ? `#${spawn}` : undefined), field("model"));
      tone = "accent";
      break;
    }
    case "step_done": {
      const duration = typeof event.durationSec === "number" && Number.isFinite(event.durationSec) && event.durationSec >= 0
        ? `+${formatCardDuration(event.durationSec)}` : undefined;
      body = join(" ", "■", step, duration);
      tone = "dim";
      break;
    }
    case "step_failed":
    case "step_dead":
      body = join(" · ", join(" ", "✕", step), field("cause"));
      tone = "red";
      break;
    case "needs_input":
      body = join(" ", "?", step);
      tone = "amber";
      break;
    case "answered":
      body = join(" ", "✓", step);
      break;
    case "gate_verdict":
      body = join(" ", "◆", step);
      break;
    case "rewind": {
      const gate = field("gate");
      const target = field("target");
      body = join(" ", "↺", join(" → ", gate, target));
      break;
    }
    case "terminal": {
      const status = field("status");
      body = join(" ", "⏹", status);
      tone = status === "completed" ? "green" : status === "failed" ? "red" : undefined;
      break;
    }
    case "job_stopped":
      body = "⏸";
      break;
    case "needs_recovery":
      body = join(" · ", join(" ", "⚠", field("reason")), field("detail"));
      tone = "red";
      break;
    case "push_failed":
      body = join(" ", "⚠", field("error"));
      tone = "red";
      break;
    default:
      return null;
  }
  const text = capCodePoints(mask(`${formatProgressClock(event.at)} ${body}`), PROGRESS_EVENT_MAX);
  return { id, kind: "event", text, ...(tone ? { tone } : {}), event: event.kind };
}

function isProgressLine(value: unknown): value is PolyforgeProgressLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  if (typeof line.id !== "string" || typeof line.text !== "string") return false;
  if (line.kind === "narration" || line.kind === "tool") return line.tone === undefined && line.event === undefined;
  return line.kind === "event"
    && (line.tone === undefined || (typeof line.tone === "string" && PROGRESS_TONES.has(line.tone)))
    && (line.event === undefined || typeof line.event === "string");
}

/** The progress snapshot to render after a read (; the
 * last-good semantics). A failed request (`body` not a
 *  snapshot), a degraded body (`available: false`) or a malformed one keeps
 *  the previous snapshot — no flash, no error readout; a usable body
 *  replaces it wholesale, sliced to the newest PROGRESS_MAX_LINES (the
 *  slice adds to `omitted`), each line reduced to its wire fields. With
 *  nothing held yet, a degraded body is the unavailable state. Pure. */
export function nextProgressSnapshot(
  previous: PolyforgeProgressSnapshot | null,
  body: unknown,
): PolyforgeProgressSnapshot | null {
  if (!body || typeof body !== "object") return previous;
  const snapshot = body as Record<string, unknown>;
  if (typeof snapshot.available !== "boolean" || !Array.isArray(snapshot.lines)) return previous;
  if (!snapshot.available) return previous ?? { available: false, lines: [], omitted: 0 };
  const omitted = snapshot.omitted;
  if (typeof omitted !== "number" || !Number.isSafeInteger(omitted) || omitted < 0) return previous;
  if (!snapshot.lines.every(isProgressLine)) return previous;
  const all = snapshot.lines as PolyforgeProgressLine[];
  const kept = all.slice(-PROGRESS_MAX_LINES);
  const lines = kept.map(({ id, kind, text, tone, event }) => ({
    id, kind, text, ...(tone ? { tone } : {}), ...(event ? { event } : {}),
  }));
  return { available: true, lines, omitted: omitted + (all.length - kept.length) };
}

/** How close (px) to the bottom of the detail's scroll region still counts
 *  as "at the bottom" for the progress follow. */
export const PROGRESS_PIN_THRESHOLD_PX = 8;

/** Whether a scroll region is at its bottom (within
 *  PROGRESS_PIN_THRESHOLD_PX), so new progress lines should keep it there;
 *  content no taller than the viewport is at its bottom. Unreadable numbers
 *  read as not pinned: the follow then never moves the reader. Pure. */
export function isProgressPinnedToBottom(region: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  const { scrollTop, scrollHeight, clientHeight } = region;
  if (![scrollTop, scrollHeight, clientHeight].every(Number.isFinite)) return false;
  return scrollHeight - clientHeight - scrollTop <= PROGRESS_PIN_THRESHOLD_PX;
}

/** The cursor map the next request sends (wi → cursor). */
export function cardCursors(cards: PolyforgeCard[] | null): Record<string, string> {
  const cursors: Record<string, string> = {};
  for (const card of cards ?? []) {
    if (isPolyforgeWorkItemId(card.job.wi) && card.progress.cursor) cursors[card.job.wi] = card.progress.cursor;
  }
  return cursors;
}
