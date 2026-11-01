import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { polyforgeDataRoot, readJobIndex, readProgressSnapshot } from "@/lib/polyforge-cards";
import { isPolyforgeWorkItemId } from "@/lib/polyforge-cards-pure";

export const dynamic = "force-dynamic";

/**
 * GET /api/polyforge/progress?wi=<wi_…> — the job detail's execution
 * progress (; whole-job since): every spawn of
 * every step, reruns included, as one time-ordered stream of narration, one
 * masked tool line per call and one composed line per retained lifecycle
 * event — `{ available, lines: [{ id, kind: "narration"|"tool"|"event",
 * text, tone?, event? }], omitted }`, the newest 2000 lines with the exact
 * count of earlier ones left out — read from the daemon's own files (no pf
 * spawn), for a running and a finished job alike.
 *
 * Reachable by whoever passes the existing /api gate (403 otherwise).
 * Read-only: the wi must have the daemon's id shape (400 before any file
 * read). A missing, unreadable or non-JSON `runtime-state.json` answers 200
 * `available: false` (N6); a readable index without that job answers 400
 * before any capsule read. Every path comes from the daemon's records and a
 * transcript must resolve inside the capsule or the data root; nothing
 * readable answers 200 `available: false`. Only the two 400s and the gate's
 * 403 are non-2xx; no response names a path. GET only (any other method is
 * 405).
 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const wi = new URL(request.url).searchParams.get("wi");
  if (!isPolyforgeWorkItemId(wi)) {
    return NextResponse.json({ error: "wi must be a work-item id (wi_…)" }, { status: 400 });
  }
  const root = polyforgeDataRoot();
  // readJobIndex and readProgressSnapshot never throw: an unreadable index
  // is `readable: false`, an unreadable capsule is `available: false`.
  const index = readJobIndex(root);
  if (!index.readable) return NextResponse.json({ available: false, lines: [], omitted: 0 });
  const record = index.records.get(wi);
  if (!record) {
    return NextResponse.json({ error: "unknown work item" }, { status: 400 });
  }
  return NextResponse.json(record.capsuleDir ? readProgressSnapshot(root, record.capsuleDir, wi) : { available: false, lines: [], omitted: 0 });
}
