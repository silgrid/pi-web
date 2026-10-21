"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Lazy per-surface polyforge chat-id fetch (pi#121): for each session id
 * that carries the display-only ` · <id>` tab-label suffix — a pane tab on
 * desktop, the current session on mobile — one request when the surface
 * first renders it, plus at most two bounded retries while the answer is
 * null. The retries exist because the first request races the tab's own
 * SSE attach: the wrapper registers in this server a moment after the tab
 * renders, and the memo's "a later render or refresh retries" covers
 * re-asking a null; a resolved id is never re-asked.
 *
 * Gated on pf presence (usePolyforge's mount probe): a pf-less install
 * issues NO request at all. The server answers 200 with `chatId: null`
 * for every absent case (not live, pf absent, daemon down, bad shape,
 * timeout), so there is no non-2xx console noise (mem_KsEwMtUw); a null
 * answer just renders no suffix.
 */

/** Bounded null-answer retries: the attach race closes within ~1 s. */
const RETRY_DELAYS_MS = [1000, 3000];

export function useSessionChatIds(
  pfPresent: boolean,
  sessionIds: readonly string[],
): Record<string, string> {
  const [chatIds, setChatIds] = useState<Record<string, string>>({});
  const stateRef = useRef<{
    requested: Set<string>;
    resolved: Set<string>;
    timers: ReturnType<typeof setTimeout>[];
  }>({ requested: new Set(), resolved: new Set(), timers: [] });

  useEffect(() => {
    if (!pfPresent) return;
    const { requested, resolved, timers } = stateRef.current;
    const request = async (id: string) => {
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/chat-id`, {
          cache: "no-store",
        });
        if (!response.ok) return;
        const body = (await response.json()) as { chatId?: unknown };
        if (typeof body.chatId === "string" && body.chatId) {
          resolved.add(id);
          setChatIds((prev) => ({ ...prev, [id]: body.chatId as string }));
        }
      } catch {
        // Network blip: absent, no suffix, no error surface.
      }
    };
    for (const id of sessionIds) {
      if (requested.has(id)) continue;
      requested.add(id);
      void request(id);
      for (const delay of RETRY_DELAYS_MS) {
        timers.push(setTimeout(() => {
          if (!resolved.has(id)) void request(id);
        }, delay));
      }
    }
  }, [pfPresent, sessionIds]);

  // Unmount-only cleanup: an effect re-run (a new session id, a presence
  // flip) must never cancel the earlier ids' still-pending retries.
  useEffect(() => () => {
    for (const timer of stateRef.current.timers) clearTimeout(timer);
  }, []);

  return chatIds;
}