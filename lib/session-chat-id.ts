/**
 * Server-side (pi, sessionId) → chat_id resolution for the session tab
 * label suffix (pi#121). The daemon's mapping is minted by the pf-chat
 * extension's `pf chat init` at session start and is immutable and
 * idempotent, so resolving here only ever reads back the same id the
 * panel's job origin carries — never a second one.
 *
 * Subprocess contract (measured against pf v2.18.2): `pf chat init
 * --harness pi --harness-session <id>` — NO `--json` — exits 0 and prints
 * exactly the chat id token plus a trailing newline on stdout
 * (`chat_` + 16 hex chars; the CLI prints `rec.ChatID` via `Fprintln`, and
 * polyforge's own CLI test `TestChatInitPrintsIDAndSendsHarnessSession`
 * pins stdout == the bare token). A live run from this machine is refused
 * by the daemon's step-agent guard (DAEMON-403: "a step agent must never
 * drive the daemon"), so the shape is verified from the polyforge CLI
 * source plus that test, and matches the pf-chat extension — the
 * reference consumer — which validates the trimmed stdout against the
 * same `^chat_[A-Za-z0-9_]+$` used here. Anything else that ever lands on
 * stdout counts as absent (never cached), exactly like a failed spawn.
 *
 * Resolution is gated, in order: (1) live-session gate — only a session
 * this server has started or attached (a live wrapper in
 * `lib/rpc-manager.ts` when the request arrives; a session that is not
 * live gets no suffix and spawns no pf, so an old history session opened
 * in a tab mints nothing); (2) the existing `pf --version` presence probe
 * (`probePolyforgePresent`, no pf = the whole feature is off). A
 * successful id is cached per sessionId for the life of the process; every
 * failure (pf absent, daemon unreachable, bad shape, timeout) stays
 * uncached, so a later render or refresh retries.
 */

const CHAT_ID_PATTERN = /^chat_[A-Za-z0-9_]+$/;

/** Spawn timeout, the same budget as the polyforge-status reads (10 s). */
export const CHAT_ID_TIMEOUT_MS = 10_000;

/** A trimmed chat id token: `chat_` + `[A-Za-z0-9_]+`, nothing else. */
export function isChatIdToken(value: unknown): value is string {
  return typeof value === "string" && CHAT_ID_PATTERN.test(value);
}

/** The closed `pf chat init` argv for one session id (no shell, ever). */
export function chatInitArgv(sessionId: string): string[] {
  return ["chat", "init", "--harness", "pi", "--harness-session", sessionId];
}

export interface SessionChatIdEnv {
  /** The `pf --version` presence probe; false = absent, no spawn. */
  present(): Promise<boolean>;
  /** True when this server has a live wrapper for the session. */
  isLiveSession(sessionId: string): boolean;
  /** Runs `pf chat init` and resolves the raw (unvalidated) stdout. */
  spawnChatInit(sessionId: string): Promise<string>;
}

export interface SessionChatIdResolver {
  /**
   * The session's polyforge chat id, or null when there is none to show
   * (not live, pf absent, daemon down, bad shape, timeout). Never throws;
   * only a validated success lands in the cache.
   */
  resolve(sessionId: string): Promise<string | null>;
}

/**
 * Build a resolver with its own success-only cache. The cache lives for
 * the resolver's lifetime (the process, in production): the daemon mapping
 * is immutable, so a hit never re-spawns; a miss (any failure) is never
 * cached, so the next call retries.
 */
export function createSessionChatIdResolver(env: SessionChatIdEnv): SessionChatIdResolver {
  const cache = new Map<string, string>();
  return {
    async resolve(sessionId: string): Promise<string | null> {
      const cached = cache.get(sessionId);
      if (cached !== undefined) return cached;
      // Live gate before any subprocess: a session this server never
      // started or attached resolves nothing and spawns no pf.
      if (!env.isLiveSession(sessionId)) return null;
      if (!(await env.present())) return null;
      try {
        const stdout = await env.spawnChatInit(sessionId);
        const token = typeof stdout === "string" ? stdout.trim() : "";
        if (!isChatIdToken(token)) return null;
        cache.set(sessionId, token);
        return token;
      } catch {
        // pf absent from PATH mid-run, daemon unreachable, timeout: absent
        // this time, uncached, retried on the next call.
        return null;
      }
    },
  };
}

/**
 * The production wiring lives in the route (`app/api/sessions/[id]/chat-id`):
 * `probePolyforgePresent`, `getRpcSession` as the live gate, and the
 * execFile transport (no shell, `lib/exec-file.ts`) over `chatInitArgv`.
 */