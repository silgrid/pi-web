import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hasConfigListShape, POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION } from "./polyforge-config";
import { isPolyforgeVersionBelowMinimum } from "./polyforge-detect";
import { probePolyforgeVersion } from "./polyforge-status";
import {
  appendPolyforgeConfigHistory,
  type PolyforgeConfigHistoryEntry,
} from "./polyforge-config-history";

/**
 * The panel's write path. It is the only module allowed to
 * mutate configuration, and it can only do so through `pf`: one no-shell
 * spawn helper, the exact writable-key allowlist, and api_key on stdin only.
 * No value from this module is ever logged or echoed in an error.
 */

export const WRITABLE_KEYS = new Set([
  "max_concurrent_jobs",
  "step_timeout",
  "stall_window",
  "summarize.models",
  "summarize.language",
  "summarize.interval_sec",
  "api_key",
]);

const WRITE_TIMEOUT_MS = 30000;

export class ConfigWriteError extends Error {
  status: number;
  diff?: unknown;
  constructor(message: string, status = 400, diff?: unknown) {
    super(message);
    this.name = "ConfigWriteError";
    this.status = status;
    this.diff = diff;
  }
}

interface PfRun {
  code: number;
  stdout: string;
  stderr: string;
}

function runPf(argv: string[], stdin?: string): Promise<PfRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("pf", argv, { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ConfigWriteError("pf did not answer in time", 504));
    }, WRITE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ConfigWriteError(error instanceof Error ? error.message : "polyforge is unavailable", 503));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** pf's typed error envelope, both the CLI's own api.Error and the wrapped
 *  `{error: …}` shape a stub/older build may use. pf keeps api_key out of the
 *  detail and diff by contract (the CLI reports a changed/unchanged bit with
 *  the value redacted); this function returns `detail`/`message` and `extra`
 *  verbatim and does no redaction of its own. */
export function parsePfError(stderr: string): { status: number; message: string; diff?: unknown } {
  const text = stderr.trim();
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart)) as Record<string, unknown>;
      const envelope = (parsed.error && typeof parsed.error === "object" ? parsed.error : parsed) as Record<string, unknown>;
      const code = typeof envelope.code === "string" ? envelope.code : "";
      const detail = typeof envelope.detail === "string" ? envelope.detail
        : typeof envelope.message === "string" ? envelope.message : "pf refused the write";
      const extra = envelope.extra;
      const status = /-(409)$/.test(code) ? 409 : /-4\d\d$/.test(code) ? 400 : 400;
      return { status, message: detail, diff: extra };
    } catch {
      // fall through to pf's plain stderr
    }
  }
  return { status: 400, message: text.slice(0, 512) || "pf refused the write" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertShape(key: string, value: unknown): void {
  if (key === "api_key") {
    if (typeof value !== "string" || value === "") throw new ConfigWriteError("api_key must be a non-empty string");
    return;
  }
  if (key === "summarize.models") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new ConfigWriteError("summarize.models must be an ordered list of model candidates");
    }
    return;
  }
  if (key === "summarize.language") {
    if (typeof value !== "string" || value.trim() === "") throw new ConfigWriteError("summarize.language must be a non-empty string");
    return;
  }
  if (key === "summarize.interval_sec" || key === "max_concurrent_jobs") {
    const okNumber = typeof value === "number" && Number.isInteger(value);
    const okString = typeof value === "string" && /^-?\d+$/.test(value.trim());
    if (!okNumber && !okString) throw new ConfigWriteError(`${key} must be an integer`);
    return;
  }
  if (key === "step_timeout" || key === "stall_window") {
    if (typeof value !== "string" || value.trim() === "") throw new ConfigWriteError(`${key} must be a duration string`);
    return;
  }
}

function valueArg(key: string, value: unknown): string {
  if (key === "summarize.models") return JSON.stringify(value);
  return String(value);
}

async function opsReachable(): Promise<boolean> {
  const run = await runPf(["--json", "ops", "status"]);
  return run.code === 0;
}

async function readConfigList(): Promise<Record<string, unknown>> {
  const run = await runPf(["--json", "config", "list"]);
  if (run.code !== 0) {
    const failure = parsePfError(run.stderr);
    throw new ConfigWriteError(failure.message, failure.status, failure.diff);
  }
  return JSON.parse(run.stdout) as Record<string, unknown>;
}


export interface ConfigWriteRequest {
  action: "set" | "unset";
  key: string;
  value?: unknown;
  cwd?: string;
  expect_state?: unknown;
}

export interface ConfigWriteResult {
  ok: true;
  key: string;
  outcome: "applied" | "saved";
  message: string;
  entry: PolyforgeConfigHistoryEntry | null;
  daemonReachable: boolean;
}

/** The write surface stays unavailable below the configuration panel's
 *  capability floor (or with a list that lacks the class/schema shape). The
 *  check is a read only: it never spawns a write/workspace verb. */
async function assertWritableCapability(): Promise<void> {
  const presence = await probePolyforgeVersion(true);
  if (!presence.present) throw new ConfigWriteError("polyforge is not installed on this machine", 400);
  if (isPolyforgeVersionBelowMinimum(presence.version, POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION)) {
    throw new ConfigWriteError(`the configuration panel needs pf ${POLYFORGE_CONFIG_PANEL_MINIMUM_PF_VERSION} or newer (found ${presence.version ?? "an unparseable version"})`, 400);
  }
  const list = await readConfigList();
  if (!hasConfigListShape(list)) {
    throw new ConfigWriteError("this pf reports the configuration list without the class/schema shape the panel needs", 400);
  }
}

interface CurrentValue {
  class: string;
  hash: string | null;
  exists: boolean;
  value: unknown;
  set: boolean;
  workspace?: string;
}

/** The value a key has in the file right now, read through pf. The write path
 *  records `old` from here (never from the previous history entry), and takes
 *  the CAS hash of the file the key actually lives in (cli.toml for the cli
 *  keys, the workspace yaml for summarize.*). */
async function readCurrentValue(key: string, cwd: string): Promise<CurrentValue> {
  if (key.startsWith("summarize.")) {
    const run = await runPf(["--json", "config", "workspace", "--cwd", cwd]);
    if (run.code !== 0) {
      const failure = parsePfError(run.stderr);
      throw new ConfigWriteError(failure.message, failure.status, failure.diff);
    }
    const doc = JSON.parse(run.stdout) as Record<string, unknown>;
    const workspace = typeof doc.workspace === "string" ? doc.workspace : cwd;
    const yaml = isRecord(doc.yaml) ? doc.yaml : {};
    const name = key.slice("summarize.".length);
    const entry = isRecord(doc.summarize) && isRecord(doc.summarize[name]) ? doc.summarize[name] : {};
    const source = typeof entry.source === "string" ? entry.source : "default";
    const fromFile = source === "file";
    return {
      class: typeof entry.class === "string" ? entry.class : "",
      hash: typeof yaml.sha256 === "string" ? yaml.sha256 : null,
      exists: yaml.exists !== false,
      value: fromFile ? entry.value ?? null : null,
      set: fromFile,
      workspace,
    };
  }
  const list = await readConfigList();
  const file = isRecord(list.file) ? list.file : {};
  const items = Array.isArray(list.items) ? list.items : [];
  const item = items.find((it) => isRecord(it) && it.key === key);
  const cls = item && typeof item.class === "string" ? item.class : "";
  const hash = typeof file.sha256 === "string" ? file.sha256 : null;
  const exists = file.exists !== false;
  if (key === "api_key") {
    const set = Boolean(item && item.set === true);
    return { class: cls, hash, exists, value: { set }, set };
  }
  const source = item && typeof item.source === "string" ? item.source : "default";
  const fromFile = source === "file";
  return { class: cls, hash, exists, value: fromFile ? item?.value ?? null : null, set: fromFile };
}

/** pf's reload class → the result text. A restart-only key never claims to be
 *  applied by the running daemon; a down daemon always says the next start. */
function writeMessage(cls: string, reachable: boolean): { outcome: "applied" | "saved"; text: string } {
  if (!reachable) return { outcome: "saved", text: "saved; the value applies at the next daemon start" };
  switch (cls) {
    case "restart-only":
      return { outcome: "saved", text: "saved; the value applies after a daemon restart" };
    case "next-claim":
      return { outcome: "saved", text: "saved; applies at the next claim" };
    case "cli-only":
      return { outcome: "saved", text: "saved (cli-only); applies to the next pf invocation" };
    default:
      return { outcome: "applied", text: "applied" };
  }
}

async function executeWrite(body: ConfigWriteRequest): Promise<ConfigWriteResult> {
  await assertWritableCapability();
  const key = typeof body.key === "string" ? body.key : "";
  if (!WRITABLE_KEYS.has(key)) throw new ConfigWriteError(`key ${JSON.stringify(key)} is not writable from the panel`, 400);
  const action = body.action;
  if (action !== "set" && action !== "unset") throw new ConfigWriteError("action must be set or unset");
  const cwd = typeof body.cwd === "string" ? body.cwd : "";
  const scope: "cli" | "workspace" = key.startsWith("summarize.") ? "workspace" : "cli";
  if (scope === "workspace" && !cwd) throw new ConfigWriteError("a workspace write needs cwd");
  if (action === "set") assertShape(key, body.value);

  // A fresh read gives the file value before the write (the history's `old`)
  // and the file the key lives in (the CAS hash).
  const current = await readCurrentValue(key, scope === "workspace" ? cwd : "");

  const argv = ["--json", "config", action, key];
  let stdin: string | undefined;
  if (action === "set") {
    if (key === "api_key") {
      stdin = `${String(body.value)}\n`;
    } else {
      argv.push(valueArg(key, body.value));
    }
  }
  if (scope === "workspace") argv.push("--cwd", cwd);
  if (isRecord(body.expect_state)) argv.push("--expect-state", JSON.stringify(body.expect_state));

  const run = await runPf(argv, stdin);
  if (run.code !== 0) {
    const failure = parsePfError(run.stderr);
    throw new ConfigWriteError(failure.message, failure.status, failure.diff);
  }

  const reachable = await opsReachable();
  const secret = key === "api_key";
  const old = secret ? { set: current.set } : current.set ? current.value : null;
  const entry: PolyforgeConfigHistoryEntry = {
    id: randomUUID(),
    at: new Date().toISOString(),
    scope,
    // Workspace entries key by the resolved workspace, never the raw cwd.
    cwd: scope === "workspace" ? current.workspace ?? cwd : "",
    key,
    old,
    new: secret ? { set: action === "set" } : action === "set" ? body.value : null,
    secret,
    rollbackable: !secret,
  };
  await appendPolyforgeConfigHistory(entry);
  const message = writeMessage(current.class, reachable);
  return { ok: true, key, outcome: message.outcome, message: message.text, entry, daemonReachable: reachable };
}

export async function writePolyforgeConfig(body: ConfigWriteRequest): Promise<ConfigWriteResult> {
  return executeWrite(body);
}

export interface ConfigRollbackRequest {
  id?: string;
  key?: string;
  old?: unknown;
  cwd?: string;
  entry?: PolyforgeConfigHistoryEntry;
}

/** Rollback is a fresh read followed by the SAME CAS write path; it appends
 *  a new entry and never touches api_key (non-rollbackable). The entry's own
 *  workspace is used, never the panel's current cwd, and an entry with no old
 *  value rolls back to `unset` as the spec says. */
export async function rollbackPolyforgeConfig(body: ConfigRollbackRequest): Promise<ConfigWriteResult> {
  const entry = body.entry;
  const key = typeof body.key === "string" ? body.key : entry?.key ?? "";
  if (!WRITABLE_KEYS.has(key)) throw new ConfigWriteError(`key ${JSON.stringify(key)} is not writable from the panel`, 400);
  if (key === "api_key") throw new ConfigWriteError("api_key entries are not rollbackable", 400);
  const scope: "cli" | "workspace" = key.startsWith("summarize.") ? "workspace" : "cli";
  const workspace = scope === "workspace" ? entry?.cwd ?? "" : "";
  if (scope === "workspace" && !workspace) throw new ConfigWriteError("this workspace entry has no workspace to roll back to", 400);
  const current = await readCurrentValue(key, workspace);
  const expectState: Record<string, unknown> = { file_sha256: current.hash };
  const target = body.old !== undefined ? body.old : entry?.old;
  if (target === null || target === undefined) {
    return executeWrite({ action: "unset", key, cwd: workspace, expect_state: expectState });
  }
  return executeWrite({ action: "set", key, value: target, cwd: workspace, expect_state: expectState });
}

export async function reloadPolyforgeConfig(): Promise<{ reloaded: unknown; daemon: unknown }> {
  const run = await runPf(["--json", "config", "reload"]);
  if (run.code !== 0) {
    const failure = parsePfError(run.stderr);
    throw new ConfigWriteError(failure.message, failure.status, failure.diff);
  }
  let reloaded: unknown = null;
  try { reloaded = JSON.parse(run.stdout); } catch { reloaded = null; }
  const status = await runPf(["--json", "ops", "status"]);
  let daemon: unknown = null;
  if (status.code === 0) {
    try { daemon = JSON.parse(status.stdout); } catch { daemon = null; }
  }
  return { reloaded, daemon };
}
