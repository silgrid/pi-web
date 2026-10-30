# Settings panels: plugins, skills and shared blocks

## General appearance
- `components/FontSettings.tsx` offers separate interface/chat and monospace (code, tool output, terminal) font-name lists in the Fonts & layout section after Appearance, together with chat font size (which also sets the terminal's, hence its "Chat & terminal font size" label; client-platform.md) and content width; the Chat section keeps only behavior switches. Every row there has one shape: a header line (label, value, reset button in a fixed 28px column) over a full-width slider, so values and resets line up. A font row puts its name field between label and value, and its slider is the weight (100–600, step 100; `aria-valuetext` adds the weight's name). Both font rows share one grid (`subgrid`), so their name fields start at the same x whatever the labels' widths in each locale. The name field is drawn in the font it names, which is the preview; keep one short section description, no separate preview lines or per-control paragraphs. `hooks/useFontPreferences.ts` stores them only in the browser (`pi-ui-font-family`, `pi-mono-font-family`), applies changes immediately through `--font-ui` / `--font-mono`, and syncs other tabs. AppShell keeps the hook mounted so restoring a font never requires opening Settings or a chat. Empty input removes the override; the original stacks stay in `app/globals.css` as `--font-ui-default` / `--font-mono-default`.
- Font names refer to fonts on the **browser's device**, not the server; no enumeration, upload or remote download. `lib/font-preferences.ts` treats commas as separators, accepts optional enclosing quotes, quotes non-generic names as data, and always appends the default stack. Never interpolate font input into a stylesheet or accept it as executable CSS. Keep raw input whitespace while typing so multi-word names remain editable.
- Each font has a separate base weight (100–600 in steps of 100, default Regular/400; it stops at 600 because headings and labels use 600 and bold text, highlighted bold and the terminal's bold use 700, so a heavier base would outweigh them), stored as `pi-ui-font-weight` / `pi-mono-font-weight` and applied through `--font-ui-weight` / `--font-mono-weight`. Missing/invalid stored weights use 400; saving 400 removes the override. Each reset clears that font's name **and** weight in one update, not the other font or chat size/width. The UI weight is inherited by ordinary interface/chat text; code/pre, highlighted code (including its inline theme styles), source-view line numbers and diffs use the mono weight. Headings, Markdown bold/inline code inside emphasis, and other explicitly weighted labels keep their original weights; do not blanket-override them with `!important`.
- General's sidebar layout option (`settings.sidebarLayout`) chooses where the desktop sidebar shows the file browser: below the sessions (`stacked`, the default) or in a Sessions | Files tab (`tabs`), as two radio options in the send key's look (`settings-send-mode-option`). `lib/files-placement.ts` keeps it per browser (`pi-web:files-placement`; storage that is absent, blocked or corrupt reads as the default) and `useFilesPlacement()` subscribes through `useSyncExternalStore` (the server snapshot is the default, so hydration agrees), so Settings and `SessionSidebar` follow the same store. Phones always use tabs, whatever is stored.
- General's Chat section ends with the switch for pi's own `showCacheMissNotices` (#1265), saved in the global settings.json through `/api/cache-miss-notices`, not in the browser: the notices come from the server, and the pi CLI reads the same key. Its note says a project's `.pi/settings.json` can override it. After a save the open chat remounts (`onSessionReloaded`) to show or drop them; see sessions.md, Cache and cost notices.
- ChatInput remeasures an existing draft when the interface font or weight changes. TerminalPanel subscribes in its existing lifetime effect, updates xterm's family and normal weight (its bold stays xterm's default 700, above every base weight) and refits, never restarting the terminal or its SSE stream for a font change.

## Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable and disable; disabling writes empty `extensions/skills/prompts/themes` arrays to the package entry. Every POST drops the provider routes' shared runtime, since a package can add or drop a provider ([models.md](models.md), Auth and model config).
- `/api/skills` lists through `DefaultResourceLoader`, so settings paths, package skills and project `.agents/skills` appear as the runtime sees them. The loader takes `noExtensions: true` (`lib/skills-service.ts`, #1226): extensions add skills only through `resources_discover` at `session_start`, which a listing never runs, so importing them added nothing and blocked the event loop on every Skills open, skill click and slash-palette open. Skills an extension discovers never showed there, before or since. Even an empty extension load re-keys the SDK's one-cwd factory cache, so a listing for a folder other than the running sessions' still makes their next start re-import. The detail pane lazily reads a selected skill through `/api/skills/content` and renders its post-frontmatter instructions as Markdown; that route permits only an exact file path returned by the same runtime loader and caps the regular-file read at 1 MiB, rather than becoming a general Markdown-file reader. Toggling a skill edits only the `disable-model-invocation` frontmatter key of its `SKILL.md`, so user formatting survives, and `PATCH /api/skills` edits only `.md` files (its roots also hold `auth.json`, settings and project files). `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run in the selected cwd.
- **Skill documents.** A local link in the instructions (`MarkdownBody`'s `onNavigateLink`) opens that file in the same Instructions field. `resolveSkillLink()` resolves it from the linking document's folder, as pi resolves a skill's relative paths; `SkillDetail` keeps a stack of the documents opened, the last one shown under one Back button and its relative path. Switching skills remounts `SkillDetail`, emptying the stack. A link or Back brings the field's top, or the `#heading`, into view once the document shows: Back lands at the previous document's top, nothing saves a scroll position. A link to the skill file itself reads it without `document`. The client refuses nothing: an absolute path or a `..` past the folder goes to the route, whose message shows under Back.
- `/api/skills/content`'s optional `document` is a path in the loaded skill's `baseDir` (pi's dirname of the skill file): relative, without `..`, `\`, `:` or NUL, `.md`/`.markdown` by name and by real path, inside the folder after symlinks (`isExistingPathWithinRoots()`), a regular file up to 1 MiB. One stat before the bounded read answers a FIFO or a directory with 400 and a larger file with 413; a missing file is 404, a link out of the folder 403, and no refusal or failed read names a path. Without `document` the route reads the loaded file exactly as before.
- **Group switches.** Each sidebar group of the Skills, Plugins and MCP panels (a skill scope, a package scope, an `mcp.json`; not standalone extensions) has a `ConfigSidebarGroupSwitch` in its heading row, so the 190px phone sidebar loses no height. As with the Models provider switch, it is on only while every row is: a partial group reads as off beside its `n/m` count and one click completes it. A panel whose group can hold rows its switch never turns on passes its own `checked` (MCP: `mcpGroupSwitchChecked()`), or the switch stays off for good. One request carries the list (`PATCH /api/skills` `filePaths`, `POST /api/plugins` `packages`, `POST /api/mcp` `set-enabled` `servers`) and answers per item, so a refused row does not stop the rest; what was left undone shows under the heading (`ConfigSidebarGroupStatus`). An entry already in the requested state is left alone; enabling keeps an entry's own keys such as `autoload`. `SettingsManager` never throws a failed load or write (`flush()` resolves), so the bulk plugin path reads `drainErrors()`, or an unreadable settings.json would report success. Disabling empties the four resource lists and keeps no filters, so a group switched off leaves an enabled filtered package on (the SDK reports every object entry as `filtered`) and says so; the bulk route refuses it.

## Polyforge section (pi#122, configuration panel)

Settings › Polyforge is always visible — not `requiresProject`-gated, openable
and restorable with no project selected (`"polyforge"` in
`lib/settings-navigation.ts`'s `SETTINGS_SECTION_VALUES`, not in
`PROJECT_SECTIONS`). It renders `components/PolyforgeConfig.tsx` from the
shared blocks; its machine-level detection comes from
`GET /api/polyforge/detect` (the route contract and the detection rules are in
[polyforge-panel.md](polyforge-panel.md)).

A "Jobs card stream" card carries exactly two numeric
controls for the dock's Jobs tab: title length (default 30, 10–200) and poll
interval in seconds (default 3, 1–60), each a `ConfigDetailGridRow` with its
input, a Save `ConfigButton` right after it and a visible hint. The values live
in this browser's localStorage only (`pi-web:polyforge-title-length`,
`pi-web:polyforge-poll-interval`, `lib/polyforge-panel-preferences.ts`): no
request, no pf config, no server file. The card renders whether or not pf is
detected; the inputs show the stored value clamped (absent/corrupt/non-positive
→ the default, a positive out-of-range value → its bound), and Save clamps,
stores and dispatches `pi-web:polyforge-preferences` so an open panel applies
it without a reload.

The configuration panel below the detection block is its own surface: the
machine-scope note is always visible, and the keys of `pf --json config list`
render in source cards, each with a title and a visible one-line
hint, in a fixed order — cli.toml flat keys, `[daemon]`, workspace mapping,
summarize, then the declared candidates. The grouping is presentation only and
lives in the import-free `components/polyforge-config-helpers.ts`: pf marks no
table membership, so the daemon card uses a copy of pf's five `[daemon]` key
names (a key pf adds later shows in the cli.toml card until the list is
extended — cosmetic), a `section` item is a workspace mapping, a `summarize.`
key is summarize, and any other key stays in the cli.toml card, never dropped.
The detection block and the package switch are cards too, and the detection
rows use the same key-column width as the configuration cards.

Every card declares only its effective columns:
key | applies | file value for cli.toml and summarize, key | applies | file
value | daemon value for `[daemon]`, and workspace path | applies | projects
for the workspace card. The key and applies tracks are page-level fixed widths
(`--polyforge-col-key`, `--polyforge-col-class` on `.settings-polyforge`) and
the rows are CSS subgrids, so the value column starts at the same x in every
card whether or not that card has a daemon column; no card renders an empty
column, and a row is `is-readonly` (muted value, no write control) without
collapsing a cell. A key outside the three live daemon keys has no daemon cell
(its file value takes that width); a live daemon key whose daemon value is
unset shows the unset placeholder in that one cell. The Save button lives
inside the row's value cell, directly beside its input — never in a far-right actions column. A
workspace mapping row shows the workspace path (`shortenPath()`, display only)
with its projects as chips, never the raw `[workspace."…"]` TOML header; a
header that does not parse renders verbatim. pf's reload classes go through
`t()` (`restart-only`, `cli-only`, `live`, `next-claim`) with a per-card legend
and the raw class as the badge's tooltip; an unknown class renders through the
fallback, never as a bare token. List values (`summarize.models`) render as
individual chips with an add input and a remove control per chip, so no
comma-joined long string is displayed, while `formValue()` still splits the
comma string it builds before the write. The three daemon-column keys show the
file value beside the daemon's loaded value with a visible stale reason (and,
when `pf --json ops status` fails, the column says the daemon is not running),
and the workspace summarize values come from the cwd-resolved workspace (their
rows stay visible but read-only, with the visible reason, when the cwd is
unmapped). Under 640px the same cells stack in one column, the header hides
and nothing overflows horizontally. Below the pf capability floor,
or an old list shape, the write controls are unavailable with visible reason
text while detection keeps working. Candidate steps are read-only and render
in the candidates card as one collapsible group per project (native
`<details open>`; summary = project + step count, project-less steps in one
"all projects" group last), each step a line with its models as chips on the
line below. `groupStepsByProject()` sorts projects and steps by name (pf builds
them from Go maps, so its order is unstable) but never reorders a step's
models, which are pf's order. An undeclared step is labelled bundle default
and no composed list is shown. The
write controls are schema-derived (numeric/duration bounds from pf, enforced
again client-side before the write so 0/9 cannot be submitted; free-text
language, ordered models, an api_key password field that clears after save).
That client-side guard lives in `lib/polyforge-config-schema.ts`, a pure,
import-free module: it is the only value the panel imports from the config
layer, so the server read module (`lib/polyforge-config.ts`, which pulls
`node:child_process` and the pi SDK) never enters the browser bundle; the
server read module consumes the same module's schema type. Save, reload and
rollback go through the routes above. The write result text
comes from pf's reload class: a restart-only key says it applies after a daemon
restart, a down daemon says the next start, and a next-claim key says the next
claim.

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
- **Every add pane chooses global or project in one place:** a `ConfigSaveTarget` (scope switch aria-labelled `config.saveTo`, plus the path that choice writes to) first under the pane's title, where a detail pane shows its `ConfigScopeTag` and path. Skills, Plugins and MCP get it through `ConfigAddSourceHeading` (title, the catalog links at its right, then the save target); Sub-agents put it in the detail header in place of the tag while creating. The submit button stays where its flow needs it (Install under the source box or on each skill result, Save in the footer, Add at the end of the MCP form), with why it waits beside it, not under the save target. The path is shown whole, never cut short: it wraps after a separator (`<wbr>`), then anywhere. Sub-agents offer both scopes whatever the folder's trust: profiles are not project resources that wait for it.
- **One inset, one scroll region.** The detail pane (`.config-detail`) keeps the shared 20 px inset on every edge and is the one vertical scroll region; a section page adds no extra bottom padding of its own ( removed Settings › Polyforge's `padding-bottom: 24px`, which made a 44 px bottom gap), and `e2e/polyforge-config-viewport.mjs` pins 20 ± 1 px on all four edges.
- **Why a control is unavailable is visible text** — a scope switch's `disabledReason` (under the switch's whole line, so controls passed as its `children` stay level with it), the note under a detail header, a footer summary that opens its diagnostics — never only a `title` tooltip, which a touch screen cannot show.
- `ConfigTrustNotice` shows its button only when given `onTrust`; Settings › MCP passes AppShell's trust dialog through `SettingsPanel` (see **Trust from Settings** in [mcp-settings.md](mcp-settings.md)). Skills and Plugins take the page's `trust` and reload after a decision but have no Trust button; adding one needs `onOpenTrustDialog` passed to them and `mcpProjectTrustable()`'s rule.
