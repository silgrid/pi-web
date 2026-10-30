import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const lib = await jiti.import("./polyforge-messages.ts");
const pure = await jiti.import("./polyforge-messages-pure.ts");

test("the Messages floor is 2.20.12 and below it the capability rep says upgrade", async () => {
  // the contact list needs `pf msg contacts` (2.20.12).
  assert.equal(lib.POLYFORGE_MESSAGES_MINIMUM_PF_VERSION, "2.20.12");
  const detect = await jiti.import("./polyforge-detect.ts");
  assert.equal(detect.isPolyforgeVersionBelowMinimum("v2.20.6", lib.POLYFORGE_MESSAGES_MINIMUM_PF_VERSION), true);
  // Numeric compare: 2.20.9 < 2.20.12, no string trap.
  assert.equal(detect.isPolyforgeVersionBelowMinimum("v2.20.9", lib.POLYFORGE_MESSAGES_MINIMUM_PF_VERSION), true);
  assert.equal(detect.isPolyforgeVersionBelowMinimum("v2.20.11", lib.POLYFORGE_MESSAGES_MINIMUM_PF_VERSION), true);
  assert.equal(detect.isPolyforgeVersionBelowMinimum("v2.20.12", lib.POLYFORGE_MESSAGES_MINIMUM_PF_VERSION), false);
});

test("the floor has exactly one capability gate and no alternate below-floor read path", () => {
  const source = readFileSync(new URL("./polyforge-messages.ts", import.meta.url), "utf8");
  const uses = source.split("POLYFORGE_MESSAGES_MINIMUM_PF_VERSION").length - 1;
  assert.equal(uses, 3, "definition + the single gate's compare and reason string");
  assert.equal(source.split("readPolyforgeMessagesCapability").length - 1, 2, "one gate, defined and named once each");
  // No degraded/read-only or id-based read path exists below the floor.
  assert.doesNotMatch(source, /degraded[_ ]?mode|read-only[_ ]?mode|fallback/);
});

test("sanitizers filter membership and derive peer/mine without exposing ids or credentials", () => {
  const conversation = lib.sanitizeConversation({
    id: "conv_1", kind: "direct", members: ["u_self", "u_peer"], peer: "u_peer",
    member_names: { u_self: "Self Name", u_peer: "Peer Name", u_third: "Third Name" },
    last_seq: 9, unread: 2, created_at: "2026-10-01T00:00:00Z", preview: "hi",
    server: "http://10.0.0.1", api_key: "SECRET",
  }, "u_self");
  assert.deepEqual(Object.keys(conversation).sort(), ["created_at", "id", "kind", "last_seq", "peer", "peer_name", "unread"]);
  assert.equal(conversation.peer, "u_peer", "the peer is derived from members");
  assert.equal(conversation.peer_name, "Peer Name", "only the peer's own member_names key is read");
  const wire = JSON.stringify(conversation);
  assert.ok(!wire.includes("u_self"), "the caller's own id never leaves");
  assert.ok(!wire.includes("Self Name"), "the caller's own name never leaves");
  assert.ok(!wire.includes("Third Name"), "a non-member's name never leaves");
  // A missing member_names (old-aihub transient) and a non-string/absent
  // value both read as "" — the unknown-user placeholder, never an id.
  const noNames = lib.sanitizeConversation({
    id: "conv_1", kind: "direct", members: ["u_self", "u_peer"], last_seq: 9, unread: 0,
  }, "u_self");
  assert.equal(noNames.peer_name, "");
  const emptyName = lib.sanitizeConversation({
    id: "conv_1", kind: "direct", members: ["u_self", "u_peer"],
    member_names: { u_peer: "" }, last_seq: 9, unread: 0,
  }, "u_self");
  assert.equal(emptyName.peer_name, "");
  const nonString = lib.sanitizeConversation({
    id: "conv_1", kind: "direct", members: ["u_self", "u_peer"],
    member_names: { u_peer: 42 }, last_seq: 9, unread: 0,
  }, "u_self");
  assert.equal(nonString.peer_name, "");
  assert.equal(lib.sanitizeConversation({
    id: "conv_2", kind: "direct", members: ["u_other", "u_peer"], last_seq: 1, unread: 0,
  }, "u_self"), null, "a conversation the caller is not a member of is filtered");
  assert.equal(lib.sanitizeConversation({ id: "not-a-conv" }), null, "an invalid id drops the row");
  const message = lib.sanitizeMessage({
    id: "msg_1", seq: 3, conversation_id: "conv_1", sender_id: "u_peer", sender: "peer",
    text: "body", about_wi: "task-42", reply_to: "msg_0", created_at: "t", mine: true,
    server: "http://10.0.0.1",
  }, "u_self");
  assert.deepEqual(Object.keys(message).sort(), ["about_wi", "conversation_id", "created_at", "id", "mine", "reply_to", "seq", "text"]);
  assert.equal(message.conversation_id, "conv_1");
  assert.equal(message.mine, false, "mine comes from sender_id, not a stub-only sender/mine field");
  assert.ok(!JSON.stringify(message).includes("u_peer"));
  assert.equal(lib.sanitizeMessage({ id: "msg_2", seq: 4, text: "own", sender_id: "u_self" }, "u_self").mine, true);
  assert.equal(lib.sanitizeMessage({ id: "msg_3", seq: 5, text: "own", sender: "self" }).mine, false, "the stub marker is not trusted");
});

test("older pages prepend with no gap or duplicate and newest refreshes merge by id", () => {
  const msg = (seq) => ({ id: `msg_${seq}`, seq, text: `${seq}`, created_at: "", mine: false });
  const page = [71, 72, 73].map(msg);
  const older = [69, 70, 71].map(msg);
  const merged = pure.mergeOlderPage(page, older);
  assert.deepEqual(merged.map((m) => m.seq), [69, 70, 71, 72, 73], "ascending, duplicate 71 collapsed");
  assert.equal(new Set(merged.map((m) => m.seq)).size, merged.length, "no duplicate");
  const newest = [73, 74].map(msg);
  const refreshed = pure.mergeNewestPage(merged, newest);
  assert.deepEqual(refreshed.map((m) => m.seq), [69, 70, 71, 72, 73, 74]);
});

test("ackDecision: visible newest-displayed seq only; hidden/blocked suppress auto; explicit bypasses", () => {
  const base = {
    panelOpen: true, activeTab: "messages", conversationId: "conv_1",
    blocked: false, newestDisplayedSeq: 12, lastAckedSeq: 11,
  };
  assert.equal(pure.ackDecision(base), 12);
  assert.equal(pure.ackDecision({ ...base, panelOpen: false }), null, "closed panel never auto-acks");
  assert.equal(pure.ackDecision({ ...base, activeTab: "jobs" }), null, "another tab never auto-acks");
  assert.equal(pure.ackDecision({ ...base, blocked: true }), null, "a blocked job suppresses auto-ack");
  assert.equal(pure.ackDecision({ ...base, newestDisplayedSeq: 11 }), null, "already-acked seq is not repeated");
  assert.equal(pure.ackDecision({ ...base, newestDisplayedSeq: 13, lastAckedSeq: 12 }), 13, "the unseen 13 is not used while 12 is displayed");
  assert.equal(pure.ackDecision({ ...base, blocked: true, explicit: true }), 12, "an explicit gesture still acks");
});

test("splitAnchor exposes only the work-item part and leaves the rest as text", () => {
  assert.deepEqual(pure.splitAnchor("task-42/artifacts/spec.md"), { ref: "task-42", rest: "/artifacts/spec.md" });
  assert.deepEqual(pure.splitAnchor("task-42"), { ref: "task-42", rest: "" });
  assert.deepEqual(pure.splitAnchor("pi#108"), { ref: "pi#108", rest: "" });
  assert.deepEqual(pure.splitAnchor("no anchor here"), { ref: "", rest: "no anchor here" });
});

test("layout identity helpers: name, initial, colour, sections", () => {
  // conversationName: the trimmed peer display name; "" for absent, empty
  // and blank — the caller renders the placeholder, never an id.
  const named = { id: "conv_1", kind: "direct", peer: "u_peer", peer_name: "Alice Chen", last_seq: 1, unread: 0, created_at: "" };
  assert.equal(pure.conversationName(named), "Alice Chen");
  assert.equal(pure.conversationName({ ...named, peer_name: "  " }), "");
  assert.equal(pure.conversationName({ ...named, peer_name: undefined }), "");
  assert.equal(pure.conversationName({ id: "conv_1", kind: "direct", last_seq: 1, unread: 0, created_at: "" }), "");
  // avatarInitial: the first code point upper-cased, "?" for no name.
  assert.equal(pure.avatarInitial("alice chen"), "A");
  assert.equal(pure.avatarInitial("béa"), "B");
  assert.equal(pure.avatarInitial("😀emoji"), "😀");
  assert.equal(pure.avatarInitial(""), "?");
  assert.equal(pure.avatarInitial("   "), "?");
  // avatarColor: deterministic, differs across seeds, a CSS colour string
  // that never renders the seed.
  const red = pure.avatarColor("u_a");
  assert.equal(pure.avatarColor("u_a"), red);
  assert.notEqual(pure.avatarColor("u_b"), red);
  assert.match(red, /^hsl\(\d+, 45%, 45%\)$/);
  assert.ok(!red.includes("u_a"));
  // groupConversations: direct vs any other kind, order preserved.
  const group = { id: "conv_g", kind: "group", last_seq: 0, unread: 0, created_at: "" };
  const second = { id: "conv_2", kind: "direct", last_seq: 0, unread: 0, created_at: "" };
  const sections = pure.groupConversations([named, group, second]);
  assert.deepEqual(sections.direct.map((c) => c.id), ["conv_1", "conv_2"]);
  assert.deepEqual(sections.groups.map((c) => c.id), ["conv_g"]);
});

test("send validation happens before any spawn; errors map to 4xx and never 5xx", () => {
  assert.equal(lib.validateSendInput({ to: "u_peer", text: "hi" }).ok, true);
  assert.equal(lib.validateSendInput({ to: "-bad", text: "hi" }).ok, false);
  assert.equal(lib.validateSendInput({ to: "u_peer", text: "  " }).ok, false);
  assert.equal(lib.validateSendInput({ to: "u_peer", text: "hi", reply_to: "not-a-message" }).ok, false);
  assert.equal(lib.validateSendInput({ to: "u_peer", text: "hi", about_wi: "bad\nanchor" }).ok, false);
  assert.equal(lib.validateSendInput({ to: "u_peer", text: "hi", about_wi: "x".repeat(201) }).ok, false);
  assert.equal(lib.messageErrorStatus("CORE-422"), 422);
  assert.equal(lib.messageErrorStatus("CORE-404"), 404);
  assert.equal(lib.messageErrorStatus("DAEMON-409"), 409);
  assert.equal(lib.messageErrorStatus("DAEMON-500"), 200, "no 5xx: the analyzer failure is a 200 error field");
  assert.equal(lib.messageErrorStatus(""), 200, "an untyped/unreachable pf is a 200 error field, not an invented code");
});

test("contacts sanitize to exactly id + trimmed display_name; blank names stay blank", () => {
  const contacts = lib.sanitizeContactsAnswer({
    contacts: [
      { id: "u_ava", display_name: "  Ava Stone ", type: "human", role: "writer", email: "a@example.com" },
      { id: "u_blank", display_name: "" },
      { id: "u_nonstring", display_name: 42 },
      { id: "-bad", display_name: "Bad" },
      { display_name: "No Id" },
      "not-an-object",
    ],
    total: 9,
  });
  assert.deepEqual(contacts, [
    { id: "u_ava", display_name: "Ava Stone" },
    { id: "u_blank", display_name: "" },
    { id: "u_nonstring", display_name: "" },
  ]);
  assert.deepEqual(lib.sanitizeContactsAnswer({ contacts: "nope" }), []);
  assert.deepEqual(lib.sanitizeContactsAnswer(null), []);
});

test("directRows: conversation rows first in order, then silent contacts by name, one row per peer", () => {
  const conv = (id, peer, peer_name, kind = "direct") => ({ id, kind, peer, peer_name, last_seq: 1, unread: 1, created_at: "" });
  const dot = conv("conv_dot", "u_dot", "Dot");
  const ava = conv("conv_ava", "u_ava", "Ava");
  const group = conv("conv_g", undefined, undefined, "group");
  const rows = pure.directRows([dot, group, ava], [
    { id: "u_zoe", display_name: "Zoe" },
    { id: "u_ava", display_name: "Ava" },
    { id: "u_blank", display_name: "" },
    { id: "u_ben", display_name: "Ben" },
    { id: "u_zoe", display_name: "Zoe again" },
  ]);
  assert.deepEqual(rows.map((row) => row.kind === "conversation" ? row.conversation.id : row.contact.id),
    ["conv_dot", "conv_ava", "u_ben", "u_zoe", "u_blank"],
    "direct conversations keep their order; silent contacts follow by name, blank last; no group row; no duplicate peer");
  assert.equal(rows[0].conversation.unread, 1, "unread rides the conversation row unchanged");
  assert.deepEqual(pure.directRows([], []), []);
  assert.deepEqual(pure.directRows([], [{ id: "u_a", display_name: "A" }]).map((row) => row.kind), ["contact"],
    "with no conversation at all every contact still renders");
});

// A stub `pf` on PATH: the version, the list and the contact read are driven
// by a mode file so one process can exercise the read's isolation.
function contactsStub(t) {
  const work = mkdtempSync(join(tmpdir(), "pf-messages-contacts-"));
  const mode = join(work, "mode.json");
  const argvLog = join(work, "argv.log");
  writeFileSync(argvLog, "");
  writeFileSync(join(work, "pf"), `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + "\\n");
const m = JSON.parse(fs.readFileSync(${JSON.stringify(mode)}, "utf8"));
const rest = args.filter((a) => a !== "--json");
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (args.includes("--version")) { process.stdout.write(m.version + "\\n"); process.exit(0); }
if (rest[0] === "config") out({ items: [{ key: "user_id", value: "u_self" }] });
if (rest[0] === "msg" && rest[1] === "contacts") {
  if (m.contactsFail) { process.stderr.write("CORE-503: contacts are unavailable\\n"); process.exit(1); }
  out({ contacts: [{ id: "u_ava", display_name: "Ava", type: "human" }] });
}
if (rest[0] === "msg" && rest[1] === "list") {
  if (m.listFail) { process.stderr.write("AUTH-401: bad key\\n"); process.exit(1); }
  out({ conversations: [{ id: "conv_1", kind: "direct", members: ["u_self", "u_peer"], member_names: { u_peer: "Peer" }, last_seq: 2, unread: 1 }] });
}
process.exit(2);
`);
  chmodSync(join(work, "pf"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${work}${delimiter}${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(work, { recursive: true, force: true }); });
  return {
    set: (value) => writeFileSync(mode, JSON.stringify({ version: "v2.20.12", ...value })),
    calls: () => readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    reset: () => writeFileSync(argvLog, ""),
  };
}

test("the messages read carries contacts; a contact failure leaves conversations, capable and error untouched", async (t) => {
  const stub = contactsStub(t);
  const status = await jiti.import("./polyforge-status.ts");

  stub.set({});
  await status.probePolyforgeVersion(true);
  const ok = await lib.readPolyforgeMessages();
  assert.equal(ok.capable, true);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.conversations.map((c) => c.id), ["conv_1"]);
  assert.deepEqual(ok.contacts, [{ id: "u_ava", display_name: "Ava" }], "contacts are sanitized to id + display_name");

  stub.set({ contactsFail: true });
  const failed = await lib.readPolyforgeMessages();
  assert.deepEqual(failed.contacts, [], "a failed contact read is an empty set");
  assert.equal(failed.capable, true, "a contact failure is not a capability downgrade");
  assert.equal(failed.error, undefined, "a contact failure never becomes the messages error");
  assert.equal(failed.reason, undefined);
  assert.deepEqual(failed.conversations, ok.conversations, "the conversation rows survive a contact failure");

  stub.set({ listFail: true });
  const listFailed = await lib.readPolyforgeMessages();
  assert.match(listFailed.error ?? "", /bad key/, "a list failure keeps its own error");
  assert.deepEqual(listFailed.contacts, [{ id: "u_ava", display_name: "Ava" }], "the contact read is independent of the list read");

  stub.set({ version: "v2.20.11" });
  await status.probePolyforgeVersion(true);
  stub.reset();
  const below = await lib.readPolyforgeMessages();
  assert.equal(below.capable, false);
  assert.match(below.reason ?? "", /2\.20\.12/);
  assert.deepEqual(below.contacts, []);
  assert.equal(stub.calls().filter((argv) => argv.includes("msg")).length, 0, "below the floor no message or contact verb spawns");
});
