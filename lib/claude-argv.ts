// The claude child's argv and environment (#250, #272). Pure: no I/O.
import { agentLanguageInstruction, type AgentLanguage } from "./agent-language";
import { CLAUDE_EFFORT_DEFAULT, type ClaudeEffort } from "./claude-shared";

// Flags as `claude 2.1.312 --help` documents them; docs/agents/claude-sessions.md
// states the one reduced set and the tests pin it.

/** Print mode, NDJSON user messages on stdin, stream-json events (token deltas included) on stdout. */
export const CLAUDE_STREAM_FLAGS: readonly string[] = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
];

export interface ClaudeArgvOptions {
  /** The conversation id: `--session-id` on the first launch, `--resume` on a restart. */
  sessionId: string;
  resume: boolean;
  /** The session's full model name, passed verbatim. */
  model: string;
  /** The session's effort: `--effort <level>` unless it is the default entry. */
  effort?: ClaudeEffort;
  /**
   * The session's Agent language: 中文 adds `--append-system-prompt`
   * with the fixed instruction; English or absent adds nothing.
   */
  agentLanguage?: AgentLanguage;
}

function appendSystemPromptFlag(language: AgentLanguage | undefined): string[] {
  const instruction = agentLanguageInstruction(language);
  return instruction === undefined ? [] : ["--append-system-prompt", instruction];
}

/**
 * The reduced argv: no preset, tool or permission-mode flag and no `--cwd` (the
 * session folder is the spawn's cwd). Tools, MCP servers, hooks and CLAUDE.md are the
 * user's claude config's; `--permission-prompts none` makes claude deny an action that
 * would ask, which the adapter shows as a tool error instead of a waiting turn.
 */
export function buildClaudeArgv(options: ClaudeArgvOptions): string[] {
  return [
    ...CLAUDE_STREAM_FLAGS,
    "--model", options.model,
    ...(options.effort && options.effort !== CLAUDE_EFFORT_DEFAULT ? ["--effort", options.effort] : []),
    ...appendSystemPromptFlag(options.agentLanguage),
    "--permission-prompts", "none",
    ...(options.resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId]),
  ];
}

/** Whether a variable of pi-web's environment stays out of the child's. */
export function isWithheldFromClaude(name: string): boolean {
  // pi-web's own password never leaves it; CLAUDECODE marks a process running inside
  // claude code, which the child must not believe of itself.
  return name === "PI_WEB_PASSWORD" || name === "CLAUDECODE";
}

/**
 * The child's environment: a copy of `base` without PI_WEB_PASSWORD and
 * CLAUDECODE. Nothing is set: the system claude runs with the user's own ANTHROPIC_* /
 * CLAUDE_* variables (CLAUDE_CONFIG_DIR only when pi-web inherited it). `base` is left as it is.
 */
export function buildClaudeEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isWithheldFromClaude(name)) continue;
    env[name] = value;
  }
  return env;
}
