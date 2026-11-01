// Client-safe vocabulary of the claude code harness: which
// harness a session runs on, the fixed model aliases and the two tool presets.
// No Node import: the composer and the sidebar read it too.

export const PI_HARNESS = "pi";
export const CLAUDE_HARNESS = "claude";
export type SessionHarness = typeof PI_HARNESS | typeof CLAUDE_HARNESS;

/** The fixed alias set; `claude-default` lets claude pick its own model (no `--model`). */
export const CLAUDE_MODEL_ALIASES = ["sonnet", "opus", "haiku", "claude-default"] as const;
export type ClaudeModelAlias = typeof CLAUDE_MODEL_ALIASES[number];
export const DEFAULT_CLAUDE_MODEL_ALIAS: ClaudeModelAlias = "claude-default";

/** read-only: Read/Glob/Grep under bare mode; writable: edits auto-accepted, Bash per the config dir's allow list. */
export const CLAUDE_TOOL_PRESETS = ["read-only", "writable"] as const;
export type ClaudeToolPreset = typeof CLAUDE_TOOL_PRESETS[number];
export const DEFAULT_CLAUDE_TOOL_PRESET: ClaudeToolPreset = "read-only";

/** The provider name a claude session's model reports, beside its alias as the model id. */
export const CLAUDE_PROVIDER = "claude";

export function isClaudeHarness(value: unknown): value is typeof CLAUDE_HARNESS {
  return value === CLAUDE_HARNESS;
}

export function isSessionHarness(value: unknown): value is SessionHarness {
  return value === PI_HARNESS || value === CLAUDE_HARNESS;
}

export function isClaudeModelAlias(value: unknown): value is ClaudeModelAlias {
  return typeof value === "string" && (CLAUDE_MODEL_ALIASES as readonly string[]).includes(value);
}

export function isClaudeToolPreset(value: unknown): value is ClaudeToolPreset {
  return typeof value === "string" && (CLAUDE_TOOL_PRESETS as readonly string[]).includes(value);
}

/** The `--model` value of an alias; undefined for `claude-default`, which passes no flag. */
export function claudeModelFlag(alias: ClaudeModelAlias): string | undefined {
  return alias === "claude-default" ? undefined : alias;
}
