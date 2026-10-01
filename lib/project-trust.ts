import { join } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ProjectTrustStatus } from "./api-types";

export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd);
  if (!requiresTrust) return { requiresTrust: false, trusted: true };

  const trustStore = new ProjectTrustStore(agentDir);
  return {
    requiresTrust: true,
    trusted: trustStore.get(cwd) === true,
  };
}

// Hot reload re-evaluates this module; globalThis keeps one warning per error per process.
const TRUST_READ_WARNINGS_KEY: symbol = Symbol.for("pi-web:project-trust-read-warnings");
const TRUST_READ_WARNINGS_MAX = 200;

/**
 * Whether the trust-gated configuration of the project at `cwd` (its
 * `.pi/mcp.json`) may be read right now: true only while the folder requires
 * trust and a decision, exact or inherited, trusts it. The folder's resources
 * and `trust.json` are read on every call, so a decision made anywhere (the
 * trust dialog, the pi CLI) and a `.pi/` resource that appeared since (`git
 * pull`, `pi mcp add -l`, the model's write tool) count at once. That is what
 * a per-wrapper `SettingsManager.isProjectTrusted()` cannot give: it is fixed
 * when the wrapper is built, `true` for a folder that needed no trust then,
 * and refreshed only on reload.
 *
 * A folder that requires no trust gets `false`, although its status reads
 * `trusted: true`. It has no `.pi/mcp.json` — that file alone makes a folder
 * require trust — so nothing is lost, while `true` would let the caller read a
 * file that landed between this check and its own read with no decision at all.
 *
 * A `trust.json` that cannot be read (unparsable, or still locked by another
 * process after the store's ~200 ms synchronous wait) counts as untrusted, with
 * one warning per distinct error.
 */
export function mayReadProjectConfigNow(cwd: string, agentDir: string): boolean {
  try {
    const status = getProjectTrustStatus(cwd, agentDir);
    return status.requiresTrust && status.trusted;
  } catch (error) {
    const trustPath = join(agentDir, "trust.json");
    const message = error instanceof Error ? error.message : String(error);
    const store = globalThis as Record<symbol, Set<string> | undefined>;
    const warned = (store[TRUST_READ_WARNINGS_KEY] ??= new Set());
    const key = `${trustPath}\0${message}`;
    if (!warned.has(key)) {
      if (warned.size >= TRUST_READ_WARNINGS_MAX) warned.clear();
      warned.add(key);
      // A lock error does not name the file, so the path is always given.
      console.warn(`[pi-web] cannot read project trust from ${trustPath}; projects that need it count as untrusted meanwhile: ${message}`);
    }
    return false;
  }
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  new ProjectTrustStore(agentDir).set(cwd, true);
  return { requiresTrust: true, trusted: true };
}

/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the SDK's project-trust store.
 *
 * Pi Web *executes* project extensions when it builds session services: their
 * factory runs on import and their `session_start` handlers run on startup.
 * Without a trust gate, merely opening an untrusted repository in Pi Web runs
 * repository-controlled code locally (issue #236). The SDK's resource loader
 * only imports project extensions once `resolveProjectTrust` resolves true, so
 * denying trust keeps them dormant.
 *
 * Pi Web and the `pi` CLI share the same trust store. Projects with gated
 * resources default to untrusted until either client records a trust decision.
 * Returns `undefined` when the project has no trust-requiring resources,
 * leaving ordinary projects on their existing load path.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } | undefined {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return undefined;
  const trustStore = new ProjectTrustStore(agentDir);
  return { resolveProjectTrust: async () => trustStore.get(cwd) === true };
}
