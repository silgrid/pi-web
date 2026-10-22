# Settings panels: plugins, skills and shared blocks

## Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable and disable; disabling writes empty `extensions/skills/prompts/themes` arrays to the package entry.
- `/api/skills` lists through `DefaultResourceLoader`, so settings paths, package skills and project `.agents/skills` appear as the runtime sees them. Toggling a skill edits only the `disable-model-invocation` frontmatter key of its `SKILL.md`, so user formatting survives, and `PATCH /api/skills` edits only `.md` files (its roots also hold `auth.json`, settings and project files). `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run in the selected cwd.
- **Group switches.** Each sidebar group of the Skills, Plugins and MCP panels (a skill scope, a package scope, an `mcp.json`; not standalone extensions) has a `ConfigSidebarGroupSwitch` in its heading row, so the 190px phone sidebar loses no height. As with the Models provider switch, it is on only while every row is: a partial group reads as off beside its `n/m` count and one click completes it. A panel whose group can hold rows its switch never turns on passes its own `checked` (MCP: `mcpGroupSwitchChecked()`), or the switch stays off for good. One request carries the list (`PATCH /api/skills` `filePaths`, `POST /api/plugins` `packages`, `POST /api/mcp` `set-enabled` `servers`) and answers per item, so a refused row does not stop the rest; what was left undone shows under the heading (`ConfigSidebarGroupStatus`). An entry already in the requested state is left alone; enabling keeps an entry's own keys such as `autoload`. `SettingsManager` never throws a failed load or write (`flush()` resolves), so the bulk plugin path reads `drainErrors()`, or an unreadable settings.json would report success. Disabling empties the four resource lists and keeps no filters, so a group switched off leaves an enabled filtered package on (the SDK reports every object entry as `filtered`) and says so; the bulk route refuses it.

## Polyforge section (pi#122)

Settings › Polyforge is always visible — not `requiresProject`-gated, openable
and restorable with no project selected (`"polyforge"` in
`lib/settings-navigation.ts`'s `SETTINGS_SECTION_VALUES`, not in
`PROJECT_SECTIONS`). It renders `components/PolyforgeConfig.tsx` from the
shared blocks; its machine-level detection comes from
`GET /api/polyforge/detect` (the route contract and the detection rules are in
[polyforge-panel.md](polyforge-panel.md)).

- **Cadence — never a poll.** Detection runs once each time the section
  becomes active (the section host keeps visited sections mounted and passes
  an `active` signal, so every open re-detects), again on the 「重新检测」
  control (`?force=1`, bypassing the 60 s presence cache), and automatically
  after a toggle (non-force). No timer exists in the section, and the dock's
  polling hook (`hooks/usePolyforge.ts`) is deliberately not reused. The
  activation fetch is guarded against React StrictMode's simulated dev remount
  (setup → cleanup → setup), so one open issues exactly one detect request.
- **未安装 state.** pf absent renders a clear 「未安装」 line — no blank
  panel, no error surface — plus the copyable install.sh install/upgrade
  command (`polyforge.settings.installCommand`, a fixed i18n string with
  placeholders only, identical in every locale; a copy button puts it on the
  clipboard, nothing ever executes it). The command is shown in every state.
- **Rows.** Version (verbatim, with the non-blocking 「版本过低」 hint below
  v2.18.1), line (内部线/公开线/未知), the pi skill package state
  (已安装/未安装, 已启用/未启用 — global settings only), the two read-only
  Claude Code items (skill symlink present/absent, SessionStart hook
  present/absent — no control either way), and the daemon row
  (可达/不可达 + pf's own stderr/不适用 without pf).
- **The one switch.** The pi package switch renders only when the skill is
  installed (未安装 shows no toggle — only the state and the install command).
  It is the section's only switch, and it writes through the existing global
  path exactly as PluginsConfig's package switch does: `POST /api/plugins`
  `{action: "enable"|"disable", source, scope: "global", cwd}`. The source is
  resolved from that listing's join (`scope === "global" &&
  packageName === "polyforge"`), never from the detect response (which
  carries no paths). With no project selected the switch renders disabled
  with visible reason text (the write path needs a `cwd`); it is never a
  tooltip-only title. Write failures surface as a visible footer status.
  Nothing in the section edits `cli.toml`, writes Claude Code config, or
  executes any install.

## Shared blocks
- Panels are built from the shared blocks in `components/SettingsUi.tsx` (`ConfigScopeTag`, `ConfigScopeSwitch`, `ConfigSaveTarget`, `ConfigAddSourceHeading`, `ConfigAddSourcePanel`, `ConfigDetailGrid`, `ConfigFooterStatus`, `ConfigTrustNotice`), `itemsToSwitch()` in `components/settings-ui-helpers.ts`, and `lib/display-path.ts`; a new settings section reuses them instead of copying a panel. `SettingsUi.tsx` takes every word as a prop and holds no state, so it renders outside the i18n provider; panels pass `t()` strings.
- **Every add pane chooses global or project in one place:** a `ConfigSaveTarget` (scope switch aria-labelled `config.saveTo`, plus the path that choice writes to) first under the pane's title, where a detail pane shows its `ConfigScopeTag` and path. Skills, Plugins and MCP get it through `ConfigAddSourceHeading` (title, the catalog link at its right, then the save target); Sub-agents put it in the detail header in place of the tag while creating. The submit button stays where its flow needs it (Install under the source box or on each skill result, Save in the footer, Add at the end of the MCP form), with why it waits beside it, not under the save target. The path is shown whole, never cut short: it wraps after a separator (`<wbr>`), then anywhere. Sub-agents offer both scopes whatever the folder's trust: profiles are not project resources that wait for it.
- **Why a control is unavailable is visible text** — a scope switch's `disabledReason` (under the switch's whole line, so controls passed as its `children` stay level with it), the note under a detail header, a footer summary that opens its diagnostics — never only a `title` tooltip, which a touch screen cannot show.
- `ConfigTrustNotice` shows its button only when given `onTrust`; Settings › MCP passes AppShell's trust dialog through `SettingsPanel` (see **Trust from Settings** in [mcp-settings.md](mcp-settings.md)). Skills and Plugins take the page's `trust` and reload after a decision but have no Trust button; adding one needs `onOpenTrustDialog` passed to them and `mcpProjectTrustable()`'s rule.
