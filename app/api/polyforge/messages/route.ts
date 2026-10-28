import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  PolyforgeMessagesError,
  messageErrorStatus,
  readPolyforgeMessages,
  readPolyforgeMessagesCapability,
  sendPolyforgeMessage,
  validateSendInput,
} from "@/lib/polyforge-messages";

export const dynamic = "force-dynamic";

/**
 * GET /api/polyforge/messages — the caller's member-only conversations plus
 * the Messages capability answer. Degradation-first: pf
 * absent, below the 2.20.10 floor, an unreadable list or an unreachable daemon
 * all answer 200 with fields, never 5xx. Below the floor no message verb is
 * spawned. The in-route gate is the authenticated-surface check every
 * polyforge route re-checks.
 *
 * POST /api/polyforge/messages — send one message. JSON-only; every value is
 * validated before the one `pf msg send` spawn. A refusal is pf's typed code
 * as a 4xx; DAEMON-500/unavailable answers 200 `{error}` (no 5xx).
 */
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    return NextResponse.json(await readPolyforgeMessages());
  } catch {
    // A capability probe can only throw unexpectedly; keep the read
    // degraded (200, capable so an open conversation stays rendered) and
    // reserve `capable:false` for pf absent or below the floor.
    return NextResponse.json({
      pfPresent: true,
      pfVersion: null,
      capable: true,
      error: "the messages read failed; polyforge may be unavailable",
      conversations: [],
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
  const validated = validateSendInput(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const capability = await readPolyforgeMessagesCapability();
  if (!capability.capable) {
    return NextResponse.json(
      { error: capability.reason ?? "polyforge messages are unavailable" },
      { status: 400 },
    );
  }
  try {
    const message = await sendPolyforgeMessage(validated.value);
    return NextResponse.json({ ok: true, message });
  } catch (error) {
    const failure = error instanceof PolyforgeMessagesError
      ? error
      : new PolyforgeMessagesError("polyforge is unavailable");
    return NextResponse.json(
      { error: failure.message },
      { status: messageErrorStatus(failure.code) },
    );
  }
}
