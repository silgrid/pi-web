import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const list = await read("./messages/route.ts");
const history = await read("./messages/[id]/route.ts");
const ack = await read("./messages/ack/route.ts");
const analyze = await read("./messages/analyze/route.ts");
const lib = await read("../../../lib/polyforge-messages.ts");

test("every messages route re-checks isApiRequestAllowed in-route", () => {
  for (const [name, source] of [["list", list], ["history", history], ["ack", ack], ["analyze", analyze]]) {
    assert.match(source, /import \{[^}]*isApiRequestAllowed[^}]*\} from "@\/lib\/request-security"/, `${name} imports the gate`);
    assert.match(source, /if \(!isApiRequestAllowed\(request\)\)/, `${name} checks the gate in the route`);
    assert.match(source, /status: 403/, `${name} answers a JSON 403`);
  }
});

test("writes are JSON-only POSTs and validate before the pf spawn", () => {
  for (const [name, source, validator] of [
    ["send", list, /validateSendInput\(body\)/],
    ["ack", ack, /isPositiveSeq\(body\.seq\)/],
    ["analyze", analyze, /isPolyforgeMessageId\(body\.message_id\)/],
  ]) {
    assert.match(source, /hasJsonContentType\(request\)/, `${name} is JSON-only`);
    assert.match(source, /status: 415/, `${name} refuses another content type`);
    const check = source.search(validator);
    const spawn = source.search(/sendPolyforgeMessage\(|acknowledgePolyforgeMessage\(|analyzePolyforgeMessage\(/);
    assert.ok(check >= 0, `${name} validates its body`);
    assert.ok(check < spawn, `${name} validates before the spawn`);
  }
});

test("no messages route answers 5xx and no route logs a request or response body", () => {
  for (const [name, source] of [["list", list], ["history", history], ["ack", ack], ["analyze", analyze]]) {
    assert.doesNotMatch(source, /status:\s*5\d\d/, `${name} carries no 5xx literal`);
    assert.doesNotMatch(source, /console\.(log|error|warn)/, `${name} never logs`);
    assert.doesNotMatch(source, /sender_id|members/, `${name} never echoes the identity fields`);
    assert.doesNotMatch(source, /code:\s*"/, `${name} answers {error} without an invented code field`);
  }
  assert.match(lib, /messageErrorStatus/, "the one status mapping lives in the lib");
  assert.match(lib, /rawBefore|before/, "the history read forwards a validated cursor");
});

test("the wire whitelist drops sender_id/members and the sanitizer never exposes an id", () => {
  assert.match(lib, /sender_id/);
  assert.match(lib, /members/);
  assert.match(lib, /sanitizeConversation/);
  assert.match(lib, /sanitizeMessage/);
  assert.doesNotMatch(lib, /preview\?|conversation\.preview|newest message as a list preview/, "the unrequested preview and its per-conversation spawn are gone");
  assert.doesNotMatch(lib, /PF-UNAVAILABLE/, "no invented unavailable code");
  assert.doesNotMatch(lib, /console\.(log|error|warn)/, "the lib never logs a body, credential or env value");
});

test("a list-read failure stays capable so no false upgrade state replaces an open conversation", () => {
  const start = lib.indexOf("export async function readPolyforgeMessages");
  const end = lib.indexOf("export async function readPolyforgeMessagesPage", start);
  const read = lib.slice(start, end);
  assert.match(read, /capable: true,\s*error: error instanceof Error/);
  assert.match(read, /conversations: \[\]/, "a failed poll returns an empty list, not a capability downgrade");
  assert.match(list, /capable: true,\s*error: "the messages read failed/, "the route's catch does not invent a floor state");
});

test("the list route's answer carries contacts on every branch", () => {
  assert.match(list, /configured `contacts`/, "the GET face documents the contacts field");
  assert.match(list, /conversations: \[\],\s*contacts: \[\],/, "the route's catch answers an empty contact set too");
  const start = lib.indexOf("export async function readPolyforgeMessages(");
  const end = lib.indexOf("export async function readPolyforgeMessagesPage", start);
  const read = lib.slice(start, end);
  assert.match(read, /return \{ \.\.\.capability, conversations: \[\], contacts: \[\] \};/, "below the floor no contact read starts");
  assert.equal((read.match(/contacts: await contactsRead/g) ?? []).length, 2, "both the list-failure and success answers carry the contact read");
  assert.match(lib, /runPfJson\(\["--json", "msg", "contacts"\], CONTACT_READ_TIMEOUT_MS\)/, "one bounded `pf --json msg contacts` spawn");
  assert.match(lib, /const CONTACT_READ_TIMEOUT_MS = 2000;/, "the contact read is bounded well below the 15 s read timeout");
});
