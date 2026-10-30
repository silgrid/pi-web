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
  // The package switch is one POST; the configuration panel adds its own
  // write/reload/rollback POSTs.
  assert.ok((source.match(/method: "POST"/g) ?? []).length >= 1, "the package switch POST exists");
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
  assert.match(source, /\/api\/polyforge\/config/);
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

test("the panel hosts the section without a project and re-detects on every open", async () => {
  assert.match(panelSource, /\{ id: "polyforge", label: t\("polyforge\.title"\) \}/);
  // Which sections need a project is decided in lib/settings-navigation.ts; polyforge is not one.
  const { settingsSectionRequiresProject } = await import("../lib/settings-navigation.ts");
  assert.equal(settingsSectionRequiresProject("polyforge"), false);
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

test("the configuration panel reads through pf and keeps api_key write-only", () => {
  assert.match(source, /\/api\/polyforge\/config\?cwd=/);
  assert.match(source, /type=\{item\.key === "api_key" \? "password"/);
  assert.match(source, /item\.key === "api_key" \? \(item\.set \? "<set>" : "<unset>"\)/, "api_key never renders a value");
  assert.match(source, /expect_state/);
  assert.match(source, /\/api\/polyforge\/config\/history/);
  assert.match(source, /\/api\/polyforge\/config\/reload/);
});

test("the form enforces pf's schema client-side so 0 and 9 are unreachable", () => {
  // The value is validated against the key's pf schema BEFORE any write.
  assert.match(source, /configValueError\(item\.key, value, item\.schema\)/);
  // The guard lives in the browser-safe schema module: a value import of the
  // server read module would pull node:child_process into the client bundle.
  assert.match(source, /import \{ configValueError \} from "@\/lib\/polyforge-config-schema";/, "the guard comes from the browser-safe module");
  assert.doesNotMatch(source, /import \{ configValueError \} from "@\/lib\/polyforge-config";/, "never value-import the server read module");
  assert.match(source, /min=\{item\.schema\?\.min\}/);
  assert.match(source, /max=\{item\.schema\?\.max\}/);
  // And the read snapshot (values, api_key as {set}) rides expect_state.
  assert.match(source, /function expectedValues\(/);
  assert.match(source, /file_sha256: hash \?\? null, values: expectedValues/);
});

test("the daemon column says the daemon is not running, and only the three live keys carry it", () => {
  assert.match(source, /isDaemonColumnKey/);
  assert.match(source, /polyforge\.settings\.configDaemonDown/);
  assert.match(source, /config\.daemonReachable === false/);
});

test("visible reasons: capability floor, unmapped cwd and incomplete candidates are text", () => {
  assert.match(source, /config\?\.capable === false/);
  assert.match(source, /configReason/);
  assert.match(source, /config\.mapped/);
  assert.match(source, /config\.steps_complete === false/);
  assert.match(source, /polyforge\.settings\.configMachineScope/);
});

test("items render in source cards with a title and a visible one-line hint", () => {
  assert.match(source, /groupConfigItems\(config\.items \?\? \[\]\)\.map\(\(group\) =>/);
  assert.match(source, /<p className="polyforge-config-card-title">\{t\(GROUP_TITLE\[group\.id\]\)\}<\/p>/);
  assert.match(source, /<p className="polyforge-config-card-hint">\{t\(GROUP_HINT\[group\.id\]\)\}<\/p>/);
  for (const id of ["Flat", "Daemon", "Workspace", "Summarize"]) {
    assert.match(source, new RegExp(`"polyforge\\.settings\\.configGroup${id}"`), `card title ${id}`);
    assert.match(source, new RegExp(`"polyforge\\.settings\\.configGroup${id}Hint"`), `card hint ${id}`);
  }
  // The daemon card uses pf's five [daemon] keys; the daemon column stays the three live keys.
  assert.match(source, /function isDaemonColumnKey\(key: string\): boolean \{\s*\n\s*return key === "max_concurrent_jobs" \|\| key === "step_timeout" \|\| key === "stall_window";/);
});

test("each card declares only its effective columns and the page shares one column system", () => {
  for (const label of ["configColKey", "configColClass", "configColFile", "configColDaemon"]) {
    assert.match(source, new RegExp(`t\\("polyforge\\.settings\\.${label}"\\)`), `grid header ${label}`);
  }
  // Only the daemon card declares the daemon column: no header and no cell in
  // every other card (the #88 five-cells-in-every-row rule is reversed).
  assert.match(source, /const hasDaemon = group\.id === "daemon";/);
  assert.match(source, /className=\{`polyforge-config-grid/);
  assert.match(source, /hasDaemon \? " has-daemon" : ""/);
  assert.match(source, /\{hasDaemon && <span>\{t\("polyforge\.settings\.configColDaemon"\)\}<\/span>\}/);
  assert.match(source, /const daemonCell = hasDaemon && isDaemonColumnKey\(item\.key\);/);
  assert.match(source, /\{daemonCell && \(/, "the daemon cell is per group and per key");
  assert.doesNotMatch(source, /<span className="polyforge-config-daemon">\s*\{isDaemonColumnKey/, "no unconditional daemon placeholder cell");
  // The row still renders key | class | value unconditionally, in that column
  // order, so no cell collapses when a row is read-only (the #88 intent kept).
  // Only the daemon cell may be conditional, and only behind daemonCell.
  const row = source.slice(source.indexOf("<div key={item.key} className={`polyforge-config-row"), source.indexOf("</div>", source.indexOf("<div key={item.key} className={`polyforge-config-row")));
  let at = 0;
  for (const cell of ["polyforge-config-key", "polyforge-config-class", "polyforge-config-file"]) {
    const index = row.indexOf(`<span className="${cell}">`, at);
    assert.ok(index > at, `${cell} renders unconditionally, in column order`);
    // The line opening the cell is the cell itself, not a `cond && (` wrapper,
    // and no conditional opens on an earlier line either.
    const before = row.slice(row.lastIndexOf("\n", index), index);
    assert.match(before, /^\n\s*$/, `${cell} is not wrapped in a condition`);
    assert.doesNotMatch(row.slice(0, index), /&&\s*\(/, `${cell} is not behind a condition`);
    at = index;
  }
  assert.match(source, /<span className="polyforge-config-badge" title=\{item\.class\}>\{reloadClassLabel\(item\.class\)\}<\/span>/, "the reload class is a localized badge");
  assert.match(source, /const unset = t\("polyforge\.settings\.configUnset"\)/);
  // renderValue still renders the unset placeholder for unset file values and
  // empty project/model lists; the WI removed only the whole-column daemon one.
  assert.match(source, /<span className="polyforge-config-empty">\{unset\}<\/span>/, "unset values show the placeholder");
  assert.match(source, /is-readonly/, "read-only rows are muted");
});

test("the Save action sits beside its input, and model lists render as chips", () => {
  // The write control and the Save button share one cell; the old far-right
  // actions column is gone.
  assert.match(source, /<span className="polyforge-config-write">\s*\n\s*<input/, "the input opens the write cell");
  assert.match(source, /<span className="polyforge-config-write-row">/);
  assert.match(source, /<ConfigButton size="small" disabled=\{writeBusy !== null\} onClick=\{\(\) => void save\(item\)\}>/);
  assert.doesNotMatch(source, /polyforge-config-actions/);
  // summarize.models is a chip list with an add input, never String(array).
  assert.match(source, /function isModelListKey\(item: PolyforgeConfigItem\): boolean \{/);
  assert.match(source, /kind === "model-list" \|\| item\.key === "summarize\.models"/);
  assert.match(source, /<span className="polyforge-config-chip-label">\{model\}<\/span>/);
  assert.match(source, /polyforge\.settings\.configAddModel/);
  assert.match(source, /polyforge\.settings\.configRemoveModel/);
  // The save path still hands a comma string to formValue, which splits it.
  assert.match(source, /isModelListKey\(item\)\s*\n\s*\? \[/);
  assert.match(source, /\.join\(","\)/);
});

test("a workspace row shows the path and project chips, never the raw TOML header", () => {
  assert.match(source, /workspaceSectionPath\(item\.key\)/);
  assert.match(source, /shortenPath\(workspacePath\)/);
  assert.match(source, /const projects = workspaceProjects\(item\.value\);/);
  assert.match(source, /\{projects\.map\(\(project\) =>/);
  assert.match(source, /<span key=\{project\} className="polyforge-config-chip">\{project\}<\/span>/);
  assert.match(source, /aria-label=\{t\("polyforge\.settings\.configProjects"\)\}/);
  // The raw key renders only when the header did not parse (a visible degradation).
  assert.match(source, /workspacePath !== null\s*\n\s*\? <span className="polyforge-config-workspace-path">/);
});

test("the grid CSS shares fixed tracks and stacks on phones", async () => {
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  for (const cls of ["polyforge-config-card", "polyforge-config-grid", "polyforge-config-badge", "polyforge-config-empty", "polyforge-config-chips", "polyforge-config-chip", "polyforge-config-write", "polyforge-config-workspace-path"]) {
    assert.match(css, new RegExp(`\\.${cls}\\b`), `${cls} is styled`);
  }
  // Page-level shared tracks: key/class are fixed, so the value column starts
  // at the same x in every card regardless of a daemon column.
  assert.match(css, /--polyforge-col-key: \d+px;/);
  assert.match(css, /--polyforge-col-class: \d+px;/);
  assert.match(css, /\.polyforge-config-grid \{[^}]*grid-template-columns: var\(--polyforge-col-key\) var\(--polyforge-col-class\) var\(--polyforge-col-value\);/);
  assert.match(css, /\.polyforge-config-grid\.has-daemon \{[^}]*var\(--polyforge-col-daemon\);/);
  assert.match(css, /\.polyforge-config-row \{[^}]*grid-template-columns: subgrid;/);
  assert.match(css, /@media \(max-width: 640px\) \{[^@]*\.polyforge-config-grid-header \{ display: none; \}/);
});

test("the card, column and placeholder strings exist in all three locales", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of [
      "configGroupFlat", "configGroupFlatHint", "configGroupDaemon", "configGroupDaemonHint",
      "configGroupWorkspace", "configGroupWorkspaceHint", "configGroupSummarize", "configGroupSummarizeHint",
      "configColKey", "configColClass", "configColFile", "configColDaemon", "configUnset", "configProjects",
      "configStatusTitle", "configPackageHint", "configLegend", "configModels", "configAddModel", "configRemoveModel",
      "classRestartOnly", "classCliOnly", "classLive", "classNextClaim", "classUnknown",
    ]) {
      assert.match(text, new RegExp(`"polyforge\\.settings\\.${key}": "`), `${locale} must carry ${key}`);
    }
  }
});

test("candidates are collapsible per-project groups with model chips", () => {
  const card = source.slice(source.indexOf('polyforge-config-card polyforge-config-steps'), source.indexOf("config.steps_complete === false"));
  assert.match(card, /groupStepsByProject\(config\.steps\)\.map\(\(group\) =>/);
  assert.match(card, /<details key=\{group\.project \?\? ""\} className="polyforge-config-candidate-group" open>/, "groups are native details, open by default");
  assert.match(card, /<summary>/);
  assert.match(card, /t\("polyforge\.settings\.configCandidateCount", \{ count: group\.steps\.length \}\)/);
  assert.match(card, /group\.project \?\? t\("polyforge\.settings\.configAllProjects"\)/);
  assert.match(card, /\(step\.models \?\? \[\]\)\.map\(\(model, index\) =>/, "one chip per model, in pf's order");
  assert.match(card, /className="polyforge-config-chip">\{model\}<\/span>/);
  assert.match(card, /t\("polyforge\.settings\.configBundleDefault"\)/, "an undeclared step still says bundle default");
  assert.match(card, /t\("polyforge\.settings\.configGroupCandidatesHint"\)/);
  assert.doesNotMatch(card, /\.join\(", "\)/, "no flat comma-joined model list");
});

test("candidate group CSS and strings in all three locales", async () => {
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  assert.match(css, /\.polyforge-config-candidate-group > summary \{/);
  assert.match(css, /\.polyforge-config-candidate-group > summary:focus-visible \{/);
  assert.match(css, /\.polyforge-config-candidate-step \{/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["configGroupCandidatesHint", "configAllProjects"]) {
      assert.match(text, new RegExp(`"polyforge\\.settings\\.${key}": "`), `${locale} must carry ${key}`);
    }
    assert.match(text, /"polyforge\.settings\.configCandidateCount": "[^"]*\{count\}/, `${locale}'s count interpolates {count}`);
  }
});

test("exactly two browser-stored numeric controls, built from the shared blocks, with no server write", () => {
  const start = source.indexOf("function PanelPreferenceRow(");
  const row = source.slice(start, source.indexOf("export function PolyforgeConfig("));
  assert.ok(start >= 0, "the preference row exists");
  assert.match(row, /<ConfigDetailGridRow label=\{label\} tone="plain">/, "a shared grid row");
  assert.match(row, /type="number"/);
  assert.match(row, /min=\{spec\.min\}\s*max=\{spec\.max\}/, "the input declares the bounds");
  assert.match(row, /<ConfigButton size="small" onClick=\{save\}>\{saveLabel\}<\/ConfigButton>/, "Save sits right after its input");
  assert.match(row, /writePolyforgePreference\(spec, draft \?\? value\);/, "the save clamps and stores through the preferences module");
  assert.match(row, /className="config-scope-switch-reason">\{hint\}</, "a visible hint, not a tooltip");
  assert.doesNotMatch(row, /fetch\(|\/api\//, "no request: browser storage only");
  const section = source.slice(source.indexOf("polyforge-config-cards"), source.indexOf("polyforge-config-package"));
  assert.equal((section.match(/<PanelPreferenceRow/g) ?? []).length, 2, "exactly the two new controls");
  assert.match(section, /spec=\{POLYFORGE_TITLE_LENGTH\}/);
  assert.match(section, /spec=\{POLYFORGE_POLL_INTERVAL\}/);
  assert.doesNotMatch(section, /detect/, "the card does not depend on pf detection");
  assert.match(source, /const \{ titleLength, pollIntervalSec \} = usePolyforgePanelPreferences\(\);/, "the inputs show the stored (clamped) values");
});

test("the card-preference strings exist in all three locales", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["cardsTitle", "cardsHint", "cardsTitleLength", "cardsTitleLengthHint", "cardsPollInterval", "cardsPollIntervalHint"]) {
      assert.match(text, new RegExp(`"polyforge\\.settings\\.${key}": "\\S`), `${locale} must carry ${key}`);
    }
  }
});
