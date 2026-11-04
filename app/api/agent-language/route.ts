import { NextResponse } from "next/server";
import type { AgentLanguageResponse } from "@/lib/api-types";
import { isAgentLanguage } from "@/lib/agent-language";
import { readStoredAgentLanguage, writeStoredAgentLanguage } from "@/lib/agent-language-config";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET/PUT /api/agent-language: the server-side Agent language that
// new pi and claude sessions capture. The only writer of `pi-web-settings.json`.
// Reached through the proxy's `/api/*` authentication (PI_WEB_PASSWORD when set);
// the PUT also refuses an untrusted (cross-site / foreign host) request itself.

function failure(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export async function GET() {
  return NextResponse.json({ language: readStoredAgentLanguage() } satisfies AgentLanguageResponse);
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return failure(403, "Untrusted API request");
  if (!hasJsonContentType(req)) return failure(415, "Content-Type must be application/json");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return failure(400, "Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return failure(400, "Expected a JSON object");
  }
  const keys = Object.keys(body);
  const language = (body as { language?: unknown }).language;
  if (keys.length !== 1 || keys[0] !== "language" || !isAgentLanguage(language)) {
    return failure(400, "Expected { language: \"en\" | \"zh-CN\" }");
  }
  try {
    return NextResponse.json({ language: await writeStoredAgentLanguage(language) } satisfies AgentLanguageResponse);
  } catch (error) {
    return failure(500, error instanceof Error ? error.message : String(error));
  }
}
