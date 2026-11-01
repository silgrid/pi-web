/**
 * Client-safe pure model and helpers for the Messages tab:
 * response types, the page merges, the one acknowledgment decision, the
 * anchor split, the flat direct contact list and the project
 * groups. No Node import lives here, so both the server
 * module and the client hook/panel can use it.
 */

export interface PolyforgeConversation {
  id: string;
  kind: string;
  /** The peer user id — the send address, never rendered. */
  peer?: string;
  /** The peer's display name; absent/empty renders as the unknown-user
   *  placeholder, never an id fallback. */
  peer_name?: string;
  last_seq: number;
  unread: number;
  created_at: string;
}

/** A configured contact: one human the caller can message,
 *  from `pf msg contacts`. `id` is the send address only — never rendered,
 *  titled or labelled; `display_name` may be "" (the unknown-user
 *  placeholder renders, never the id). */
export interface PolyforgeContact {
  id: string;
  display_name: string;
}

/** One `cli.toml`-mapped project's group: the project name
 *  and its human contacts (id + display name only — the contact set's own
 *  projection; roles, machines and the caller never enter). `error` is that
 *  project's own failed members read; the other groups are unaffected. */
export interface PolyforgeProjectGroup {
  project: string;
  contacts: PolyforgeContact[];
  error?: string;
}

/** One project's members read, as the server joins it: the member user ids
 *  (roles already dropped), or the read's own failure text. */
export type PolyforgeProjectMembersRead = { ids: string[] } | { error: string };

export interface PolyforgeMessage {
  id: string;
  seq: number;
  text: string;
  about_wi?: string;
  reply_to?: string;
  /** The conversation the message lives in — a send's answer carries it so
   *  the resulting conversation can be opened without re-reading the list. */
  conversation_id?: string;
  created_at: string;
  mine: boolean;
}

export interface PolyforgeMessagePage {
  messages: PolyforgeMessage[];
  last_seq: number;
  /** True when the page was full, so an older page may still exist. */
  has_older?: boolean;
}

const CONVERSATION_TOKEN = /^conv_[A-Za-z0-9_]+$/;
const MESSAGE_TOKEN = /^msg_[A-Za-z0-9_]+$/;
const USER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export function isPolyforgeConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_TOKEN.test(value);
}

export function isPolyforgeMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_TOKEN.test(value);
}

export function isPolyforgeRecipient(value: unknown): value is string {
  return typeof value === "string" && USER_TOKEN.test(value);
}

export function isPositiveSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Prepend an older page, deduping by message id and keeping ascending seq
 *  order. No gap is invented and no duplicate survives. Pure. */
export function mergeOlderPage(
  existing: PolyforgeMessage[],
  older: PolyforgeMessage[],
): PolyforgeMessage[] {
  const seen = new Set(existing.map((message) => message.id));
  const merged = [...older.filter((message) => !seen.has(message.id)), ...existing];
  return merged.sort((a, b) => a.seq - b.seq);
}

/** Merge a newest-page refresh into the loaded history: replace/insert by id,
 *  keep already-loaded older pages, keep ascending order. Pure. */
export function mergeNewestPage(
  existing: PolyforgeMessage[],
  newest: PolyforgeMessage[],
): PolyforgeMessage[] {
  const byId = new Map(existing.map((message) => [message.id, message]));
  for (const message of newest) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

/** The acknowledgment decision (one place, pure): auto-ack only while the
 *  panel is open, Messages is the active tab, a conversation is open and no
 *  local job is blocked; always the NEWEST DISPLAYED sequence, never one the
 *  user has not seen; never a sequence already acknowledged. An explicit user
 *  gesture (message click / scroll-to-bottom) bypasses visibility and the
 *  blocked-job suppression. */
export interface AckDecisionInput {
  panelOpen: boolean;
  /** The dock's top-level tab (Work | Memory | Messages, the
   *  former Jobs and Tasks tabs now Work's sub-tabs): only "messages" may
   *  auto-ack — the union keeps the hook's tab state passing through
   *  unchanged. */
  activeTab: "memory" | "messages" | "work";
  conversationId: string | null;
  blocked: boolean;
  newestDisplayedSeq: number;
  lastAckedSeq: number;
  explicit?: boolean;
}

export function ackDecision(input: AckDecisionInput): number | null {
  if (!input.conversationId) return null;
  if (!isPositiveSeq(input.newestDisplayedSeq)) return null;
  if (input.newestDisplayedSeq <= input.lastAckedSeq) return null;
  if (!input.explicit) {
    if (!input.panelOpen || input.activeTab !== "messages" || input.blocked) return null;
  }
  return input.newestDisplayedSeq;
}

/** Split a work-item anchor into the clickable work-item part and the rest
 *  of the reference. Only the work-item prefix reaches the Jobs watch read;
 *  the remainder renders as plain text and is never fetched. Pure. */
export function splitAnchor(anchor: string): { ref: string; rest: string } {
  const value = anchor.trim();
  const match = /^(wi_[A-Za-z0-9]+|[A-Za-z0-9][A-Za-z0-9_-]*#\d+|[A-Za-z0-9][A-Za-z0-9_-]*-\d+)/.exec(value);
  if (!match) return { ref: "", rest: value };
  const ref = match[1];
  const rest = value.slice(ref.length);
  if (rest && !rest.startsWith("/")) return { ref: "", rest: value };
  return { ref, rest };
}

// ---- the Slack-like layout's identity helpers ----

/** The conversation's display name (the peer's), trimmed; "" when absent,
 *  empty or blank. The caller renders the unknown-user placeholder for "" —
 *  never a raw id fallback. Pure. */
export function conversationName(conversation: PolyforgeConversation): string {
  return (conversation.peer_name ?? "").trim();
}

/** The avatar initial: the first code point of the display name, upper-cased
 *  (code-point safe, not UTF-16 unit); "?" when there is no name. Pure. */
export function avatarInitial(name: string): string {
  const first = [...name.trim()][0];
  return first ? first.toUpperCase() : "?";
}

/** A deterministic per-user colour (FNV-1a hash of the stable peer id →
 *  hue). The result is a CSS colour string only — the seed is never rendered
 *  as text. Pure. */
export function avatarColor(seed: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `hsl(${hash % 360}, 45%, 45%)`;
}

/** Split the list into the direct (单聊) and group (群聊 — any other kind)
 *  sections, preserving order. Pure. */
export function groupConversations(
  list: PolyforgeConversation[],
): { direct: PolyforgeConversation[]; groups: PolyforgeConversation[] } {
  const direct: PolyforgeConversation[] = [];
  const groups: PolyforgeConversation[] = [];
  for (const conversation of list) {
    if (conversation.kind === "direct") direct.push(conversation);
    else groups.push(conversation);
  }
  return { direct, groups };
}

/** The contact order every list uses: display name ascending, blank names
 *  last, the id only as a deterministic tie-break (never rendered). Pure. */
export function compareContactsByName(a: PolyforgeContact, b: PolyforgeContact): number {
  const left = a.display_name.trim();
  const right = b.display_name.trim();
  if (!left !== !right) return left ? -1 : 1;
  return left.localeCompare(right) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** One row of the flat direct (单聊) area: an existing direct conversation,
 *  or a silent contact — a configured contact with no direct conversation. */
export type PolyforgeDirectRow =
  | { kind: "conversation"; conversation: PolyforgeConversation }
  | { kind: "contact"; contact: PolyforgeContact };

/** The flat direct area: the direct conversation rows in
 *  their current order (unread intact), then the silent contacts sorted by
 *  display name (blank names last, id as the tie-break), one row per peer —
 *  a contact whose id is already a direct conversation's peer, or repeats an
 *  earlier contact, adds no row. Group conversations are not part of it.
 *  Pure. */
export function directRows(
  conversations: PolyforgeConversation[],
  contacts: PolyforgeContact[],
): PolyforgeDirectRow[] {
  const { direct } = groupConversations(conversations);
  const seen = new Set<string>();
  for (const conversation of direct) if (conversation.peer) seen.add(conversation.peer);
  const silent: PolyforgeContact[] = [];
  for (const contact of contacts) {
    if (seen.has(contact.id)) continue;
    seen.add(contact.id);
    silent.push(contact);
  }
  silent.sort(compareContactsByName);
  return [
    ...direct.map((conversation) => ({ kind: "conversation" as const, conversation })),
    ...silent.map((contact) => ({ kind: "contact" as const, contact })),
  ];
}

/** The direct conversation whose peer is this contact: the
 *  one a silent contact's peer created with a first message, else null. A
 *  group conversation never matches. Pure. */
export function conversationForContact(
  conversations: PolyforgeConversation[],
  contactId: string,
): PolyforgeConversation | null {
  return conversations.find((conversation) => conversation.kind === "direct" && conversation.peer === contactId) ?? null;
}

/** A mapping's project names as groups use them: trimmed, deduplicated,
 *  ascending by name. Pure. */
export function normalizeProjectNames(names: string[]): string[] {
  const unique = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed) unique.add(trimmed);
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The project groups: one per mapped project in name order;
 *  each project's member ids joined by id to the contact set — an id absent
 *  from it (a machine, the caller, a non-human) adds no row, an id repeated
 *  adds one — sorted like every contact list. A failed members read keeps
 *  its group with no contacts and its own error. Pure. */
export function buildProjectGroups(
  projects: string[],
  memberReads: Record<string, PolyforgeProjectMembersRead | undefined>,
  contacts: PolyforgeContact[],
): PolyforgeProjectGroup[] {
  const byId = new Map<string, PolyforgeContact>();
  for (const contact of contacts) if (!byId.has(contact.id)) byId.set(contact.id, contact);
  return normalizeProjectNames(projects).map((project) => {
    const read = memberReads[project];
    if (!read || "error" in read) {
      return { project, contacts: [], error: read?.error || "the project members read failed" };
    }
    const seen = new Set<string>();
    const rows: PolyforgeContact[] = [];
    for (const id of read.ids) {
      const contact = byId.get(id);
      if (!contact || seen.has(id)) continue;
      seen.add(id);
      rows.push({ id: contact.id, display_name: contact.display_name });
    }
    rows.sort(compareContactsByName);
    return { project, contacts: rows };
  });
}

/** The silent contacts the flat direct area still lists once project groups
 *  render: a contact shown in any group lives there, not
 *  twice; with no groups every contact stays. Pure. */
export function contactsOutsideGroups(
  contacts: PolyforgeContact[],
  groups: PolyforgeProjectGroup[],
): PolyforgeContact[] {
  const grouped = new Set<string>();
  for (const group of groups) for (const contact of group.contacts) grouped.add(contact.id);
  return contacts.filter((contact) => !grouped.has(contact.id));
}
