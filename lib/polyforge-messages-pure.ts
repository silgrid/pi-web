/**
 * Client-safe pure model and helpers for the Messages tab:
 * response types, the page merges, the one acknowledgment decision and the
 * anchor split. No Node import lives here, so both the server module and the
 * client hook/panel can use it.
 */

export interface PolyforgeConversation {
  id: string;
  kind: string;
  peer?: string;
  last_seq: number;
  unread: number;
  created_at: string;
}

export interface PolyforgeMessage {
  id: string;
  seq: number;
  text: string;
  about_wi?: string;
  reply_to?: string;
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
  activeTab: "jobs" | "messages";
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
