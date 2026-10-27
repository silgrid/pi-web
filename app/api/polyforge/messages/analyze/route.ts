import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  analyzePolyforgeMessage,
  isPolyforgeMessageId,
  PolyforgeMessagesError,
  messageErrorStatus,
  readPolyforgeMessagesCapability,
} from "@/lib/polyforge-messages";

export const dynamic = "force-dynamic";

/**
 * POST /api/polyforge/messages/analyze — the read-only analyzer one-shot for
 * one received message. JSON-only; the message id is validated before any
 * spawn. The conclusion exists only in this response: nothing is written,
 * persisted or logged. pf's typed failure (DAEMON-409/500, unreachable
 * daemon) surfaces as its documented text — DAEMON-500/unavailable answers
 * 200 `{error}` because this repo's routes never answer 5xx.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: { message_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!isPolyforgeMessageId(body.message_id)) {
    return NextResponse.json({ error: "message_id must be a message id" }, { status: 400 });
  }
  const capability = await readPolyforgeMessagesCapability();
  if (!capability.capable) {
    return NextResponse.json(
      { error: capability.reason ?? "polyforge messages are unavailable" },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({ ok: true, ...(await analyzePolyforgeMessage(body.message_id)) });
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
