import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MachineLoadSection } = await jiti.import("./MachineLoadSection.tsx");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const { zhTWLocale } = await jiti.import("../lib/i18n/messages/zh-TW.ts");

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const agentPanel = await readFile(new URL("./AgentSessionPanel.tsx", import.meta.url), "utf8");

const KEYS = [
  "session.machineLoad",
  "session.machineHost",
  "session.machineCpu",
  "session.machineCores",
  "session.machineLoadavg",
  "session.machineMemory",
  "session.machineUnavailable",
];

function render(messages) {
  const translate = (key) => messages[key] ?? key;
  return renderToStaticMarkup(React.createElement(MachineLoadSection, { translate }));
}

test("first open (no good value yet) renders the heading, the host badge and 不可用 in all four rows", () => {
  const html = render(zhCNLocale.messages);
  assert.match(html, /class="machine-load-section"/);
  assert.match(html, />机器负载</);
  assert.match(html, />宿主机</);
  assert.equal((html.match(/>不可用</g) || []).length, 4);
  assert.doesNotMatch(html, /\d%|0\.00|GiB/, "no fabricated value before the first success");
  assert.doesNotMatch(html, /<input|<select|<textarea/, "no interval control");
  assert.match(html, /grid-template-columns:auto minmax\(0, 1fr\)/, "the grid wraps at phone width");
});

test("all three locales resolve every section key", () => {
  assert.equal(zhCNLocale.messages["session.machineLoad"], "机器负载");
  assert.equal(zhCNLocale.messages["session.machineHost"], "宿主机");
  assert.equal(zhCNLocale.messages["session.machineUnavailable"], "不可用");
  for (const locale of [enLocale, zhCNLocale, zhTWLocale]) {
    for (const key of KEYS) assert.equal(typeof locale.messages[key], "string", `${locale.id}: ${key}`);
    const html = render(locale.messages);
    assert.doesNotMatch(html, /session\.machine/, `${locale.id}: no raw key fallback`);
  }
  assert.doesNotMatch(render(enLocale.messages), /[一-鿿]/, "en renders no CJK");
  assert.notEqual(zhTWLocale.messages["session.machineLoad"], zhCNLocale.messages["session.machineLoad"]);
});

test("AppShell mounts it only inside the Session-info popover; the Agents dropdown is untouched", () => {
  assert.equal((appShell.match(/<MachineLoadSection /g) || []).length, 1);
  const sessionBlock = appShell.indexOf('activeTopPanel === "session" && (');
  const debugBlock = appShell.indexOf('activeTopPanel === "debug" && (', sessionBlock);
  const mount = appShell.indexOf("<MachineLoadSection translate={translate} />");
  assert.ok(sessionBlock >= 0 && sessionBlock < mount && mount < debugBlock, "mounted in the session popover block");
  assert.ok(appShell.lastIndexOf('className="session-info-popover"', mount) > sessionBlock);
  assert.doesNotMatch(agentPanel, /MachineLoad|machine-load/);
});
