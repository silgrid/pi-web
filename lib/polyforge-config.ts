import { spawn } from "node:child_process";
import { isPolyforgeVersionBelowMinimum } from "./polyforge-detect";
import type { PolyforgeConfigSchema } from "./polyforge-config-schema";
import {
  probePolyforgeVersion,
  type PolyforgeOpsStatus,
} from "./polyforge-status";

/**
 * Server-side reads for the Settings › Polyforge CONFIGURATION panel
 *. Every fact is a `pf` subprocess read — the panel never
 * parses cli.toml or `.polyforge.yaml` itself. The sanitizers are the only
 * passport off this module: an api_key value is never present on the wire,
 * and a class pf reports but the panel has never seen passes through
 * verbatim rather than being remapped.
 */

/** The configuration panel's own capability floor (plan decision 1): the
 *  next release after the v2.20.5 baseline. The dock's older floor is
 *  unchanged; this one gates only the new config verbs. */
export const POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION = "2.20.6";

const READ_TIMEOUT_MS = 15000;

export interface PolyforgeConfigDaemonValue {
  value: string | number | boolean | null;
  max_configured?: number;
}

export interface PolyforgeConfigItem {
  key: string;
  value?: unknown;
  set?: boolean;
  source?: string;
  class: string;
  schema?: PolyforgeConfigSchema;
  section?: boolean;
  daemon?: PolyforgeConfigDaemonValue;
  stale_reason?: string;
}

export interface PolyforgeConfigStep {
  project?: string;
  step: string;
  declared: boolean;
  models: string[] | null;
}

export interface PolyforgeConfigReload {
  pending: string[];
  overridden: string[];
  maxConfigured?: number;
}

export interface PolyforgeConfigRead {
  pfPresent: boolean;
  pfVersion: string | null;
  capable: boolean;
  reason?: string;
  file?: { sha256: string | null; exists: boolean };
  items: PolyforgeConfigItem[];
  mapped: boolean;
  daemonReachable?: boolean;
  reload?: PolyforgeConfigReload;
  steps?: PolyforgeConfigStep[];
  steps_complete?: boolean;
  summarize?: Record<string, { value: unknown; source: string; class?: string; schema?: PolyforgeConfigSchema }>;
  workspaceFile?: { sha256: string | null; exists: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function runPf(argv: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pf", argv, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("pf did not answer in time"));
    }, READ_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error("polyforge is unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim().slice(0, 512) || `pf exited ${code ?? 1}`));
    });
  });
}

async function runPfJson(argv: string[]): Promise<unknown> {
  return JSON.parse(await runPf(argv));
}

/** One list item, sanitized. api_key keeps set/source/class/schema only. */
export function sanitizeConfigItem(raw: unknown): PolyforgeConfigItem | null {
  if (!isRecord(raw)) return null;
  const key = str(raw.key);
  if (!key) return null;
  const item: PolyforgeConfigItem = { key, class: str(raw.class) };
  const source = str(raw.source);
  if (source) item.source = source;
  if (raw.section === true) item.section = true;
  if (isRecord(raw.schema) && typeof raw.schema.kind === "string") {
    item.schema = raw.schema as PolyforgeConfigSchema;
  }
  if (key === "api_key") {
    item.set = raw.set === true;
    return item;
  }
  if (raw.value !== undefined) item.value = raw.value;
  if (raw.set === true) item.set = true;
  return item;
}

/** The list document's shape gate: the CAS hash plus class/schema on every
 *  item. A newer version with the old shape is still not capable. */
export function hasConfigListShape(doc: unknown): doc is { file: { sha256: string; exists?: boolean }; items: Array<Record<string, unknown>> } {
  if (!isRecord(doc) || !isRecord(doc.file) || typeof doc.file.sha256 !== "string") return false;
  if (!Array.isArray(doc.items) || doc.items.length === 0) return false;
  return doc.items.every((item) => isRecord(item) && typeof item.key === "string" && typeof item.class === "string");
}

function sanitizeOps(raw: unknown): { ops: PolyforgeOpsStatus | null; reload?: PolyforgeConfigReload } {
  if (!isRecord(raw)) return { ops: null };
  const queue = isRecord(raw.queue) ? raw.queue : {};
  const reloadRaw = isRecord(raw.reload) ? raw.reload : {};
  const pending = Array.isArray(reloadRaw.pending) ? reloadRaw.pending.filter((v): v is string => typeof v === "string") : [];
  const overridden = Array.isArray(reloadRaw.overridden) ? reloadRaw.overridden.filter((v): v is string => typeof v === "string") : [];
  const maxConfigured = finite(queue.max_configured);
  const jobs: unknown[] = [];
  return {
    ops: {
      queue: { running: finite(queue.running) ?? 0, max: finite(queue.max_concurrent) ?? 0 },
      jobs: jobs as PolyforgeOpsStatus["jobs"],
    },
    reload: {
      pending,
      overridden,
      ...(maxConfigured !== undefined ? { maxConfigured } : {}),
    },
  };
}

/** Pure stale classification (plan decision 7): pending restart, an explicit
 *  daemon-flag override, a temporary `pf ops max` override, or not reloaded. */
export function classifyStaleReason(
  key: string,
  fileValue: unknown,
  daemonValue: unknown,
  reload: PolyforgeConfigReload | undefined,
  maxConfigured?: number,
): string | undefined {
  if (fileValue === undefined || daemonValue === undefined) return undefined;
  if (String(fileValue) === String(daemonValue)) return undefined;
  if (reload?.pending.includes(key)) return "pending restart";
  if (reload?.overridden.includes(key)) return "daemon flag override";
  if (key === "max_concurrent_jobs" && maxConfigured !== undefined && daemonValue !== undefined && Number(maxConfigured) !== Number(daemonValue)) {
    return "pf ops max override";
  }
  return "not reloaded";
}

function daemonValueFor(key: string, doc: Record<string, unknown>): { value: string | number | null; maxConfigured?: number } | undefined {
  const queue = isRecord(doc.queue) ? doc.queue : {};
  const supervision = isRecord(doc.supervision) ? doc.supervision : {};
  if (key === "max_concurrent_jobs") {
    const value = finite(queue.max_concurrent);
    if (value === undefined) return undefined;
    const maxConfigured = finite(queue.max_configured);
    return maxConfigured !== undefined ? { value, maxConfigured } : { value };
  }
  if (key === "step_timeout" && typeof supervision.step_timeout === "string") return { value: supervision.step_timeout };
  if (key === "stall_window" && typeof supervision.stall_window === "string") return { value: supervision.stall_window };
  return undefined;
}

function sanitizeWorkspace(raw: unknown): {
  mapped: boolean;
  summarize?: Record<string, { value: unknown; source: string; class?: string; schema?: PolyforgeConfigSchema }>;
  steps?: PolyforgeConfigStep[];
  steps_complete?: boolean;
  workspaceFile?: { sha256: string | null; exists: boolean };
} {
  if (!isRecord(raw)) return { mapped: false };
  if (raw.mapped !== true) return { mapped: false };
  const yaml = isRecord(raw.yaml)
    ? { sha256: typeof raw.yaml.sha256 === "string" ? raw.yaml.sha256 : null, exists: raw.yaml.exists !== false }
    : undefined;
  const summarize: Record<string, { value: unknown; source: string; class?: string; schema?: PolyforgeConfigSchema }> = {};
  if (isRecord(raw.summarize)) {
    for (const name of ["models", "language", "interval_sec"] as const) {
      const entry = raw.summarize[name];
      if (!isRecord(entry)) continue;
      const source = str(entry.source) || "default";
      const cls = str(entry.class);
      const schema = isRecord(entry.schema) && typeof entry.schema.kind === "string"
        ? entry.schema as PolyforgeConfigSchema
        : undefined;
      summarize[name] = {
        value: entry.value,
        source,
        ...(cls ? { class: cls } : {}),
        ...(schema ? { schema } : {}),
      };
    }
  }
  const steps: PolyforgeConfigStep[] = [];
  if (isRecord(raw.steps)) {
    for (const [outer, value] of Object.entries(raw.steps)) {
      if (!isRecord(value)) continue;
      if (typeof value.declared === "boolean") {
        steps.push({
          step: outer,
          declared: value.declared,
          models: Array.isArray(value.models) ? value.models.filter((m): m is string => typeof m === "string") : null,
        });
        continue;
      }
      // Real pf groups candidates per project.
      for (const [step, entry] of Object.entries(value)) {
        if (!isRecord(entry) || typeof entry.declared !== "boolean") continue;
        steps.push({
          project: outer,
          step,
          declared: entry.declared,
          models: Array.isArray(entry.models) ? entry.models.filter((m): m is string => typeof m === "string") : null,
        });
      }
    }
  }
  return {
    mapped: true,
    summarize,
    steps,
    steps_complete: raw.steps_complete !== false,
    ...(yaml ? { workspaceFile: yaml } : {}),
  };
}

/** The one read assembly the config route calls. Every degradation is a
 *  field, never an exception: pf absent / below the floor / an old list
 *  shape answers capable:false with visible reason text and issues no new
 *  workspace/write spawn. */
export async function readPolyforgeConfig(cwd: string): Promise<PolyforgeConfigRead> {
  // A capability read is route-initiated: probe fresh so an installed pf
  // upgrade/downgrade is reflected on the next panel read.
  const presence = await probePolyforgeVersion(true);
  if (!presence.present) {
    return {
      pfPresent: false,
      pfVersion: null,
      capable: false,
      reason: "polyforge is not installed on this machine",
      items: [],
      mapped: false,
    };
  }
  if (isPolyforgeVersionBelowMinimum(presence.version, POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION)) {
    return {
      pfPresent: true,
      pfVersion: presence.version,
      capable: false,
      reason: `the configuration panel needs pf ${POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION} or newer (found ${presence.version ?? "an unparseable version"})`,
      items: [],
      mapped: false,
    };
  }
  let list: unknown;
  try {
    list = await runPfJson(["--json", "config", "list"]);
  } catch (error) {
    return {
      pfPresent: true,
      pfVersion: presence.version,
      capable: false,
      reason: error instanceof Error ? error.message : "pf config list is unavailable",
      items: [],
      mapped: false,
    };
  }
  if (!hasConfigListShape(list)) {
    return {
      pfPresent: true,
      pfVersion: presence.version,
      capable: false,
      reason: "this pf reports the configuration list without the class/schema shape the panel needs",
      items: [],
      mapped: false,
    };
  }
  const items = list.items
    .map(sanitizeConfigItem)
    .filter((item): item is PolyforgeConfigItem => item !== null);

  let opsRaw: unknown = null;
  try {
    opsRaw = await runPfJson(["--json", "ops", "status"]);
  } catch {
    opsRaw = null;
  }
  const { reload } = sanitizeOps(opsRaw);
  if (isRecord(opsRaw)) {
    for (const item of items) {
      const daemon = daemonValueFor(item.key, opsRaw);
      if (!daemon) continue;
      item.daemon = daemon;
      const reason = classifyStaleReason(item.key, item.value, daemon.value, reload, daemon.maxConfigured);
      if (reason) item.stale_reason = reason;
    }
  }

  let mapped = false;
  let summarize: PolyforgeConfigRead["summarize"];
  let steps: PolyforgeConfigStep[] | undefined;
  let stepsComplete: boolean | undefined;
  let workspaceFile: PolyforgeConfigRead["workspaceFile"];
  if (cwd) {
    try {
      const ws = sanitizeWorkspace(await runPfJson(["--json", "config", "workspace", "--cwd", cwd]));
      mapped = ws.mapped;
      summarize = ws.summarize;
      steps = ws.steps;
      stepsComplete = ws.steps_complete;
      workspaceFile = ws.workspaceFile;
      if (ws.mapped && ws.summarize) {
        for (const name of ["models", "language", "interval_sec"] as const) {
          const entry = ws.summarize[name];
          if (!entry) continue;
          const key = `summarize.${name}`;
          const existing = items.find((item) => item.key === key);
          if (existing) {
            // The list already reported this key (and its pf schema); the
            // workspace read contributes the effective value/source and
            // pf's own class (never a UI copy).
            existing.value = entry.value;
            existing.source = entry.source;
            if (entry.class) existing.class = entry.class;
            continue;
          }
          items.push({
            key,
            value: entry.value,
            source: entry.source,
            class: entry.class ?? "",
            ...(entry.schema ? { schema: entry.schema } : {}),
          });
        }
      } else {
        // An unmapped cwd still renders the workspace controls (read-only),
        // so the panel can state why they are unavailable instead of hiding
        // them. No class is invented: pf reported none for an unmapped cwd.
        for (const name of ["models", "language", "interval_sec"] as const) {
          items.push({ key: `summarize.${name}`, value: null, class: "" });
        }
      }
    } catch {
      mapped = false;
      for (const name of ["models", "language", "interval_sec"] as const) {
        items.push({ key: `summarize.${name}`, value: null, class: "" });
      }
    }
  }

  return {
    pfPresent: true,
    pfVersion: presence.version,
    capable: true,
    file: { sha256: list.file.sha256, exists: list.file.exists !== false },
    items,
    mapped,
    daemonReachable: isRecord(opsRaw),
    ...(reload ? { reload } : {}),
    ...(summarize ? { summarize } : {}),
    ...(steps ? { steps } : {}),
    ...(stepsComplete !== undefined ? { steps_complete: stepsComplete } : {}),
    ...(workspaceFile ? { workspaceFile } : {}),
  };
}
