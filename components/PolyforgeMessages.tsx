"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import {
  splitAnchor,
  type PolyforgeConversation,
  type PolyforgeMessage,
} from "@/lib/polyforge-messages-pure";

/**
 * The dock's Messages surface: the member-only conversation
 * list, newest-page-first history with scroll-up paging, the composer and
 * reply quote, per-received-message analysis (transient) and work-item
 * anchors that open the existing Jobs detail. It renders only inside the
 * dock panel (desktop dock and mobile sheet share the same component) and
 * never writes a chat session, the agent composer or a storage key.
 */

export interface PolyforgeMessagesProps {
  pfPresent: boolean;
  capable: boolean;
  reason: string | null;
  conversations: PolyforgeConversation[];
  error: string | null;
  selectedConversation: string | null;
  onSelectConversation: (id: string | null) => void;
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

export function PolyforgeMessages({
  pfPresent,
  capable,
  reason,
  conversations,
  error,
  selectedConversation,
  onSelectConversation,
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
  const historyRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  // A programmatic scrollTop write also fires onScroll; only a real user
  // gesture may turn reaching the bottom into an explicit acknowledgment.
  const userScrolledRef = useRef(false);
  // The open conversation's peer is the recipient; it is captured on open so
  // a list poll blip cannot blank a reply's recipient.
  const [lastPeer, setLastPeer] = useState("");
  const [newRecipient, setNewRecipient] = useState("");
  const [text, setText] = useState("");
  const [anchor, setAnchor] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);

  const selectedPeer = selectedConversation
    ? conversations.find((conversation) => conversation.id === selectedConversation)?.peer ?? ""
    : "";
  useEffect(() => { if (selectedPeer) setLastPeer(selectedPeer); }, [selectedPeer]);
  const recipient = selectedConversation ? (selectedPeer || lastPeer) : "";

  // A newly opened conversation resets the composer's reply state.
  useEffect(() => { setReplyTo(null); }, [selectedConversation]);

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

  const submit = useCallback(async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (sending) return;
    // Inside an open conversation the recipient is its peer (never a free
    // field); the list view's new-message entry takes the typed recipient.
    const target = selectedConversation ? recipient : newRecipient.trim();
    setSending(true);
    setSendError(null);
    try {
      await onSend({
        to: target,
        text,
        ...(anchor.trim() ? { aboutWi: anchor.trim() } : {}),
        ...(replyTo ? { replyTo } : {}),
      });
      setText("");
      setAnchor("");
      setNewRecipient("");
      setReplyTo(null);
    } catch (submitError) {
      setSendError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setSending(false);
    }
  }, [sending, onSend, selectedConversation, recipient, newRecipient, text, anchor, replyTo]);

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

  // One composer for both faces: the conversation view locks its recipient to
  // the open conversation's peer, the list view takes a new recipient.
  const renderComposer = (recipientField: React.ReactNode) => (
    <form onSubmit={(event) => void submit(event)} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 12px", borderTop: "1px solid var(--border)", flexShrink: 0 }}>
      {replyOriginal && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", borderLeft: "2px solid var(--border)", paddingLeft: 6 }}>
          {t("polyforge.messages.quote")}: {replyOriginal.text}
        </div>
      )}
      {recipientField}
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
        {t("polyforge.messages.anchor")}
        <input value={anchor} onChange={(event) => setAnchor(event.target.value)}
          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
        {t("polyforge.messages.text")}
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3}
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

  if (!selectedConversation) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
          {error && <div style={{ padding: "8px 12px", color: "#dc2626", fontSize: 12 }}>{error}</div>}
          {conversations.length === 0 && (
            <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.messages.empty")}</div>
          )}
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              onClick={() => onSelectConversation(conversation.id)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                padding: "8px 12px", background: "none", border: "none", borderBottom: "1px solid var(--border)",
                cursor: "pointer", textAlign: "left", width: "100%", font: "inherit",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", fontSize: 12, color: "var(--text)" }}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {conversation.peer ?? conversation.id}
                </span>
                {conversation.unread > 0 && (
                  <span aria-label={t("polyforge.messages.unread")} title={t("polyforge.messages.unread")}
                    style={{ minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "var(--accent)", color: "var(--bg-panel)", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {conversation.unread}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
        {renderComposer(
          <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
            {t("polyforge.messages.recipient")}
            <input value={newRecipient} onChange={(event) => setNewRecipient(event.target.value)}
              aria-label={t("polyforge.messages.recipient")}
              style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
          </label>,
        )}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button type="button" onClick={() => onSelectConversation(null)}
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: 0 }}>
          ← {t("polyforge.messages.back")}
        </button>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text-dim)" }}>
          {conversations.find((conversation) => conversation.id === selectedConversation)?.peer ?? selectedConversation}
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
        {messages.map((message) => {
          const original = message.reply_to
            ? messages.find((candidate) => candidate.id === message.reply_to)
            : undefined;
          return (
            <div
              key={message.id}
              onClick={onAcknowledge}
              style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px", borderRadius: 6, cursor: "default", background: message.mine ? "var(--user-bg)" : "var(--bg-hover)" }}
            >
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
                  {t("polyforge.messages.quote")}: {original ? original.text : message.reply_to}
                </span>
              )}
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
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

      {renderComposer(
        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--text-dim)" }}>
          {t("polyforge.messages.recipient")}
          <input value={recipient} onChange={() => undefined}
            aria-label={t("polyforge.messages.recipient")} aria-readonly="true"
            style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }} />
        </label>,
      )}
    </div>
  );
}
