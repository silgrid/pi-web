import { NextResponse } from "next/server";
import { claudeConfigDir } from "@/lib/claude-config-dir";
import { findClaudeBinary } from "@/lib/claude-session";
import { CLAUDE_MODEL_ALIASES, CLAUDE_TOOL_PRESETS, DEFAULT_CLAUDE_TOOL_PRESET } from "@/lib/claude-shared";

export const dynamic = "force-dynamic";

// GET /api/claude - whether the claude harness can be offered (a `claude` on PATH),
// the dedicated config dir's path and the fixed choices. Reads only: creates no
// directory, starts nothing and never reads a credential. Behind proxy.ts's password gate.
export async function GET() {
  const available = findClaudeBinary() !== null;
  return NextResponse.json({
    available,
    ...(available ? {} : { reason: "not-on-path" }),
    configDir: claudeConfigDir(),
    modelAliases: CLAUDE_MODEL_ALIASES,
    presets: CLAUDE_TOOL_PRESETS,
    defaultPreset: DEFAULT_CLAUDE_TOOL_PRESET,
  }, { headers: { "Cache-Control": "no-store" } });
}
