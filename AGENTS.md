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

---

## Architecture

- **Browsing** (read-only, no AgentSession): `GET /api/sessions` lists `~/.pi/agent/sessions/`; `GET /api/sessions/[id]` reads the `.jsonl` through SDK `SessionManager` helpers and `lib/session-reader.ts`, or an open wrapper's in-memory `SessionManager`. `GET /api/agent/running` snapshots the running ids.
- **Sending**: `POST /api/agent/[id]` → `startRpcSession()` (`lib/rpc-manager.ts`) creates the AgentSession in-process (`createAgentSessionFromServices()`); `session.send(cmd)` → `session.prompt()`.
- **Events**: `GET /api/agent/[id]/events` streams SSE `data: {...}` from `session.onEvent()`, fed by `session.subscribe()`.
- **Extension compatibility (principle)**: extensions written for the pi CLI must behave the same here. Fix display problems in the web client; never add pi-web-only options or fields to the extension API (`ctx.ui.*` options, `extension_ui_request`). pi's TUI (`node_modules/@earendil-works/pi-tui`) is the reference for what an extension asking for something means.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/chat-id/route.ts  GET the polyforge chat id of a live session (pi#121; 200-absent, never 5xx)
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth and API-key provider lists
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd/YYYYMMDD (local date)
  files/[...path]/route.ts        GET file contents for viewer
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
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  subagents/settings/route.ts     GET/PUT built-in subagent feature setting
  worktrees/route.ts              GET/POST/DELETE git worktrees
  web-auth/route.ts               GET status | POST login | DELETE logout (browser password)
  plugins/check/route.ts          POST check plugin package updates
  project-trust/route.ts          GET/POST project trust for package installs
  sessions/search/route.ts        GET session search
  sessions/[id]/state/route.ts    GET live wrapper state when the session is running
  sessions/[id]/auto-name/route.ts POST generate a session title
  terminal/route.ts               POST create a terminal session
  terminal/[id]/route.ts          GET stream | POST input/resize | DELETE kill
  cwd/browse/route.ts             GET browse allowed cwd directories | POST create child directory
  open-in-explorer/route.ts       GET availability | POST open a cwd in the OS file manager (loopback only)
  app-update/route.ts             GET current vs latest published pi-web version
  file-index/route.ts             GET file list for @-mentions
  git/status/route.ts             GET changed files for a cwd
  git/diff/route.ts               GET diff for one changed file
  provider-usage/query/route.ts   POST provider usage quotas
  push/config/route.ts            GET VAPID public key for push subscriptions
  push/subscribe/route.ts         POST register a push subscription
  tools/settings/route.ts         GET/PUT defaultTools switches: PowerShell (Windows) and Code mode (automatic / always)
  polyforge/detect/route.ts       GET ?force= — Settings Polyforge section machine detection (pi#122; 200 flat JSON, no 5xx)

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  default-preferences.ts  write defaultModel/defaultThinkingLevel; detect project-level shadowing
  deferred-provider-models.ts  models of providers an extension registers only at session_start, re-added to listings
  draft-store.ts       local draft persistence helpers
  extension-ui-queue.ts  FIFO queues for extension dialogs and custom panels, keyed by request id
  file-access.ts       allowed file roots for /api/files and worktrees
  file-upload-client.ts     browser upload to /api/files ?type=upload, shared by the explorer and chat drops
  linked-directory.ts  directory links that lead outside the allowed roots + the allow-link check
  default-cwd.ts       dated ~/pi-cwd/YYYYMMDD path for "Use default directory"
  file-paths.ts        client/server path encoding helpers
  display-path.ts      display-only `~` / `./` path shortening for the settings panels
  file-tree-visibility.ts  which entries the file tree lists: git check-ignore, name-list fallback
  enabled-models.ts    pure minimal-edit engine for the `enabledModels` pattern list
  enabled-models-runtime.ts  SDK adapter: per-pattern resolution, provider kinds, settings IO
  markdown.ts          shared markdown helpers
  prism-languages.ts   loadPrismLanguages(): every Prism language in a chunk of its own, loaded when a highlighter first needs it
  gfm-autolink-email-loader.cjs  bundler loader: remark-gfm's email regex without a lookbehind literal (#753)
  node-cli.ts          locate bundled npm-cli.js / npx-cli.js so npm/npx spawn without a shell (Windows npm.cmd)
  npx.ts               npx runner used by skill install
  plugin-updates.ts    npm view update checks for /api/plugins/check
  pi-types.ts          local structural types for pi SDK objects
  pi-sdk-internals.ts  file-URL loader for SDK modules the package does not export (MCP connection, config, OAuth)
  mcp-transport.ts     MCP transport factory: stdio servers get the sanitized project-command env, never PI_WEB_PASSWORD
  builtin-extensions.ts  codemode / tool-search / mcp built-ins for normal sessions, PI_WEB_DISABLE_MCP, sandbox self-test
  mcp-read-only-policy.ts  tool_call policy: read-only sessions block MCP tools without readOnlyHint, nested calls too
  mcp-host.ts          per-wrapper MCP host: registers mcp.json servers before a prompt, waits for them, idles them out
  mcp-tool-display.ts  `server/tool` label for an mcp__ call from its result's details (never parsed from the name), JSON result indenting
  codemode-view.ts     display helpers for codemode cards: script, nested calls, header-free output, progress
  codemode-settings.ts Code mode automatic / always as `+codemode` in the global defaultTools
  global-settings-file.ts  locked read-modify-write of the global settings.json (shared with SettingsManager's lock)
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  session-watcher.ts  globalThis fs.watch singleton on the sessions root; external writes bump sessionListVersion
  subagent-settings.ts  read/write ~/.pi/agent/agents/settings.json
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  CodemodeToolView.tsx  codemode card body: highlighted script + the tool calls it made
  BranchNavigator.tsx in-session branch switcher
  ChatMinimap.tsx     scroll minimap alongside the message list
  MarkdownBody.tsx    markdown renderer
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  EnabledModelsSection.tsx  model switches inside ModelsConfig, backed by enabledModels
  OAuthPastePanel.tsx paste box for a server-side sign-in's redirected address or code
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useStreamingSelector.ts  one value of the streaming store (lib/streaming-message.ts): a chunk re-renders only its subscribers
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      chat drop zone: dropped files and folders, in drop order
  useIsMobile.ts      responsive breakpoint hook
  usePrismLanguages.ts  true once the Prism languages are loaded; starts the load for a highlighter
  useTheme.ts         theme state
```

---

## Topic Notes

Design decisions and traps live in `docs/agents/`, one note per area. Read every note whose files a change touches before making it. Add new notes to the area's file, not here.

- [sessions.md](docs/agents/sessions.md): AgentSession lifecycle and shutdown, fork vs in-session branching, session file rewrites, toolCall normalization, SSE reconnect and tool events, transcript system / usage / context-edit entries, running-state polling, exported HTML. Files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/normalize.ts`, `hooks/useAgentSession.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `components/CodemodeToolView.tsx`.
- [tools.md](docs/agents/tools.md): tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md): the per-session MCP host (when servers register and connect, reported states, trust read on every sync, idle release); `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md): Settings › MCP reads without running anything, masking, the trust dialog's server list, row states, notices, Code mode choice, trust from Settings, Escape stacking, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md): Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md): Settings › MCP add (paste re-parsed on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust, the add pane) and the paste importer's escaping and grammars. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md): default model and reasoning level, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, provider auth listing and credentials. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-catalog-refresh.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md): worktrees and project grouping, the file access allow-list (the `/api/files` security boundary), file tree visibility, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/FileExplorer.tsx`.
- [settings-ui.md](docs/agents/settings-ui.md): Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks every settings panel and add pane uses. Files: `app/api/plugins/**`, `app/api/skills/**`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`; also before adding a settings section or add pane.
- [subagents.md](docs/agents/subagents.md): the built-in subagent setting, profiles and their files, run status, completion notifications. Files: `lib/subagent*.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`.
- [client-platform.md](docs/agents/client-platform.md): mobile software keyboard and viewport height, completion sound. Files: `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, the keyboard-open CSS.
- [polyforge-panel.md](docs/agents/polyforge-panel.md): the Polyforge dock panel — read-only `app/api/polyforge/**` routes (degradation-first, no 5xx), pf subprocess contract (`--once --events 40`, probe TTL), response sanitization, polling cadence, the shared dock slot, the Settings section's machine detection (pi#122: the detect route, the line/pi-skill/Claude/daemon rules, the shared presence probe). Files: `lib/polyforge-status.ts`, `lib/polyforge-detect.ts`, `lib/package-settings.ts`, `app/api/polyforge/**`, `hooks/usePolyforge.ts`, `components/PolyforgePanel.tsx`, `polyforge.*` wiring in `components/AppShell.tsx` and `lib/i18n/messages/*`.

---

## Key Design Decisions & Traps

### MCP host (`lib/mcp-host.ts`) — fork state
The fork's `lib/mcp-host.ts` is older than upstream's (no `lib/mcp-command.ts`, `lib/mcp-status.ts` or `lib/mcp-config-key.ts` yet); the notes below describe the fork as it is. Upstream's newer design is in [mcp-runtime.md](docs/agents/mcp-runtime.md); where they differ, the code wins.

### MCP host (`lib/mcp-host.ts`)
- `createPiWebBuiltinExtensions()` returns `{ extensions, mcpHost }`; `startRpcSession()` passes the host to the wrapper. The host's inline extension reads the global and project `mcp.json` itself and hands the servers it wants to the SDK's MCP extension with `pi.registerMcpServer()`, so the extension's own `loadConfig` stays empty (ADR 0006). It stays inactive unless `/mcp` belongs to `builtin:mcp`: with `-builtin:mcp`, or a third-party extension that registers `/mcp`, another implementation would connect the servers through its own, unscrubbed transport.
- **Nothing connects until a prompt.** Before a prompt that starts a run (`!inner.isStreaming`), the wrapper calls `prepareForPrompt()`: the host diffs `mcp.json` against what it registered, unregisters and re-registers only entries whose canonical JSON changed, then waits up to 10 s for servers still connecting. A server that outlasts one full wait is not waited for again. `before_agent_start` also syncs, without waiting, for prompts that do not come through the wrapper.
- **Stop during that wait** aborts it, and the prompt is rejected unsent with `MCP_WAIT_STOPPED_MESSAGE`, so the client restores the draft. It cannot live in `before_agent_start`: pi emits it before the run has an abort signal, and `AgentSession.abort()` does nothing until a run is active. The `abort` command waits for the withdrawn prompt to unwind before it checks `isRunning()`.
- **Connection state comes from the transports.** The extension reports none, so `wrapTransportFactory()` wraps pi-web's transport factory and `watchConnection()` listens on each transport it creates (an extra listener and an own `send` on the instance, never a wrapper object: the SDK checks `instanceof StdioTransport`). Ready means every `tools/list` / `resources/list` / `resources/templates/list` request is answered and a macrotask passed without another page being requested; the extension registers the tools in the microtasks that settle the last list. A transport that closes first, or a factory that throws (such as a `PI_WEB_PASSWORD` reference), is failed.
- **Never unregister a server before its transport exists.** The extension assigns `server.connection` only after loading the MCP runtime, and its removal closes that connection; unregistering earlier finds nothing to close, and the extension connects the server anyway with no way left to close it. The host waits (at most 5 s) for the transport before unregistering. Once it exists, `close()` is safe even mid-handshake: the connection throws away the client when the handshake finishes.
- A host that has not run for `PI_WEB_MCP_IDLE_MS` (10 minutes; `0` disables) unregisters its servers, unless `ctx.isIdle()` says a run is still going; the next prompt registers them again. The timer is stopped from `agent_start` to `agent_end` and while a prompt waits in `prepareForPrompt()`, and started again at `agent_end`, when `prepareForPrompt()` returns, and whenever a sync finishes. Never rely on `agent_end` alone: a prompt that registers servers and then starts no run (Stop during the wait, a slash command, a rejected preflight) never emits it, and a sync Stop gave up on still finishes in the queue afterwards. A reload binds a new host instance with nothing registered.
- MCP tools register as `mcp__<server>__<tool>`, sanitized to `[A-Za-z0-9_-]` and hashed past 64 characters, so the name cannot be split back: `docs.v2/search.pages` and `docs_v2/search_pages` register alike, and either part may hold `__`. A tool card reads `server/tool` only from its result's details (`{ server, tool }`); a running call, the status line and a codemode script's calls keep the registered name, which is also what scripts call.
- Project `.pi/mcp.json` entries follow the project's trust, as in the pi CLI, inherited trust included: `loadMcpConfig` reads the project file only when told the project is trusted, and the host connects every entry it returns. There is no per-entry approval, because a trusted project's `.pi/extensions` already run inside the same boundary, and earlier (on browsing, not on the first prompt). A project entry replaces a global one of the same name. Without a working codemode sandbox, servers with `codemode` exposure are registered as `deferred`, reachable through `tool_search`.
- **Trust is read fresh on every sync**, through the host's `mayReadProjectConfig(cwd)` option (by default `mayReadProjectConfigNow()` in `lib/project-trust.ts`), never from `ctx.isProjectTrusted()`. That is the wrapper's `SettingsManager` flag: fixed when the wrapper is built — `true` for a folder that needed no trust then — and refreshed only on reload, so a `.pi/mcp.json` that appeared later (`git pull`, `pi mcp add -l`, the model's `write` tool) connected on the next prompt with no trust decision. The read is true only while a decision, exact or inherited, trusts a folder that requires trust — not `getProjectTrustStatus().trusted`, which is `true` for a folder with no trust-requiring resources: `loadMcpConfig` looks at the folder again when it opens the file, and a file landing between the two looks would be read with no decision. Nothing is lost, since `.pi/mcp.json` alone makes a folder require trust. A decision made anywhere, the CLI included, reaches an open session's MCP servers on its next prompt, while its project extensions keep the trust the wrapper was built with until a reload (`/api/project-trust` rebuilds the cwd's wrappers anyway). The cost, twice per prompt (`before_agent_start` and `prepareForPrompt()`), is the SDK's `hasTrustRequiringProjectResources()` (up to 8 `existsSync` in `.pi/`, then one per ancestor for `.agents/skills`) and, for a folder that requires trust, a `lockSync` and read of `trust.json`. An unparsable `trust.json`, or one still locked after the store's ~200 ms wait (synchronous: it blocks the event loop that long), counts as untrusted — fail closed, so connected project servers are unregistered until a read succeeds — with one warning per distinct error, naming the file. The MCP extension's `loadConfig` uses the same read for `autoEnableCodemode`, but the extension calls it only on `session_start`, so that flag follows a trust change only at the next reload. While the project file may not be read, `serverStates()` reports every name it declares as `not-trusted` (problems are keyed by scope and name, since a global entry may share it); the names are read after `loadMcpConfig`, so a file that just landed is reported at once. They come from a file nobody has trusted, so only a regular file of at most 1 MiB whose real path is inside the project is parsed, and only for its `mcpServers` keys: the resolved path is opened once with `O_NOFOLLOW | O_NONBLOCK` and checked through `fstat`, so a link elsewhere is refused before opening, and a FIFO or a device is opened without blocking and never read. `loadMcpConfig()`'s `errors[]` (an unparsable file, an entry the SDK skipped) are logged once per process each instead of dropped.

### Plugins and skills — fork state
The fork has no MCP group switch or `ConfigSaveTarget` in `components/SettingsUi.tsx` yet; these two paragraphs describe the fork as it is.

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
