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

test("the list view carries the new-message entry and an open conversation uses its peer", () => {
  assert.match(source, /if \(!selectedConversation\) \{/, "the list view has its own branch (including the empty state)");
  assert.match(source, /const renderComposer = \(recipientField: React\.ReactNode\) => \(/);
  assert.match(source, /<input value=\{newRecipient\} onChange=\{\(event\) => setNewRecipient\(event\.target\.value\)\}/);
  assert.match(source, /const recipient = selectedConversation \? \(selectedPeer \|\| lastPeer\) : "";/);
  assert.match(source, /<input value=\{recipient\} onChange=\{\(\) => undefined\}/, "the open conversation's recipient is not a free field");
  assert.match(source, /aria-readonly="true"/);
  assert.match(source, /const target = selectedConversation \? recipient : newRecipient\.trim\(\);/);
});

test("a loaded original renders as a quote and an unloaded one as its id", () => {
  assert.match(source, /const replyOriginal = replyTo \? messages\.find\(\(message\) => message\.id === replyTo\) : undefined;/);
  assert.match(source, /\{replyOriginal && \(/);
  assert.match(source, /\{original \? original\.text : message\.reply_to\}/, "the history falls back to the id only when the original is unloaded");
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
  assert.match(source, /messages\.map\(\(message\) => \{/, "the history maps the chronological array");
});

test("the composer, reply and analyzer controls carry the tested accessible labels", () => {
  for (const key of ["recipient", "anchor", "text", "send", "reply", "analyze"]) {
    assert.match(source, new RegExp(`polyforge\\.messages\\.${key}`), `${key} label exists`);
  }
  assert.match(source, /<textarea/, "the message body is a textarea");
  assert.match(source, /onSubmit=\{\(event\) => void submit\(event\)\}/);
});

test("below the floor the panel shows the upgrade state and spawns nothing", () => {
  assert.match(source, /if \(!capable\) \{/);
  assert.match(source, /polyforge\.messages\.upgrade/);
  assert.match(source, /reason \?\? t\("polyforge\.messages\.upgradeReason"\)/);
  assert.doesNotMatch(source, /from "@\/hooks\/useAgentSession"/, "incoming messages never enter a chat session");
});
