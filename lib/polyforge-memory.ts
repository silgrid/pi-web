import { execFileAsync } from "./exec-file";
import { parsePfError } from "./polyforge-config-write";
import { isPolyforgeVersionBelowMinimum } from "./polyforge-detect";
import { probePolyforgeVersion } from "./polyforge-status";
import { workspaceProjects } from "../components/polyforge-config-helpers";
import {
  isMemoryTagList,
  isPolyforgeMemoryId,
  MEMORY_RESULT_LIMIT,
  MEMORY_TYPE_FILTERS,
  type MemoryTypeFilter,
  type PolyforgeMemoryDetail,
  type PolyforgeMemoryHit,
} from "./polyforge-memory-pure";

/**
 * Server-side reads for the Memory tab. Every fact comes from
 * a `pf` subprocess through `execFileAsync` (no shell); every argv value is
 * validated here, before any spawn. The HTTP faces under
 * `app/api/polyforge/memory/**` only degrade and answer.
 *
 * The sanitizers are the only passport off this module: a hit keeps exactly
 * id/type/title/visibility/status/tags/related/work_item_id/created_at/
 * updated_at/content_len and the detail adds `content` (capped at
 * MEMORY_BODY_FORWARD_CAP). `owner_user_id`, `project_id`, `content_sha`,
 * `content_excerpt` and every unknown field never leave the server, and no
 * response carries the pf api key, user id, server address or an environment
 * value. No memory body is ever logged.
 */

/** The release every flag this panel uses was observed on (Assumption 2). */
export const POLYFORGE_MEMORY_MINIMUM_PF_VERSION = "2.20.9";

/** The body this module forwards, cut on a code-point boundary (Assumption 4). */
export const MEMORY_BODY_FORWARD_CAP = 262144;

const READ_TIMEOUT_MS = 15000;
/** A large recall answer degrades through the normal path, not an unbounded
 *  buffer (D5): 8 MiB is far above a 200-hit sanitized-in-flight answer. */
const SPAWN_MAX_BUFFER = 8 * 1024 * 1024;
/** pf's own stderr passes through under this cap; nothing else is echoed. */
const STDERR_CAP = 512;
/** A cwd is a path: this bound keeps argv bounded, nothing more. */
const CWD_MAX_BYTES = 4096;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export { isMemoryTagList, isPolyforgeMemoryId } from "./polyforge-memory-pure";
export type { MemoryTypeFilter, PolyforgeMemoryDetail, PolyforgeMemoryHit } from "./polyforge-memory-pure";

/** A search after validation, in the CLI's own face. */
export interface PolyforgeMemorySearchInput {
  cwd: string;
  q: string;
  project: string;
  type: MemoryTypeFilter;
  tags?: string;
  any?: boolean;
}

/** pf's typed/plain failure text, bounded: never our argv, never env values. */
export class PolyforgeMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolyforgeMemoryError";
  }

  static fromSpawnError(error: unknown): PolyforgeMemoryError {
    if (error instanceof Error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      if (stderr) {
        return new PolyforgeMemoryError(parsePfError(stderr).message.slice(0, STDERR_CAP));
      }
    }
    return new PolyforgeMemoryError("polyforge is unavailable");
  }
}

// ---- validation (shape only, before any spawn) ----

function hasControlBytes(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Validate the search face's raw params (Requirement 3 / D4): every value
 *  is checked here, so a refusal answers 400 with no pf process at all —
 *  the version probe included. Project membership is NOT here: "one of the
 *  projects the panel offered" needs the config read that defines it. */
export function validateMemorySearch(params: {
  cwd: unknown;
  q: unknown;
  project: unknown;
  type: unknown;
  tags?: unknown;
  any?: unknown;
}): ValidationResult<PolyforgeMemorySearchInput> {
  const cwd = params.cwd;
  if (typeof cwd !== "string" || !cwd.trim() || hasControlBytes(cwd) || Buffer.byteLength(cwd, "utf8") > CWD_MAX_BYTES) {
    return { ok: false, error: "cwd must be a directory path" };
  }
  const q = params.q;
  if (typeof q !== "string" || !q.trim()) return { ok: false, error: "a keyword is required" };
  if (q.startsWith("-")) return { ok: false, error: "the keyword must not start with '-'" };
  if (hasControlBytes(q)) return { ok: false, error: "the keyword carries control bytes" };
  const project = params.project;
  if (typeof project !== "string" || !PROJECT_NAME.test(project)) {
    return { ok: false, error: "project must be a project name" };
  }
  const type = params.type;
  if (typeof type !== "string" || !(MEMORY_TYPE_FILTERS as readonly string[]).includes(type)) {
    return { ok: false, error: "type must be one of the six dropdown values" };
  }
  const tags = params.tags;
  if (tags !== undefined && tags !== "" && !isMemoryTagList(tags)) {
    return { ok: false, error: "tags must be a comma-separated list of tag tokens" };
  }
  const value: PolyforgeMemorySearchInput = {
    cwd,
    q,
    project,
    type: type as MemoryTypeFilter,
  };
  if (tags !== undefined && tags !== "") value.tags = tags;
  if (params.any === "1" || params.any === true) value.any = true;
  return { ok: true, value };
}

/** The exact search argv (D2): one `pf recall`, the keyword as the one
 *  positional, `--limit 200`, and the three optional filters opt-in. `*` is
 *  sent as no `--type` (the default search). Exported for tests. */
export function buildRecallArgv(input: PolyforgeMemorySearchInput): string[] {
  const argv = ["--json", "recall", "--project", input.project, "--limit", String(MEMORY_RESULT_LIMIT)];
  if (input.any) argv.push("--any");
  if (input.tags) argv.push("--tags", input.tags);
  if (input.type !== "*") argv.push("--type", input.type);
  argv.push(input.q);
  return argv;
}

// ---- pure sanitizers (the only passport) ----

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

/** One hit, cut to the allowed field set. `owner_user_id`, `project_id`,
 *  `content_sha`, `content_excerpt` and unknown fields never pass; an
 *  invalid id drops the row. */
export function sanitizeMemoryHit(raw: unknown): PolyforgeMemoryHit | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!isPolyforgeMemoryId(id)) return null;
  const workItem = str(row.work_item_id);
  return {
    id,
    type: str(row.type),
    title: str(row.title),
    visibility: str(row.visibility),
    status: str(row.status),
    tags: strList(row.tags),
    related: strList(row.related),
    work_item_id: workItem || null,
    created_at: str(row.created_at),
    updated_at: str(row.updated_at),
    content_len: num(row.content_len),
  };
}

/** The recall answer: only its `items` list, each through the hit passport. */
export function sanitizeMemorySearchAnswer(raw: unknown): PolyforgeMemoryHit[] {
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((entry) => {
    const hit = sanitizeMemoryHit(entry);
    return hit ? [hit] : [];
  });
}

/** Cut a body to at most `cap` UTF-8 bytes on a code-point boundary. */
function capUtf8Bytes(value: string, cap: number): string {
  if (Buffer.byteLength(value, "utf8") <= cap) return value;
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > cap) break;
    bytes += size;
    end += char.length;
  }
  return value.slice(0, end);
}

/** One single-memory read: the hit's field set plus `content`, capped at
 *  MEMORY_BODY_FORWARD_CAP. There is no truncation wire field — the client
 *  compares the body with `content_len` (D6). */
export function sanitizeMemoryDetail(raw: unknown): PolyforgeMemoryDetail | null {
  const hit = sanitizeMemoryHit(raw);
  if (!hit) return null;
  const content = typeof (raw as Record<string, unknown>).content === "string"
    ? (raw as Record<string, unknown>).content as string
    : "";
  return { ...hit, content: capUtf8Bytes(content, MEMORY_BODY_FORWARD_CAP) };
}

// ---- transport ----

async function runPfJson(argv: string[], timeoutMs = READ_TIMEOUT_MS): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("pf", argv, { timeout: timeoutMs, maxBuffer: SPAWN_MAX_BUFFER });
    return JSON.parse(stdout);
  } catch (error) {
    throw PolyforgeMemoryError.fromSpawnError(error);
  }
}

export interface PolyforgeMemoryCapability {
  pfPresent: boolean;
  pfVersion: string | null;
  capable: boolean;
  reason?: string;
}

/** The Memory floor gate: presence + the 2.20.9 capability floor, from the
 *  one existing version probe. Below it no memory verb is spawned. */
export async function readPolyforgeMemoryCapability(): Promise<PolyforgeMemoryCapability> {
  const presence = await probePolyforgeVersion();
  if (!presence.present) {
    return { pfPresent: false, pfVersion: null, capable: false };
  }
  if (isPolyforgeVersionBelowMinimum(presence.version, POLYFORGE_MEMORY_MINIMUM_PF_VERSION)) {
    return {
      pfPresent: true,
      pfVersion: presence.version,
      capable: false,
      reason: `the Memory tab needs pf ${POLYFORGE_MEMORY_MINIMUM_PF_VERSION} or newer (found ${presence.version ?? "an unparseable version"})`,
    };
  }
  return { pfPresent: true, pfVersion: presence.version, capable: true };
}

// ---- the project scope (D3: the config panel's cwd→workspace rule) ----

/** The projects of the workspace the cwd maps to (Assumption 8): first
 *  `pf --json config workspace --cwd <cwd>`, then the
 *  `[workspace."<name>"]` item of `pf --json config list`, split with the
 *  config panel's own `workspaceProjects` helper — one rule, one place. An
 *  unmapped cwd answers `{ mapped: false }` with no second read. A spawn
 *  failure throws (the route degrades it); an unparsable answer maps to
 *  nothing, never a guess. */
export async function readPolyforgeMemoryProjects(cwd: string): Promise<{ mapped: boolean; projects: string[] }> {
  const workspaceAnswer = await runPfJson(["--json", "config", "workspace", "--cwd", cwd]);
  const mapped = !!(workspaceAnswer && typeof workspaceAnswer === "object"
    && (workspaceAnswer as { mapped?: unknown }).mapped === true);
  if (!mapped) return { mapped: false, projects: [] };
  const workspace = str((workspaceAnswer as { workspace?: unknown }).workspace);
  if (!workspace) return { mapped: false, projects: [] };
  const listAnswer = await runPfJson(["--json", "config", "list"]);
  const items = listAnswer && typeof listAnswer === "object" && Array.isArray((listAnswer as { items?: unknown }).items)
    ? (listAnswer as { items: unknown[] }).items
    : [];
  const wantedKey = `[workspace."${workspace}"]`;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { key?: unknown; value?: unknown };
    if (row.key === wantedKey) return { mapped: true, projects: workspaceProjects(row.value) };
  }
  return { mapped: false, projects: [] };
}

// ---- the two read faces (D2) ----

/** The search face: exactly one `pf recall` (the argv of buildRecallArgv).
 *  The caller has validated the shape and the capability; membership is the
 *  route's, so this function only transports and sanitizes. */
export async function searchPolyforgeMemory(input: PolyforgeMemorySearchInput): Promise<PolyforgeMemoryHit[]> {
  const raw = await runPfJson(buildRecallArgv(input));
  return sanitizeMemorySearchAnswer(raw);
}

/** The single-memory face: exactly one `pf memory show`, body capped. A
 *  pf-side miss (MEM-404) throws pf's own text; a malformed upstream answer
 *  degrades to null, never a guess. */
export async function showPolyforgeMemory(id: string): Promise<PolyforgeMemoryDetail | null> {
  const raw = await runPfJson(["--json", "memory", "show", id]);
  return sanitizeMemoryDetail(raw);
}
