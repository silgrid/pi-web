/**
 * Pure presentation helpers for Settings › Polyforge's configuration panel
 *. Import-free on purpose, like `lib/polyforge-config-schema.ts`:
 * the client component imports it, so it must never pull a server module into
 * the browser bundle. Nothing here changes what is read or written — it only
 * decides which card a `pf --json config list` item renders in and how a
 * workspace mapping row is displayed.
 */

/** The minimal item shape the helpers need (structurally a PolyforgeConfigItem). */
export interface ConfigItemLike {
  key: string;
  value?: unknown;
  section?: boolean;
}

/**
 * pf's `[daemon]` table keys (pi-web `internal/polyforge/cli/config_keys.go`).
 * `pf --json config list` does not mark table membership, so the panel keeps
 * this copy to put them in the daemon card. Drift cost: a `[daemon]` key pf
 * adds later renders in the cli.toml card until this list is extended —
 * cosmetic only. Distinct from the panel's daemon *column* (the three keys
 * whose live value the daemon reports).
 */
export const DAEMON_TABLE_KEYS: readonly string[] = [
  "step_timeout",
  "stall_window",
  "harness_root",
  "operator_agent_dir",
  "max_concurrent_jobs",
];

export type ConfigGroupId = "flat" | "daemon" | "workspace" | "summarize";

/** Fixed card order: cli.toml flat keys, `[daemon]`, workspace mapping, summarize. */
export const CONFIG_GROUPS: readonly ConfigGroupId[] = ["flat", "daemon", "workspace", "summarize"];

/** The card an item renders in; an unknown key falls into the flat card (never dropped). */
export function configGroupOf(item: ConfigItemLike): ConfigGroupId {
  if (item.section === true) return "workspace";
  if (item.key.startsWith("summarize.")) return "summarize";
  if (DAEMON_TABLE_KEYS.includes(item.key)) return "daemon";
  return "flat";
}

/** Items bucketed by card in CONFIG_GROUPS order; empty cards are dropped, pf's order kept inside a card. */
export function groupConfigItems<T extends ConfigItemLike>(items: readonly T[]): { id: ConfigGroupId; items: T[] }[] {
  return CONFIG_GROUPS
    .map((id) => ({ id, items: items.filter((item) => configGroupOf(item) === id) }))
    .filter((group) => group.items.length > 0);
}

/** `[workspace."<abs path>"]` → `<abs path>`; anything else → null (rendered verbatim by the caller). */
export function workspaceSectionPath(key: string): string | null {
  const match = /^\[workspace\."(.*)"\]$/.exec(key);
  return match ? match[1] : null;
}

/** A workspace section's comma-joined project list as chips; empty → []. */
export function workspaceProjects(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

/** Whether a value is unset (renders the placeholder instead of a value). */
export function isUnsetValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

/** The minimal candidate-step shape (structurally a PolyforgeConfigStep). */
export interface ConfigStepLike {
  project?: string;
  step: string;
}

/**
 * Declared candidates grouped per project for the collapsible groups. pf builds
 * the list from Go maps, so its project/step order is unstable: groups sort by
 * project and steps by id. A step without a project lands in one group with
 * `project: null` (rendered as "all projects"), last. Each step object is
 * passed through as-is — the model order inside a step is pf's and is kept.
 */
export function groupStepsByProject<T extends ConfigStepLike>(steps: readonly T[]): { project: string | null; steps: T[] }[] {
  const byProject = new Map<string | null, T[]>();
  for (const step of steps) {
    const project = step.project ? step.project : null;
    const bucket = byProject.get(project);
    if (bucket) bucket.push(step);
    else byProject.set(project, [step]);
  }
  return [...byProject.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([project, bucket]) => ({ project, steps: [...bucket].sort((x, y) => x.step.localeCompare(y.step)) }));
}
