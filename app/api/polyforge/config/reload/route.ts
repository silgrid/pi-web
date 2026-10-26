import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { ConfigWriteError, reloadPolyforgeConfig } from "@/lib/polyforge-config-write";

export const dynamic = "force-dynamic";

/**
 * POST /api/polyforge/config/reload — apply a hand edit on demand through
 * `pf config reload`, then re-read `pf --json ops status` independently so
 * the panel shows the daemon's own newly loaded value (never the write's own
 * reload report).
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    return NextResponse.json(await reloadPolyforgeConfig());
  } catch (error) {
    if (error instanceof ConfigWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "polyforge is unavailable" }, { status: 400 });
  }
}
