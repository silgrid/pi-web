import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter";
import { readRegularFileText } from "./regular-file";
import { maskPolyforgeCredentials, type PolyforgeJob } from "./polyforge-status";
import {
  CARD_ENTRY_MAX,
  CARD_FIRST_PAGE,
  CARD_POLL_PAGE,
  CARD_RESPONSE_MAX_BYTES,
  CARD_RESPONSE_MAX_ENTRIES,
  capCodePoints,
  formatCardCursor,
  isPolyforgeWorkItemId,
  parseCardCursor,
  sortPolyforgeCards,
  type PolyforgeCard,
  type PolyforgeCardEntry,
  type PolyforgeCardProgress,
  type PolyforgeCardStep,
} from "./polyforge-cards-pure";

/**
 * Server-side reader of the Polyforge Jobs-tab card stream.
 * Read-only, straight from the daemon's own files — no pf spawn per card:
 *
 * - `<data root>/runtime-state.json` `jobs[]` → a job's `capsule_dir` and
 *   job-level `transcript` (data root: `$POLYFORGE_DATA_DIR`, else
 *   `~/.local/share/polyforge`, the daemon's own default);
 * - `<data root>/events/wi-<wi>.jsonl` → earliest `job_started`, per-step
 *   `step_started` / `step_done` runs (bounded read);
 * - `<capsule>/capsule.json` `bundle_name` → `<capsule>/workflows/<bundle>/
 *   workflow.md` frontmatter `steps[].id` → declared step order;
 * - `<capsule>/runtime-state/work-item.json` (`goal`) and `execution.json`
 *   (`current_step`, per-step `status` / `step_started_at`);
 * - `<capsule>/runtime-state/spawn-journal.jsonl` latest line → the current
 *   step's `harness`, `started_at`, `harness_session` and `transcript`. The
 *   harness's live session file is read first (pi: the newest file under
 *   `<data root>/step-agent-sessions/<encoded capsule>/` written since the
 *   step started; claude: `<data root>/claude-config/projects/<encoded
 *   capsule>/<harness_session>.jsonl`), then the journal's `transcript` (the
 *   capsule copy, complete only once the step ends). The job record's own
 *   `transcript` is the job's first step, never the current one, so it is
 *   not a progress source.
 *
 * Every path derives from a wi id validated by its shape and found in the
 * daemon's own job record; a transcript must resolve inside the capsule or
 * the data root. Content leaves only through the entry whitelist: assistant
 * narration text, credential-masked never a tool call, its
 * name or command/argument, tool results, thinking, user/system prompts. Every failure degrades to an
 * absent field or `available: false`; nothing here throws to the route.
 */

/** Small JSON records (job index, capsule, work item, execution). */
const RECORD_MAX_BYTES = 4 * 1024 * 1024;
/** workflow.md is read for its frontmatter only. */
const WORKFLOW_MAX_BYTES = 512 * 1024;
/** Events: read whole up to this; beyond it a head (job_started) + tail window. */
const EVENTS_MAX_BYTES = 512 * 1024;
const EVENTS_HEAD_BYTES = 32 * 1024;
/** Spawn journal: only its newest line matters. */
const JOURNAL_TAIL_BYTES = 16 * 1024;
/** Transcript bytes read per card per request (tail on first load, forward slice after). */
export const TRANSCRIPT_WINDOW_BYTES = 64 * 1024;
/** Goal text kept for the hover title. */
const GOAL_MAX = 2000;

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK || 0);
const HARNESS_SESSION_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export function polyforgeDataRoot(): string {
  const configured = process.env.POLYFORGE_DATA_DIR?.trim();
  return configured && isAbsolute(configured) ? configured : join(homedir(), ".local", "share", "polyforge");
}

// ---- bounded file reads ----

/** Read `[start, start+length)` of a regular file; undefined when missing,
 *  not a regular file or unreadable. `size` is the file size at open. */
function readSlice(path: string, start: number | ((size: number) => number), length: number | ((size: number, start: number) => number)):
  { buffer: Buffer; start: number; size: number; ino: number; dev: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return undefined;
    const size = stats.size;
    const from = Math.max(0, Math.min(size, typeof start === "function" ? start(size) : start));
    const want = Math.max(0, Math.min(size - from, typeof length === "function" ? length(size, from) : length));
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const n = readSync(fd, buffer, read, want - read, from + read);
      if (n === 0) break;
      read += n;
    }
    return { buffer: buffer.subarray(0, read), start: from, size, ino: stats.ino, dev: stats.dev };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function readJson(path: string, maxBytes = RECORD_MAX_BYTES): unknown {
  try {
    const text = readRegularFileText(path, maxBytes);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

// ---- daemon job records ----

export interface PolyforgeJobRecord {
  capsuleDir?: string;
}

/** `runtime-state.json` → wi → its record's capsule dir. */
export function readJobRecords(root: string): Map<string, PolyforgeJobRecord> {
  const records = new Map<string, PolyforgeJobRecord>();
  const jobs = asObject(readJson(join(root, "runtime-state.json")))?.jobs;
  if (!Array.isArray(jobs)) return records;
  for (const job of jobs) {
    const record = asObject(job);
    const wi = record?.work_item_id;
    if (!isPolyforgeWorkItemId(wi) || records.has(wi)) continue;
    const capsuleDir = asString(record?.capsule_dir);
    records.set(wi, capsuleDir && isAbsolute(capsuleDir) ? { capsuleDir } : {});
  }
  return records;
}

// ---- events and step durations ----

export interface PolyforgeCardEvent {
  at: string;
  kind: string;
  step?: string;
}

/** The WI event file's lines, bounded: whole up to EVENTS_MAX_BYTES, else a
 *  head window (where `job_started` lives) plus the newest tail window. */
export function readCardEvents(path: string): PolyforgeCardEvent[] {
  const head = readSlice(path, 0, EVENTS_MAX_BYTES);
  if (!head) return [];
  let lines: string[];
  if (head.size <= EVENTS_MAX_BYTES) {
    lines = head.buffer.toString("utf8").split("\n");
  } else {
    const headText = head.buffer.subarray(0, EVENTS_HEAD_BYTES).toString("utf8");
    const headLines = headText.split("\n").slice(0, -1);
    const tail = readSlice(path, (size) => size - (EVENTS_MAX_BYTES - EVENTS_HEAD_BYTES), EVENTS_MAX_BYTES - EVENTS_HEAD_BYTES);
    const tailLines = tail ? tail.buffer.toString("utf8").split("\n").slice(1) : [];
    lines = [...headLines, ...tailLines];
  }
  const events: PolyforgeCardEvent[] = [];
  for (const line of lines) {
    const record = parseLine(line);
    const at = asString(record?.at);
    const kind = asString(record?.kind);
    if (!at || !kind) continue;
    const step = asString(asObject(record?.body)?.step);
    events.push(step ? { at, kind, step } : { at, kind });
  }
  return events;
}

export function earliestJobStarted(events: PolyforgeCardEvent[]): string | undefined {
  let best: { at: string; ms: number } | undefined;
  for (const event of events) {
    if (event.kind !== "job_started") continue;
    const ms = Date.parse(event.at);
    if (!Number.isFinite(ms)) continue;
    if (!best || ms < best.ms) best = { at: event.at, ms };
  }
  return best?.at;
}

export interface PolyforgeExecutionSteps {
  currentStep?: string;
  steps: Map<string, { status: string; startedAt?: string }>;
}

export function readExecution(capsuleDir: string): PolyforgeExecutionSteps | undefined {
  const execution = asObject(readJson(join(capsuleDir, "runtime-state", "execution.json")));
  if (!execution) return undefined;
  const steps = new Map<string, { status: string; startedAt?: string }>();
  for (const [id, value] of Object.entries(asObject(execution.steps) ?? {})) {
    const step = asObject(value);
    const startedAt = asString(step?.step_started_at) ?? asString(step?.started_at);
    steps.set(id, { status: asString(step?.status) ?? "pending", ...(startedAt ? { startedAt } : {}) });
  }
  const currentStep = asString(execution.current_step);
  return { ...(currentStep ? { currentStep } : {}), steps };
}

/** Declared step ids from the bundle's workflow.md frontmatter, in order. */
export function readDeclaredSteps(capsuleDir: string): string[] | undefined {
  const bundle = asString(asObject(readJson(join(capsuleDir, "capsule.json")))?.bundle_name);
  if (!bundle || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bundle)) return undefined;
  let text: string | undefined;
  try {
    text = readRegularFileText(join(capsuleDir, "workflows", bundle, "workflow.md"), WORKFLOW_MAX_BYTES);
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  const steps = parseFrontmatter(text).data?.steps;
  if (!Array.isArray(steps)) return undefined;
  const ids: string[] = [];
  for (const step of steps) {
    const id = asString(asObject(step)?.id);
    if (!id) return undefined;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * One entry per step, in `order`. A run opens at `step_started` and closes
 * at the step's `step_done` (or `step_failed`/`step_dead`) or at its next
 * `step_started`; the current in-progress step's open run closes at `now`.
 * The duration is the sum over runs; `runs` counts `step_started`.
 * A step with no readable start is `unstarted` when the execution record
 * says it never left `pending`, `skipped` when it says `skipped`, and
 * `unknown` otherwise — except the current
 * in-progress step, timed from the execution record's start. Pure.
 */
export function computeCardSteps(
  order: string[],
  events: PolyforgeCardEvent[],
  execution: PolyforgeExecutionSteps | undefined,
  now: number,
): PolyforgeCardStep[] {
  const runs = new Map<string, { count: number; totalMs: number; timed: boolean; openMs: number | null }>();
  const stateOf = (step: string) => {
    let state = runs.get(step);
    if (!state) {
      state = { count: 0, totalMs: 0, timed: false, openMs: null };
      runs.set(step, state);
    }
    return state;
  };
  const close = (state: { totalMs: number; timed: boolean; openMs: number | null }, endMs: number) => {
    if (state.openMs !== null && endMs >= state.openMs) {
      state.totalMs += endMs - state.openMs;
      state.timed = true;
    }
    state.openMs = null;
  };
  for (const event of events) {
    if (!event.step) continue;
    const ms = Date.parse(event.at);
    if (event.kind === "step_started") {
      const state = stateOf(event.step);
      state.count += 1;
      if (Number.isFinite(ms)) close(state, ms);
      state.openMs = Number.isFinite(ms) ? ms : null;
    } else if (event.kind === "step_done" || event.kind === "step_failed" || event.kind === "step_dead") {
      const state = runs.get(event.step);
      if (state && Number.isFinite(ms)) close(state, ms);
    }
  }
  return order.map((id): PolyforgeCardStep => {
    const record = execution?.steps.get(id);
    const live = execution?.currentStep === id && record?.status === "in_progress";
    const state = runs.get(id);
    if (state && state.count > 0) {
      if (state.openMs !== null && live) close(state, Math.max(now, state.openMs));
      return state.timed
        ? { id, state: "timed", durationSec: Math.max(0, Math.round(state.totalMs / 1000)), runs: state.count }
        : { id, state: "unknown", runs: state.count };
    }
    if (live && record?.startedAt) {
      const startMs = Date.parse(record.startedAt);
      if (Number.isFinite(startMs)) {
        return { id, state: "timed", durationSec: Math.max(0, Math.round((now - startMs) / 1000)), runs: 1 };
      }
    }
    if (!record || record.status === "pending") return { id, state: "unstarted", runs: 0 };
    if (record.status === "skipped") return { id, state: "skipped", runs: 0 };
    return { id, state: "unknown", runs: 0 };
  });
}

/** Declared order, else the execution record's steps ordered by first
 *  observed `step_started`, then the rest in record order. */
export function cardStepOrder(
  declared: string[] | undefined,
  events: PolyforgeCardEvent[],
  execution: PolyforgeExecutionSteps | undefined,
): string[] {
  if (declared && declared.length > 0) return declared;
  const keys = [...(execution?.steps.keys() ?? [])];
  const seen: string[] = [];
  for (const event of events) {
    if (event.kind === "step_started" && event.step && keys.includes(event.step) && !seen.includes(event.step)) seen.push(event.step);
  }
  return [...seen, ...keys.filter((key) => !seen.includes(key))];
}

// ---- transcript resolution ----

export type PolyforgeHarness = "pi" | "claude";

export interface PolyforgeTranscriptSource {
  path: string;
  harness: PolyforgeHarness;
  step?: string;
}

function realInside(path: string, roots: string[]): string | undefined {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return undefined;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    if (real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return real;
  }
  return undefined;
}

/** pi's session directory name for a cwd: `--<path, separators → ->--`. */
export function encodePiSessionDir(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Claude's project directory name for a cwd: every non-alphanumeric → `-`. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Slack for a pi session file created just before the journal's start stamp. */
const SESSION_START_SLACK_MS = 60_000;

function newestJsonl(dir: string): { path: string; mtime: number } | undefined {
  try {
    const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    let best: { path: string; mtime: number } | undefined;
    for (const name of names) {
      const path = join(dir, name);
      const stats = statSync(path);
      if (stats.isFile() && (!best || stats.mtimeMs > best.mtime)) best = { path, mtime: stats.mtimeMs };
    }
    return best;
  } catch {
    return undefined;
  }
}

/** The current step's transcript and harness, from the spawn journal's
 *  newest line: the harness's live session file first, then the journal's
 *  `transcript`. Undefined when no candidate resolves inside the
 *  capsule/data root or the harness is not one this reader parses. */
export function resolveTranscript(root: string, capsuleDir: string): PolyforgeTranscriptSource | undefined {
  const journal = readSlice(join(capsuleDir, "runtime-state", "spawn-journal.jsonl"), (size) => size - JOURNAL_TAIL_BYTES, JOURNAL_TAIL_BYTES);
  let latest: Record<string, unknown> | undefined;
  if (journal) {
    const lines = journal.buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0 && !latest; i--) latest = parseLine(lines[i]);
  }
  const harnessName = asString(latest?.harness);
  if (harnessName !== "pi" && harnessName !== "claude") return undefined;
  const harness: PolyforgeHarness = harnessName;
  const step = asString(latest?.step_id);
  const roots = [capsuleDir, root];
  const candidates: (string | undefined)[] = [];
  if (harness === "pi") {
    // The newest session of this capsule, unless it predates the step (the
    // current step has not written its own yet).
    const newest = newestJsonl(join(root, "step-agent-sessions", encodePiSessionDir(capsuleDir)));
    const startedMs = Date.parse(asString(latest?.started_at) ?? "");
    if (newest && (!Number.isFinite(startedMs) || newest.mtime >= startedMs - SESSION_START_SLACK_MS)) candidates.push(newest.path);
  } else {
    const session = asString(latest?.harness_session);
    if (session && HARNESS_SESSION_PATTERN.test(session)) {
      candidates.push(join(root, "claude-config", "projects", encodeClaudeProjectDir(capsuleDir), `${session}.jsonl`));
    }
  }
  candidates.push(asString(latest?.transcript));
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate)) continue;
    const path = realInside(candidate, roots);
    if (path) return { path, harness, ...(step ? { step } : {}) };
  }
  return undefined;
}

// ---- transcript parsing (the whitelist) ----

function cleanText(value: string): string {
  return capCodePoints(maskPolyforgeCredentials(value.replace(/\s+/g, " ").trim()), CARD_ENTRY_MAX);
}

/** Whether a record belongs to the harness's transcript format at all. */
function recognised(record: Record<string, unknown>, harness: PolyforgeHarness): boolean {
  const type = record.type;
  if (harness === "pi") return type === "message" || type === "session";
  return type === "assistant" || type === "user" || type === "queue-operation" || type === "system";
}

/** The whitelisted entries of one transcript record: assistant text blocks
 *  only. Tool calls, tool results, thinking, user and system
 *  records produce nothing. */
export function transcriptEntries(record: Record<string, unknown>, harness: PolyforgeHarness, idPrefix: string): PolyforgeCardEntry[] {
  const message = asObject(record.message);
  if (!message || message.role !== "assistant") return [];
  if (harness === "pi" ? record.type !== "message" : record.type !== "assistant") return [];
  const content = message.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const entries: PolyforgeCardEntry[] = [];
  blocks.forEach((value, index) => {
    const block = asObject(value);
    if (!block) return;
    if (block.type !== "text" || typeof block.text !== "string") return;
    const text = cleanText(block.text);
    if (text) entries.push({ id: `${idPrefix}.${index}`, text });
  });
  return entries;
}

export interface PolyforgeCardBudget {
  entries: number;
  bytes: number;
}

function entryBytes(entries: PolyforgeCardEntry[]): number {
  return entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1, 0);
}

/**
 * The card progress for one transcript: a first load (no cursor, or one
 * for another transcript/identity, or past the end) reads the newest
 * TRANSCRIPT_WINDOW_BYTES and returns its newest CARD_FIRST_PAGE entries
 * with `reset`; a matching cursor reads forward at most that many bytes and
 * returns at most CARD_POLL_PAGE entries, the cursor stopping after the
 * last whole line consumed. `budget` (shared across the response) is
 * decremented; a card it cannot serve keeps its cursor.
 */
export function readCardProgress(
  source: PolyforgeTranscriptSource,
  cursor: string | undefined,
  budget: PolyforgeCardBudget,
): PolyforgeCardProgress {
  const head = readSlice(source.path, 0, 0);
  if (!head) return { available: false, entries: [] };
  const identity = createHash("sha256")
    .update(`${source.path}\0${head.dev}\0${head.ino}\0${source.harness}\0${source.step ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  const parsed = parseCardCursor(cursor);
  const incremental = parsed && parsed.identity === identity && parsed.offset <= head.size ? parsed.offset : null;

  if (incremental !== null) {
    const slice = readSlice(source.path, incremental, TRANSCRIPT_WINDOW_BYTES);
    if (!slice) return { available: false, entries: [] };
    const text = slice.buffer;
    const fullBudget = budget.entries >= CARD_RESPONSE_MAX_ENTRIES && budget.bytes >= CARD_RESPONSE_MAX_BYTES;
    const entries: PolyforgeCardEntry[] = [];
    let consumed = 0;
    let lineStart = 0;
    while (lineStart < text.length && entries.length < CARD_POLL_PAGE) {
      const newline = text.indexOf(0x0a, lineStart);
      if (newline < 0) break;
      const record = parseLine(text.subarray(lineStart, newline).toString("utf8"));
      let take = record ? transcriptEntries(record, source.harness, `${identity}.${incremental + lineStart}`) : [];
      if (take.length > budget.entries || entryBytes(take) > budget.bytes) {
        // A line the rest of this response cannot hold waits for the next
        // poll; only a line no response could ever hold is cut to fit.
        if (entries.length > 0 || !fullBudget) break;
        const fitted: PolyforgeCardEntry[] = [];
        for (const entry of take) {
          if (fitted.length >= budget.entries || entryBytes([...fitted, entry]) > budget.bytes) break;
          fitted.push(entry);
        }
        take = fitted;
      }
      entries.push(...take);
      budget.entries -= take.length;
      budget.bytes -= entryBytes(take);
      consumed = newline + 1;
      lineStart = newline + 1;
    }
    // A single line longer than the whole window is skipped, never re-read forever.
    if (consumed === 0 && entries.length === 0 && text.length >= TRANSCRIPT_WINDOW_BYTES) consumed = text.length;
    return { available: true, entries, cursor: formatCardCursor(identity, incremental + consumed) };
  }

  const slice = readSlice(source.path, (size) => size - TRANSCRIPT_WINDOW_BYTES, TRANSCRIPT_WINDOW_BYTES);
  if (!slice) return { available: false, entries: [] };
  const text = slice.buffer;
  let lineStart = 0;
  if (slice.start > 0) {
    const first = text.indexOf(0x0a);
    lineStart = first < 0 ? text.length : first + 1;
  }
  const end = text.lastIndexOf(0x0a) + 1;
  const all: PolyforgeCardEntry[] = [];
  let known = false;
  while (lineStart < end) {
    const newline = text.indexOf(0x0a, lineStart);
    const record = parseLine(text.subarray(lineStart, newline).toString("utf8"));
    if (record && recognised(record, source.harness)) {
      known = true;
      all.push(...transcriptEntries(record, source.harness, `${identity}.${slice.start + lineStart}`));
    }
    lineStart = newline + 1;
  }
  if (!known) return { available: false, entries: [] };
  const entries: PolyforgeCardEntry[] = [];
  let bytes = 0;
  for (let i = all.length - 1; i >= 0 && entries.length < Math.min(CARD_FIRST_PAGE, budget.entries); i--) {
    const size = entryBytes([all[i]]);
    if (bytes + size > budget.bytes) break;
    bytes += size;
    entries.unshift(all[i]);
  }
  budget.entries -= entries.length;
  budget.bytes -= bytes;
  // A budget that could not serve this first page leaves no cursor: the
  // next poll reads the newest page again instead of skipping it.
  if (entries.length === 0 && all.length > 0) return { available: true, entries: [] };
  return { available: true, entries, cursor: formatCardCursor(identity, slice.start + end), reset: true };
}

// ---- the card stream ----

function readGoal(capsuleDir: string): string | undefined {
  const goal = asString(asObject(readJson(join(capsuleDir, "runtime-state", "work-item.json")))?.goal);
  return goal ? capCodePoints(goal, GOAL_MAX) : undefined;
}

function bareCard(job: PolyforgeJob): PolyforgeCard {
  return { job, steps: [], progress: { available: false, entries: [] } };
}

/** Facts of one card except its progress (no budget needed). */
function cardFacts(job: PolyforgeJob, root: string, record: PolyforgeJobRecord | undefined, now: number): PolyforgeCard {
  if (!isPolyforgeWorkItemId(job.wi)) return bareCard(job);
  const events = readCardEvents(join(root, "events", `wi-${job.wi}.jsonl`));
  const startedAt = earliestJobStarted(events);
  const capsuleDir = record?.capsuleDir;
  const execution = capsuleDir ? readExecution(capsuleDir) : undefined;
  const order = cardStepOrder(capsuleDir ? readDeclaredSteps(capsuleDir) : undefined, events, execution);
  const goal = capsuleDir ? readGoal(capsuleDir) : undefined;
  return {
    job,
    ...(goal ? { goal } : {}),
    ...(startedAt ? { startedAt } : {}),
    steps: computeCardSteps(order, events, execution, now),
    ...(execution?.currentStep ? { currentStep: execution.currentStep } : {}),
    progress: { available: false, entries: [] },
  };
}

/**
 * The whole card stream for `jobs` (the daemon's own `pf ops status` job
 * list), ordered by sortPolyforgeCards, with progress for each card read
 * from its cursor under one per-response entry/byte budget. Never throws:
 * a card whose files cannot be read keeps only its job facts.
 */
export function readPolyforgeCards(
  jobs: PolyforgeJob[],
  cursors: Map<string, string>,
  now: number,
  root: string = polyforgeDataRoot(),
): PolyforgeCard[] {
  let records: Map<string, PolyforgeJobRecord>;
  try {
    records = readJobRecords(root);
  } catch {
    records = new Map();
  }
  const cards = sortPolyforgeCards(jobs.map((job) => {
    try {
      return cardFacts(job, root, isPolyforgeWorkItemId(job.wi) ? records.get(job.wi) : undefined, now);
    } catch {
      return bareCard(job);
    }
  }));
  const budget: PolyforgeCardBudget = { entries: CARD_RESPONSE_MAX_ENTRIES, bytes: CARD_RESPONSE_MAX_BYTES };
  for (const card of cards) {
    const wi = card.job.wi;
    const record = isPolyforgeWorkItemId(wi) ? records.get(wi) : undefined;
    if (!record?.capsuleDir) continue;
    const cursor = cursors.get(wi);
    try {
      const source = resolveTranscript(root, record.capsuleDir);
      if (!source) continue;
      if (budget.entries <= 0 || budget.bytes <= 0) {
        // Out of budget: nothing read, the client's cursor stays as it is.
        card.progress = { available: true, entries: [], ...(cursor ? { cursor } : {}) };
        continue;
      }
      card.progress = readCardProgress(source, cursor, budget);
    } catch {
      card.progress = { available: false, entries: [] };
    }
  }
  return cards;
}
