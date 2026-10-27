import { execFileAsync } from "./exec-file";
import { parsePfError } from "./polyforge-config-write";
import { isPolyforgeVersionBelowMinimum } from "./polyforge-detect";
import { probePolyforgeVersion } from "./polyforge-status";

/**
 * Server-side reads/writes for the Polyforge dock's Messages tab
 *. Every fact comes from a `pf` subprocess through
 * `execFileAsync` (no shell); the argv is validated before any spawn. The
 * HTTP faces under `app/api/polyforge/messages/**` only degrade and answer.
 *
 * The sanitizers are the only passport off this module: a conversation keeps
 * id/kind/peer/last_seq/unread/created_at (member-only, peer derived from
 * `members`), a message keeps id/seq/text/about_wi/reply_to/created_at/mine
 * (mine derived from `sender_id` and the server-side pf config user id).
 * `sender_id` and `members` never leave the server, and no response carries
 * the pf user id, api key, server address or an environment value.
 */

/** Messages' own capability floor: the release that ships the split cursor,
 *  `pf msg ack` and `list --before`. */
export const POLYFORGE_MESSAGES_MINIMUM_PF_VERSION = "2.20.7";

const READ_TIMEOUT_MS = 15000;
const WRITE_TIMEOUT_MS = 15000;
/** A real analyzer one-shot is an LLM call: the ruling sets the wait at
 *  no less than five minutes. */
const ANALYZE_TIMEOUT_MS = 300000;
/** pf's own stderr passes through under this cap; nothing else is echoed. */
const STDERR_CAP = 512;
const MESSAGE_TEXT_MAX_BYTES = 4096;
const ABOUT_WI_MAX_BYTES = 200;
const DEFAULT_PAGE_SIZE = 50;
/** The newest page request: any sequence above the real newest. */
const NEWEST_BEFORE = "9223372036854775807";

export type {
  PolyforgeConversation,
  PolyforgeMessage,
  PolyforgeMessagePage,
} from "./polyforge-messages-pure";
export {
  ackDecision,
  isPolyforgeConversationId,
  isPolyforgeMessageId,
  isPolyforgeRecipient,
  isPositiveSeq,
  mergeNewestPage,
  mergeOlderPage,
  splitAnchor,
} from "./polyforge-messages-pure";

export interface PolyforgeMessagesRead {
  pfPresent: boolean;
  pfVersion: string | null;
  capable: boolean;
  reason?: string;
  error?: string;
  conversations: PolyforgeConversation[];
}

import {
  isPolyforgeConversationId,
  isPolyforgeMessageId,
  isPolyforgeRecipient,
  isPositiveSeq,
  type PolyforgeConversation,
  type PolyforgeMessage,
  type PolyforgeMessagePage,
} from "./polyforge-messages-pure";

/** pf's typed failure: the code as pf reports it (empty when the failure is
 *  not a typed refusal), plus its bounded text. The text is pf's own stderr —
 *  never our argv, never `process.env`. */
export class PolyforgeMessagesError extends Error {
  readonly code: string;

  constructor(message: string, code = "") {
    super(message);
    this.name = "PolyforgeMessagesError";
    this.code = code;
  }

  /** pf --json writes its typed envelope {code, detail} to stderr; plain
   *  stderr ("CORE-400: ...") is the older/human shape. parsePfError already
   *  understands both, and the code is recovered separately for the status. */
  static fromSpawnError(error: unknown): PolyforgeMessagesError {
    if (error instanceof Error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim();
      if (stderr) {
        const failure = parsePfError(stderr);
        return new PolyforgeMessagesError(failure.message.slice(0, STDERR_CAP), typedCode(stderr));
      }
    }
    return new PolyforgeMessagesError("polyforge is unavailable");
  }
}

/** The typed code in pf's stderr: the --json envelope's code, or a leading
 *  CODE-NNN in plain text. Empty when the failure carries no typed code. */
function typedCode(stderr: string): string {
  const text = stderr.trim();
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart)) as Record<string, unknown>;
      const envelope = (parsed.error && typeof parsed.error === "object" ? parsed.error : parsed) as Record<string, unknown>;
      if (typeof envelope.code === "string") return envelope.code;
    } catch {
      // Fall through to the plain shape.
    }
  }
  const match = /\b([A-Z][A-Z0-9]*-\d+)\b/.exec(text);
  return match ? match[1] : "";
}

/** The HTTP status a pf typed code maps to. Writes are 4xx at most; a
 *  DAEMON-500 or an untyped/unreachable pf answers 200 with the error field
 *  (the repo's no-5xx rule), so the panel can still render pf's text. */
export function messageErrorStatus(code: string): number {
  if (code === "DAEMON-500" || code === "") return 200;
  const status: Record<string, number> = {
    "CORE-400": 400,
    "CORE-404": 404,
    "CORE-413": 413,
    "CORE-422": 422,
    "CORE-429": 429,
    "AUTH-401": 401,
    "AUTH-403": 403,
    "DAEMON-409": 409,
  };
  return status[code] ?? 400;
}

// ---- argv validation (before any spawn) ----

function hasControlBytes(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A send body after validation, in the CLI's own face. */
export interface PolyforgeSendInput {
  to: string;
  text: string;
  aboutWi?: string;
  replyTo?: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateSendInput(raw: unknown): ValidationResult<PolyforgeSendInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid send body" };
  const body = raw as { to?: unknown; text?: unknown; about_wi?: unknown; reply_to?: unknown };
  if (!isPolyforgeRecipient(body.to)) return { ok: false, error: "recipient must be a human user id" };
  if (typeof body.text !== "string" || !body.text.trim()) return { ok: false, error: "message text is required" };
  if (Buffer.byteLength(body.text, "utf8") > MESSAGE_TEXT_MAX_BYTES) {
    return { ok: false, error: `message text is over the ${MESSAGE_TEXT_MAX_BYTES}-byte bound` };
  }
  const value: PolyforgeSendInput = { to: body.to, text: body.text };
  if (body.about_wi !== undefined && body.about_wi !== "") {
    if (typeof body.about_wi !== "string" || hasControlBytes(body.about_wi)) {
      return { ok: false, error: "work-item anchor carries control bytes" };
    }
    if (Buffer.byteLength(body.about_wi, "utf8") > ABOUT_WI_MAX_BYTES) {
      return { ok: false, error: `work-item anchor is over the ${ABOUT_WI_MAX_BYTES}-byte bound` };
    }
    value.aboutWi = body.about_wi;
  }
  if (body.reply_to !== undefined && body.reply_to !== "") {
    if (!isPolyforgeMessageId(body.reply_to)) return { ok: false, error: "reply_to must be a message id" };
    value.replyTo = body.reply_to;
  }
  return { ok: true, value };
}

// ---- pure sanitizers ----

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** One conversation row, filtered to the caller's own membership. `userId`
 *  comes from pf config on the server and never reaches the browser; the peer
 *  is derived from the raw `members` list, which itself never leaves. */
export function sanitizeConversation(raw: unknown, userId = ""): PolyforgeConversation | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!isPolyforgeConversationId(id)) return null;
  const members = Array.isArray(row.members)
    ? row.members.filter((member): member is string => typeof member === "string" && member !== "")
    : [];
  if (userId && !members.includes(userId)) return null;
  const conversation: PolyforgeConversation = {
    id,
    kind: str(row.kind) || "direct",
    last_seq: num(row.last_seq),
    unread: Math.max(0, Math.trunc(num(row.unread))),
    created_at: str(row.created_at),
  };
  const peer = userId ? members.find((member) => member !== userId) : "";
  if (peer) conversation.peer = peer;
  return conversation;
}

export function sanitizeMessage(raw: unknown, userId = ""): PolyforgeMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!isPolyforgeMessageId(id)) return null;
  const seq = num(row.seq);
  if (!Number.isSafeInteger(seq) || seq <= 0) return null;
  const message: PolyforgeMessage = {
    id,
    seq,
    text: typeof row.text === "string" ? row.text : "",
    created_at: str(row.created_at),
    // Derived server-side from the real sender id and the pf config user id;
    // the sender id itself is dropped here.
    mine: userId !== "" && str(row.sender_id) === userId,
  };
  const about = str(row.about_wi);
  if (about) message.about_wi = about;
  const reply = str(row.reply_to);
  if (reply) message.reply_to = reply;
  return message;
}

export function sanitizeConversationsAnswer(raw: unknown, userId = ""): PolyforgeConversation[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { conversations?: unknown }).conversations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((row) => {
    const conversation = sanitizeConversation(row, userId);
    return conversation ? [conversation] : [];
  });
}

export function sanitizeMessagePage(raw: unknown, userId = ""): PolyforgeMessagePage {
  if (!raw || typeof raw !== "object") return { messages: [], last_seq: 0 };
  const body = raw as { messages?: unknown; last_seq?: unknown };
  const messages = Array.isArray(body.messages)
    ? body.messages.flatMap((row) => {
      const message = sanitizeMessage(row, userId);
      return message ? [message] : [];
    })
    : [];
  return { messages, last_seq: num(body.last_seq) };
}

/** A page shorter than the requested limit is the oldest page: aihub's seq is
 *  a global AUTOINCREMENT, so "first seq == 1" is not a termination signal. */
function pageWithOldestFlag(page: PolyforgeMessagePage, limit: number): PolyforgeMessagePage {
  return { ...page, has_older: page.messages.length >= limit };
}

// ---- transport ----

async function runPfJson(argv: string[], timeoutMs = READ_TIMEOUT_MS): Promise<unknown> {
  try {
    const { stdout } = await execFileAsync("pf", argv, { timeout: timeoutMs });
    return JSON.parse(stdout);
  } catch (error) {
    throw PolyforgeMessagesError.fromSpawnError(error);
  }
}

async function listConversationsRaw(): Promise<unknown> {
  return runPfJson(["--json", "msg", "list"]);
}

/** The pf caller's own user id, read server-side from `pf config`. It is used
 *  to filter conversations and derive peer/mine, then dropped: no response
 *  carries it. */
async function readPolyforgeUserId(): Promise<string> {
  let raw: unknown;
  try {
    raw = await runPfJson(["--json", "config", "list"]);
  } catch (error) {
    throw PolyforgeMessagesError.fromSpawnError(error);
  }
  const items = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
    ? (raw as { items: unknown[] }).items
    : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { key?: unknown; value?: unknown };
    if (row.key === "user_id" && typeof row.value === "string" && row.value.trim()) return row.value.trim();
  }
  throw new PolyforgeMessagesError("pf config has no user_id; run `pf config set user_id <your user id>`", "CORE-400");
}

async function listMessagesRaw(
  conversationId: string,
  before: number,
  after: number,
  limit: number,
): Promise<unknown> {
  const argv = ["--json", "msg", "list", "--conversation", conversationId];
  if (before > 0) argv.push("--before", String(before));
  if (after > 0) argv.push("--after", String(after));
  if (limit > 0) argv.push("--limit", String(limit));
  return runPfJson(argv);
}

export interface PolyforgeMessagesCapability {
  pfPresent: boolean;
  pfVersion: string | null;
  capable: boolean;
  reason?: string;
}

/** The Messages floor gate: presence + the 2.20.7 capability floor. Below it
 *  no message verb is spawned (the panel renders the upgrade state). */
export async function readPolyforgeMessagesCapability(): Promise<PolyforgeMessagesCapability> {
  const presence = await probePolyforgeVersion();
  if (!presence.present) {
    return { pfPresent: false, pfVersion: null, capable: false };
  }
  if (isPolyforgeVersionBelowMinimum(presence.version, POLYFORGE_MESSAGES_MINIMUM_PF_VERSION)) {
    return {
      pfPresent: true,
      pfVersion: presence.version,
      capable: false,
      reason: `the Messages tab needs pf ${POLYFORGE_MESSAGES_MINIMUM_PF_VERSION} or newer (found ${presence.version ?? "an unparseable version"})`,
    };
  }
  return { pfPresent: true, pfVersion: presence.version, capable: true };
}

/** Read the conversations the pf caller may see, filtered server-side to its
 *  own membership and annotated with the peer from `members` (one spawn; no
 *  per-conversation preview fan-out). */
export async function readPolyforgeMessages(): Promise<PolyforgeMessagesRead> {
  const capability = await readPolyforgeMessagesCapability();
  if (!capability.capable) {
    return { ...capability, conversations: [] };
  }
  const presence = { version: capability.pfVersion };
  let raw: unknown;
  let userId: string;
  try {
    userId = await readPolyforgeUserId();
    raw = await listConversationsRaw();
  } catch (error) {
    // A list-read failure (missing user_id, AUTH-401, an unreachable aihub or
    // daemon) is NOT the capability floor: `capable:false` is reserved for pf
    // absent or below the floor, so the panel never shows a false upgrade
    // notice and an open conversation survives a poll blip.
    return {
      pfPresent: capability.pfPresent,
      pfVersion: presence.version,
      capable: true,
      error: error instanceof Error ? error.message : "pf msg list is unavailable",
      conversations: [],
    };
  }
  return {
    pfPresent: true,
    pfVersion: presence.version,
    capable: true,
    conversations: sanitizeConversationsAnswer(raw, userId),
  };
}

/** One conversation's history. A `before` of 0 requests the newest page;
 *  scroll-up passes the oldest loaded sequence. */
export async function readPolyforgeMessagesPage(
  conversationId: string,
  before: number,
  limit = DEFAULT_PAGE_SIZE,
): Promise<PolyforgeMessagePage> {
  if (!isPolyforgeConversationId(conversationId)) {
    throw new PolyforgeMessagesError("conversation must be a conversation id", "CORE-400");
  }
  const userId = await readPolyforgeUserId();
  const effectiveBefore = before > 0 ? before : Number.MAX_SAFE_INTEGER;
  const page = sanitizeMessagePage(
    await listMessagesRaw(conversationId, effectiveBefore, 0, limit), userId,
  );
  return pageWithOldestFlag(page, limit);
}

/** Newest page, one request: the history route's initial open. */
export async function readPolyforgeNewestPage(conversationId: string): Promise<PolyforgeMessagePage> {
  if (!isPolyforgeConversationId(conversationId)) {
    throw new PolyforgeMessagesError("conversation must be a conversation id", "CORE-400");
  }
  const userId = await readPolyforgeUserId();
  const page = sanitizeMessagePage(await runPfJson([
    "--json", "msg", "list", "--conversation", conversationId,
    "--before", NEWEST_BEFORE, "--limit", String(DEFAULT_PAGE_SIZE),
  ]), userId);
  return pageWithOldestFlag(page, DEFAULT_PAGE_SIZE);
}

/** Messages newer than `after`, for the open conversation's 3 s refresh
 *  (forward paging — never a second backward request). */
export async function readPolyforgeNewerMessages(
  conversationId: string,
  after: number,
): Promise<PolyforgeMessage[]> {
  if (!isPolyforgeConversationId(conversationId) || !isPositiveSeq(after)) return [];
  const userId = await readPolyforgeUserId();
  const page = sanitizeMessagePage(await listMessagesRaw(conversationId, 0, after, 50), userId);
  return page.messages;
}

export async function sendPolyforgeMessage(input: PolyforgeSendInput): Promise<PolyforgeMessage | null> {
  // Read the identity BEFORE the spawn: a config-read failure must not turn a
  // message that was already sent into a reported failure (a retry would
  // duplicate it).
  const userId = await readPolyforgeUserId();
  const argv = ["--json", "msg", "send", "--to", input.to, "--text", input.text];
  if (input.aboutWi) argv.push("--about-wi", input.aboutWi);
  if (input.replyTo) argv.push("--reply-to", input.replyTo);
  const raw = await runPfJson(argv, WRITE_TIMEOUT_MS);
  return sanitizeMessage(raw, userId);
}

export async function acknowledgePolyforgeMessage(conversationId: string, seq: number): Promise<void> {
  if (!isPolyforgeConversationId(conversationId) || !isPositiveSeq(seq)) {
    throw new PolyforgeMessagesError("conversation and a positive seq are required", "CORE-400");
  }
  try {
    await execFileAsync("pf", ["--json", "msg", "ack", conversationId, "--seq", String(seq)], {
      timeout: WRITE_TIMEOUT_MS,
    });
  } catch (error) {
    throw PolyforgeMessagesError.fromSpawnError(error);
  }
}

export async function analyzePolyforgeMessage(messageId: string): Promise<{ conclusion: string; model?: string }> {
  if (!isPolyforgeMessageId(messageId)) {
    throw new PolyforgeMessagesError("message_id must be a message id", "CORE-400");
  }
  const raw = await runPfJson(["--json", "msg", "analyze", messageId], ANALYZE_TIMEOUT_MS);
  if (!raw || typeof raw !== "object") {
    throw new PolyforgeMessagesError("the analyzer answered no conclusion", "DAEMON-500");
  }
  const body = raw as { conclusion?: unknown; model?: unknown };
  const conclusion = typeof body.conclusion === "string" ? body.conclusion.trim() : "";
  if (!conclusion) throw new PolyforgeMessagesError("the analyzer answered no conclusion", "DAEMON-500");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
  return model ? { conclusion, model } : { conclusion };
}
