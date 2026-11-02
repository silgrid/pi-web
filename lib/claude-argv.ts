// The claude child's argv and environment. Pure: no I/O.
// Flags as `claude 2.1.312 --help` documents them; the per-preset sets are the
// contract docs/agents/claude-sessions.md states and the tests pin.
import { claudeModelFlag, type ClaudeModelAlias, type ClaudeToolPreset } from "./claude-shared";

/** Print mode, NDJSON user messages on stdin, stream-json events (token deltas included) on stdout. */
export const CLAUDE_STREAM_FLAGS: readonly string[] = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
];

export const CLAUDE_READ_ONLY_TOOLS: readonly string[] = ["Read", "Glob", "Grep"];
export const CLAUDE_WRITABLE_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];
/** Bash is available but not pre-approved: only the config dir's `permissions.allow` lets a command run. */
export const CLAUDE_WRITABLE_ALLOWED_TOOLS: readonly string[] = ["Read", "Glob", "Grep", "Edit", "Write"];

/** The tools a preset makes available (`--tools`), for the session's tool list. */
export function claudePresetTools(preset: ClaudeToolPreset): readonly string[] {
  return preset === "writable" ? CLAUDE_WRITABLE_TOOLS : CLAUDE_READ_ONLY_TOOLS;
}

function presetFlags(preset: ClaudeToolPreset): string[] {
  if (preset === "writable") {
    // No --bare / --strict-mcp-config: the config dir's MCP servers, hooks, plugins and
    // allow/deny rules apply, and claude loads the cwd's CLAUDE.md (known, accepted).
    return [
      "--permission-mode", "acceptEdits",
      "--permission-prompts", "none",
      "--tools", CLAUDE_WRITABLE_TOOLS.join(","),
      "--allowedTools", CLAUDE_WRITABLE_ALLOWED_TOOLS.join(","),
    ];
  }
  // Bare mode skips hooks, plugins and CLAUDE.md auto-discovery; strict MCP loads no server.
  return [
    "--bare",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode", "dontAsk",
    "--permission-prompts", "none",
    "--tools", CLAUDE_READ_ONLY_TOOLS.join(","),
    "--allowedTools", CLAUDE_READ_ONLY_TOOLS.join(","),
  ];
}

export interface ClaudeArgvOptions {
  /** The conversation id: `--session-id` on the first launch, `--resume` on a restart. */
  sessionId: string;
  resume: boolean;
  modelAlias: ClaudeModelAlias;
  preset: ClaudeToolPreset;
}

export function buildClaudeArgv(options: ClaudeArgvOptions): string[] {
  const model = claudeModelFlag(options.modelAlias);
  return [
    ...CLAUDE_STREAM_FLAGS,
    ...presetFlags(options.preset),
    ...(model ? ["--model", model] : []),
    ...(options.resume ? ["--resume", options.sessionId] : ["--session-id", options.sessionId]),
  ];
}

/** Whether a variable of pi-web's environment stays out of the child's. */
export function isWithheldFromClaude(name: string): boolean {
  // CLAUDECODE marks a process running inside claude code: a child must not inherit it either.
  return name === "PI_WEB_PASSWORD" || name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_") || name === "CLAUDECODE";
}

/**
 * The child's environment: a copy of `base` without PI_WEB_PASSWORD and every
 * inherited ANTHROPIC_* / CLAUDE_* variable (and CLAUDECODE), plus CLAUDE_CONFIG_DIR. Credentials
 * come from the config dir's settings.json, never from pi-web. `base` is left as it is.
 */
export function buildClaudeEnv(base: NodeJS.ProcessEnv, configDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || isWithheldFromClaude(name)) continue;
    env[name] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}
