"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import {
  MEMORY_COLLAPSE_BYTES,
  MEMORY_PAGE_SIZE,
  MEMORY_RESULT_LIMIT,
  MEMORY_TYPE_FILTERS,
  isMemoryBodyTruncated,
  isPolyforgeMemoryId,
  memoryPage,
  sortMemoryHitsNewestFirst,
  type PolyforgeMemoryDetail,
  type PolyforgeMemoryHit,
} from "@/lib/polyforge-memory-pure";
import { MarkdownBody } from "./MarkdownBody";

/**
 * The dock's Memory surface: search-then-view, pull-only. One
 * scope read when the tab first renders (the config read behind the project
 * dropdown — no memory verb); a search on submit only; a single-memory read
 * on selection. No timer, no polling, no storage: query, results and detail
 * live in component state and die with the tab.
 */

export interface PolyforgeMemoryProps {
  /** The session cwd whose workspace projects scope the search. */
  cwd: string | null;
  /** Opens a work-item reference through the existing Jobs watch read. */
  onOpenWorkItem: (ref: string) => void;
}

/** The scope read's answer (the route's capability + project fields). */
interface MemoryScope {
  pfPresent: boolean;
  capable: boolean;
  reason?: string;
  mapped: boolean;
  projects: string[];
}

interface SearchResponse extends Partial<MemoryScope> {
  hits?: PolyforgeMemoryHit[];
  error?: string;
}

interface ShowResponse extends Partial<MemoryScope> {
  memory?: PolyforgeMemoryDetail | null;
  error?: string;
}

/** The collapsed body's display-height clip (the source is never sliced). */
const COLLAPSE_MAX_HEIGHT_PX = 280;

/** The six dropdown values → their labels; `*` is the "all types" default. */
const TYPE_LABEL_KEYS: Record<string, string> = {
  "doc.*": "polyforge.memory.typeDoc",
  "experience.*": "polyforge.memory.typeExperience",
  "fact.*": "polyforge.memory.typeFact",
  "methodology.*": "polyforge.memory.typeMethodology",
  "rule.*": "polyforge.memory.typeRule",
};

export function PolyforgeMemory({ cwd, onOpenWorkItem }: PolyforgeMemoryProps) {
  const { t } = useI18n();
  const [scope, setScope] = useState<MemoryScope | null>(null);
  const [scopeError, setScopeError] = useState<string | null>(null);

  const [keyword, setKeyword] = useState("");
  const [anyWord, setAnyWord] = useState(false);
  const [tags, setTags] = useState("");
  const [type, setType] = useState<string>(MEMORY_TYPE_FILTERS[0]);
  const [project, setProject] = useState("");

  const [hits, setHits] = useState<PolyforgeMemoryHit[] | null>(null);
  const [page, setPage] = useState(1);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const [detail, setDetail] = useState<PolyforgeMemoryDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const detailScrollRef = useRef<HTMLDivElement | null>(null);
  // A selection sequence: only the newest openDetail (or the back button)
  // may write detail state, so a slow earlier read cannot overwrite a later
  // selection's answer (the review finding,).
  const detailSeqRef = useRef(0);

  // The one scope read: when the tab first renders (and when the cwd changes),
  // the dropdown's own source. It spawns no memory verb, so an open, idle tab
  // reads nothing (Requirement 2). A null cwd maps to nothing — no fetch.
  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    setScope(null);
    setScopeError(null);
    fetch(`/api/polyforge/memory?cwd=${encodeURIComponent(cwd)}`)
      .then(async (response) => {
        const body = await response.json() as SearchResponse;
        if (cancelled) return;
        if (!response.ok) {
          setScopeError(body.error ?? t("polyforge.memory.error"));
          return;
        }
        const projects = Array.isArray(body.projects) ? body.projects.filter((item) => typeof item === "string") : [];
        setScope({
          pfPresent: body.pfPresent !== false,
          capable: body.capable !== false,
          ...(body.reason ? { reason: body.reason } : {}),
          mapped: body.mapped === true,
          projects,
        });
        // The first project is selected by default (Assumption 8); a project
        // that leaves the scope's list falls back to the first.
        setProject((current) => (projects.includes(current) ? current : (projects[0] ?? "")));
        if (body.error) setScopeError(body.error);
      })
      .catch(() => {
        if (!cancelled) setScopeError(t("polyforge.memory.error"));
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t() is stable per locale; the read is keyed on cwd only
  }, [cwd]);

  const openDetail = useCallback((id: string) => {
    if (!isPolyforgeMemoryId(id)) return;
    const seq = ++detailSeqRef.current;
    setDetail(null);
    setDetailError(null);
    setExpanded(false);
    setCopied(false);
    if (detailScrollRef.current) detailScrollRef.current.scrollTop = 0;
    fetch(`/api/polyforge/memory/${encodeURIComponent(id)}`)
      .then(async (response) => {
        const body = await response.json() as ShowResponse;
        if (seq !== detailSeqRef.current) return;
        if (!response.ok) {
          setDetailError(body.error ?? t("polyforge.memory.error"));
          return;
        }
        setDetailError(body.error ?? null);
        setDetail(body.memory ?? null);
      })
      .catch(() => {
        if (seq === detailSeqRef.current) setDetailError(t("polyforge.memory.error"));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per selection; t() is stable per locale
  }, []);

  const submit = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    const q = keyword.trim();
    // An empty keyword keeps the guidance state and spawns nothing; an
    // unmapped cwd offers no runnable search at all.
    if (!q || !scope?.mapped || !cwd || searching) return;
    const params = new URLSearchParams({ cwd, q, project, type });
    if (tags.trim()) params.set("tags", tags.trim());
    if (anyWord) params.set("any", "1");
    setSearching(true);
    setSearchError(null);
    fetch(`/api/polyforge/memory?${params}`)
      .then(async (response) => {
        const body = await response.json() as SearchResponse;
        if (!response.ok) {
          setSearchError(body.error ?? t("polyforge.memory.error"));
          return;
        }
        // Newest-first is the display order (pf answers relevance order).
        setHits(sortMemoryHitsNewestFirst(Array.isArray(body.hits) ? body.hits : []));
        setPage(1);
        setSearchError(body.error ?? null);
      })
      .catch(() => setSearchError(t("polyforge.memory.error")))
      .finally(() => setSearching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the read follows the submit gesture; t() is stable per locale
  }, [keyword, scope, cwd, searching, project, type, tags, anyWord]);

  // Expanding reveals the whole body: the clip comes off and the region
  // scrolls to the body's end, so the last line is truly shown — not just
  // unclipped but left below the fold.
  useEffect(() => {
    if (expanded && detailScrollRef.current) {
      const element = detailScrollRef.current;
      element.scrollTop = element.scrollHeight;
    }
  }, [expanded]);

  const copy = useCallback(() => {
    if (!detail) return;
    void copyText(detail.id).then(() => setCopied(true)).catch(() => undefined);
  }, [detail]);

  if (scopeError) {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <span style={{ color: "#dc2626" }}>{t("polyforge.memory.error")}</span>
        <span style={{ color: "var(--text-dim)" }}>{scopeError}</span>
      </div>
    );
  }
  if (!cwd) {
    // A null cwd maps to nothing and runs no read (the scope effect's own
    // guard), so without this branch the tab would sit on Loading… forever
    // (the review finding,). The unmapped state is the honest answer.
    return <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.memory.unmapped")}</div>;
  }
  if (!scope) {
    return <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.loading")}</div>;
  }
  if (!scope.pfPresent) {
    return <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.memory.notInstalled")}</div>;
  }
  if (!scope.capable) {
    return (
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
        <span style={{ color: "var(--text)" }}>{t("polyforge.memory.upgrade")}</span>
        <span style={{ color: "var(--text-dim)" }}>{scope.reason ?? t("polyforge.memory.upgradeReason")}</span>
      </div>
    );
  }
  if (!scope.mapped) {
    return <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.memory.unmapped")}</div>;
  }

  const renderForm = () => (
    <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0, fontSize: 11 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, color: "var(--text-dim)", flex: 1, minWidth: 140 }}>
        {t("polyforge.memory.keyword")}
        <input
          type="search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t("polyforge.memory.keywordPlaceholder")}
          aria-label={t("polyforge.memory.keyword")}
          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }}
        />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, color: "var(--text-dim)" }}>
        {t("polyforge.memory.project")}
        <select
          value={project}
          onChange={(event) => setProject(event.target.value)}
          aria-label={t("polyforge.memory.project")}
          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }}
        >
          {scope.projects.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, color: "var(--text-dim)" }}>
        {t("polyforge.memory.type")}
        <select
          value={type}
          onChange={(event) => setType(event.target.value)}
          aria-label={t("polyforge.memory.type")}
          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }}
        >
          {MEMORY_TYPE_FILTERS.map((value) => (
            <option key={value} value={value}>
              {value === "*" ? t("polyforge.memory.typeAll") : t(TYPE_LABEL_KEYS[value] ?? "")}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 2, color: "var(--text-dim)" }}>
        {t("polyforge.memory.tags")}
        <input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={t("polyforge.memory.tagsPlaceholder")}
          aria-label={t("polyforge.memory.tags")}
          style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 4, padding: "4px 6px", fontSize: 12 }}
        />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-dim)", paddingTop: 14 }}>
        <input
          type="checkbox"
          checked={anyWord}
          onChange={(event) => setAnyWord(event.target.checked)}
          aria-label={t("polyforge.memory.any")}
        />
        {t("polyforge.memory.any")}
      </label>
      <button
        type="submit"
        disabled={searching}
        style={{ alignSelf: "flex-end", background: "var(--accent)", color: "var(--bg-panel)", border: "none", borderRadius: 4, padding: "4px 12px", fontSize: 12, cursor: searching ? "default" : "pointer" }}
      >
        {t("polyforge.memory.search")}
      </button>
    </form>
  );

  if (detail || detailError) {
    const bodyCapped = detail ? isMemoryBodyTruncated(detail.content, detail.content_len) : false;
    const collapsible = detail ? detail.content_len > MEMORY_COLLAPSE_BYTES : false;
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <button type="button" onClick={() => { detailSeqRef.current += 1; setDetail(null); setDetailError(null); setExpanded(false); setCopied(false); }}
            style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: 0 }}>
            ← {t("polyforge.memory.back")}
          </button>
          {detail && (
            <button type="button" onClick={copy}
              style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 8px" }}>
              {t("polyforge.memory.copy")}
            </button>
          )}
          {copied && <span style={{ fontSize: 11, color: "#16a34a" }}>{t("polyforge.memory.copied")}</span>}
        </div>
        {detailError && <div style={{ padding: "8px 12px", color: "#dc2626", fontSize: 12 }}>{detailError}</div>}
        {detail && (
          <div ref={detailScrollRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)" }}>{detail.title}</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11 }}>
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 76 }}>{t("polyforge.memory.type")}</span>
                <span style={{ color: "var(--text)" }}>{detail.type}</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 76 }}>{t("polyforge.memory.metaVisibility")}</span>
                <span style={{ color: "var(--text)", ...(detail.visibility === "private" ? { border: "1px solid #d97706", borderRadius: 4, padding: "0 6px" } : {}) }}>
                  {detail.visibility}
                </span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 76 }}>{t("polyforge.memory.metaStatus")}</span>
                <span style={{ color: "var(--text)", ...(detail.status !== "active" ? { border: "1px solid var(--border)", borderRadius: 4, padding: "0 6px" } : {}) }}>
                  {detail.status}
                </span>
              </div>
              {detail.tags.length > 0 && (
                <div style={{ display: "flex", gap: 6 }}>
                  <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 76 }}>{t("polyforge.memory.tags")}</span>
                  <span style={{ color: "var(--text)" }}>{detail.tags.join(", ")}</span>
                </div>
              )}
              {detail.related.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 76 }}>{t("polyforge.memory.metaRelated")}</span>
                  {detail.related.map((relatedId) => (
                    <button key={relatedId} type="button" onClick={() => openDetail(relatedId)}
                      style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", font: "inherit", textDecoration: "underline", fontSize: 11 }}>
                      {relatedId}
                    </button>
                  ))}
                </div>
              )}
              {detail.work_item_id && (
                <div style={{ display: "flex", gap: 6 }}>
                  <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 76 }}>{t("polyforge.memory.metaWorkItem")}</span>
                  <button type="button" onClick={() => onOpenWorkItem(detail.work_item_id as string)}
                    style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer", font: "inherit", textDecoration: "underline", fontSize: 11 }}>
                    {detail.work_item_id}
                  </button>
                </div>
              )}
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 76 }}>{t("polyforge.memory.metaCreated")}</span>
                <span style={{ color: "var(--text)" }}>{detail.created_at}</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ color: "var(--text-dim)", flexShrink: 0, width: 76 }}>{t("polyforge.memory.metaUpdated")}</span>
                <span style={{ color: "var(--text)" }}>{detail.updated_at}</span>
              </div>
            </div>
            {bodyCapped && (
              <div style={{ fontSize: 11, color: "#d97706" }}>{t("polyforge.memory.truncated")}</div>
            )}
            {/* The height clip never slices the markdown source: the whole
                body stays in the DOM, so fences, tables and links survive. */}
            <div style={collapsible && !expanded ? { maxHeight: COLLAPSE_MAX_HEIGHT_PX, overflowY: "hidden" } : undefined}>
              <MarkdownBody>{detail.content}</MarkdownBody>
            </div>
            {collapsible && (
              <button type="button" onClick={() => setExpanded((value) => !value)}
                style={{ alignSelf: "flex-start", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 8px", flexShrink: 0 }}>
                {expanded ? t("polyforge.memory.collapse") : t("polyforge.memory.expand")}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  const pages = hits ? Math.max(1, Math.ceil(hits.length / MEMORY_PAGE_SIZE)) : 1;
  const rows = hits ? memoryPage(hits, page) : [];
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {renderForm()}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        {searchError && (
          <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
            <span style={{ color: "#dc2626" }}>{t("polyforge.memory.error")}</span>
            <span style={{ color: "var(--text-dim)" }}>{searchError}</span>
          </div>
        )}
        {hits === null && !searchError && (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.memory.guidance")}</div>
        )}
        {hits !== null && hits.length === 0 && !searchError && (
          <div style={{ padding: 16, color: "var(--text-dim)", fontSize: 12 }}>{t("polyforge.memory.empty")}</div>
        )}
        {hits !== null && hits.length >= MEMORY_RESULT_LIMIT && (
          <div style={{ padding: "8px 12px", color: "#d97706", fontSize: 11 }}>{t("polyforge.memory.narrow")}</div>
        )}
        {rows.map((hit) => (
          <button
            key={hit.id}
            type="button"
            onClick={() => openDetail(hit.id)}
            style={{
              display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
              padding: "6px 12px", background: "none", border: "none", borderBottom: "1px solid var(--border)",
              cursor: "pointer", textAlign: "left", width: "100%", font: "inherit",
            }}
          >
            <span style={{ display: "flex", gap: 6, width: "100%", fontSize: 12, color: "var(--text)" }}>
              <span style={{ flexShrink: 0, color: "var(--text-muted)" }}>[{hit.type}]</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hit.title}</span>
            </span>
            <span style={{ display: "flex", gap: 8, fontSize: 11, color: "var(--text-dim)" }}>
              <span>{hit.updated_at}</span>
              {hit.tags.length > 0 && <span>{hit.tags.join(", ")}</span>}
            </span>
          </button>
        ))}
        {hits !== null && hits.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 11, color: "var(--text-dim)", flexShrink: 0 }}>
            <button type="button" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}
              style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 8px" }}>
              ‹ {t("polyforge.memory.prev")}
            </button>
            <span>{t("polyforge.memory.page", { page, pages })}</span>
            <button type="button" disabled={page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}
              style={{ background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, padding: "2px 8px" }}>
              {t("polyforge.memory.next")} ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
