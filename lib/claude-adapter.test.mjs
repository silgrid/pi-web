import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const adapter = await jiti.import("./claude-adapter.ts");
const { toClientAgentEvent } = await jiti.import("./agent-event-wire.ts");

const fixture = (name) => adapter.parseClaudeTranscript(readFileSync(new URL(`./__fixtures__/claude-2.1.312/${name}`, import.meta.url), "utf8"));

function translateAll(events) {
  const translator = new adapter.ClaudeStreamTranslator(() => 1000);
  const out = [];
  let turnEnd;
  for (const event of events) {
    const translated = translator.push(event);
    out.push(...translated.events);
    if (translated.turnEnd) turnEnd = translated.turnEnd;
  }
  return { translator, events: out, turnEnd };
}

const ended = (events) => events.filter((event) => event.type === "message_end").map((event) => event.message);

test("the recorded stream maps to streamed deltas, a tool call, its result and the turn end", () => {
  const recorded = fixture("stream.jsonl");
  const { translator, events, turnEnd } = translateAll(recorded);
  const init = recorded.find((event) => event.type === "system" && event.subtype === "init");
  assert.equal(translator.sessionId, init.session_id, "the session identity comes from the stream");

  const messages = ended(events);
  assert.deepEqual(messages.map((message) => message.role), ["assistant", "toolResult", "assistant"]);
  const [call, result, reply] = messages;
  assert.deepEqual(call.content, [{ type: "toolCall", id: "toolu_019r4f1eeY8DPjUCUz7UJ7pU", name: "Read", arguments: { file_path: "/tmp/claude-rec/work/notes.txt" } }]);
  assert.equal(call.provider, "claude");
  assert.equal(call.model, "claude-haiku-5-5");
  assert.equal(result.toolCallId, "toolu_019r4f1eeY8DPjUCUz7UJ7pU");
  assert.equal(result.toolName, "Read");
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /PINEAPPLE/);
  assert.match(reply.content[0].text, /PINEAPPLE/);

  // Token-level streaming: the text deltas, in order, make up the final reply.
  const textDeltas = events.filter((event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta");
  assert.ok(textDeltas.length > 3);
  assert.equal(textDeltas.map((event) => event.assistantMessageEvent.delta).join(""), reply.content[0].text);
  // The tool input streams too, and reaches the browser with its id and name.
  const toolStart = events.find((event) => event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_start");
  assert.deepEqual(
    { id: toClientAgentEvent(toolStart).assistantMessageEvent.id, toolName: toClientAgentEvent(toolStart).assistantMessageEvent.toolName },
    { id: "toolu_019r4f1eeY8DPjUCUz7UJ7pU", toolName: "Read" },
  );
  const execution = events.filter((event) => event.type.startsWith("tool_execution_"));
  assert.deepEqual(execution.map((event) => [event.type, event.toolCallId, event.toolName]), [
    ["tool_execution_start", "toolu_019r4f1eeY8DPjUCUz7UJ7pU", "Read"],
    ["tool_execution_end", "toolu_019r4f1eeY8DPjUCUz7UJ7pU", "Read"],
  ]);
  assert.equal(events.at(-1).type, "agent_end");
  assert.equal(turnEnd.error, undefined);
  assert.equal(translator.streamingMessage, null);
});

test("usage is the result aggregate, not the streamed per-message sum", () => {
  const recorded = fixture("stream.jsonl");
  const { turnEnd } = translateAll(recorded);
  const result = recorded.find((event) => event.type === "result");
  assert.deepEqual(turnEnd.usage, {
    input: result.usage.input_tokens,
    output: result.usage.output_tokens,
    cacheRead: result.usage.cache_read_input_tokens,
    cacheWrite: result.usage.cache_creation_input_tokens,
    cost: result.total_cost_usd,
  });
  assert.equal(turnEnd.usage.output, 283);
  const streamedOutput = recorded
    .filter((event) => event.type === "stream_event" && event.event.type === "message_start")
    .reduce((sum, event) => sum + event.event.message.usage.output_tokens, 0);
  assert.notEqual(turnEnd.usage.output, streamedOutput);
  assert.ok(streamedOutput < turnEnd.usage.output);
});

test("the recorded transcript maps to the same conversation the stream showed", () => {
  const { messages, entryIds } = adapter.claudeTranscriptToMessages(fixture("transcript.jsonl"));
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
  assert.match(messages[0].content, /^Use the Glob tool/);
  const streamed = ended(translateAll(fixture("stream.jsonl")).events);
  assert.deepEqual(messages.slice(1).map((message) => message.content), streamed.map((message) => message.content));
  assert.equal(messages[2].toolName, "Read");
  assert.equal(entryIds.length, messages.length);
  assert.ok(entryIds.every((id) => /^[0-9a-f-]{36}$/.test(id)));
});

test("a permission denial is an error tool result naming the denial, and the turn still ends", () => {
  const { events, turnEnd } = translateAll(fixture("writable-bash-deny.jsonl"));
  const results = ended(events).filter((message) => message.role === "toolResult");
  assert.deepEqual(results.map((message) => message.isError), [false, true]);
  assert.equal(results[0].content[0].text, "allowed-ok");
  assert.match(results[1].content[0].text, /Permission for this tool use was denied/);
  assert.equal(results[1].toolName, "Bash");
  assert.equal(events.filter((event) => event.type === "tool_execution_end").at(-1).isError, true);
  assert.equal(events.at(-1).type, "agent_end");
  assert.equal(turnEnd.error, undefined);
});

test("a read-only write request ends with a refusal and no tool call (no write tool exists)", () => {
  const { events } = translateAll(fixture("read-only-deny.jsonl"));
  const messages = ended(events);
  assert.ok(messages.every((message) => message.role === "assistant"));
  assert.ok(messages.every((message) => message.content.every((block) => block.type !== "toolCall")));
  assert.match(messages.at(-1).content[0].text, /can't create/);
});

test("unknown events and junk are ignored, never thrown", () => {
  const translator = new adapter.ClaudeStreamTranslator();
  for (const event of [null, 42, "x", { type: "nope" }, { type: "stream_event", event: { type: "content_block_delta", index: 9, delta: { type: "text_delta", text: "x" } } }, { type: "user", message: { content: "plain" } }]) {
    assert.deepEqual(translator.push(event).events, []);
  }
});

test("a failed turn reports claude's own error", () => {
  const translator = new adapter.ClaudeStreamTranslator();
  const { turnEnd, events } = translator.push({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login", usage: {}, total_cost_usd: 0 });
  assert.equal(turnEnd.error, "Invalid API key · Please run /login");
  assert.deepEqual(events, [{ type: "agent_end", messages: [] }]);
});

test("flush keeps a partly streamed reply as a final message, then ends the run", () => {
  const translator = new adapter.ClaudeStreamTranslator(() => 5);
  translator.push({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  translator.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "half a rep" } } });
  assert.equal(translator.streamingMessage.content[0].text, "half a rep");
  const events = translator.flush();
  assert.deepEqual(events.map((event) => event.type), ["message_end", "agent_end"]);
  assert.equal(events[0].message.content[0].text, "half a rep");
  assert.equal(translator.streamingMessage, null);
});

test("stdin lines and the line decoder speak stream-json", () => {
  assert.deepEqual(JSON.parse(adapter.claudeUserInputLine("hi")), { type: "user", message: { role: "user", content: "hi" } });
  assert.deepEqual(JSON.parse(adapter.claudeInterruptLine("r1")), { type: "control_request", request_id: "r1", request: { subtype: "interrupt" } });
  const decoder = new adapter.ClaudeLineDecoder();
  assert.deepEqual(decoder.push('{"a":1}\n{"b"'), [{ a: 1 }]);
  assert.deepEqual(decoder.push(':2}\nnot json\n'), [{ b: 2 }]);
});
