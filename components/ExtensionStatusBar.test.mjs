import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  ExtensionStatusBar,
  formatExtensionStatusLine,
  sanitizeExtensionStatusText,
} = await jiti.import("./ExtensionStatusBar.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderStatusBar(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionStatusBar, props),
    ),
  );
}

test("sorts status text by hidden key like the Pi CLI footer", () => {
  const statuses = [
    { key: "20-memory", text: "memory" },
    { key: "90-notify", text: "notify" },
    { key: "10-permissions", text: "permissions" },
    { key: "05-ponytail", text: "ponytail" },
  ];

  assert.equal(
    formatExtensionStatusLine(statuses),
    "ponytail permissions memory notify",
  );
});

test("preserves status line breaks while normalizing horizontal whitespace", () => {
  assert.equal(
    sanitizeExtensionStatusText("  first\tsecond \r\n third  "),
    "first second\nthird",
  );
});

test("preserves explicit status lines without wrapping and scrolls long or tall output", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const statusLineRule = css.match(/\.extension-status-line\s*\{([^}]*)\}/)?.[1] ?? "";
  const statusTextRule = css.match(/\.extension-status-text\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(statusLineRule, /max-height:/);
  assert.match(statusLineRule, /align-items:\s*flex-start/);
  assert.match(statusLineRule, /overflow:\s*auto/);
  assert.match(statusTextRule, /white-space:\s*pre\s*;/);
  assert.doesNotMatch(statusTextRule, /overflow[^:]*:\s*hidden/);
  assert.doesNotMatch(statusTextRule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(statusTextRule, /text-overflow:\s*ellipsis/);
});

test("renders a single status line without identifier keys", () => {
  const html = renderStatusBar({
    statuses: [
      { key: "20-memory", text: "\x1b[32mmemory\x1b[0m" },
      { key: "05-ponytail", text: "ponytail" },
    ],
  });

  assert.match(html, /aria-label="ponytail memory"/);
  assert.match(html, /extension-status-shelf/);
  assert.match(html, /extension-status-line/);
  assert.match(html, /extension-status-text/);
  assert.match(html, />ponytail <span style=/);
  assert.match(html, />memory</);
  assert.doesNotMatch(html, /05-ponytail|20-memory/);
});

test("renders widgets and status text in one footer", () => {
  const html = renderStatusBar({
    statuses: [{ key: "status", text: "connected" }],
    widgets: [{
      key: "usage",
      lines: ["42%"],
      placement: "aboveEditor",
    }],
  });

  assert.match(html, /extension-status-shelf has-widgets has-status/);
  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /usage/);
  assert.match(html, /connected/);
});

// pi#111: the pf-chat `polyforge` widget never renders in the shelf. These
// go through the real render boundary (ExtensionStatusBar → DOM) and fail on
// code without the filter.
test("never renders the pf-chat polyforge widget (pi#111)", () => {
  const html = renderStatusBar({
    statuses: [],
    widgets: [{
      key: "polyforge",
      lines: ["pi#111 fix running"],
      placement: "aboveEditor",
    }],
  });

  assert.equal(html, "");
});

test("keeps other widgets when the polyforge widget is present (pi#111)", () => {
  const html = renderStatusBar({
    statuses: [],
    widgets: [
      { key: "polyforge", lines: ["pi#111 fix running"], placement: "aboveEditor" },
      { key: "usage", lines: ["42%"], placement: "aboveEditor" },
    ],
  });

  assert.match(html, /extension-status-shelf has-widgets/);
  assert.match(html, /extension-widget-key">usage/);
  assert.doesNotMatch(html, /polyforge/);
});

test("renders statuses alone when the polyforge widget was the only widget (pi#111)", () => {
  const html = renderStatusBar({
    statuses: [{ key: "05-mcp", text: "mcp disconnected" }],
    widgets: [{ key: "polyforge", lines: ["pi#111 fix running"], placement: "aboveEditor" }],
  });

  assert.match(html, /extension-status-shelf has-status/);
  assert.doesNotMatch(html, /has-widgets/);
  assert.match(html, /mcp disconnected/);
  assert.doesNotMatch(html, /polyforge/);
});
