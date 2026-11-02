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
 * `$CLAUDE_CONFIG_DIR/projects/<encoded cwd>/<session id>.jsonl` so the
 * session's history can be rendered from claude's own transcript.
 *
 * It records — for the test only — each launch's argv, its child environment
 * variable NAMES (never values) and the resolved config dir, plus an `exit`
 * record when it is terminated. Nothing else leaves the process.
 *
 * Inputs (environment):
 *   PI_E2E_CLAUDE_STUB_LOG  the jsonl record file (argv / env names / exits)
 *   CLAUDE_CONFIG_DIR       where the transcript is written
 */
import { appendFileSync, mkdirSync } from "node:fs";
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
const configDir = process.env.CLAUDE_CONFIG_DIR;
const resumeId = valueOf("--resume");
const sessionId = resumeId ?? valueOf("--session-id") ?? randomUUID();
const model = valueOf("--model");

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
  configDir: configDir ?? null,
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
  parentUuid = uuid;
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
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "user") continue;
    const text = userTextOf(event).trim();
    if (!text) continue;
    chain = chain.then(() => respond(text)).catch(() => {});
  }
});
process.stdin.on("end", () => {
  chain = chain.then(() => { recordExit(); process.exit(0); });
});