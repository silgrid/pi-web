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
  // it stays first in DOM order.
  assert.match(source, /flexDirection: "row-reverse"/, "the column is the right-hand item");
  // owner 有意变更: mobile keeps the desktop two-pane
  // layout at every width (was a single-view switch), and owner 有意变更
  // desktop replaces the fixed clamp with the resizer's stored
  // width; mobile keeps the clamp and gets no handle.
  assert.match(source, /width: isMobile \? "clamp\(120px, 35%, 220px\)" : "var\(--pf-messages-list-width\)"/, "desktop width is the resizer variable; mobile keeps the clamp");
  assert.match(source, /borderLeft: "1px solid var\(--border\)",\s*overflowY: "auto"/, "the list column's divider stays at every width");
  assert.match(source, /flexDirection: "row-reverse" \}\}>\n      \{listColumn\}\n      \{chatPane\}\n    <\/div>/, "the column and the pane are always the two children");
  assert.doesNotMatch(source, /showListColumn|showChatPane/, "no single-view switch remains");
  assert.doesNotMatch(source, /\{isMobile \? \(listColumn/, "the list column is never conditionally dropped");
  assert.match(source, /const chatPane = !chatOpen \? \(/, "nothing open keeps the empty chat pane (no auto-open)");
  assert.match(source, /t\("polyforge\.messages\.select"\)/, "the empty pane reads the select-a-conversation copy");
  assert.match(source, /← \{t\("polyforge\.messages\.back"\)\}/, "the back control stays on the chat header");
});

test("the desktop list column is the resize separator of the shared panel hook", () => {
  assert.match(source, /const listResizer = useResizablePanel\(\{/);
  assert.match(source, /ariaLabel: t\("polyforge\.messages\.resizeList"\)/);
  assert.match(source, /cssVariable: "--pf-messages-list-width"/);
  assert.match(source, /defaultWidth: POLYFORGE_MESSAGES_LIST_MIN_WIDTH/);
  assert.match(source, /getDefaultWidth: listDefaultWidth/);
  assert.match(source, /getMaxWidth: listMaxWidth/);
  assert.match(source, /growthDirection: "left"/);
  assert.match(source, /minWidth: POLYFORGE_MESSAGES_LIST_MIN_WIDTH/);
  assert.match(source, /maxWidth: POLYFORGE_MESSAGES_LIST_MAX_WIDTH/);
  assert.match(source, /persistClamp: false/);
  assert.match(source, /storageKey: "pi-web:polyforge-messages-list-width"/);
  assert.match(source, /getPolyforgeMessagesListMaxWidth\(panelWidth\)/);
  assert.match(source, /getPolyforgeMessagesListDefaultWidth\(panelWidth\)/);
  // The dock drag changes the panel without a window resize: the surface's
  // own box drives the re-fit, not only the hook's window listener.
  assert.match(source, /new ResizeObserver\(\(\) => \{ reclampListWidth\(\); \}\)/);
  assert.match(source, /observer\.observe\(element\)/);
  assert.match(source, /\}, \[reclampListWidth, pfPresent, capable\]\)/, "the observer follows the branch's element");
  // The separator is the desktop divider only; mobile renders none.
  assert.match(source, /\{!isMobile && \(\n        <div\n          \{\.\.\.listResizer\.separatorProps\}/);
  assert.match(source, /data-resize-handle="polyforge-messages-list"/);
  assert.match(source, /className=\{`pf-messages-resize-handle\$\{listResizer\.isResizing \? " is-resizing" : ""\}`\}/);
  assert.match(source, /title=\{`\$\{t\("polyforge\.messages\.resizeList"\)\}: \$\{t\("layout\.resizeHint"\)\}`\}/);
  assert.match(source, /aria-controls="pf-messages-list"/);
});

test("the list column carries the flat direct area, the group section and their placeholders", () => {
  // ruling 5 removes the compose entry: no ＋新消息, no picker, no typed id.
  assert.doesNotMatch(source, /polyforge\.messages\.(newMessage|recipientPick|recipient)\b/, "no compose entry, picker or typed recipient label");
  assert.doesNotMatch(source, /newRecipient|setPicked|composing|composeDraft/, "no compose state survives");
  assert.doesNotMatch(source, /<input[^>]*aria-label/, "no typed recipient field");
  assert.match(source, /const sections = groupConversations\(conversations\);/);
  assert.match(source, /const direct = directRows\(conversations, contacts\);/, "the direct area is the pure flat sequence");
  assert.match(source, /\{direct\.map\(\(row\) => \(row\.kind === "conversation" \? renderRow\(row\.conversation\) : renderContact\(row\.contact\)\)\)\}/, "conversation rows and silent contacts render in that one sequence");
  assert.match(source, /\{direct\.length === 0 && \(/, "the direct placeholder shows only when both lists are empty");
  assert.match(source, /\{sections\.groups\.map\(renderRow\)\}/, "群聊 renders unchanged from the group conversations");
  assert.match(source, /polyforge\.messages\.sectionDirect/, "the 单聊 section header renders");
  assert.match(source, /polyforge\.messages\.sectionGroups/, "the 群聊 section header renders");
  assert.match(source, /polyforge\.messages\.noGroups/, "尚无群聊 renders while the group section is empty");
  assert.match(source, /polyforge\.messages\.empty/, "the direct section's empty placeholder renders");
  assert.match(source, /textOverflow: "ellipsis", whiteSpace: "nowrap"/, "row names ellipsize");
});

test("every identity surface uses the display name and the unknown-user placeholder, never an id", () => {
  assert.match(source, /const name = conversationName\(conversation\);/, "rows read the pure name helper");
  assert.match(source, /\{name \|\| t\("polyforge\.messages\.unknownUser"\)\}/, "rows fall back to the placeholder, not an id");
  assert.match(source, /const headerName = selectedRow\s*\? conversationName\(selectedRow\)\s*: \(selectedContact\?\.display_name\.trim\(\) \?\? ""\);/);
  assert.match(source, /\{headerName \|\| t\("polyforge\.messages\.unknownUser"\)\}/, "the header never falls back to an id");
  assert.doesNotMatch(source, />\s*\{conversation\.peer/, "no row label falls back to the peer id");
  assert.doesNotMatch(source, /\?\? selectedConversation/, "no header label falls back to the conversation id");
  assert.match(source, /aria-hidden="true"/, "avatars are aria-hidden beside their visible name");
  // Silent contacts and the contact pane: the display name or the
  // placeholder; the id is the avatar seed and the send address only.
  assert.match(source, /const name = contact\.display_name\.trim\(\);/, "contact rows read the trimmed display name");
  assert.match(source, /<Avatar seed=\{contact\.id\} name=\{name\} \/>/, "the contact id is only the avatar hash seed");
  assert.match(source, /: \(selectedContact\?\.display_name\.trim\(\) \?\? ""\);/, "the contact pane header reads the display name");
  assert.doesNotMatch(source, />\s*\{contact\.id/, "no label renders a contact id");
  assert.doesNotMatch(source, /(title|aria-label)=\{[^}]*(contact\.id|recipient|paneSeed)/, "no title or aria-label carries an id");
  assert.match(source, /\{composer\}/, "the composer carries no recipient field");
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
  assert.match(source, /\{replyOriginal && \(/, "the reply quote renders in the composer");
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
  for (const key of ["anchor", "text", "send", "reply", "analyze"]) {
    assert.match(source, new RegExp(`polyforge\\.messages\\.${key}`), `${key} label exists`);
  }
  assert.match(source, /<textarea/, "the message body is a textarea");
  assert.match(source, /onSubmit=\{\(event\) => void submit\(event\)\}/, "the one composer form submits");
});

test("below the floor the panel shows the upgrade state and spawns nothing", () => {
  assert.match(source, /if \(!capable\) \{/);
  assert.match(source, /polyforge\.messages\.upgrade/);
  assert.match(source, /reason \?\? t\("polyforge\.messages\.upgradeReason"\)/);
  assert.doesNotMatch(source, /from "@\/hooks\/useAgentSession"/, "incoming messages never enter a chat session");
});

test("a silent contact opens an empty pane; its first send addresses the contact id", () => {
  assert.match(source, /onClick=\{\(\) => \{ if \(!open\) onSelectContact\(contact\); \}\}/, "a contact row selects that contact; re-clicking the open one is a no-op");
  assert.match(source, /const chatOpen = selectedConversation !== null \|\| selectedContact !== null;/, "a contact opens the pane");
  assert.match(source, /const recipient = selectedConversation \? \(selectedPeer \|\| lastPeer\) : \(selectedContact\?\.id \?\? ""\);/, "the first send addresses the contact id");
  // No directory: no /users-style route call, no fetch anywhere in the
  // component (the other tests already pin the no-fetch rule).
  assert.doesNotMatch(source, /"\/users|'\/users|`\/users/);
});

test("opening the tab renders the select-a-conversation empty state and nothing else", () => {
  assert.match(source, /const chatOpen = selectedConversation !== null \|\| selectedContact !== null;/);
  assert.match(source, /const chatPane = !chatOpen \? \(\n    <div style=\{\{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var\(--text-dim\)", fontSize: 12, padding: 16 \}\}>\n      \{t\("polyforge\.messages\.select"\)\}/, "the empty state is the chat pane with nothing open");
  // The history region and the composer render only inside the open branch.
  assert.match(source, /chatOpen \? \(/);
});

test("the composer clears on submit and restores the attempt on a refusal", () => {
  // A rendered message body must always mean the message reached the
  // history — never an in-flight composer echo — and a refusal (pf's 4xx
  // text) restores the attempt.
  assert.match(source, /const attempt = \{ text: draftText, anchor: draftAnchor \};/);
  assert.match(source, /setDraftText\(""\);\s*setDraftAnchor\(""\);/, "the draft clears when its send is accepted for submission");
  assert.match(source, /setDraftText\(attempt\.text\);/, "a refusal restores the attempt");
  assert.match(source, /setSendError\(submitError instanceof Error \? submitError\.message : String\(submitError\)\);/, "the refusal text shows");
  assert.match(source, /<textarea value=\{draftText\}/, "the textarea reads the draft");
});

test("project groups render between the direct area and 群聊", () => {
  const directAt = source.indexOf("{direct.map((row) =>");
  const groupsAt = source.indexOf("{groups.map(renderProjectGroup)}");
  const chatsAt = source.indexOf("{sections.groups.map(renderRow)}");
  assert.ok(directAt > 0 && groupsAt > directAt && chatsAt > groupsAt, "direct rows, then project groups, then 群聊");
  assert.match(source, /\{groups\.length > 0 && \(/, "the projects label renders only with groups (no mapping: today's list)");
  assert.match(source, /polyforge\.messages\.sectionProjects/);
  assert.match(source, /const contacts = contactsOutsideGroups\(configuredContacts, groups\);/,
    "a grouped contact is not repeated as a silent direct row; conversation rows stay");
});

test("a group header folds through the collapse hook and counts its contacts", () => {
  assert.match(source, /import \{ usePolyforgeMessagesCollapse \} from "@\/hooks\/usePolyforgeMessagesCollapse";/);
  assert.match(source, /const \{ collapsed, toggleProject \} = usePolyforgeMessagesCollapse\(\);/);
  assert.match(source, /const expanded = !collapsed\.has\(group\.project\);/, "expanded unless stored collapsed; a stale stored name matches no group");
  assert.match(source, /aria-expanded=\{expanded\}/);
  assert.match(source, /aria-controls=\{bodyId\}/);
  assert.match(source, /onClick=\{\(\) => toggleProject\(group\.project\)\}/);
  assert.match(source, /t\("polyforge\.messages\.projectGroupLabel", \{ project: group\.project, count: group\.contacts\.length \}\)/,
    "the header names the project and its contact count");
  assert.match(source, /\{group\.contacts\.length\}<\/span>/, "the visible count is the contact count, folded or not");
  assert.doesNotMatch(source, /localStorage|sessionStorage\./, "the component never touches storage directly");
});

test("a group shows its own failure note or an explicit empty placeholder", () => {
  assert.match(source, /\{t\("polyforge\.messages\.groupReadFailed"\)\}: \{group\.error\}/, "pf's text is shown in that group only");
  assert.match(source, /data-empty-group=\{group\.project\}/);
  assert.match(source, /polyforge\.messages\.groupEmpty/);
});

test("a group row opens the existing conversation or the empty pane, with no unread badge", () => {
  const start = source.indexOf("const renderGroupContact = ");
  const end = source.indexOf("const renderProjectGroup = ", start);
  const body = source.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(body, /const existing = conversationForContact\(conversations, contact\.id\);/);
  assert.match(body, /if \(existing\) onSelectConversation\(existing\.id\);\s*else onSelectContact\(contact\);/, "no conversation is created by a click");
  assert.doesNotMatch(body, /unread/, "unread lives on the direct row only");
  assert.match(body, /\{name \|\| t\("polyforge\.messages\.unknownUser"\)\}/, "the display name or the placeholder, never an id");
  assert.match(body, /<Avatar seed=\{contact\.id\} name=\{name\} \/>/);
});

test("management only for an admin; otherwise an explicit read-only notice", () => {
  assert.match(source, /\{groups\.length > 0 && membershipAdmin === false && \(/, "a refused or failed probe shows the notice");
  assert.match(source, /polyforge\.messages\.membershipNeedsAdmin/);
  assert.match(source, /\{membershipAdmin === true && !group\.error && \(/, "add only for an admin, never over a failed group read");
  assert.match(source, /\{membershipAdmin === true && \(\n          <button/, "remove only for an admin");
  assert.match(source, /aria-label=\{t\("polyforge\.messages\.addMember", \{ project: group\.project \}\)\}/);
  assert.match(source, /aria-label=\{t\("polyforge\.messages\.removeMember", \{ name: name \|\| t\("polyforge\.messages\.unknownUser"\), project \}\)\}/,
    "the remove label names the display name or the placeholder, never an id");
});

test("the picker offers only users outside the group, with no role choice", () => {
  const start = source.indexOf("const renderPicker = ");
  const body = source.slice(start, source.indexOf("const renderProjectGroup = ", start));
  assert.ok(start > 0);
  assert.match(body, /const members = new Set\(group\.contacts\.map\(\(contact\) => contact\.id\)\);/);
  assert.match(body, /users\.filter\(\(user\) => !members\.has\(user\.id\)\)\.sort\(compareContactsByName\)/, "existing members are hidden");
  assert.match(body, /\{name \|\| t\("polyforge\.messages\.unknownUser"\)\}/);
  assert.match(body, /changeMembership\("add", group\.project, user\)/);
  assert.doesNotMatch(source, /<select|setRole|polyforge\.messages\.\w*[Rr]ole/, "no role selector: add is always writer server-side");
  assert.doesNotMatch(body, /<input/, "no typed id field");
});

test("every change is confirmed by name first; cancel sends nothing; a refusal is shown, not applied", () => {
  const start = source.indexOf("const changeMembership = useCallback");
  const body = source.slice(start, source.indexOf("}, [membershipBusy, onChangeMembership, t]);", start));
  assert.ok(start > 0);
  assert.match(body, /const name = user\.display_name\.trim\(\) \|\| t\("polyforge\.messages\.unknownUser"\);/);
  assert.match(body, /t\("polyforge\.messages\.confirmAddMember", \{ name, project \}\)/);
  assert.match(body, /t\("polyforge\.messages\.confirmRemoveMember", \{ name, project \}\)/);
  const confirmAt = body.indexOf("if (!window.confirm(question)) return;");
  const changeAt = body.indexOf("await onChangeMembership({ action, project, userId: user.id });");
  assert.ok(confirmAt > 0 && changeAt > confirmAt, "the confirmation precedes the one change; cancelling returns first");
  assert.match(body, /setMembershipError\(\{ project, text: changeError instanceof Error \? changeError\.message : String\(changeError\) \}\);/,
    "pf's refusal text is kept for its group");
  assert.doesNotMatch(body, /setGroups|groups\.(push|splice|filter)/, "no optimistic membership change");
  assert.match(source, /\{t\("polyforge\.messages\.membershipFailed"\)\}: \{membershipError\.text\}/);
});
