import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readPolyforgeWorkflows } from "@/lib/polyforge-workflows";

export const dynamic = "force-dynamic";

/**
 * GET /api/polyforge/workflows?cwd=… — the Settings › Polyforge workflow
 * card's read: `pf --json workflows --cwd` plus
 * `pf --json config workspace --cwd`, spawned afresh on every call (each ↻
 * click is a fresh read, no module cache). Read-only: this route exports GET
 * alone, so any other method is 405; step-chain and attr writes go through
 * POST /api/polyforge/config. Degradation-first: pf absent, below the 2.20.15
 * floor, an unreachable daemon or a failed read all answer 200 with the
 * reason as a field — never 5xx; the only non-2xx answer is the gate's 403.
 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const cwd = new URL(request.url).searchParams.get("cwd") ?? "";
  try {
    return NextResponse.json(await readPolyforgeWorkflows(cwd));
  } catch (error) {
    return NextResponse.json({
      pfPresent: false,
      pfVersion: null,
      capable: false,
      reason: error instanceof Error ? error.message : "the workflow read failed; polyforge may be unavailable",
      workflows: null,
      workspace: null,
    });
  }
}
