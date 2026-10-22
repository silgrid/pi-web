import { execFileAsync } from "./exec-file";

/**
 * Server-side pf reads for the Polyforge dock panel (pi#108). The transport
 * (execFile via lib/exec-file.ts, no shell) and the pure logic (ref
 * validation, sanitizers, step ordering, event tail) live here together; the
 * HTTP faces in `app/api/polyforge/**` only degrade and answer.
 *
 * Subprocess contract (pf CLI, verified live 2026-10-18):
 * - presence probe: `pf --version` (exit 0, no daemon needed)
 * - ops: `pf --json ops status` → machine `{ env_names, workspaces,
 *   workflows_dir, machine_id, jobs[], queue: { pending, running,
 *   max_concurrent }, … }`
 * - watch: `pf --json watch <ref> --once --demand --events 40` → machine `{ known,
 *   slug, execution: { steps: Record<name, { status, started_at }> }, …,
 *   events[] }` — `--once` is mandatory (the resident watcher would stream
 *   forever and outlive the 10s timeout); `--demand` (pi#119) arms the
 *   summarize lane on every read (the open panel's 3s poll is this route's
 *   only in-app caller, so every read is a human-side read).
 *
 * The sanitizers are the only passport off this file: machine passthrough
 * never reaches a response (env names, workspace paths, raw event bodies,
 * pending-question text, session fingerprints, non-chat origins). The
 * owner-approved additions (pi#117) still leave only through them:
 * `progress.command` masked + truncated server-side, `command_age_sec`,
 * `tool_calls`, `recent_files`, per-step `startedAt`, and chat-origin
 * `chat_id`/`owner`. The summarize-lane fields (pi#119) — `summary`,
 * `summary_age_sec`, `summary_error`, `summary_capped` — leave only through
 * the same passport: flat on the wire, flat on the response, each absent
 * when missing or malformed.
 */

const PRESENCE_PROBE_TIMEOUT_MS = 3000;
const READ_TIMEOUT_MS = 10000;
const PRESENCE_TTL_MS = 60000;
const EVENT_TAIL = 40;
/** pf's own stderr passes through under this cap; nothing else is echoed. */
const STDERR_CAP = 512;

/** Cap on the command text that can leave the server (pi#117): the value is
 *  the program+args shape, ~120 chars, never a full raw command line. */
const COMMAND_MAX = 120;

/** Cap on the summary error text that can leave the server (pi#119): pf's
 *  own raw wording for a failed summarize call, verbatim but bounded (the
 *  same bound as the pf-stderr cap; a separate fact, so a separate
 *  constant). */
const SUMMARY_ERROR_MAX = 512;

/** Credential-shaped substrings masked server-side before a command can
 *  reach a response (pi#117, owner-approved): token prefixes (`sk-`,
 *  `ghp_`, `npm_`), env assignments whose name ends in `API_KEY`,
 *  `token=`/`password=`/`passwd=` assignments (the `=` forms, `--flag=`
 *  included), and the `--password <value>` flag form. Over-masking only
 *  costs display fidelity; under-masking leaks, so the value patterns are
 *  greedy `\S+`. No RegExp lookbehind (repo rule). */
const COMMAND_REDACTIONS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]+/g, "sk-***"],
  [/\bghp_[A-Za-z0-9]+/g, "ghp_***"],
  [/\bnpm_[A-Za-z0-9]+/g, "npm_***"],
  [/\b([A-Za-z0-9_]*API_KEY=)\S+/gi, "$1***"],
  [/\b(token=|password=|passwd=)\S+/gi, "$1***"],
  [/(--password\s)\S+/gi, "$1***"],
];

/** Mask credential-shaped substrings, then truncate to COMMAND_MAX — the
 *  only shape in which `progress.command` may leave the server. A clean
 *  command passes verbatim (the program+args shape is the point); one
 *  carrying credential-shaped substrings never leaves unmasked. Pure,
 *  never throws. */
export function redactPolyforgeCommand(command: string): string {
  let redacted = command;
  for (const [pattern, replacement] of COMMAND_REDACTIONS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted.slice(0, COMMAND_MAX);
}

export class PolyforgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolyforgeError";
  }

  /** The only text that survives a spawn failure: pf's own stderr, bounded.
   *  Never `error.message` (it carries our argv) and never `process.env`
   *  (a stale POLYFORGE_V1_API_KEY must leak nothing). */
  static fromSpawnError(error: unknown): PolyforgeError {
    if (error instanceof Error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      if (stderr) return new PolyforgeError(stderr.slice(0, STDERR_CAP));
    }
    return new PolyforgeError("polyforge is unavailable");
  }
}

// ---- ref validation (before any subprocess argv) ----

/**
 * A single closed positional: slug `proj#123` (project part `[A-Za-z0-9]`
 * then dash-safe) or id `wi_…`. Anything else (spaces, flags, `;`) is
 * refused — the ref never reaches argv.
 */
const WI_REF_PATTERN = /^(wi_[A-Za-z0-9]+|[A-Za-z0-9][A-Za-z0-9_-]*#\d+)$/;

export function isPolyforgeWiRef(value: unknown): value is string {
  return typeof value === "string" && WI_REF_PATTERN.test(value);
}

// ---- response shapes (assumption 4: key names are ours to choose) ----

export interface PolyforgeQueue {
  running: number;
  max: number;
}

export interface PolyforgeJob {
  wi: string;
  slug: string;
  status: string;
  stepAgeSec: number;
  idleAgeSec: number;
  candidate: string;
  spawnN: number;
}

export interface PolyforgeOpsStatus {
  queue: PolyforgeQueue;
  jobs: PolyforgeJob[];
}

export interface PolyforgeStep {
  name: string;
  status: string;
  /** Machine `started_at` (pi#117): present only on started steps, so the
   *  client can show start times and compute durations. */
  startedAt?: string;
}

/** Sanitized workflow declaration entry (pi#114): id only — `on_fail` and
 *  every other declared field are dropped server-side and never reach a
 *  response. */
export interface PolyforgeDeclaredStep {
  id: string;
}

export interface PolyforgeEvent {
  at: string;
  kind: string;
  step?: string;
  model?: string;
  from?: string;
  to?: string;
  cause?: string;
  gate?: string;
  target?: string;
  status?: string;
}

/** Sanitized live progress (pi#117): every field is absent when missing or
 *  malformed on the wire — the client renders nothing for an absent field. */
export interface PolyforgeProgress {
  /** Masked credential-shaped substrings + ~120-char truncation, both
   *  server-side (redactPolyforgeCommand): the program+args shape, never
   *  secrets. */
  command?: string;
  command_age_sec?: number;
  tool_calls?: number;
  recent_files?: string[];
}

/** Sanitized origin (pi#117): exposed only for chat origins — every other
 *  origin field is dropped, and any other kind degrades the whole origin to
 *  absent. */
export interface PolyforgeOrigin {
  kind: "chat";
  chat_id?: string;
  owner?: string;
}

/** The summarize-lane fields of a watch snapshot (pi#119), flat like on
 *  the wire: each is absent when missing or malformed — the client renders
 *  nothing for an absent field. */
export interface PolyforgeSummary {
  /** The last finished summarize line — narration, passed verbatim (the
   *  lane's own bound is 200 chars; no server-side cap, no masking). */
  summary?: string;
  /** Present only together with `summary`. */
  summary_age_sec?: number;
  /** Raw error text of the latest failed summarize call, verbatim (no
   *  masking — the dispatch design carries no credential in the summarize
   *  argv, logs or artifacts), capped server-side at 512 chars. */
  summary_error?: string;
  /** Present and true only at the lane's 20-calls-per-attempt cap. */
  summary_capped?: true;
}

export interface PolyforgeWatchStatus extends PolyforgeSummary {
  wi: string;
  slug: string;
  workflowStatus: string;
  currentStep?: string;
  updatedAt?: string;
  steps: PolyforgeStep[];
  declared_steps: PolyforgeDeclaredStep[] | null;
  events: PolyforgeEvent[];
  progress?: PolyforgeProgress;
  origin?: PolyforgeOrigin;
}

// ---- transport ----

/** Cached presence probe: `pf` reachable on PATH plus the version it
 *  reported. Cached server-side for 60s (assumption 5: a CLI installed while
 *  the server runs appears after a reload once the TTL expires). Any probe
 *  failure (ENOENT, timeout, kill) reads as absent — the UI affordance is
 *  gated on presence, never on daemon reachability. */
let presenceCache: { present: boolean; version: string | null; expiresAt: number } | null = null;

export interface PolyforgePresence {
  present: boolean;
  /** The version `pf --version` reported, verbatim; null when absent or unparseable. */
  version: string | null;
}

/** `pf` reachable on PATH (pi#108's original probe, boolean contract kept for
 *  its callers — the status route and `lib/session-chat-id.ts`). Same single
 *  `pf --version` spawn and 60s cache as `probePolyforgeVersion`. */
export async function probePolyforgePresent(): Promise<boolean> {
  return (await probePolyforgeVersion()).present;
}

/** The one `pf --version` spawn (presence + the reported version), cached
 *  module-side for 60s. `force` bypasses the cache read (the settings
 *  section's 「重新检测」, pi#122) but still refreshes it — one spawn per
 *  probe, never a second detection implementation. */
export async function probePolyforgeVersion(force = false): Promise<PolyforgePresence> {
  const now = Date.now();
  if (!force && presenceCache && now < presenceCache.expiresAt) {
    return { present: presenceCache.present, version: presenceCache.version };
  }
  let present = false;
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync("pf", ["--version"], { timeout: PRESENCE_PROBE_TIMEOUT_MS });
    present = true;
    version = parsePolyforgeVersion(stdout);
  } catch {
    present = false;
  }
  presenceCache = { present, version, expiresAt: now + PRESENCE_TTL_MS };
  return { present, version };
}

const VERSION_VALUE_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][^\s]+)?$/;

/** Version parse (pure): `pf --version` stdout verbatim when it is a
 *  semver-ish `v?X.Y.Z` line (a prerelease/build suffix tolerated — the
 *  reported string is the point); anything else → null (version absent,
 *  still present), never an error. */
export function parsePolyforgeVersion(stdout: string): string | null {
  const value = stdout.trim();
  return VERSION_VALUE_PATTERN.test(value) ? value : null;
}

async function runPfJson(argv: string[]): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("pf", argv, { timeout: READ_TIMEOUT_MS });
    return JSON.parse(stdout);
  } catch (error) {
    throw PolyforgeError.fromSpawnError(error);
  }
}

export async function getPolyforgeOpsStatus(): Promise<PolyforgeOpsStatus | null> {
  const machine = await runPfJson(["--json", "ops", "status"]);
  return sanitizeOpsStatus(machine);
}

export async function getPolyforgeWatch(wiRef: string): Promise<PolyforgeWatchStatus | null> {
  if (!isPolyforgeWiRef(wiRef)) {
    throw new PolyforgeError("wi must be a slug (pi#107) or id (wi_…)");
  }
  // `--demand` (pi#119) arms the summarize lane on EVERY read: the open
  // panel's 3s poll is this route's only in-app caller, so every read is a
  // human-side read. Always passed, no client parameter, no fallback — a
  // pf older than v2.18.1 (no --demand) fails the read and the route
  // degrades through the existing unavailable path.
  const machine = await runPfJson(["--json", "watch", wiRef, "--once", "--demand", "--events", String(EVENT_TAIL)]);
  return sanitizeWatch(machine);
}

// ---- pure helpers ----

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toOptionalTrimmedString(value: unknown): string | undefined {
  const trimmed = toTrimmedString(value);
  return trimmed ? trimmed : undefined;
}

/**
 * Execution order: started steps by `started_at` ascending, then steps that
 * never started, ties broken by step name. `pf watch` exposes only each
 * step's `started_at` (no workflow declaration), so this ordering is the
 * plan's definition of "execution order". Started steps keep their
 * `startedAt` (pi#117); unstarted steps carry none.
 */
export function orderPolyforgeSteps(
  machineSteps: Record<string, { status?: unknown; started_at?: unknown }> | undefined,
): PolyforgeStep[] {
  if (!machineSteps || typeof machineSteps !== "object") return [];
  const entries = Object.entries(machineSteps).map(([name, step]) => ({
    name,
    status: toTrimmedString((step ?? {}).status) || "pending",
    startedAt: toOptionalTrimmedString((step ?? {}).started_at),
  }));
  const started = entries
    .filter((entry) => entry.startedAt)
    .sort((a, b) => (a.startedAt! < b.startedAt! ? -1 : a.startedAt! > b.startedAt! ? 1 : a.name.localeCompare(b.name)));
  const unstarted = entries
    .filter((entry) => !entry.startedAt)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...started, ...unstarted].map(({ name, status, startedAt }) =>
    startedAt ? { name, status, startedAt } : { name, status });
}

/**
 * Sanitize `execution.declared_steps` (pi#114). Keeps each entry's trimmed
 * non-empty `id`, in declaration order; `on_fail` and every other field are
 * dropped server-side (raw shape is proposed to companion WI #213). Absent,
 * null, non-array, empty, or any entry without a valid id → null — the
 * client then falls back to started-at ordering. Pure, never throws, so the
 * route's 2xx degradation contract is untouched.
 */
export function sanitizeDeclaredSteps(value: unknown): PolyforgeDeclaredStep[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const steps: PolyforgeDeclaredStep[] = [];
  for (const entry of value) {
    const id = entry && typeof entry === "object" ? toTrimmedString((entry as { id?: unknown }).id) : "";
    if (!id) return null;
    steps.push({ id });
  }
  return steps;
}

/** Owner-approved per-kind event body whitelist (pi#112). Every kind not
 *  listed here passes through only `body.step` (when present); all other
 *  body keys — question, detail, evidence, error, answered_by, files,
 *  reason, from_model/to_model, spawn_n, … — never reach a response. */
const EVENT_BODY_FIELDS: Record<string, readonly string[]> = {
  step_started: ["step", "model"],
  candidate_switched: ["step", "from", "to"],
  step_failed: ["step", "cause"],
  step_dead: ["step", "cause"],
  rewind: ["gate", "target"],
  terminal: ["status"],
};

/** Clamp to the newest `maxEvents`, order preserved (newest last). */
export function tailPolyforgeEvents(events: unknown[], maxEvents: number = EVENT_TAIL): PolyforgeEvent[] {
  if (!Array.isArray(events)) return [];
  return events.slice(-maxEvents).map((event): PolyforgeEvent | null => {
    if (!event || typeof event !== "object") return null;
    const e = event as { at?: unknown; kind?: unknown; body?: unknown };
    const kind = toTrimmedString(e.kind);
    const at = toTrimmedString(e.at);
    if (!at || !kind) return null;
    const mapped: PolyforgeEvent = { at, kind };
    // Per-kind body whitelist (pi#112): only the owner-approved fields for
    // each kind pass through; every other body key is dropped before it can
    // reach a response. Unknown kinds pass through at most `body.step`.
    if (e.body && typeof e.body === "object") {
      const body = e.body as Record<string, unknown>;
      const fields = EVENT_BODY_FIELDS[kind] ?? ["step"];
      for (const field of fields) {
        const value = toOptionalTrimmedString(body[field]);
        if (value !== undefined) {
          (mapped as unknown as Record<string, string | undefined>)[field] = value;
        }
      }
    }
    return mapped;
  }).filter((event): event is PolyforgeEvent => event !== null);
}

/**
 * Machine ops status → response snapshot. Keeps `queue.running`,
 * `queue.max_concurrent` and per-job wi/slug/status/stepAgeSec/idleAgeSec/
 * candidate/spawnN. Drops `env_names`, `workspaces`, `workflows_dir`,
 * `machine_id`, `shutting_down`, `session_fingerprint`, `origin`.
 */
export function sanitizeOpsStatus(machine: unknown): PolyforgeOpsStatus | null {
  if (!machine || typeof machine !== "object") return null;
  const m = machine as { queue?: unknown; jobs?: unknown };
  if (!m.queue || typeof m.queue !== "object" || m.queue === null) return null;
  if (!Array.isArray(m.jobs)) return null;
  const queue = m.queue as { running?: unknown; max_concurrent?: unknown };
  const jobs = m.jobs.flatMap((job): PolyforgeJob[] => {
    if (!job || typeof job !== "object") return [];
    const j = job as {
      work_item_id?: unknown;
      slug?: unknown;
      status?: unknown;
      spawn_n?: unknown;
      step_age_sec?: unknown;
      last_work_ago_sec?: unknown;
      candidate?: unknown;
    };
    const slug = toTrimmedString(j.slug);
    if (!slug) return [];
    return [{
      wi: toTrimmedString(j.work_item_id),
      slug,
      status: toTrimmedString(j.status),
      stepAgeSec: toNumber(j.step_age_sec),
      idleAgeSec: toNumber(j.last_work_ago_sec),
      candidate: toTrimmedString(j.candidate),
      spawnN: toNumber(j.spawn_n),
    }];
  });
  return {
    queue: {
      running: toNumber(queue.running),
      max: toNumber(queue.max_concurrent),
    },
    jobs,
  };
}

/**
 * Sanitize machine `progress` (pi#117): only `command` (masked + truncated
 *  server-side via redactPolyforgeCommand), `command_age_sec`, `tool_calls`
 *  and `recent_files` pass; every other machine field is dropped. Each
 *  field is absent when missing or malformed; a progress object with no
 *  valid field degrades the whole field to absent. Pure, never throws.
 */
function sanitizeProgress(value: unknown): PolyforgeProgress | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as { command?: unknown; command_age_sec?: unknown; tool_calls?: unknown; recent_files?: unknown };
  const sanitized: PolyforgeProgress = {};
  const command = toOptionalTrimmedString(p.command);
  if (command) sanitized.command = redactPolyforgeCommand(command);
  if (typeof p.command_age_sec === "number" && Number.isFinite(p.command_age_sec)) {
    sanitized.command_age_sec = p.command_age_sec;
  }
  if (typeof p.tool_calls === "number" && Number.isFinite(p.tool_calls)) {
    sanitized.tool_calls = p.tool_calls;
  }
  // recent_files passes the whitelist as path strings; anything that is not
  // an array of strings degrades to absent — never an error (the field's
  // exact pf wire shape is unobserved, owner-stated).
  if (Array.isArray(p.recent_files) && p.recent_files.every((file) => typeof file === "string")) {
    sanitized.recent_files = p.recent_files as string[];
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Sanitize the machine job origin (pi#117): `kind`, `chat_id` and `owner`
 * are exposed only when `kind === "chat"` — every other origin field is
 *  dropped, and any other kind (or a malformed job/origin) degrades the
 * whole origin to absent. Pure, never throws.
 */
function sanitizeOrigin(job: unknown): PolyforgeOrigin | undefined {
  if (!job || typeof job !== "object") return undefined;
  const origin = (job as { origin?: unknown }).origin;
  if (!origin || typeof origin !== "object") return undefined;
  const o = origin as { kind?: unknown; chat_id?: unknown; owner?: unknown };
  if (toTrimmedString(o.kind) !== "chat") return undefined;
  const sanitized: PolyforgeOrigin = { kind: "chat" };
  const chatId = toOptionalTrimmedString(o.chat_id);
  const owner = toOptionalTrimmedString(o.owner);
  if (chatId) sanitized.chat_id = chatId;
  if (owner) sanitized.owner = owner;
  return sanitized;
}

/**
 * Sanitize the flat summarize-lane wire fields (pi#119): `summary` (a
 *  trimmed non-empty string, verbatim — the lane's own bound is 200 chars,
 *  no server-side cap), `summary_age_sec` (a finite number, kept only
 *  together with `summary`), `summary_error` (a trimmed non-empty string,
 *  verbatim and capped at SUMMARY_ERROR_MAX — no masking: the dispatch
 *  design carries no credential in the summarize argv, logs or artifacts,
 *  so raw-never-faked holds literally) and `summary_capped` (kept only
 *  when the wire value is exactly `true`). Each field is absent when
 *  missing or malformed on the wire, never an error, and no other machine
 *  field leaks. Pure, never throws.
 */
function sanitizeSummaryFields(machine: {
  summary?: unknown;
  summary_age_sec?: unknown;
  summary_error?: unknown;
  summary_capped?: unknown;
}): PolyforgeSummary {
  const summary = toOptionalTrimmedString(machine.summary);
  const summaryError = toOptionalTrimmedString(machine.summary_error);
  const fields: PolyforgeSummary = {};
  if (summary) {
    fields.summary = summary;
    if (typeof machine.summary_age_sec === "number" && Number.isFinite(machine.summary_age_sec)) {
      fields.summary_age_sec = machine.summary_age_sec;
    }
  }
  if (summaryError) fields.summary_error = summaryError.slice(0, SUMMARY_ERROR_MAX);
  if (machine.summary_capped === true) fields.summary_capped = true;
  return fields;
}

/**
 * Machine watch → response snapshot, or null when the ref is unknown to the
 * daemon (`known:false` shape) or the machine shape is unusable. Null keeps
 * the client's last snapshot (selection persistence, daemon blips).
 */
export function sanitizeWatch(machine: unknown): PolyforgeWatchStatus | null {
  if (!machine || typeof machine !== "object") return null;
  const m = machine as {
    known?: unknown;
    work_item?: unknown;
    slug?: unknown;
    job?: unknown;
    execution?: unknown;
    events?: unknown;
    progress?: unknown;
    summary?: unknown;
    summary_age_sec?: unknown;
    summary_error?: unknown;
    summary_capped?: unknown;
  };
  if (m.known !== true) return null;
  const execution = m.execution;
  if (!execution || typeof execution !== "object") return null;
  const ex = execution as {
    workflow_status?: unknown;
    current_step?: unknown;
    updated_at?: unknown;
    steps?: unknown;
    declared_steps?: unknown;
  };
  if (!ex.steps || typeof ex.steps !== "object") return null;
  const wi = toTrimmedString(m.work_item);
  const slug = toTrimmedString(m.slug);
  if (!wi || !slug) return null;
  return {
    wi,
    slug,
    workflowStatus: toTrimmedString(ex.workflow_status),
    currentStep: toOptionalTrimmedString(ex.current_step),
    updatedAt: toOptionalTrimmedString(ex.updated_at),
    steps: orderPolyforgeSteps(ex.steps as Record<string, { status?: unknown; started_at?: unknown }>),
    declared_steps: sanitizeDeclaredSteps(ex.declared_steps),
    events: tailPolyforgeEvents(Array.isArray(m.events) ? m.events : [], EVENT_TAIL),
    progress: sanitizeProgress(m.progress),
    origin: sanitizeOrigin(m.job),
    ...sanitizeSummaryFields(m),
  };
}
