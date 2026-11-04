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

/** An event line's colour; absent = neutral (`var(--text-muted)`). */
export type PolyforgeProgressTone = "accent" | "dim" | "red" | "amber" | "green";

/** A tool call's state in the progress poll: `error` when
 *  its paired result says so, `running` while no result is paired, else `ok`. */
export type PolyforgeProgressToolStatus = "ok" | "error" | "running";

/** The light tool fields a tool line carries in the 2 s poll:
 *  never the call's full input or output — those are read on demand from
 *  `GET /api/polyforge/progress/tool`. */
export interface PolyforgeProgressTool {
  name: string;
  /** The masked primary argument, in full (the card header ellipsizes it). */
  argument?: string;
  status: PolyforgeProgressToolStatus;
  /** Result time − call time, only when both timestamps exist. */
  durationMs?: number;
}

/** One line of the whole-job stream: assistant narration, one masked tool
 *  call (`<name>: <primary argument>`), or one server-composed lifecycle
 *  line (`event`, with its raw daemon kind in `event` for the hover title). */
export interface PolyforgeProgressLine {
  /** Unique within the snapshot; never a path. */
  id: string;
  kind: "narration" | "tool" | "event";
  text: string;
  /** Narration only: `thinking` when the line projects a pi/claude
   *  `thinking` block (rendered dim italic), absent for assistant `text`. */
  variant?: "thinking";
  /** Event lines only; absent = neutral. */
  tone?: PolyforgeProgressTone;
  /** Event lines only: the raw daemon kind. */
  event?: string;
  /** Event lines only: the event's time (epoch ms) when readable, for the
   *  spawn block head's duration. */
  at?: number;
  /** Tool lines only: the light tool fields. */
  tool?: PolyforgeProgressTool;
}

/** `GET /api/polyforge/progress?wi=` — the whole job's stream, oldest first,
 *  complete (no line bound); a fresh snapshot each time. */
export interface PolyforgeProgressSnapshot {
  /** False: nothing readable (no spawn journal and no event log), or the
   *  read failed. */
  available: boolean;
  lines: PolyforgeProgressLine[];
  /** Legacy field: the exact count of earlier lines left out. The server
   *  returns every line since, so it stays 0. */
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
 * credential mask — this module stays Node-free) without a length cap
 * ( removed the per-line caps). Pure.
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
  const text = mask(`${formatProgressClock(event.at)} ${body}`);
  const at = Date.parse(event.at);
  return { id, kind: "event", text, ...(tone ? { tone } : {}), event: event.kind, ...(Number.isFinite(at) ? { at } : {}) };
}

const PROGRESS_TOOL_STATUSES = new Set<string>(["ok", "error", "running"]);

const isDuration = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function isProgressTool(value: unknown): value is PolyforgeProgressTool {
  if (!value || typeof value !== "object") return false;
  const tool = value as Record<string, unknown>;
  return typeof tool.name === "string"
    && (tool.argument === undefined || typeof tool.argument === "string")
    && typeof tool.status === "string" && PROGRESS_TOOL_STATUSES.has(tool.status)
    && (tool.durationMs === undefined || isDuration(tool.durationMs));
}

function isProgressLine(value: unknown): value is PolyforgeProgressLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  if (typeof line.id !== "string" || typeof line.text !== "string") return false;
  if (line.kind === "narration") {
    return line.tone === undefined && line.event === undefined && line.at === undefined && line.tool === undefined
      && (line.variant === undefined || line.variant === "thinking");
  }
  if (line.kind === "tool") {
    return line.tone === undefined && line.event === undefined && line.variant === undefined && line.at === undefined
      && (line.tool === undefined || isProgressTool(line.tool));
  }
  return line.kind === "event"
    && (line.tone === undefined || (typeof line.tone === "string" && PROGRESS_TONES.has(line.tone)))
    && (line.event === undefined || typeof line.event === "string")
    && (line.at === undefined || (typeof line.at === "number" && Number.isFinite(line.at)))
    && line.variant === undefined && line.tool === undefined;
}

/** A tool line's light fields reduced to the wire's four. */
function wireTool({ name, argument, status, durationMs }: PolyforgeProgressTool): PolyforgeProgressTool {
  return { name, ...(argument !== undefined ? { argument } : {}), status, ...(durationMs !== undefined ? { durationMs } : {}) };
}

/** The progress snapshot to render after a read (; the
 * last-good semantics). A failed request (`body` not a
 *  snapshot), a degraded body (`available: false`) or a malformed one keeps
 *  the previous snapshot — no flash, no error readout; a usable body
 *  replaces it wholesale (no line bound,), each line reduced
 *  to its wire fields. With nothing held yet, a degraded body is the
 *  unavailable state.
 *
 *  One exception: a usable body of event lines only while
 *  the held snapshot shows narration or tool lines — the route's event-log
 *  answer once the daemon has dropped the job — keeps the held lines and
 *  appends the body's event lines after the newest one the held snapshot
 *  also shows (event line ids are the same in both answers); nothing new
 *  keeps the held snapshot itself. The caller passes only the same job's
 *  snapshot as `previous`. Pure. */
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
  const all = (snapshot.lines as PolyforgeProgressLine[]).map(({ id, kind, text, variant, tone, event, at, tool }) => ({
    id, kind, text, ...(variant ? { variant } : {}), ...(tone ? { tone } : {}), ...(event ? { event } : {}),
    ...(at !== undefined ? { at } : {}), ...(tool ? { tool: wireTool(tool) } : {}),
  }));
  const isStream = (line: PolyforgeProgressLine) => line.kind !== "event";
  if (previous?.available && all.length > 0 && !all.some(isStream) && previous.lines.some(isStream)) {
    const held = new Set(previous.lines.map((line) => line.id));
    let last = -1;
    all.forEach((line, index) => { if (held.has(line.id)) last = index; });
    const added = all.slice(last + 1);
    if (added.length === 0) return previous;
    return { available: true, lines: [...previous.lines, ...added], omitted: previous.omitted };
  }
  return { available: true, lines: all, omitted };
}

/** One step's spawn block in the job detail's execution progress
 *, cut at each `step_started` line in stream order. */
export interface PolyforgeProgressBlock {
  /** Index of the block's own `step_started` line in the snapshot. */
  start: number;
  /** Lines in the block, its own `step_started` line included. */
  count: number;
  /** The step name and spawn number the start line itself carries; absent
   *  when that line does not expose them. */
  step?: string;
  spawn?: string;
  /** From the block's own lifecycle lines only. */
  status: PolyforgeProgressBlockStatus;
  /** Index of the block's terminal lifecycle line — its last `step_done`,
   *  `step_failed` or `step_dead` — when it has one. The
   *  block head absorbs that line and the `start` line: the UI renders
   *  neither as a body row and puts both texts and raw kinds on the head's
   *  title. `count` still includes both. */
  terminal?: number;
  /** The start line's and the terminal line's `at` (epoch ms), when present. */
  startAt?: number;
  endAt?: number;
  /** endAt − startAt, only when both exist and are ordered; a running block's
   *  live duration is the UI's (now − startAt), never invented here. */
  durationMs?: number;
}

/** The status mark a block header carries. */
export type PolyforgeProgressBlockStatus = "done" | "failed" | "needs_input" | "stopped" | "running" | "none";

/** The progress stream cut into leading lines and per-spawn blocks. */
export interface PolyforgeProgressBlockLayout {
  /** Lines before the first `step_started`; rendered unfolded, in place. */
  leading: number;
  blocks: PolyforgeProgressBlock[];
}

/** The step and spawn number a composed `step_started` line carries
 *  (`<HH:MM:SS> ▶ <step> #<spawn_n> · <model>`); no other field is invented. */
function stepStartedHeader(text: string): { step?: string; spawn?: string } {
  const arrow = text.indexOf("▶");
  if (arrow < 0) return { step: text.trim() || undefined };
  let rest = text.slice(arrow + 1).trim();
  const modelAt = rest.indexOf(" · ");
  if (modelAt >= 0) rest = rest.slice(0, modelAt);
  const spawnAt = rest.lastIndexOf(" #");
  if (spawnAt >= 0) {
    const step = rest.slice(0, spawnAt).trim();
    const spawn = rest.slice(spawnAt + 2).trim();
    return { ...(step ? { step } : {}), ...(spawn ? { spawn } : {}) };
  }
  return rest ? { step: rest } : {};
}

/**
 * Cut the whole-job progress stream into spawn blocks: each
 * `step_started` line opens a block that runs to the next `step_started`
 * line, in stream order, so interleaved spawns are cut where they appear and
 * every rerun is its own block. Lines before the first start stay leading
 * and unfolded. The block's status comes only from its own lifecycle lines,
 * in this precedence: any `step_done` → done; any `step_failed`/`step_dead`
 * → failed; a last lifecycle line of `needs_input` → needs_input; any
 * `job_stopped` → stopped; otherwise the newest block is running and an
 * older one has no mark. Leading lines plus every block's count equal the
 * stream length; no line is dropped. Since each block also
 * names its terminal lifecycle line and its start/end times and duration
 * from the lines' `at` (absent when a time is missing — never invented).
 * Pure.
 */
export function progressBlocks(lines: PolyforgeProgressLine[]): PolyforgeProgressBlockLayout {
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (line.kind === "event" && line.event === "step_started") starts.push(index);
  });
  if (starts.length === 0) return { leading: lines.length, blocks: [] };
  const blocks = starts.map((start, index): PolyforgeProgressBlock => {
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length;
    let done = false;
    let failed = false;
    let stopped = false;
    let lastEvent: string | undefined;
    let terminal: number | undefined;
    for (let at = start; at < end; at += 1) {
      const line = lines[at];
      if (line.kind !== "event") continue;
      lastEvent = line.event;
      if (line.event === "step_done") done = true;
      else if (line.event === "step_failed" || line.event === "step_dead") failed = true;
      else if (line.event === "job_stopped") stopped = true;
      if (at > start && (line.event === "step_done" || line.event === "step_failed" || line.event === "step_dead")) terminal = at;
    }
    const startAt = lines[start].at;
    const endAt = terminal !== undefined ? lines[terminal].at : undefined;
    const durationMs = startAt !== undefined && endAt !== undefined && endAt >= startAt ? endAt - startAt : undefined;
    const status: PolyforgeProgressBlockStatus = done ? "done"
      : failed ? "failed"
        : lastEvent === "needs_input" ? "needs_input"
          : stopped ? "stopped"
            : index === starts.length - 1 ? "running" : "none";
    return {
      start, count: end - start, ...stepStartedHeader(lines[start].text), status,
      ...(terminal !== undefined ? { terminal } : {}),
      ...(startAt !== undefined ? { startAt } : {}),
      ...(endAt !== undefined ? { endAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  });
  return { leading: starts[0], blocks };
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
