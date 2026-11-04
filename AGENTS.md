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
- `next dev` rewrites the `BEGIN:nextjs-agent-rules` block at the end of this file only when that block differs from the text the installed Next writes. The block here is committed byte-for-byte equal to that output, so a dev or e2e run leaves `AGENTS.md` unchanged; when a Next upgrade changes the block, refresh it in that upgrade's own change (the block's last line names its generator). A unit test pins this equality (`docs/next-agent-rules.test.mjs`).

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
  sessions/route.ts               GET  list all sessions (pi files, live pi wrappers, and pi-web's claude index rows with `harness: "claude"`)
  sessions/[id]/route.ts          GET/PATCH/DELETE session (claude: history from claude's transcript plus `claudeSubagents`, the subagent runs rebuilt from its sidecars, PATCH { name } / { archived } in the index, DELETE its transcript + entry)
  sessions/[id]/context/route.ts   GET ?leafId=&tail=&before= a page of a leaf's context (tail defaults to 50; before pages upward)
  sessions/[id]/chat-id/route.ts  GET the polyforge chat id of a live session (pi#121; 200-absent, never 5xx)
  sessions/[id]/search/route.ts   GET in-tab search: active-branch matches in earlier (unloaded) history (pi#80)
  sessions/filter-match/route.ts  GET  worker-session filter rules evaluated against the full first message
  agent/[id]/bg-tasks/route.ts    GET a live session's background tasks (pi-background-tasks bridge)
  agent/[id]/bg-tasks/[taskId]/logs/route.ts GET bounded output tail of one task
  agent/[id]/bg-tasks/[taskId]/kill/route.ts POST kill one background task
  fs-manage/route.ts              POST guarded browse-area directory rename/delete (pi#59; typed 200 outcomes)
  sessions/[id]/export/route.ts   GET exported HTML for a session
  sessions/stats/route.ts          POST { ids } each session's tokens, cost, tool calls, active time (the agent switcher's rows; claude: the index's `result` totals)
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? } | { cwd, type, message?, harness: "claude", model, effort? } (model: one of the four claude full names; effort: a claude level or default; guard first, then index, then child)
  agent/[id]/route.ts             GET state | POST any command (claude ids: prompt/abort/get_state/get_tools/get_commands/get_session_stats/set_model/set_effort/compact — a switch with no live child only writes the index; others refused)
  agent/[id]/events/route.ts      GET SSE stream (a claude id starts its child, `--resume`, when none is alive)
  agent/[id]/lease/route.ts        POST ?holder=<page id> keep the session that page has selected alive (with or without its stream); reply: running, awaitingInput, subagentsActive (claude: renews the child, never spawns; subagentsActive = an unsettled background subagent,)
  agent/running/route.ts          GET currently-running session ids (pi and claude); subagentsActiveSessionIds include claude sessions with an unsettled background subagent
  claude/route.ts                 GET whether claude is on PATH and the four claude full model names + default (no config dir, no presets; reads only;, #250)
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
  sessions/[id]/state/route.ts    GET live wrapper state when the session is running (claude: while its child is alive)
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
  agent-language/route.ts        GET/PUT the server-side Agent language (en / zh-CN) new pi and claude sessions capture; the only writer of pi-web-settings.json
  polyforge/status/route.ts       GET the machine's job queue snapshot, sanitized for the panel (pi#108; 200 `status: null` + `pfPresent` on degradation, no 5xx)
  polyforge/watch/route.ts        GET ?wi=<slug|id> one work item's workflow header, ordered steps and newest 40 events (pi#108; 400 malformed ref before any spawn, 200 `status: null` otherwise)
  polyforge/memory/route.ts       GET ?cwd=&project=&q= the Memory tab: scope read, browse page (no q) or keyword `pf recall` search (browse; 2.20.12 floor, 400 shape refusals before any spawn, no 5xx)
  polyforge/memory/[id]/route.ts  GET one memory via `pf memory show` (; 400 malformed id, 200 `memory: null` + capability/error otherwise)
  polyforge/tasks/route.ts        GET the Tasks tab list: one `pf --json task list`, nine-key rows (/#163/#194; GET only, 2.20.12 floor, no 5xx)
  polyforge/tasks/[id]/route.ts   GET one task via `pf --json task show` (; 400 malformed id, 200 `task: null` + capability/error otherwise)
  polyforge/messages/[id]/route.ts  GET ?before=|?after= one conversation's history page (newest without a cursor, `after` is the open conversation's 3 s refresh; 4xx refusals, 200 empty + error when pf is unavailable)
  polyforge/messages/ack/route.ts POST { conversation_id, seq } advance the caller's read cursor (JSON-only, validated before the spawn; pf's typed refusal 4xx, never 5xx)
  polyforge/messages/analyze/route.ts  POST { message_id } one message's structured analysis: the 2.20.18 analysis floor (400 `{error, upgrade}` before any spawn), one blocking `pf --json msg analyze` (one read-only pf task, 420 s bound), `{ok, analysis}` through the one sanitizer — closed type/actions, task id, no `conclusion` (; JSON-only; nothing persisted; never 5xx)
  polyforge/messages/prompt/route.ts  POST { message_id } the Messages 「@」 action: reach = pi-web's authenticated surface (in-route gate), JSON-only, the id validated and the 2.20.20 prompt floor checked (fresh probe; 400 `{error, upgrade}`) before the one `pf --json msg prompt <id>` (one read-only pf task, 420 s bound); `{ok, prompt}` through the one four-field sanitizer (prompt, task_id, model, duration); pf's 4xx kept, 200 `{error}` otherwise, never 5xx, nothing persisted or logged
  polyforge/messages/file-ticket/route.ts  POST { goal, project, content } the analysis card's 【建票】 confirm: reach = pi-web's authenticated surface (in-route gate), JSON-only, validated against the mapping before the one `pf --json file create` without `--bundle` (a registration ticket); `{ok, slug}`, pf's 4xx kept, 200 `{error}` when unavailable, never 5xx, nothing logged
  polyforge/detect/route.ts       GET ?force= — Settings Polyforge section machine detection (pi#122; 200 flat JSON, no 5xx)
  polyforge/config/route.ts       GET/POST the configuration panel read/write (; pf-only writes, JSON-only POST; every non-secret cli.toml key + api_key + summarize writable; summarize and the per-path memory_policy read only from `pf --json config list`, summarize written as flat cli.toml keys with the cli.toml CAS, both hidden behind one upgrade hint below pf 2.20.21 (an unknown version counts below) and a summarize write refused 400 there; memory_policy never writable)
  polyforge/config/reload/route.ts       POST reload, then an independent ops-status read
  polyforge/config/history/route.ts      GET the bounded panel history; POST rollback as a new CAS write
  polyforge/workflows/route.ts    GET ?cwd= the workflow card's read: fresh `pf --json workflows` + `pf --json config workspace` per call, 2.20.15 floor, 200 degradation (; GET only, no 5xx); the union of every cli.toml-mapped workspace — 1 `config list` + those 2 reads per workspace (`--cwd W`), `workspaces[]` with a per-workspace failure reason
  polyforge/cards/route.ts        GET ?cursors= the Jobs tab's whole card stream in one read: goal, step durations, progress increments (; 200, no 5xx)
  polyforge/progress/route.ts     GET ?wi=wi_… the job detail's execution progress: the whole job's complete stream — every spawn's narration (text and non-empty thinking, whitespace kept for Markdown,) + one masked tool line with only the light `tool` fields (name, argument, ok/error/running, duration;), merged with the composed lifecycle/fault lines (`at` on each) by time, no line bound or per-line cap (/#238,; a job dropped from the index is served from its event log, lifecycle lines only,; 400 bad wi or a wi with neither an index record nor an event log, 200 `available:false` for a missing/unreadable job index or nothing readable, no 5xx)
  polyforge/progress/tool/route.ts GET ?wi=&id= one progress tool call's full masked input/output for an expanded card (; the progress route's gate, wi/id validated before any read → 400, 200 `available:false` when unreadable, never 5xx, no path)
  polyforge/work-items/route.ts   GET the Work › 工单列表 list: one merged `pf --json queue`, 8-key rows, whole-table 200 degradation (; no 5xx)
  polyforge/work-items/[id]/route.ts GET one work item's detail: id-checked (400) `pf --json file show`, 18-key passport, 256 KiB content cap
  polyforge/messages/route.ts     GET the Messages list (conversations, contacts, project `groups` from one bounded `pf projects get` per mapped project,); POST send (the analysis floor is the analyze route's own gate,)
  polyforge/users/route.ts        GET the Messages admin probe + membership picker: one `pf --json users list`, humans only, id + display name (; 200 admin:false on refusal, no 5xx)
  polyforge/projects/members/route.ts  POST add (writer) / remove one user in one mapped project: JSON-only, validated before the one `pf projects members` spawn (; 4xx refusal, 200 {error} unreachable)
  machine-load/route.ts           GET  host CPU %, cores, loadavg 1/5/15, memory used/total for the Debug panel (#168, #198; whitelist only, 2 s shared sample, 200 { metrics: null } on failure, no 5xx)

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
  draft-store.ts       local draft persistence helpers; appendPromptText/appendDraftText — the 「@」 fill rule (old draft, one blank line, prompt; an empty draft gets the prompt alone; stored images kept)
  extension-ui-queue.ts  FIFO queues for extension dialogs and custom panels, keyed by request id
  favicon-badge.ts          the tab's favicon badge: awaiting and unread counts drawn over the stock icon
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
  html-sandbox-polyfill.ts  in-memory localStorage/sessionStorage shim injected into the sandboxed HTML preview's srcDoc
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
  agent-language.ts         client-safe Agent language vocabulary (en / zh-CN, tolerant English default) and the one fixed Chinese instruction both harnesses send
  agent-language-config.ts  <pi agent dir>/pi-web-settings.json: tolerant read of the stored Agent language, serialized atomic 0600 write that keeps other keys and refuses a malformed file
  regular-file.ts           readRegularFileText() / readRegularFileTextAsync(): non-blocking read of a regular file only, optional size cap
  polyforge-cards.ts        server: the Jobs-tab cards read straight from the daemon's files (events, job record, capsule, spawn journal, pi/claude transcript whitelist, cursor, bounds); readJobIndex/readSpawnJournal/readProgressEventLog/readProgressSnapshot/progressEntries for the job detail's whole-job execution progress (#238: every spawn, read-once resumed transcripts, timestamp merge, the event-log answer after the drop; #251: text + non-empty thinking narration, masked but uncapped, no line bound; #271: narration whitespace kept, tool results paired into the light status/duration fields, readProgressToolDetail/isProgressToolId for one call's on-demand full detail)
  polyforge-cards-pure.ts   client-safe card wire types, bounds, cursor shape, ordering, title/duration text, progress merge and last-good snapshot; shortJobTitle; the whole-job progress snapshot (`lines`/`variant`/`tone`/`event`/`omitted`), no line bound, the lifecycle-line composer (glyphs, tones, dropped kinds, no length cap), the snapshot merge and the scroll follow's isProgressPinnedToBottom (8 px); the event line's `at`, the tool line's light `tool` fields (PolyforgeProgressTool), and progressBlocks' absorbed terminal line, start/end times and duration
  polyforge-work-items.ts   server: the 工单列表 reads (merged `pf --json queue`, `pf --json file show`), 2.19.0 floor, passports, bounded degradation
  polyforge-work-items-pure.ts  client-safe work-item wire types, id check, seven statuses, newest-first sort, 500-cap hint, one filter predicate, running count
  polyforge-panel-preferences.ts  the two browser-stored card preferences (title length, poll interval): keys, bounds, clamp, guarded read/write, change event
  polyforge-workflows-pure.ts  client-safe workflow card row model: default project, one row per step id with its bundles, order (default, steps A–Z, task), declared vs inherited, per-bundle effective chains, chain edit ops; the mapped workspaces' project union, each project's owning workspace/yaml path and the failed workspaces (workflowUnion/projectOwner,)
  polyforge-workflows.ts     server: the workflow card's two pf reads (`pf --json workflows`, `pf --json config workspace`), the 2.20.15 floor, sanitizers, degradation as fields; the `config list` mapping read and those two reads per mapped workspace with its own `--cwd`, parallel and independently degraded
  polyforge-disclosure.ts         Settings › Polyforge page disclosure state: one localStorage key, seven region booleans (`workflow` added, `summarize`/`candidates` retired), defaults on absent/corrupt, guarded merge-preserving write, change event
  polyforge-messages.ts     server: the Messages pf reads/writes — conversations, contacts, the project grouping read (mapping + bounded `pf projects get`), the human-only users read, the membership write, the structured analyze read and the analysis floor gate, the bundle-free 建票 write; the 「@」 prompt floor gate (fresh probe) and the one `pf msg prompt` spawn; floors, argv validation, sanitizers
  polyforge-messages-pure.ts  client-safe Messages types, page merges, ackDecision, directRows, conversationForContact, buildProjectGroups, contactsOutsideGroups; the 2.20.18 analysis floor constant, the closed analysis type/action vocabularies, PolyforgeAnalysis + parsePolyforgeAnalysis (the one wire sanitizer, display bounds), primarySuggestedAction, the 建票 bounds and fileTicketDialogDefaults; the 2.20.20 prompt floor constant, PolyforgePrompt + parsePolyforgePrompt (the four-field prompt sanitizer)
  polyforge-messages-collapse.ts  Messages project-group collapse state: `pi-web:polyforge-messages-collapsed`, a JSON array of collapsed projects, expanded on absent/corrupt, guarded merge-preserving write, in-memory on refusal, change event
  polyforge-messages-list-collapse.ts  the Messages contact column's whole-column strip (the ≤640px sheet too): `pi-web:polyforge-messages-list-collapsed`, "1" folded, expanded on absent/corrupt, guarded write, in-memory on refusal, change event; separate from #222's width and #223's groups
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-agent-language.ts  a pi session's Agent language: the `pi-web:agent-language` custom entry written at creation, newest valid entry read (none = English)
  agent-language-prompt.ts  normal pi sessions' before_agent_start handler appending the Agent language instruction for 中文 (English: no change)
  claude-shared.ts          client-safe claude harness vocabulary: harness ids, the four full model names pinned to claude 2.1.312 + default, isClaudeModel, normalizeClaudeModel (legacy aliases); claude's effort levels low/medium/high/xhigh/max + the "default" entry, normalizeClaudeEffort
  claude-argv.ts            the claude child's reduced argv (stream-json, --model <full name>, --effort <level> unless default, --append-system-prompt <Agent language instruction> for a 中文 session, --permission-prompts none, --session-id/--resume) and its env (pi-web's minus PI_WEB_PASSWORD/CLAUDECODE)
  claude-config-dir.ts      the system claude's config dir (inherited CLAUDE_CONFIG_DIR, else ~/.claude; never created): transcript lookup/removal by id, subagent sidecar lookup (`<id>/subagents/agent-*.jsonl` + meta)
  claude-index.ts           <pi agent dir>/claude-sessions.json: the claude sessions pi-web created (name, current full model name, effort, Agent language fixed at creation, archived, result usage; legacy alias/preset and effort-less or language-less records read tolerantly); serialized atomic writes
  claude-adapter.ts         the only claude-aware module: stream-json events and the jsonl transcript → pi events/messages, result usage, stdin lines (prompt, interrupt, set_model / apply_flag_settings control requests, bare /compact), control_response answers, compact_boundary tokens and the transcript boundary as pi's compaction card; subagent activity (`parent_tool_use_id`, task_* events, async launch receipts) → `claude_subagent` run events, never main messages
  claude-subagent-view.ts   client-safe claude subagent run model: run/entry types, merge by entry id (live and history alike), default expansion + page-memory manual toggle, header stats, page size 25; no format parsing
  claude-session.ts         a claude child per live session: spawn from PATH, stdin prompts, live set_model / set_effort over claude's control channel (refusal kept, idle switch index-only) and /compact as a guarded turn, lease/idle, Stop (interrupt, then SIGINT), --resume restart, process-group shutdown, list rows, stats; history with sidecar subagent runs; unsettled background subagents hold the idle timer and the announcement until claude's last follow-up turn ends
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
  types.ts            shared TypeScript types (SessionInfo.harness / claude { model, effort } / archived for claude rows)
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + tab management (no top-bar bg-tasks toggle or running-count badge: the dock opens from the bg-task terminal notification only,; claude sessions: export unavailable in visible text, no background tasks/subagents/title); the Messages 「@」 fill binding (`bindPromptTarget`, click-time, through resolveChatInputHandle's derivation) and its prompt request
  SessionSidebar.tsx  the sidebar (internal line; upstream's redesign not adopted,): session rows (claude rows carry a right-aligned `claude` harness chip, never the model), pinned directories, archive (claude rows: in pi-web's index), filters, multi-root FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper (claude sessions: pi-only controls hidden, claude's model / effort / compact handlers passed; provides the subagent runs to every Agent row)
  ChatInput.tsx       input bar + model/thinking/tools/compact controls; a fresh composer's harness selector beside the model selector (claude: the four full names); a claude composer's model selector (four full names; on a phone an open session keeps it in the bottom bar's left cell,) and effort in pi's reasoning menu, an open claude session's compact control (idle only; ≤640px effort and compact in More controls) and its compact result line; ClaudeComposerControls: the system-claude hint, not-on-PATH reason, a refused switch's line; image attach/paste/drop on both harnesses (claude: PNG/JPEG/GIF/WebP only, visible refusal, no image warning)
  HarnessSelector.tsx a fresh composer's pi/claude popover, the model selector's button and rows (claude disabled with its reason when not on PATH)
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult); in a claude session an Agent/Task call with a run renders ClaudeSubagentRow; its tool card shell and markdown guard are the shared ToolCallCard / SafeMarkdownBody
  ToolCallCard.tsx    the transcript's tool card shell — tone border, one aria-expanded header (name, ellipsized preview, stats, chevron), formatToolDuration and its 100 ms floor; shared by MessageView and the Polyforge progress cards
  SafeMarkdownBody.tsx MarkdownBody behind the oversized-content guard (click-to-reveal plain text over 100k chars); shared by MessageView and the Polyforge progress narration
  ClaudeSubagentRow.tsx a claude subagent run's Agent row: header (badge, description, live status or tools · duration · tokens), expands in place into prompt → indented timeline (MessageView) → Result, 25-step paging; ClaudeSubagentContext carries the runs
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
  SessionChatPanel.tsx     right-panel tab of a subagent: a ChatWindow for that session
  DebugPanel.tsx           Debug top panel (toolbar, left of the stats): page and server state, its own tick and poll, error boundary; mounts MachineLoadSection as the last area of `.debug-cols` (the narrow rightmost column on a wide panel, under the sessions in the middle, the last block of the phone stack)
  MachineLoadSection.tsx   host-labelled machine-load section of the Debug panel (its only mount; mounted only while the panel is open)
  debug-panel-state.ts     pure helpers of DebugPanel: formatting, server clock, poller, issues, session grouping, poll samples
  PluginsConfig.tsx   modal for installed package plugins
  PolyforgeConfig.tsx  Settings › Polyforge section: machine detection display + the pi package switch (pi#122; once-per-open, no polling) + the two browser-stored Jobs card preferences; confirmed order, one-line detection summary, seven common keys with counted read-only folds, collapsed read-outs, per-row inline feedback, browser-stored disclosure; the workflow card (per-project step rows across bundles, declared/inherited and effective chains, inline chain/attr edits through the config write route, ↻ fresh read, capability-gated writes) and the 工作区 card (the cli.toml mapping rows only, legend/header above the fold; the declared-candidates card is gone);/#290: one cli.toml card with literal `cli.toml` / `cli.toml [daemon]` / `cli.toml [summarize]` zones and the read-only `[memory_policy]` blocks grouped per workspace path (both from `pf --json config list` only; below pf 2.20.21 — or an unknown version — both hidden behind one localized upgrade hint), the nine non-secret keys editable (5 common visible, 3 + 2 advanced folded per zone on the cliToml/daemon regions), connection keys saved only after a page-level confirmation with an inline notice + one-click rollback, and the workflow card's project union with owning-workspace writes
  PolyforgePanel.tsx  the Polyforge dock panel: header, Work | Memory | Messages strip, Work's sub-tab rail, the Jobs card row and the job detail — one scroll region of three blocks, ① summary (title row, folded goal + expand control, facts, summarize narration, tool calls / recent files / origin) ② DAG ③ the whole-job execution progress (narration as Markdown via SafeMarkdownBody, thinking dim italic, tool calls as PolyforgeProgressToolCard, lifecycle marker rows with tones, every spawn block — a lone one too — under a foldable group head with step/status/duration that absorbs its start and terminal lines; 200-line render chunks, legacy omitted marker); the region opens at the top per selection and follows new lines only for a reader at its bottom; no event-mode toggle, command row or event tail (#163, #210, #213, #238, #251); an analysis card's task link switches to Work › Tasks and hands the id to PolyforgeTasks
  PolyforgeProgressToolCard.tsx  one progress tool call on the ToolCallCard shell: 120-code-point header with the full masked text on its title, ok/error/running + duration, collapsed by default; its expansion reads that call's detail once (fetchProgressToolDetail) and shows the full input/output inline, no result yet, or unavailable for that card only
  PolyforgeMessages.tsx  the Messages tab: list column (direct rows, collapsible project groups with counts and admin-only add/remove behind confirmations, 群聊; it folds to a 28px strip on desktop and a 40px strip in the ≤640px sheet, each with the expand control and the total-unread indicator, the sheet's collapse control in a 40px header row, + #274) beside the bubble pane — the inline icon+text Analyze button on every received message with per-message in-flight state and refusal slot, the analysis card under its message, 【回复】's draft prefill (never sends) and the 建票 dialog (#93, #150, #222, #223, #252); the visible 「@」 on every row (own messages too) with per-message in-flight state, the click-time `bindPromptTarget` binding, the fill / under-message prompt / refusal outcome under the message (`已填入 <会话名>`, `无目标会话，已显示在消息下`) and the busy report that keeps the desktop dock open mid-run
  PolyforgeAnalysisCard.tsx  one message's collapsible analysis card: localized type badge, model · duration, expand control and the 【建票】/【回复】 row (suggested one primary) always shown; summary and the Work › Tasks task link while expanded
  PolyforgeFileTicketDialog.tsx  the 【建票】 confirmation dialog: goal / mapped-project select / content prefilled and editable, cancel writes nothing, confirm = one file-ticket POST, a refusal stays open with pf's text
  PolyforgeSearchBar.tsx  the one search bar of Work › 工单列表, Memory and Tasks: row 1 search input + square icon action, row 2 filters, `data-pf-searchbar`; desktop 26px/1px/radius 4/12px, ≤640px no-wrap row, 2-column filter grid and ≥40px controls; the shared ↻ (#204 contract)
  PolyforgeWorkItems.tsx  Work › 工单列表: the read-only work item list/detail surface — one read per opening, per count-key change and per ↻ click, client-only filters/search, the 500 hint, no virtualisation (↻)
  PolyforgeTasks.tsx  Work › Tasks: the read-only task list/detail (#163, #194, #204); an external `openTaskId` (an analysis card's task link) runs that task's existing detail read once
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
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic; a claude session's subagent run map (history's `claudeSubagents` + live `claude_subagent` deltas, merged by entry id,); claude model / effort switches, a fresh claude composer's effort and the refused-switch line
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
  usePolyforgeProgress.ts  the job detail's execution progress: fixed 2 s visible-only poll of /api/polyforge/progress while the selected job runs, one read otherwise, last-good snapshot, a failed first read is unavailable (#238)
  usePolyforgePanelPreferences.ts  the card stream's title length and poll interval, live on save (storage + preferences event)
  usePolyforgeDisclosure.ts        the Settings › Polyforge page's stored open/closed regions (useSyncExternalStore, all-closed server snapshot, storage + change event)
  usePolyforgeMessagesCollapse.ts  the Messages list's collapsed project groups under `pi-web:polyforge-messages-collapsed` (useSyncExternalStore, none-collapsed server snapshot, storage + change event)
  usePolyforgeMessagesListCollapse.ts  the Messages contact column's strip state under `pi-web:polyforge-messages-list-collapsed` (useSyncExternalStore, expanded server snapshot, storage + change event;, shared with the ≤640px sheet)
  usePolyforge.ts  the dock's reads and actions (status, cards, watch, Messages); the page-memory `analyses` map of structured analyses by message id, cleared when the dock closes
```

---

## Topic Notes

Design decisions and traps live in `docs/agents/`, one note per area. Read every note whose files a change touches before making it. Add new notes to the area's file, not here.

- [sessions.md](docs/agents/sessions.md): AgentSession lifecycle and shutdown, fork vs in-session branching, session file rewrites, toolCall normalization, SSE reconnect and tool events, transcript system / usage / context-edit entries, running-state polling, the manual fetch of the newest data, exported HTML. Files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/normalize.ts`, `hooks/useAgentSession.ts`, `lib/manual-fetch.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `components/CodemodeToolView.tsx`, `components/ChatWindow.tsx` (the manual fetch, the message list).
- [claude-sessions.md](docs/agents/claude-sessions.md): the claude harness (#250, #253, #270, #272) — the system claude, harness and model selectors side by side (the four full model names pinned to 2.1.312, reset on a harness switch, the system-claude hint), the model / effort / compact controls in pi's slots (hot `set_model` over claude's control channel with a visible refusal, effort low…max + 「默认」 via `apply_flag_settings` and `--effort`, claude's own `/compact` as a stoppable turn with its result line and transcript marker, idle-only, no tool preset or `configured`), the one reduced argv and `--permission-prompts none`, the inherited environment and config dir (no dedicated dir, no presets), pi-web's tolerant claude index, history from claude's transcript, lease/idle/`--resume` and process-group shutdown, Stop, result-aggregate usage, the adapter and its recorded fixtures, first-class subagent runs (live routing by `parent_tool_use_id` and task events, the async launch receipt is no completion, history from the sidecars, claude's follow-up turn — its own turn at the hidden `claude:task-notification` anchor — and `subagentsActive` until it ends, the Agent row, the one fold exception for a running background subagent), image attachments (the three entry points, pi's limits plus the PNG/JPEG/GIF/WebP whitelist, the API's 400 before stdin, exact base64 on stdin, image-only `[Image]` turns, live and transcript replay), the Agent language's conditional `--append-system-prompt` on every launch of a 中文 session and the index's tolerant `agentLanguage` (the `language/` recording), hidden pi-only features. Files: `lib/claude-*.ts`, `lib/agent-language.ts`, `lib/image-attachments.ts`, `lib/__fixtures__/claude-2.1.312/` (`language/` included), `app/api/claude/route.ts`, the claude branches of `app/api/agent/**` and `app/api/sessions/**`, `instrumentation-node.ts`, claude parts of `hooks/useAgentSession.ts` (the subagent run map), `components/ChatInput.tsx`, `components/HarnessSelector.tsx`, `components/ChatWindow.tsx`, `components/ClaudeSubagentRow.tsx`, the claude anchor in `lib/message-display.ts`, `components/SessionSidebar.tsx`, `components/AppShell.tsx`.
- [tools.md](docs/agents/tools.md): what `configured` means in plain language (no tool override: pi's `settings.json` `defaultTools`, else pi's built-in default list; claude sessions have none), tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `lib/agent-language.ts`, `lib/session-agent-language.ts`, `lib/agent-language-prompt.ts` (the Agent language append,), `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md): the per-session MCP host (when servers register and connect, reported states, trust read on every sync, idle release); `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md): Settings › MCP reads without running anything, masking, the trust dialog's server list, row states, notices, Code mode choice, trust from Settings, Escape stacking, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md): Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md): Settings › MCP add (paste re-parsed on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust, the add pane) and the paste importer's escaping and grammars. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md): default model and reasoning level, providers registered at session_start, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, provider auth listing and credentials. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-catalog-refresh.ts`, `lib/deferred-provider-models.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md): worktrees and project grouping, the file access allow-list (the `/api/files` security boundary), file tree visibility, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/FileExplorer.tsx`.
- [settings-ui.md](docs/agents/settings-ui.md): Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks every settings panel and add pane uses. Files: `app/api/plugins/**`, `app/api/skills/**`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`, `components/PolyforgeConfig.tsx` (the Settings › Polyforge section, pi#122), `lib/agent-language.ts`, `lib/agent-language-config.ts`, `app/api/agent-language/route.ts`, `AgentLanguageSettings` in `components/SettingsPanel.tsx` (Settings › General's Agent language,); also before adding a settings section or add pane.
- [subagents.md](docs/agents/subagents.md): the built-in subagent setting, profiles and their files, run status, completion notifications, the subagent tab (a pi subagent's Agent language inheritance is documented in [tools.md](docs/agents/tools.md), not here,). Files: `lib/subagent*.ts`, `lib/agent-language.ts`, `lib/session-agent-language.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`, `components/SessionChatPanel.tsx`.
- [client-platform.md](docs/agents/client-platform.md): the global shortcuts (Ctrl+Alt+N on macOS's dead-key Option+N and Windows AltGr, Esc stacking), mobile software keyboard and viewport height, the terminal's extra keys, its own dark/light theme and its font size following the chat's, completion sound, the message list's bottom pull-up that starts the manual fetch. Files: `hooks/useKeyboardShortcuts.ts`, `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, `components/TerminalExtraKeys.tsx`, `lib/terminal-extra-keys.ts`, `lib/terminal-theme.ts`, `hooks/useTerminalTheme.ts`, `terminalFontSize()` in `hooks/useChatAppearance.ts`, the keyboard-open CSS, the touch pull-up in `components/ChatWindow.tsx`.
- [polyforge-panel.md](docs/agents/polyforge-panel.md): the Polyforge dock panel — `app/api/polyforge/**` routes (degradation-first, no 5xx): GET reads, and writes only through JSON-only POSTs (`messages` send, `messages/ack`, `projects/members`, the configuration panel's `config`/`config/reload`/`config/history` rollback), the analysis card's bundle-free registration-ticket `POST /api/polyforge/messages/file-ticket`, the Messages 「@」 action's `POST /api/polyforge/messages/prompt` in `app/api/polyforge/messages/prompt/route.ts` (the 2.20.20 prompt floor, click-time binding, append fill into the bound composer or session draft, under-message fallbacks, 已填入 / 无目标会话，已显示在消息下 feedback), pf subprocess contract (`--once --events 40`, probe TTL), response sanitization, polling cadence, the shared dock slot, the Work tab (Work | Memory | Messages top strip, order; Jobs, Tasks and 工单列表 are Work's sub-tabs in a ~72px right text rail, a 40px right-side vertical icon rail at ≤640px with aria-label/title names and the badge under the icon (; the main area stays first in the DOM, no remount); page-memory sub-tab, anchors land on Work › Jobs), the Messages tab's two panes (the list column right of the chat pane with its divider, 选择一个会话 while nothing is open and the ← back control) at every width — on desktop that divider is a resize separator, width 120px…min(480px, panel−200px), default 35% clamped 120–220px, stored globally under `pi-web:polyforge-messages-list-width`; the ≤640px sheet keeps the fixed `clamp(120px, 35%, 220px)` expanded and no handle but folds to a 40px strip with 40×40 controls through the same key; the message analysis (the inline icon+text Analyze button on received messages, the 2.20.18 analysis floor, the collapsible structured analysis card with the closed localized type badge, task link and 【建票】/【回复】 actions, the bundle-free `POST /api/polyforge/messages/file-ticket` registration-ticket write in `app/api/polyforge/messages/file-ticket/route.ts`, page memory only), the contact-column strip (28px on desktop; the ≤640px sheet folds to a 40px strip, 40×40 controls, its own `pi-web:polyforge-messages-list-collapsed` key in `lib/polyforge-messages-list-collapse.ts` beside #222/#223), the project groups (one collapsible group per `cli.toml`-mapped project between the direct rows and 群聊, contact counts, empty/failure notes, no unread on group rows, folding stored under `pi-web:polyforge-messages-collapsed`, the `pf users list` admin probe gating add (writer) / remove behind confirmations via `GET /api/polyforge/users` and `POST /api/polyforge/projects/members`, immediate re-read after a change), the read-only work item list (one merged `pf --json queue` and one `pf --json file show` GET face, the 2.19.0 floor, 8-key row / 18-key detail passports, the 256 KiB content cap, whole-table degradation, newest-first rows with the total and the exact-500-per-project hint, client-only status/project filters and slug/goal/project search, no virtualisation, a last-read running badge and one re-read per `queue.running`:terminal-jobs key change), the Settings section's machine detection (pi#122), the configuration panel (the config read/write/reload/history routes, CAS diff, api_key stdin-only, capability floor, bounded history; the nine-key cli.toml allowlist, summarize read only from the workspace yaml (superseded by), the workflow read's mapped-workspace union with its spawn bound and owning-workspace write `--cwd`; summarize and the per-path memory_policy read only from `pf --json config list` (no `config workspace` fallback), summarize written as flat cli.toml keys (no `--cwd`, the cli.toml CAS), both hidden below the 2.20.21 floor (an unknown version counts below) with one upgrade hint and summarize writes refused 400, memory_policy read-only in the cli.toml card, the 工作区 card mapping-only; a workflow step row is one line when it fits and wraps by segment otherwise, never overflowing, and the machine-scope hint is one ellipsised line with its full title at desktop, whole and balanced at ≤640px) the Memory tab (browses the project's memories by default with load more and a total, a keyword switches to the `pf recall` relevance read, `pf memory show` detail, the 2.20.12 floor, hit/detail passports, the 256 KiB body cap, no polling), the read-only Tasks tab (`pf task list`/`pf task show` GET faces, 正在运行 / 全部 sections, no spawn or cancel, the 2.20.12 floor; a responsive block grid with state, project, two-line summary and durations — side by side,; the 150px track, two across at 460px and the 375px sheet, one at 340px ( decouples it from the 180px job cards), —, client-side project/state filters over the one list read — running ones tick on a local 1 s render clock that never reads; two-line plain-text report tail under the summary, dim 生成中… on running / 暂无报告 on finished blocks without a tail, and a client-only reporter filter (全部发起人, humans ascending, 机器发起 last; component memory only; a 26px ↻ refresh button on the search row re-reads the list once per click — disabled, aria-busy and animate-spin while the newest list read is in flight, labelled polyforge.refresh / polyforge.refreshing)), the desktop dock pin (persisted, suppresses only the outside-press dismissal) and the Jobs tab card stream (block, compact side-by-side cards, the status on the slug's row with the running job's age and no card narration, and's status-coloured card frame / duration-only running label, a 180px fixed job card decoupled from the Tasks grid's own 150px minimum/#322: one GET read of the daemon's own files per tick, ordering, key information only — slug + goal, status, the emphasized needs-input marker, narration-only progress (transcript whitelist) — with the DAG step graph (name + dot only, the status in title/aria-label, skipped a hollow gray ring), step durations and reruns in the job detail (the detail reads summary — the one-line title row with the pure first-clause short title, the goal folded to three lines with an expand control, the job facts, the summarize narration, tool calls / recent files / origin — → DAG with a +duration/×N timing line under each node and the start time in the node title → the whole-job execution progress last via `GET /api/polyforge/progress` and `hooks/usePolyforgeProgress.ts`, lifecycle events as its lines; no event-mode toggle, command row or event tail; Markdown narration, the shared tool cards with the on-demand `GET /api/polyforge/progress/tool` detail, light poll tool fields, group heads absorbing start/terminal lines with their duration, lone blocks foldable), the no-Loading empty state, cursor and bounds, the daemon/capsule layout coupling, the two browser-stored preferences); one shared search bar (`components/PolyforgeSearchBar.tsx`) renders the 工单列表, Memory and Tasks search rows — `data-pf-searchbar`, input + square icon action then the filter row, desktop 26px/1px/4/12px, ≤640px no-wrap input row, 2-column filter grid and ≥40px controls (action 40×40) — with the 工单列表 ↻ manual re-read (#204 busy contract, one existing work-items GET per click), the Memory 🔍 submit (keyword still submit-only; visible labels dropped for aria/title/placeholder) and the Tasks ↻ unchanged. Files: `lib/polyforge-status.ts`, `lib/polyforge-cards*.ts`, `lib/polyforge-panel-preferences.ts`, `lib/polyforge-disclosure.ts`, `lib/polyforge-messages*.ts`, `lib/polyforge-detect.ts`, `lib/polyforge-config*.ts`, `lib/polyforge-memory*.ts`, `lib/polyforge-tasks*.ts`, `lib/polyforge-work-items*.ts`, `lib/polyforge-workflows*.ts`, `lib/package-settings.ts`, `app/api/polyforge/**`, `hooks/usePolyforge.ts`, `hooks/usePolyforgePanelPreferences.ts`, `hooks/usePolyforgeDisclosure.ts`, `hooks/usePolyforgeMessagesCollapse.ts`, `hooks/usePolyforgeMessagesListCollapse.ts`, `components/PolyforgePanel.tsx`, `components/PolyforgeProgressToolCard.tsx`, `components/ToolCallCard.tsx` and `components/SafeMarkdownBody.tsx` (shared with the transcript), `components/PolyforgeMessages.tsx`, `components/PolyforgeAnalysisCard.tsx`, `components/PolyforgeFileTicketDialog.tsx`, `components/PolyforgeMemory.tsx`, `components/PolyforgeTasks.tsx`, `components/PolyforgeSearchBar.tsx`, `components/PolyforgeWorkItems.tsx`, `components/PolyforgeConfig.tsx`, `polyforge.*` wiring in `components/AppShell.tsx` and `lib/i18n/messages/*`.
- [machine-load.md](docs/agents/machine-load.md): the Debug panel's machine load (#168; the grid's narrow rightmost column since, Debug only since) — the `GET /api/machine-load` whitelist and degradation, the on-demand 2 s shared sampler and delta CPU, the host-view caveat, open + visible client polling, last-good / clear-on-close, the pinned formats. Files: `app/api/machine-load/route.ts`, `lib/machine-load.ts`, `lib/machine-load-view.ts`, `hooks/useMachineLoad.ts`, `components/MachineLoadSection.tsx`, its mount in `components/DebugPanel.tsx`, `session.machine*` in `lib/i18n/messages/*`.

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

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
