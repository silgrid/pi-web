"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePolyforgeMessagesCollapse } from "@/hooks/usePolyforgeMessagesCollapse";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import {
  getPolyforgeMessagesListDefaultWidth,
  getPolyforgeMessagesListMaxWidth,
  POLYFORGE_MESSAGES_LIST_MAX_WIDTH,
  POLYFORGE_MESSAGES_LIST_MIN_WIDTH,
} from "@/lib/panel-layout";
import {
  avatarColor,
  avatarInitial,
  compareContactsByName,
  contactsOutsideGroups,
  conversationForContact,
  conversationName,
  directRows,
  groupConversations,
  splitAnchor,
  type PolyforgeContact,
  type PolyforgeConversation,
  type PolyforgeMessage,
  type PolyforgeProjectGroup,
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
 * renders only inside the dock panel (the desktop dock and the mobile sheet
 * share the same component, two panes side by side at every width). On
 * desktop the list's left divider is also its resize separator
 *. Between the direct area and 群聊 sit the project groups
 *: one collapsible group per `cli.toml`-mapped project with
 * its contact count, an explicit empty or read-failure note, and rows that
 * open the contact's existing conversation or its empty pane (no unread
 * badge — unread lives on the direct row only). An admin (the users read
 * answered) gets an add control per group — a picker of human non-members,
 * added as writer — and a remove control per row, each behind a confirmation
 * naming the project and the display name; anyone else sees the groups
 * read-only with an explicit needs-admin notice. Its own storage is that width
 * and, through `usePolyforgeMessagesCollapse`, the collapsed groups. It never
 * writes a chat session or the agent composer.
 */

export interface PolyforgeMessagesProps {
  pfPresent: boolean;
  capable: boolean;
  reason: string | null;
  conversations: PolyforgeConversation[];
  contacts: PolyforgeContact[];
  /** The mapped projects' groups; [] renders no group. */
  groups: PolyforgeProjectGroup[];
  /** The admin probe: true enables add/remove, false shows the read-only
   *  notice, null (not answered yet) shows neither. */
  membershipAdmin: boolean | null;
  /** The picker's human users (id + display name only). */
  users: PolyforgeContact[];
  /** One confirmed membership change; resolves after the groups re-read and
   *  rejects with pf's text on a refusal. */
  onChangeMembership: (input: { action: "add" | "remove"; project: string; userId: string }) => Promise<void>;
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
  contacts: configuredContacts,
  groups,
  membershipAdmin,
  users,
  onChangeMembership,
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
  const { collapsed, toggleProject } = usePolyforgeMessagesCollapse();
  // The whole Messages surface measures the panel the list's bounds derive
  // from (the dock drag moves this width without a window resize).
  const messagesPanelRef = useRef<HTMLDivElement | null>(null);
  const listWidthRef = useRef(0);
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
  // the group whose add picker is open, the one membership
  // change in flight, and the last refused change's text (shown in its group).
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [membershipBusy, setMembershipBusy] = useState(false);
  const [membershipError, setMembershipError] = useState<{ project: string; text: string } | null>(null);

  const messagesPanelWidth = useCallback(
    () => messagesPanelRef.current?.getBoundingClientRect().width ?? 0,
    [],
  );
  const listDefaultWidth = useCallback(() => {
    const panelWidth = messagesPanelWidth();
    return panelWidth > 0 ? getPolyforgeMessagesListDefaultWidth(panelWidth) : POLYFORGE_MESSAGES_LIST_MIN_WIDTH;
  }, [messagesPanelWidth]);
  const listMaxWidth = useCallback(() => {
    const panelWidth = messagesPanelWidth();
    return panelWidth > 0 ? getPolyforgeMessagesListMaxWidth(panelWidth) : POLYFORGE_MESSAGES_LIST_MAX_WIDTH;
  }, [messagesPanelWidth]);
  // desktop only. persistClamp stays off so a dock narrowed
  // past the stored width only shrinks what is shown, never the saved value.
  const listResizer = useResizablePanel({
    ariaLabel: t("polyforge.messages.resizeList"),
    cssVariable: "--pf-messages-list-width",
    defaultWidth: POLYFORGE_MESSAGES_LIST_MIN_WIDTH,
    getDefaultWidth: listDefaultWidth,
    getMaxWidth: listMaxWidth,
    growthDirection: "left",
    maxWidth: POLYFORGE_MESSAGES_LIST_MAX_WIDTH,
    minWidth: POLYFORGE_MESSAGES_LIST_MIN_WIDTH,
    persistClamp: false,
    storageKey: "pi-web:polyforge-messages-list-width",
    widthRef: listWidthRef,
  });
  const reclampListWidth = listResizer.reclampWidth;

  // The hook refits on window resize only; a dock drag (or a sheet change)
  // changes this surface's own width, so re-fit from its box as well.
  useEffect(() => {
    const element = messagesPanelRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { reclampListWidth(); });
    observer.observe(element);
    return () => observer.disconnect();
    // The unavailable/capable branches and the list share this ref; when the
    // rendered branch changes, observe the element that is actually there.
  }, [reclampListWidth, pfPresent, capable]);

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

  // One membership change, behind a confirmation naming the project and the
  // display name (or the placeholder). Cancelling returns before any request.
  // The groups change only through the hook's awaited re-read; a refusal
  // shows pf's text in that group and changes nothing shown.
  const changeMembership = useCallback(async (action: "add" | "remove", project: string, user: PolyforgeContact) => {
    setAddingTo(null);
    if (membershipBusy) return;
    const name = user.display_name.trim() || t("polyforge.messages.unknownUser");
    const question = action === "add"
      ? t("polyforge.messages.confirmAddMember", { name, project })
      : t("polyforge.messages.confirmRemoveMember", { name, project });
    if (!window.confirm(question)) return;
    setMembershipBusy(true);
    setMembershipError(null);
    try {
      await onChangeMembership({ action, project, userId: user.id });
    } catch (changeError) {
      setMembershipError({ project, text: changeError instanceof Error ? changeError.message : String(changeError) });
    } finally {
      setMembershipBusy(false);
    }
  }, [membershipBusy, onChangeMembership, t]);

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
    return <div ref={messagesPanelRef} style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.unavailable")}</div>;
  }
  if (!capable) {
    return (
      <div ref={messagesPanelRef} style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <span style={{ color: "var(--text)" }}>{t("polyforge.messages.upgrade")}</span>
        <span style={{ color: "var(--text-dim)" }}>{reason ?? t("polyforge.messages.upgradeReason")}</span>
      </div>
    );
  }

  // One tree and one two-pane layout for desktop and mobile:
  // the list column and the chat pane are always side by side.
  const chatOpen = selectedConversation !== null || selectedContact !== null;

  const sections = groupConversations(conversations);
  // a contact listed in a project group lives there; the
  // direct area keeps its conversation rows and only the ungrouped silent
  // contacts (all of them when no group renders).
  const contacts = contactsOutsideGroups(configuredContacts, groups);
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

  // A project group's contact row: the display name (or the
  // placeholder) and no unread badge. A contact with a direct conversation
  // opens it; one without opens the empty pane — nothing is created or
  // acknowledged. Re-clicking what is already open is a no-op.
  const renderGroupContact = (project: string, contact: PolyforgeContact) => {
    const name = contact.display_name.trim();
    const existing = conversationForContact(conversations, contact.id);
    const open = existing
      ? existing.id === selectedConversation
      : selectedConversation === null && selectedContact?.id === contact.id;
    return (
      <div key={`group:${project}:${contact.id}`} style={{ display: "flex", alignItems: "center" }}>
        <button
          type="button"
          onClick={() => {
            if (open) return;
            if (existing) onSelectConversation(existing.id);
            else onSelectContact(contact);
          }}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "6px 8px 6px 16px", flex: 1, minWidth: 0,
            background: open ? "var(--bg-selected)" : "none",
            border: "none", cursor: "pointer", textAlign: "left", font: "inherit",
          }}
        >
          <Avatar seed={contact.id} name={name} />
          <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
            {name || t("polyforge.messages.unknownUser")}
          </span>
        </button>
        {membershipAdmin === true && (
          <button
            type="button"
            disabled={membershipBusy}
            onClick={() => void changeMembership("remove", project, contact)}
            aria-label={t("polyforge.messages.removeMember", { name: name || t("polyforge.messages.unknownUser"), project })}
            style={{ flexShrink: 0, background: "none", border: "none", color: "var(--text-muted)", cursor: membershipBusy ? "default" : "pointer", fontSize: 12, padding: "0 8px" }}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  // The add picker: the human users not already in the group
  // (machines never arrive; the caller is dropped server-side), by display
  // name. Choosing one asks for the confirmation; there is no role choice.
  const renderPicker = (group: PolyforgeProjectGroup) => {
    const members = new Set(group.contacts.map((contact) => contact.id));
    const candidates = users.filter((user) => !members.has(user.id)).sort(compareContactsByName);
    return (
      <div style={{ margin: "2px 8px 4px 16px", border: "1px solid var(--border)", borderRadius: 4, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", fontSize: 11, color: "var(--text-dim)" }}>
          <span style={{ flex: 1, minWidth: 0 }}>{t("polyforge.messages.pickMember")}</span>
          <button type="button" onClick={() => setAddingTo(null)}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: 0 }}>
            {t("polyforge.messages.pickClose")}
          </button>
        </div>
        {candidates.map((user) => {
          const name = user.display_name.trim();
          return (
            <button
              key={`pick:${group.project}:${user.id}`}
              type="button"
              onClick={() => void changeMembership("add", group.project, user)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", background: "none", border: "none", cursor: "pointer", textAlign: "left", font: "inherit" }}
            >
              <Avatar seed={user.id} name={name} />
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text)" }}>
                {name || t("polyforge.messages.unknownUser")}
              </span>
            </button>
          );
        })}
        {candidates.length === 0 && (
          <div style={{ padding: "4px 6px", fontSize: 11, color: "var(--text-dim)" }}>{t("polyforge.messages.pickEmpty")}</div>
        )}
      </div>
    );
  };

  // One project group: a header button (name, count, aria-expanded) that
  // folds it — expanded unless this browser stored it collapsed — then its
  // rows, its read-failure note, or the explicit empty placeholder. The
  // count is the group's contact count whether or not it is folded.
  const renderProjectGroup = (group: PolyforgeProjectGroup) => {
    const expanded = !collapsed.has(group.project);
    const bodyId = `pf-messages-group-${group.project}`;
    return (
      <div key={`project:${group.project}`}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={t("polyforge.messages.projectGroupLabel", { project: group.project, count: group.contacts.length })}
            onClick={() => toggleProject(group.project)}
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", flex: 1, minWidth: 0,
              background: "none", border: "none", cursor: "pointer", textAlign: "left", font: "inherit",
              fontSize: 11, color: "var(--text-muted)",
            }}
          >
            <span aria-hidden="true" style={{ width: 10, flexShrink: 0 }}>{expanded ? "▾" : "▸"}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{group.project}</span>
            <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{group.contacts.length}</span>
          </button>
          {membershipAdmin === true && !group.error && (
            <button
              type="button"
              disabled={membershipBusy}
              onClick={() => { setMembershipError(null); setAddingTo(addingTo === group.project ? null : group.project); }}
              aria-label={t("polyforge.messages.addMember", { project: group.project })}
              style={{ flexShrink: 0, background: "none", border: "none", color: "var(--text-muted)", cursor: membershipBusy ? "default" : "pointer", fontSize: 13, padding: "0 8px" }}
            >
              +
            </button>
          )}
        </div>
        {addingTo === group.project && membershipAdmin === true && renderPicker(group)}
        {membershipError?.project === group.project && (
          <div role="alert" style={{ padding: "2px 8px 4px 16px", fontSize: 11, color: "#dc2626", overflowWrap: "anywhere" }}>
            {t("polyforge.messages.membershipFailed")}: {membershipError.text}
          </div>
        )}
        {expanded && (
          <div id={bodyId}>
            {group.error ? (
              <div style={{ padding: "2px 8px 4px 16px", fontSize: 11, color: "#dc2626", overflowWrap: "anywhere" }}>
                {t("polyforge.messages.groupReadFailed")}: {group.error}
              </div>
            ) : group.contacts.length === 0 ? (
              <div data-empty-group={group.project} style={{ padding: "2px 8px 4px 16px", fontSize: 11, color: "var(--text-dim)" }}>
                {t("polyforge.messages.groupEmpty")}
              </div>
            ) : (
              group.contacts.map((contact) => renderGroupContact(group.project, contact))
            )}
          </div>
        )}
      </div>
    );
  };

  // The list column: the flat 单聊 area (conversation rows first, then the
  // silent contacts by display name, one row per peer) and the 群聊 section,
  // each with its empty placeholder. On desktop its left divider is the
  // resize separator; the stored width survives a narrow dock
  // and the chat pane always keeps its 200px floor. Mobile keeps the fixed
  // clamp with no handle.
  const listColumn = (
    <div
      ref={listResizer.panelRef}
      style={{
        position: "relative",
        width: isMobile ? "clamp(120px, 35%, 220px)" : "var(--pf-messages-list-width)",
        flexShrink: 0, minHeight: 0,
        display: "flex", flexDirection: "column",
        "--pf-messages-list-width": `${listResizer.width}px`,
      } as React.CSSProperties}
    >
      {!isMobile && (
        <div
          {...listResizer.separatorProps}
          aria-controls="pf-messages-list"
          className={`pf-messages-resize-handle${listResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="polyforge-messages-list"
          title={`${t("polyforge.messages.resizeList")}: ${t("layout.resizeHint")}`}
        />
      )}
      <div
        id="pf-messages-list"
        style={{
          flex: 1, minHeight: 0,
          borderLeft: "1px solid var(--border)",
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
        {groups.length > 0 && (
          <div style={{ padding: "6px 8px 2px", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
            {t("polyforge.messages.sectionProjects")}
          </div>
        )}
        {groups.length > 0 && membershipAdmin === false && (
          <div style={{ padding: "2px 8px 4px", fontSize: 11, color: "var(--text-muted)" }}>
            {t("polyforge.messages.membershipNeedsAdmin")}
          </div>
        )}
        {groups.map(renderProjectGroup)}
        <div style={{ padding: "6px 8px 2px", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
          {t("polyforge.messages.sectionGroups")}
        </div>
        {sections.groups.map(renderRow)}
        {sections.groups.length === 0 && (
          <div style={{ padding: "4px 8px", fontSize: 11, color: "var(--text-dim)" }}>{t("polyforge.messages.noGroups")}</div>
        )}
      </div>
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
    <div ref={messagesPanelRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row-reverse" }}>
      {listColumn}
      {chatPane}
    </div>
  );
}
