// claude sessions as managed child processes. pi sessions run
// in-process (lib/rpc-manager.ts); a claude session is one `claude -p` child
// per live session, speaking stream-json on stdin/stdout. Its events reach the
// page through the adapter (lib/claude-adapter.ts) and the existing SSE stream.
//
// Lifecycle as pi's: the child lives while a page renews the lease, a turn runs
// or a background subagent is unsettled, and is ended one
// PI_WEB_IDLE_TIMEOUT_MS after the last renewal; the next
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
  claudeCompactLine,
  claudeInterruptLine,
  claudeSetEffortLine,
  claudeSetModelLine,
  claudeTranscriptToMessages,
  claudeUserInputLine,
  claudeUserPromptEvents,
  parseClaudeTranscript,
  type ClaudeControlResponse,
  type ClaudePromptImage,
  type ClaudeSidecar,
  type ClaudeSidecars,
} from "./claude-adapter";
import { buildClaudeArgv, buildClaudeEnv } from "./claude-argv";
import { claudeConfigDir, claudeSidecarFiles, claudeTranscriptFile } from "./claude-config-dir";
import { getClaudeSessionRecord, readClaudeIndex, recordClaudeUsage, updateClaudeSessionRecord, type ClaudeSessionRecord } from "./claude-index";
import {
  CLAUDE_EFFORT_DEFAULT,
  CLAUDE_PROVIDER,
  claudeFirstMessage,
  isClaudeEffort,
  isClaudeModel,
  type ClaudeEffort,
  type ClaudeModel,
} from "./claude-shared";
import type { ClaudeSubagentRun } from "./claude-subagent-view";
import { resolveSessionIdleTimeoutMs } from "./rpc-manager";
import type { SessionFileStats } from "./session-stats";
import type { AgentMessage, SessionInfo } from "./types";
import { notifySessionComplete } from "./web-push";

/** How long Stop's interrupt request gets before the process group is signalled. */
export const CLAUDE_INTERRUPT_DEADLINE_MS = 5_000;
/** How long a control request (a model or effort switch) waits for claude's answer. */
export const CLAUDE_CONTROL_DEADLINE_MS = 15_000;
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

export interface ClaudeHistory {
  file: string | null;
  messages: AgentMessage[];
  entryIds: string[];
  /** The subagent runs the conversation started, their entries from claude's sidecars. */
  subagents: ClaudeSubagentRun[];
}

/** Every sidecar of the session, read whole; a missing or unreadable one is left out (its run shows no entries). */
function readClaudeSidecars(sessionId: string, transcript: string): ClaudeSidecars {
  const sidecars: Record<string, ClaudeSidecar> = {};
  for (const { agentId, file, metaFile } of claudeSidecarFiles(sessionId, undefined, transcript)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let meta: unknown;
    try {
      meta = JSON.parse(readFileSync(metaFile, "utf8"));
    } catch {
      meta = undefined;
    }
    sidecars[agentId] = { entries: parseClaudeTranscript(text), meta };
  }
  return sidecars;
}

/** The session's history and file stats, read from claude's own transcript (and its subagents' sidecars) through the adapter. */
export function readClaudeHistory(sessionId: string): ClaudeHistory {
  const file = claudeTranscriptFile(sessionId);
  if (!file) return { file: null, messages: [], entryIds: [], subagents: [] };
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { file, messages: [], entryIds: [], subagents: [] };
  }
  return { file, ...claudeTranscriptToMessages(parseClaudeTranscript(text), readClaudeSidecars(sessionId, file)) };
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
    claude: { model: record.model, effort: record.effort },
    ...(record.archived ? { archived: true } : {}),
  };
}

/** Every claude session pi-web created, as list rows. Only the index: no claude projects dir is scanned. */
export function getClaudeSessionInfos(): SessionInfo[] {
  return readClaudeIndex().map((record) => claudeSessionInfo(record));
}

type Listener = (event: AgentEventLike) => void;

/**
 * The agent commands a claude session answers; every other (pi-only) one is refused.
 * adds the model switch, the effort change and claude's own compaction.
 */
export const CLAUDE_SESSION_COMMANDS: ReadonlySet<string> = new Set([
  "prompt",
  "abort",
  "get_state",
  "get_tools",
  "get_commands",
  "get_session_stats",
  "set_model",
  "set_effort",
  "compact",
]);

/** A `set_model` command's full model name (`model`, else pi's `modelId`); null when it names none. */
export function claudeCommandModel(command: Record<string, unknown>): ClaudeModel | null {
  const model = command.model ?? command.modelId;
  return isClaudeModel(model) ? model : null;
}

/** A `set_effort` command's effort (a level or the default entry); null when it names none. */
export function claudeCommandEffort(command: Record<string, unknown>): ClaudeEffort | null {
  return isClaudeEffort(command.effort) ? command.effort : null;
}

/** What a model switch did: the model in force, and claude's refusal when it kept the old one. */
export interface ClaudeModelSwitch {
  model: ClaudeModel;
  /** No live child: only the index changed; the next child starts with `--model <model>`. */
  pending?: true;
  rejected?: true;
  error?: string;
  errorCode?: string;
}

/** How claude's own compaction ended. */
export type ClaudeCompactOutcome = { tokensBefore?: number } | { aborted: true } | { error: string };

/** What an effort change did: the effort in force, and claude's refusal when it kept the old one. */
export interface ClaudeEffortSwitch {
  effort: ClaudeEffort;
  /** Only the index changed; the next child starts with this effort. */
  pending?: true;
  rejected?: true;
  error?: string;
}

/**
 * A switch with no live child: the index is the whole change, nothing
 * is spawned; the next open or prompt starts `--resume` with the new values.
 */
export async function setIdleClaudeSetting(
  id: string,
  command: Record<string, unknown>,
): Promise<ClaudeModelSwitch | ClaudeEffortSwitch> {
  if (command.type === "set_model") {
    const model = claudeCommandModel(command);
    if (!model) throw new Error(`Not a claude model: ${String(command.model ?? command.modelId)}`);
    await updateClaudeSessionRecord(id, (record) => ({ ...record, model }));
    return { model, pending: true };
  }
  const effort = claudeCommandEffort(command);
  if (!effort) throw new Error(`Not a claude effort: ${String(command.effort)}`);
  await updateClaudeSessionRecord(id, (record) => ({ ...record, effort }));
  return { effort, pending: true };
}

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
  /**
   * `result` events still owed to the running turn: its prompt's, plus one per
   * follow-up turn claude started on its own meanwhile. The turn
   * ends with the last of them.
   */
  private pendingResults = 0;
  private aborting = false;
  /**
   * The running turn is claude's own `/compact`: announced as pi's
   * compaction (compaction_start / compaction_end) and settled by `settleCompaction`.
   */
  private compaction: { boundary?: { tokensBefore?: number }; settle: (outcome: ClaudeCompactOutcome) => void } | null = null;
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stderrTail = "";
  /** Control requests written to stdin, by request id, waiting for claude's answer. */
  private readonly pendingControls = new Map<string, (response: ClaudeControlResponse) => void>();
  private readonly exited: Promise<void>;

  constructor(record: ClaudeSessionRecord, binary: string, options: { resume: boolean; configDir: string }) {
    this.sessionId = record.id;
    this.record = record;
    this.configDir = options.configDir;
    this.argv = buildClaudeArgv({
      sessionId: record.id,
      resume: options.resume,
      model: record.model,
      effort: record.effort,
      agentLanguage: record.agentLanguage,
    });
    this.child = spawn(binary, [...this.argv], {
      cwd: record.cwd,
      env: buildClaudeEnv(process.env) as NodeJS.ProcessEnv,
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

  /**
   * A background subagent still running, or finished with claude's follow-up turn
   * not started yet: the session is unsettled — no idle reap, no
   * completion announcement, `subagentsActive` on the lease.
   */
  hasUnsettledSubagents(): boolean {
    return this.alive && this.translator.hasUnsettledSubagents();
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
      case "set_model":
        return this.setModel(command);
      case "set_effort":
        return this.setEffort(command);
      case "compact":
        return this.compact();
      case "get_tools":
        // claude's tools are the user's claude config's, not pi-web's to select or describe.
        return [];
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
    // The index's current model and effort (a switch rewrites them), not the launch copy.
    const record = this.currentRecord();
    return {
      sessionId: this.sessionId,
      sessionFile: claudeTranscriptFile(this.sessionId) ?? "",
      isStreaming: this.turnRunning,
      isPromptRunning: this.turnRunning,
      isBashRunning: false,
      isCompacting: this.compaction !== null,
      autoCompactionEnabled: false,
      model: { id: record.model, provider: CLAUDE_PROVIDER },
      claudeEffort: record.effort,
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
    // The composer's `{type: "image", data, mimeType}` entries; the API validated them
    // (validateClaudeImages) before this session was reached.
    const images: ClaudePromptImage[] = Array.isArray(command.images)
      ? command.images.map((image: { data: string; mimeType: string }) => ({ data: image.data, mimeType: image.mimeType }))
      : [];
    if (!message.trim() && images.length === 0) throw new Error("A claude prompt needs text");
    // An image-only prompt sends no (whitespace) text block.
    const text = message.trim() ? message : "";
    if (!this.alive) throw new Error("The claude process has exited; send again to resume it");
    // No queue and no steer: one turn at a time.
    if (this.turnRunning) throw new Error("A claude turn is already running");
    if (!existsSync(this.record.cwd)) throw new Error(`The session folder no longer exists: ${this.record.cwd}`);
    this.turnRunning = true;
    this.pendingResults = 1;
    this.aborting = false;
    this.child.stdin?.write(claudeUserInputLine(text, images));
    this.emit({ type: "agent_start" });
    for (const event of claudeUserPromptEvents(text, images)) this.emit(event);
    void updateClaudeSessionRecord(this.sessionId, (record) => ({
      ...record,
      modified: new Date().toISOString(),
      firstMessage: record.firstMessage || claudeFirstMessage(text, images.length),
    })).catch((error) => console.error("[pi-web] claude index update failed:", error instanceof Error ? error.message : error));
    return null;
  }

  /** Refuses a switch that would land mid-turn: it changes nothing. */
  private assertIdle(what: string): void {
    if (this.turnRunning) throw new Error(`A claude turn is running; ${what} when it ends`);
  }

  /** Writes a control request and waits for claude's answer; a missing answer is an error, never a hang. */
  private controlRequest(line: (requestId: string) => string): Promise<ClaudeControlResponse> {
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControls.delete(requestId);
        this.resetIdleTimer();
        resolve({ requestId, subtype: "error", error: `claude did not answer within ${CLAUDE_CONTROL_DEADLINE_MS / 1000} s` });
      }, CLAUDE_CONTROL_DEADLINE_MS);
      timer.unref?.();
      this.pendingControls.set(requestId, (response) => {
        clearTimeout(timer);
        this.pendingControls.delete(requestId);
        // An answered request is activity: the idle countdown starts over from it.
        this.resetIdleTimer();
        resolve(response);
      });
      this.child.stdin?.write(line(requestId));
    });
  }

  /**
   * The hot model switch: claude's own `set_model` on the live child,
   * same process and transcript. Accepted: the index records the model and every later
   * child starts with it. Refused by a live child: claude's text comes back and nothing
   * changes. The child exits before answering: recorded as an idle switch, the next
   * child starts with `--model <model>`.
   */
  private async setModel(command: Record<string, unknown>): Promise<ClaudeModelSwitch> {
    const model = claudeCommandModel(command);
    if (!model) throw new Error(`Not a claude model: ${String(command.model ?? command.modelId)}`);
    this.assertIdle("switch the model");
    if (!this.alive) return setIdleClaudeSetting(this.sessionId, { type: "set_model", model }) as Promise<ClaudeModelSwitch>;
    const answer = await this.controlRequest((requestId) => claudeSetModelLine(requestId, model));
    // The child went away before answering: the switch is recorded like an idle one.
    if (!this.alive) return setIdleClaudeSetting(this.sessionId, { type: "set_model", model }) as Promise<ClaudeModelSwitch>;
    if (answer.subtype !== "success") {
      return {
        model: this.currentRecord().model,
        rejected: true,
        error: answer.error ?? "claude refused the model",
        ...(answer.errorCode ? { errorCode: answer.errorCode } : {}),
      };
    }
    const active = isClaudeModel(answer.response?.model) ? answer.response.model : model;
    await updateClaudeSessionRecord(this.sessionId, (record) => ({ ...record, model: active }));
    return { model: active };
  }

  /**
   * An effort change. A level goes to the live child as
   * `apply_flag_settings {effortLevel}`, which the recording proves reaches the next
   * turn; the default entry has no such value, so the idle child is ended and the next
   * one starts without `--effort`. Either way the index records it first for every later child.
   */
  private async setEffort(command: Record<string, unknown>): Promise<ClaudeEffortSwitch> {
    const effort = claudeCommandEffort(command);
    if (!effort) throw new Error(`Not a claude effort: ${String(command.effort)}`);
    this.assertIdle("change the effort");
    if (!this.alive || effort === CLAUDE_EFFORT_DEFAULT) {
      const result = await setIdleClaudeSetting(this.sessionId, { type: "set_effort", effort }) as ClaudeEffortSwitch;
      if (this.alive && !this.turnRunning) await this.shutdown();
      return result;
    }
    const answer = await this.controlRequest((requestId) => claudeSetEffortLine(requestId, effort));
    if (!this.alive) return setIdleClaudeSetting(this.sessionId, { type: "set_effort", effort }) as Promise<ClaudeEffortSwitch>;
    if (answer.subtype !== "success") {
      return { effort: this.currentRecord().effort, rejected: true, error: answer.error ?? "claude refused the effort" };
    }
    await updateClaudeSessionRecord(this.sessionId, (record) => ({ ...record, effort }));
    return { effort };
  }

  /**
   * claude's own compaction: the bare `/compact` on stdin, as a turn
   * (nothing else is sent until it ends; Stop interrupts it like any turn). Resolves
   * with claude's pre-compaction token count once its `result` arrives, `{ aborted }`
   * after Stop; rejects with claude's own error. No restart, resume or instructions.
   */
  private compact(): Promise<{ tokensBefore?: number } | { aborted: true }> {
    this.assertIdle("compact");
    if (!this.alive) throw new Error("The claude process has exited; send again to resume it");
    this.turnRunning = true;
    this.pendingResults = 1;
    this.aborting = false;
    const outcome = new Promise<ClaudeCompactOutcome>((settle) => {
      this.compaction = { settle };
    });
    this.child.stdin?.write(claudeCompactLine());
    this.emit({ type: "compaction_start", reason: "manual" });
    return outcome.then((result) => {
      if ("error" in result) throw new Error(result.error);
      return result;
    });
  }

  /** Ends the compaction turn: pi's compaction_end with claude's number, or the stop / error. */
  private settleCompaction(outcome: ClaudeCompactOutcome): void {
    const compaction = this.compaction;
    if (!compaction) return;
    this.compaction = null;
    this.turnRunning = false;
    this.pendingResults = 0;
    this.aborting = false;
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    if ("error" in outcome) this.emit({ type: "compaction_end", reason: "manual", errorMessage: outcome.error });
    else if ("aborted" in outcome) this.emit({ type: "compaction_end", reason: "manual", aborted: true });
    else this.emit({ type: "compaction_end", reason: "manual", result: outcome });
    this.resetIdleTimer();
    compaction.settle(outcome);
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
    const { events, turnEnd, claudeTurnStart, control, compactBoundary } = this.translator.push(event);
    if (control) this.pendingControls.get(control.requestId)?.(control);
    const compaction = this.compaction;
    if (compaction) {
      // A compaction turn is not a reply: only its boundary and its result count.
      if (compactBoundary) compaction.boundary = compactBoundary;
      if (!turnEnd) return;
      void recordClaudeUsage(this.sessionId, turnEnd.usage)
        .catch((error) => console.error("[pi-web] claude usage update failed:", error instanceof Error ? error.message : error));
      if (this.aborting) this.settleCompaction({ aborted: true });
      else if (turnEnd.error) this.settleCompaction({ error: this.withConfigDir(turnEnd.error) });
      else if (compaction.boundary) this.settleCompaction(compaction.boundary);
      else this.settleCompaction({ error: "claude did not compact the conversation" });
      return;
    }
    if (claudeTurnStart) this.startClaudeTurn();
    for (const translated of events) this.emit(translated);
    if (!turnEnd) return;
    void recordClaudeUsage(this.sessionId, turnEnd.usage)
      .catch((error) => console.error("[pi-web] claude usage update failed:", error instanceof Error ? error.message : error));
    const aborted = this.aborting;
    if (turnEnd.error && !aborted) this.emit({ type: "prompt_error", errorMessage: this.withConfigDir(turnEnd.error) });
    // A stopped turn ends with its result; otherwise the last owed result ends it.
    this.pendingResults = aborted ? 0 : Math.max(0, this.pendingResults - 1);
    if (this.pendingResults === 0) this.endTurn(aborted, !turnEnd.error);
  }

  /**
   * claude's own follow-up turn after a background subagent finished: no prompt
   * started it. Alone it is a turn of its own (`agent_start`, then its normal end);
   * while a turn still runs, that turn also waits for its result.
   */
  private startClaudeTurn(): void {
    this.pendingResults += 1;
    if (this.turnRunning) return;
    this.turnRunning = true;
    this.aborting = false;
    this.emit({ type: "agent_start" });
  }

  private withConfigDir(message: string): string {
    return `${message} (claude config dir: ${this.configDir})`;
  }

  private endTurn(aborted: boolean, completed: boolean): void {
    if (!this.turnRunning) return;
    this.turnRunning = false;
    this.pendingResults = 0;
    this.aborting = false;
    if (this.interruptTimer) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
    // A subagent whose end starts another turn here: the page holds its chime and
    // notification until the last follow-up turn ends, and so does the push.
    const subagentsActive = this.hasUnsettledSubagents();
    const flags = { ...(aborted ? { aborted: true } : {}), ...(subagentsActive ? { subagentsActive: true } : {}) };
    this.emit({ type: "agent_settled", ...flags });
    this.emit({ type: "prompt_done", ...flags });
    this.resetIdleTimer();
    if (completed && !aborted && !subagentsActive) {
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
    for (const [requestId, answer] of [...this.pendingControls]) answer({ requestId, subtype: "error", error: "claude exited before it answered" });
    if (this.compaction) {
      const detail = this.stderrTail.trim() || `claude exited${code === null ? "" : ` with code ${code}`}`;
      this.settleCompaction(this.aborting ? { aborted: true } : { error: this.withConfigDir(detail) });
    }
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
      // A running turn keeps the child, as a running pi session is kept; so does an
      // unsettled subagent, whose end starts claude's follow-up turn here, and a control
      // request still waiting for claude's answer.
      if (this.turnRunning || this.hasUnsettledSubagents() || this.pendingControls.size > 0) {
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
  // The system claude's own config dir: resolved for the resume check and error text, never created.
  const configDir = claudeConfigDir();
  const session = new ClaudeSession(record, binary, { resume: claudeTranscriptFile(record.id, configDir) !== null, configDir });
  registry().set(record.id, session);
  return session;
}

export function getRunningClaudeSessionIds(): string[] {
  return [...registry().values()].filter((session) => session.isRunning()).map((session) => session.sessionId);
}

/** Live claude sessions with an unsettled subagent run. */
export function getClaudeSessionIdsWithUnsettledSubagents(): string[] {
  return [...registry().values()].filter((session) => session.hasUnsettledSubagents()).map((session) => session.sessionId);
}

/** Every live child, ended (process groups signalled at once; resolves when they exited or the deadline passed). */
export function shutdownAllClaudeSessions(): Promise<void> {
  return Promise.all([...registry().values()].map((session) => session.shutdown())).then(() => undefined);
}
