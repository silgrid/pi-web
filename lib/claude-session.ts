// claude sessions as managed child processes. pi sessions run
// in-process (lib/rpc-manager.ts); a claude session is one `claude -p` child
// per live session, speaking stream-json on stdin/stdout. Its events reach the
// page through the adapter (lib/claude-adapter.ts) and the existing SSE stream.
//
// Lifecycle as pi's: the child lives while a page renews the lease or a turn
// runs, and is ended one PI_WEB_IDLE_TIMEOUT_MS after the last renewal; the next
// open or send starts a new child with `--resume <id>`. Every child runs in its
// own process group, which is what is signalled, so no descendant outlives it.
import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { accessSync, constants, existsSync, readFileSync, statSync } from "fs";
import { delimiter, join } from "path";
import type { AgentEventLike } from "./agent-event-wire";
import {
  ClaudeLineDecoder,
  ClaudeStreamTranslator,
  claudeInterruptLine,
  claudeTranscriptToMessages,
  claudeUserInputLine,
  claudeUserPromptEvents,
  parseClaudeTranscript,
} from "./claude-adapter";
import { buildClaudeArgv, buildClaudeEnv, claudePresetTools } from "./claude-argv";
import { claudeTranscriptFile, ensureClaudeConfigDir } from "./claude-config-dir";
import { getClaudeSessionRecord, readClaudeIndex, recordClaudeUsage, updateClaudeSessionRecord, type ClaudeSessionRecord } from "./claude-index";
import { CLAUDE_PROVIDER } from "./claude-shared";
import { resolveSessionIdleTimeoutMs } from "./rpc-manager";
import type { SessionFileStats } from "./session-stats";
import type { AgentMessage, SessionInfo } from "./types";
import { notifySessionComplete } from "./web-push";

/** How long Stop's interrupt request gets before the process group is signalled. */
export const CLAUDE_INTERRUPT_DEADLINE_MS = 5_000;
/** How long a child gets after SIGTERM before SIGKILL. */
export const CLAUDE_SHUTDOWN_DEADLINE_MS = 3_000;
const STDERR_TAIL_BYTES = 4096;

/** The first executable `claude` on PATH, looked up on every call (no cache, no path setting). */
export function findClaudeBinary(pathValue: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

/** The session's history and file stats, read from claude's own transcript through the adapter. */
export function readClaudeHistory(sessionId: string): { file: string | null; messages: AgentMessage[]; entryIds: string[] } {
  const file = claudeTranscriptFile(sessionId);
  if (!file) return { file: null, messages: [], entryIds: [] };
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, messages: [], entryIds: [] };
  }
  return { file, ...claudeTranscriptToMessages(parseClaudeTranscript(text)) };
}

/** pi's file stats for a claude session: counts from the transcript, tokens and cost from the index's `result` totals. */
export function claudeSessionStats(record: ClaudeSessionRecord, messages: readonly AgentMessage[]): SessionFileStats {
  const stats: SessionFileStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: messages.length,
    tokens: {
      input: record.usage.input,
      output: record.usage.output,
      cacheRead: record.usage.cacheRead,
      cacheWrite: record.usage.cacheWrite,
      total: record.usage.input + record.usage.output + record.usage.cacheRead + record.usage.cacheWrite,
    },
    cost: record.usage.cost,
  };
  for (const message of messages) {
    if (message.role === "user") stats.userMessages += 1;
    else if (message.role === "toolResult") stats.toolResults += 1;
    else if (message.role === "assistant") {
      stats.assistantMessages += 1;
      stats.toolCalls += message.content.filter((block) => (block as { type?: string }).type === "toolCall").length;
    }
  }
  return stats;
}

/** A claude session's row for the session list, from its index record (and its transcript's message count). */
export function claudeSessionInfo(record: ClaudeSessionRecord, history = readClaudeHistory(record.id)): SessionInfo {
  return {
    path: history.file ?? "",
    id: record.id,
    cwd: record.cwd,
    ...(record.name ? { name: record.name } : {}),
    created: record.created,
    modified: record.modified,
    messageCount: history.messages.length,
    firstMessage: record.firstMessage || "(no messages)",
    harness: "claude",
    claude: { modelAlias: record.modelAlias, preset: record.preset },
    ...(record.archived ? { archived: true } : {}),
  };
}

/** Every claude session pi-web created, as list rows. Only the index: no claude projects dir is scanned. */
export function getClaudeSessionInfos(): SessionInfo[] {
  return readClaudeIndex().map((record) => claudeSessionInfo(record));
}

type Listener = (event: AgentEventLike) => void;

/** The agent commands a claude session answers; every other (pi-only) one is refused. */
export const CLAUDE_SESSION_COMMANDS: ReadonlySet<string> = new Set([
  "prompt",
  "abort",
  "get_state",
  "get_tools",
  "get_commands",
  "get_session_stats",
]);

/** One live claude child. A new one (with `--resume`) replaces it once it has exited. */
export class ClaudeSession {
  readonly sessionId: string;
  readonly record: ClaudeSessionRecord;
  readonly configDir: string;
  readonly argv: readonly string[];
  private readonly child: ChildProcess;
  private readonly translator = new ClaudeStreamTranslator();
  private readonly decoder = new ClaudeLineDecoder();
  private readonly listeners = new Set<Listener>();
  private alive = true;
  private turnRunning = false;
  private aborting = false;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail = "";
  private readonly exited: Promise<void>;

  constructor(record: ClaudeSessionRecord, binary: string, options: { resume: boolean; configDir: string }) {
    this.sessionId = record.id;
    this.record = record;
    this.configDir = options.configDir;
    this.argv = buildClaudeArgv({ sessionId: record.id, resume: options.resume, modelAlias: record.modelAlias, preset: record.preset });
    this.child = spawn(binary, [...this.argv], {
      cwd: record.cwd,
      env: buildClaudeEnv(process.env, options.configDir) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group: shutdown signals the group, descendants included.
      detached: true,
    });
    this.exited = new Promise((resolve) => this.child.once("close", () => resolve()));
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      for (const event of this.decoder.push(chunk)) this.handleClaudeEvent(event);
    });
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });
    // A write after the child died must not crash the server.
    this.child.stdin?.on("error", () => {});
    this.child.once("error", (error) => {
      this.stderrTail = (this.stderrTail + String(error.message)).slice(-STDERR_TAIL_BYTES);
      this.handleExit(null);
    });
    this.child.once("close", (code) => this.handleExit(code));
    this.resetIdleTimer();
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isStreaming(): boolean {
    return this.turnRunning;
  }

  get streamingMessage(): unknown {
    return this.translator.streamingMessage ?? undefined;
  }

  isAlive(): boolean {
    return this.alive;
  }

  isRunning(): boolean {
    return this.alive && this.turnRunning;
  }

  isAwaitingInput(): boolean {
    return false;
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** A page's lease renewal: the idle countdown starts over. */
  renewIdleTimer(): void {
    this.resetIdleTimer();
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type;
    if (type !== "get_state") this.resetIdleTimer();
    switch (type) {
      case "prompt":
        return this.prompt(command);
      case "abort":
        this.abort();
        return null;
      case "get_state":
        return this.state();
      case "get_tools":
        return claudePresetTools(this.record.preset).map((name) => ({ name, description: "", active: true }));
      case "get_commands":
        return { commands: [] };
      case "get_session_stats": {
        const { file, messages } = readClaudeHistory(this.sessionId);
        const record = this.currentRecord();
        return { ...claudeSessionStats(record, messages), sessionFile: file ?? undefined, sessionId: this.sessionId, sessionName: record.name };
      }
      default:
        throw new Error(`${String(type)} is not available for claude sessions`);
    }
  }

  /** The index's record as it is now (renamed, usage added); the launch's copy if it was removed. */
  private currentRecord(): ClaudeSessionRecord {
    return getClaudeSessionRecord(this.sessionId) ?? this.record;
  }

  private state(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      sessionFile: claudeTranscriptFile(this.sessionId) ?? "",
      isStreaming: this.turnRunning,
      isPromptRunning: this.turnRunning,
      isBashRunning: false,
      isCompacting: false,
      autoCompactionEnabled: false,
      model: { id: this.record.modelAlias, provider: CLAUDE_PROVIDER },
      messageCount: 0,
      pendingMessageCount: 0,
      queuedMessages: { steering: [], followUp: [] },
      contextUsage: null,
      thinkingLevel: "off",
      extensionStatuses: [],
      extensionWidgets: [],
    };
  }

  private prompt(command: Record<string, unknown>): null {
    const message = typeof command.message === "string" ? command.message : "";
    if (!message.trim()) throw new Error("A claude prompt needs text");
    if (!this.alive) throw new Error("The claude process has exited; send again to resume it");
    // No queue and no steer: one turn at a time.
    if (this.turnRunning) throw new Error("A claude turn is already running");
    if (!existsSync(this.record.cwd)) throw new Error(`The session folder no longer exists: ${this.record.cwd}`);
    this.turnRunning = true;
    this.aborting = false;
    this.child.stdin?.write(claudeUserInputLine(message));
    this.emit({ type: "agent_start" });
    for (const event of claudeUserPromptEvents(message)) this.emit(event);
    void updateClaudeSessionRecord(this.sessionId, (record) => ({
      ...record,
      modified: new Date().toISOString(),
      firstMessage: record.firstMessage || message,
    })).catch((error) => console.error("[pi-web] claude index update failed:", error instanceof Error ? error.message : error));
    return null;
  }

  /** Stop: the stream-json interrupt first; a turn still running at the deadline gets SIGINT. */
  private abort(): void {
    if (!this.turnRunning || !this.alive) return;
    this.aborting = true;
    this.child.stdin?.write(claudeInterruptLine(randomUUID()));
    if (this.interruptTimer) clearTimeout(this.interruptTimer);
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      if (this.turnRunning) this.signalGroup("SIGINT");
    }, CLAUDE_INTERRUPT_DEADLINE_MS);
    this.interruptTimer.unref?.();
  }

  private handleClaudeEvent(event: unknown): void {
    const { events, turnEnd } = this.translator.push(event);
    for (const translated of events) this.emit(translated);
    if (!turnEnd) return;
    void recordClaudeUsage(this.sessionId, turnEnd.usage)
      .catch((error) => console.error("[pi-web] claude usage update failed:", error instanceof Error ? error.message : error));
    const aborted = this.aborting;
    if (turnEnd.error && !aborted) this.emit({ type: "prompt_error", errorMessage: this.withConfigDir(turnEnd.error) });
    this.endTurn(aborted, !turnEnd.error);
  }

  private withConfigDir(message: string): string {
    return `${message} (claude config dir: ${this.configDir})`;
  }

  private endTurn(aborted: boolean, completed: boolean): void {
    if (!this.turnRunning) return;
    this.turnRunning = false;
    this.aborting = false;
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    this.emit({ type: "agent_settled", ...(aborted ? { aborted: true } : {}) });
    this.emit({ type: "prompt_done", ...(aborted ? { aborted: true } : {}) });
    this.resetIdleTimer();
    if (completed && !aborted) {
      void notifySessionComplete(this.sessionId, this.currentRecord().name)
        .catch((error) => console.error("[pi-web] failed to send completion push:", error instanceof Error ? error.message : error));
    }
  }

  private handleExit(code: number | null): void {
    if (!this.alive) return;
    this.alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    // Whatever the group still holds goes with it.
    this.signalGroup("SIGKILL");
    if (this.turnRunning) {
      const aborted = this.aborting;
      for (const event of this.translator.flush()) this.emit(event);
      if (!aborted) {
        const detail = this.stderrTail.trim() || `claude exited${code === null ? "" : ` with code ${code}`}`;
        this.emit({ type: "prompt_error", errorMessage: this.withConfigDir(detail) });
      }
      this.endTurn(aborted, false);
    }
    unregister(this);
    this.emit({ type: "session_shutdown" });
    this.listeners.clear();
  }

  private signalGroup(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (!pid) return;
    try {
      process.kill(process.platform === "win32" ? pid : -pid, signal);
    } catch {
      // Already gone.
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (!this.alive) return;
    const timeoutMs = resolveSessionIdleTimeoutMs();
    if (timeoutMs === 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // A running turn keeps the child, as a running pi session is kept.
      if (this.turnRunning) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown();
    }, timeoutMs);
    this.idleTimer.unref?.();
  }

  /** Ends the child: stdin closed, SIGTERM to the group, SIGKILL after the deadline. */
  async shutdown(): Promise<void> {
    if (!this.alive) return;
    try { this.child.stdin?.end(); } catch { /* closed */ }
    this.signalGroup("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.signalGroup("SIGKILL");
        resolve();
      }, CLAUDE_SHUTDOWN_DEADLINE_MS);
    });
    await Promise.race([this.exited, deadline]);
    if (timer) clearTimeout(timer);
    await Promise.race([this.exited, new Promise<void>((resolve) => setTimeout(resolve, 1_000).unref?.())]);
  }

  private emit(event: AgentEventLike): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`[pi-web] failed to deliver ${event.type} event:`, error instanceof Error ? error.message : error);
      }
    }
  }
}

// Shared across route bundles and hot reloads, like the pi registry.
const REGISTRY = Symbol.for("pi-web.claudeSessions");
function registry(): Map<string, ClaudeSession> {
  const store = globalThis as Record<symbol, Map<string, ClaudeSession> | undefined>;
  return (store[REGISTRY] ??= new Map());
}

function unregister(session: ClaudeSession): void {
  if (registry().get(session.sessionId) === session) registry().delete(session.sessionId);
}

/** The live child of a session, if any. */
export function getClaudeSession(sessionId: string): ClaudeSession | undefined {
  const session = registry().get(sessionId);
  return session?.isAlive() ? session : undefined;
}

/**
 * The session's live child, or a new one: `--resume <id>` once claude has a
 * transcript for the id, `--session-id <id>` before (a new conversation).
 * Throws when claude is not on PATH or the folder is gone.
 */
export function startClaudeSession(record: ClaudeSessionRecord): ClaudeSession {
  const existing = getClaudeSession(record.id);
  if (existing) return existing;
  const binary = findClaudeBinary();
  if (!binary) throw new Error("claude was not found on PATH");
  if (!existsSync(record.cwd)) throw new Error(`The session folder no longer exists: ${record.cwd}`);
  const configDir = ensureClaudeConfigDir();
  const session = new ClaudeSession(record, binary, { resume: claudeTranscriptFile(record.id) !== null, configDir });
  registry().set(record.id, session);
  return session;
}

export function getRunningClaudeSessionIds(): string[] {
  return [...registry().values()].filter((session) => session.isRunning()).map((session) => session.sessionId);
}

/** Every live child, ended (process groups signalled at once; resolves when they exited or the deadline passed). */
export function shutdownAllClaudeSessions(): Promise<void> {
  return Promise.all([...registry().values()].map((session) => session.shutdown())).then(() => undefined);
}
