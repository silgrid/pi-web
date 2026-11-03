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
//                             exit: exits (code 3) on the first user message.
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
const withId = (line) => line.replaceAll("5b203fcd-56c9-4d0c-b700-749b82c41afb", sessionId);

log({ kind: "launch", argv, cwd: process.cwd(), envKeys: Object.keys(process.env).sort(), configDir: process.env.CLAUDE_CONFIG_DIR ?? null });
if (process.env.PI_TEST_CLAUDE_STUB_GRANDCHILD === "1") {
  const sleeper = spawn("sleep", ["300"], { stdio: "ignore" });
  log({ kind: "grandchild", grandchildPid: sleeper.pid });
}
process.on("SIGINT", () => { log({ kind: "signal", signal: "SIGINT" }); process.exit(130); });
process.on("SIGTERM", () => { log({ kind: "signal", signal: "SIGTERM" }); process.exit(143); });

let waiting = null;
function replay() {
  for (const line of readFileSync(join(recordings, "stream.jsonl"), "utf8").split("\n")) if (line) process.stdout.write(`${withId(line)}\n`);
  const transcript = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  appendFileSync(transcript, withId(readFileSync(join(recordings, "transcript.jsonl"), "utf8")));
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
    if (event.type === "user") {
      if (mode === "exit") process.exit(3);
      if (mode === "replay") replay();
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
