"use client";

import { useCallback, useEffect, useState } from "react";
import type { PolyforgeEvent, PolyforgeJob, PolyforgeOpsStatus, PolyforgeWatchStatus } from "@/lib/polyforge-status";
import { useI18n } from "@/hooks/useI18n";

const STEP_STATUS_COLORS: Record<string, string> = {
  in_progress: "var(--accent)",
  done: "#16a34a",
  failed: "#dc2626",
  blocked: "#d97706",
  // pi#114: state the full contract — pending/cancelled are gray explicitly;
  // unknown statuses keep the same gray via the fallback in stepNodeColor.
  pending: "var(--text-dim)",
  cancelled: "var(--text-dim)",
};

const CANDIDATE_MAX = 24;

/** Candidate shortening (assumption 1): >24 chars ⇒ first 24 + `…`, client-side. */
export function shortenCandidate(candidate: string): string {
  return candidate.length > CANDIDATE_MAX ? candidate.slice(0, CANDIDATE_MAX) + "…" : candidate;
}

/** Age in seconds → compact duration (7325 → "2h 2m"). */
export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// Known labels get a translated string; unknown values pass through raw
// (never a missing i18n key — no raw `polyforge.*` text can reach the UI).
const JOB_STATUS_KEYS = new Set(["running", "needs_input", "queued", "completed", "failed", "cancelled"]);
const STEP_STATUS_KEYS = new Set(["done", "in_progress", "pending", "failed", "blocked", "cancelled"]);
const WORKFLOW_STATUS_KEYS = new Set(["running", "needs_input", "queued", "completed", "blocked", "failed", "cancelled", "done"]);
const EVENT_KIND_KEYS = new Set([
  "published", "transcript_missing", "exec_init", "step_started", "step_done",
  "step_failed", "step_dead", "candidate_switched", "needs_input", "answered",
  "gate_verdict", "rewind", "envelope_rejected", "needs_recovery", "push_failed",
  "job_started", "job_stopped", "terminal", "authored_tests_rebaselined",
]);
const EVENT_ARROW_KINDS = new Set(["candidate_switched", "rewind"]);

/** Severity colours (pi#112): amber needs_input; red failure kinds; green
 *  terminal completed; terminal cancelled and everything else neutral. */
const EVENT_SEVERITY_COLORS: Record<string, string> = {
  amber: "#d97706",
  red: "#dc2626",
  green: "#16a34a",
};

/** Global (browser-wide) storage key for the event tail display mode. */
const EVENT_MODE_STORAGE_KEY = "pi-web:polyforge-event-mode";

type EventMode = "simple" | "verbose";

export type PolyforgeTailRow =
  | { noise: true; count: number }
  | { noise: false; event: PolyforgeEvent };

const EVENT_NOISE_KINDS = new Set(["published", "transcript_missing", "exec_init"]);

/** Collapse each consecutive run of noise events into a single
 *  `{ noise: true, count }` marker (N≥1 uniform). Meaningful events are
 *  never collapsed. Pure helper, no I/O. */
export function collapseNoiseRuns(events: PolyforgeEvent[]): PolyforgeTailRow[] {
  const noise = EVENT_NOISE_KINDS;
  const rows: PolyforgeTailRow[] = [];
  for (const event of events) {
    const last = rows[rows.length - 1];
    if (noise.has(event.kind)) {
      if (last && last.noise) last.count += 1;
      else rows.push({ noise: true, count: 1 });
    } else {
      rows.push({ noise: false, event });
    }
  }
  return rows;
}

/** Severity emphasis per kind (pi#112): amber needs_input; red failure kinds;
 *  green terminal completed; terminal cancelled and everything else neutral. */
export function eventSeverity(event: { kind: string; status?: string }): "amber" | "red" | "green" | null {
  if (event.kind === "needs_input") return "amber";
  if (event.kind === "terminal") {
    if (event.status === "completed") return "green";
    if (event.status === "failed") return "red";
    return null;
  }
  if (
    event.kind === "step_failed"
    || event.kind === "step_dead"
    || event.kind === "push_failed"
    || event.kind === "envelope_rejected"
    || event.kind === "needs_recovery"
  ) {
    return "red";
  }
  return null;
}

/** Whitelisted field values of an event, in display order (untruncated). */
export function eventValueParts(event: PolyforgeEvent): (string | undefined)[] {
  switch (event.kind) {
    case "step_started":
      return [event.step, event.model];
    case "candidate_switched":
      return [event.step, event.from, event.to];
    case "step_failed":
    case "step_dead":
      return [event.step, event.cause];
    case "rewind":
      return [event.gate, event.target];
    case "terminal":
      return [event.status];
    default:
      return [event.step];
  }
}

/** Row display text: whitelisted values, each ellipsized at 24 chars. Arrow
 *  kinds pair their last two fields with `→` (`from → to`, `gate → target`);
 *  any leading field (`candidate_switched`'s step) joins with `·`, e.g.
 *  `alpha-plan · pi:old → claude:new`. */
export function formatEventValues(event: PolyforgeEvent): string {
  const shown = eventValueParts(event).filter((v): v is string => !!v).map(shortenCandidate);
  if (!EVENT_ARROW_KINDS.has(event.kind)) return shown.join(" · ");
  const head = shown.slice(0, -2).join(" · ");
  const tail = shown.slice(-2).join(" → ");
  return head ? `${head} · ${tail}` : tail;
}

/** Node colour for the step flow graph (pi#114, R6): status colour from the
 *  explicit map; unknown statuses read gray, never a missing entry. */
export function stepNodeColor(status: string): string {
  return STEP_STATUS_COLORS[status] ?? "var(--text-dim)";
}

export interface StepGraph {
  nodes: { id: string; status: string }[];
  sequenceEdges: [string, string][];
  rewindEdges: [string, string][];
}

/** Flow-graph model for the step display (pi#114, R2–R5). Pure: no I/O, no
 *  throw, so a malformed snapshot degrades silently instead of surfacing an
 *  error.
 *  - `declaredSteps` present: nodes follow declaration order; declared ids
 *    missing from `steps` become pending gray placeholders; steps absent from
 *    the declaration are appended in started-at fallback order (the order
 *    `steps` already carries) with no sequence edges.
 *  - `declaredSteps` null (absent/malformed/empty): nodes follow the
 *    started-at fallback order of `steps`; the started segment is the prefix of
 *    steps up to and including the LAST node whose status is not 'pending',
 *    and sequence edges join every consecutive pair inside that prefix, so
 *    never-started (always pending) steps trail unedged.
 *    Basis: pf stamps `step_started_at` on claim (transition.go ~293-309), so a
 *    step that never started is always pending; but a rewind
 *    (applyRewindRangeLocked) resets [target, gate) to 'pending' while keeping
 *    `step_started_at`, so pending steps can sit inside the started segment —
 *    testing pairs individually would wrongly break the chain around them.
 *  - Rewind edges: only tail `rewind` events whose gate AND target are both
 *    nodes, one edge per distinct gate→target pair. `on_fail` targets are
 *    not nodes in this model, so they can never be drawn. */
export function buildStepGraph(
  steps: { name: string; status: string }[],
  declaredSteps: { id: string }[] | null,
  events: { kind: string; gate?: string; target?: string }[],
): StepGraph {
  const statusByName = new Map(steps.map((step) => [step.name, step.status]));
  const sequenceEdges: [string, string][] = [];
  let nodes: { id: string; status: string }[];
  if (declaredSteps && declaredSteps.length > 0) {
    nodes = declaredSteps.map(({ id }) => ({ id, status: statusByName.get(id) ?? "pending" }));
    const declared = new Set(declaredSteps.map(({ id }) => id));
    for (const step of steps) {
      if (!declared.has(step.name)) nodes.push({ id: step.name, status: step.status });
    }
    for (let i = 1; i < declaredSteps.length; i++) {
      sequenceEdges.push([declaredSteps[i - 1].id, declaredSteps[i].id]);
    }
  } else {
    nodes = steps.map((step) => ({ id: step.name, status: step.status }));
    // Started segment = prefix up to and including the LAST non-pending node.
    // pf rewinds reset [target, gate) to 'pending' while keeping started_at, so
    // pending steps can sit inside the started segment; edge the whole prefix
    // and leave the trailing never-started steps unedged.
    let lastStarted = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].status !== "pending") lastStarted = i;
    }
    for (let i = 1; i <= lastStarted; i++) {
      sequenceEdges.push([nodes[i - 1].id, nodes[i].id]);
    }
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const rewindEdges: [string, string][] = [];
  const seenRewinds = new Set<string>();
  for (const event of events) {
    if (event.kind !== "rewind" || !event.gate || !event.target) continue;
    if (!nodeIds.has(event.gate) || !nodeIds.has(event.target)) continue;
    const key = `${event.gate}\u0000${event.target}`;
    if (seenRewinds.has(key)) continue;
    seenRewinds.add(key);
    rewindEdges.push([event.gate, event.target]);
  }
  return { nodes, sequenceEdges, rewindEdges };
}

/** Per-step timing model (pi#117). `durationSec` is null when the step
 *  shows no duration: a done step's duration is its started_at → the NEXT
 *  started step's started_at (null when nothing started after it), the
 *  in_progress step's is the live age since its started_at, and every other
 *  started status (failed, blocked, …) shows started_at only. Never-started
 *  steps carry no entry at all. Pure: no I/O, no throw — an unparseable
 *  started_at degrades that step to no timing. */
export interface StepTiming {
  startedAt: string;
  durationSec: number | null;
}

export function buildStepTimings(
  steps: { name: string; status: string; startedAt?: string }[],
  now: number,
): Map<string, StepTiming> {
  const timings = new Map<string, StepTiming>();
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step.startedAt) continue;
    const ownMs = Date.parse(step.startedAt);
    if (!Number.isFinite(ownMs)) continue;
    let durationSec: number | null = null;
    if (step.status === "in_progress") {
      durationSec = Math.max(0, Math.round((now - ownMs) / 1000));
    } else if (step.status === "done") {
      // steps arrive in execution order (started by started_at ascending),
      // so the next array entry, when started, is the next started step.
      const next = steps[i + 1];
      if (next?.startedAt) {
        const nextMs = Date.parse(next.startedAt);
        if (Number.isFinite(nextMs)) {
          const diffSec = Math.round((nextMs - ownMs) / 1000);
          if (diffSec >= 0) durationSec = diffSec;
        }
      }
    }
    timings.set(step.name, { startedAt: step.startedAt, durationSec });
  }
  return timings;
}

/** Live per-step timing for the current snapshot (pi#117): the
 *  in_progress age reads the clock at render — the module-level helper
 *  follows BackgroundTasksPanel.formatDuration's clock-at-render pattern —
 *  and the 3 s watch poll re-renders the panel, so the age stays live
 *  without a dedicated timer. */
function liveStepTimings(steps: { name: string; status: string; startedAt?: string }[]): Map<string, StepTiming> {
  return buildStepTimings(steps, Date.now());
}

export function PolyforgePanel({
  opsStatus,
  opsError,
  watchStatus,
  selectedWi,
  onSelect,
  onClose,
  onRefresh,
}: {
  opsStatus: PolyforgeOpsStatus | null;
  opsError: string | null;
  watchStatus: PolyforgeWatchStatus | null;
  selectedWi: string | null;
  onSelect: (wi: string | null) => void;
  onClose: () => void;
  // May return the status fetch's settle promise (usePolyforge.refreshStatus
  // does); the manual-refresh feedback (pi#113) awaits it.
  onRefresh: () => void | Promise<void>;
}) {
  const { t, locale } = useI18n();

  // Event tail display mode (pi#112): defaults to simple; the stored global
  // preference is read in a mount effect because window is unavailable at
  // first render (client components still SSR).
  const [eventMode, setEventMode] = useState<EventMode>("simple");
  useEffect(() => {
    try {
      if (window.localStorage.getItem(EVENT_MODE_STORAGE_KEY) === "verbose") setEventMode("verbose");
    } catch {
      // storage unavailable — keep the default
    }
  }, []);
  // Client-side only: no fetch/network I/O on toggle.
  const toggleEventMode = useCallback(() => {
    const next: EventMode = eventMode === "simple" ? "verbose" : "simple";
    setEventMode(next);
    try {
      window.localStorage.setItem(EVENT_MODE_STORAGE_KEY, next);
    } catch {
      // best effort persistence
    }
  }, [eventMode]);

  // Manual-refresh in-flight feedback (pi#113): the icon spins and the button
  // disables until the status fetch settles, floored at ~400 ms so a fast
  // response still reads as feedback (an explicit UX floor, not
  // synchronization). Failure settles the same way — the panel's existing
  // error text is the only error signal. Background polls call the hook's
  // refreshStatus directly and never touch this state.
  const [refreshBusy, setRefreshBusy] = useState(false);
  const handleRefresh = useCallback(() => {
    if (refreshBusy) return;
    setRefreshBusy(true);
    const settled = Promise.resolve(onRefresh()).catch(() => undefined);
    const floor = new Promise<void>((resolve) => { setTimeout(resolve, 400); });
    void Promise.all([settled, floor]).then(() => setRefreshBusy(false));
  }, [refreshBusy, onRefresh]);

  const jobStatusLabel = useCallback((status: string) => (
    JOB_STATUS_KEYS.has(status) ? t(`polyforge.jobStatus.${status}`) : status
  ), [t]);
  const workflowStatusLabel = useCallback((status: string) => (
    WORKFLOW_STATUS_KEYS.has(status) ? t(`polyforge.workflowStatus.${status}`) : status
  ), [t]);
  const stepStatusLabel = useCallback((status: string) => (
    STEP_STATUS_KEYS.has(status) ? t(`polyforge.stepStatus.${status}`) : status
  ), [t]);
  const eventKindLabel = useCallback((kind: string) => (
    EVENT_KIND_KEYS.has(kind) ? t(`polyforge.eventKind.${kind}`) : kind
  ), [t]);

  const formatEventTime = useCallback((at: string) => {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return at;
    try {
      return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
    } catch {
      return at;
    }
  }, [locale]);

  const renderEventRow = useCallback((event: PolyforgeEvent, index: number) => {
    const severity = eventSeverity(event);
    const noise = EVENT_NOISE_KINDS.has(event.kind);
    const parts = eventValueParts(event).filter((v): v is string => !!v);
    const displayText = formatEventValues(event);
    const titleText = [event.kind, ...parts].join(" ");
    return (
      <div
        key={`${event.at}-${event.kind}-${index}`}
        title={titleText}
        style={{ display: "flex", gap: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: severity ? EVENT_SEVERITY_COLORS[severity] : noise ? "var(--text-dim)" : "var(--text-muted)" }}
      >
        <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{formatEventTime(event.at)}</span>
        <span style={{ flexShrink: 0 }}>{eventKindLabel(event.kind)}</span>
        {displayText && <span style={{ overflow: "hidden", textOverflow: "ellipsis", color: !severity && !noise ? "var(--text)" : undefined }}>{displayText}</span>}
        {eventMode === "verbose" && EVENT_KIND_KEYS.has(event.kind) && (
          <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{event.kind}</span>
        )}
      </div>
    );
  }, [eventMode, formatEventTime, eventKindLabel]);

  // Step flow graph (pi#114): derived from the sanitized watch snapshot.
  // Null exactly when watchStatus is null (the detail section's loading state).
  const graph = watchStatus
    ? buildStepGraph(watchStatus.steps, watchStatus.declared_steps, watchStatus.events)
    : null;

  // pi#117 detail rows: live progress, per-step timing and the chat origin —
  // display-only, each absent piece renders nothing (no placeholder).
  const progress = watchStatus?.progress;
  const origin = watchStatus?.origin;
  // pi#119 summary block: the summarize lane's narration. Every field is
  // already absent when missing or malformed server-side (the sanitizer
  // guarantees it), so the block renders only when at least one is present;
  // the 3s watch poll refreshes the age like command_age_sec — no
  // client-side ticking between polls (a non-goal).
  const summary = watchStatus?.summary;
  const summaryAgeSec = watchStatus?.summary_age_sec;
  const summaryError = watchStatus?.summary_error;
  const summaryCapped = watchStatus?.summary_capped;
  const summaryVisible = Boolean(summary || summaryError || summaryCapped);
  // The in_progress live age is computed at render from `now`; the watch
  // poll re-renders every 3s while the panel is open with a selection, so the
  // age stays live without a dedicated timer.
  const stepTimings = watchStatus ? liveStepTimings(watchStatus.steps) : null;
  const originHasText = Boolean(origin?.chat_id || origin?.owner);
  const detailInfoVisible = Boolean(progress?.command)
    || progress?.tool_calls != null
    || Boolean(progress?.recent_files)
    || (stepTimings?.size ?? 0) > 0
    || originHasText;

  const jobs = opsStatus?.jobs ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }} role="complementary" aria-label={t("polyforge.title")}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>{t("polyforge.title")}</span>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshBusy}
          title={t("polyforge.refresh")}
          aria-label={t("polyforge.refresh")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, background: "none", border: "none", color: "var(--text-muted)", cursor: refreshBusy ? "default" : "pointer", fontSize: 14 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={refreshBusy ? { animation: "spin 0.8s linear infinite" } : undefined}>
            <path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onClose}
          title={t("polyforge.close")}
          aria-label={t("polyforge.close")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {opsStatus ? (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {/* Queue line + job list */}
            <div style={{ maxHeight: "45%", overflowY: "auto", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 11, color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                <span>{t("polyforge.queue")}</span>
                <span style={{ fontWeight: 600, color: "var(--text)" }}>
                  {opsStatus.queue.running} / {opsStatus.queue.max}
                </span>
              </div>
              {jobs.length === 0 && (
                <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.empty")}</div>
              )}
              {jobs.map((job: PolyforgeJob) => (
                <div
                  key={job.wi || job.slug}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(selectedWi === job.slug ? null : job.slug)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(selectedWi === job.slug ? null : job.slug);
                    }
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 12px",
                    cursor: "pointer", fontSize: 12,
                    background: selectedWi === job.slug ? "var(--bg-selected)" : "none",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
                      {job.slug}
                    </span>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 11 }}>
                      {jobStatusLabel(job.status)} · #{job.spawnN}
                    </span>
                  </span>
                  <span style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, fontSize: 11, color: "var(--text-dim)", textAlign: "right" }}>
                    <span title={job.candidate} style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono, monospace)" }}>
                      {shortenCandidate(job.candidate)}
                    </span>
                    <span>
                      {formatAge(job.stepAgeSec)} {t("polyforge.stepAge")} · {formatAge(job.idleAgeSec)} {t("polyforge.idleAge")}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            {/* Detail for the selected work item */}
            {/* pi#120: with a job selected, the whole detail — header,
                graph, summary, detail rows, toggle and event tail — is ONE
                vertical scroll region (this container). No nested vertical
                scroller exists inside it, so every row is reachable by
                scrolling at any sheet height and in the desktop dock — the
                old layout stacked the blocks as non-shrinking children of
                an overflow-hidden column and clipped everything below the
                fold once the fixed blocks exceeded the leftover height
                (the tail collapsed to zero). */}
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
              {selectedWi ? (
                  <>
                    {/* Detail header with an explicit deselect control: the only
                        reliable gesture once the selected job has left the list
                        (the row that could toggle it off is gone) or while its
                        watch snapshot is still loading. */}
                    <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--text-dim)", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => onSelect(null)}
                        title={t("polyforge.deselect")}
                        aria-label={t("polyforge.deselect")}
                        style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 22, height: 22, padding: 0, background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M15 18l-6-6 6-6" />
                        </svg>
                      </button>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, flex: 1, minWidth: 0 }}>
                        {watchStatus?.slug ?? selectedWi}
                        {watchStatus && <> · {workflowStatusLabel(watchStatus.workflowStatus)}</>}
                      </span>
                      {watchStatus?.updatedAt && (
                        <span style={{ flexShrink: 0 }}>{t("polyforge.updatedAt")}: {formatEventTime(watchStatus.updatedAt)}</span>
                      )}
                      {watchStatus?.currentStep && (
                        <span style={{ flexShrink: 0 }}>{t("polyforge.currentStep")}: {watchStatus.currentStep}</span>
                      )}
                    </div>
                    {watchStatus ? (
                      <>
                        {/* Step flow graph (pi#114): display-only nodes with
                            status dots, solid sequence connectors between
                            consecutive nodes, dashed rewind chips below.
                            Nodes wrap; the container never scrolls. */}
                        {graph && (
                        <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0, overflow: "hidden" }}>
                          <div role="list" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: 6 }}>
                            {graph.nodes.map((node, index) => (
                              <span key={`${node.id}-${index}`} style={{ display: "inline-flex", alignItems: "center" }}>
                                {/* Connector only for pairs the model actually
                                    edges: started-only in fallback (G5), and
                                    declared-consecutive pairs only (G6). */}
                                {index > 0 &&
                                  graph.sequenceEdges.some(
                                    ([from, to]) => from === graph.nodes[index - 1].id && to === node.id,
                                  ) && (
                                  <span aria-hidden="true" style={{ color: "var(--text-dim)", fontSize: 10, padding: "0 3px", flexShrink: 0 }}>
                                    →
                                  </span>
                                )}
                                <span
                                  role="listitem"
                                  title={`${node.id} · ${stepStatusLabel(node.status)}`}
                                  aria-label={`${node.id} · ${stepStatusLabel(node.status)}`}
                                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 11, color: "var(--text)", fontFamily: "var(--font-mono, monospace)" }}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={node.status === "in_progress" ? "pf-step-node-pulse" : undefined}
                                    style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: stepNodeColor(node.status) }}
                                  />
                                  {shortenCandidate(node.id)}
                                </span>
                              </span>
                            ))}
                          </div>
                          {graph.rewindEdges.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, paddingTop: 4 }}>
                              {graph.rewindEdges.map(([gate, target]) => (
                                <span
                                  key={`${gate}->${target}`}
                                  title={`${eventKindLabel("rewind")}: ${gate} → ${target}`}
                                  aria-label={`${eventKindLabel("rewind")}: ${gate} → ${target}`}
                                  style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 6px", borderRadius: 6, border: "1px dashed var(--border)", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)" }}
                                >
                                  <span aria-hidden="true">⇢</span>
                                  {`${shortenCandidate(gate)} → ${shortenCandidate(target)}`}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        )}
                        {/* pi#119 summary block: the summarize lane's
                            narration — the line, its age (formatted like
                            command_age_sec), a cap-reached marker and the
                            raw error line, which may show together with an
                            older summary. The whole block is absent when
                            the snapshot carries none of the four fields:
                            no heading, placeholder or loading text. */}
                        {summaryVisible && (
                        <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 2, fontSize: 11 }}>
                          {summary && (
                            <>
                              <span style={{ color: "var(--text-dim)" }}>
                                {t("polyforge.summary")}{summaryAgeSec != null ? ` · ${formatAge(summaryAgeSec)}` : ""}
                              </span>
                              <span style={{ color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{summary}</span>
                            </>
                          )}
                          {summaryCapped && (
                            <span style={{ color: "#d97706" }}>{t("polyforge.summaryCapped")}</span>
                          )}
                          {summaryError && (
                            <span style={{ color: "#dc2626", fontFamily: "var(--font-mono, monospace)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{summaryError}</span>
                          )}
                        </div>
                        )}
                        {/* pi#117 detail rows: command (+age), tool calls,
                            recent files, per-step timing, chat origin.
                            Display-only; the whole block is absent when the
                            snapshot carries none of it. */}
                        {detailInfoVisible && (
                        <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 4, fontSize: 11 }}>
                          {progress?.command && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              <span style={{ color: "var(--text-dim)" }}>
                                {t("polyforge.command")}{progress.command_age_sec != null ? ` · ${formatAge(progress.command_age_sec)}` : ""}
                              </span>
                              <span
                                title={progress.command}
                                style={{ color: "var(--text)", fontFamily: "var(--font-mono, monospace)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                              >
                                {progress.command}
                              </span>
                            </div>
                          )}
                          {progress?.tool_calls != null && (
                            <div style={{ display: "flex", gap: 6 }}>
                              <span style={{ color: "var(--text-dim)" }}>{t("polyforge.toolCalls")}</span>
                              <span style={{ color: "var(--text)" }}>{progress.tool_calls}</span>
                            </div>
                          )}
                          {progress?.recent_files && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              <span style={{ color: "var(--text-dim)" }}>{t("polyforge.recentFiles")}</span>
                              {progress.recent_files.map((file) => (
                                <span
                                  key={file}
                                  title={file}
                                  style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                >
                                  {file}
                                </span>
                              ))}
                            </div>
                          )}
                          {stepTimings && stepTimings.size > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              <span style={{ color: "var(--text-dim)" }}>{t("polyforge.stepTiming")}</span>
                              {watchStatus.steps.map((step) => {
                                // Never-started steps show no timing row.
                                const timing = stepTimings.get(step.name);
                                if (!timing) return null;
                                return (
                                  <div
                                    key={step.name}
                                    title={`${step.name} · ${timing.startedAt}`}
                                    style={{ display: "flex", gap: 6 }}
                                  >
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono, monospace)", color: "var(--text-dim)" }}>
                                      {shortenCandidate(step.name)}
                                    </span>
                                    <span style={{ flexShrink: 0, fontFamily: "var(--font-mono, monospace)", color: "var(--text-dim)" }}>
                                      {formatEventTime(timing.startedAt)}
                                    </span>
                                    {timing.durationSec != null && (
                                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono, monospace)", color: "var(--text-dim)" }}>
                                        +{formatAge(timing.durationSec)}
                                      </span>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          {originHasText && origin && (
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <span style={{ color: "var(--text-dim)" }}>{t("polyforge.origin")}</span>
                              {origin.chat_id && (
                                <span title={origin.chat_id} style={{ color: "var(--text)", fontFamily: "var(--font-mono, monospace)" }}>
                                  {shortenCandidate(origin.chat_id)}
                                </span>
                              )}
                              {origin.owner && <span style={{ color: "var(--text)" }}>{origin.owner}</span>}
                            </div>
                          )}
                        </div>
                        )}
                        {/* Event tail (newest last) */}
                        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", padding: "2px 12px 0" }}>
                          <button
                            type="button"
                            onClick={toggleEventMode}
                            style={{ display: "flex", alignItems: "center", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 8px" }}
                          >
                            {t(eventMode === "simple" ? "polyforge.eventMode.verbose" : "polyforge.eventMode.simple")}
                          </button>
                        </div>
                        {/* Event tail (newest last): the rows are plain
                            blocks inside the detail's scroll region (pi#120),
                            not their own scroller. */}
                        <div style={{ flexShrink: 0, padding: "6px 12px", fontSize: 11, lineHeight: 1.45, fontFamily: "var(--font-mono, monospace)" }}>
                          {watchStatus.events.length === 0 && (
                            <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-sans, sans-serif)" }}>{t("polyforge.emptyEvents")}</div>
                          )}
                          {eventMode === "verbose"
                            ? watchStatus.events.map((event, index) => renderEventRow(event, index))
                            : collapseNoiseRuns(watchStatus.events).map((row, index) =>
                                row.noise ? (
                                  <div
                                    key={`sync-${index}`}
                                    style={{ display: "flex", gap: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-dim)" }}
                                  >
                                    <span>
                                      {t("polyforge.eventSync")} ×{row.count}
                                    </span>
                                  </div>
                                ) : (
                                  renderEventRow(row.event, index)
                                ),
                              )}
                        </div>
                      </>
                    ) : (
                      <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.loading")}</div>
                    )}
                  </>
                ) : (
                <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.selectJob")}</div>
              )}
            </div>
          </div>
        ) : opsError ? (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.unavailable")}</div>
        ) : (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.loading")}</div>
        )}
      </div>
    </div>
  );
}
