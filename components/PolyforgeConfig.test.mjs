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
  // the same browser-safe module also carries the step-key guard.
  assert.match(source, /import \{ configValueError, stepValueError, stepWriteKey \} from "@\/lib\/polyforge-config-schema";/, "the guard comes from the browser-safe module");
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

test("visible reasons: capability floor, unmapped cwd and an incomplete workflow read are text", () => {
  assert.match(source, /config\?\.capable === false/);
  assert.match(source, /configReason/);
  assert.match(source, /config\.mapped/);
  // the step facts moved to the workflow card, whose failed or
  // daemon-less read is a visible alert line (the old steps_complete note's role).
  assert.match(source, /\{readError && <p role="alert" className="config-add-source-error">\{readError\}<\/p>\}/);
  assert.match(source, /polyforge\.settings\.configMachineScope/);
});

test("items render in source cards with a title and a visible one-line hint", () => {
  assert.match(source, /configCards\(groupConfigItems\(config\.items \?\? \[\]\)\)\.map\(\(group\) =>/);
  assert.match(source, /<p className="polyforge-config-card-title">\{t\(GROUP_TITLE\[group\.id\]\)\}<\/p>/);
  assert.match(source, /<p className="polyforge-config-card-hint">\{t\(GROUP_HINT\[group\.id\]\)\}<\/p>/);
  // the 工作区 card replaces the mapping and summarize cards.
  assert.match(source, /workspace: "polyforge\.settings\.workspaceTitle",/, "the merged card's title");
  assert.match(source, /workspace: "polyforge\.settings\.configGroupWorkspaceHint",/, "the merged card's hint");
  assert.doesNotMatch(source, /configGroupSummarize|configGroupWorkspace"/, "no summarize card and no old mapping-card title");
  for (const id of ["Flat", "Daemon"]) {
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

test("at <=640px the key and class badge share a row and the values span the row below", async () => {
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  const phone = css.slice(css.indexOf("@media (max-width: 640px) {\n  /* Phones:"));
  const block = phone.slice(0, phone.indexOf("\n}\n"));
  assert.ok(block.length > 0, "the config page's phone block exists");
  assert.match(block, /\.polyforge-config-row,\s*\.polyforge-config-row\.no-daemon \{\s*grid-template-columns: minmax\(0, 1fr\) auto;/, "two columns: key, then the badge");
  assert.match(block, /\.polyforge-config-class \{ justify-self: end; \}/, "the badge sits at the row's right end");
  assert.match(block, /\.polyforge-config-badge \{ max-width: none; \}/, "the badge is never squeezed");
  assert.match(block, /\.polyforge-config-file,\s*\.polyforge-config-daemon,\s*\.polyforge-config-row\.no-daemon \.polyforge-config-file \{ grid-column: 1 \/ -1; \}/, "values span the row below");
  assert.doesNotMatch(block, /grid-template-columns: minmax\(0, 1fr\);\s*gap: 4px;/, "no single stacked column any more");
});

test("the card, column and placeholder strings exist in all three locales", async () => {
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of [
      "configGroupFlat", "configGroupFlatHint", "configGroupDaemon", "configGroupDaemonHint",
      "configGroupWorkspaceHint", "workspaceTitle", "workspaceSourceFile", "memoryPolicyTitle", "memoryPolicyAppendNote",
      "configColKey", "configColClass", "configColFile", "configColDaemon", "configUnset", "configProjects",
      "configStatusTitle", "configPackageHint", "configLegend", "configModels", "configAddModel", "configRemoveModel",
      "classRestartOnly", "classCliOnly", "classLive", "classNextClaim", "classUnknown",
    ]) {
      assert.match(text, new RegExp(`"polyforge\\.settings\\.${key}": "`), `${locale} must carry ${key}`);
    }
  }
});

test("the read-only declared-candidates card is gone, region and strings included", async () => {
  // Replaces the #88/#212 candidates-card pins: the workflow card carries the step facts.
  assert.doesNotMatch(source, /polyforge-config-steps|polyforge-config-candidate-(group|step|project)/, "no candidates card markup");
  assert.doesNotMatch(source, /disclosure\.candidates|setRegion\("candidates"/, "no candidates region");
  assert.doesNotMatch(source, /groupStepsByProject|config\.steps\b/, "the card no longer reads the config steps");
  assert.doesNotMatch(source, /configCandidates|configCandidateCount|configBundleDefault|configAllProjects|configStepsIncomplete/);
  assert.ok(source.indexOf("<WorkflowCard") > 0, "the workflow card takes over");
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.polyforge-config-candidate-(group|step|project)/, "the candidate CSS is deleted");
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["configCandidates", "configGroupCandidatesHint", "configCandidateCount", "configAllProjects", "configBundleDefault", "configStepsIncomplete", "configGroupSummarize", "configGroupSummarizeHint", "configGroupWorkspace"]) {
      assert.doesNotMatch(text, new RegExp(`"polyforge\\.settings\\.${key}": `), `${locale} drops ${key}`);
    }
  }
});

test("one 工作区 card carries the mapping, summarize and read-only memory_policy rows, each tagged with its file", () => {
  assert.match(source, /function configCards</);
  assert.match(source, /const summarize = groups\.find\(\(group\) => group\.id === "summarize"\)\?\.items \?\? \[\];/);
  assert.match(source, /items: \[\.\.\.group\.items, \.\.\.summarize\]/, "the mapping rows, then the summarize rows");
  assert.match(source, /return item\.section \? "cli\.toml" : "\.polyforge\.yaml";/, "the tag names the row's own file");
  assert.match(source, /\{isWorkspace\s*\n\s*\? <span className="polyforge-config-file-tag" title=\{t\("polyforge\.settings\.workspaceSourceFile"\)\}>\{workspaceRowFile\(item\)\}<\/span>/);
  // memory_policy rows: from the config read, read-only, no write control, tagged.
  const memory = source.slice(source.indexOf("const renderMemoryRow ="), source.indexOf("// the legend and the column header"));
  assert.match(source, /const policy = isWorkspace \? config\.memoryPolicy \?\? null : null;/);
  assert.match(memory, /className="polyforge-config-row is-readonly"/);
  assert.match(memory, /<span className="polyforge-config-file-tag" title=\{t\("polyforge\.settings\.workspaceSourceFile"\)\}>\.polyforge\.yaml<\/span>/);
  assert.doesNotMatch(memory, /<input|<textarea|<ConfigButton|onClick/, "memory_policy is read-only");
  assert.match(source, /t\("polyforge\.settings\.memoryPolicyTitle"\)/);
  assert.match(source, /policy\?\.appendToDefault && <p className="config-scope-switch-reason">\{t\("polyforge\.settings\.memoryPolicyAppendNote"\)\}<\/p>/);
  // Each file keeps its own write path: summarize rows still post summarize.* to the yaml writer.
  assert.match(source, /const workspace = item\.key\.startsWith\("summarize\."\);\s*\n\s*const hash = workspace \? config\.workspaceFile\?\.sha256 : config\.file\?\.sha256;/);
});

test("every card's legend and grid header sit above its fold, so collapsing hides rows only", () => {
  const card = source.slice(source.indexOf("// the legend and the column header"), source.indexOf("void reload()"));
  const fold = card.indexOf('className="polyforge-disclosure-body polyforge-config-fold"');
  assert.ok(fold > 0);
  assert.ok(card.indexOf("{legend}") > 0 && card.indexOf("{legend}") < fold, "the legend renders before the fold body");
  assert.ok(card.indexOf("{gridHeader}") > 0 && card.indexOf("{gridHeader}") < fold, "the header renders before the fold body");
  assert.equal((card.match(/\{legend\}/g) ?? []).length, 1, "one legend per card, never inside the fold");
  assert.equal((card.match(/\{gridHeader\}/g) ?? []).length, 1, "one header per card, never inside the fold");
  assert.match(card, /\{\(common\.length > 0 \|\| foldCount > 0\) && \(/, "the header shows even when every row folds");
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
  // the Jobs card's own section, marker to its closing tag
  // (the package switch now renders before it).
  const cardsStart = source.indexOf("polyforge-config-card polyforge-config-cards");
  const section = source.slice(cardsStart, source.indexOf("</section>", cardsStart));
  assert.ok(cardsStart > source.indexOf("polyforge-config-card polyforge-config-package"), "the Jobs card renders after the package switch");
  assert.equal((section.match(/<PanelPreferenceRow/g) ?? []).length, 2, "exactly the two new controls");
  assert.equal((section.match(/<input|<ConfigSwitch|<ConfigButton/g) ?? []).length, 0, "the two preference rows are the card's only controls");
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

test("detection collapses to one visible summary line over its six detail rows", async () => {
  const statusStart = source.indexOf("polyforge-config-card polyforge-config-status");
  const status = source.slice(statusStart, source.indexOf("</section>", statusStart));
  assert.ok(status.length > 0, "the detection card exists");
  // One toggle line, default closed through the stored region, never forced open.
  assert.match(status, /<DisclosureToggle\s*\n\s*open=\{disclosure\.detect\}/);
  assert.match(status, /onToggle=\{\(\) => setRegion\("detect", !disclosure\.detect\)\}/);
  assert.match(status, /hidden=\{!disclosure\.detect\}/, "the detail body is hidden while the region is closed");
  assert.match(status, /\{detectSummary\}/, "the summary line is the toggle's visible text");
  // The six detail rows stay, unchanged, inside the body.
  for (const key of ["version", "line", "piSkill", "claudeSymlink", "claudeHook", "daemon"]) {
    assert.match(status, new RegExp(`<ConfigDetailGridRow label=\\{t\\("polyforge\\.settings\\.${key}"\\)\\}`), `detail row ${key}`);
  }
  assert.equal((status.match(/<ConfigDetailGridRow /g) ?? []).length, 6, "exactly the six detail rows");
  // Abnormal states are visible text in the summary, never a tooltip.
  assert.match(source, /detect\.pfPresent === false\s*\n\s*\? t\("polyforge\.settings\.notInstalled"\)/, "pf absent names itself");
  assert.match(source, /detect\.pfVersionBelowMinimum \? ` · \$\{t\("polyforge\.settings\.belowMinimum"\)\}` : ""/, "below minimum is appended");
  assert.match(source, /t\("polyforge\.settings\.configSummary", \{\s*\n\s*version:[^\n]*\n\s*line: lineLabel,\s*\n\s*daemon: daemonState,/);
  assert.match(source, /t\("polyforge\.settings\.daemonUnreachable"\)/, "daemon unreachable reads as text");
  assert.doesNotMatch(source, /<p className="config-empty-state">\{t\("polyforge\.settings\.notInstalled"\)\}<\/p>/, "no duplicate standalone not-installed paragraph");
  // The toggle is a real button with aria-expanded/aria-controls.
  assert.match(source, /function DisclosureToggle\(/);
  assert.match(source, /aria-expanded=\{open\}\s*\n\s*aria-controls=\{controls\}/);
  assert.match(source, /usePolyforgeDisclosure\(\)/, "the regions come from the browser-only disclosure hook");
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    const line = text.match(/"polyforge\.settings\.configSummary": "([^"]*)"/)?.[1] ?? "";
    for (const placeholder of ["{version}", "{line}", "{daemon}"]) assert.ok(line.includes(placeholder), `${locale} summary carries ${placeholder}`);
  }
});

test("each card shows its common writable rows and folds the rest under a counted disclosure", async () => {
  const cards = source.slice(source.indexOf("configCards(groupConfigItems(config.items ?? [])).map((group) =>"), source.indexOf("void reload()"));
  // The common set is the seven writable keys, decided by key, never by mapping.
  for (const key of ["max_concurrent_jobs", "step_timeout", "stall_window", "summarize.models", "summarize.language", "summarize.interval_sec", "api_key"]) {
    assert.match(source.slice(source.indexOf("const WRITABLE = new Set(["), source.indexOf("]);", source.indexOf("const WRITABLE"))), new RegExp(`"${key.replace(/\./g, "\\.")}"`), `${key} is common`);
  }
  // one rule for every card, the 工作区 card included (its
  // summarize keys are its common rows; the mapping and memory rows fold).
  assert.match(cards, /const common = group\.items\.filter\(\(item\) => WRITABLE\.has\(item\.key\) && !item\.section\);/);
  assert.doesNotMatch(cards, /const common = [^\n]*mapped/, "the common set never depends on the mapping");
  assert.match(cards, /const folded = group\.items\.filter\(\(item\) => !common\.includes\(item\)\);/, "every other item, unknown keys included, folds");
  // One row renderer for both lists, so the #126 row markup is unchanged.
  assert.match(cards, /const renderRow = \(item: PolyforgeConfigItem\) => \{/);
  assert.match(cards, /\{common\.map\(renderRow\)\}/);
  assert.match(cards, /\{folded\.map\(renderRow\)\}/);
  // The fold: counted, stored per card region, default closed.
  assert.match(cards, /const foldCount = folded\.length \+ memoryRows\.length;/, "the count covers every folded row");
  assert.match(cards, /t\("polyforge\.settings\.configReadOnlyCount", \{ count: foldCount \}\)/);
  assert.match(cards, /t\("polyforge\.settings\.configRowCount", \{ count: foldCount \}\)/, "the workspace card states its row count");
  assert.match(cards, /const fold = regionToggle\(region, lockMarker\(folded\.map\(\(item\) => item\.key\)\)\);/);
  assert.match(cards, /open=\{fold\.open\}/);
  assert.match(cards, /hidden=\{!fold\.open\}/);
  assert.match(source, /const GROUP_REGION: Record<ConfigCardId, PolyforgeDisclosureRegion> = \{\s*\n\s*flat: "cliToml",\s*\n\s*daemon: "daemon",\s*\n\s*workspace: "workspace",\s*\n\};/);
  // An unmapped cwd keeps summarize.* in the common position, read-only.
  assert.match(cards, /const writable = WRITABLE\.has\(item\.key\) && !item\.section && \(!item\.key\.startsWith\("summarize\."\) \|\| config\.mapped\);/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["configReadOnlyCount", "configRowCount"]) {
      assert.match(text, new RegExp(`"polyforge\\.settings\\.${key}": "[^"]*\\{count\\}`), `${locale}'s ${key} interpolates {count}`);
    }
  }
});

test("every read-only row shares one muted value treatment", async () => {
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  for (const leaf of ["polyforge-config-value", "polyforge-config-workspace-path", "polyforge-config-chips", "polyforge-config-chip", "polyforge-config-empty"]) {
    assert.match(css, new RegExp(`\\.polyforge-config-row\\.is-readonly \\.${leaf}[,\\s][^}]*?\\{ color: var\\(--text-muted\\); \\}`), `${leaf} is muted in a read-only row`);
  }
  // A read-only row renders no write control: renderValue only writes when writable.
  assert.match(source, /if \(writable\) \{\s*\n\s*return \(\s*\n\s*<span className="polyforge-config-write">/);
  assert.match(source, /if \(!writable\) return chips;/);
});

test("the confirmed page order and the default-collapsed read-outs", async () => {
  const markers = [
    "polyforge-config-card polyforge-config-status",
    "<div className=\"polyforge-config-panel\">",
    "configCards(groupConfigItems(config.items ?? [])).map((group) =>",
    "void reload()",
    "<WorkflowCard",
    "polyforge-config-card polyforge-config-package",
    "polyforge-config-card polyforge-config-cards",
    "aria-label={t(\"polyforge.settings.configHistory\")}",
    "polyforge-config-card polyforge-config-install",
    "<ConfigFooter",
  ];
  let previous = -1;
  for (const marker of markers) {
    const at = source.indexOf(marker);
    assert.ok(at > previous, `${marker} renders in the confirmed order`);
    previous = at;
  }
  // History: closed by default, its title counts the entries; rollback rows unchanged inside.
  assert.match(source, /const historyRegion = regionToggle\("history", lockMarker\(history\.map\(\(entry\) => entry\.id\)\)\);/);
  assert.match(source, /open=\{historyRegion\.open\}/);
  assert.match(source, /hidden=\{!historyRegion\.open\}/);
  assert.match(source, /t\("polyforge\.settings\.configHistoryCount", \{ count: history\.length \}\)/);
  assert.match(source, /\{entry\.rollbackable && entry\.key !== "api_key" && \(/);
  // Install: closed by default, no count, forced open (never stored) until pf is proven present and new enough.
  assert.match(source, /const installForced = !detect \|\| detect\.pfPresent === false \|\| detect\.pfVersionBelowMinimum === true;/);
  assert.match(source, /hidden=\{!installForced && !disclosure\.install\}/);
  assert.doesNotMatch(source, /setRegion\("install", (true|installForced)/, "the forced state is never written");
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.match(text, /"polyforge\.settings\.configHistoryCount": "[^"]*\{count\}/, `${locale}'s history count interpolates {count}`);
  }
});

test("per-key results render under their own row; the footer keeps page-level status only", async () => {
  const saveFn = source.slice(source.indexOf("const save = useCallback("), source.indexOf("const reload = useCallback("));
  const rollbackFn = source.slice(source.indexOf("const rollback = useCallback("), source.indexOf("const installCommand ="));
  // The schema guard still runs before any write, and its error lands under the row.
  assert.match(saveFn, /const invalid = configValueError\(item\.key, value, item\.schema\);\s*\n\s*if \(invalid\) \{\s*\n\s*setRowFeedback\(\{ \[item\.key\]: \{ message: invalid, tone: "error" \} \}\);\s*\n\s*return;/);
  assert.match(saveFn, /setRowFeedback\(\{ \[item\.key\]: \{ message: data\.message \?\? t\("polyforge\.settings\.configSaved"\), tone: "default" \} \}\);/);
  assert.match(saveFn, /await runHistory\(\);/, "a save still refreshes history");
  assert.match(rollbackFn, /setRowFeedback\(\{ \[entry\.id\]: /, "a rollback result is keyed by its entry");
  for (const fn of [saveFn, rollbackFn]) {
    assert.doesNotMatch(fn, /setActionError|setActionMessage/, "row results never reach the footer");
  }
  // Rendered inside the row / entry; an error is an alert.
  assert.match(source, /role=\{feedback\.tone === "error" \? "alert" : undefined\}/);
  assert.match(source, /\{renderFeedback\(item\.key\)\}\s*\n\s*<\/div>/, "under its config row");
  assert.match(source, /\{renderFeedback\(entry\.id\)\}\s*\n\s*<\/div>/, "under its history entry");
  // Copy feedback stays in the install block.
  assert.match(source, /setInstallMessage\(t\("polyforge\.settings\.installCopied"\)\)/);
  assert.doesNotMatch(source, /setActionMessage\(t\("polyforge\.settings\.installCopied"\)\)/);
  // The footer's summary is the page-level status.
  assert.match(source, /summary=\{actionError \?\? actionMessage \?\? \(detect \? t\("polyforge\.settings\.detected"\) : t\("polyforge\.loading"\)\)\}/);
  // Element budget: still exactly one switch; numeric inputs only via the two preference rows plus pf's own int keys.
  assert.equal((source.match(/<ConfigSwitch\b/g) ?? []).length, 1, "exactly one role=switch");
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  assert.match(css, /\.polyforge-config-row-feedback \{[^}]*grid-column: 1 \/ -1;/, "the result spans the row");
});

test("a draft or an error locks its region open with a visible marker, never stored", async () => {
  assert.match(source, /const lockMarker = \(ids: string\[\]\): string \| null =>/);
  assert.match(source, /rowFeedback\[id\]\?\.tone === "error"\)\) return t\("polyforge\.settings\.configErrorMarker"\)/);
  assert.match(source, /return t\("polyforge\.settings\.configDraftMarker"\)/);
  assert.match(source, /open: marker !== null \|\| disclosure\[region\],/, "open = locked || stored");
  assert.match(source, /onToggle: \(\) => \{ if \(marker === null\) setRegion\(region, !disclosure\[region\]\); \},/, "a locked toggle writes nothing");
  assert.match(source, /\{marker \? <span className="polyforge-disclosure-marker">\{marker\}<\/span> : null\}/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of ["configDraftMarker", "configErrorMarker"]) {
      assert.match(text, new RegExp(`"polyforge\\.settings\\.${key}": "\\S`), `${locale} must carry ${key}`);
    }
  }
});

// the workflow card.
const workflowCard = source.slice(source.indexOf("function WorkflowCard("));

test("the workflow card reads its own route afresh per click with the #204 refresh pattern", () => {
  assert.ok(workflowCard.length > 0, "the card exists");
  assert.match(workflowCard, /fetch\(`\/api\/polyforge\/workflows\?cwd=\$\{encodeURIComponent\(cwd \?\? ""\)\}`\)/, "one fresh read of the route");
  // Only the newest read writes the card or ends the spin.
  assert.match(workflowCard, /const seq = \+\+readSeqRef\.current;/);
  assert.equal((workflowCard.match(/if \(seq !== readSeqRef\.current\) return;/g) ?? []).length, 2, "both the answer and the failure check the seq");
  // A failed read keeps the last good list: it never clears `read`.
  assert.doesNotMatch(workflowCard, /setRead\(null\)/);
  assert.match(workflowCard, /if \(!good\) \{\s*\n\s*\/\/ Keep the list on screen; the error sits above it\.\s*\n\s*setReadError\(/);
  assert.match(workflowCard, /\{readError && <p role="alert" className="config-add-source-error">\{readError\}<\/p>\}/);
  // The 26px ↻: disabled, aria-busy and spinning while the newest read is in flight; the existing keys.
  assert.match(workflowCard, /className=\{`polyforge-workflow-refresh\$\{refreshing \? " animate-spin" : ""\}`\}/);
  assert.match(workflowCard, /disabled=\{refreshing\}\s*\n\s*aria-busy=\{refreshing\}/);
  assert.match(workflowCard, /aria-label=\{refreshing \? t\("polyforge\.refreshing"\) : t\("polyforge\.refresh"\)\}/);
  assert.doesNotMatch(workflowCard, /setInterval|setTimeout/, "no timer: a read is a mount or a click");
});

test("rows come from the pure model, carry the live badge, the next-dispatch note and Inherited", () => {
  assert.match(workflowCard, /const rows = buildWorkflowRows\(workflows, read\?\.workspace \?\? null, project\);/);
  assert.match(workflowCard, /: defaultProject\(projects\);/, "the first mapped project is the default");
  assert.match(workflowCard, /<li key=\{row\.id\} className="polyforge-workflow-row">/);
  assert.match(workflowCard, /<span className="polyforge-workflow-id">\{row\.id\}<\/span>/);
  assert.match(workflowCard, /reloadClassLabel\("live"\)/);
  assert.match(workflowCard, /t\("polyforge\.settings\.classLiveNote"\)/);
  assert.match(workflowCard, /t\("polyforge\.settings\.workflowInherit"\)/);
  assert.match(workflowCard, /t\("polyforge\.settings\.workflowDeclared"\)/);
  assert.match(workflowCard, /t\("polyforge\.settings\.workflowSourceLabel"\)\}: \{view\.from\}/, "the effective chain names its level");
  // No element inside a row other than the row itself carries "row" in its class (the row is the row).
  const rowBody = workflowCard.slice(workflowCard.indexOf('className="polyforge-workflow-row"') + 10, workflowCard.indexOf("</li>"));
  assert.doesNotMatch(rowBody.replace("polyforge-config-row-feedback", ""), /className="[^"]*row[^"]*"/);
});

test("pf submit --models is a note only and writes go through the one config route with the yaml CAS", () => {
  assert.match(workflowCard, /<p className="config-scope-switch-reason">\{t\("polyforge\.settings\.workflowSubmitNote"\)\}<\/p>/);
  for (const label of workflowCard.matchAll(/aria-label=\{([^}]*)\}/g)) {
    assert.doesNotMatch(label[1], /submit|--models/, "no control edits pf submit --models");
  }
  assert.match(workflowCard, /fetch\("\/api\/polyforge\/config", \{/);
  assert.match(workflowCard, /expect_state: \{ file_sha256: read\?\.workspace\?\.yaml\.sha256 \?\? null, values: \{\} \}/);
  assert.match(workflowCard, /stepWriteKey\(project \?\? "", row\.id\)/);
  assert.match(workflowCard, /stepWriteKey\(project \?\? "", row\.id, attr\.name\)/);
  assert.match(workflowCard, /void write\(row\.id, key, "unset"\)/, "clear = unset (falls back one level)");
  assert.doesNotMatch(workflowCard, /harness\.|ParseCandidate|candidateError/, "no UI candidate validator");
});

test("below the capability floor the read facts stay and every write control is disabled with visible text", () => {
  assert.match(workflowCard, /const writeCapable = workflows\?\.write_capable === true && read\?\.workspace !== null && project !== null;/);
  assert.match(workflowCard, /const disabled = !writeCapable \|\| writing !== null;/);
  assert.match(workflowCard, /\{workflows && !workflows\.write_capable && \(\s*\n\s*<p className="config-scope-switch-reason">\s*\n\s*\{t\("polyforge\.settings\.workflowCapabilityHint"\)\}/);
  const editor = workflowCard.slice(workflowCard.indexOf("const renderEditor ="), workflowCard.indexOf("return (\n    <section"));
  const controls = (editor.match(/<input|<button|<ConfigButton/g) ?? []).length;
  const gated = (editor.match(/disabled=\{disabled/g) ?? []).length;
  assert.equal(gated, controls, "every write control is gated on the capability");
});

test("the card folds its write controls under the stored workflow region, locked open by a draft or error", () => {
  assert.match(workflowCard, /const foldOpen = marker !== null \|\| disclosure\.workflow;/);
  assert.match(workflowCard, /onToggle=\{\(\) => \{ if \(marker === null\) setRegion\("workflow", !disclosure\.workflow\); \}\}/);
  assert.match(workflowCard, /<div className="polyforge-workflow-editor" hidden=\{!foldOpen\}>/);
  assert.match(workflowCard, /usePolyforgeDisclosure\(\)/, "the #212 store, no third collapse idiom");
  assert.doesNotMatch(workflowCard, /localStorage/);
});

test("the workflow strings exist in all three locales and the CSS defines the card", async () => {
  const keys = ["workflowTitle", "workflowHint", "workflowProject", "workflowBundleLabel", "workflowInherit", "workflowDeclared",
    "workflowEffective", "workflowSourceLabel", "workflowSubmitNote", "workflowCapabilityHint", "workflowBundleError",
    "workflowChainAdd", "workflowChainClear", "workflowAttrBatch", "workflowDefaultRow", "workflowTaskRow", "workflowEditToggle", "classLiveNote"];
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const text = await readFile(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    for (const key of keys) assert.match(text, new RegExp(`"polyforge\\.settings\\.${key}": "\\S`), `${locale} must carry ${key}`);
    assert.match(text, /"polyforge\.settings\.workflowCapabilityHint": "[^"]*2\.20\.15/, `${locale}'s hint names the floor`);
    assert.match(text, /"polyforge\.settings\.workflowSubmitNote": "`pf submit --models`/);
  }
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  for (const cls of ["polyforge-workflow-refresh", "polyforge-workflow-row", "polyforge-workflow-id", "polyforge-workflow-note", "polyforge-workflow-editor"]) {
    assert.match(css, new RegExp(`\\.${cls}[ ,{.]`), `${cls} is styled`);
  }
});
