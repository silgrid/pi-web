import { workspaceProjects } from "../components/polyforge-config-helpers";
import { execFileAsync } from "./exec-file";
import { parsePfError } from "./polyforge-config-write";
import { isPolyforgeVersionBelowMinimum } from "./polyforge-detect";
import { polyforgePfBin } from "./polyforge-pf-bin";
import { probePolyforgeVersion } from "./polyforge-status";

/**
 * Server-side reads/writes for the Polyforge dock's Messages tab
 *. Every fact comes from a `pf` subprocess through
 * `execFileAsync` (no shell); the argv is validated before any spawn. The
 * HTTP faces under `app/api/polyforge/messages/**` only degrade and answer.
 *
 * The sanitizers are the only passport off this module: a conversation keeps
 * id/kind/peer/peer_name/last_seq/unread/created_at (member-only, peer
 * derived from `members`, peer_name from exactly the peer's own
 * `member_names` key), a message keeps id/seq/text/about_wi/reply_to/created_at/mine
 * (mine derived from `sender_id` and the server-side pf config user id) plus
 * its own optional conversation_id — the conversation the message lives in,
 * carried by a send's answer so its client can open that conversation
 * without re-reading the list. A contact keeps exactly id/display_name
 *: the id is the send address, the name may be "". A project
 * group keeps its project name and contacts from that same
 * contact set, joined by id to the members of `pf --json projects get`:
 * roles, machines and the caller never leave.
 * `sender_id`, `members` and every other `member_names` key never leave the
 * server, and no response carries the pf user id, api key, server address or
 * an environment value.
 */

/** Messages' own capability floor: the release that ships `pf msg contacts`
 * on top of the split cursor, `pf msg ack`, `list --before`
 *  and the conversation list's `member_names`. */
export const POLYFORGE_MESSAGES_MINIMUM_PF_VERSION = "2.20.12";

const READ_TIMEOUT_MS = 15000;
/** The contact read's own bound: the list answer awaits it, so
 *  a slow `pf msg contacts` must not hold the whole Messages list for the
 *  15 s read timeout. At the bound the contact set is empty for that poll.
 *  Each per-project members read shares the same bound. */
const CONTACT_READ_TIMEOUT_MS = 2000;
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
  PolyforgeContact,
  PolyforgeConversation,
  PolyforgeMessage,
  PolyforgeMessagePage,
  PolyforgeProjectGroup,
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
  /** The configured contacts; [] when their own read fails (that failure
   *  never touches capable/reason/error or the conversations). */
  contacts: PolyforgeContact[];
  /** The `cli.toml`-mapped projects' groups; [] below the
   *  floor, with no mapping, or when the contact read fails; absent when the
   *  caller asked for no groups (no `pf projects get` was spawned). */
  groups?: PolyforgeProjectGroup[];
}

import {
  buildProjectGroups,
  isPolyforgeConversationId,
  normalizeProjectNames,
  isPolyforgeMessageId,
  isPolyforgeRecipient,
  isPositiveSeq,
  type PolyforgeContact,
  type PolyforgeConversation,
  type PolyforgeMessage,
  type PolyforgeMessagePage,
  type PolyforgeProjectGroup,
  type PolyforgeProjectMembersRead,
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

/** A membership change after validation, in the CLI's own
 *  face: add always lands as `writer`, so the body carries no role. */
export interface PolyforgeMembershipInput {
  action: "add" | "remove";
  project: string;
  userId: string;
}

/** Validate a membership body against the current mapping before any spawn:
 *  the action is add/remove, the project is exactly one mapped name (trimmed)
 *  and the user is a user id. */
export function validateMembershipInput(
  raw: unknown,
  mappedProjects: string[],
): ValidationResult<PolyforgeMembershipInput> {
  if (!raw || typeof raw !== "object") return { ok: false, error: "invalid membership body" };
  const body = raw as { action?: unknown; project?: unknown; user_id?: unknown };
  if (body.action !== "add" && body.action !== "remove") return { ok: false, error: "action must be add or remove" };
  const project = typeof body.project === "string" ? body.project.trim() : "";
  if (!project || !mappedProjects.includes(project)) {
    return { ok: false, error: "project must be one of this machine's mapped projects" };
  }
  if (!isPolyforgeRecipient(body.user_id)) return { ok: false, error: "user_id must be a user id" };
  return { ok: true, value: { action: body.action, project, userId: body.user_id } };
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
  if (peer) {
    conversation.peer = peer;
    // Scope: exactly the peer's own key of member_names is read
    //. The caller's own name and any other member's name
    // never leave the server; a missing or non-string value — the
    // old-aihub transient with no member_names at all included — reads as
    // "" and renders as the unknown-user placeholder, never an id.
    const names = row.member_names;
    conversation.peer_name =
      names && typeof names === "object" && !Array.isArray(names) &&
        typeof (names as Record<string, unknown>)[peer] === "string"
        ? ((names as Record<string, string>)[peer] as string).trim()
        : "";
  }
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
  // The conversation the message lives in (task-42): a send's answer carries
  // it, so the client can open the resulting conversation without a second
  // list read racing the polls. Shape-validated, same as the page reads.
  const conversation = str(row.conversation_id);
  if (isPolyforgeConversationId(conversation)) message.conversation_id = conversation;
  return message;
}

/** One contact row: a valid user id and its trimmed display name ("" when
 *  absent or not a string); every other field is dropped. */
export function sanitizeContact(raw: unknown): PolyforgeContact | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!isPolyforgeRecipient(id)) return null;
  return { id, display_name: str(row.display_name) };
}

export function sanitizeContactsAnswer(raw: unknown): PolyforgeContact[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { contacts?: unknown }).contacts;
  if (!Array.isArray(list)) return [];
  return list.flatMap((row) => {
    const contact = sanitizeContact(row);
    return contact ? [contact] : [];
  });
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
    const { stdout } = await execFileAsync(polyforgePfBin(), argv, { timeout: timeoutMs });
    return JSON.parse(stdout);
  } catch (error) {
    throw PolyforgeMessagesError.fromSpawnError(error);
  }
}

async function listConversationsRaw(): Promise<unknown> {
  return runPfJson(["--json", "msg", "list"]);
}

/** The configured contacts (`pf msg contacts`: the union of the caller's
 *  human co-members over every mapped project, assembled by pf). Its own
 *  isolated spawn bounded by CONTACT_READ_TIMEOUT_MS: any failure, including
 *  the bound, is an empty set, never the messages error. */
async function readPolyforgeContacts(): Promise<PolyforgeContact[] | null> {
  try {
    return sanitizeContactsAnswer(await runPfJson(["--json", "msg", "contacts"], CONTACT_READ_TIMEOUT_MS));
  } catch {
    return null;
  }
}

/** The items of one `pf --json config list` read: the caller's identity and
 *  the `cli.toml` workspace mapping both come from it. */
async function readPolyforgeConfigItems(): Promise<unknown[]> {
  let raw: unknown;
  try {
    raw = await runPfJson(["--json", "config", "list"]);
  } catch (error) {
    throw PolyforgeMessagesError.fromSpawnError(error);
  }
  return raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
    ? (raw as { items: unknown[] }).items
    : [];
}

const WORKSPACE_SECTION_KEY = /^\[workspace\."[^"]*"\]$/;
/** A project name safe to pass as one argv value (no leading dash, no
 *  whitespace or control byte). */
const PROJECT_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The `cli.toml`-mapped projects: every
 *  `[workspace."<path>"]` item's comma-separated list, trimmed, deduplicated
 *  and name-ordered — the same mapping `pf msg contacts` is built from. A
 *  name that is not a plain project token is never spawned with. */
export function mappedProjectsFromConfig(items: unknown[]): string[] {
  const names: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { key?: unknown; value?: unknown };
    if (typeof row.key !== "string" || !WORKSPACE_SECTION_KEY.test(row.key)) continue;
    names.push(...workspaceProjects(row.value));
  }
  return normalizeProjectNames(names).filter((name) => PROJECT_TOKEN.test(name));
}

/** The caller's user id out of the config items; a missing one is pf's
 *  typed refusal shape. */
function userIdFromConfig(items: unknown[]): string {
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { key?: unknown; value?: unknown };
    if (row.key === "user_id" && typeof row.value === "string" && row.value.trim()) return row.value.trim();
  }
  throw new PolyforgeMessagesError("pf config has no user_id; run `pf config set user_id <your user id>`", "CORE-400");
}

/** The pf caller's own user id, read server-side from `pf config`. It is used
 *  to filter conversations and derive peer/mine, then dropped: no response
 *  carries it. */
async function readPolyforgeUserId(): Promise<string> {
  return userIdFromConfig(await readPolyforgeConfigItems());
}

/** One project's members (`pf --json projects get <project>`), bounded by
 *  CONTACT_READ_TIMEOUT_MS and never rejecting: only the member user ids
 *  survive (roles and every other field are dropped here); a failure, the
 *  bound included, is that project's own bounded error text. */
async function readProjectMembers(project: string): Promise<PolyforgeProjectMembersRead> {
  try {
    const raw = await runPfJson(["--json", "projects", "get", project], CONTACT_READ_TIMEOUT_MS);
    const members = raw && typeof raw === "object" && Array.isArray((raw as { members?: unknown }).members)
      ? (raw as { members: unknown[] }).members
      : [];
    const ids = members.flatMap((member) => {
      const id = member && typeof member === "object" ? str((member as { user_id?: unknown }).user_id) : "";
      return isPolyforgeRecipient(id) ? [id] : [];
    });
    return { ids };
  } catch (error) {
    const failure = error instanceof PolyforgeMessagesError ? error : PolyforgeMessagesError.fromSpawnError(error);
    return { error: failure.message.slice(0, STDERR_CAP) };
  }
}

/** The project groups for one list read: the per-project members reads start
 *  as soon as the mapping is known, concurrently with the contact read, and
 *  are joined with the contact set. An unreadable mapping or a failed contact
 *  read answers no groups (no group is offered over unknown contacts). Never
 *  rejects. */
async function readProjectGroups(
  configRead: Promise<unknown[]>,
  contactsRead: Promise<PolyforgeContact[] | null>,
): Promise<PolyforgeProjectGroup[]> {
  let projects: string[];
  try {
    projects = mappedProjectsFromConfig(await configRead);
  } catch {
    return [];
  }
  if (projects.length === 0) return [];
  const reads = await Promise.all(projects.map(readProjectMembers));
  const contacts = await contactsRead;
  if (contacts === null) return [];
  const memberReads: Record<string, PolyforgeProjectMembersRead> = {};
  projects.forEach((project, index) => { memberReads[project] = reads[index]; });
  return buildProjectGroups(projects, memberReads, contacts);
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

/** The Messages floor gate: presence + the 2.20.12 capability floor. Below it
 *  no message or contact verb is spawned (the panel renders the upgrade
 *  state); there is no degraded list below it. */
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
 *  per-conversation preview fan-out), plus the configured contacts from one
 *  independent `pf msg contacts` spawn and the project groups (:
 *  one bounded `pf projects get` per mapped project, joined with those
 *  contacts). `withGroups: false` (the dock off the Messages tab) skips the
 *  project reads and omits `groups`, so no other tab spawns `projects get`. */
export async function readPolyforgeMessages(
  { withGroups = true }: { withGroups?: boolean } = {},
): Promise<PolyforgeMessagesRead> {
  const capability = await readPolyforgeMessagesCapability();
  if (!capability.capable) {
    return { ...capability, conversations: [], contacts: [], groups: [] };
  }
  const presence = { version: capability.pfVersion };
  // Started alongside the list reads and never rejects: a contact-read
  // failure is an empty set that leaves the conversation answer alone.
  const contactsAnswer = readPolyforgeContacts();
  const contactsRead = contactsAnswer.then((contacts) => contacts ?? []);
  // One config read serves the identity and the mapping; the per-project
  // reads start the moment it lands and never reject.
  const configRead = readPolyforgeConfigItems();
  const groupsRead = withGroups ? readProjectGroups(configRead, contactsAnswer) : Promise.resolve(undefined);
  let raw: unknown;
  let userId: string;
  try {
    // The identity read and the list read are independent spawns: they run
    // concurrently, so a fresh page's first list lands after one spawn's
    // latency, not two (task-42: the list and the picker render on the first
    // poll after the dock opens). Any failure keeps the same degraded answer.
    [userId, raw] = await Promise.all([
      configRead.then(userIdFromConfig),
      listConversationsRaw(),
    ]);
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
      contacts: await contactsRead,
      groups: await groupsRead,
    };
  }
  return {
    pfPresent: true,
    pfVersion: presence.version,
    capable: true,
    conversations: sanitizeConversationsAnswer(raw, userId),
    contacts: await contactsRead,
    groups: await groupsRead,
  };
}

/** One user the membership picker may offer: a human user's
 *  id and trimmed display name — nothing else of `pf users list` leaves. */
export interface PolyforgeUser {
  id: string;
  display_name: string;
}

export interface PolyforgeUsersRead {
  pfPresent: boolean;
  pfVersion: string | null;
  capable: boolean;
  reason?: string;
  /** True only when `pf users list` (admin-only in aihub) answered: the one
   *  switch for add/remove in the panel. */
  admin: boolean;
  users: PolyforgeUser[];
  error?: string;
}

/** `pf users list`'s answer to the picker's whitelist: `user_type ===
 *  "human"` only, a valid id, the trimmed display name; email, role,
 *  user_type, api_tokens and every other field are dropped. Pure. */
export function sanitizeUsersAnswer(raw: unknown): PolyforgeUser[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  return list.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const user = row as Record<string, unknown>;
    if (user.user_type !== "human") return [];
    const id = str(user.id);
    if (!isPolyforgeRecipient(id)) return [];
    return [{ id, display_name: str(user.display_name) }];
  });
}

/** The admin probe and the picker's data: behind the
 *  Messages floor gate first (below it no `users list` spawn), then one
 *  bounded `pf --json users list`. Its success is the admin answer; a
 *  refusal or an unreachable pf is `admin: false` with pf's bounded text.
 *  The caller is dropped (read concurrently from pf config, never sent): it
 *  is never listed in a group, and re-adding it through the picker would be
 *  an upsert that rewrites its own role. */
export async function readPolyforgeUsers(): Promise<PolyforgeUsersRead> {
  const capability = await readPolyforgeMessagesCapability();
  if (!capability.capable) {
    return { ...capability, admin: false, users: [] };
  }
  try {
    const [userId, raw] = await Promise.all([
      readPolyforgeUserId(),
      runPfJson(["--json", "users", "list"]),
    ]);
    const users = sanitizeUsersAnswer(raw).filter((user) => user.id !== userId);
    return { ...capability, admin: true, users };
  } catch (error) {
    const failure = error instanceof PolyforgeMessagesError ? error : PolyforgeMessagesError.fromSpawnError(error);
    return { ...capability, admin: false, users: [], error: failure.message };
  }
}

/** The `cli.toml`-mapped projects, read now for a membership write's
 *  validation; a failed read throws pf's typed failure (the route answers it
 *  without spawning a membership verb). */
export async function readPolyforgeMappedProjects(): Promise<string[]> {
  return mappedProjectsFromConfig(await readPolyforgeConfigItems());
}

/** One membership change exactly one pf subprocess:
 *  `projects members add <p> --user <id> --role writer` or
 *  `projects members remove <p> --user <id>`. pi-web writes no config file and
 *  never calls aihub directly; a refusal throws pf's typed failure. */
export async function changePolyforgeMembership(input: PolyforgeMembershipInput): Promise<void> {
  const argv = input.action === "add"
    ? ["--json", "projects", "members", "add", input.project, "--user", input.userId, "--role", "writer"]
    : ["--json", "projects", "members", "remove", input.project, "--user", input.userId];
  try {
    await execFileAsync(polyforgePfBin(), argv, { timeout: WRITE_TIMEOUT_MS });
  } catch (error) {
    throw PolyforgeMessagesError.fromSpawnError(error);
  }
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
  const effectiveBefore = before > 0 ? before : Number.MAX_SAFE_INTEGER;
  // The identity and page reads are independent spawns: concurrent (task-42 —
  // opening a conversation must settle after one spawn's latency, not two).
  const [userId, rawPage] = await Promise.all([
    readPolyforgeUserId(),
    listMessagesRaw(conversationId, effectiveBefore, 0, limit),
  ]);
  const page = sanitizeMessagePage(rawPage, userId);
  return pageWithOldestFlag(page, limit);
}

/** Newest page, one request: the history route's initial open. */
export async function readPolyforgeNewestPage(conversationId: string): Promise<PolyforgeMessagePage> {
  if (!isPolyforgeConversationId(conversationId)) {
    throw new PolyforgeMessagesError("conversation must be a conversation id", "CORE-400");
  }
  const [userId, rawPage] = await Promise.all([
    readPolyforgeUserId(),
    runPfJson([
      "--json", "msg", "list", "--conversation", conversationId,
      "--before", NEWEST_BEFORE, "--limit", String(DEFAULT_PAGE_SIZE),
    ]),
  ]);
  const page = sanitizeMessagePage(rawPage, userId);
  return pageWithOldestFlag(page, DEFAULT_PAGE_SIZE);
}

/** Messages newer than `after`, for the open conversation's 3 s refresh
 *  (forward paging — never a second backward request). */
export async function readPolyforgeNewerMessages(
  conversationId: string,
  after: number,
): Promise<PolyforgeMessage[]> {
  if (!isPolyforgeConversationId(conversationId) || !isPositiveSeq(after)) return [];
  const [userId, rawPage] = await Promise.all([
    readPolyforgeUserId(),
    listMessagesRaw(conversationId, 0, after, 50),
  ]);
  const page = sanitizeMessagePage(rawPage, userId);
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
    await execFileAsync(polyforgePfBin(), ["--json", "msg", "ack", conversationId, "--seq", String(seq)], {
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
