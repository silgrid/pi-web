# Pi Web - Development Notes

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit` · Lint: `npm run lint`

**Never run `next build` during dev**: it pollutes `.next/` and breaks `npm run dev`.

### Dev server troubleshooting

- First run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse a healthy Pi Web process. A second `next dev` on another port is no workaround: both contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph, not a broken server or source. Use the browser's explicit reload, then compare the server log and a direct HTTP/API request.
- Restart only when the failure reproduces from a fresh page and the server-side checks fail too: stop that exact dev process gracefully, move `.next` into a `mktemp -d` backup, restart with `npm run dev`.
- Never fall back to `next dev --webpack`: the dev graph can fail on `undici` imports such as `node:console`. Development uses Turbopack.
- `next dev` may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md`. It is tooling output: check `git status` and keep it out of unrelated commits.

### Upgrading pi
pi's packages depend on each other with `^` ranges, and the published pi-web's dependencies resolve afresh on install (no lockfile ships). Install every `@earendil-works/*` package the tree holds, the SDK's own dependencies included (`pi-codemode`, `pi-mcp`, `pi-telemetry`, …), with `npm install --save-exact`, so npm reuses those exact versions for the SDK's ranges. `lib/pi-packages.test.mjs` fails on any pi package that is not pinned that way; pi-web 0.12.0 pinned four, and installs after pi 1.2.0 paired pi-coding-agent 1.1.0 with pi-codemode 1.2.0.

---

## Architecture

- **Browsing** (read-only, no AgentSession): `GET /api/sessions` lists `~/.pi/agent/sessions/`; `GET /api/sessions/[id]` reads the `.jsonl` through SDK `SessionManager` helpers and `lib/session-reader.ts`, or an open wrapper's in-memory `SessionManager`. `GET /api/agent/running` snapshots the running ids.
- **Sending**: `POST /api/agent/[id]` → `startRpcSession()` (`lib/rpc-manager.ts`) creates the AgentSession in-process (`createAgentSessionFromServices()`); `session.send(cmd)` → `session.prompt()`.
- **Events**: `GET /api/agent/[id]/events` streams SSE `data: {...}` from `session.onEvent()`, fed by `session.subscribe()`.
- **Product scope**: a light web wrapper around pi, not an IDE or a platform of its own. Before adding a feature, check the out-of-scope list in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Extension compatibility (principle)**: extensions written for the pi CLI must behave the same here. Fix display problems in the web client; never add pi-web-only options or fields to the extension API (`ctx.ui.*` options, `extension_ui_request`). pi's TUI (`node_modules/@earendil-works/pi-tui`) is the reference for what an extension asking for something means.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts   GET ?leafId=&tail=&before= a page of a leaf's context (tail defaults to 50; before pages upward)
  sessions/[id]/chat-id/route.ts  GET the polyforge chat id of a live session (pi#121; 200-absent, never 5xx)
  sessions/[id]/search/route.ts   GET in-tab search: active-branch matches in earlier (unloaded) history (pi#80)
  sessions/filter-match/route.ts  GET  worker-session filter rules evaluated against the full first message
  agent/[id]/bg-tasks/route.ts    GET a live session's background tasks (pi-background-tasks bridge)
  agent/[id]/bg-tasks/[taskId]/logs/route.ts GET bounded output tail of one task
  agent/[id]/bg-tasks/[taskId]/kill/route.ts POST kill one background task
  fs-manage/route.ts              POST guarded browse-area directory rename/delete (pi#59; typed 200 outcomes)
  sessions/[id]/export/route.ts   GET exported HTML for a session
  sessions/stats/route.ts          POST { ids } each session's tokens, cost, tool calls, active time (the agent switcher's rows)
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/[id]/lease/route.ts        POST ?holder=<page id> keep the session that page has selected alive (with or without its stream); reply: running, awaitingInput, subagentsActive
  agent/running/route.ts          GET currently-running session ids
  agent/debug/route.ts             GET ?session= the Debug panel's read-only snapshot: wrappers, streams, subagents, MCP, terminals, file watches
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth and API-key provider lists
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd/YYYYMMDD (local date)
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models/enabled/route.ts         GET/PUT enabledModels switches for the Models panel
  models/default/route.ts         PUT save the default model / reasoning level for new sessions
  models/refresh/route.ts         POST fetch provider catalogs from pi.dev on demand
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/content/route.ts          GET one loaded skill's bounded Markdown source, or ?document= a Markdown file in its folder
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  subagents/settings/route.ts     GET/PUT built-in subagent feature setting
  worktrees/route.ts              GET/POST/DELETE git worktrees
  web-auth/route.ts               GET status | POST login | DELETE logout (browser password)
  plugins/check/route.ts          POST check plugin package updates
  sessions/search/route.ts        GET session search
  sessions/[id]/state/route.ts    GET live wrapper state when the session is running
  sessions/[id]/auto-name/route.ts POST generate a session title
  terminal/route.ts               POST create a terminal session
  terminal/[id]/route.ts          GET stream | POST input/resize | DELETE kill
  mcp/route.ts                     GET [?cwd=] Settings › MCP overview, files only | POST add/enable/disable/remove/undo/set-enabled/set-exposure/set-in-project/sign-out
  mcp/test/route.ts                POST { scope, name, cwd? } test one server once (entry read from its file)
  mcp/sign-in/route.ts             POST { scope, name, cwd? } start or join an OAuth sign-in
  mcp/sign-in/[flowId]/route.ts    GET flow state (polled) | POST { redirectUrl } | DELETE cancel
  project-trust/route.ts           GET trust status + project .pi/mcp.json servers (files only) | POST trust, rebuild the cwd's wrappers
  cwd/browse/route.ts             GET browse allowed cwd directories | POST create child directory
  open-in-explorer/route.ts       GET availability | POST open a cwd in the OS file manager (loopback only)
  files/[...path]/route.ts         GET ?type=list|read|download|meta|preview|watch | POST ?type=upload|upload-check|allow-link
  app-update/route.ts             GET current vs latest published pi-web version
  file-index/route.ts             GET file list for @-mentions
  git/status/route.ts             GET changed files for a cwd
  git/diff/route.ts               GET diff for one changed file
  provider-usage/query/route.ts   POST provider usage quotas
  push/config/route.ts            GET VAPID public key for push subscriptions
  push/subscribe/route.ts         POST register a push subscription
  tools/settings/route.ts         GET/PUT defaultTools switches: PowerShell (Windows) and Code mode (automatic / always)
  cache-miss-notices/route.ts      GET/PUT pi's global showCacheMissNotices (Settings › General)
  polyforge/detect/route.ts       GET ?force= — Settings Polyforge section machine detection (pi#122; 200 flat JSON, no 5xx)
  polyforge/config/route.ts       GET/POST the configuration panel read/write (; pf-only writes, JSON-only POST)
  polyforge/config/reload/route.ts       POST reload, then an independent ops-status read
  polyforge/config/history/route.ts      GET the bounded panel history; POST rollback as a new CAS write
  polyforge/cards/route.ts        GET ?cursors= the Jobs tab's whole card stream in one read: goal, step durations, progress increments (; 200, no 5xx)
  machine-load/route.ts           GET  host CPU %, cores, loadavg 1/5/15, memory used/total for the Session-info popover and the Debug panel (#168; whitelist only, 2 s shared sample, 200 { metrics: null } on failure, no 5xx)

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  missing-cwd.ts            client-safe `reason: "cwd-missing"` refusal of a folder that no longer exists: error class, body fields, parsing
  debug-types.ts            client-safe shapes of the Debug panel: GET /api/agent/debug and the page's own snapshot
  debug-snapshot.ts         buildDebugSnapshot(): the debug route's synchronous field reads, each source guarded
  stream-client.ts          an event stream's reported address and "Chrome · macOS" label, for the Debug panel's connected pages and SSE titles only
  page-stream-registry.ts   open terminal and file-watch streams with their page (`?holder=`) and client, for the Debug panel's connected pages
  page-debug.ts             client: the page's id (`?holder=` of its streams), EventSources, visibility history, protocol and running-poll record (Debug panel)
  file-watch-registry.ts    open ?type=watch streams, counted on globalThis for the Debug panel
  default-preferences.ts  write defaultModel/defaultThinkingLevel; detect project-level shadowing
  deferred-provider-models.ts  models of providers an extension registers only at session_start, re-added to listings
  draft-store.ts       local draft persistence helpers
  extension-ui-queue.ts  FIFO queues for extension dialogs and custom panels, keyed by request id
  session-stats-format.ts   client-safe compact counts, costs and active durations of the stats toolbar and agent switcher
  machine-load.ts           server: on-demand host sampler, one sample shared per 2 s window, CPU from the delta of two fresh os.cpus() reads (no timer)
  machine-load-view.ts      client-safe: the route's five-field metrics type, the keep-last-good merge, the pinned formats and four rows
  turn-duration.ts          getTurnDurationMs() / formatTurnDuration(): a finished turn's length from its anchor to its last response's end, on pi's timestamps
  transcript-notices.ts     client-safe: showCacheMissNotices notices on chat messages, TUI number formats, a fold's cache-miss sum
  transcript-notices-server.ts the notices derived from session entries (cache-stats port), live ones for message_end, the setting
  file-access.ts       allowed file roots for /api/files and worktrees
  file-upload-client.ts     browser upload to /api/files ?type=upload, shared by the explorer and chat drops
  linked-directory.ts  directory links that lead outside the allowed roots + the allow-link check
  default-cwd.ts       dated ~/pi-cwd/YYYYMMDD path for "Use default directory"
  file-paths.ts        client/server path encoding helpers
  file-version.ts           a watched file's size+mtime version: viewers skip reloading an unchanged file on reconnect
  delimited-table.ts        client-safe CSV/TSV parsing (RFC 4180, delimiter detection, file line per record) and table layout
  display-path.ts      display-only `~` / `./` path shortening for the settings panels
  file-tree-visibility.ts  which entries the file tree lists: git check-ignore, name-list fallback
  file-tree-expansion.ts    the file tree's open directories per cwd: page-memory LRU of 20 folders
  enabled-models.ts    pure minimal-edit engine for the `enabledModels` pattern list
  enabled-models-runtime.ts  SDK adapter: per-pattern resolution, provider kinds, settings IO
  model-context.ts          client-safe: managed models' contextWindow overrides in the models.json draft, the Save check
  model-provider-check.ts   client-safe: Save refuses a models.json provider entry pi rejects on its own (Add provider's empty stub, oauth without a Base URL)
  markdown.ts          shared markdown helpers
  markdown-blocks.ts        splitMarkdownBlocks(): where a streaming reply may be cut into blocks parsed apart
  highlight-queue.ts        code fences past a task's highlight budget get their colors in idle slices
  prism-languages.ts   loadPrismLanguages(): every Prism language in a chunk of its own, loaded when a highlighter first needs it
  gfm-autolink-email-loader.cjs  bundler loader: remark-gfm's email regex without a lookbehind literal (#753)
  node-cli.ts          locate bundled npm-cli.js / npx-cli.js so npm/npx spawn without a shell (Windows npm.cmd)
  npx.ts               npx runner used by skill install
  plugin-updates.ts    npm view update checks for /api/plugins/check
  jsonc.ts                  JSON with comments and trailing commas (models.json is read through it)
  shell-words.ts            split a pasted command line into words without a shell; refuses | && ; redirects $(…)
  key-serializer.ts         serializeByKey(): one globalThis promise chain per key
  stacked-dialog.ts         Escape and focus handling for Settings and dialogs stacked above it
  project-trust.ts          project trust status and decisions; fresh-folder trust-and-write
  pi-types.ts          local structural types for pi SDK objects
  pi-sdk-internals.ts  file-URL loader for SDK modules the package does not export (MCP connection, config, OAuth)
  mcp-transport.ts     MCP transport factory: stdio servers get the sanitized project-command env, never PI_WEB_PASSWORD
  mcp-command.ts            client-safe: who owns /mcp (built-in or another extension)
  builtin-extensions.ts  codemode / tool-search / mcp built-ins for normal sessions, PI_WEB_DISABLE_MCP, sandbox self-test
  mcp-read-only-policy.ts  tool_call policy: read-only sessions block MCP tools without readOnlyHint, nested calls too
  mcp-config-key.ts         canonicalJson() and mcpConfigKey(), the per-process HMAC statuses are keyed by
  mcp-config-values.ts      client-safe: the values pi resolves and the PI_WEB_PASSWORD rule
  mcp-config-read.ts        Settings › MCP reads of both mcp.json files; nothing resolved or run
  mcp-config-file.ts        the mcp.json writer: SDK editor's bytes, lock, atomic write, typed refusals
  mcp-override.ts           project overrides of global servers: the SDK's isOverride() and loader refusals
  mcp-json-error.ts         JSON.parse error messages that never quote the source
  mcp-undo.ts               removed mcp.json entries kept 60 s for undo; only a token reaches the browser
  mcp-status.ts             last known connection state per mcp.json entry (tests and sessions)
  mcp-test.ts               Settings › MCP Test: one bounded, masked SDK connection (sign-in reuses its steps)
  mcp-entry-request.ts      route checks before connecting one mcp.json entry (Test, sign-in); guards /api/mcp and /api/project-trust share
  mcp-sign-in.ts            Settings › MCP OAuth sign-in flows (as pi mcp login), polled by id
  mcp-sign-out.ts           OAuth store keys (name + URL); guard barring token writes by runs started before a sign-out
  mcp-secrets.ts            pure secret classification and masking for MCP config values
  mcp-add.ts                POST /api/mcp add's checks before it writes
  mcp-import.ts             pure paste importer (+ mcp-import-core/json/cli/links.ts)
  mcp-server-display.ts     client-safe display helpers for McpServerInfo (hidden-character escapes, labels)
  mcp-host.ts          per-session MCP host: registers mcp.json servers before prompts, reports status
  mcp-tool-display.ts  `server/tool` label for an mcp__ call from its result's details (never parsed from the name), JSON result indenting
  codemode-view.ts     display helpers for codemode cards: script, nested calls, header-free output, progress
  codemode-settings.ts Code mode automatic / always as `+codemode` in the global defaultTools
  global-settings-file.ts  locked read-modify-write of the global settings.json (shared with SettingsManager's lock)
  regular-file.ts           readRegularFileText(): non-blocking read of a regular file only, optional size cap
  polyforge-cards.ts        server: the Jobs-tab cards read straight from the daemon's files (events, job record, capsule, spawn journal, pi/claude transcript whitelist, cursor, bounds)
  polyforge-cards-pure.ts   client-safe card wire types, bounds, cursor shape, ordering, title/duration text, progress merge and last-good snapshot
  polyforge-panel-preferences.ts  the two browser-stored card preferences (title length, poll interval): keys, bounds, clamp, guarded read/write, change event
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  session-delete.ts         deleteSessions(): DELETE /api/sessions/[id], session files with their subagents, re-parenting what stays, wrapper shutdown
  session-links.ts          a session's same-instance link (?session=<id>) and the plain-click rule the sidebar keeps in the page
  normalize.ts              normalizeToolCalls(): file-format vs our toolCall field names
  message-keys.ts           client-safe React keys of chat messages: a run's messages keep theirs when the file is read again
  manual-fetch.ts           client-safe manual "fetch latest" helpers: new-content check and history merge by entry id, the pull-up's arming/threshold, hh:mm
  session-watcher.ts  globalThis fs.watch singleton on the sessions root; external writes bump sessionListVersion
  subagent-settings.ts  read/write ~/.pi/agent/agents/settings.json
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  tool-fields.ts            a tool call's arguments as flat rows: all of them or no table
  types.ts            shared TypeScript types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  the sidebar (internal line; upstream's redesign not adopted,): session rows, pinned directories, archive, filters, multi-root FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CodemodeToolView.tsx  codemode card body: highlighted script + the tool calls it made
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  SvgBlock.tsx             a ```svg fence: preview only as an <img> data URL, source toggle, zoom, download (MermaidBlock's pieces)
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  EnabledModelsSection.tsx  model switches inside ModelsConfig, backed by enabledModels
  ModelContextWindow.tsx   a managed model row's context-window field (blank: no override)
  OAuthPastePanel.tsx paste box for a server-side sign-in's redirected address or code
  ProjectTrustDialog.tsx   trust confirmation listing the project's MCP servers
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  SubagentViewer.tsx       read-only right-panel tab of a subagent's transcript (polls the context route)
  DebugPanel.tsx           Debug top panel (toolbar, left of the stats): page and server state, its own tick and poll, error boundary; mounts MachineLoadSection at the top
  MachineLoadSection.tsx   host-labelled machine-load section of the Session-info popover and the Debug panel (mounted only while one of them is open)
  debug-panel-state.ts     pure helpers of DebugPanel: formatting, server clock, poller, issues, session grouping, poll samples
  PluginsConfig.tsx   modal for installed package plugins
  PolyforgeConfig.tsx  Settings › Polyforge section: machine detection display + the pi package switch (pi#122; once-per-open, no polling) + the two browser-stored Jobs card preferences
  SkillsConfig.tsx    modal for loaded/search/installable skills
  McpConfig.tsx            Settings › MCP: servers, switches, exposure, remove/undo, Test, sign-in, Code mode, trust
  mcp-config-helpers.ts    pure helpers and requests for McpConfig
  McpSignIn.tsx            a server's Sign-in row in Settings › MCP
  mcp-sign-in-helpers.ts   pure helpers and requests for McpSignIn
  McpAddServer.tsx         Settings › MCP add pane: paste, preview, values, name, scope
  mcp-add-helpers.ts       pure helpers and the add request for McpAddServer
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  DelimitedTable.tsx       a CSV/TSV file's Preview: virtualized table, gutter of file lines
  TabBar.tsx          tab bar (Chat + open file tabs)
  TranscriptNotices.tsx    a message's cache and cost notice lines, the fold header's cache-miss text

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useStreamingSelector.ts  one value of the streaming store (lib/streaming-message.ts): a chunk re-renders only its subscribers
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      chat drop zone: dropped files and folders, in drop order
  useIsMobile.ts      responsive breakpoint hook
  usePageHidden.ts         HIDDEN_PAGE_GRACE_MS; true once the page has been hidden that long (file watches pause)
  useMachineLoad.ts        fixed 2 s poll of /api/machine-load while mounted and the page is visible; keeps the last good values
  useKeyboardShortcuts.ts  Esc stops the running agent unless a field or nearer handler took it; Ctrl+Alt+N
  useResizablePanel.ts     drag/keyboard panel size kept per key; persistClamp: false never saves a short window's clamp
  usePrismLanguages.ts  true once the Prism languages are loaded; starts the load for a highlighter
  useTheme.ts         theme state
  useTerminalTheme.ts      the terminal's own dark/light choice (localStorage), apart from the app theme
  usePolyforgePanelPreferences.ts  the card stream's title length and poll interval, live on save (storage + preferences event)
```

---

## Topic Notes

Design decisions and traps live in `docs/agents/`, one note per area. Read every note whose files a change touches before making it. Add new notes to the area's file, not here.

- [sessions.md](docs/agents/sessions.md): AgentSession lifecycle and shutdown, fork vs in-session branching, session file rewrites, toolCall normalization, SSE reconnect and tool events, transcript system / usage / context-edit entries, running-state polling, the manual fetch of the newest data, exported HTML. Files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/normalize.ts`, `hooks/useAgentSession.ts`, `lib/manual-fetch.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `components/CodemodeToolView.tsx`, `components/ChatWindow.tsx` (the manual fetch, the message list).
- [tools.md](docs/agents/tools.md): tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md): the per-session MCP host (when servers register and connect, reported states, trust read on every sync, idle release); `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md): Settings › MCP reads without running anything, masking, the trust dialog's server list, row states, notices, Code mode choice, trust from Settings, Escape stacking, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md): Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md): Settings › MCP add (paste re-parsed on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust, the add pane) and the paste importer's escaping and grammars. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md): default model and reasoning level, providers registered at session_start, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, provider auth listing and credentials. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-catalog-refresh.ts`, `lib/deferred-provider-models.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md): worktrees and project grouping, the file access allow-list (the `/api/files` security boundary), file tree visibility, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/FileExplorer.tsx`.
- [settings-ui.md](docs/agents/settings-ui.md): Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks every settings panel and add pane uses. Files: `app/api/plugins/**`, `app/api/skills/**`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`, `components/PolyforgeConfig.tsx` (the Settings › Polyforge section, pi#122); also before adding a settings section or add pane.
- [subagents.md](docs/agents/subagents.md): the built-in subagent setting, profiles and their files, run status, completion notifications. Files: `lib/subagent*.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`.
- [client-platform.md](docs/agents/client-platform.md): the global shortcuts (Ctrl+Alt+N on macOS's dead-key Option+N and Windows AltGr, Esc stacking), mobile software keyboard and viewport height, the terminal's extra keys, its own dark/light theme and its font size following the chat's, completion sound, the message list's bottom pull-up that starts the manual fetch. Files: `hooks/useKeyboardShortcuts.ts`, `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, `components/TerminalExtraKeys.tsx`, `lib/terminal-extra-keys.ts`, `lib/terminal-theme.ts`, `hooks/useTerminalTheme.ts`, `terminalFontSize()` in `hooks/useChatAppearance.ts`, the keyboard-open CSS, the touch pull-up in `components/ChatWindow.tsx`.
- [polyforge-panel.md](docs/agents/polyforge-panel.md): the Polyforge dock panel — read-only `app/api/polyforge/**` routes (degradation-first, no 5xx), pf subprocess contract (`--once --events 40`, probe TTL), response sanitization, polling cadence, the shared dock slot, the Work tab (Work | Memory | Messages top strip, order; Jobs and Tasks are Work's sub-tabs in a ~72px right rail, a two-segment bar at ≤640px; page-memory sub-tab, anchors land on Work › Jobs), the Settings section's machine detection (pi#122), the configuration panel (the config read/write/reload/history routes, CAS diff, api_key stdin-only, capability floor, bounded history) the Memory tab (browses the project's memories by default with load more and a total, a keyword switches to the `pf recall` relevance read, `pf memory show` detail, the 2.20.12 floor, hit/detail passports, the 256 KiB body cap, no polling), the read-only Tasks tab (`pf task list`/`pf task show` GET faces, 正在运行 / 全部 sections, no spawn or cancel, the 2.20.12 floor; a responsive block grid with state, project, two-line summary and durations — side by side from 340px on, —, client-side project/state filters over the one list read — running ones tick on a local 1 s render clock that never reads), the desktop dock pin (persisted, suppresses only the outside-press dismissal) and the Jobs tab card stream (block, compact side-by-side cards one GET read of the daemon's own files per tick, ordering, key information only — slug + goal, status, the emphasized needs-input marker, narration-only progress (transcript whitelist) — with the DAG step graph, step durations and reruns in the job detail, the no-Loading empty state, cursor and bounds, the daemon/capsule layout coupling, the two browser-stored preferences). Files: `lib/polyforge-status.ts`, `lib/polyforge-cards*.ts`, `lib/polyforge-panel-preferences.ts`, `lib/polyforge-detect.ts`, `lib/polyforge-config*.ts`, `lib/polyforge-memory*.ts`, `lib/polyforge-tasks*.ts`, `lib/package-settings.ts`, `app/api/polyforge/**`, `hooks/usePolyforge.ts`, `hooks/usePolyforgePanelPreferences.ts`, `components/PolyforgePanel.tsx`, `components/PolyforgeMemory.tsx`, `components/PolyforgeTasks.tsx`, `components/PolyforgeConfig.tsx`, `polyforge.*` wiring in `components/AppShell.tsx` and `lib/i18n/messages/*`.
- [machine-load.md](docs/agents/machine-load.md): the Session-info popover's and the Debug panel's machine load (#168) — the `GET /api/machine-load` whitelist and degradation, the on-demand 2 s shared sampler and delta CPU, the host-view caveat, open + visible client polling, last-good / clear-on-close, the pinned formats. Files: `app/api/machine-load/route.ts`, `lib/machine-load.ts`, `lib/machine-load-view.ts`, `hooks/useMachineLoad.ts`, `components/MachineLoadSection.tsx`, its mounts in `components/AppShell.tsx` and `components/DebugPanel.tsx`, `session.machine*` in `lib/i18n/messages/*`.

---

## Key Design Decisions & Traps

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.
- Each sidebar group of the Skills and Plugins panels (a skill scope, a package scope; not standalone extensions) has a small switch in its heading (`ConfigSidebarGroupSwitch`), with the same rule as the Models panel's provider switch: on only while every row is, so a partial group reads as off beside its `n/m` count and one click completes it. It lives in the heading row so the sidebar loses no height, which matters in the 190px phone layout. A switch sends one request with a list (`PATCH /api/skills` with `filePaths`, `POST /api/plugins` with `packages`) and gets a result per item, so a refused row does not stop the rest; what it left undone is shown under that group's heading (`ConfigSidebarGroupStatus`). `SettingsManager` records load and write failures instead of throwing, and `flush()` still resolves; the bulk plugin path reads them back with `drainErrors()`, or an unreadable settings.json would report success. An entry already in the requested state is left alone, and enabling keeps an entry's own keys such as `autoload`. Disabling empties the four resource lists and nothing keeps the filters they replaced, so switching a group off leaves an enabled filtered package on (the SDK reports every object entry as `filtered`) and says so, and the bulk route refuses one. `PATCH /api/skills` edits only `.md` files: the roots it allows also hold `auth.json`, settings and project files.
- The Skills and Plugins panels are built from the shared blocks in `components/SettingsUi.tsx` (`ConfigScopeTag`, `ConfigScopeSwitch`, `ConfigAddSourcePanel`, `ConfigDetailGrid`, `ConfigFooterStatus`, `ConfigTrustNotice`), `itemsToSwitch()` in `components/settings-ui-helpers.ts`, and `lib/display-path.ts`; a new settings section reuses them instead of copying a panel. Why a control is unavailable is visible text — a scope switch's `disabledReason` (under the switch's whole line, so controls passed as its `children` stay level with it), the note under a detail header, a footer summary that opens its diagnostics — never only a `title` tooltip, which a touch screen cannot show. `SettingsUi.tsx` takes every word as a prop and holds no state, so it renders outside the i18n provider; the panels pass `t()` strings. `ConfigTrustNotice` shows its button only when given `onTrust`, and neither panel passes one yet: trusting from Settings needs `AppShell`'s trust state threaded through `SettingsPanel` and a reload of the panel afterwards.

## Old Safari (iOS 16.2)

- `/` renders entirely on the client, so one script chunk the browser cannot parse is a blank page. Next 16 targets Safari 16.4+; the `browserslist` in `package.json` lowers Safari and iOS to 16.2 so SWC turns class `static {}` blocks into private static fields. That covers Next's client runtime; other node_modules keep their syntax unless listed in `transpilePackages` (mermaid and `@mermaid-js/parser` are, for their lazy diagram chunks). Keep the other browserslist entries at Next's defaults.
- Never write a RegExp lookbehind (`(?<=`, `(?<!`) in client code: SWC cannot downlevel it and Safari parses it only from 16.4. `lib/markdown.ts` emulates its leading lookbehinds with `replaceNotPrecededBy()`. A lookbehind built at runtime (`new RegExp("(?<=…)")` in `try`) fails only when run; that is how `lib/gfm-autolink-email-loader.cjs` fixes `mdast-util-gfm-autolink-literal`'s email regex. The loader is registered for webpack and Turbopack in `next.config.ts` and fails the build if that regex changes upstream.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext.entryIds[]` parallels `messages[]`: each displayed message's `.jsonl` entry id, used for fork and navigate_tree.

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
