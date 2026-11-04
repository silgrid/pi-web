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

// the real claude 2.1.312 image turn (text + one PNG block).
const recordedImageLine = JSON.parse(readFileSync(new URL("./__fixtures__/claude-2.1.312/image/stdin.jsonl", import.meta.url), "utf8"));
const recordedImage = recordedImageLine.message.content.find((block) => block.type === "image");
const recordedText = recordedImageLine.message.content.find((block) => block.type === "text").text;

test("the recorded image transcript maps the image block exactly and hides claude's isMeta companion", () => {
  const entries = fixture("image/transcript.jsonl");
  assert.ok(entries.some((entry) => entry.isMeta === true && /^\[Image: source: /.test(entry.message?.content?.[0]?.text ?? "")), "the recording holds the companion");
  const { messages } = adapter.claudeTranscriptToMessages(entries);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(messages[0].content, [
    { type: "text", text: recordedText },
    { type: "image", data: recordedImage.source.data, mimeType: recordedImage.source.media_type },
  ]);
  assert.equal(recordedImage.source.media_type, "image/png");
  assert.ok(messages.every((message) => JSON.stringify(message.content).indexOf("[Image: source:") === -1), "the companion renders nothing");
  const streamed = ended(translateAll(fixture("image/stream.jsonl")).events);
  assert.deepEqual(messages.slice(1).map((message) => message.content), streamed.map((message) => message.content));
});

test("the image stdin line is the line claude 2.1.312 accepted, byte for byte; image-only omits the text block", () => {
  const recordedLine = readFileSync(new URL("./__fixtures__/claude-2.1.312/image/stdin.jsonl", import.meta.url), "utf8");
  const images = [{ data: recordedImage.source.data, mimeType: recordedImage.source.media_type }];
  assert.equal(adapter.claudeUserInputLine(recordedText, images), recordedLine);
  assert.deepEqual(JSON.parse(adapter.claudeUserInputLine("", images)).message.content, [recordedImage]);
  assert.equal(adapter.claudeUserInputLine("hi", []), adapter.claudeUserInputLine("hi"));
});

test("the live prompt events carry the image blocks in pi's shape; text alone stays a string", () => {
  const images = [{ data: recordedImage.source.data, mimeType: "image/png" }];
  const [start, end] = adapter.claudeUserPromptEvents("look", images, 7);
  assert.equal(start.type, "message_start");
  assert.equal(end.type, "message_end");
  assert.deepEqual(end.message, { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: images[0].data, mimeType: "image/png" }], timestamp: 7 });
  assert.deepEqual(adapter.claudeUserPromptEvents("", images, 7)[1].message.content, [{ type: "image", data: images[0].data, mimeType: "image/png" }]);
  assert.equal(adapter.claudeUserPromptEvents("plain", [], 7)[1].message.content, "plain");
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

// subagent activity, on the real background-Agent recording.
const AGENT_ID = "toolu_01F1YZd2Gseivs4hckhQVw5s";
const READ_ID = "toolu_012N7brUKegpGiA36sdi1ApH";
const subagentEvents = (events) => events.filter((event) => event.type === adapter.CLAUDE_SUBAGENT_EVENT);

test("a subagent's Read, result and text go to its Agent run, never to a main-conversation event", () => {
  const { events } = translateAll(fixture("subagent/stream.jsonl"));
  const main = events.filter((event) => event.type !== adapter.CLAUDE_SUBAGENT_EVENT);
  assert.ok(!JSON.stringify(main).includes(READ_ID), "the subagent's Read leaked into the main conversation");
  assert.deepEqual(
    ended(main).map((message) => message.role === "custom" ? message.customType : `${message.role}:${message.content[0].type}`),
    ["assistant:toolCall", "toolResult:text", "assistant:text", "claude:task-notification", "assistant:text"],
    "the main conversation keeps the Agent call, its launch receipt, its reply, the follow-up anchor and the follow-up reply",
  );
  const runs = subagentEvents(events);
  assert.ok(runs.every((event) => event.run.toolCallId === AGENT_ID), "every subagent event names the Agent call");
  const entries = runs.flatMap((event) => event.run.entries);
  assert.deepEqual(entries.map((entry) => [entry.id, entry.message.role]), [
    ["989c7aa3-823f-4e39-b826-7a4fa64b76cc", "assistant"],
    ["9e9ed764-c94f-4c81-9581-cf1ff958eb80", "toolResult"],
    ["95f1af84-d81a-4ab5-adfd-e41b2d9a338b", "assistant"],
  ], "each entry arrives once, keyed by claude's uuid, in claude's order");
  assert.equal(entries[0].message.content[0].id, READ_ID);
  assert.equal(entries[1].message.toolName, "Read", "the subagent's tool result is named after its call");
});

test("the async launch receipt keeps the run running; claude's task events set its final state and statistics", () => {
  const recorded = fixture("subagent/stream.jsonl");
  const translator = new adapter.ClaudeStreamTranslator(() => 1000);
  const runAfter = [];
  for (const event of recorded) {
    const last = subagentEvents(translator.push(event).events).at(-1);
    if (last) runAfter.push({ cause: event.subtype ?? event.type, run: last.run });
  }
  const receipt = runAfter.find((step) => step.cause === "user" && step.run.agentId && step.run.entries.length === 0);
  assert.equal(receipt.run.status, "running", "async_launched is no completion");
  assert.equal(receipt.run.background, true);
  assert.equal(receipt.run.agentType, "general-purpose");
  assert.equal(receipt.run.description, "Read note.txt first line");
  const progress = runAfter.find((step) => step.cause === "task_progress").run;
  assert.equal(progress.progress, "Reading note.txt");
  assert.deepEqual(progress.entries, [], "a progress update adds no timeline entry");
  const final = runAfter.find((step) => step.cause === "task_notification").run;
  assert.equal(final.status, "completed");
  assert.deepEqual(final.usage, { totalTokens: 10379, toolUses: 1, durationMs: 1906 });
  assert.equal(final.result, "SUBAGENT_PROBE_TOKEN_253");
});

test("claude's follow-up turn opens with a hidden anchor; the session is unsettled until it starts", () => {
  const recorded = fixture("subagent/stream.jsonl");
  const translator = new adapter.ClaudeStreamTranslator(() => 1000);
  const unsettled = [];
  let turnStarts = 0;
  for (const event of recorded) {
    const translated = translator.push(event);
    if (translated.claudeTurnStart) {
      turnStarts += 1;
      assert.equal(event.subtype, "init");
      assert.deepEqual(translated.events.map((out) => [out.type, out.message.customType, out.message.display]), [
        ["message_start", "claude:task-notification", false],
        ["message_end", "claude:task-notification", false],
      ]);
    }
    unsettled.push(translator.hasUnsettledSubagents());
  }
  assert.equal(turnStarts, 1, "only the init after the notification starts claude's own turn");
  assert.equal(unsettled[0], false, "before any Agent call nothing is unsettled");
  const followUp = recorded.findIndex((event, index) => index > 0 && event.subtype === "init");
  assert.ok(unsettled.slice(2, followUp).every(Boolean), "unsettled from the Agent call to the follow-up turn (task_updated included)");
  assert.ok(unsettled.slice(followUp).every((value) => !value), "settled once claude's follow-up turn started");
});

test("a nested Agent call starts its own run, and its entries go to it, not to the parent's", () => {
  const translator = new adapter.ClaudeStreamTranslator(() => 1000);
  const events = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_outer", name: "Agent", input: { description: "outer", prompt: "p", subagent_type: "general-purpose" } }] }, parent_tool_use_id: null, uuid: "m1" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_inner", name: "Task", input: { description: "inner", prompt: "q", subagent_type: "Explore" } }] }, parent_tool_use_id: "toolu_outer", uuid: "s1" },
    { type: "assistant", message: { content: [{ type: "text", text: "deep text" }] }, parent_tool_use_id: "toolu_inner", uuid: "d1" },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }, parent_tool_use_id: "toolu_inner" },
    { type: "system", subtype: "task_something_new", task_id: "x" },
  ].flatMap((event) => translator.push(event).events);
  const runs = subagentEvents(events);
  assert.deepEqual(runs.map((event) => [event.run.toolCallId, event.run.entries.map((entry) => entry.id)]), [
    ["toolu_outer", []],
    ["toolu_outer", ["s1"]],
    ["toolu_inner", []],
    ["toolu_inner", ["d1"]],
  ]);
  assert.equal(runs[2].run.agentType, "Explore");
  assert.equal(runs[2].run.background, false, "a foreground call is no background run");
  assert.ok(!events.some((event) => event.type === "message_update"), "a subagent's partial stream is not shown in the main reply");
  assert.equal(translator.hasUnsettledSubagents(), false, "foreground runs hold nothing");
});

const SIDECAR_ID = "a9fb2ff3aa8e8ff40";
const sidecarsOf = () => ({
  [SIDECAR_ID]: {
    entries: fixture(`subagent/subagents/agent-${SIDECAR_ID}.jsonl`),
    meta: JSON.parse(readFileSync(new URL(`./__fixtures__/claude-2.1.312/subagent/subagents/agent-${SIDECAR_ID}.meta.json`, import.meta.url), "utf8")),
  },
});
const entryKeys = (entries) => entries.map((entry) => [entry.id, entry.message.role]);

test("history rebuilds the run from the sidecar, keeps its entries out of the main list and its prompt out of the timeline", () => {
  const history = adapter.claudeTranscriptToMessages(fixture("subagent/transcript.jsonl"), sidecarsOf());
  assert.equal(history.subagents.length, 1);
  const [run] = history.subagents;
  assert.equal(run.toolCallId, AGENT_ID);
  assert.equal(run.agentId, SIDECAR_ID, "linked by the receipt's toolUseResult.agentId");
  assert.equal(run.status, "completed");
  assert.equal(run.result, "SUBAGENT_PROBE_TOKEN_253", "the notification's <result>, not its summary line");
  assert.deepEqual(run.usage, { totalTokens: 10379, toolUses: 1, durationMs: 1906 });
  assert.match(run.prompt, /^Read the file note\.txt/);
  assert.ok(!run.entries.some((entry) => entry.message.role === "user"), "the sidecar's opening prompt is not repeated as an entry");
  assert.ok(!JSON.stringify(history.messages).includes(READ_ID), "the sidecar's entries are not main messages");
  assert.ok(JSON.stringify(history.messages).includes(AGENT_ID), "the Agent call stays in the main list");
});

test("live and history yield the same entries for the run", () => {
  const live = subagentEvents(translateAll(fixture("subagent/stream.jsonl")).events).flatMap((event) => event.run.entries);
  const [run] = adapter.claudeTranscriptToMessages(fixture("subagent/transcript.jsonl"), sidecarsOf()).subagents;
  assert.deepEqual(entryKeys(run.entries), entryKeys(live));
  assert.deepEqual(run.entries.map((entry) => entry.message.content), live.map((entry) => entry.message.content));
});

test("the task-notification turn is a hidden anchor, not a user bubble; the follow-up reply stays", () => {
  const { messages } = adapter.claudeTranscriptToMessages(fixture("subagent/transcript.jsonl"));
  const anchors = messages.filter((message) => message.role === "custom");
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].customType, "claude:task-notification");
  assert.equal(anchors[0].display, false);
  assert.ok(!messages.some((message) => message.role === "user" && JSON.stringify(message).includes("<task-notification>")));
  assert.match(messages.at(-1).content[0].text, /^The subagent finished and reported/);
});

test("a missing sidecar leaves the run without entries, and the meta's toolUseId links one without a receipt", () => {
  const [bare] = adapter.claudeTranscriptToMessages(fixture("subagent/transcript.jsonl")).subagents;
  assert.deepEqual(bare.entries, []);
  assert.equal(bare.status, "completed", "the notification still settles it");
  // A transcript cut before the receipt: only the meta names the call.
  const cut = fixture("subagent/transcript.jsonl").slice(0, 2);
  const [linked] = adapter.claudeTranscriptToMessages(cut, sidecarsOf()).subagents;
  assert.equal(linked.agentId, SIDECAR_ID);
  assert.equal(linked.entries.length, 3);
  assert.equal(linked.status, "completed", "the meta's finished flag is claude's own report");
});

test("nested sidecars are followed through the inner Agent call's receipt", () => {
  const main = [
    { type: "assistant", uuid: "m1", isSidechain: false, message: { content: [{ type: "tool_use", id: "toolu_outer", name: "Agent", input: { description: "outer", prompt: "go", subagent_type: "general-purpose" } }] } },
    { type: "user", uuid: "m2", isSidechain: false, message: { content: [{ type: "tool_result", tool_use_id: "toolu_outer", content: "outer done" }] }, toolUseResult: { status: "completed", agentId: "outer1", content: [{ type: "text", text: "outer done" }] } },
  ];
  const outer = [
    { type: "user", uuid: "o0", isSidechain: true, message: { content: "go" } },
    { type: "assistant", uuid: "o1", isSidechain: true, message: { content: [{ type: "tool_use", id: "toolu_inner", name: "Agent", input: { description: "inner", prompt: "deeper", subagent_type: "Explore" } }] } },
    { type: "user", uuid: "o2", isSidechain: true, message: { content: [{ type: "tool_result", tool_use_id: "toolu_inner", content: "inner done" }] }, toolUseResult: { status: "completed", agentId: "inner1" } },
  ];
  const inner = [
    { type: "user", uuid: "i0", isSidechain: true, message: { content: "deeper" } },
    { type: "assistant", uuid: "i1", isSidechain: true, message: { content: [{ type: "text", text: "deep text" }] } },
  ];
  const { subagents, messages } = adapter.claudeTranscriptToMessages(main, { outer1: { entries: outer }, inner1: { entries: inner } });
  assert.deepEqual(subagents.map((run) => [run.toolCallId, run.status, run.result, run.entries.map((entry) => entry.id)]), [
    ["toolu_outer", "completed", "outer done", ["o1", "o2"]],
    ["toolu_inner", "completed", "inner done", ["i1"]],
  ]);
  assert.ok(!JSON.stringify(messages).includes("deep text"));
});

test("the recorded control responses translate into answers, never chat messages; the builders reproduce the accepted requests", () => {
  const stdin = fixture("model-switch/stdin.jsonl");
  assert.equal(adapter.claudeSetModelLine(stdin[2].request_id, "claude-sonnet-5-5"), `${JSON.stringify(stdin[2])}\n`);
  const effortStdin = fixture("effort/stdin.jsonl");
  assert.equal(adapter.claudeSetEffortLine(effortStdin[1].request_id, "max"), `${JSON.stringify(effortStdin[1])}\n`);
  const translator = new adapter.ClaudeStreamTranslator(() => 1);
  const answers = [];
  const assistantModels = [];
  for (const event of fixture("model-switch/stream.jsonl")) {
    const translated = translator.push(event);
    if (translated.control) {
      answers.push(translated.control);
      assert.deepEqual(translated.events, []);
    }
    for (const out of translated.events) if (out.type === "message_end" && out.message.role === "assistant") assistantModels.push(out.message.model);
    for (const out of translated.events) assert.ok(!(out.type === "message_end" && out.message.role === "user"), "a /model bookkeeping event became a user message");
  }
  assert.deepEqual(answers.map((answer) => [answer.requestId, answer.subtype, answer.errorCode ?? null]), [["req_switch_bogus", "error", "check_failed"], ["req_switch_sonnet", "success", null]]);
  assert.match(answers[0].error, /model not changed/);
  assert.deepEqual(answers[1].response, { model: "claude-sonnet-5-5" });
  assert.deepEqual(assistantModels, ["claude-opus-5-5", "claude-sonnet-5-5"]);
  const effortAnswer = fixture("effort/stream.jsonl").map((event) => adapter.claudeControlResponse(event)).find(Boolean);
  assert.deepEqual(effortAnswer, { requestId: "req_effort_max", subtype: "success" });
});

test("the model-switch transcript shows the user's words and both replies, not claude's /model bookkeeping", () => {
  const { messages } = adapter.claudeTranscriptToMessages(fixture("model-switch/transcript.jsonl"));
  const users = messages.filter((message) => message.role === "user").map((message) => message.content);
  assert.deepEqual(users, ["Reply with exactly the word: one", "Reply with exactly the word: two"]);
  assert.deepEqual(messages.filter((message) => message.role === "assistant").map((message) => message.model), ["claude-opus-5-5", "claude-sonnet-5-5"]);
});

test("the compact recording: the bare /compact line, compact_boundary's token figure, the transcript marker without a summary", () => {
  assert.equal(adapter.claudeCompactLine(), `${JSON.stringify(fixture("compact/stdin.jsonl").at(-1))}\n`);
  const translator = new adapter.ClaudeStreamTranslator(() => 1);
  const boundaries = fixture("compact/stream.jsonl").map((event) => translator.push(event).compactBoundary).filter(Boolean);
  assert.deepEqual(boundaries, [{ tokensBefore: 16739 }]);
  const { messages, entryIds } = adapter.claudeTranscriptToMessages(fixture("compact/transcript.jsonl"));
  const markers = messages.filter((message) => message.role === "custom" && message.customType === "compaction");
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0].details, { tokensBefore: 16739 });
  assert.equal(markers[0].content, "", "no summary body");
  assert.equal(markers[0].display, true);
  assert.equal(entryIds[messages.indexOf(markers[0])], fixture("compact/transcript.jsonl").find((entry) => entry.subtype === "compact_boundary").uuid);
  assert.deepEqual(messages.filter((message) => message.role === "user").map((message) => message.content), [
    "Remember the colour teal. Reply with exactly the word: noted",
    "Which colour did I ask you to remember? Reply with one word.",
  ], "every pre-compaction message stays; no summary or /compact bookkeeping bubble");
  assert.equal(messages.filter((message) => message.role === "assistant").length, 2);
  assert.ok(messages.indexOf(markers[0]) > messages.findLastIndex((message) => message.role === "assistant"), "the marker sits where claude compacted");
});
