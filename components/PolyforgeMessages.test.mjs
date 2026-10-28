import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./PolyforgeMessages.tsx", import.meta.url), "utf8");

test("the history opens at the newest page (bottom) and scroll-up asks for the page above", () => {
  assert.match(source, /element\.scrollTop = element\.scrollHeight;/, "the newest page is anchored at the bottom");
  assert.match(source, /if \(element\.scrollTop <= 4\) onLoadOlder\(\);/, "reaching the top loads the older page");
  assert.match(source, /mergeOlderPage|onLoadOlder/, "the page merge is the hook's pure helper");
  assert.match(source, /const atBottom = element\.scrollHeight - element\.clientHeight - element\.scrollTop < 24;/, "scroll-to-bottom is the explicit ack gesture");
});

test("opening positions at the newest page even when blocked; only arrivals are suppressed", () => {
  // Selection change and the first settled page always position the history.
  assert.match(source, /if \(!initialPageLoaded\) return;/);
  assert.match(source, /stickToBottomRef\.current = true;/);
  assert.match(source, /\}, \[selectedConversation, initialPageLoaded\]\);/);
  // The arrival effect is the only one gated by the blocked job.
  assert.match(source, /if \(!element \|\| blocked \|\| !stickToBottomRef\.current\) return;/);
  assert.match(source, /\}, \[messages, blocked\]\);/);
  assert.match(source, /const userScrolledRef = useRef\(false\);/);
  assert.match(source, /if \(atBottom && userScrolledRef\.current\)/);
  for (const gesture of ["onWheel", "onTouchMove", "onPointerDown", "onKeyDown"]) {
    assert.match(source, new RegExp(`${gesture}=\\{markUserScroll\\}`), `${gesture} marks a user scroll`);
  }
});

test("the panel is two columns: the list column right of the chat pane", () => {
  // row-reverse + DOM order [list, chat] keeps the column flush right while
  // the compose entry's fields stay first in DOM order.
  assert.match(source, /flexDirection: "row-reverse"/, "the column is the right-hand item");
  assert.match(source, /width: isMobile \? "100%" : "clamp\(120px, 35%, 220px\)",\s*flexShrink: 0/, "mobile fills the sheet; desktop keeps the clamped, never-shrinking width");
  assert.match(source, /borderLeft: isMobile \? "none" : "1px solid var\(--border\)"/, "no desktop divider on the mobile single view");
  assert.match(source, /\{showListColumn && listColumn\}\n      \{showChatPane && chatPane\}/, "the column and the pane are the two children");
  // Desktop keeps both columns at every dock width; mobile shows one view.
  assert.match(source, /const isMobile = useIsMobile\(\);/);
  assert.match(source, /const showListColumn = !isMobile \|\| !chatOpen;/, "mobile hides the list while a chat is open");
  assert.match(source, /const showChatPane = !isMobile \|\| chatOpen;/, "mobile shows the chat pane only while a chat is open");
  assert.match(source, /← \{t\("polyforge\.messages\.back"\)\}/, "the back control stays on the chat header");
});

test("the list column carries the compose entry, both sections and their placeholders", () => {
  assert.match(source, /\{t\("polyforge\.messages\.newMessage"\)\}/, "the compose entry sits at the top of the column");
  assert.match(source, /const sections = groupConversations\(conversations\);/);
  assert.match(source, /polyforge\.messages\.sectionDirect/, "the 单聊 section header renders");
  assert.match(source, /polyforge\.messages\.sectionGroups/, "the 群聊 section header renders");
  assert.match(source, /polyforge\.messages\.noGroups/, "尚无群聊 renders while the group section is empty");
  assert.match(source, /polyforge\.messages\.empty/, "the direct section's empty placeholder renders");
  assert.match(source, /textOverflow: "ellipsis", whiteSpace: "nowrap"/, "row names ellipsize");
});

test("every identity surface uses the display name and the unknown-user placeholder, never an id", () => {
  assert.match(source, /const name = conversationName\(conversation\);/, "rows read the pure name helper");
  assert.match(source, /\{name \|\| t\("polyforge\.messages\.unknownUser"\)\}/, "rows fall back to the placeholder, not an id");
  assert.match(source, /const headerName = selectedRow \? conversationName\(selectedRow\) : "";/);
  assert.match(source, /\{headerName \|\| t\("polyforge\.messages\.unknownUser"\)\}/, "the header never falls back to an id");
  assert.doesNotMatch(source, />\s*\{conversation\.peer/, "no row label falls back to the peer id");
  assert.doesNotMatch(source, /\?\? selectedConversation/, "no header label falls back to the conversation id");
  assert.match(source, /aria-hidden="true"/, "avatars are aria-hidden beside their visible name");
  // The open-conversation composer drops the read-only recipient field (the
  // peer id was visible there); the compose entry keeps the typed field.
  assert.match(source, /renderComposer\(null, "chat"\)/, "the open conversation's composer carries no recipient field");
  assert.match(source, /aria-label=\{t\("polyforge\.messages\.recipient"\)\}/, "the compose entry's typed recipient field");
});

test("own bubbles right without attribution; peer bubbles left with a first-of-run avatar and name", () => {
  assert.match(source, /alignSelf: message\.mine \? "flex-end" : "flex-start"/, "alignment is per message");
  assert.match(source, /const firstOfRun = index === 0 \|\| messages\[index - 1\]\.mine;/);
  assert.match(source, /\{!message\.mine && firstOfRun && \(/, "the attribution shows only on the first of a consecutive peer run");
  assert.match(source, /formatTimestamp\(message\.created_at\)/, "each bubble renders its timestamp");
  assert.match(source, /function formatTimestamp\(iso: string\): string \{/);
});

test("a loaded original renders as a quote and an unloaded one as its id", () => {
  assert.match(source, /const replyOriginal = replyTo \? messages\.find\(\(message\) => message\.id === replyTo\) : undefined;/);
  assert.match(source, /\{face === "chat" && replyOriginal && \(/, "the reply quote renders in the chat composer only");
  assert.match(source, /\{original \? <span>\{original\.text\}<\/span> : message\.reply_to\}/, "the history quotes the loaded original as its own text leaf, falling back to the id only when unloaded");
});

test("the analyzer control exists only on received messages and its conclusion is transient UI state", () => {
  assert.match(source, /\{!message\.mine && \(/);
  assert.match(source, /\{analyses\[message\.id\] && \(/);
  assert.doesNotMatch(source, /localStorage|sessionStorage\./, "the conclusion never reaches browser storage");
  assert.doesNotMatch(source, /fetch\(/, "the panel reads only through the hook's actions");
});

test("only the work-item part of an anchor is clickable and the rest is plain text", () => {
  assert.match(source, /const \{ ref, rest \} = splitAnchor\(anchor\);/);
  assert.match(source, /aria-label=\{ref\}/);
  assert.match(source, /\{rest && <span>\{rest\}<\/span>\}/);
  assert.doesNotMatch(source, /fetch\(|http/, "an anchor never fetches the referenced path");
});

test("unanchored messages are de-emphasized but keep their place in the list", () => {
  assert.match(source, /color: message\.about_wi \? "var\(--text\)" : "var\(--text-dim\)"/);
  assert.match(source, /messages\.map\(\(message, index\) => \{/, "the history maps the chronological array");
});

test("the composer, reply and analyzer controls carry the tested accessible labels", () => {
  for (const key of ["recipient", "anchor", "text", "send", "reply", "analyze"]) {
    assert.match(source, new RegExp(`polyforge\\.messages\\.${key}`), `${key} label exists`);
  }
  assert.match(source, /<textarea/, "the message body is a textarea");
  assert.match(source, /onSubmit=\{\(event\) => void submit\(event, face\)\}/, "each form names its face");
});

test("below the floor the panel shows the upgrade state and spawns nothing", () => {
  assert.match(source, /if \(!capable\) \{/);
  assert.match(source, /polyforge\.messages\.upgrade/);
  assert.match(source, /reason \?\? t\("polyforge\.messages\.upgradeReason"\)/);
  assert.doesNotMatch(source, /from "@\/hooks\/useAgentSession"/, "incoming messages never enter a chat session");
});

test("the recipient picker offers exactly the existing peers; first contact stays typed", () => {
  assert.match(source, /aria-label=\{t\("polyforge\.messages\.recipientPick"\)\}/, "the picker group carries its own label");
  assert.match(source, /\{conversations\.map\(\(conversation\) => \{/, "the picker renders exactly the conversations — no other source");
  assert.match(source, /key=\{conversation\.id\}/, "picker rows are keyed by conversation id");
  assert.match(source, /onClick=\{\(\) => \{ setPicked\(conversation\.id\); setNewRecipient\(""\); \}\}/, "picking targets that conversation");
  assert.match(source, /const target = face === "chat"\s*\? recipient\s*: \(picked \? pickedPeer : newRecipient\.trim\(\)\);/, "the chat composer sends to the open peer; the entry to a picked peer or the typed id — regardless of what is open beside it");
  assert.match(source, /const pickedRow = picked \? conversations\.find\(\(conversation\) => conversation\.id === picked\) : undefined;/);
  assert.match(source, /const pickedPeer = pickedRow\?\.peer \?\? "";/, "a picked peer that disappears falls back to nothing picked");
  // The typed-id path still exists; typing picks nothing.
  assert.match(source, /onChange=\{\(event\) => \{ setPicked\(null\); setNewRecipient\(event\.target\.value\); \}\}/);
  assert.match(source, /aria-label=\{t\("polyforge\.messages\.recipient"\)\}/, "the typed recipient field stays");
  // No directory: no /users-style route call, no fetch anywhere in the component
  // (the other tests already pin the no-fetch rule).
  assert.doesNotMatch(source, /"\/users|'\/users|`\/users/);
});

test("opening the tab renders the select-a-conversation empty state and nothing else", () => {
  assert.match(source, /const chatOpen = selectedConversation !== null;/);
  assert.match(source, /const chatPane = !chatOpen \? \(\n    <div style=\{\{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var\(--text-dim\)", fontSize: 12, padding: 16 \}\}>\n      \{t\("polyforge\.messages\.select"\)\}/, "the empty state is the chat pane with nothing open");
  // The history region and the composer render only inside the open branch.
  assert.match(source, /chatOpen \? \(/);
});

test("each face owns its draft; the compose entry never sends a reply target (task-42 the review finding)", () => {
  // The chat composer and the 新消息 compose entry shared one text/anchor/
  // error/reply state, so both textareas mirrored each other and a
  // compose-entry send carried the open conversation's --reply-to to another
  // peer (aihub refuses a reply outside its conversation).
  assert.match(source, /function useDraft\(\) \{/, "a face's draft is its own hook state");
  assert.match(source, /const chatDraft = useDraft\(\);\s*const composeDraft = useDraft\(\);/, "the two faces hold separate drafts");
  assert.doesNotMatch(source, /value=\{text\}/, "no textarea reads a shared draft text state");
  assert.match(source, /<textarea value=\{draft\.text\}/, "each face's textarea reads its own draft");
  assert.match(source, /\.\.\.\(face === "chat" && replyTo \? \{ replyTo \} : \{\}\),/, "only the chat face carries a reply target");
  assert.match(source, /const draft = face === "chat" \? chatDraft : composeDraft;/, "each face reads its own draft");
  // The reply quote and the reply state belong to the chat face only.
  assert.match(source, /if \(face === "chat"\) setReplyTo\(null\);/);
  assert.match(source, /\/\/ The reply target belongs to the chat face only/, "the reply state is documented chat-only");
});

test("each composer clears its own face on submit and restores the attempt on a refusal", () => {
  // A rendered message body must always mean the message reached the
  // history — never an in-flight composer echo — and a refusal restores the
  // attempt only on the face it was typed in.
  assert.match(source, /const attempt = \{ text: draft\.text, anchor: draft\.anchor, newRecipient: face === "compose" \? newRecipient : "", picked: face === "compose" \? picked : null \};/);
  assert.match(source, /draft\.setText\(""\);\s*draft\.setAnchor\(""\);/, "the face's draft clears when its send is accepted for submission");
  assert.match(source, /draft\.setText\(attempt\.text\);/, "a refusal restores the attempt on its own face");
});
