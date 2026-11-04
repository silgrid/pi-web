import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readPolyforgeWorkflows } from "@/lib/polyforge-workflows";

export const dynamic = "force-dynamic";

/**
 * GET /api/polyforge/workflows?cwd=… — the Settings › Polyforge workflow
 * card's read: makes it the union of every
 * cli.toml-mapped workspace — one `pf --json config list` for the mapping,
 * then per mapped workspace `pf --json workflows --cwd W` plus
 * `pf --json config workspace --cwd W`, all spawned afresh on every call
 * (each ↻ click is a fresh read, no module cache; never one spawn per
 * project). `workspaces[]` carries each workspace's reads or its failure
 * reason; the top-level `workflows`/`workspace` stay the settings cwd's own.
 * A machine with no mapping reads the cwd alone. Read-only: this route
 * exports GET alone, so any other method is 405; step-chain and attr writes
 * go through POST /api/polyforge/config with the owning workspace's cwd.
 * Degradation-first: pf absent, below the 2.20.15 floor, an unreachable
 * daemon or a failed read all answer 200 with the reason as a field — never
 * 5xx; the only non-2xx answer is the gate's 403.
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
