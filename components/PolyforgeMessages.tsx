"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import {
  avatarColor,
  avatarInitial,
  conversationName,
  directRows,
  groupConversations,
  splitAnchor,
  type PolyforgeContact,
  type PolyforgeConversation,
  type PolyforgeMessage,
} from "@/lib/polyforge-messages-pure";

/**
 * The dock's Messages surface (layout redone in,
 * contact list in): a Slack-like two-column panel — the list
 * as a right-hand column (the flat 单聊 area: direct conversation rows first,
 * then the silent configured contacts by display name; the 群聊 section;
 * initial-plus-colour avatars, display names, unread badges; no compose
 * entry — a contact row is the whole gesture) beside the bubble stream (own
 * bubbles right without attribution, peer bubbles left with a first-of-run
 * avatar and name, timestamps kept). No surface ever renders a raw user id:
 * every identity is the display name or the unknown-user placeholder. It
 * renders only inside the dock panel (desktop dock and mobile sheet share
 * the same component, one view at a time below the mobile breakpoint) and
 * never writes a chat session, the agent composer or a storage key.
 */

export interface PolyforgeMessagesProps {
  pfPresent: boolean;
  capable: boolean;
  reason: string | null;
  conversations: PolyforgeConversation[];
  contacts: PolyforgeContact[];
  error: string | null;
  selectedConversation: string | null;
  onSelectConversation: (id: string | null) => void;
  /** The open silent contact (no conversation yet): an empty pane whose
   *  first send addresses `contact.id`. */
  selectedContact: PolyforgeContact | null;
  onSelectContact: (contact: PolyforgeContact) => void;
  messages: PolyforgeMessage[];
  initialPageLoaded: boolean;
  blocked: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onAcknowledge: () => void;
  onSend: (input: { to: string; text: string; aboutWi?: string; replyTo?: string }) => Promise<unknown>;
  onAnalyze: (messageId: string) => Promise<string>;
  analyses: Record<string, string>;
  onOpenAnchor: (ref: string) => void;
}

function AnchorText({ anchor, onOpenAnchor }: { anchor: string; onOpenAnchor: (ref: string) => void }) {
  const { ref, rest } = splitAnchor(anchor);
  if (!ref) return <span>{anchor}</span>;
  return (
    <span>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onOpenAnchor(ref); }}
        aria-label={ref}
        style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", font: "inherit", textDecoration: "underline" }}
      >
        {ref}
      </button>
      {rest && <span>{rest}</span>}
    </span>
  );
}

/** The initial-plus-colour avatar. `seed` is the stable peer id (hash input
 *  only, never rendered); `name` is the display name the initial comes from.
 *  aria-hidden: the visible name beside it already identifies the peer. */
function Avatar({ seed, name }: { seed: string; name: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        flexShrink: 0, width: 22, height: 22, borderRadius: 11,
        background: avatarColor(seed), color: "#ffffff",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        fontSize: 11, fontWeight: 700,
      }}
    >
      {avatarInitial(name)}
    </span>
  );
}

/** HH:MM from the sanitized created_at; the raw string when unparsable. */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function PolyforgeMessages({
  pfPresent,
  capable,
  reason,
  conversations,
  contacts,
  error,
  selectedConversation,
  onSelectConversation,
  selectedContact,
  onSelectContact,
  messages,
  initialPageLoaded,
  blocked,
  loadingOlder,
  onLoadOlder,
  onAcknowledge,
  onSend,
  onAnalyze,
  analyses,
  onOpenAnchor,
}: PolyforgeMessagesProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const historyRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  // A programmatic scrollTop write also fires onScroll; only a real user
  // gesture may turn reaching the bottom into an explicit acknowledgment.
  const userScrolledRef = useRef(false);
  // The open conversation's peer is the recipient; it is captured on open so
  // a list poll blip cannot blank a reply's recipient.
  const [lastPeer, setLastPeer] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  // The composer's draft: text, anchor, the refusal text and the in-flight
  // flag.
  const [draftText, setDraftText] = useState("");
  const [draftAnchor, setDraftAnchor] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const selectedRow = selectedConversation
    ? conversations.find((conversation) => conversation.id === selectedConversation)
    : undefined;
  const selectedPeer = selectedRow?.peer ?? "";
  useEffect(() => { if (selectedPeer) setLastPeer(selectedPeer); }, [selectedPeer]);
  // The send address: the open conversation's peer, or — for a silent
  // contact with no conversation yet — the contact's id. Neither is rendered.
  const recipient = selectedConversation ? (selectedPeer || lastPeer) : (selectedContact?.id ?? "");
  // The pane's identity: the avatar hash seed and the display name.
  const paneSeed = selectedConversation ? selectedPeer : (selectedContact?.id ?? "");

  // A newly opened conversation or contact resets the composer's reply state.
  useEffect(() => { setReplyTo(null); }, [selectedConversation, selectedContact]);

  // Opening a conversation always positions the history at the newest message,
  // even while a local job is blocked: blocked suppresses only ARRIVAL
  // auto-scroll. A programmatic scroll never becomes an ack (userScrolledRef).
  useEffect(() => {
    stickToBottomRef.current = true;
    userScrolledRef.current = false;
    if (!initialPageLoaded) return;
    const element = historyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [selectedConversation, initialPageLoaded]);

  useEffect(() => {
    const element = historyRef.current;
    if (!element || blocked || !stickToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages, blocked]);

  const markUserScroll = useCallback(() => { userScrolledRef.current = true; }, []);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
    stickToBottomRef.current = atBottom;
    if (element.scrollTop <= 4) onLoadOlder();
    if (atBottom && userScrolledRef.current) {
      userScrolledRef.current = false;
      onAcknowledge();
    }
  }, [onLoadOlder, onAcknowledge]);

  const replyOriginal = replyTo ? messages.find((message) => message.id === replyTo) : undefined;

  // The composer sends to the open conversation's peer, or to the open
  // silent contact's id (its first send; the hook then opens the
  // conversation the send's answer names). The composer clears the moment
  // the send is accepted for submission and restores the attempt on a
  // refusal (pf's 4xx text shows under it), so a rendered message body
  // always means the message actually reached the history (never an
  // in-flight composer echo).
  const submit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (sending) return;
    const attempt = { text: draftText, anchor: draftAnchor };
    setSending(true);
    setSendError(null);
    setDraftText("");
    setDraftAnchor("");
    try {
      await onSend({
        to: recipient,
        text: attempt.text,
        ...(attempt.anchor.trim() ? { aboutWi: attempt.anchor.trim() } : {}),
        ...(replyTo ? { replyTo } : {}),
      });
      setReplyTo(null);
    } catch (submitError) {
      setDraftText(attempt.text);
      setDraftAnchor(attempt.anchor);
      setSendError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSending(false);
    }
  }, [sending, draftText, draftAnchor, onSend, recipient, replyTo]);

  const analyze = useCallback(async (messageId: string) => {
    if (analyzing) return;
    setAnalyzing(messageId);
    try {
      await onAnalyze(messageId);
    } catch (analyzeError) {
      setSendError(analyzeError instanceof Error ? analyzeError.message : String(analyzeError));
    } finally {
      setAnalyzing(null);
    }
  }, [analyzing, onAnalyze]);

  // The composer: it sends to the open conversation's peer or the open
  // silent contact (no recipient field — the header names the peer).
  const composer = (
    <form onSubmit={(event) => void submit(event)} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 12px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
      {replyOriginal && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", borderLeft: "2px solid var(--border)", paddingLeft: 6 }}>
          {t("polyforge.messages.quote")}: {replyOriginal.text}
        </div>
      )}
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
        {t("polyforge.messages.anchor")}
        <input value={draftAnchor} onChange={(event) => setDraftAnchor(event.target.value)}
          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
        {t("polyforge.messages.text")}
        <textarea value={draftText} onChange={(event) => setDraftText(event.target.value)} rows={3}
          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12, resize: "vertical" }} />
      </label>
      {sendError && <div style={{ fontSize: 11, color: "#dc2626" }}>{sendError}</div>}
      <button type="submit" disabled={sending}
        style={{ alignSelf: "flex-end", background: "var(--accent)", color: "var(--bg-panel)", border: "none", borderRadius: 4, padding: "4px 12px", fontSize: 12, cursor: sending ? "default" : "pointer" }}>
        {t("polyforge.messages.send")}
      </button>
    </form>
  );

  if (!pfPresent) {
    return <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.unavailable")}</div>;
  }
  if (!capable) {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <span style={{ color: "var(--text)" }}>{t("polyforge.messages.upgrade")}</span>
        <span style={{ color: "var(--text-dim)" }}>{reason ?? t("polyforge.messages.upgradeReason")}</span>
      </div>
    );
  }

  const chatOpen = selectedConversation !== null || selectedContact !== null;
  // One tree for desktop and mobile: mobile shows one view at a time (the
  // list while nothing is open, the chat while a conversation or contact is
  // open); the ack and scroll refs survive the switch because nothing
  // remounts.
  const showListColumn = !isMobile || !chatOpen;
  const showChatPane = !isMobile || chatOpen;

  const sections = groupConversations(conversations);
  const direct = directRows(conversations, contacts);

  const renderRow = (conversation: PolyforgeConversation) => {
    const name = conversationName(conversation);
    return (
      <button
        key={conversation.id}
        type="button"
        // Re-clicking the already-open row is a no-op: a second select would
        // blank the open history and restart its page fetch (the row stays
        // rendered in the two-column layout, so the click can repeat).
        onClick={() => { if (conversation.id !== selectedConversation) onSelectConversation(conversation.id); }}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
          background: conversation.id === selectedConversation ? "var(--bg-selected)" : "none",
          border: "none", cursor: "pointer", textAlign: "left", width: "100%", font: "inherit",
        }}
      >
        <Avatar seed={conversation.peer ?? conversation.id} name={name} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
          {name || t("polyforge.messages.unknownUser")}
        </span>
        {conversation.unread > 0 && (
          <span aria-label={t("polyforge.messages.unread")} title={t("polyforge.messages.unread")}
            style={{ minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "var(--accent)", color: "var(--bg-panel)", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {conversation.unread}
          </span>
        )}
      </button>
    );
  };

  // A silent contact row: avatar, display name (or the placeholder), no
  // unread. Clicking it opens the empty pane — no conversation is created
  // and nothing is acknowledged; re-clicking the open contact is a no-op.
  const renderContact = (contact: PolyforgeContact) => {
    const name = contact.display_name.trim();
    const open = selectedConversation === null && selectedContact?.id === contact.id;
    return (
      <button
        key={`contact:${contact.id}`}
        type="button"
        onClick={() => { if (!open) onSelectContact(contact); }}
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
          background: open ? "var(--bg-selected)" : "none",
          border: "none", cursor: "pointer", textAlign: "left", width: "100%", font: "inherit",
        }}
      >
        <Avatar seed={contact.id} name={name} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
          {name || t("polyforge.messages.unknownUser")}
        </span>
      </button>
    );
  };

  // The list column: the flat 单聊 area (conversation rows first, then the
  // silent contacts by display name, one row per peer) and the 群聊 section,
  // each with its empty placeholder. On desktop the column is a fixed clamp
  // of the panel width that never shrinks (the chat pane takes the rest); on
  // mobile it is the single view while nothing is open, so it fills the
  // sheet's full width with no desktop divider.
  const listColumn = (
    <div
      style={{
        width: isMobile ? "100%" : "clamp(120px, 35%, 220px)",
        flexShrink: 0, minHeight: 0,
        display: "flex", flexDirection: "column",
        borderLeft: isMobile ? "none" : "1px solid var(--border)",
        overflowY: "auto",
      }}
    >
      {error && <div style={{ padding: "6px 8px", color: "#dc2626", fontSize: 11, flexShrink: 0 }}>{error}</div>}
      <div style={{ padding: "6px 8px 2px", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
        {t("polyforge.messages.sectionDirect")}
      </div>
      {direct.map((row) => (row.kind === "conversation" ? renderRow(row.conversation) : renderContact(row.contact)))}
      {direct.length === 0 && (
        <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-dim)" }}>{t("polyforge.messages.empty")}</div>
      )}
      <div style={{ padding: "6px 8px 2px", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
        {t("polyforge.messages.sectionGroups")}
      </div>
      {sections.groups.map(renderRow)}
      {sections.groups.length === 0 && (
        <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-dim)" }}>{t("polyforge.messages.noGroups")}</div>
      )}
    </div>
  );

  // The chat pane: with nothing open it carries only the select-a-conversation
  // empty state (the history region and composer are not rendered, so
  // nothing acks and no conversation was auto-opened); with a conversation
  // or a silent contact open it is the header, the bubble stream (empty for
  // a contact until its first send) and the composer.
  const headerName = selectedRow
    ? conversationName(selectedRow)
    : (selectedContact?.display_name.trim() ?? "");
  const chatPane = !chatOpen ? (
    <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12, padding: 16 }}>
      {t("polyforge.messages.select")}
    </div>
  ) : (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button type="button" onClick={() => onSelectConversation(null)}
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: 0 }}>
          ← {t("polyforge.messages.back")}
        </button>
        <Avatar seed={paneSeed} name={headerName} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
          {headerName || t("polyforge.messages.unknownUser")}
        </span>
      </div>

      <div
        ref={historyRef}
        onScroll={handleScroll}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={markUserScroll}
        onKeyDown={markUserScroll}
        aria-label={t("polyforge.messages.history")}
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}
      >
        {loadingOlder && <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{t("polyforge.messages.loadingOlder")}</div>}
        {messages.map((message, index) => {
          const original = message.reply_to
            ? messages.find((candidate) => candidate.id === message.reply_to)
            : undefined;
          // In a direct conversation every consecutive non-own neighbour is
          // the same peer, so the attribution shows on the first of a run.
          const firstOfRun = index === 0 || messages[index - 1].mine;
          return (
            <div
              key={message.id}
              onClick={onAcknowledge}
              style={{
                display: "flex", flexDirection: "column", gap: 2, padding: "6px 8px", borderRadius: 6,
                cursor: "default", background: message.mine ? "var(--user-bg)" : "var(--bg-hover)",
                alignSelf: message.mine ? "flex-end" : "flex-start", maxWidth: "80%",
              }}
            >
              {!message.mine && firstOfRun && (
                <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <Avatar seed={paneSeed} name={headerName} />
                  <span style={{ fontSize: 11, color: "var(--text)" }}>
                    {headerName || t("polyforge.messages.unknownUser")}
                  </span>
                </span>
              )}
              {message.about_wi && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  <AnchorText anchor={message.about_wi} onOpenAnchor={onOpenAnchor} />
                </span>
              )}
              <span style={{ fontSize: 12, color: message.about_wi ? "var(--text)" : "var(--text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {message.text}
              </span>
              {message.reply_to && (
                <span style={{ fontSize: 11, color: "var(--text-muted)", borderLeft: "2px solid var(--border)", paddingLeft: 6 }}>
                  {t("polyforge.messages.quote")}: {original ? <span>{original.text}</span> : message.reply_to}
                </span>
              )}
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{formatTimestamp(message.created_at)}</span>
                <button type="button" onClick={(event) => { event.stopPropagation(); flushSync(() => setReplyTo(message.id)); }}
                  style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: 0 }}>
                  {t("polyforge.messages.reply")}
                </button>
                {!message.mine && (
                  <button type="button" onClick={(event) => { event.stopPropagation(); void analyze(message.id); }}
                    disabled={analyzing === message.id}
                    style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: 0 }}>
                    {t("polyforge.messages.analyze")}
                  </button>
                )}
              </span>
              {analyses[message.id] && (
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{analyses[message.id]}</span>
              )}
            </div>
          );
        })}
      </div>

      {composer}
    </div>
  );

  // row-reverse keeps the column flush right while it stays first in DOM
  // order (the layout's own oracle).
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row-reverse" }}>
      {showListColumn && listColumn}
      {showChatPane && chatPane}
    </div>
  );
}
