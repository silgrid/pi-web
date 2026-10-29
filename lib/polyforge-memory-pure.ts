/**
 * Client-safe pure model for the Memory tab: the wire types,
 * the six type-filter values, the display constants (page size, pf-side
 * result limit, collapse threshold), the id/tag validators, the
 * newest-first sort, the page slicer and the truncation test. No Node import
 * lives here, so both the server module and the client panel can use it.
 */

/** One recall hit, exactly the field set the sanitizer forwards (no body). */
export interface PolyforgeMemoryHit {
  id: string;
  type: string;
  title: string;
  visibility: string;
  status: string;
  tags: string[];
  related: string[];
  work_item_id: string | null;
  created_at: string;
  updated_at: string;
  content_len: number;
}

/** One single-memory read: the hit's fields plus the (capped) body. */
export interface PolyforgeMemoryDetail extends PolyforgeMemoryHit {
  content: string;
}

/** The fixed type dropdown (spec: `*` for all, else a `prefix.*` family). */
export const MEMORY_TYPE_FILTERS = [
  "*",
  "doc.*",
  "experience.*",
  "fact.*",
  "methodology.*",
  "rule.*",
] as const;

export type MemoryTypeFilter = (typeof MEMORY_TYPE_FILTERS)[number];

/** Client-side page size (rows per page). */
export const MEMORY_PAGE_SIZE = 20;

/** pf's own per-search result bound (`--limit`); also the narrowing notice's trigger. */
export const MEMORY_RESULT_LIMIT = 200;

/** A body whose `content_len` exceeds this starts collapsed (Assumption 1). */
export const MEMORY_COLLAPSE_BYTES = 2000;

const MEMORY_ID_TOKEN = /^mem_[A-Za-z0-9]+$/;
const TAG_TOKEN = /^[A-Za-z0-9._:-]+$/;

/** A memory id: `mem_` + token. Anything else never reaches a spawn argv. */
export function isPolyforgeMemoryId(value: unknown): value is string {
  return typeof value === "string" && MEMORY_ID_TOKEN.test(value);
}

/** A non-empty comma-separated list of tag-shaped tokens, or false. */
export function isMemoryTagList(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const parts = trimmed.split(",");
  return parts.length > 0 && parts.every((part) => TAG_TOKEN.test(part));
}

/** UTF-8 byte length of a string (the truncation and collapse tests). */
export function memoryUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Newest first by `updated_at` (pf answers relevance order; the display
 *  order is ours). Unparseable timestamps fall back to a string compare so
 *  the sort stays deterministic. Pure, never throws. */
export function sortMemoryHitsNewestFirst(hits: PolyforgeMemoryHit[]): PolyforgeMemoryHit[] {
  return [...hits].sort((a, b) => {
    const at = Date.parse(a.updated_at);
    const bt = Date.parse(b.updated_at);
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

/** One 1-based page of hits (20 rows); out-of-range pages are empty. Pure. */
export function memoryPage(hits: PolyforgeMemoryHit[], page: number): PolyforgeMemoryHit[] {
  if (!Number.isSafeInteger(page) || page < 1) return [];
  const start = (page - 1) * MEMORY_PAGE_SIZE;
  return hits.slice(start, start + MEMORY_PAGE_SIZE);
}

/** The forwarded body is shorter than pf says the memory is (Assumption 4):
 *  the visible truncation notice. Never a guess — equal lengths read whole. */
export function isMemoryBodyTruncated(content: string, contentLen: number): boolean {
  if (typeof contentLen !== "number" || !Number.isFinite(contentLen) || contentLen <= 0) return false;
  return memoryUtf8ByteLength(content) < contentLen;
}
