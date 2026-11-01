import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { polyforgeDataRoot, readJobRecords, readProgressTail } from "@/lib/polyforge-cards";
import { isPolyforgeWorkItemId } from "@/lib/polyforge-cards-pure";

export const dynamic = "force-dynamic";

/**
 * GET /api/polyforge/progress?wi=<wi_…> — the job detail's execution
 * progress: the current step's newest transcript tail as
 * `{ available, entries: [{ id, kind: "narration"|"tool", text }] }`, read
 * from the daemon's own files (no pf spawn), newest 50 entries within 32 KiB.
 *
 * Reachable by whoever passes the existing /api gate (403 otherwise).
 * Read-only: the wi must have the daemon's id shape (400 before any file
 * read) and be a job in the daemon's own `runtime-state.json` (400 before
 * any transcript read); the transcript path comes from the daemon's records
 * and must resolve inside the capsule or the data root. A missing, outside,
 * unreadable or partially written transcript answers 200 with
 * `available: false`. Only the two 400s and the gate's 403 are non-2xx; no
 * response names a path. GET only (any other method is 405).
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
  // readJobRecords and readProgressTail never throw: an unreadable index
  // finds no record, an unreadable transcript is `available: false`.
  const record = readJobRecords(root).get(wi);
  if (!record) {
    return NextResponse.json({ error: "unknown work item" }, { status: 400 });
  }
  return NextResponse.json(record.capsuleDir ? readProgressTail(root, record.capsuleDir) : { available: false, entries: [] });
}
