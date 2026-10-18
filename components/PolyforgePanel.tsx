"use client";

import { useCallback } from "react";
import type { PolyforgeJob, PolyforgeOpsStatus, PolyforgeWatchStatus } from "@/lib/polyforge-status";
import { useI18n } from "@/hooks/useI18n";

const STEP_STATUS_COLORS: Record<string, string> = {
  in_progress: "var(--accent)",
  done: "#16a34a",
  failed: "#dc2626",
  blocked: "#d97706",
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
  "published", "step_started", "step_done", "step_failed", "step_blocked",
  "job_started", "needs_input", "job_done", "job_blocked",
]);

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
  onRefresh: () => void;
}) {
  const { t, locale } = useI18n();

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

  const jobs = opsStatus?.jobs ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, background: "var(--bg-panel)" }} role="complementary" aria-label={t("polyforge.title")}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1 }}>{t("polyforge.title")}</span>
        <button
          type="button"
          onClick={onRefresh}
          title={t("polyforge.refresh")}
          aria-label={t("polyforge.refresh")}
          style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26, background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 14 }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
            <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
              {selectedWi ? (
                watchStatus ? (
                  <>
                    <div style={{ padding: "4px 12px", fontSize: 11, color: "var(--text-dim)", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                        {watchStatus.slug} · {workflowStatusLabel(watchStatus.workflowStatus)}
                      </span>
                      {watchStatus.updatedAt && (
                        <span style={{ flexShrink: 0 }}>{t("polyforge.updatedAt")}: {formatEventTime(watchStatus.updatedAt)}</span>
                      )}
                      {watchStatus.currentStep && (
                        <span style={{ flexShrink: 0 }}>{t("polyforge.currentStep")}: {watchStatus.currentStep}</span>
                      )}
                    </div>
                    {/* Steps in execution order */}
                    <div style={{ padding: "6px 12px", display: "flex", flexWrap: "wrap", gap: 4, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                      {watchStatus.steps.map((step) => (
                        <span key={step.name} title={stepStatusLabel(step.status)} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 6, border: "1px solid var(--border)", fontSize: 11, color: "var(--text)", fontFamily: "var(--font-mono, monospace)" }}>
                          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 4, flexShrink: 0, background: STEP_STATUS_COLORS[step.status] ?? "var(--text-dim)" }} />
                          {step.name}
                          <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{stepStatusLabel(step.status)}</span>
                        </span>
                      ))}
                    </div>
                    {/* Event tail (newest last) */}
                    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "6px 12px", fontSize: 11, lineHeight: 1.45, fontFamily: "var(--font-mono, monospace)" }}>
                      {watchStatus.events.length === 0 && (
                        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-sans, sans-serif)" }}>{t("polyforge.emptyEvents")}</div>
                      )}
                      {watchStatus.events.map((event, index) => (
                        <div key={`${event.at}-${event.kind}-${index}`} style={{ display: "flex", gap: 8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>{formatEventTime(event.at)}</span>
                          <span style={{ color: "var(--text-muted)", flexShrink: 0 }}>{eventKindLabel(event.kind)}</span>
                          {event.summary && <span style={{ color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis" }}>{event.summary}</span>}
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.loading")}</div>
                )
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
