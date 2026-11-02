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

export interface ClaudeTranslation {
  events: AgentEventLike[];
  /** Set by the `result` event that ends a turn. */
  turnEnd?: ClaudeTurnEnd;
}

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

/** The pi events a prompt pi-web wrote to claude's stdin is announced with. */
export function claudeUserPromptEvents(text: string, timestamp = Date.now()): AgentEventLike[] {
  const message: PiUserMessage = { role: "user", content: text, timestamp };
  return [{ type: "message_start", message }, { type: "message_end", message }];
}

/** The stdin line that delivers a user message (stream-json input). */
export function claudeUserInputLine(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/** The stdin line of the stream-json interrupt control request (Stop). */
export function claudeInterruptLine(requestId: string): string {
  return `${JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "interrupt" } })}\n`;
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

  constructor(private readonly now: () => number = Date.now) {}

  push(raw: unknown): ClaudeTranslation {
    if (!isObject(raw)) return { events: [] };
    if (typeof raw.session_id === "string" && raw.session_id) this.sessionId = raw.session_id;
    switch (raw.type) {
      case "system":
        if (raw.subtype === "init" && typeof raw.model === "string") this.model = raw.model;
        return { events: [] };
      case "stream_event":
        return { events: isObject(raw.event) ? this.streamEvent(raw.event) : [] };
      case "assistant":
        return { events: isObject(raw.message) ? this.assistant(raw.message, raw.timestamp) : [] };
      case "user":
        return { events: isObject(raw.message) ? this.user(raw.message, raw.timestamp) : [] };
      case "result":
        return this.result(raw);
      default:
        return { events: [] };
    }
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
    return events;
  }

  private user(message: Record<string, unknown>, timestamp: unknown): AgentEventLike[] {
    const events: AgentEventLike[] = [];
    const at = timestampOf(timestamp, this.now());
    for (const block of toolResultBlocks(message.content)) {
      const result = toToolResult(block, this.toolNames, at);
      events.push({ type: "tool_execution_end", toolCallId: result.toolCallId, toolName: result.toolName, isError: result.isError });
      events.push({ type: "message_start", message: result });
      events.push({ type: "message_end", message: result });
    }
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

/** A transcript entry claude wrote that is part of the conversation the user sees. */
function conversationEntry(entry: unknown): Record<string, unknown> | null {
  if (!isObject(entry) || (entry.type !== "user" && entry.type !== "assistant")) return null;
  if (entry.isSidechain === true || entry.isMeta === true || !isObject(entry.message)) return null;
  return entry;
}

/**
 * A claude jsonl transcript (parsed entries, file order) → the pi messages the
 * chat shows, with each one's transcript `uuid` as its entry id. Tool results are
 * named after the tool_use they answer.
 */
export function claudeTranscriptToMessages(entries: readonly unknown[]): { messages: AgentMessage[]; entryIds: string[] } {
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  const toolNames = new Map<string, string>();
  let model = "";
  entries.forEach((raw, position) => {
    const entry = conversationEntry(raw);
    if (!entry) return;
    const message = entry.message as Record<string, unknown>;
    const id = typeof entry.uuid === "string" ? entry.uuid : `claude-${position}`;
    const at = timestampOf(entry.timestamp, 0);
    if (entry.type === "assistant") {
      if (typeof message.model === "string" && message.model) model = message.model;
      const content = toAssistantBlocks(message.content);
      for (const block of content) if (block.type === "toolCall") toolNames.set(block.id, block.name);
      if (content.length === 0) return;
      const assistant: PiAssistantMessage = {
        role: "assistant",
        content,
        api: CLAUDE_API,
        provider: CLAUDE_PROVIDER,
        model,
        ...(typeof message.stop_reason === "string" ? { stopReason: message.stop_reason } : {}),
        timestamp: at,
      };
      messages.push(assistant as unknown as AgentMessage);
      entryIds.push(id);
      return;
    }
    const results = toolResultBlocks(message.content);
    if (results.length > 0) {
      results.forEach((block, index) => {
        messages.push(toToolResult(block, toolNames, at) as unknown as AgentMessage);
        entryIds.push(index === 0 ? id : `${id}:${index}`);
      });
      return;
    }
    const content = typeof message.content === "string" ? message.content : toResultContent(message.content);
    if (typeof content === "string" ? !content : content.length === 0) return;
    const user: PiUserMessage = { role: "user", content, timestamp: at };
    messages.push(user as unknown as AgentMessage);
    entryIds.push(id);
  });
  return { messages, entryIds };
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
