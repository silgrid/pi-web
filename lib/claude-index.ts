// pi-web's own index of the claude sessions it created:
// `<pi agent dir>/claude-sessions.json`. The session list shows exactly these
// rows; nothing scans claude's projects dir and nothing is mirrored into the
// pi sessions store. The conversation itself stays in claude's transcript.
import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { defaultAgentDir } from "./http-dispatcher";
import { serializeByKey } from "./key-serializer";
import { invalidateSessionListCache } from "./session-reader";
import { isClaudeModelAlias, isClaudeToolPreset, type ClaudeModelAlias, type ClaudeToolPreset } from "./claude-shared";

/** Token and cost totals, summed from each turn's `result` aggregate. */
export interface ClaudeUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ClaudeSessionRecord {
  /** claude's session id (`--session-id` on the first launch), also pi-web's. */
  id: string;
  cwd: string;
  name?: string;
  modelAlias: ClaudeModelAlias;
  preset: ClaudeToolPreset;
  created: string;
  modified: string;
  firstMessage: string;
  usage: ClaudeUsageTotals;
  archived?: boolean;
}

export const EMPTY_CLAUDE_USAGE: ClaudeUsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

const WRITE_CHAIN = Symbol.for("pi-web.claudeIndexWrites");

export function claudeIndexPath(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "claude-sessions.json");
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseRecord(value: unknown): ClaudeSessionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.cwd !== "string") return null;
  if (!isClaudeModelAlias(raw.modelAlias) || !isClaudeToolPreset(raw.preset)) return null;
  const usage = (typeof raw.usage === "object" && raw.usage !== null ? raw.usage : {}) as Record<string, unknown>;
  const created = typeof raw.created === "string" ? raw.created : new Date(0).toISOString();
  return {
    id: raw.id,
    cwd: raw.cwd,
    ...(typeof raw.name === "string" && raw.name ? { name: raw.name } : {}),
    modelAlias: raw.modelAlias,
    preset: raw.preset,
    created,
    modified: typeof raw.modified === "string" ? raw.modified : created,
    firstMessage: typeof raw.firstMessage === "string" ? raw.firstMessage : "",
    usage: {
      input: finite(usage.input),
      output: finite(usage.output),
      cacheRead: finite(usage.cacheRead),
      cacheWrite: finite(usage.cacheWrite),
      cost: finite(usage.cost),
    },
    ...(raw.archived === true ? { archived: true } : {}),
  };
}

/** Every record; a missing or unreadable file reads as an empty index (never throws). */
export function readClaudeIndex(agentDir?: string): ClaudeSessionRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(claudeIndexPath(agentDir), "utf8"));
  } catch {
    return [];
  }
  const sessions = (parsed as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.map(parseRecord).filter((record): record is ClaudeSessionRecord => record !== null);
}

export function getClaudeSessionRecord(id: string, agentDir?: string): ClaudeSessionRecord | undefined {
  return readClaudeIndex(agentDir).find((record) => record.id === id);
}

/**
 * Read-modify-write of the whole index, one at a time per file, written atomically.
 * Every mutation bumps the session list version.
 */
function mutateIndex<T>(
  agentDir: string | undefined,
  change: (records: ClaudeSessionRecord[]) => { records: ClaudeSessionRecord[]; result: T },
): Promise<T> {
  const path = claudeIndexPath(agentDir);
  return serializeByKey(WRITE_CHAIN, path, async () => {
    const { records, result } = change(readClaudeIndex(agentDir));
    mkdirSync(dirname(path), { recursive: true });
    writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, sessions: records }, null, 2)}\n`);
    invalidateSessionListCache();
    return result;
  });
}

/** Inserts the record, or replaces the one with its id. */
export function upsertClaudeSessionRecord(record: ClaudeSessionRecord, agentDir?: string): Promise<ClaudeSessionRecord> {
  return mutateIndex(agentDir, (records) => ({
    records: [...records.filter((existing) => existing.id !== record.id), record],
    result: record,
  }));
}

/** Applies `patch` to an existing record (modified is stamped); undefined when the id is unknown. */
export function updateClaudeSessionRecord(
  id: string,
  patch: (record: ClaudeSessionRecord) => ClaudeSessionRecord,
  agentDir?: string,
): Promise<ClaudeSessionRecord | undefined> {
  return mutateIndex(agentDir, (records) => {
    let updated: ClaudeSessionRecord | undefined;
    const next = records.map((record) => {
      if (record.id !== id) return record;
      updated = { ...patch(record), id: record.id };
      return updated;
    });
    return { records: next, result: updated };
  });
}

/** Removes the record; true when it existed. */
export function removeClaudeSessionRecord(id: string, agentDir?: string): Promise<boolean> {
  return mutateIndex(agentDir, (records) => {
    const next = records.filter((record) => record.id !== id);
    return { records: next, result: next.length !== records.length };
  });
}

/** Adds one turn's `result` aggregate to the session's totals. */
export function recordClaudeUsage(
  id: string,
  usage: ClaudeUsageTotals,
  agentDir?: string,
): Promise<ClaudeSessionRecord | undefined> {
  return updateClaudeSessionRecord(id, (record) => ({
    ...record,
    modified: new Date().toISOString(),
    usage: {
      input: record.usage.input + usage.input,
      output: record.usage.output + usage.output,
      cacheRead: record.usage.cacheRead + usage.cacheRead,
      cacheWrite: record.usage.cacheWrite + usage.cacheWrite,
      cost: record.usage.cost + usage.cost,
    },
  }), agentDir);
}
