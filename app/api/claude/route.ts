import { NextResponse } from "next/server";
import { findClaudeBinary } from "@/lib/claude-session";
import { CLAUDE_MODELS, DEFAULT_CLAUDE_MODEL } from "@/lib/claude-shared";

export const dynamic = "force-dynamic";

// GET /api/claude - whether the claude harness can be offered (a `claude` on PATH)
// and the fixed model choices (the four full names and the default). Reads only: creates no directory, starts nothing and never
// reads a credential. Behind proxy.ts's password gate.
export async function GET() {
  const available = findClaudeBinary() !== null;
  return NextResponse.json({
    available,
    ...(available ? {} : { reason: "not-on-path" }),
    models: CLAUDE_MODELS,
    defaultModel: DEFAULT_CLAUDE_MODEL,
  }, { headers: { "Cache-Control": "no-store" } });
}
