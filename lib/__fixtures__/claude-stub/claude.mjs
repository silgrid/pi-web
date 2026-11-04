#!/usr/bin/env node
// A `claude` stand-in for lib/claude-session.test.mjs. Put on
// PATH as `claude`, it records each launch (argv, environment variable NAMES,
// never values) and every stdin line to $PI_TEST_CLAUDE_STUB_LOG, and answers
// like claude 2.1.312. Never touches a network.
//
//   PI_TEST_CLAUDE_STUB_MODE  replay (default): each user message replays the
//                             recorded stream.jsonl and writes its transcript;
//                             hang: a reply that streams one delta and waits for
//                             the interrupt; deaf: like hang, interrupt ignored;
//                             exit: exits (code 3) on the first user message;
//                             subagent: replays the background-Agent recording
//                             (subagent/stream.jsonl,), holding
//                             PI_TEST_CLAUDE_STUB_HOLD_MS after the subagent's text;
//                             subagent-early: the same with the parent turn's
//                             `result` moved before the subagent's activity (a
//                             synthetic order: the parent answered while the
//                             subagent still runs, which the real stdin recording
//                             cannot show).
//                             switch | effort | compact: each
//                             stdin line replays the next segment of the
//                             model-switch/, effort/ or compact/ recording (a user
//                             line: up to its `result`; a control request: its
//                             `control_response` under this request's id), the
//                             session id and cwd made this child's; past the
//                             recording a line gets the replay answers below.
//   In replay / subagent / exit modes a `set_model` control request
//   is answered as 2.1.312 answered it (a full name: success with the model; any
//   other: the recorded `check_failed` refusal), `apply_flag_settings` with success,
//   and a user line that is exactly `/compact` replays the compact recording's
//   compaction turn (its transcript boundary appended before the stream). hang and
//   deaf leave every control request but interrupt unanswered.
//   PI_TEST_CLAUDE_STUB_GRANDCHILD=1  starts a long sleep child and logs its pid.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const recordings = join(here, "..", "claude-2.1.312");
const argv = process.argv.slice(2);
const valueOf = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
const sessionId = valueOf("--resume") ?? valueOf("--session-id") ?? "no-id";
const mode = process.env.PI_TEST_CLAUDE_STUB_MODE || "replay";
const log = (entry) => {
  if (process.env.PI_TEST_CLAUDE_STUB_LOG) appendFileSync(process.env.PI_TEST_CLAUDE_STUB_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
};
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
// As claude: the inherited CLAUDE_CONFIG_DIR, else ~/.claude of the child's HOME.
const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "", ".claude");
const withId = (line) => line.replaceAll("5b203fcd-56c9-4d0c-b700-749b82c41afb", sessionId);
const transcriptFile = () => join(configDir, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
const appendTranscript = (text) => {
  mkdirSync(dirname(transcriptFile()), { recursive: true });
  appendFileSync(transcriptFile(), text);
};
const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
let model = valueOf("--model") ?? "claude-default";

// The recordings: session id and cwd made this child's, then cut into segments.
const RECORDED = {
  switch: ["model-switch", "27200000-0000-4000-8000-000000000001", "/tmp/claude-switch-rec"],
  effort: ["effort", "27200000-0000-4000-8000-000000000002", "/tmp/claude-effort-rec"],
  compact: ["compact", "27200000-0000-4000-8000-000000000003", "/tmp/claude-compact-rec"],
};
function recorded(name, file) {
  const [dir, id, cwd] = RECORDED[name];
  const encoded = (path) => path.replace(/[^A-Za-z0-9]/g, "-");
  return readFileSync(join(recordings, dir, file), "utf8")
    .replaceAll(id, sessionId).replaceAll(encoded(cwd), encoded(process.cwd())).replaceAll(cwd, process.cwd())
    .split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
function segmentsOf(name) {
  const turns = [];
  const controls = [];
  let current = [];
  for (const event of recorded(name, "stream.jsonl")) {
    if (event.type === "control_response") {
      controls.push(event);
      continue;
    }
    current.push(event);
    if (event.type === "result") {
      turns.push(current);
      current = [];
    }
  }
  return { turns, controls };
}
const segments = RECORDED[mode] ? segmentsOf(mode) : null;
/** The recorded transcript entries a replayed turn adds: its assistant entries, or the compaction's. */
function transcriptFor(name, segment) {
  const ids = new Set(segment.flatMap((event) => (event.type === "assistant" ? [event.message?.id] : [])));
  const compacting = segment.some((event) => event.type === "system" && event.subtype === "compact_boundary");
  const entries = recorded(name, "transcript.jsonl");
  const from = entries.findIndex((entry) => entry.subtype === "compact_boundary");
  return entries.filter((entry, index) => (compacting ? from >= 0 && index >= from : entry.type === "assistant" && ids.has(entry.message?.id)));
}
function replaySegment(name, segment) {
  const entries = transcriptFor(name, segment);
  if (entries.length > 0) appendTranscript(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  for (const event of segment) emit(event);
}
function answerControl(event) {
  const request = event.request ?? {};
  const requestId = event.request_id;
  if (request.subtype === "set_model") {
    if (!CLAUDE_MODELS.includes(request.model)) {
      emit({ type: "control_response", response: { subtype: "error", request_id: requestId, error: "API error: 502 Upstream request failed · model not changed", error_code: "check_failed", model } });
      return;
    }
    model = request.model;
    emit({ type: "control_response", response: { subtype: "success", request_id: requestId, response: { model } } });
    return;
  }
  emit({ type: "control_response", response: { subtype: "success", request_id: requestId } });
}

log({ kind: "launch", argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null });
if (process.env.PI_TEST_CLAUDE_STUB_GRANDCHILD === "1") {
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
  log({ kind: "grandchild", grandchildPid: sleeper.pid });
}
process.on("SIGINT", () => { log({ kind: "signal", signal: "SIGINT" }); process.exit(130); });
process.on("SIGTERM", () => { log({ kind: "signal", signal: "SIGTERM" }); process.exit(143); });

let waiting = null;
function replay() {
  // claude persists the turn's entries as it streams them, so by the time its
  // `result` is read the transcript holds the turn: write it first. Written
  // after the stream, a reader that acts on `result` (stats, history) races the
  // append and loses on a loaded host (verification s22, toolCalls 0 !== 1;
  // fixed the same transcript-before-reply order).
  const transcript = join(configDir, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  appendFileSync(transcript, withId(readFileSync(join(recordings, "transcript.jsonl"), "utf8")));
  for (const line of readFileSync(join(recordings, "stream.jsonl"), "utf8").split("\n")) if (line) process.stdout.write(`${withId(line)}\n`);
}
async function replaySubagent(early) {
  const lines = readFileSync(join(recordings, "subagent", "stream.jsonl"), "utf8").split("\n").filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  if (early) {
    const first = events.findIndex((event) => typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id);
    const parentResult = events.findIndex((event) => event.type === "result");
    const [result] = events.splice(parentResult, 1);
    events.splice(first, 0, result);
  }
  const holdMs = Number(process.env.PI_TEST_CLAUDE_STUB_HOLD_MS || 0);
  for (const event of events) {
    emit(event);
    const subagentText = event.type === "assistant" && event.parent_tool_use_id && JSON.stringify(event.message.content).includes("\"text\"");
    if (subagentText && holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  }
}
function hang() {
  emit({ type: "stream_event", event: { type: "message_start", message: { model: "stub", usage: {} } }, session_id: sessionId });
  emit({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, session_id: sessionId });
  emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial answ" } }, session_id: sessionId });
  waiting = setInterval(() => {}, 1_000);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    log({ kind: "stdin", line });
    const event = JSON.parse(line);
    const text = typeof event.message?.content === "string" ? event.message.content.trim() : "";
    if (segments && event.type === "control_request" && event.request?.subtype !== "interrupt") {
      const answer = segments.controls.shift();
      if (answer) emit({ ...answer, response: { ...answer.response, request_id: event.request_id } });
      else answerControl(event);
      continue;
    }
    if (segments && event.type === "user" && segments.turns.length > 0) {
      replaySegment(mode, segments.turns.shift());
      continue;
    }
    if (event.type === "control_request" && event.request?.subtype !== "interrupt" && mode !== "hang" && mode !== "deaf") {
      answerControl(event);
      continue;
    }
    if (event.type === "user" && text === "/compact" && mode !== "hang" && mode !== "deaf" && mode !== "exit") {
      replaySegment("compact", segmentsOf("compact").turns.at(-1));
      continue;
    }
    if (event.type === "user") {
      if (mode === "exit") process.exit(3);
      if (mode === "replay" || segments) replay();
      else if (mode === "subagent" || mode === "subagent-early") void replaySubagent(mode === "subagent-early");
      else hang();
    } else if (event.type === "control_request" && event.request?.subtype === "interrupt" && mode === "hang") {
      clearInterval(waiting);
      emit({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: {} } });
      emit({ type: "assistant", message: { model: "stub", id: "m1", role: "assistant", content: [{ type: "text", text: "partial answ" }] }, session_id: sessionId });
      emit({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, session_id: sessionId });
      emit({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, total_cost_usd: 0, usage: {} });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
