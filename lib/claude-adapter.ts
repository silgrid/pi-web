// The only module that knows claude's native formats: claude
// 2.1.312's stream-json stdout events and its jsonl transcript, translated into
// the pi event vocabulary (lib/agent-event-wire.ts) and pi messages the chat
// already renders. Pure: no I/O. Contract-tested on the real recordings in
// lib/__fixtures__/claude-2.1.312/.
//
// Observed dialect (see the fixtures' README): with --include-partial-messages,
// `stream_event` wraps the API's message_start / content_block_* / message_*
// events; claude then emits one `assistant` event per finished content block
// (all with the API message's id), usually before that block's
// content_block_stop; tool results come back as a `user` event of tool_result
// blocks; a turn ends with one `result` event carrying the aggregate usage.
import type { AgentEventLike } from "./agent-event-wire";
import { CLAUDE_PROVIDER } from "./claude-shared";
import {
  CLAUDE_TASK_NOTIFICATION_TYPE,
  isClaudeSubagentToolName,
  type ClaudeSubagentEntry,
  type ClaudeSubagentRun,
  type ClaudeSubagentStatus,
  type ClaudeSubagentUsage,
} from "./claude-subagent-view";
import type { AgentMessage } from "./types";

/** pi's message shapes as the SDK writes them (tool calls as id / name / arguments). */
type PiTextBlock = { type: "text"; text: string };
type PiThinkingBlock = { type: "thinking"; thinking: string };
type PiToolCallBlock = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };
type PiImageBlock = { type: "image"; data: string; mimeType: string };
type PiAssistantBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock;

export interface PiAssistantMessage {
  role: "assistant";
  content: PiAssistantBlock[];
  api: string;
  provider: string;
  model: string;
  stopReason?: string;
  timestamp: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (PiTextBlock | PiImageBlock)[];
  isError: boolean;
  timestamp: number;
}

export interface PiUserMessage {
  role: "user";
  content: string | (PiTextBlock | PiImageBlock)[];
  timestamp: number;
}

export type PiMessage = PiAssistantMessage | PiToolResultMessage | PiUserMessage;

/** A turn's `result` aggregate: the only source of a claude session's usage. */
export interface ClaudeTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ClaudeTurnEnd {
  usage: ClaudeTurnUsage;
  /** claude's own error text when the turn failed (an authentication failure, say). */
  error?: string;
}

/** claude's answer to one control request: never a chat message. */
export interface ClaudeControlResponse {
  requestId: string;
  subtype: "success" | "error";
  /** claude's own error text, for an error. */
  error?: string;
  /** claude's own error code (`check_failed` for a model it refused), for an error. */
  errorCode?: string;
  /** The request's result (`{ model }` for an accepted `set_model`). */
  response?: Record<string, unknown>;
}

export interface ClaudeTranslation {
  events: AgentEventLike[];
  /** Set by a `control_response`: the answer to the control request with its id. */
  control?: ClaudeControlResponse;
  /** Set by `compact_boundary`: claude compacted; its pre-compaction token count when it gave one. */
  compactBoundary?: { tokensBefore?: number };
  /** Set by the `result` event that ends a turn. */
  turnEnd?: ClaudeTurnEnd;
  /**
   * Set by the `init` that starts claude's own follow-up turn after a background
   * subagent's task notification: a turn no user prompt started. Its events open
   * with the hidden turn anchor (claudeTaskNotificationAnchor()).
   */
  claudeTurnStart?: true;
}

/** The live wire event carrying a subagent run's header and its new entries. */
export const CLAUDE_SUBAGENT_EVENT = "claude_subagent";


export const CLAUDE_API = "claude-code";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function timestampOf(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The `result` event's aggregate (never the streamed per-message usage, which under-counts). */
export function claudeResultUsage(event: unknown): ClaudeTurnUsage {
  const raw = isObject(event) ? event : {};
  const usage = isObject(raw.usage) ? raw.usage : {};
  return {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    cost: num(raw.total_cost_usd),
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** claude content blocks → pi assistant blocks; empty (redacted) thinking and unknown blocks are left out. */
function toAssistantBlocks(content: unknown): PiAssistantBlock[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: PiAssistantBlock[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      blocks.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "tool_use" && typeof block.id === "string") {
      blocks.push({
        type: "toolCall",
        id: block.id,
        name: typeof block.name === "string" ? block.name : "tool",
        arguments: isObject(block.input) ? block.input : {},
      });
    }
  }
  return blocks;
}

function toResultContent(content: unknown): (PiTextBlock | PiImageBlock)[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: (PiTextBlock | PiImageBlock)[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") blocks.push({ type: "text", text: block.text });
    else if (block.type === "image" && isObject(block.source) && typeof block.source.data === "string") {
      blocks.push({ type: "image", data: block.source.data, mimeType: typeof block.source.media_type === "string" ? block.source.media_type : "image/png" });
    }
  }
  return blocks;
}

function toolResultBlocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter((block): block is Record<string, unknown> => isObject(block) && block.type === "tool_result") : [];
}

function toToolResult(block: Record<string, unknown>, toolNames: Map<string, string>, timestamp: number): PiToolResultMessage {
  const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
  return {
    role: "toolResult",
    toolCallId,
    toolName: toolNames.get(toolCallId) ?? "tool",
    content: toResultContent(block.content),
    // A permission denial arrives as an is_error result naming the denial.
    isError: block.is_error === true,
    timestamp,
  };
}

/** claude's task status → the run's state; undefined for a word that is no state (kept as it was). */
function claudeTaskStatus(value: unknown): ClaudeSubagentStatus | undefined {
  switch (value) {
    case "running":
    case "pending":
    case "async_launched":
      return "running";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
    case "cancelled":
    case "canceled":
    case "aborted":
      return "stopped";
    default:
      return undefined;
  }
}

function claudeTaskUsage(value: unknown): ClaudeSubagentUsage | undefined {
  if (!isObject(value)) return undefined;
  return { totalTokens: num(value.total_tokens), toolUses: num(value.tool_uses), durationMs: num(value.duration_ms) };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return toResultContent(content).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** A new run from its `Agent` / `Task` tool call. */
function runFromToolCall(block: PiToolCallBlock): ClaudeSubagentRun {
  const input = block.arguments;
  return {
    toolCallId: block.id,
    ...(typeof input.subagent_type === "string" && input.subagent_type ? { agentType: input.subagent_type } : {}),
    ...(typeof input.description === "string" && input.description ? { description: input.description } : {}),
    ...(typeof input.prompt === "string" && input.prompt ? { prompt: input.prompt } : {}),
    background: input.run_in_background === true,
    status: "running",
    entries: [],
  };
}

/**
 * What an `Agent` / `Task` tool result says about its run: an async launch receipt
 * (`status: async_launched`) names the agent and keeps the run running; a finished
 * foreground run carries its result text and statistics.
 */
function runFromToolResult(toolCallId: string, receipt: unknown, content: unknown, isError: boolean): Partial<ClaudeSubagentRun> {
  const raw = isObject(receipt) ? receipt : {};
  const update: Partial<ClaudeSubagentRun> = { toolCallId };
  if (typeof raw.agentId === "string" && raw.agentId) update.agentId = raw.agentId;
  if (raw.isAsync === true || raw.status === "async_launched") {
    update.background = true;
    return update;
  }
  update.status = isError ? "failed" : (claudeTaskStatus(raw.status) ?? "completed");
  const text = textOf(raw.content ?? content).trim();
  if (text) update.result = text;
  if (num(raw.totalTokens) || num(raw.totalToolUseCount) || num(raw.totalDurationMs)) {
    update.usage = { totalTokens: num(raw.totalTokens), toolUses: num(raw.totalToolUseCount), durationMs: num(raw.totalDurationMs) };
  }
  return update;
}

/**
 * One subagent transcript / stream entry → its timeline entries, as the main
 * conversion maps them (an assistant reply, its tool results, a user text), each
 * keyed by claude's entry uuid (`<uuid>:<n>` for the 2nd+ tool result of an entry).
 * The live stream and the sidecar carry the same uuid, which is what makes both
 * paths yield the same entries.
 */
function subagentEntries(
  type: unknown,
  message: Record<string, unknown>,
  id: string,
  at: number,
  toolNames: Map<string, string>,
  model: string,
): ClaudeSubagentEntry[] {
  if (type === "assistant") {
    const content = toAssistantBlocks(message.content);
    for (const block of content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
    if (content.length === 0) return [];
    const assistant: PiAssistantMessage = {
      role: "assistant",
      content,
      api: CLAUDE_API,
      provider: CLAUDE_PROVIDER,
      model: typeof message.model === "string" && message.model ? message.model : model,
      ...(typeof message.stop_reason === "string" ? { stopReason: message.stop_reason } : {}),
      timestamp: at,
    };
    return [{ id, message: assistant as unknown as ClaudeSubagentEntry["message"] }];
  }
  const results = toolResultBlocks(message.content);
  if (results.length > 0) {
    return results.map((block, index) => ({
      id: index === 0 ? id : `${id}:${index}`,
      message: toToolResult(block, toolNames, at) as unknown as ClaudeSubagentEntry["message"],
    }));
  }
  const content = typeof message.content === "string" ? message.content : toResultContent(message.content);
  if (typeof content === "string" ? !content : content.length === 0) return [];
  const user: PiUserMessage = { role: "user", content, timestamp: at };
  return [{ id, message: user as unknown as ClaudeSubagentEntry["message"] }];
}

/** The hidden custom message that starts claude's follow-up turn; it renders no bubble. */
export function claudeTaskNotificationAnchor(toolCallIds: readonly string[], timestamp: number): AgentMessage {
  return {
    role: "custom",
    customType: CLAUDE_TASK_NOTIFICATION_TYPE,
    content: "",
    display: false,
    details: { toolCallIds: [...toolCallIds] },
    timestamp,
  } as unknown as AgentMessage;
}

/** An image a prompt carries, as the composer sends it (pi's shape). */
export type ClaudePromptImage = { data: string; mimeType: string };

/**
 * The pi events a prompt pi-web wrote to claude's stdin is announced with: the text
 * alone as a string, or with images the text block (when any) then the image blocks,
 * pi's live user-message shape.
 */
export function claudeUserPromptEvents(text: string, images: readonly ClaudePromptImage[] = [], timestamp = Date.now()): AgentEventLike[] {
  const content: PiUserMessage["content"] = images.length === 0
    ? text
    : [...(text ? [{ type: "text" as const, text }] : []), ...images.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType }))];
  const message: PiUserMessage = { role: "user", content, timestamp };
  return [{ type: "message_start", message }, { type: "message_end", message }];
}

/**
 * The stdin line that delivers a user message (stream-json input). Text alone is a
 * string content; with images the content is the text block (omitted
 * when empty) then one base64 image block per image, data and media type unchanged —
 * the line claude 2.1.312 accepted in lib/__fixtures__/claude-2.1.312/image/stdin.jsonl.
 */
export function claudeUserInputLine(text: string, images: readonly ClaudePromptImage[] = []): string {
  const content = images.length === 0
    ? text
    : [
      ...(text ? [{ type: "text", text }] : []),
      ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } })),
    ];
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

/** The stdin line of the stream-json interrupt control request (Stop). */
export function claudeInterruptLine(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;
}

/** The stdin line of a `set_model` control request, as claude 2.1.312 accepted it. */
export function claudeSetModelLine(requestId: string, model: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "set_model", model } })}\n`;
}

/**
 * The stdin line that changes a live child's effort: `apply_flag_settings`
 * with `effortLevel`, which the recording shows reaching the next request's effort.
 */
export function claudeSetEffortLine(requestId: string, effort: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "apply_flag_settings", settings: { effortLevel: effort } } })}\n`;
}

/** The stdin line of claude's own compaction: the bare `/compact`, no instructions. */
export function claudeCompactLine(): string {
  return claudeUserInputLine("/compact");
}

/**
 * claude's transcript compaction boundary (`system` / `compact_boundary`) as pi's
 * compaction card: the marker and claude's pre-compaction token count, no summary body
 * (claude's summary stays its own hidden entry).
 */
export function claudeCompactionMarker(entry: Record<string, unknown>, timestamp: number): AgentMessage {
  const metadata = isObject(entry.compactMetadata) ? entry.compactMetadata : {};
  const tokensBefore = typeof metadata.preTokens === "number" && Number.isFinite(metadata.preTokens) ? metadata.preTokens : undefined;
  return {
    role: "custom",
    customType: "compaction",
    content: "",
    display: true,
    details: tokensBefore === undefined ? {} : { tokensBefore },
    timestamp,
  } as unknown as AgentMessage;
}

/** A `control_response` event → its answer; null for anything else. */
export function claudeControlResponse(raw: unknown): ClaudeControlResponse | null {
  if (!isObject(raw) || raw.type !== "control_response" || !isObject(raw.response)) return null;
  const response = raw.response;
  if (typeof response.request_id !== "string") return null;
  const error = response.subtype !== "success";
  return {
    requestId: response.request_id,
    subtype: error ? "error" : "success",
    ...(error ? { error: typeof response.error === "string" && response.error ? response.error : "claude refused the request" } : {}),
    ...(error && typeof response.error_code === "string" ? { errorCode: response.error_code } : {}),
    ...(isObject(response.response) ? { response: response.response } : {}),
  };
}

interface PartialBlock {
  local: number;
  kind: "text" | "thinking" | "toolCall";
  rawJson: string;
}

/**
 * Translates one claude child's stdout, event by event, into pi events. Keeps the
 * reply being streamed (`streamingMessage`) for a reconnecting page's snapshot.
 */
export class ClaudeStreamTranslator {
  /** The session id claude reported (init / every event); null until the first. */
  sessionId: string | null = null;
  /** The pi assistant message being streamed, or null between replies. */
  streamingMessage: PiAssistantMessage | null = null;
  private model = "";
  private blocks = new Map<number, PartialBlock>();
  private toolNames = new Map<string, string>();
  /** Every subagent run seen, by its tool call id (header data; entries go out as they arrive). */
  private runs = new Map<string, ClaudeSubagentRun>();
  /** claude's task id → the tool call that started it. */
  private taskRuns = new Map<string, string>();
  /** Background runs notified since the last `init`: claude starts a follow-up turn for them. */
  private notified: string[] = [];
  /** Background runs whose follow-up turn has not started yet. */
  private unsettled = new Set<string>();
  /** Background runs whose follow-up turn has started. */
  private followedUp = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * A background subagent still running, or one that finished whose follow-up turn
   * claude has not started yet: the session is not settled.
   */
  hasUnsettledSubagents(): boolean {
    return this.unsettled.size > 0;
  }

  push(raw: unknown): ClaudeTranslation {
    if (!isObject(raw)) return { events: [] };
    if (typeof raw.session_id === "string" && raw.session_id) this.sessionId = raw.session_id;
    // A subagent's own activity names the tool call that started it: its run's, never the main conversation's.
    if (typeof raw.parent_tool_use_id === "string" && raw.parent_tool_use_id) {
      return { events: this.subagentActivity(raw.parent_tool_use_id, raw) };
    }
    switch (raw.type) {
      case "system":
        return this.system(raw);
      case "stream_event":
        return { events: isObject(raw.event) ? this.streamEvent(raw.event) : [] };
      case "assistant":
        return { events: isObject(raw.message) ? this.assistant(raw.message, raw.timestamp) : [] };
      case "user":
        return { events: isObject(raw.message) ? this.user(raw.message, raw.timestamp, raw.tool_use_result) : [] };
      case "result":
        return this.result(raw);
      case "control_response": {
        const control = claudeControlResponse(raw);
        return control ? { events: [], control } : { events: [] };
      }
      default:
        return { events: [] };
    }
  }

  private system(raw: Record<string, unknown>): ClaudeTranslation {
    switch (raw.subtype) {
      case "compact_boundary": {
        const metadata = isObject(raw.compact_metadata) ? raw.compact_metadata : {};
        const tokensBefore = typeof metadata.pre_tokens === "number" && Number.isFinite(metadata.pre_tokens) ? metadata.pre_tokens : undefined;
        return { events: [], compactBoundary: tokensBefore === undefined ? {} : { tokensBefore } };
      }
      case "init": {
        if (typeof raw.model === "string") this.model = raw.model;
        if (this.notified.length === 0) return { events: [] };
        // claude starts its own turn for the notified runs: it opens with a hidden anchor.
        const anchor = claudeTaskNotificationAnchor(this.notified, this.now());
        for (const toolCallId of this.notified) {
          this.unsettled.delete(toolCallId);
          this.followedUp.add(toolCallId);
        }
        this.notified = [];
        return { events: [{ type: "message_start", message: anchor }, { type: "message_end", message: anchor }], claudeTurnStart: true };
      }
      case "task_started": {
        const toolCallId = typeof raw.tool_use_id === "string" ? raw.tool_use_id : "";
        if (!toolCallId) return { events: [] };
        if (typeof raw.task_id === "string" && raw.task_id) this.taskRuns.set(raw.task_id, toolCallId);
        return {
          events: this.updateRun(toolCallId, {
            ...(typeof raw.task_id === "string" && raw.task_id ? { agentId: raw.task_id } : {}),
            ...(typeof raw.subagent_type === "string" && raw.subagent_type ? { agentType: raw.subagent_type } : {}),
            ...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}),
            ...(typeof raw.prompt === "string" && raw.prompt ? { prompt: raw.prompt } : {}),
            ...(raw.is_backgrounded === true ? { background: true } : {}),
          }),
        };
      }
      case "task_progress": {
        const toolCallId = this.taskToolCall(raw);
        if (!toolCallId) return { events: [] };
        const usage = claudeTaskUsage(raw.usage);
        return {
          events: this.updateRun(toolCallId, {
            ...(typeof raw.description === "string" && raw.description ? { progress: raw.description } : {}),
            ...(usage ? { usage } : {}),
          }),
        };
      }
      case "task_updated": {
        const toolCallId = this.taskToolCall(raw);
        const status = isObject(raw.patch) ? claudeTaskStatus(raw.patch.status) : undefined;
        if (!toolCallId || !status) return { events: [] };
        return { events: this.updateRun(toolCallId, { status }) };
      }
      case "task_notification": {
        const toolCallId = this.taskToolCall(raw);
        if (!toolCallId) return { events: [] };
        const usage = claudeTaskUsage(raw.usage);
        const result = typeof raw.result === "string" ? raw.result : (typeof raw.summary === "string" ? raw.summary : "");
        const events = this.updateRun(toolCallId, {
          status: claudeTaskStatus(raw.status) ?? "completed",
          ...(usage ? { usage } : {}),
          ...(result.trim() ? { result: result.trim() } : {}),
        });
        if (this.runs.get(toolCallId)?.background && !this.notified.includes(toolCallId)) this.notified.push(toolCallId);
        return { events };
      }
      default:
        return { events: [] };
    }
  }

  private taskToolCall(raw: Record<string, unknown>): string | undefined {
    if (typeof raw.tool_use_id === "string" && raw.tool_use_id) return raw.tool_use_id;
    return typeof raw.task_id === "string" ? this.taskRuns.get(raw.task_id) : undefined;
  }

  /** Folds a header change (and new entries) into the run and announces it once. */
  private updateRun(toolCallId: string, update: Partial<ClaudeSubagentRun>, entries: ClaudeSubagentEntry[] = []): AgentEventLike[] {
    const current = this.runs.get(toolCallId) ?? { toolCallId, background: false, status: "running" as const, entries: [] };
    // A settled run never goes back to running (claude's last word stands).
    const status = current.status !== "running" && update.status === "running" ? current.status : (update.status ?? current.status);
    const run: ClaudeSubagentRun = { ...current, ...update, toolCallId, background: Boolean(update.background || current.background), status, entries: [] };
    this.runs.set(toolCallId, run);
    if (run.background && !this.followedUp.has(toolCallId)) this.unsettled.add(toolCallId);
    return [{ type: CLAUDE_SUBAGENT_EVENT, run: { ...run, entries } }];
  }

  /** A subagent's assistant reply or tool result: entries of its run. Its partial stream is not shown. */
  private subagentActivity(parent: string, raw: Record<string, unknown>): AgentEventLike[] {
    if ((raw.type !== "assistant" && raw.type !== "user") || !isObject(raw.message)) return [];
    const id = typeof raw.uuid === "string" && raw.uuid ? raw.uuid : `${parent}:${this.now()}`;
    const entries = subagentEntries(raw.type, raw.message, id, timestampOf(raw.timestamp, this.now()), this.toolNames, this.model);
    if (entries.length === 0) return [];
    const events = this.updateRun(parent, {}, entries);
    events.push(...this.toolCallRuns(entries.map((entry) => entry.message)), ...this.toolResultRuns(raw.message, raw.tool_use_result));
    return events;
  }

  /** The runs an `Agent` / `Task` call in these messages starts (at any depth). */
  private toolCallRuns(messages: readonly unknown[]): AgentEventLike[] {
    const events: AgentEventLike[] = [];
    for (const message of messages) {
      if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content as PiAssistantBlock[]) {
        if (block.type !== "toolCall" || !isClaudeSubagentToolName(block.name) || this.runs.has(block.id)) continue;
        const { entries: _entries, ...header } = runFromToolCall(block);
        void _entries;
        events.push(...this.updateRun(block.id, header));
      }
    }
    return events;
  }

  /** What an `Agent` / `Task` tool result (a launch receipt or a finished run) says about its run. */
  private toolResultRuns(message: Record<string, unknown>, receipt: unknown): AgentEventLike[] {
    const events: AgentEventLike[] = [];
    for (const block of toolResultBlocks(message.content)) {
      const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (!toolCallId || !this.runs.has(toolCallId)) continue;
      const update = runFromToolResult(toolCallId, receipt, block.content, block.is_error === true);
      if (update.agentId) this.taskRuns.set(update.agentId, toolCallId);
      events.push(...this.updateRun(toolCallId, update));
    }
    return events;
  }

  /**
   * Ends a turn that will see no `result` (a stopped run, a child that exited): the
   * reply streamed so far is kept as a final message, then the run ends.
   */
  flush(): AgentEventLike[] {
    const events: AgentEventLike[] = [];
    const partial = this.streamingMessage;
    if (partial) {
      const content = partial.content.filter((block) => block.type !== "thinking" || block.thinking);
      if (content.length > 0) events.push({ type: "message_end", message: { ...partial, content, stopReason: "aborted" } });
    }
    this.resetPartial();
    events.push({ type: "agent_end", messages: [] });
    return events;
  }

  private resetPartial(): void {
    this.streamingMessage = null;
    this.blocks.clear();
  }

  private ensurePartial(events: AgentEventLike[]): PiAssistantMessage {
    if (this.streamingMessage) return this.streamingMessage;
    const message: PiAssistantMessage = {
      role: "assistant",
      content: [],
      api: CLAUDE_API,
      provider: CLAUDE_PROVIDER,
      model: this.model,
      timestamp: this.now(),
    };
    this.streamingMessage = message;
    events.push({ type: "message_start", message });
    return message;
  }

  private update(partial: PiAssistantMessage, assistantMessageEvent: Record<string, unknown>): AgentEventLike {
    // No `message` beside it: a reconnecting page's snapshot is this partial, and the stream
    // skips events whose `message` is the snapshot (isEventIncludedInSnapshot).
    return { type: "message_update", assistantMessageEvent: { ...assistantMessageEvent, partial } };
  }

  private streamEvent(event: Record<string, unknown>): AgentEventLike[] {
    const events: AgentEventLike[] = [];
    const index = typeof event.index === "number" ? event.index : -1;
    switch (event.type) {
      case "message_start":
        if (isObject(event.message) && typeof event.message.model === "string") this.model = event.message.model;
        return events;
      case "content_block_start": {
        const block = isObject(event.content_block) ? event.content_block : {};
        const partial = this.ensurePartial(events);
        const local = partial.content.length;
        if (block.type === "text") {
          partial.content.push({ type: "text", text: "" });
          this.blocks.set(index, { local, kind: "text", rawJson: "" });
          events.push(this.update(partial, { type: "text_start", contentIndex: local }));
        } else if (block.type === "thinking") {
          partial.content.push({ type: "thinking", thinking: "" });
          this.blocks.set(index, { local, kind: "thinking", rawJson: "" });
          events.push(this.update(partial, { type: "thinking_start", contentIndex: local }));
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          const name = typeof block.name === "string" ? block.name : "tool";
          this.toolNames.set(block.id, name);
          partial.content.push({ type: "toolCall", id: block.id, name, arguments: {} });
          this.blocks.set(index, { local, kind: "toolCall", rawJson: "" });
          events.push(this.update(partial, { type: "toolcall_start", contentIndex: local }));
        }
        return events;
      }
      case "content_block_delta": {
        const known = this.blocks.get(index);
        const partial = this.streamingMessage;
        const delta = isObject(event.delta) ? event.delta : {};
        if (!known || !partial) return events;
        const block = partial.content[known.local];
        if (delta.type === "text_delta" && typeof delta.text === "string" && block?.type === "text") {
          block.text += delta.text;
          events.push(this.update(partial, { type: "text_delta", contentIndex: known.local, delta: delta.text }));
        } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking && block?.type === "thinking") {
          block.thinking += delta.thinking;
          events.push(this.update(partial, { type: "thinking_delta", contentIndex: known.local, delta: delta.thinking }));
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && block?.type === "toolCall") {
          known.rawJson += delta.partial_json;
          if (delta.partial_json) {
            events.push(this.update(partial, { type: "toolcall_delta", contentIndex: known.local, delta: delta.partial_json }));
          }
        }
        return events;
      }
      case "content_block_stop": {
        // Usually the block's `assistant` event already ended the reply; then nothing is open.
        const known = this.blocks.get(index);
        const partial = this.streamingMessage;
        if (!known || !partial) return events;
        const block = partial.content[known.local];
        if (block?.type === "text") {
          events.push(this.update(partial, { type: "text_end", contentIndex: known.local, content: block.text }));
        } else if (block?.type === "thinking") {
          events.push(this.update(partial, { type: "thinking_end", contentIndex: known.local, content: block.thinking }));
        } else if (block?.type === "toolCall") {
          block.arguments = parseJsonObject(known.rawJson);
          events.push(this.update(partial, { type: "toolcall_end", contentIndex: known.local, toolCall: block }));
        }
        return events;
      }
      default:
        return events;
    }
  }

  /** One finished content block (or several): the authoritative reply, ending what was streamed. */
  private assistant(message: Record<string, unknown>, timestamp: unknown): AgentEventLike[] {
    const events: AgentEventLike[] = [];
    if (typeof message.model === "string" && message.model) this.model = message.model;
    const content = toAssistantBlocks(message.content);
    const partial = this.streamingMessage;
    this.resetPartial();
    for (const block of content) if (block.type === "toolCall") this.toolNames.set(block.id, block.name);
    // Redacted thinking alone renders nothing: the next block's reply replaces the stream.
    if (content.length === 0) return events;
    const final: PiAssistantMessage = {
      role: "assistant",
      content,
      api: CLAUDE_API,
      provider: CLAUDE_PROVIDER,
      model: this.model,
      ...(typeof message.stop_reason === "string" ? { stopReason: message.stop_reason } : {}),
      timestamp: partial?.timestamp ?? timestampOf(timestamp, this.now()),
    };
    if (!partial) events.push({ type: "message_start", message: final });
    events.push({ type: "message_end", message: final });
    for (const block of content) {
      if (block.type === "toolCall") {
        events.push({ type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments });
      }
    }
    events.push(...this.toolCallRuns([final]));
    return events;
  }

  private user(message: Record<string, unknown>, timestamp: unknown, receipt: unknown): AgentEventLike[] {
    const events: AgentEventLike[] = [];
    const at = timestampOf(timestamp, this.now());
    for (const block of toolResultBlocks(message.content)) {
      const result = toToolResult(block, this.toolNames, at);
      events.push({ type: "tool_execution_end", toolCallId: result.toolCallId, toolName: result.toolName, isError: result.isError });
      events.push({ type: "message_start", message: result });
      events.push({ type: "message_end", message: result });
    }
    events.push(...this.toolResultRuns(message, receipt));
    return events;
  }

  private result(raw: Record<string, unknown>): ClaudeTranslation {
    const events: AgentEventLike[] = [];
    // A turn that ends mid-block (an error) keeps what was streamed.
    if (this.streamingMessage) events.push(...this.flush().filter((event) => event.type !== "agent_end"));
    this.resetPartial();
    events.push({ type: "agent_end", messages: [] });
    const errors = Array.isArray(raw.errors) ? raw.errors.filter((entry): entry is string => typeof entry === "string") : [];
    const failed = raw.is_error === true || (typeof raw.subtype === "string" && raw.subtype !== "success");
    const error = failed
      ? (typeof raw.result === "string" && raw.result ? raw.result : errors.join("\n") || String(raw.subtype ?? "claude reported an error"))
      : undefined;
    return { events, turnEnd: { usage: claudeResultUsage(raw), ...(error ? { error } : {}) } };
  }
}

/**
 * claude's bookkeeping of a command it ran itself (`/model` from a
 * `set_model` request, `/compact`): `<command-name>` / `<local-command-stdout>` user
 * entries no user typed, and the compaction summary only claude's transcript view shows.
 */
function isClaudeCommandBookkeeping(entry: Record<string, unknown>, message: Record<string, unknown>): boolean {
  if (entry.type !== "user") return false;
  if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return true;
  return entry.promptSource !== "sdk"
    && typeof message.content === "string"
    && /^<(command-name|local-command-stdout|local-command-stderr|local-command-caveat)>/.test(message.content);
}

/** A transcript entry claude wrote that is part of the conversation the user sees (a sidecar's own are sidechain). */
function conversationEntry(entry: unknown, sidechain: boolean): Record<string, unknown> | null {
  if (!isObject(entry) || (entry.type !== "user" && entry.type !== "assistant")) return null;
  if ((entry.isSidechain === true) !== sidechain || entry.isMeta === true || !isObject(entry.message)) return null;
  if (isClaudeCommandBookkeeping(entry, entry.message)) return null;
  return entry;
}

/** One subagent's sidecar, as claude writes it beside the transcript: `agent-<id>.jsonl` and `.meta.json`. */
export interface ClaudeSidecar {
  entries: readonly unknown[];
  meta?: unknown;
}

/** A session's sidecars by agent id (the `<id>` of `agent-<id>.jsonl`). */
export type ClaudeSidecars = Readonly<Record<string, ClaudeSidecar>>;

/** What the `<task-notification>` text claude adds to the main transcript reports for one run. */
interface ClaudeTaskNote {
  toolCallId: string;
  status?: ClaudeSubagentStatus;
  result?: string;
  usage?: ClaudeSubagentUsage;
}

function xmlTag(text: string, tag: string): string | undefined {
  const open = text.indexOf(`<${tag}>`);
  if (open < 0) return undefined;
  const from = open + tag.length + 2;
  const close = text.indexOf(`</${tag}>`, from);
  return close < 0 ? undefined : text.slice(from, close).trim();
}

function taskNotificationText(entry: Record<string, unknown>, message: Record<string, unknown>): string | null {
  const text = typeof message.content === "string" ? message.content : textOf(message.content);
  return entry.turnOrigin === "task_notification" || text.trimStart().startsWith("<task-notification>") ? text : null;
}

function taskNote(text: string): ClaudeTaskNote | null {
  const toolCallId = xmlTag(text, "tool-use-id");
  if (!toolCallId) return null;
  const tokens = xmlTag(text, "subagent_tokens") ?? xmlTag(text, "total_tokens");
  const toolUses = xmlTag(text, "tool_uses");
  const duration = xmlTag(text, "duration_ms");
  const result = xmlTag(text, "result");
  const status = claudeTaskStatus(xmlTag(text, "status"));
  return {
    toolCallId,
    ...(status ? { status } : {}),
    ...(result ? { result } : {}),
    ...(tokens || toolUses || duration ? { usage: { totalTokens: Number(tokens) || 0, toolUses: Number(toolUses) || 0, durationMs: Number(duration) || 0 } } : {}),
  };
}

interface HistoryWalk {
  runs: Map<string, ClaudeSubagentRun>;
  notes: ClaudeTaskNote[];
  toolNames: Map<string, string>;
  model: string;
}

/**
 * Walks one transcript (the main one, or a sidecar with `sidechain`) in file order,
 * handing each displayed entry to `emit`: the same mapping the live stream uses
 * (subagentEntries()), the `Agent` / `Task` calls registered as runs and their
 * receipts / results folded in, and claude's `<task-notification>` turn as a hidden
 * anchor (its report kept as a note) instead of a user bubble.
 */
function walkTranscript(entries: readonly unknown[], walk: HistoryWalk, sidechain: boolean, emit: (entry: ClaudeSubagentEntry) => void): void {
  entries.forEach((raw, position) => {
    // claude's compaction boundary: the compaction card, where it happened.
    if (!sidechain && isObject(raw) && raw.type === "system" && raw.subtype === "compact_boundary") {
      const id = typeof raw.uuid === "string" ? raw.uuid : `claude-${position}`;
      emit({ id, message: claudeCompactionMarker(raw, timestampOf(raw.timestamp, 0)) as unknown as ClaudeSubagentEntry["message"] });
      return;
    }
    const entry = conversationEntry(raw, sidechain);
    if (!entry) return;
    const message = entry.message as Record<string, unknown>;
    const id = typeof entry.uuid === "string" ? entry.uuid : `claude-${position}`;
    const at = timestampOf(entry.timestamp, 0);
    if (entry.type === "assistant" && typeof message.model === "string" && message.model) walk.model = message.model;
    if (entry.type === "user") {
      const notification = taskNotificationText(entry, message);
      if (notification !== null) {
        const note = taskNote(notification);
        if (note) walk.notes.push(note);
        emit({ id, message: claudeTaskNotificationAnchor(note ? [note.toolCallId] : [], at) as unknown as ClaudeSubagentEntry["message"] });
        return;
      }
    }
    const converted = subagentEntries(entry.type, message, id, at, walk.toolNames, walk.model);
    for (const item of converted) {
      emit(item);
      const out = item.message;
      if (out.role === "assistant" && Array.isArray(out.content)) {
        for (const block of out.content as PiAssistantBlock[]) {
          if (block.type === "toolCall" && isClaudeSubagentToolName(block.name) && !walk.runs.has(block.id)) walk.runs.set(block.id, runFromToolCall(block));
        }
      }
    }
    if (entry.type === "user") {
      for (const block of toolResultBlocks(message.content)) {
        const toolCallId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
        const run = walk.runs.get(toolCallId);
        if (!run) continue;
        walk.runs.set(toolCallId, { ...run, ...runFromToolResult(toolCallId, entry.toolUseResult, block.content, block.is_error === true) });
      }
    }
  });
}

/**
 * A claude jsonl transcript (parsed entries, file order) → the pi messages the
 * chat shows, with each one's transcript `uuid` as its entry id, and the subagent
 * runs its `Agent` / `Task` calls started. A run's entries come
 * from its sidecar — linked by the receipt's `toolUseResult.agentId`, else the
 * sidecar meta's `toolUseId` — never from the main list; nested sidecars are
 * followed the same way. A missing sidecar leaves its run without entries.
 */
export function claudeTranscriptToMessages(
  entries: readonly unknown[],
  sidecars: ClaudeSidecars = {},
): { messages: AgentMessage[]; entryIds: string[]; subagents: ClaudeSubagentRun[] } {
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  const walk: HistoryWalk = { runs: new Map(), notes: [], toolNames: new Map(), model: "" };
  walkTranscript(entries, walk, false, (entry) => {
    messages.push(entry.message as unknown as AgentMessage);
    entryIds.push(entry.id);
  });
  const metaToolCall = new Map<string, string>();
  for (const [agentId, sidecar] of Object.entries(sidecars)) {
    if (isObject(sidecar.meta) && typeof sidecar.meta.toolUseId === "string") metaToolCall.set(sidecar.meta.toolUseId, agentId);
  }
  const linked = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const run of [...walk.runs.values()]) {
      const agentId = run.agentId ?? metaToolCall.get(run.toolCallId);
      const sidecar = agentId ? sidecars[agentId] : undefined;
      if (!agentId || !sidecar || linked.has(agentId)) continue;
      linked.add(agentId);
      changed = true;
      const meta = isObject(sidecar.meta) ? sidecar.meta : {};
      const timeline: ClaudeSubagentEntry[] = [];
      let first = true;
      let prompt = run.prompt;
      walkTranscript(sidecar.entries, walk, true, (entry) => {
        // A sidecar opens with the run's prompt: the row shows it once, above the timeline.
        if (first && entry.message.role === "user" && typeof entry.message.content === "string") {
          prompt ??= entry.message.content;
          first = false;
          return;
        }
        first = false;
        timeline.push(entry);
      });
      const current = walk.runs.get(run.toolCallId) ?? run;
      walk.runs.set(run.toolCallId, {
        ...current,
        agentId,
        ...(current.agentType ? {} : typeof meta.agentType === "string" ? { agentType: meta.agentType } : {}),
        ...(current.description ? {} : typeof meta.description === "string" ? { description: meta.description } : {}),
        ...(prompt ? { prompt } : {}),
        ...(meta.requestShape === "background" ? { background: true } : {}),
        ...(current.status === "running" && meta.finished === true ? { status: "completed" as const } : {}),
        entries: timeline,
      });
    }
  }
  for (const note of walk.notes) {
    const run = walk.runs.get(note.toolCallId);
    if (!run) continue;
    walk.runs.set(note.toolCallId, {
      ...run,
      ...(note.status ? { status: note.status } : run.status === "running" ? { status: "completed" as const } : {}),
      ...(note.result ? { result: note.result } : {}),
      ...(note.usage ? { usage: note.usage } : {}),
    });
  }
  return { messages, entryIds, subagents: [...walk.runs.values()] };
}

/** Parses a jsonl transcript's text; unreadable lines are skipped. */
export function parseClaudeTranscript(text: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A line claude is still writing.
    }
  }
  return entries;
}

/** Each stdout line → its decoded event; a partial last line waits for the next chunk. */
export class ClaudeLineDecoder {
  private buffer = "";

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const decoded: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        decoded.push(JSON.parse(line));
      } catch {
        // Not an event (a stray log line): ignored.
      }
    }
    return decoded;
  }
}
