import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { listPolyforgeTasks, PolyforgeTasksError, readPolyforgeTasksCapability } from "@/lib/polyforge-tasks";

export const dynamic = "force-dynamic";

/**
 * GET /api/polyforge/tasks — the Tasks tab's list read:
 * exactly one `pf --json task list`, every task of the local daemon, each row
 * id/project/state/prompt_summary plus started_at?/ended_at?/wall_consumed_ns?
 *. Read-only: this route exports GET alone,
 * so any other method is 405. Degradation-first: pf absent, below the 2.20.12
 * floor and a failed spawn answer 200 with fields, never 5xx; the only
 * non-2xx answer is the gate's 403.
 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const capability = await readPolyforgeTasksCapability();
  if (!capability.capable) {
    return NextResponse.json({ ...capability, tasks: [] });
  }
  try {
    const tasks = await listPolyforgeTasks();
    return NextResponse.json({ ...capability, tasks });
  } catch (error) {
    const failure = error instanceof PolyforgeTasksError ? error : new PolyforgeTasksError("polyforge is unavailable");
    return NextResponse.json({ ...capability, tasks: [], error: failure.message });
  }
}
