import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./PolyforgeConfig.tsx", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");

test("detection runs once per activation (StrictMode-resilient), never on a poll", () => {
  // One detect when the section becomes active, guarded against React
  // StrictMode's simulated remount (setup → cleanup → setup in dev) so the
  // cadence is exactly one request per open.
  assert.match(source, /const detectRanForActive = useRef\(false\)/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*\n\s*if \(!active\) \{\s*\n\s*detectRanForActive\.current = false;\s*\n\s*return;\s*\n\s*\}\s*\n\s*if \(detectRanForActive\.current\) return;\s*\n\s*detectRanForActive\.current = true;\s*\n\s*void runDetect\(false\);/,
    "the activation effect fetches once, non-force",
  );
  // No timers anywhere in the section (R10): the dock's polling hook is
  // deliberately not reused (no import, no status route).
  assert.doesNotMatch(source, /setInterval|setTimeout/);
  assert.doesNotMatch(source, /from "@\/hooks\/usePolyforge"/, "the polling dock hook is not reused");
  assert.doesNotMatch(source, /\/api\/polyforge\/status/, "the section never touches the dock's status route");
});

test("the re-detect control bypasses the 60s presence cache with ?force=1", () => {
  assert.match(source, /\/api\/polyforge\/detect\$\{force \? "\?force=1" : ""\}/);
  assert.match(source, /onClick=\{\(\) => void runDetect\(true\)\}/, "the re-detect button forces past the cache");
  assert.match(source, /disabled=\{!detect\}/, "re-detect waits for a first detection");
});

test("the toggle writes only through the existing /api/plugins global path", () => {
  assert.match(
    source,
    /fetch\("\/api\/plugins", \{\s*\n\s*method: "POST",\s*\n\s*headers: \{ "Content-Type": "application\/json" \},\s*\n\s*body: JSON\.stringify\(\{ action: enabled \? "enable" : "disable", source: sourceState\.source, scope: "global", cwd \}\),/,
    "the exact PluginsConfig package-switch call shape",
  );
  // The only non-GET request the section can issue is that one POST.
  const posts = source.match(/method: "POST"/g) ?? [];
  assert.equal(posts.length, 1, "exactly one POST site exists in the section");
  // Auto re-detect after the write settles (non-force).
  assert.match(source, /await runDetect\(false\)/, "detection re-runs automatically after the toggle");
  // The source is resolved from the listing join, never from the detect
  // response (which carries no paths).
  assert.match(
    source,
    /pkg\.scope === "global" && pkg\.packageName === "polyforge"/,
    "the source joins the listing on scope + packageName",
  );
  assert.match(source, /\/api\/plugins\?cwd=\$\{encodeURIComponent\(cwd\)\}/, "the listing is the existing GET /api/plugins");
});

test("no other write exists: no cli.toml, no Claude config, no install execution", () => {
  // The section imports no server-side module at all (type-only imports) —
  // it cannot touch cli.toml, Claude Code config or any install by itself;
  // the only write it can issue is the one /api/plugins POST above.
  assert.doesNotMatch(source, /from "node:/, "no node built-in import (config files are untouchable)");
  assert.match(source, /import type \{ PolyforgeDetectStatus \} from "@\/lib\/polyforge-detect";/, "the server detection module is imported as a type only");
  assert.doesNotMatch(source, /spawn|execFile/);
  assert.doesNotMatch(source, /method: "(PUT|DELETE|PATCH)"/);
  // The install command is copyable text only.
  assert.match(source, /navigator\.clipboard\.writeText\(installCommand\)/);
});

test("the pi package switch renders only when the skill is installed; disabled reasons are visible text", () => {
  // The switch block is gated on piSkillInstalled (未安装 shows no toggle).
  assert.match(source, /\{detect\?\.piSkillInstalled && \(\s*\n\s*<ConfigSwitch/);
  // Disabled = no project or no resolved source, with the reason as visible
  // text under the switch's line (describedBy), never only a tooltip.
  assert.match(source, /disabled=\{!cwd \|\| !sourceState\.source\}/);
  assert.match(source, /describedBy=\{switchReason \? switchReasonId : undefined\}/);
  assert.match(source, /<span id=\{switchReasonId\} className="config-scope-switch-reason">/, "the reason renders as visible text");
  const reasons = [
    "polyforge.settings.switchNeedsProject",
    "polyforge.settings.switchResolving",
    "polyforge.settings.switchNoPackage",
  ];
  for (const key of reasons) {
    assert.match(source, new RegExp(`t\\("${key.replace(/\./g, "\\.")}"\\)`), `the section carries ${key}`);
  }
});

test("the section reuses the shared SettingsUi blocks and every word is a prop", () => {
  for (const block of ["ConfigButton", "ConfigDetailGrid", "ConfigDetailGridRow", "ConfigDetailStack", "ConfigFooter", "ConfigFooterStatus", "ConfigSectionTitle", "ConfigSwitch"]) {
    assert.match(source, new RegExp(`<${block}[\\s>]`), `the section renders through ${block}`);
  }
  // The section label reuses the existing polyforge.title key (no new label).
  assert.match(source, /t\("polyforge\.title"\)/);
});

test("the panel hosts the section without a project and re-detects on every open", () => {
  assert.match(panelSource, /\{ id: "polyforge", label: t\("polyforge\.title"\), requiresProject: false \}/);
  assert.match(panelSource, /<PolyforgeConfig cwd=\{cwd\} active=\{section === "polyforge"\} \/>/);
  // Not cwd-gated: the section host renders without a selected project.
  const hostLine = panelSource.slice(panelSource.indexOf('sectionHost("polyforge"'));
  assert.doesNotMatch(hostLine.split("\n")[0], /cwd &&/, "the polyforge section host is not project-gated");
});

test("the install command and every section string exist in all three locales", async () => {
  const installNeedles = ["tools/install.sh", "raw.githubusercontent.com"];
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of [
      "polyforge.settings.notInstalled",
      "polyforge.settings.installCommandTitle",
      "polyforge.settings.installCommand",
      "polyforge.settings.copyInstall",
      "polyforge.settings.redetect",
      "polyforge.settings.version",
      "polyforge.settings.belowMinimum",
      "polyforge.settings.line",
      "polyforge.settings.line.internal",
      "polyforge.settings.line.public",
      "polyforge.settings.line.unknown",
      "polyforge.settings.piSkill",
      "polyforge.settings.claudeSymlink",
      "polyforge.settings.claudeHook",
      "polyforge.settings.state.enabled",
      "polyforge.settings.state.disabled",
      "polyforge.settings.state.notInstalled",
      "polyforge.settings.state.present",
      "polyforge.settings.state.absent",
      "polyforge.settings.daemon",
      "polyforge.settings.daemonReachable",
      "polyforge.settings.daemonUnreachable",
      "polyforge.settings.daemonNotApplicable",
      "polyforge.settings.packageSwitch",
      "polyforge.settings.switchNeedsProject",
      "polyforge.settings.switchResolving",
      "polyforge.settings.switchNoPackage",
      "polyforge.settings.packageToggled",
    ]) {
      assert.match(text, new RegExp(`"${key}": "`), `${locale} must carry ${key}`);
    }
    // The install command is the fixed install.sh usage string, identical in
    // every locale, placeholders only (never a real key).
    const command = text.match(/"polyforge\.settings\.installCommand": "((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\"/g, '"') ?? "";
    for (const needle of installNeedles) {
      assert.ok(command.includes(needle), `${locale}'s install command must carry ${needle}`);
    }
    assert.ok(command.includes("<api-key>"), "the api key stays a placeholder");
    assert.doesNotMatch(command, /sk-|ghp_[A-Za-z0-9]/, "no real credential shape in the install text");
  }
});