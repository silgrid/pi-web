"use client";

import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import type { PolyforgeEvent, PolyforgeJob, PolyforgeOpsStatus, PolyforgeWatchStatus } from "@/lib/polyforge-status";
import {
  cardRunningMinutes,
  formatCardDuration,
  polyforgeCardKey,
  shortJobTitle,
  truncateCardTitle,
  type PolyforgeCard,
} from "@/lib/polyforge-cards-pure";
import { POLYFORGE_BLOCK_STYLE } from "@/lib/panel-layout";
import { usePolyforgePanelPreferences } from "@/hooks/usePolyforgePanelPreferences";
import type { PolyforgeContact, PolyforgeConversation, PolyforgeMessage, PolyforgeProjectGroup } from "@/lib/polyforge-messages-pure";
import type { PolyforgeTab, PolyforgeWorkTab } from "@/hooks/usePolyforge";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePolyforgeProgress } from "@/hooks/usePolyforgeProgress";
import { PolyforgeMessages } from "./PolyforgeMessages";
import { PolyforgeMemory } from "./PolyforgeMemory";
import { PolyforgeTasks } from "./PolyforgeTasks";
import { PolyforgeWorkItems } from "./PolyforgeWorkItems";
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
const JOB_STATUS_KEYS = new Set(["running", "needs_input", "paused", "queued", "completed", "failed", "cancelled"]);
const STEP_STATUS_KEYS = new Set(["done", "in_progress", "pending", "failed", "blocked", "cancelled", "skipped"]);
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

/** A status job shown before the first card read: the slug and status
 *  from the status poll (the needs-input marker included), no goal, no
 *  steps, no narration (the card renders none), and whether
 *  the card read is unavailable. */
function statusOnlyCard(job: PolyforgeJob, available: boolean): PolyforgeCard {
  return { job, steps: [], progress: { available, entries: [] } };
}

/**
 * The job detail's execution progress: a heading, then the
 * selected job's current-step tail — one nowrap/ellipsized line per entry,
 * newest last, the full text on hover — inline in the detail's one scroll
 * region (no overflowY of its own, pi#120). The localized loading, empty
 * and unavailable states; a failed or degraded read keeps the last good
 * tail without an error readout (usePolyforgeProgress). Mounted only while
 * the Jobs detail of a selected job renders, so deselecting or closing the
 * dock stops its reads.
 */
function PolyforgeDetailProgress({ wi, running }: { wi: string | null; running: boolean }) {
  const { t } = useI18n();
  const tail = usePolyforgeProgress(wi, running);
  const message = !wi || tail?.available === false ? t("polyforge.progress.unavailable")
    : !tail ? t("polyforge.loading")
      : tail.entries.length === 0 ? t("polyforge.progress.empty") : null;
  return (
    <div data-pf-progress="" style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", flexDirection: "column", gap: 2, fontSize: 11, lineHeight: "16px", minWidth: 0 }}>
      <span style={{ color: "var(--text-dim)" }}>{t("polyforge.progress.title")}</span>
      {!tail || message !== null ? (
        <span style={{ color: "var(--text-dim)" }}>{message}</span>
      ) : tail.entries.map((entry) => (
        <div
          key={entry.id}
          data-pf-progress-kind={entry.kind}
          title={entry.text}
          style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0,
            ...(entry.kind === "tool" ? { color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)" } : { color: "var(--text)" }) }}
        >
          {entry.text}
        </div>
      ))}
    </div>
  );
}

/** Job card width: the 150px the Tasks blocks' column minimum shares
 *, fixed rather than stretched. */
const JOB_CARD_WIDTH = 150;

/**
 * One Jobs card (compact card) in the shared
 * block style, one fixed-width item of the single card row (; a
 * grid cell until then): the slug (wrapping) with
 * the small status label at the right end of its row, for a
 * `needs_input` job the emphasized 等待输入 marker there instead of the dim
 * label; the truncated goal under them (at most 2 lines). No narration on the
 * card ( removed the 32px scroller added; the
 * assistant narration stays in the job detail's execution progress and
 * summary). No step information on the card: the DAG, per-step durations and
 * reruns, model and step/idle age live in the job detail.
 * Keyed by wi in the stream and memoized, so a poll updates the same DOM node
 * (a trusted click never lands on a replaced one). Clicking (or Enter/Space)
 * toggles the existing slug selection and its detail. A status-only stand-in
 * (before the first card read) has no select handler and takes no pointer
 *: the first card read may reorder the stream once (server
 * start order replaces `pf ops status` order), and a click in that window
 * could otherwise land on a neighbouring job.
 *
 * (owner's intentional change, not a regression): the card is
 * denser — a 4px outer column gap, explicit 16px lines for the slug row and
 * the goal span (the inherited 18px inflated them), the needs-input badge at
 * padding 0 5px / line-height 14px and the dim status label at 16px, plus the
 * shared block padding 6px 8px. A 1-line slug + 2-line goal card was 100px.
 *
 * (owner's intentional change, reversing the
 * narration): the card-only vertical padding drops to 4px (left/right stay
 * 8px) and the slug/goal gap to 0, so a card with a goal is 42px + its slug
 * row — 58px with a 1-line slug, 74px with a 2-line one. A `running` job's
 * label carries the job's age in whole minutes (`运行中 23m`), from the card's
 * existing earliest `job_started`, advanced by a local render clock and no
 * request.
 */
const PolyforgeJobCard = memo(function PolyforgeJobCard({
  card,
  pending,
  selected,
  titleLength,
  onSelect,
}: {
  card: PolyforgeCard;
  /** A status-only stand-in before the first card read: no card identity yet. */
  pending: boolean;
  selected: boolean;
  titleLength: number;
  onSelect: (wi: string | null) => void;
}) {
  const { t } = useI18n();
  const { job, goal } = card;
  const jobStatusLabel = (status: string) => (JOB_STATUS_KEYS.has(status) ? t(`polyforge.jobStatus.${status}`) : status);
  const needsInput = job.status === "needs_input";
  const running = job.status === "running";
  // a local render clock for the running age — it reads
  // `Date.now()` and fetches nothing (the Tasks blocks' pattern); a 30s tick
  // keeps the label within half a minute of the wall clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(clock);
  }, [running]);
  const runningMinutes = running ? cardRunningMinutes(card.startedAt, now) : null;
  const baseStatusLabel = jobStatusLabel(job.status);
  // Only a running job carries the age; a missing/unparsable `startedAt`
  // keeps the bare label.
  const statusLabel = runningMinutes === null ? baseStatusLabel : `${baseStatusLabel} ${runningMinutes}m`;

  const toggle = () => onSelect(selected ? null : job.slug);
  return (
    <div
      data-pf-card={pending ? undefined : ""}
      data-pf-card-wi={pending ? undefined : polyforgeCardKey(card)}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${job.slug} · ${statusLabel}`}
      aria-disabled={pending || undefined}
      onClick={pending ? undefined : toggle}
      onKeyDown={pending ? undefined : (event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      }}
      style={{
        ...POLYFORGE_BLOCK_STYLE,
        // a fixed 150px cell of the one horizontally scrolling
        // row — a flex basis, so a narrow row scrolls instead of squeezing it.
        flex: `0 0 ${JOB_CARD_WIDTH}px`,
        display: "flex", flexDirection: "column", gap: 4, minWidth: 0,
        // the card-only vertical padding is 4px (the shared
        // block keeps 6px, so the Tasks blocks are unchanged).
        padding: "4px 8px",
        cursor: pending ? "default" : "pointer", pointerEvents: pending ? "none" : undefined, fontSize: 12,
        background: selected ? "var(--bg-selected)" : POLYFORGE_BLOCK_STYLE.background,
      }}
    >
      {/* Title: the slug (wraps, never clipped) and the status at the right
          end of its row — the small dim label, or for a job awaiting a human
          answer the emphasized marker; the truncated goal under them (at most
          2 lines). The status ellipsizes before it squeezes the slug. */}
      <div style={{ display: "flex", flexDirection: "column", gap: 0, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, minWidth: 0 }}>
          <div style={{ flex: "1 1 0", minWidth: 0, color: "var(--text)", fontWeight: 600, overflowWrap: "anywhere", lineHeight: "16px" }}>{job.slug}</div>
          {needsInput ? (
            <div data-pf-needs-input="" style={{ flex: "0 1 auto", minWidth: 0, maxWidth: "60%", padding: "0 5px", borderRadius: 4, border: "1px solid #d97706", color: "#d97706", fontWeight: 600, fontSize: 11, lineHeight: "14px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {statusLabel}
            </div>
          ) : (
            <div style={{ flex: "0 1 auto", minWidth: 0, maxWidth: "60%", fontSize: 11, lineHeight: "16px", color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{statusLabel}</div>
          )}
        </div>
        {goal && (
          <span title={goal} style={{ color: "var(--text-muted)", overflowWrap: "anywhere", lineHeight: "16px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{truncateCardTitle(goal, titleLength)}</span>
        )}
      </div>
    </div>
  );
});

/** Work's sub-tab badges' accessible-name keys. */
const WORK_TAB_BADGES = { jobs: "polyforge.work.jobsRunning", tasks: "polyforge.work.tasksRunning", items: "polyforge.work.itemsRunning" } as const;

/** The ≤640px Work rail's 16px icons, in the panel's 24-viewBox stroke style. */
const workTabIcon = (paths: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths}
  </svg>
);
const WORK_TAB_ICONS = {
  // 作业: a stack of running jobs.
  jobs: workTabIcon(<><path d="m12 3 9 5-9 5-9-5z" /><path d="m3 13 9 5 9-5" /></>),
  // 任务: a checked box.
  tasks: workTabIcon(<><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m9 12 2 2 4-4" /></>),
  // 工单列表: a bulleted list.
  items: workTabIcon(<><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01" /><path d="M4 12h.01" /><path d="M4 18h.01" /></>),
} as const;

/** the 工单列表 re-read key — `queue.running` and the count of
 *  terminal (completed/failed/cancelled) jobs in the status snapshot; null
 *  without a snapshot (no re-read). Pure. */
export function workItemCountKey(opsStatus: PolyforgeOpsStatus | null): string | null {
  if (!opsStatus) return null;
  const terminal = opsStatus.jobs.filter((job) => job.status === "completed" || job.status === "failed" || job.status === "cancelled").length;
  return `${opsStatus.queue.running}:${terminal}`;
}

export function PolyforgePanel({
  opsStatus,
  opsError,
  cards,
  cardsError,
  watchStatus,
  selectedWi,
  onSelect,
  onClose,
  onRefresh,
  activeTab,
  onActiveTab,
  workTab,
  onWorkTab,
  workItemsRunning,
  onWorkItemsRunningChange,
  memoryCwd,
  messagesSurface,
  showPin,
  pinned,
  onTogglePin,
}: {
  opsStatus: PolyforgeOpsStatus | null;
  opsError: string | null;
  /** the Jobs-tab card stream (null until its first good read). */
  cards: PolyforgeCard[] | null;
  cardsError: string | null;
  watchStatus: PolyforgeWatchStatus | null;
  selectedWi: string | null;
  onSelect: (wi: string | null) => void;
  onClose: () => void;
  // May return the status fetch's settle promise (usePolyforge.refreshStatus
  // does); the manual-refresh feedback (pi#113) awaits it.
  onRefresh: () => void | Promise<void>;
  activeTab: PolyforgeTab;
  onActiveTab: (tab: PolyforgeTab) => void;
  /** Work's selected sub-tab (page memory, held by the hook). */
  workTab: PolyforgeWorkTab;
  onWorkTab: (tab: PolyforgeWorkTab) => void;
  /** the 工单列表 badge — the last list read's running count
   *  (null until the first read), held by the hook, reported by the surface. */
  workItemsRunning: number | null;
  onWorkItemsRunningChange: (count: number) => void;
  /** The session cwd the Memory tab scopes its project dropdown to. */
  memoryCwd: string | null;
  /** the desktop dock's pin control (absent on the mobile sheet). */
  showPin: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  messagesSurface: {
    pfPresent: boolean;
    capable: boolean;
    reason: string | null;
    conversations: PolyforgeConversation[];
    contacts: PolyforgeContact[];
    groups: PolyforgeProjectGroup[];
    membershipAdmin: boolean | null;
    users: PolyforgeContact[];
    onChangeMembership: (input: { action: "add" | "remove"; project: string; userId: string }) => Promise<void>;
    error: string | null;
    selectedConversation: string | null;
    onSelectConversation: (id: string | null) => void;
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
    unreadTotal: number;
  };
}) {
  const { t, locale } = useI18n();
  const { titleLength } = usePolyforgePanelPreferences();
  // the Work sub-tab controls follow the viewport, not the
  // dock kind — a 340px desktop dock keeps the 72px text rail, ≤640px gets
  // the 40px icon rail, both on the right of the main area.
  const isMobile = useIsMobile();
  const itemCountKey = workItemCountKey(opsStatus);

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

  // pi#117 detail rows: live progress and the chat origin (the per-step
  // timing is the DAG's timing line since) —
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
    || originHasText;

  // Until the first card read lands, the status jobs render as line-1-only
  // cards (same key, so the real card reuses the node): the job list never
  // blanks to "Loading…" while the status poll already knows the jobs.
  const shownCards = cards ?? (opsStatus?.jobs ?? []).map((job) => statusOnlyCard(job, !cardsError));
  // The selected job's status facts for the detail: from the
  // rendered cards, else the status job list; matched by slug or wi id (an
  // anchor selects by either).
  const selectedCard = selectedWi
    ? shownCards.find((card) => card.job.slug === selectedWi || card.job.wi === selectedWi)
    : undefined;
  const selectedJob = selectedWi
    ? (selectedCard?.job ?? opsStatus?.jobs.find((job) => job.slug === selectedWi || job.wi === selectedWi))
    : undefined;
  // the per-step rerun count the card no longer shows, from the
  // selected card's own read (no new read); shown on the DAG timing line
  //.
  const stepRuns = new Map((selectedCard?.steps ?? []).map((step) => [step.id, step.runs]));
  // title row: the slug (the watch read's, else the selected
  // job's, else the selection ref), the goal's pure first-clause short title
  // (absent without a readable goal — never an invented title) and the job
  // status (the watch read's workflow status once the job left the list).
  // The hover carries the full goal, the workflow status (the old header's
  // visible label), the update time and the current step.
  const detailSlug = watchStatus?.slug ?? selectedJob?.slug ?? selectedWi;
  const detailGoal = selectedCard?.goal;
  const detailShortTitle = shortJobTitle(detailGoal);
  const detailStatus = selectedJob
    ? jobStatusLabel(selectedJob.status)
    : watchStatus ? workflowStatusLabel(watchStatus.workflowStatus) : null;
  const detailTitleHover = [
    detailGoal,
    watchStatus ? workflowStatusLabel(watchStatus.workflowStatus) : undefined,
    watchStatus?.updatedAt ? `${t("polyforge.updatedAt")}: ${formatEventTime(watchStatus.updatedAt)}` : undefined,
    watchStatus?.currentStep ? `${t("polyforge.currentStep")}: ${watchStatus.currentStep}` : undefined,
  ].filter(Boolean).join("\n");

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }} role="complementary" aria-label={t("polyforge.title")}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>{t("polyforge.title")}</span>
        {/* the desktop pin — while pressed an outside press no
            longer dismisses the dock; close and the topbar toggle still do. */}
        {showPin && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinned}
            title={pinned ? t("polyforge.dock.unpin") : t("polyforge.dock.pin")}
            aria-label={t("polyforge.dock.pin")}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, background: pinned ? "var(--bg-selected)" : "none", border: "none", borderRadius: 4, color: pinned ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 14 }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 17v5" /><path d="M9 10.76V6h6v4.76l2 3.24H7z" /><path d="M8 2h8" />
            </svg>
          </button>
        )}
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

      {/* Work | Memory | Messages tab strip (; order by owner
          2026-10-30,; the former Jobs and Tasks tabs are Work's
          sub-tabs). The unread indicator is its own element beside the
          Messages label: it never replaces any badge. Work carries no count
          of its own. */}
      <div role="tablist" data-pf-tabstrip="top" aria-label={t("polyforge.title")} style={{ display: "flex", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button type="button" role="tab" aria-selected={activeTab === "work"}
          onClick={() => onActiveTab("work")}
          style={{ flex: 1, padding: "6px 12px", background: activeTab === "work" ? "var(--bg-selected)" : "none", border: "none", borderBottom: activeTab === "work" ? "2px solid var(--accent)" : "2px solid transparent", color: activeTab === "work" ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
          {t("polyforge.work.tab")}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "memory"}
          onClick={() => onActiveTab("memory")}
          style={{ flex: 1, padding: "6px 12px", background: activeTab === "memory" ? "var(--bg-selected)" : "none", border: "none", borderBottom: activeTab === "memory" ? "2px solid var(--accent)" : "2px solid transparent", color: activeTab === "memory" ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
          {t("polyforge.memory.tab")}
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "messages"}
          onClick={() => onActiveTab("messages")}
          style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "6px 12px", background: activeTab === "messages" ? "var(--bg-selected)" : "none", border: "none", borderBottom: activeTab === "messages" ? "2px solid var(--accent)" : "2px solid transparent", color: activeTab === "messages" ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
          {t("polyforge.messages.tab")}
          {messagesSurface.unreadTotal > 0 && (
            <span aria-label={t("polyforge.messages.unread")} title={t("polyforge.messages.unread")}
              style={{ width: 8, height: 8, borderRadius: 4, background: "var(--accent)", display: "inline-block" }} />
          )}
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {activeTab === "messages" ? (
          <PolyforgeMessages
            pfPresent={messagesSurface.pfPresent}
            capable={messagesSurface.capable}
            reason={messagesSurface.reason}
            conversations={messagesSurface.conversations}
            contacts={messagesSurface.contacts}
            groups={messagesSurface.groups}
            membershipAdmin={messagesSurface.membershipAdmin}
            users={messagesSurface.users}
            onChangeMembership={messagesSurface.onChangeMembership}
            error={messagesSurface.error}
            selectedConversation={messagesSurface.selectedConversation}
            onSelectConversation={messagesSurface.onSelectConversation}
            selectedContact={messagesSurface.selectedContact}
            onSelectContact={messagesSurface.onSelectContact}
            messages={messagesSurface.messages}
            initialPageLoaded={messagesSurface.initialPageLoaded}
            blocked={messagesSurface.blocked}
            loadingOlder={messagesSurface.loadingOlder}
            onLoadOlder={messagesSurface.onLoadOlder}
            onAcknowledge={messagesSurface.onAcknowledge}
            onSend={messagesSurface.onSend}
            onAnalyze={messagesSurface.onAnalyze}
            analyses={messagesSurface.analyses}
            onOpenAnchor={messagesSurface.onOpenAnchor}
          />
        ) : activeTab === "memory" ? (
          <PolyforgeMemory cwd={memoryCwd} onOpenWorkItem={messagesSurface.onOpenAnchor} />
        ) : (
          // Work: the main area shows the selected sub-tab's
          // surface, the sub-tab controls sit in a right rail: ~72px with text
          // labels on desktop, a 40px icon rail at ≤640px.
          // The controls come after the main area in the DOM in one row at
          // every width, so switching never re-mounts the main area's siblings.
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "row" }}>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {workTab === "items" ? (
                // one list read per opening, one re-read per
                // change of queue.running or the terminal-job count while
                // mounted (null without a snapshot); none elsewhere.
                <PolyforgeWorkItems itemCountKey={itemCountKey} onRunningCount={onWorkItemsRunningChange} />
              ) : workTab === "tasks" ? (
                // one list re-read per status task-count change
                // while this sub-page is visible; none elsewhere (it unmounts).
                <PolyforgeTasks taskCountKey={opsStatus ? `${opsStatus.tasks?.running ?? 0}:${opsStatus.tasks?.completed ?? 0}` : null} />
              ) : opsStatus ? (
                <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                  {/* Queue line + job card stream: the stream
                      takes the whole body until a job is selected, then yields
                      the lower part to the detail. */}
                  <div style={{ maxHeight: selectedWi ? "45%" : "100%", overflowY: "auto", overflowX: "hidden", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 11, color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}>
                      <span>{t("polyforge.queue")}</span>
                      <span style={{ fontWeight: 600, color: "var(--text)" }}>
                        {opsStatus.queue.running} / {opsStatus.queue.max}
                      </span>
                    </div>
                    {/* a known snapshot with no job is the empty
                        state at once — the stand-ins are the status jobs, so an
                        empty stream before the first card read means the status
                        already says "no jobs" (no Loading… flash). */}
                    {shownCards.length === 0 ? (
                      <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.empty")}</div>
                    ) : (
                      // (intentional change per the 2026-10-31 ruling, not a
                      // regression):
                      // one row of cards that scrolls left and right — each card is a
                      // fixed 150px (the Tasks blocks' column minimum,), so
                      // a wider main area leaves room at the right and a narrower one
                      // (the 340px dock) never squeezes the card. Native touch inertia, no
                      // scroll-snap; the thin scrollbar stays visible because a desktop
                      // mouse has no horizontal wheel and a hidden bar would strand the
                      // cards past the fold.
                      <div style={{ display: "flex", flexWrap: "nowrap", gap: 8, padding: 8, overflowX: "auto", scrollbarWidth: "thin" }}>
                        {shownCards.map((card: PolyforgeCard) => (
                          <PolyforgeJobCard
                            key={polyforgeCardKey(card)}
                            card={card}
                            pending={cards === null}
                            selected={selectedWi === card.job.slug || selectedWi === card.job.wi}
                            titleLength={titleLength}
                            onSelect={onSelect}
                          />
                        ))}
                      </div>
                    )}
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
                          {/* title row (was the detail header): the
                              deselect control, the slug, the goal's short title
                              (one line, ellipsized) and the job status on one line;
                              the full goal, workflow status, update time and current
                              step on hover. The deselect control is the only
                              reliable gesture once the selected job has left the
                              list (the row that could toggle it off is gone) or
                              while its watch snapshot is still loading, so the row
                              sits above the watchStatus split. */}
                          <div
                            data-pf-detail-title=""
                            title={detailTitleHover || undefined}
                            style={{ padding: "4px 12px", fontSize: 11, color: "var(--text-dim)", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
                          >
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
                            <span style={{ flex: "0 0 auto", whiteSpace: "nowrap", fontWeight: 600, color: "var(--text)" }}>{detailSlug}</span>
                            {detailShortTitle && (
                              <span style={{ flex: "1 1 0", minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--text-muted)" }}>{detailShortTitle}</span>
                            )}
                            {detailStatus && (
                              <span style={{ flex: "0 0 auto", marginLeft: "auto", whiteSpace: "nowrap" }}>{detailStatus}</span>
                            )}
                          </div>
                          {/* order: title row → DAG with timing lines →
                              execution progress → every existing block in its
                              original relative order (facts row, summary, detail
                              rows, event-mode toggle, event tail). */}
                          {/* Step flow graph (pi#114): display-only nodes with
                              status dots, solid sequence connectors between
                              consecutive nodes, dashed rewind chips below.
                              Nodes wrap; the container never scrolls. */}
                          {graph ? (
                          <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0, overflow: "hidden" }}>
                            <div role="list" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: 6 }}>
                              {graph.nodes.map((node, index) => {
                                // the per-step timing lives under its
                                // node — `+<duration>` (done: own start → the next
                                // started step's start; in_progress: the live age at
                                // render) and `×N` for a rerun; otherwise an empty
                                // line of the same height keeps the nodes aligned.
                                // The start time joins the node's hover title.
                                const timing = stepTimings?.get(node.id);
                                const runs = stepRuns.get(node.id) ?? 0;
                                const timingText = [
                                  timing && timing.durationSec != null ? `+${formatCardDuration(timing.durationSec)}` : "",
                                  runs > 1 ? `×${runs}` : "",
                                ].filter(Boolean).join(" ");
                                return (
                                <span key={`${node.id}-${index}`} style={{ display: "inline-flex", alignItems: "flex-start" }}>
                                  {/* Connector only for pairs the model actually
                                      edges: started-only in fallback (G5), and
                                      declared-consecutive pairs only (G6). */}
                                  {index > 0 &&
                                    graph.sequenceEdges.some(
                                      ([from, to]) => from === graph.nodes[index - 1].id && to === node.id,
                                    ) && (
                                    <span aria-hidden="true" style={{ color: "var(--text-dim)", fontSize: 10, lineHeight: "20px", padding: "0 3px", flexShrink: 0 }}>
                                      →
                                    </span>
                                  )}
                                  {/* The node column: the listitem (name + dot, exact
                                      name-only text) and its timing line as a sibling. */}
                                  <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center" }}>
                                  <span
                                    role="listitem"
                                    title={`${node.id} · ${stepStatusLabel(node.status)}${timing ? ` · ${formatEventTime(timing.startedAt)}` : ""}`}
                                    aria-label={`${node.id} · ${stepStatusLabel(node.status)}`}
                                    style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 11, color: "var(--text)", fontFamily: "var(--font-mono, monospace)" }}
                                  >
                                    <span
                                      aria-hidden="true"
                                      className={node.status === "in_progress" ? "pf-step-node-pulse" : undefined}
                                      style={node.status === "skipped"
                                        // skipped is a hollow gray ring (pending stays the filled gray dot).
                                        ? { width: 7, height: 7, borderRadius: 4, flexShrink: 0, boxSizing: "border-box", background: "transparent", border: "1.5px solid var(--text-dim)" }
                                        : { width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: stepNodeColor(node.status) }}
                                    />
                                    {/* name + dot only; the status lives in title/aria-label. */}
                                    {shortenCandidate(node.id)}
                                  </span>
                                  <span data-pf-step-timing={node.id} style={{ height: 14, lineHeight: "14px", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)", whiteSpace: "nowrap" }}>{timingText}</span>
                                  </span>
                                </span>
                                );
                              })}
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
                          ) : (
                            <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.loading")}</div>
                          )}
                          {/* execution progress: the selected job's
                              current-step transcript tail (narration + one masked
                              tool line per call), newest last, inline in this one
                              scroll region — no nested scroller. Its own fixed 2 s
                              read while running (usePolyforgeProgress). */}
                          <PolyforgeDetailProgress wi={selectedJob?.wi ?? null} running={selectedJob?.status === "running"} />
                          {/* the job's model (24 chars + … as before,
                              full on hover), spawn number and step/idle age left
                              the card; they live here, from the status snapshot,
                              so they show even while the watch read is loading. */}
                          {selectedJob && (
                            <div style={{ padding: "4px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", flexWrap: "wrap", columnGap: 12, rowGap: 2, fontSize: 11 }}>
                              <span style={{ display: "flex", gap: 6, minWidth: 0 }}>
                                <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{t("polyforge.candidate")}</span>
                                <span title={selectedJob.candidate} style={{ color: "var(--text)", fontFamily: "var(--font-mono, monospace)", overflowWrap: "anywhere" }}>{selectedJob.candidate ? shortenCandidate(selectedJob.candidate) : "—"}</span>
                                <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>#{selectedJob.spawnN}</span>
                              </span>
                              <span style={{ display: "flex", gap: 6, whiteSpace: "nowrap" }}>
                                <span style={{ color: "var(--text-dim)" }}>{t("polyforge.stepAge")}</span>
                                <span style={{ color: "var(--text)" }}>{formatAge(selectedJob.stepAgeSec)}</span>
                                <span style={{ color: "var(--text-dim)" }}>{t("polyforge.idleAge")}</span>
                                <span style={{ color: "var(--text)" }}>{formatAge(selectedJob.idleAgeSec)}</span>
                              </span>
                            </div>
                          )}
                          {watchStatus && (
                            <>
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
                                  recent files, chat origin (the per-step timing
                                  moved under the DAG nodes,).
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
            <div
              role="tablist"
              data-pf-tabstrip="work"
              aria-label={t("polyforge.work.tab")}
              aria-orientation="vertical"
              style={isMobile
                ? { flex: "0 0 40px", width: 40, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border)", overflowY: "auto" }
                : { flex: "0 0 72px", width: 72, display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border)", overflowY: "auto" }}
            >
              {(["jobs", "tasks", "items"] as const).map((tab) => {
                const active = workTab === tab;
                // The running count rides the existing status snapshot (no
                // timer of its own): queue.running for Jobs, tasks.running
                // for Tasks; 0 stays visible but greyed; no snapshot (daemon
                // down) shows no badge at all. 工单列表 shows
                // the last list read's running count, absent before the first.
                const count = tab === "items" ? workItemsRunning
                  : opsStatus ? (tab === "jobs" ? opsStatus.queue.running : (opsStatus.tasks?.running ?? 0)) : null;
                const label = tab === "jobs" ? t("polyforge.messages.jobsTab") : tab === "tasks" ? t("polyforge.tasks.tab") : t("polyforge.work.itemsTab");
                return (
                  <button key={tab} type="button" role="tab" aria-selected={active}
                    onClick={() => onWorkTab(tab)}
                    // icon-only at ≤640px, so the tab copy names the button.
                    aria-label={isMobile ? label : undefined}
                    title={isMobile ? label : undefined}
                    style={{
                      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: isMobile ? 0 : 2,
                      flex: "0 0 auto", minWidth: 0,
                      ...(isMobile ? { width: "100%", height: 40, padding: 0 } : { padding: "10px 4px" }),
                      background: active ? "var(--bg-selected)" : "none", border: "none",
                      borderRight: active ? "2px solid var(--accent)" : "2px solid transparent",
                      color: active ? "var(--text)" : "var(--text-muted)", cursor: "pointer", fontSize: 12,
                    }}>
                    {isMobile ? WORK_TAB_ICONS[tab] : <span>{label}</span>}
                    {count !== null && (
                      <span
                        data-pf-work-badge={tab}
                        aria-label={t(WORK_TAB_BADGES[tab], { count })}
                        title={t(WORK_TAB_BADGES[tab], { count })}
                        style={{ fontSize: 11, fontWeight: 600, lineHeight: "14px", color: count > 0 ? "var(--accent)" : "var(--text-dim)" }}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
