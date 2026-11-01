import { spawn } from "node:child_process";
import { isPolyforgeVersionBelowMinimum } from "./polyforge-detect";
import { polyforgePfBin } from "./polyforge-pf-bin";
import { probePolyforgeVersion } from "./polyforge-status";

/**
 * Server-side read of the Settings › Polyforge WORKFLOW card.
 * Two `pf` subprocess reads per call — `pf --json workflows --cwd` (the
 * installed bundles, their steps, candidates, declared attrs and each mapped
 * project's effective chain) and `pf --json config workspace --cwd` (the
 * declared values, the one declared-value source) — and nothing cached: every
 * call (each ↻ click) spawns both afresh. The panel never parses a bundle or
 * the yaml itself. Every degradation (pf absent, below the floor, a failed or
 * undecodable read) is a field of a 200 answer, never an exception.
 */

/** The workflow card's floor: the first pf with `pf workflows` and the
 *  step-attr schema (the next release after the v2.20.14 baseline). The
 *  configuration panel's 2.20.6 floor is unchanged. */
export const POLYFORGE_WORKFLOW_CARD_MINIMUM_PF_VERSION = "2.20.15";

const READ_TIMEOUT_MS = 15000;

export interface PolyforgeWorkflowChain {
  models: string[];
  from: string;
}

export interface PolyforgeWorkflowAttrDecl {
  name: string;
  type: string;
  default: string | number;
}

export interface PolyforgeWorkflowStep {
  id: string;
  model_candidates?: string[];
  attrs?: PolyforgeWorkflowAttrDecl[];
  effective?: Record<string, PolyforgeWorkflowChain>;
}

export interface PolyforgeWorkflowBundle {
  name: string;
  defaults: { model_candidates: string[] | null; effective?: Record<string, PolyforgeWorkflowChain> };
  steps: PolyforgeWorkflowStep[];
}

/** `pf --json workflows` after the sanitizer (only the documented fields). */
export interface PolyforgeWorkflowsDoc {
  workflows_dir: string;
  daemon_reachable: boolean;
  reason: string;
  workspace: string | null;
  projects: string[];
  write_capable: boolean;
  write_reason: string;
  task?: Record<string, PolyforgeWorkflowChain>;
  bundles: PolyforgeWorkflowBundle[];
  bundle_errors: { bundle: string; reason: string }[];
}

export interface PolyforgeWorkspaceAttr {
  value?: string | number;
  declared: boolean;
  source: string;
  class: string;
  default?: string | number;
  schema?: { kind: string };
}

export interface PolyforgeWorkspaceStep {
  declared: boolean;
  models: string[] | null;
  source: string;
  class: string;
  attrs?: Record<string, PolyforgeWorkspaceAttr>;
}

/** The declared values the card shows, from `pf --json config workspace`. */
export interface PolyforgeWorkflowWorkspace {
  workspace: string;
  yaml: { sha256: string | null; exists: boolean };
  steps: Record<string, Record<string, PolyforgeWorkspaceStep>>;
}

export interface PolyforgeWorkflowsRead {
  pfPresent: boolean;
  pfVersion: string | null;
  capable: boolean;
  reason?: string;
  workflows: PolyforgeWorkflowsDoc | null;
  workspace: PolyforgeWorkflowWorkspace | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function scalar(value: unknown): string | number | undefined {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : undefined;
}

function chains(value: unknown): Record<string, PolyforgeWorkflowChain> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, PolyforgeWorkflowChain> = {};
  for (const [project, chain] of Object.entries(value)) {
    if (isRecord(chain)) out[project] = { models: strings(chain.models), from: str(chain.from) };
  }
  return out;
}

/** `pf --json workflows` → the documented shape (unknown fields dropped). */
export function sanitizeWorkflowsDoc(raw: unknown): PolyforgeWorkflowsDoc | null {
  if (!isRecord(raw) || !Array.isArray(raw.bundles)) return null;
  const bundles: PolyforgeWorkflowBundle[] = [];
  for (const b of raw.bundles) {
    if (!isRecord(b) || !str(b.name)) continue;
    const defaults = isRecord(b.defaults) ? b.defaults : {};
    const steps: PolyforgeWorkflowStep[] = [];
    for (const s of Array.isArray(b.steps) ? b.steps : []) {
      if (!isRecord(s) || !str(s.id)) continue;
      const step: PolyforgeWorkflowStep = { id: str(s.id) };
      if (Array.isArray(s.model_candidates)) step.model_candidates = strings(s.model_candidates);
      if (Array.isArray(s.attrs)) {
        step.attrs = s.attrs.filter(isRecord).map((a) => ({ name: str(a.name), type: str(a.type), default: scalar(a.default) ?? "" }))
          .filter((a) => a.name !== "");
      }
      const effective = chains(s.effective);
      if (effective) step.effective = effective;
      steps.push(step);
    }
    const effective = chains(defaults.effective);
    bundles.push({
      name: str(b.name),
      defaults: { model_candidates: Array.isArray(defaults.model_candidates) ? strings(defaults.model_candidates) : null, ...(effective ? { effective } : {}) },
      steps,
    });
  }
  const task = chains(raw.task);
  return {
    workflows_dir: str(raw.workflows_dir),
    daemon_reachable: raw.daemon_reachable === true,
    reason: str(raw.reason),
    workspace: typeof raw.workspace === "string" ? raw.workspace : null,
    projects: strings(raw.projects),
    write_capable: raw.write_capable === true,
    write_reason: str(raw.write_reason),
    ...(task ? { task } : {}),
    bundles,
    bundle_errors: (Array.isArray(raw.bundle_errors) ? raw.bundle_errors : []).filter(isRecord)
      .map((e) => ({ bundle: str(e.bundle), reason: str(e.reason) })),
  };
}

/** `pf --json config workspace` → the declared values the card reads (null
 *  for an unmapped cwd or a document without the step map). */
export function sanitizeWorkflowWorkspace(raw: unknown): PolyforgeWorkflowWorkspace | null {
  if (!isRecord(raw) || raw.mapped !== true || !isRecord(raw.steps)) return null;
  const yaml = isRecord(raw.yaml) ? raw.yaml : {};
  const steps: PolyforgeWorkflowWorkspace["steps"] = {};
  for (const [project, entries] of Object.entries(raw.steps)) {
    if (!isRecord(entries)) continue;
    steps[project] = {};
    for (const [id, e] of Object.entries(entries)) {
      if (!isRecord(e) || typeof e.declared !== "boolean") continue;
      const step: PolyforgeWorkspaceStep = {
        declared: e.declared,
        models: Array.isArray(e.models) ? strings(e.models) : null,
        source: str(e.source) || "default",
        class: str(e.class),
      };
      if (isRecord(e.attrs)) {
        step.attrs = {};
        for (const [name, a] of Object.entries(e.attrs)) {
          if (!isRecord(a)) continue;
          step.attrs[name] = {
            declared: a.declared === true,
            source: str(a.source) || "default",
            class: str(a.class),
            ...(scalar(a.value) !== undefined ? { value: scalar(a.value) } : {}),
            ...(scalar(a.default) !== undefined ? { default: scalar(a.default) } : {}),
            ...(isRecord(a.schema) && typeof a.schema.kind === "string" ? { schema: { kind: a.schema.kind } } : {}),
          };
        }
      }
      steps[project][id] = step;
    }
  }
  return {
    workspace: str(raw.workspace),
    yaml: { sha256: typeof yaml.sha256 === "string" ? yaml.sha256 : null, exists: yaml.exists === true },
    steps,
  };
}

function runPfJson(argv: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(polyforgePfBin(), argv, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
      if (code !== 0) {
        reject(new Error(stderr.trim().slice(0, 512) || `pf exited ${code ?? 1}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("pf answered something that is not JSON"));
      }
    });
  });
}

/** The one read the workflows route calls. Fresh on every call. */
export async function readPolyforgeWorkflows(cwd: string): Promise<PolyforgeWorkflowsRead> {
  const presence = await probePolyforgeVersion(true);
  if (!presence.present) {
    return { pfPresent: false, pfVersion: null, capable: false, reason: "polyforge is not installed on this machine", workflows: null, workspace: null };
  }
  if (isPolyforgeVersionBelowMinimum(presence.version, POLYFORGE_WORKFLOW_CARD_MINIMUM_PF_VERSION)) {
    return {
      pfPresent: true,
      pfVersion: presence.version,
      capable: false,
      reason: `the workflow card needs pf ${POLYFORGE_WORKFLOW_CARD_MINIMUM_PF_VERSION} or newer (found ${presence.version ?? "an unparseable version"})`,
      workflows: null,
      workspace: null,
    };
  }
  const args = cwd ? ["--cwd", cwd] : [];
  const [workflowsRead, workspaceRead] = await Promise.allSettled([
    runPfJson(["--json", "workflows", ...args]),
    cwd ? runPfJson(["--json", "config", "workspace", "--cwd", cwd]) : Promise.resolve(null),
  ]);
  const workflows = workflowsRead.status === "fulfilled" ? sanitizeWorkflowsDoc(workflowsRead.value) : null;
  const workspace = workspaceRead.status === "fulfilled" ? sanitizeWorkflowWorkspace(workspaceRead.value) : null;
  let reason: string | undefined;
  if (workflowsRead.status === "rejected") {
    reason = workflowsRead.reason instanceof Error ? workflowsRead.reason.message : "pf workflows is unavailable";
  } else if (!workflows) {
    reason = "pf workflows answered without the documented shape";
  } else if (!workflows.daemon_reachable || workflows.reason) {
    reason = workflows.reason || "the daemon is not reachable";
  }
  return {
    pfPresent: true,
    pfVersion: presence.version,
    capable: true,
    ...(reason ? { reason } : {}),
    workflows,
    workspace,
  };
}
