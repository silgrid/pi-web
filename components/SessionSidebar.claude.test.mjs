import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { HarnessMarker, withClaudeArchiveState } = await jiti.import("./SessionSidebar.tsx");
const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("a claude row carries a visible harness marker with its alias; a pi row none", () => {
  const html = renderToStaticMarkup(React.createElement(HarnessMarker, { session: { harness: "claude", claude: { modelAlias: "sonnet", preset: "read-only" } } }));
  assert.match(html, /data-harness="claude"/);
  assert.match(html, />claude · sonnet</);
  assert.equal(renderToStaticMarkup(React.createElement(HarnessMarker, { session: {} })), "");
  assert.equal(renderToStaticMarkup(React.createElement(HarnessMarker, { session: { harness: "pi" } })), "");
  // Both row kinds (the list and the archive view) render it beside the title.
  assert.equal(source.match(/<HarnessMarker session=\{session\} \/>/g)?.length, 2);
});

test("the archive set mirrors claude rows' index state and leaves pi rows to the browser", () => {
  const current = new Set(["pi-archived", "claude-unarchived"]);
  const sessions = [
    { id: "pi-archived" },
    { id: "pi-live" },
    { id: "claude-archived", harness: "claude", archived: true },
    { id: "claude-unarchived", harness: "claude" },
  ];
  assert.deepEqual([...withClaudeArchiveState(current, sessions)].sort(), ["claude-archived", "pi-archived"]);
  const settled = new Set(["pi-archived", "claude-archived"]);
  assert.equal(withClaudeArchiveState(settled, sessions), settled, "unchanged state keeps the same set");
});

test("archiving a claude row writes the index (PATCH { archived }) instead of the browser set", () => {
  const archive = source.slice(source.indexOf("const archiveSession = useCallback"), source.indexOf("const unarchiveSession = useCallback"));
  assert.match(archive, /session\.harness === "claude"[\s\S]*setClaudeArchived\(id, true\)/);
  const unarchive = source.slice(source.indexOf("const unarchiveSession = useCallback"), source.indexOf("// Persist the archive set"));
  assert.match(unarchive, /setClaudeArchived\(id, false\)/);
  assert.match(source, /method: "PATCH"[\s\S]{0,120}JSON\.stringify\(\{ archived \}\)/);
});
