"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PolyforgeOpsStatus, PolyforgeWatchStatus } from "@/lib/polyforge-status";
import {
  ackDecision,
  mergeNewestPage,
  mergeOlderPage,
  type PolyforgeConversation,
  type PolyforgeMessage,
} from "@/lib/polyforge-messages-pure";

/**
 * Panel-facing client state for the Polyforge dock panel (pi#108) and its
 * Messages tab.
 *
 * - One status fetch at mount decides presence (`pfPresent`); a pf-less
 *   install never polls again — the only HTTP it ever sees is that single
 *   2xx request, so unrelated e2e flows log no console errors.
 * - With pf present: the status route is polled every 3s while the panel is
 *   open and every 30s while closed (badge).
 * - While open with a selection: the watch route is polled every 3s. A null
 *   status (daemon blip, job gone) keeps the previous snapshot — the
 *   selection and its detail survive the job leaving the job list.
 * - Messages reuse the SAME 3s/30s dock cadence (no new timer): the
 *   conversation list rides the status interval, and while a conversation is
 *   open its newer messages are fetched on the same 3s tick (one `--after`
 *   read, never a second backward page). Auto-acknowledgment goes through
 *   the one pure `ackDecision` helper.
 */

const OPEN_STATUS_POLL_MS = 3000;
const CLOSED_STATUS_POLL_MS = 30000;
const OPEN_WATCH_POLL_MS = 3000;

type StatusResponse = { pfPresent?: boolean; status?: PolyforgeOpsStatus | null; error?: string };
type WatchResponse = { status?: PolyforgeWatchStatus | null; error?: string };
type MessagesResponse = {
  pfPresent?: boolean;
  pfVersion?: string | null;
  capable?: boolean;
  reason?: string;
  conversations?: PolyforgeConversation[];
  error?: string;
};
type PageResponse = {
  capable?: boolean;
  messages?: PolyforgeMessage[];
  last_seq?: number;
  has_older?: boolean;
  error?: string;
};
type SendResponse = { ok?: boolean; message?: PolyforgeMessage; error?: string };
type AnalyzeResponse = { ok?: boolean; conclusion?: string; model?: string; error?: string };

/** Keep the last snapshot when a watch response degrades to null (pure). */
export function nextWatchSnapshot(
  previous: PolyforgeWatchStatus | null,
  body: WatchResponse | null,
): PolyforgeWatchStatus | null {
  return body?.status ?? previous;
}

export type PolyforgeTab = "jobs" | "messages";

export interface SendMessageInput {
  to: string;
  text: string;
  aboutWi?: string;
  replyTo?: string;
}

export function usePolyforge(panelOpen: boolean) {
  const [pfPresent, setPfPresent] = useState(false);
  const [probed, setProbed] = useState(false);
  const [opsStatus, setOpsStatus] = useState<PolyforgeOpsStatus | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  // False from the moment the panel opens until this opening's own status
  // read settles: auto-ack must judge the CURRENT blocked state, never the
  // previous opening's stale snapshot.
  const [statusReady, setStatusReady] = useState(false);
  const [selectedWi, setSelectedWi] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<PolyforgeWatchStatus | null>(null);

  // Messages state.
  const [activeTab, setActiveTabState] = useState<PolyforgeTab>("jobs");
  const [messagesCapable, setMessagesCapable] = useState(true);
  const [messagesReason, setMessagesReason] = useState<string | null>(null);
  const [conversations, setConversations] = useState<PolyforgeConversation[]>([]);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<string | null>(null);
  const [messages, setMessages] = useState<PolyforgeMessage[]>([]);
  // The conversation whose newest page has settled. The panel positions the
  // history at the bottom on that first page even while a job is blocked;
  // later arrivals are the only scrolled messages the blocked state suppresses.
  const [initialPageLoaded, setInitialPageLoaded] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [analyses, setAnalyses] = useState<Record<string, string>>({});

  const statusSeq = useRef(0);
  const watchSeq = useRef(0);
  const messagesSeq = useRef(0);
  const pageSeq = useRef(0);
  const messagesRef = useRef<PolyforgeMessage[]>([]);
  const lastAcked = useRef<Record<string, number>>({});

  useEffect(() => { messagesRef.current = messages; }, [messages]);

  // Returns the settle promise so a manual refresh caller (the panel's
  // refresh button, pi#113) can show in-flight state; the interval and mount
  // callers ignore it. Background polls and the manual click share this one
  // function — in-flight indication lives with the click, not the fetch.
  const refreshStatus = useCallback(() => {
    const seq = ++statusSeq.current;
    return fetch("/api/polyforge/status")
      .then(async (response) => {
        const body = await response.json() as StatusResponse;
        if (seq !== statusSeq.current) return;
        setPfPresent(Boolean(body.pfPresent));
        setProbed(true);
        setOpsStatus(body.status ?? null);
        setOpsError(body.status ? null : (body.error ?? null));
        setStatusReady(true);
      })
      .catch(() => {
        if (seq !== statusSeq.current) return;
        setProbed(true);
        setOpsStatus(null);
        setOpsError("polyforge is unreachable");
        setStatusReady(true);
      });
  }, []);

  const refreshWatch = useCallback((wi: string) => {
    const seq = ++watchSeq.current;
    fetch(`/api/polyforge/watch?wi=${encodeURIComponent(wi)}`)
      .then(async (response) => {
        const body = await response.json() as WatchResponse;
        if (seq !== watchSeq.current) return;
        // Null keeps the previous snapshot (selection persistence, AC6).
        setWatchStatus((previous) => nextWatchSnapshot(previous, body));
      })
      .catch(() => {
        // A network blip keeps the previous snapshot too.
      });
  }, []);

  // The conversation list rides the same dock cadence: one read at mount and
  // on every open/closed interval tick. Below the floor the route answers a
  // capability field and spawns no message verb.
  const refreshMessages = useCallback(() => {
    const seq = ++messagesSeq.current;
    return fetch("/api/polyforge/messages")
      .then(async (response) => {
        const body = await response.json() as MessagesResponse;
        if (seq !== messagesSeq.current) return null;
        setMessagesCapable(body.capable !== false);
        setMessagesReason(body.reason ?? null);
        setConversations(Array.isArray(body.conversations) ? body.conversations : []);
        // `error` is the non-floor read failure; `reason` belongs to the
        // upgrade state only.
        setMessagesError(body.capable === false ? (body.reason ?? null) : (body.error ?? null));
        return body;
      })
      .catch(() => {
        if (seq !== messagesSeq.current) return null;
        setMessagesError("messages are unreachable");
        return null;
      });
  }, []);

  // One fetch at mount: presence, and nothing more when pf is absent.
  // Effect cleanups ADVANCE the guard counters: resetting to an observed
  // value + 1 rewinds them (interval polls have long moved past it), so a
  // late response from the previous selection could be accepted under the
  // current one for up to one poll.
  useEffect(() => {
    refreshStatus();
    // This ref is a fetch-generation counter, not a React-rendered node, and
    // copying it into the effect would rewind past interval-poll increments
    // (the exact stale-response defect NB-1 names).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { ++statusSeq.current; };
  }, [refreshStatus]);

  // A new opening starts from an unready status: the stale snapshot cannot
  // suppress (or allow) the first auto-ack decision.
  useEffect(() => {
    if (panelOpen) setStatusReady(false);
  }, [panelOpen]);

  // Cadence: 3s open, 30s closed — only while pf is present.
  useEffect(() => {
    if (!probed || !pfPresent) return;
    // Opening the panel reads the current state immediately: a blocked job
    // must suppress auto-ack from the first poll, not one cadence later.
    if (panelOpen) refreshStatus();
    const interval = setInterval(refreshStatus, panelOpen ? OPEN_STATUS_POLL_MS : CLOSED_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [probed, pfPresent, panelOpen, refreshStatus]);

  // Messages use the same interval (3s open / 30s closed), never a new timer.
  useEffect(() => {
    if (!probed || !pfPresent) return;
    refreshMessages();
    const interval = setInterval(refreshMessages, panelOpen ? OPEN_STATUS_POLL_MS : CLOSED_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [probed, pfPresent, panelOpen, refreshMessages]);

  // Watch the selection while the panel is open: immediately and every 3s.
  useEffect(() => {
    if (!panelOpen || !selectedWi) return;
    refreshWatch(selectedWi);
    const interval = setInterval(() => refreshWatch(selectedWi), OPEN_WATCH_POLL_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same counter rationale as above
    return () => { ++watchSeq.current; clearInterval(interval); };
  }, [panelOpen, selectedWi, refreshWatch]);

  const select = useCallback((wi: string | null) => {
    setSelectedWi(wi);
    // A new selection starts from a clean snapshot; deselect clears it.
    setWatchStatus(null);
  }, []);

  // ---- Messages actions ----

  const loadNewestPage = useCallback((conversationId: string) => {
    const seq = ++pageSeq.current;
    return fetch(`/api/polyforge/messages/${encodeURIComponent(conversationId)}`)
      .then(async (response) => {
        const body = await response.json() as PageResponse;
        if (seq !== pageSeq.current) return;
        const page = Array.isArray(body.messages) ? body.messages : [];
        setMessages(page);
        setHasOlder(body.has_older === true);
        setMessagesError(body.error ?? null);
      })
      .catch(() => {
        if (seq !== pageSeq.current) return;
        setMessagesError("messages are unreachable");
      })
      .finally(() => {
        // The panel may position the history at the bottom of this first page
        // even while a local job is blocked (only arrivals are suppressed).
        if (seq === pageSeq.current) setInitialPageLoaded(conversationId);
      });
  }, []);

  const selectConversation = useCallback((conversationId: string | null) => {
    setSelectedConversation(conversationId);
    setMessages([]);
    setHasOlder(false);
    setInitialPageLoaded(null);
    ++pageSeq.current;
    if (conversationId) void loadNewestPage(conversationId);
  }, [loadNewestPage]);

  const loadOlder = useCallback(() => {
    const conversationId = selectedConversation;
    const current = messagesRef.current;
    if (!conversationId || !hasOlder || loadingOlder || current.length === 0) return;
    const oldest = current[0].seq;
    const seq = ++pageSeq.current;
    setLoadingOlder(true);
    fetch(`/api/polyforge/messages/${encodeURIComponent(conversationId)}?before=${oldest}`)
      .then(async (response) => {
        const body = await response.json() as PageResponse;
        if (seq !== pageSeq.current) return;
        const older = Array.isArray(body.messages) ? body.messages : [];
        setMessages((previous) => mergeOlderPage(previous, older));
        setHasOlder(body.has_older === true);
      })
      .catch(() => {
        // A failed older page leaves the loaded history intact.
      })
      .finally(() => {
        if (seq === pageSeq.current) setLoadingOlder(false);
      });
  }, [selectedConversation, hasOlder, loadingOlder]);

  // Newer messages for the open conversation: one forward `?after=` read on
  // the existing 3s tick, merged without touching already-loaded older pages.
  const refreshOpen = useCallback((conversationId: string) => {
    const current = messagesRef.current;
    const newest = current.length > 0 ? current[current.length - 1].seq : 0;
    if (newest <= 0) return Promise.resolve();
    // No page-generation guard here: merges are idempotent by id, and a
    // concurrent interval refresh must never drop the send-driven one.
    return fetch(`/api/polyforge/messages/${encodeURIComponent(conversationId)}?after=${newest}`)
      .then(async (response) => {
        const body = await response.json() as PageResponse;
        const newer = Array.isArray(body.messages) ? body.messages : [];
        if (newer.length === 0) return;
        setMessages((previous) => mergeNewestPage(previous, newer));
      })
      .catch(() => {
        // A blip keeps the loaded history.
      });
  }, []);

  useEffect(() => {
    if (!panelOpen || !selectedConversation) return;
    const interval = setInterval(() => refreshOpen(selectedConversation), OPEN_WATCH_POLL_MS);
    return () => { ++pageSeq.current; clearInterval(interval); };
  }, [panelOpen, selectedConversation, refreshOpen]);

  const acknowledge = useCallback((conversationId: string, seq: number) => {
    if (seq <= (lastAcked.current[conversationId] ?? 0)) return Promise.resolve();
    const previous = lastAcked.current[conversationId] ?? 0;
    lastAcked.current[conversationId] = seq;
    return fetch("/api/polyforge/messages/ack", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversation_id: conversationId, seq }),
    })
      .then(async (response) => {
        const body = await response.json() as { error?: string };
        if (!response.ok || body.error) throw new Error(body.error ?? "acknowledgment refused");
        setConversations((previousRows) => previousRows.map((row) => (
          row.id === conversationId
            ? { ...row, unread: row.last_seq <= seq ? 0 : row.unread }
            : row
        )));
      })
      .catch(() => {
        // The server did not record it: let the next poll try again.
        if ((lastAcked.current[conversationId] ?? 0) === seq) {
          lastAcked.current[conversationId] = previous;
        }
      });
  }, []);

  const blocked = opsStatus?.jobs.some((job) => job.status === "needs_input") ?? false;
  const newestDisplayedSeq = messages.length > 0 ? messages[messages.length - 1].seq : 0;

  // Auto-ack: the one pure decision, applied whenever the displayed page or
  // the visibility state changes. It names only the newest DISPLAYED seq.
  useEffect(() => {
    const conversationId = selectedConversation;
    if (!conversationId) return;
    if (!statusReady) return;
    const seq = ackDecision({
      panelOpen,
      activeTab,
      conversationId,
      blocked,
      newestDisplayedSeq,
      lastAckedSeq: lastAcked.current[conversationId] ?? 0,
    });
    if (seq !== null) void acknowledge(conversationId, seq);
  }, [panelOpen, activeTab, selectedConversation, blocked, newestDisplayedSeq, statusReady, acknowledge]);

  // An explicit user gesture (message click / scroll-to-bottom) acknowledges
  // the newest displayed sequence even while a job is blocked.
  const acknowledgeExplicitly = useCallback(() => {
    const conversationId = selectedConversation;
    const current = messagesRef.current;
    if (!conversationId || current.length === 0) return;
    const newest = current[current.length - 1].seq;
    const seq = ackDecision({
      panelOpen,
      activeTab,
      conversationId,
      blocked,
      newestDisplayedSeq: newest,
      lastAckedSeq: lastAcked.current[conversationId] ?? 0,
      explicit: true,
    });
    if (seq !== null) void acknowledge(conversationId, seq);
  }, [selectedConversation, panelOpen, activeTab, blocked, acknowledge]);

  const sendMessage = useCallback(async (input: SendMessageInput) => {
    const response = await fetch("/api/polyforge/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: input.to,
        text: input.text,
        ...(input.aboutWi ? { about_wi: input.aboutWi } : {}),
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
    });
    const body = await response.json() as SendResponse;
    if (!response.ok || body.error) {
      throw new Error(body.error ?? "the message was refused");
    }
    const listBody = await refreshMessages();
    if (selectedConversation) {
      // Await the open conversation's refresh so the sent message (and a
      // reply's rendered quote) is in the history before the caller resolves.
      await refreshOpen(selectedConversation);
    } else {
      // A send from the list's new-message entry starts (or reuses) the direct
      // conversation; open the refreshed row so the sent message is visible.
      const rows = Array.isArray(listBody?.conversations) ? listBody.conversations : [];
      const match = rows.find((row) => row.peer === input.to);
      if (match) selectConversation(match.id);
    }
    return body.message ?? null;
  }, [refreshMessages, refreshOpen, selectedConversation, selectConversation]);

  const analyzeMessage = useCallback(async (messageId: string) => {
    const response = await fetch("/api/polyforge/messages/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: messageId }),
    });
    const body = await response.json() as AnalyzeResponse;
    if (!response.ok || body.error || !body.conclusion) {
      throw new Error(body.error ?? "the analyzer is unavailable");
    }
    // Transient only: component state, cleared when the dock closes.
    setAnalyses((previous) => ({ ...previous, [messageId]: body.conclusion as string }));
    return body.conclusion;
  }, []);

  // The conclusion is transient by construction: closing the dock drops it
  // (no localStorage/sessionStorage/disk write anywhere).
  useEffect(() => {
    if (!panelOpen) setAnalyses({});
  }, [panelOpen]);

  const setActiveTab = useCallback((tab: PolyforgeTab) => {
    setActiveTabState(tab);
    if (tab === "messages") void refreshMessages();
  }, [refreshMessages]);

  // A work-item anchor opens the existing Jobs detail through the existing
  // watch read (the shell's selectPolyforgeJob path).
  const openAnchor = useCallback((ref: string) => {
    setActiveTabState("jobs");
    select(ref);
  }, [select]);

  const unreadTotal = conversations.reduce((sum, conversation) => sum + conversation.unread, 0);
  const runningCount = opsStatus ? opsStatus.queue.running : null;

  return {
    pfPresent,
    opsStatus,
    opsError,
    runningCount,
    selectedWi,
    watchStatus,
    select,
    refreshStatus,
    activeTab,
    setActiveTab,
    messagesCapable,
    messagesReason,
    messagesError,
    conversations,
    unreadTotal,
    selectedConversation,
    selectConversation,
    messages,
    initialPageLoaded: selectedConversation !== null && initialPageLoaded === selectedConversation,
    blocked,
    hasOlder,
    loadingOlder,
    loadOlder,
    acknowledgeExplicitly,
    sendMessage,
    analyzeMessage,
    analyses,
    openAnchor,
  };
}
