import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput, ClaudeComposerControls, claudePresetTextKey } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en");
const { zhCNLocale } = await jiti.import("@/lib/i18n/messages/zh-CN");
const { zhTWLocale } = await jiti.import("@/lib/i18n/messages/zh-TW");

const t = (key, params = {}) => String(enLocale.messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
const render = (state) => renderToStaticMarkup(React.createElement(ClaudeComposerControls, { state, t }));
const base = { choosing: true, harness: "pi", modelAlias: "claude-default", preset: "read-only", availability: { available: true, configDir: "/agent/claude" } };

test("a fresh composer offers pi (default) or claude, and nothing claude-specific while pi is picked", () => {
  const html = render(base);
  assert.match(html, /<option value="pi" selected="">pi<\/option>/);
  assert.match(html, /<option value="claude">claude<\/option>/);
  assert.doesNotMatch(html, /CLAUDE\.md/);
  assert.doesNotMatch(html, /\/agent\/claude/);
});

test("claude missing from PATH: the option is disabled and the reason is visible text", () => {
  const html = render({ ...base, availability: { available: false, configDir: "/agent/claude" } });
  assert.match(html, /<option value="claude" disabled="">claude<\/option>/);
  assert.match(html, />claude was not found on PATH, so a claude session cannot be started\.</);
  assert.doesNotMatch(html, /title="claude was not found/, "never a tooltip only");
});

test("claude picked: alias and preset choices, the fixed-for-life rule, the preset's CLAUDE.md wording and the config dir", () => {
  const readOnly = render({ ...base, harness: "claude", modelAlias: "sonnet" });
  for (const alias of ["sonnet", "opus", "haiku", "claude-default"]) assert.match(readOnly, new RegExp(`<option value="${alias}"`));
  assert.match(readOnly, /<option value="sonnet" selected="">/);
  assert.match(readOnly, /<option value="read-only" selected="">read-only<\/option>/);
  assert.match(readOnly, /fixed for the life of this session/);
  assert.match(readOnly, /Bare mode does not read the session folder&#x27;s CLAUDE\.md/);
  assert.match(readOnly, /claude config dir: \/agent\/claude/);
  const writable = render({ ...base, harness: "claude", preset: "writable" });
  assert.match(writable, /claude loads the session folder&#x27;s CLAUDE\.md — known, accepted behaviour/);
  assert.match(writable, /permissions\.allow/);
  assert.doesNotMatch(writable + readOnly, /type="checkbox"/, "no CLAUDE.md toggle");
});

test("an open claude session shows its fixed alias and preset; a pi session shows nothing", () => {
  assert.match(render({ ...base, choosing: false, harness: "claude", modelAlias: "haiku", preset: "writable" }), /claude · haiku · writable — fixed for this session/);
  assert.equal(render({ ...base, choosing: false }), "");
});

test("in the composer: claude replaces the pi model/thinking/tools/compact controls and attachments; Stop is named Stop agent", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
    onSend() {}, onAbort() {}, isStreaming: true,
    claude: { ...base, choosing: false, harness: "claude", modelAlias: "opus" },
  })));
  assert.match(html, /claude · opus · read-only — fixed for this session/);
  assert.match(html, /aria-label="Stop agent"/);
  assert.doesNotMatch(html, /title="Attach files"/);
});

test("every claude string exists in en, zh-CN and zh-TW, both preset texts naming CLAUDE.md", () => {
  const keys = Object.keys(enLocale.messages).filter((key) => key.startsWith("claude."));
  assert.ok(keys.length >= 15);
  for (const locale of [zhCNLocale, zhTWLocale]) {
    for (const key of keys) assert.equal(typeof locale.messages[key], "string", `${locale.id} ${key}`);
  }
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    for (const preset of ["read-only", "writable"]) assert.match(locale.messages[claudePresetTextKey(preset)], /CLAUDE\.md/);
    assert.match(locale.messages["claude.notOnPath"], /PATH/);
  }
});

test("while a claude turn runs, Send stays visible but disabled, and the composer says why", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
    onSend() {}, onAbort() {}, isStreaming: true,
    claude: { ...base, choosing: false, harness: "claude" },
  })));
  assert.match(html, /<button type="button" disabled="" aria-label="Send"/);
  assert.match(html, /placeholder="claude is answering; the next message can be sent when this turn ends\."/);
  const pi = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
    onSend() {}, onAbort() {}, isStreaming: true,
  })));
  assert.doesNotMatch(pi, /aria-label="Send"/, "a pi run keeps its own streaming controls");
});
