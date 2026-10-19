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
 * - watch: `pf --json watch <ref> --once --events 40` → machine `{ known,
 *   slug, execution: { steps: Record<name, { status, started_at }> }, …,
 *   events[] }` — `--once` is mandatory (the resident watcher would stream
 *   forever and outlive the 10s timeout).
 *
 * The sanitizers are the only passport off this file: machine passthrough
 * never reaches a response (env names, workspace paths, raw event bodies,
 * pending-question text, `progress.command`, session fingerprints, origins).
 */

const PRESENCE_PROBE_TIMEOUT_MS = 3000;
const READ_TIMEOUT_MS = 10000;
const PRESENCE_TTL_MS = 60000;
const EVENT_TAIL = 40;
/** pf's own stderr passes through under this cap; nothing else is echoed. */
const STDERR_CAP = 512;

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

export interface PolyforgeWatchStatus {
  wi: string;
  slug: string;
  workflowStatus: string;
  currentStep?: string;
  updatedAt?: string;
  steps: PolyforgeStep[];
  events: PolyforgeEvent[];
}

// ---- transport ----

let presenceCache: { present: boolean; expiresAt: number } | null = null;

/** `pf` reachable on PATH. Cached server-side for 60s (assumption 5: a CLI
 *  installed while the server runs appears after a reload once the TTL
 *  expires). Any probe failure (ENOENT, timeout, kill) reads as absent —
 *  the UI affordance is gated on presence, never on daemon reachability. */
export async function probePolyforgePresent(): Promise<boolean> {
  const now = Date.now();
  if (presenceCache && now < presenceCache.expiresAt) return presenceCache.present;
  let present = false;
  try {
    await execFileAsync("pf", ["--version"], { timeout: PRESENCE_PROBE_TIMEOUT_MS });
    present = true;
  } catch {
    present = false;
  }
  presenceCache = { present, expiresAt: now + PRESENCE_TTL_MS };
  return present;
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
  const machine = await runPfJson(["--json", "watch", wiRef, "--once", "--events", String(EVENT_TAIL)]);
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
 * plan's definition of "execution order".
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
  return [...started, ...unstarted].map(({ name, status }) => ({ name, status }));
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
    execution?: unknown;
    events?: unknown;
  };
  if (m.known !== true) return null;
  const execution = m.execution;
  if (!execution || typeof execution !== "object") return null;
  const ex = execution as {
    workflow_status?: unknown;
    current_step?: unknown;
    updated_at?: unknown;
    steps?: unknown;
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
    events: tailPolyforgeEvents(Array.isArray(m.events) ? m.events : [], EVENT_TAIL),
  };
}
