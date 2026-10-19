"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PolyforgeOpsStatus, PolyforgeWatchStatus } from "@/lib/polyforge-status";

/**
 * Panel-facing client state for the Polyforge dock panel (pi#108).
 *
 * - One status fetch at mount decides presence (`pfPresent`); a pf-less
 *   install never polls again — the only HTTP it ever sees is that single
 *   2xx request, so unrelated e2e flows log no console errors.
 * - With pf present: the status route is polled every 3s while the panel is
 *   open and every 30s while closed (badge).
 * - While open with a selection: the watch route is polled every 3s. A null
 *   status (daemon blip, job gone) keeps the previous snapshot — the
 *   selection and its detail survive the job leaving the job list.
 */

const OPEN_STATUS_POLL_MS = 3000;
const CLOSED_STATUS_POLL_MS = 30000;
const OPEN_WATCH_POLL_MS = 3000;

type StatusResponse = { pfPresent?: boolean; status?: PolyforgeOpsStatus | null; error?: string };
type WatchResponse = { status?: PolyforgeWatchStatus | null; error?: string };

/** Keep the last snapshot when a watch response degrades to null (pure). */
export function nextWatchSnapshot(
  previous: PolyforgeWatchStatus | null,
  body: WatchResponse | null,
): PolyforgeWatchStatus | null {
  return body?.status ?? previous;
}

export function usePolyforge(panelOpen: boolean) {
  const [pfPresent, setPfPresent] = useState(false);
  const [probed, setProbed] = useState(false);
  const [opsStatus, setOpsStatus] = useState<PolyforgeOpsStatus | null>(null);
  const [opsError, setOpsError] = useState<string | null>(null);
  const [selectedWi, setSelectedWi] = useState<string | null>(null);
  const [watchStatus, setWatchStatus] = useState<PolyforgeWatchStatus | null>(null);
  const statusSeq = useRef(0);
  const watchSeq = useRef(0);

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
      })
      .catch(() => {
        if (seq !== statusSeq.current) return;
        setProbed(true);
        setOpsStatus(null);
        setOpsError("polyforge is unreachable");
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

  // Cadence: 3s open, 30s closed — only while pf is present.
  useEffect(() => {
    if (!probed || !pfPresent) return;
    const interval = setInterval(refreshStatus, panelOpen ? OPEN_STATUS_POLL_MS : CLOSED_STATUS_POLL_MS);
    return () => clearInterval(interval);
  }, [probed, pfPresent, panelOpen, refreshStatus]);

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

  const runningCount = opsStatus ? opsStatus.queue.running : null;

  return { pfPresent, opsStatus, opsError, runningCount, selectedWi, watchStatus, select, refreshStatus };
}
