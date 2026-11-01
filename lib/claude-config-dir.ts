// The dedicated claude config dir pi-web runs every claude child with
// `<pi agent dir>/claude`, following PI_CODING_AGENT_DIR,
// never the service user's ~/.claude. pi-web creates it with a credential-free
// settings.json and never reads or rewrites what the user puts there.
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { defaultAgentDir } from "./http-dispatcher";

/** What a fresh settings.json holds: nothing, so no credential can be in it. */
export const DEFAULT_CLAUDE_SETTINGS = "{}\n";

export function claudeConfigDir(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "claude");
}

export function claudeSettingsPath(agentDir?: string): string {
  return join(claudeConfigDir(agentDir), "settings.json");
}

/**
 * Creates the dir (0700) and, only when absent, its settings.json (0600, atomic).
 * An existing file keeps every byte. Returns the dir.
 */
export function ensureClaudeConfigDir(agentDir?: string): string {
  const dir = claudeConfigDir(agentDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const settings = join(dir, "settings.json");
  if (!existsSync(settings)) {
    try {
      writePrivateFileAtomicSync(settings, DEFAULT_CLAUDE_SETTINGS);
    } catch (error) {
      // Another request created it meanwhile: theirs stays.
      if (!existsSync(settings)) throw error;
    }
  }
  return dir;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/**
 * The transcript claude writes for `sessionId`: `<dir>/projects/<any>/<id>.jsonl`.
 * Looked up by id, never by guessing claude's cwd encoding. Null when absent.
 */
export function claudeTranscriptFile(sessionId: string, agentDir?: string): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const projects = join(claudeConfigDir(agentDir), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Removes that session's transcript only. True when one was removed. */
export function removeClaudeTranscript(sessionId: string, agentDir?: string): boolean {
  const file = claudeTranscriptFile(sessionId, agentDir);
  if (!file) return false;
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}
