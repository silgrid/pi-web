// Client-safe vocabulary of the claude code harness (#250): which
// harness a session runs on and the fixed set of claude models it can pick.
// No Node import: the composer and the sidebar read it too.

export const PI_HARNESS = "pi";
export const CLAUDE_HARNESS = "claude";
export type SessionHarness = typeof PI_HARNESS | typeof CLAUDE_HARNESS;

/**
 * The claude models a session can run, as full names passed to `--model` verbatim.
 * Pinned to the models claude 2.1.312 offers; nothing is discovered at runtime, so
 * a newer claude's models are added here by hand.
 */
export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"] as const;
export type ClaudeModel = typeof CLAUDE_MODELS[number];
export const DEFAULT_CLAUDE_MODEL: ClaudeModel = "claude-opus-5-5";

/** The provider name a claude session's model reports, beside its full name as the model id. */
export const CLAUDE_PROVIDER = "claude";

export function isClaudeHarness(value: unknown): value is typeof CLAUDE_HARNESS {
  return value === CLAUDE_HARNESS;
}

export function isSessionHarness(value: unknown): value is SessionHarness {
  return value === PI_HARNESS || value === CLAUDE_HARNESS;
}

export function isClaudeModel(value: unknown): value is ClaudeModel {
  return typeof value === "string" && (CLAUDE_MODELS as readonly string[]).includes(value);
}

/** The values's index stored (aliases), mapped to their full names. */
const LEGACY_CLAUDE_MODELS: Readonly<Record<string, ClaudeModel>> = {
  opus: "claude-opus-5-5",
  "claude-default": "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/**
 * A stored model value as a full name: a full name stays, a legacy alias maps to its
 * full name, anything else is the default. Never throws, so no record is dropped.
 */
export function normalizeClaudeModel(value: unknown): ClaudeModel {
  if (isClaudeModel(value)) return value;
  if (typeof value === "string" && Object.hasOwn(LEGACY_CLAUDE_MODELS, value)) return LEGACY_CLAUDE_MODELS[value];
  return DEFAULT_CLAUDE_MODEL;
}

/**
 * claude's reasoning effort levels, as `claude 2.1.312 --help` lists
 * them for `--effort`. There is no off / minimal / auto.
 */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffortLevel = typeof CLAUDE_EFFORT_LEVELS[number];
/** The 「默认」 entry: no `--effort`, claude's own default applies. */
export const CLAUDE_EFFORT_DEFAULT = "default";
export type ClaudeEffort = ClaudeEffortLevel | typeof CLAUDE_EFFORT_DEFAULT;

export function isClaudeEffortLevel(value: unknown): value is ClaudeEffortLevel {
  return typeof value === "string" && (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(value);
}

export function isClaudeEffort(value: unknown): value is ClaudeEffort {
  return value === CLAUDE_EFFORT_DEFAULT || isClaudeEffortLevel(value);
}

/** A stored effort value: a level stays, anything else (missing, pre-#272, unknown) is the default. Never throws. */
export function normalizeClaudeEffort(value: unknown): ClaudeEffort {
  return isClaudeEffortLevel(value) ? value : CLAUDE_EFFORT_DEFAULT;
}

/**
 * Levels a model refuses, with the reason shown beside it. Evidence only: an entry
 * needs a recording of claude rejecting that level for that model, and the
 * recordings show none (lib/__fixtures__/claude-2.1.312/README.md).
 */
export const CLAUDE_EFFORT_EXCLUSIONS: Readonly<Partial<Record<ClaudeModel, Readonly<Partial<Record<ClaudeEffortLevel, string>>>>>> = {};

/** The first message an image-only claude prompt is listed with, in every locale. */
export const CLAUDE_IMAGE_FIRST_MESSAGE = "[Image]";

/**
 * A claude session's first message: the prompt's text as typed when there is any,
 * else `[Image]` when it carries images, else "". The client's transient row and the
 * server's index record both use it.
 */
export function claudeFirstMessage(text: string, imageCount: number): string {
  if (text.trim()) return text;
  return imageCount > 0 ? CLAUDE_IMAGE_FIRST_MESSAGE : "";
}
