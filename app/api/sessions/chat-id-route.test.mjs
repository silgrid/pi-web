import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// Flat test file (the repo convention: tests avoid the [id] bracket dirs
// so the `app/**/*.test.mjs` glob stays a plain path match).
const routeUrl = new URL("./[id]/chat-id/route.ts", import.meta.url);
const routeSource = await readFile(routeUrl, "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getChatId } = await jiti.import("./[id]/chat-id/route.ts");

// The host/origin gate every route re-checks (lib/request-security.ts):
// a loopback host is allowed; a foreign hostname is refused.
const allowedRequest = (sessionId) => new Request(
  `http://127.0.0.1:30141/api/sessions/${sessionId}/chat-id`,
  { headers: { host: "127.0.0.1:30141" } },
);
const refusedRequest = (sessionId) => new Request(
  `http://evil.example/api/sessions/${sessionId}/chat-id`,
  { headers: { host: "evil.example" } },
);

test("re-checks isApiRequestAllowed in-route and answers 403 JSON on refusal", async () => {
  assert.match(routeSource, /isApiRequestAllowed\(request\)/, "the host/origin gate is re-checked in-route");
  assert.match(routeSource, /\{ error: "Forbidden" \}, \{ status: 403 \}/, "refusal answers 403 JSON");
  const response = await getChatId(refusedRequest("sess-1"), { params: Promise.resolve({ id: "sess-1" }) });
  assert.equal(response.status, 403);
});

test("degradation-first: a session with no live wrapper answers 200 with no chat id", async () => {
  // No wrapper exists for this id in the test process, so the live gate
  // refuses before any presence probe or spawn: absent, never an error.
  const response = await getChatId(allowedRequest("no-such-live-session"), {
    params: Promise.resolve({ id: "no-such-live-session" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { chatId: null });
});

test("no 5xx path, GET-only, the rpc-manager live gate, and shape validation", async () => {
  assert.doesNotMatch(routeSource, /status: 5\d\d/, "never 5xx (the e2e suite treats any 5xx as a browser error)");
  assert.match(routeSource, /export async function GET\(/, "GET is the only method");
  assert.doesNotMatch(routeSource, /export async function (POST|PUT|DELETE|PATCH)/, "the route stays read-only");
  // The live gate is the rpc-manager wrapper, exactly as the memo scopes it.
  assert.match(routeSource, /getRpcSession\(sessionId\)/, "the live gate is the rpc-manager wrapper");
  assert.match(routeSource, /createSessionChatIdResolver/, "resolution goes through the session-chat-id resolver");
  const libSource = await readFile(new URL("../../../lib/session-chat-id.ts", import.meta.url), "utf8");
  assert.match(libSource, /isChatIdToken/, "the token shape is validated before it can reach a response");
});