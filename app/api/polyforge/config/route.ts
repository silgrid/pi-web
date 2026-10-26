import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readPolyforgeConfig } from "@/lib/polyforge-config";
import { ConfigWriteError, writePolyforgeConfig, type ConfigWriteRequest } from "@/lib/polyforge-config-write";

export const dynamic = "force-dynamic";

/**
 * GET /api/polyforge/config?cwd=… — the panel's configuration read
 *. Reads only through pf; every degradation (pf absent, below
 * the capability floor, an old list shape, daemon down, an unmapped cwd) is
 * a 200 field, never 5xx. The in-route isApiRequestAllowed check is the
 * authenticated-surface gate (the proxy still enforces PI_WEB_PASSWORD).
 *
 * POST /api/polyforge/config — the write path. Exactly the panel's allowlist;
 * every mutation goes through `pf`, api_key on stdin only, and a refusal is
 * pf's own 4xx envelope with the key-level diff.
 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cwd = new URL(request.url).searchParams.get("cwd") ?? "";
  try {
    return NextResponse.json(await readPolyforgeConfig(cwd));
  } catch {
    return NextResponse.json({
      pfPresent: false,
      pfVersion: null,
      capable: false,
      reason: "the configuration read failed; polyforge may be unavailable",
      items: [],
      mapped: false,
    });
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  try {
    return NextResponse.json(await writePolyforgeConfig(body as ConfigWriteRequest));
  } catch (error) {
    if (error instanceof ConfigWriteError) {
      return NextResponse.json({ error: error.message, ...(error.diff !== undefined ? { diff: error.diff } : {}) }, { status: error.status });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "polyforge is unavailable" }, { status: 400 });
  }
}
