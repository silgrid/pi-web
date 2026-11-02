import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const locales = await Promise.all(["en", "zh-CN", "zh-TW"].map((id) => jiti.import(`@/lib/i18n/messages/${id}`)));

test("export is disabled for a claude session with visible text, not a tooltip", () => {
  assert.match(appShell, /const selectedIsClaude = selectedSession\?\.harness === "claude";/);
  const branch = appShell.slice(appShell.indexOf("{selectedIsClaude ? ("), appShell.indexOf("handleViewFullHistory();"));
  assert.match(branch, /<span[\s\S]*\{translate\("claude\.exportUnavailable"\)\}\s*<\/span>/);
  assert.doesNotMatch(branch, /title=\{translate\("claude\.exportUnavailable"\)\}/);
  for (const localeModule of locales) {
    const messages = Object.values(localeModule)[0].messages;
    assert.match(messages["claude.exportUnavailable"], /claude/);
  }
});

test("background tasks, title generation and the subagent switcher are hidden for a claude session", () => {
  assert.match(appShell, /\{!selectedIsClaude && <button\s+type="button"\s+onClick=\{\(\) => \{\s+setBgPanelOpen/);
  assert.match(appShell, /\{!selectedIsClaude && \(\(\) => \{\s+\/\/ 上下文压缩后/);
  assert.match(appShell, /\{!selectedIsClaude && hasSubagentSessions && agentsBadge && \(/);
});
