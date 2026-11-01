import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ClaudeConfigDirSection } = await jiti.import("./SettingsPanel.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

test("Settings › General shows the claude config dir read-only, with each preset's wording", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(ClaudeConfigDirSection, { initialConfigDir: "/home/u/.pi/agent/claude" })));
  assert.match(html, /claude config dir: \/home\/u\/\.pi\/agent\/claude/);
  assert.match(html, /never reads, stores or shows them/);
  assert.match(html, /Bare mode does not read the session folder&#x27;s CLAUDE\.md/);
  assert.match(html, /claude loads the session folder&#x27;s CLAUDE\.md — known, accepted behaviour/);
  assert.doesNotMatch(html, /<input|<select|<button/, "nothing editable, no toggle");
});
