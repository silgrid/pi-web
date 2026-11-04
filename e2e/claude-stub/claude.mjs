#!/usr/bin/env node
/**
 * PATH-injected stand-in for the `claude` CLI ( e2e, authored
 * before `code`).
 *
 * The suite puts a copy of this file on the server's PATH as `claude`, so
 * pi-web's PATH-only binary resolution finds a real executable and spawns it
 * as a child. The stub speaks the same stream-json dialect that claude 2.1.312
 * emits (recorded from the real CLI: `system`/`init`, `stream_event`
 * `content_block_*` + `text_delta`/`input_json_delta`, full `assistant`
 * messages, a `user` tool_result event and the final `result` aggregate), and
 * it appends a real-shaped jsonl transcript under
 * `<config dir>/projects/<encoded cwd>/<session id>.jsonl` so the session's
 * history can be rendered from claude's own transcript. The config dir is the
 * child's inherited `CLAUDE_CONFIG_DIR` when pi-web passed one through, else
 * the child's `$HOME/.claude` (the system claude's own dir).
 *
 * It records — for the test only — each launch's argv, its child environment
 * variable NAMES (never values) and the resolved config dir, plus an `exit`
 * record when it is terminated. Nothing else leaves the process.
 *
 * Every stdin line is recorded too (`{ kind: "stdin", pid, line }`), so a suite
 * can assert the exact bytes pi-web wrote to the child.
 *
 * Image mode (`PI_E2E_CLAUDE_STUB_MODE=image`): a user event whose
 * content carries an image block (text optional) is answered like the real claude
 * 2.1.312 answered one: the received user entry (content verbatim, inline base64)
 * and claude's hidden `isMeta` `[Image: source: …]` companion are written to the
 * transcript first, then the recorded `stream.jsonl` of
 * `$PI_E2E_CLAUDE_IMAGE_FIXTURE` is replayed with the recording's session id and
 * cwd replaced by this child's (its assistant messages appended before `result`).
 * A user event without an image keeps the synthesised reply; a missing fixture
 * falls back to it as well.
 *
 * Control channel and compaction (every mode): a `control_request`
 * `set_model` for one of the four full model names is answered like claude 2.1.312
 * answered it (`{subtype: "success", response: {model}}`, its `/model` bookkeeping
 * entries appended to the transcript) and later replies report that model; any other
 * name gets the recorded `check_failed` refusal and the model stays. An
 * `apply_flag_settings` `{effortLevel}` request is answered `success` and the level in force is logged (`{ kind: "effort" }`). A
 * user line that is exactly `/compact` is claude's own compaction: the transcript's
 * `compact_boundary` entry, the hidden summary and the `Compacted` bookkeeping are
 * appended first, then `status` compacting, `compact_boundary` and a zero-usage
 * `result` are streamed (lib/__fixtures__/claude-2.1.312/README.md, `compact/`).
 *
 * Fixture modes (`PI_E2E_CLAUDE_STUB_MODE=switch|effort|compact`):
 * each stdin line replays the next segment of the recording in
 * `$PI_E2E_CLAUDE_SWITCH_FIXTURE` / `$PI_E2E_CLAUDE_EFFORT_FIXTURE` /
 * `$PI_E2E_CLAUDE_COMPACT_FIXTURE` (a user line: the events up to its `result`; a
 * control request: its `control_response`, under this request's id), with the
 * recording's session id and cwd replaced by this child's and its assistant
 * entries / compact boundary appended to the transcript before `result`. A missing
 * fixture, or a line the recording has no segment left for, falls back to the
 * synthesised answer above; nothing ever hangs.
 *
 * Inputs (environment):
 *   PI_E2E_CLAUDE_STUB_LOG       the jsonl record file (argv / env names / stdin / exits)
 *   PI_E2E_CLAUDE_STUB_MODE      unset, `image`, `switch`, `effort` or `compact` (above)
 *   PI_E2E_CLAUDE_IMAGE_FIXTURE  the recording directory image mode replays
 *   PI_E2E_CLAUDE_SWITCH_FIXTURE   the `model-switch/` recording directory
 *   PI_E2E_CLAUDE_EFFORT_FIXTURE   the `effort/` recording directory
 *   PI_E2E_CLAUDE_COMPACT_FIXTURE  the `compact/` recording directory
 *   CLAUDE_CONFIG_DIR            the inherited config dir, when pi-web has one
 *   HOME                         hosts the `~/.claude` fallback
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const logPath = process.env.PI_E2E_CLAUDE_STUB_LOG;
const argv = process.argv.slice(2);
const valueOf = (flag) => {
  const equals = argv.find((arg) => arg.startsWith(`${flag}=`));
  if (equals) return equals.slice(flag.length + 1);
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};

const cwd = process.cwd();
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude");
const resumeId = valueOf("--resume");
const sessionId = resumeId ?? valueOf("--session-id") ?? randomUUID();
// The current model and effort: argv first, then whatever a control request switched to.
let model = valueOf("--model");
let effort = valueOf("--effort");
const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  } catch {
    /* the suite removes its scratch tree at the end */
  }
}

record({
  kind: "launch",
  pid: process.pid,
  argv,
  cwd,
  configDir: configDir || null,
  envKeys: Object.keys(process.env).sort(),
  resumed: Boolean(resumeId),
  sessionId,
});

let exited = false;
function recordExit() {
  if (exited) return;
  exited = true;
  record({ kind: "exit", pid: process.pid, sessionId });
}
process.on("exit", recordExit);
process.on("SIGTERM", () => { recordExit(); process.exit(0); });
process.on("SIGINT", () => { recordExit(); process.exit(0); });

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

const transcriptPath = () => join(
  configDir ?? "",
  "projects",
  cwd.replace(/[^A-Za-z0-9._-]/g, "-"),
  `${sessionId}.jsonl`,
);
let parentUuid = null;
function appendTranscript(type, message, extra = {}) {
  const uuid = randomUUID();
  const entry = {
    type,
    message,
    uuid,
    parentUuid,
    sessionId,
    cwd,
    version: "2.1.312",
    timestamp: new Date().toISOString(),
    isSidechain: false,
    userType: "external",
    ...extra,
  };
  parentUuid = entry.uuid;
  try {
    mkdirSync(dirname(transcriptPath()), { recursive: true });
    appendFileSync(transcriptPath(), `${JSON.stringify(entry)}\n`);
  } catch {
    /* the suite removes its scratch tree at the end */
  }
}

let turn = 0;
const probePath = join(cwd, "e2e-probe.txt");

async function respond(userText) {
  turn += 1;
  const messageId = `msg_e2e_${turn}`;
  const toolId = `toolu_e2e_${turn}`;
  const streamed = `E2E streamed reply to ${userText}`;
  const finalText = `E2E final reply to ${userText}`;
  const toolOutput = `E2E tool output: ${userText}`;
  const modelId = model ?? "claude-default";
  const meta = { session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID() };
  const usage = { input_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };

  appendTranscript("user", { role: "user", content: userText }, { promptSource: "sdk" });

  emit({
    type: "stream_event",
    event: { type: "message_start", message: { id: messageId, type: "message", role: "assistant", model: modelId, content: [], usage } },
    ...meta,
  });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, ...meta });
  const chunks = [streamed.slice(0, 20), streamed.slice(20, 30), streamed.slice(30)];
  for (const text of chunks.filter(Boolean)) {
    emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, ...meta });
    await sleep(200);
  }
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, ...meta });
  const streamedMessage = { id: messageId, type: "message", role: "assistant", model: modelId, content: [{ type: "text", text: streamed }], stop_reason: null, usage };
  emit({ type: "assistant", message: streamedMessage, ...meta });
  appendTranscript("assistant", streamedMessage);

  // One tool call per turn, so the chat shows a tool call row and its result.
  emit({
    type: "stream_event",
    event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: toolId, name: "Read", input: {} } },
    ...meta,
  });
  const inputJson = JSON.stringify({ file_path: probePath });
  for (let at = 0; at < inputJson.length; at += 12) {
    emit({
      type: "stream_event",
      event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: inputJson.slice(at, at + 12) } },
      ...meta,
    });
    await sleep(100);
  }
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 1 }, ...meta });
  const toolMessage = {
    id: `${messageId}_tool`,
    type: "message",
    role: "assistant",
    model: modelId,
    content: [{ type: "tool_use", id: toolId, name: "Read", input: { file_path: probePath } }],
    stop_reason: "tool_use",
    usage,
  };
  emit({ type: "assistant", message: toolMessage, ...meta });
  appendTranscript("assistant", toolMessage);

  emit({
    type: "user",
    message: { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content: toolOutput }] },
    ...meta,
  });
  appendTranscript("user", { role: "user", content: [{ tool_use_id: toolId, type: "tool_result", content: toolOutput }] });

  emit({ type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } }, ...meta });
  for (const text of [finalText.slice(0, 14), finalText.slice(14)]) {
    emit({ type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "text_delta", text } }, ...meta });
    await sleep(120);
  }
  emit({ type: "stream_event", event: { type: "content_block_stop", index: 2 }, ...meta });
  const finalMessage = { id: `${messageId}_final`, type: "message", role: "assistant", model: modelId, content: [{ type: "text", text: finalText }], stop_reason: "end_turn", usage };
  emit({ type: "assistant", message: finalMessage, ...meta });
  appendTranscript("assistant", finalMessage);

  await sleep(200);
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    result: finalText,
    num_turns: turn,
    duration_ms: 1200,
    total_cost_usd: 0.0125,
    permission_denials: [],
    usage: { input_tokens: 42, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 37 },
    uuid: randomUUID(),
  });
}

// The recording's own identifiers (lib/__fixtures__/claude-2.1.312/README.md, `image/`).
const RECORDED_SESSION_ID = "27000000-0000-4000-8000-000000000270";
const RECORDED_CWD = "/tmp/claude-img-rec";

function recordedImageStream() {
  const dir = process.env.PI_E2E_CLAUDE_IMAGE_FIXTURE;
  if (!dir) return null;
  try {
    const text = readFileSync(join(dir, "stream.jsonl"), "utf8")
      .split(RECORDED_SESSION_ID).join(sessionId)
      .split(RECORDED_CWD).join(cwd);
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return null;
  }
}

async function respondWithImage(content, userText) {
  const events = recordedImageStream();
  if (!events) return respond(userText || "[Image]");
  turn += 1;
  // The transcript holds the received image before anything is streamed ('s order).
  appendTranscript("user", { role: "user", content }, { promptSource: "sdk" });
  const images = content.filter((block) => block?.type === "image");
  images.forEach((block, index) => {
    const ext = String(block.source?.media_type ?? "image/png").split("/")[1] ?? "png";
    appendTranscript(
      "user",
      { role: "user", content: [{ type: "text", text: `[Image: source: /tmp/claude-0/${cwd.replace(/[^A-Za-z0-9]/g, "-")}/${sessionId}/images/${index + 1}.${ext}]` }] },
      { isMeta: true, turnCompanion: true },
    );
  });
  for (const event of events) {
    if (event.type === "system" && event.subtype === "init") continue; // this child already sent its own
    if (event.type === "assistant") appendTranscript("assistant", event.message);
    if (event.type === "result") await sleep(50);
    emit(event);
    if (event.type === "stream_event") await sleep(20);
  }
}

/** claude's own `/compact` (the `compact/` recording's shape): transcript first, then the stream. */
async function compact() {
  const preTokens = 1000 * (turn + 1) + 234;
  const boundaryUuid = randomUUID();
  appendTranscript("system", undefined, {
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    level: "info",
    uuid: boundaryUuid,
    parentUuid: null,
    logicalParentUuid: parentUuid,
    compactMetadata: { trigger: "manual", preTokens, postTokens: 321 },
  });
  appendTranscript("user", { role: "user", content: "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nE2E summary." }, { isVisibleInTranscriptOnly: true, isCompactSummary: true });
  appendTranscript("user", { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" });
  const meta = { session_id: sessionId, uuid: randomUUID() };
  emit({ type: "system", subtype: "status", status: "compacting", ...meta });
  await sleep(300);
  emit({ type: "system", subtype: "status", status: null, compact_result: "success", ...meta });
  emit({
    type: "system",
    subtype: "compact_boundary",
    session_id: sessionId,
    uuid: boundaryUuid,
    compact_metadata: { trigger: "manual", pre_tokens: preTokens, post_tokens: 321 },
  });
  emit({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" }, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), isReplay: true });
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 300,
    num_turns: 0,
    session_id: sessionId,
    total_cost_usd: 0,
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    uuid: randomUUID(),
  });
}

/** A control request answered as claude 2.1.312 answered it (`model-switch/`, `effort/`). */
function control(event) {
  const requestId = event.request_id;
  const request = event.request ?? {};
  if (request.subtype === "set_model") {
    if (!CLAUDE_MODELS.includes(request.model)) {
      emit({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "API error: 502 Upstream request failed · model not changed", error_code: "check_failed", model: model ?? "claude-default" } });
      return;
    }
    model = request.model;
    appendTranscript("user", { role: "user", content: "<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes straight to the user. It's recorded here as context for later messages.</local-command-caveat>" }, { isMeta: true });
    appendTranscript("user", { role: "user", content: `<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>${model}</command-args>` });
    appendTranscript("user", { role: "user", content: `<local-command-stdout>Set model to \`${model}\`</local-command-stdout>` });
    emit({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { model } } });
    return;
  }
  if (request.subtype === "apply_flag_settings") {
    if (typeof request.settings?.effortLevel === "string") effort = request.settings.effortLevel;
    record({ kind: "effort", pid: process.pid, sessionId, effort: effort ?? null });
    emit({ type: "control_response", response: { subtype: "success", request_id: requestId } });
    return;
  }
  if (request.subtype === "interrupt") {
    emit({ type: "control_response", response: { subtype: "success", request_id: requestId, response: {} } });
    return;
  }
  emit({ type: "control_response", response: { subtype: "error", request_id: requestId, error: `Unsupported control request subtype: ${String(request.subtype)}` } });
}

// Fixture modes: the recording's segments, consumed one per stdin line of the same kind.
const FIXTURE_ENV = { switch: "PI_E2E_CLAUDE_SWITCH_FIXTURE", effort: "PI_E2E_CLAUDE_EFFORT_FIXTURE", compact: "PI_E2E_CLAUDE_COMPACT_FIXTURE" };
const FIXTURE_IDS = {
  switch: ["27200000-0000-4000-8000-000000000001", "/tmp/claude-switch-rec"],
  effort: ["27200000-0000-4000-8000-000000000002", "/tmp/claude-effort-rec"],
  compact: ["27200000-0000-4000-8000-000000000003", "/tmp/claude-compact-rec"],
};
const fixtureMode = Object.hasOwn(FIXTURE_ENV, process.env.PI_E2E_CLAUDE_STUB_MODE ?? "") ? process.env.PI_E2E_CLAUDE_STUB_MODE : null;
function fixtureSegments() {
  const dir = fixtureMode ? process.env[FIXTURE_ENV[fixtureMode]] : undefined;
  if (!dir) return null;
  try {
    const [recordedId, recordedCwd] = FIXTURE_IDS[fixtureMode];
    const events = readFileSync(join(dir, "stream.jsonl"), "utf8")
      .split(recordedId).join(sessionId)
      .split(recordedCwd).join(cwd)
      .split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const segments = { turn: [], control: [] };
    let current = [];
    for (const event of events) {
      if (event.type === "control_response") {
        segments.control.push([event]);
        continue;
      }
      current.push(event);
      if (event.type === "result") {
        segments.turn.push(current);
        current = [];
      }
    }
    return segments;
  } catch {
    return null;
  }
}
const segments = fixtureSegments();

async function replayTurn(segment) {
  turn += 1;
  for (const event of segment) {
    if (event.type === "system" && event.subtype === "init") continue; // this child already sent its own
    if (event.type === "assistant") appendTranscript("assistant", event.message);
    if (event.type === "system" && event.subtype === "compact_boundary") {
      appendTranscript("system", undefined, { subtype: "compact_boundary", content: "Conversation compacted", isMeta: false, level: "info", compactMetadata: { trigger: "manual", preTokens: event.compact_metadata?.pre_tokens, postTokens: event.compact_metadata?.post_tokens } });
    }
    if (event.type === "result") await sleep(50);
    emit(event);
    if (event.type === "stream_event") await sleep(10);
  }
}

const imageMode = process.env.PI_E2E_CLAUDE_STUB_MODE === "image";
const hasImage = (event) => Array.isArray(event?.message?.content) && event.message.content.some((block) => block?.type === "image");

function userTextOf(event) {
  const content = event?.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n");
}

emit({
  type: "system",
  subtype: "init",
  cwd,
  session_id: sessionId,
  tools: ["Read", "Glob", "Grep"],
  model: model ?? "claude-default",
  permissionMode: "dontAsk",
  slash_commands: [],
  uuid: randomUUID(),
});

let chain = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line) continue;
    record({ kind: "stdin", pid: process.pid, line });
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "control_request") {
      const recorded = segments?.control.shift();
      if (recorded) emit({ ...recorded[0], response: { ...recorded[0].response, request_id: event.request_id } });
      else control(event);
      continue;
    }
    if (event?.type !== "user") continue;
    if (segments && segments.turn.length > 0) {
      const segment = segments.turn.shift();
      const text = userTextOf(event).trim();
      if (text !== "/compact") appendTranscript("user", { role: "user", content: text }, { promptSource: "sdk" });
      chain = chain.then(() => replayTurn(segment)).catch(() => {});
      continue;
    }
    if (userTextOf(event).trim() === "/compact") {
      chain = chain.then(() => compact()).catch(() => {});
      continue;
    }
    if (imageMode && hasImage(event)) {
      const content = event.message.content;
      const imageText = userTextOf(event).trim();
      chain = chain.then(() => respondWithImage(content, imageText)).catch(() => {});
      continue;
    }
    const text = userTextOf(event).trim();
    if (!text) continue;
    chain = chain.then(() => respond(text)).catch(() => {});
  }
});
process.stdin.on("end", () => {
  chain = chain.then(() => { recordExit(); process.exit(0); });
});