import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { probePolyforgePresent } from "@/lib/polyforge-status";
import { execFileAsync } from "@/lib/exec-file";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  CHAT_ID_TIMEOUT_MS,
  chatInitArgv,
  createSessionChatIdResolver,
} from "@/lib/session-chat-id";

export const dynamic = "force-dynamic";

/**
 * GET /api/sessions/[id]/chat-id — the polyforge chat id of a LIVE session
 * in this server (pi#121), for the display-only ` · <id>` suffix on the
 * pane/session tab labels and the mobile current-session element.
 *
 * Degradation-first like the polyforge routes: pf absent, daemon
 * unreachable, a bad token shape, a timeout, or a session this server
 * never started or attached all answer 200 `{chatId: null}` — no 4xx/5xx,
 * no error text (the suffix is cosmetic; the e2e suite treats any 5xx and
 * any non-2xx fetch console noise as failures). The only non-2xx path is
 * the host/origin gate every route re-checks (403 JSON, like the
 * polyforge routes). The id is shape-validated (`isChatIdToken`) before
 * it can reach a response, and pf's stderr never reaches the client.
 */
const resolveSessionChatId = createSessionChatIdResolver({
  present: probePolyforgePresent,
  isLiveSession: (sessionId) => Boolean(getRpcSession(sessionId)),
  spawnChatInit: async (sessionId) => {
    const { stdout } = await execFileAsync("pf", chatInitArgv(sessionId), {
      timeout: CHAT_ID_TIMEOUT_MS,
    });
    return stdout;
  },
}).resolve;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  let chatId: string | null = null;
  try {
    chatId = await resolveSessionChatId(id);
  } catch {
    // resolve itself never throws, but the route's 2xx contract must not
    // depend on that: absent, never an error surface.
    chatId = null;
  }
  return NextResponse.json({ chatId });
}