"use client";

import { useEffect, useState } from "react";
import { isPolyforgeWorkItemId, nextProgressTail, type PolyforgeProgressTail } from "@/lib/polyforge-cards-pure";

/** The fixed progress poll interval: no setting, no stored value, never the
 *  card poll interval. */
export const PROGRESS_POLL_MS = 2000;
/** One request's bound: a read that never settles is aborted, keeps the last
 *  good tail and frees the in-flight slot ('s frozen-poll lesson). */
export const PROGRESS_REQUEST_TIMEOUT_MS = 5000;
const PROGRESS_URL = "/api/polyforge/progress";

/**
 * The selected job's execution progress, for the Jobs
 * detail only: the panel's detail mounts the component that calls this hook
 * while a job is selected, so closing the dock or deselecting unmounts it
 * and stops everything. Modeled on useMachineLoad (/#166).
 *
 * - `wi` is the selected job's work-item id (a card click stores the slug,
 *   so the caller passes the selected job's `wi`); null or a non-id reads
 *   nothing. A different `wi` never shows the previous job's tail.
 * - `running`: an immediate read, then one every PROGRESS_POLL_MS while the
 *   page is visible. Not running: exactly one read, no interval.
 * - Hidden page: the interval is cleared and the request in flight aborted
 *   at once (zero requests while hidden); becoming visible reads at once.
 * - At most one request in flight, each bounded by PROGRESS_REQUEST_TIMEOUT_MS.
 * - A failed or degraded read keeps the last good tail (nextProgressTail);
 *   a usable read replaces it wholesale. Null until the first answer.
 */
export function usePolyforgeProgress(wi: string | null, running: boolean): PolyforgeProgressTail | null {
  const [state, setState] = useState<{ wi: string; tail: PolyforgeProgressTail | null } | null>(null);

  useEffect(() => {
    if (!isPolyforgeWorkItemId(wi)) return;
    let active = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    let inFlight: AbortController | null = null;
    let readOnce = false;

    const poll = async () => {
      if (!active || inFlight || document.visibilityState !== "visible") return;
      const controller = new AbortController();
      inFlight = controller;
      readOnce = true;
      const timer = setTimeout(() => controller.abort(), PROGRESS_REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${PROGRESS_URL}?wi=${encodeURIComponent(wi)}`, { cache: "no-store", signal: controller.signal });
        const body: unknown = response.ok ? await response.json() : null;
        if (active && !controller.signal.aborted) {
          setState((previous) => {
            const held = previous?.wi === wi ? previous.tail : null;
            const tail = nextProgressTail(held, body);
            return tail === held && previous?.wi === wi ? previous : { wi, tail };
          });
        }
      } catch {
        // Network error, abort or a non-JSON body: keep the last good tail.
      } finally {
        clearTimeout(timer);
        if (inFlight === controller) inFlight = null;
      }
    };
    const stop = () => {
      if (interval !== null) clearInterval(interval);
      interval = null;
      inFlight?.abort();
      inFlight = null;
    };
    const start = () => {
      stop();
      if (!active || document.visibilityState !== "visible") return;
      if (running) {
        void poll();
        interval = setInterval(() => void poll(), PROGRESS_POLL_MS);
      } else if (!readOnce) {
        void poll();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    // One microtask late, as useMachineLoad: Strict Mode's mount → cleanup →
    // mount issues one first request, not an aborted duplicate.
    queueMicrotask(start);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [wi, running]);

  return state && state.wi === wi ? state.tail : null;
}
