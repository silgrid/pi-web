# Polyforge dock panel (pi#108)

A read-only Polyforge panel in the shared dock slot (the bg-tasks slot): a topbar
button + right dock (desktop) / bottom sheet (mobile), a job list, and a selected
work item's steps and event tail. Files: `lib/polyforge-status.ts`,
`app/api/polyforge/**`, `hooks/usePolyforge.ts`, `components/PolyforgePanel.tsx`,
the `polyforge.*` wiring in `components/AppShell.tsx`, the dock width
and sheet height constants in `lib/panel-layout.ts`, the resize handles
`hooks/useResizablePanel.ts` / `hooks/useResizableSheet.ts` and their
`.pf-dock-resize-handle` / `.pf-sheet-resize-handle` styles in
`app/globals.css`. The session chat-id resolution (pi#121) lives in
`lib/session-chat-id.ts` + `app/api/sessions/[id]/chat-id` and is documented
here too, because it is the same pf subprocess contract. The Settings Polyforge
section's machine-level detection (pi#122) is documented here as well — its
`detect` route lives under `app/api/polyforge/**` and shares the same presence
probe; the section UI itself is in [settings-ui.md](settings-ui.md).

## Route contracts (degradation-first)

- `GET /api/polyforge/status` → 200 `{pfPresent:boolean, status:{queue:{running,max},
  jobs:[{wi,slug,status,stepAgeSec,idleAgeSec,candidate,spawnN}]} | null, error?}`.
  Pf absent answers `{pfPresent:false,status:null}` (no error, the client stops
  polling); daemon down / auth failure / hang answer `{pfPresent:true,status:null,error}`.
- `GET /api/polyforge/watch?wi=<slug|wi_id>` → 200 `{status:{wi,slug,workflowStatus,
  currentStep,updatedAt,steps:[{name,status,startedAt?}],declared_steps:[{id}]|null,
  events:[{at,kind,summary?}],progress?:{command,command_age_sec,tool_calls,
  recent_files},origin?:{kind:"chat",chat_id,owner},summary?,summary_age_sec?,
  summary_error?,summary_capped?} | null, error?}`.
  A malformed `wi` answers 400 and never spawns pf. The pi#117 additions
  (`progress`, per-step `startedAt`, chat `origin`) and the pi#119 additions
  (the four summarize-lane fields) are sanitized, additive fields: each is
  absent when missing or malformed on the wire, and every existing field is
  unchanged.
- `GET /api/polyforge/detect[?force=1]` (pi#122, the Settings Polyforge section)
  → 200 flat `{pfPresent, pfVersion: string|null, pfVersionBelowMinimum,
  line: "internal"|"public"|"unknown", piSkillInstalled, piSkillEnabled,
  claudeSkillsSymlink, claudeSessionStartHook, daemon: {reachable, error?} |
  null}` — assembled by `detectPolyforge(force)` in `lib/polyforge-detect.ts`.
  Pf absent answers the same 200 shape with every dependent field absent
  (`pfVersion: null`, `daemon: null` = 不适用, no probe attempted, **no error
  field** — the pf-less path must trip no browser console error). A top-level
  catch answers 200 with those absent states: no 5xx path exists, and the only
  non-2xx is the same in-route `isApiRequestAllowed` 403. `?force=1` bypasses
  the 60 s presence cache read (the section's 「重新检测」). The response is
  flat booleans/labels only (R8): no `api_key`, server address, `user_id`,
  `cli.toml` contents, absolute home paths, or `process.env` values ever leave
  — the resolved clone root, the package source and the Claude hook command
  text all stay server-side.
- There is no 5xx path on either route, and every failure answers decodable
  JSON: the e2e suite treats any 5xx as a browser error. Both routes re-check
  `isApiRequestAllowed` in-route (`lib/request-security.ts`) and answer 403 JSON
  on refusal.
- `GET /api/sessions/[id]/chat-id` (pi#121) → 200 `{chatId: string | null}`.
  Every absent case — pf absent, daemon unreachable, a bad token shape, a
  timeout, or a session this server never started or attached — answers
  `200 {chatId: null}`, never 4xx/5xx and never error text: the id feeds a
  cosmetic tab-label suffix, and any non-2xx fetch logs a browser console
  error that fails the e2e suite. The only non-2xx path is the same in-route
  `isApiRequestAllowed` 403. The id is shape-validated
  (`isChatIdToken`, `lib/session-chat-id.ts`) before it can reach a response;
  pf's stderr never does.

## Subprocess contract

- All pf reads go through `execFileAsync` from `lib/exec-file.ts` (no shell);
  the ref is one closed argv positional, validated by `isPolyforgeWiRef`
  BEFORE any spawn.
- Presence probe: `pf --version`, 3 s timeout, cached module-side for 60 s
  (a CLI installed while the server runs appears after a reload once the TTL
  expires). The UI affordance is gated on presence, never on daemon
  reachability. **One detection implementation (pi#122):** the cache carries
  `{present, version}` — `probePolyforgeVersion(force?)` returns both from the
  single `pf --version` spawn (`force` bypasses the cache read; every probe
  refreshes it), `probePolyforgePresent()` keeps its boolean contract by
  delegating to it (its callers — the status route and
  `lib/session-chat-id.ts` — are unchanged), and `parsePolyforgeVersion`
  (pure) passes a semver-ish `v?X.Y.Z` line verbatim and reads anything else as
  version-absent-but-present. No other module spawns `pf --version`.
- Ops: `pf --json ops status`, 10 s timeout. Watch: `pf --json watch <ref>
  --once --demand --events 40`, 10 s timeout. **`--once` is mandatory** —
  without it `pf watch` is the resident watcher and streams forever.
  **`--demand` (pi#119) arms the summarize lane on every watch read**: the
  route passes it always, on every call, with no client parameter — the
  open panel's 3 s poll is the route's only in-app caller, so every read is
  a human-side read (a direct API GET is one too). No fallback, no
  retry-without-the-flag: a pf older than v2.18.1 (no `--demand`) fails the
  watch read and the route answers through the existing degradation path
  (`200 {status:null,error}`, no 5xx). **Minimum pf: v2.18.1** — the first
  release carrying the demand-gated summarize lane (polyforge#224).
- Failure text is pf's own stderr, capped at 512 chars. Error strings are
  never built from `process.env`: a stale `POLYFORGE_V1_API_KEY` inherited by
  the child must leak nothing (values, not names, are the secret).
- Chat init (pi#121): `pf chat init --harness pi --harness-session <id>` —
  NO `--json` — 10 s timeout, through the same `execFileAsync` (no shell).
  Measured against pf v2.18.2: exit 0, stdout is exactly the chat id token
  (`chat_` + 16 hex chars) plus a trailing newline; the trimmed stdout must
  match `^chat_[A-Za-z0-9_]+$` or it counts as absent — the same discipline the
  pf-chat extension (the reference consumer) applies. A live run from this
  machine is refused by the daemon's step-agent guard (DAEMON-403: a step
  agent must never drive the daemon), so the shape is verified from the
  polyforge CLI source (`verbs_chat.go` prints `rec.ChatID` via `Fprintln`)
  and its own CLI test, which pins stdout == the bare token.

## Settings detection (pi#122)

`detectPolyforge(force?)` in `lib/polyforge-detect.ts` assembles the Settings
Polyforge section's machine-level detection. Field independence: line, pi-skill
and Claude Code state are machine facts read independently of pf presence; the
pf-dependent fields degrade when pf is absent (version absent, daemon 不适用,
no probe attempted). Every read degrades on its own — a missing or unparsable
settings file, a failed spawn, a broken link — never an error, never a guess.

- **Version hint (R3):** `pfVersionBelowMinimum` is a server-computed boolean
  against `POLYFORGE_MINIMUM_PF_VERSION = "2.18.1"` (the dock's documented
  `--demand` floor): pure semver-ish compare of the X.Y.Z cores (leading `v`
  tolerated, prerelease suffix ignored), non-blocking — every other field is
  still reported below the floor.
- **Line (R4):** the clone root is located as the global polyforge package
  entry's source when that entry exists, else install.sh's conventional
  `<homedir>/.local/share/polyforge/release/current` when it exists; then
  `git -C <root> remote get-url origin` via `execFileAsync` (no shell, 3 s).
  The URL's owner/repo pair (`git@host:O/R.git` and `https://host/O/R.git`
  forms, `.git` stripped) sha256-compares (hex) against the built-in
  internal-line digest constant (`INTERNAL_ORIGIN_OWNER_REPO_SHA256` in
  `lib/polyforge-detect.ts` — the pair is stored only as that digest, never
  as plaintext) → a match is `internal`; any other
  parseable origin → `public`; no clone, no origin, or a git/parse failure →
  `unknown`, never a guess. The resolved home-path root never leaves the
  server.
- **pi skill (R5):** the harness package is the **global** settings entry whose
  source resolves to an existing directory whose `package.json` name is
  `polyforge` (project-scope entries are never consulted). Installed = such an
  entry exists; enabled = a plain string entry, or an object entry the plugins
  route's disabled-shape rule does not count disabled — the same rule lives
  once in `lib/package-settings.ts` (`getPackageSource`/`isDisabledPackage`,
  extracted from the plugins route). Global settings are read through
  `lib/global-settings-file.ts`'s locked `readGlobalSettings`; a missing or
  unparsable file degrades to 未安装, never an error.
- **Claude Code (R6):** `~/.claude/skills/polyforge` resolves through the
  symlink (stat) → boolean; `~/.claude/settings.json` carries a SessionStart
  hook whose command references polyforge → boolean. Two separate read-only
  facts; the command text itself never leaves the server (only the boolean).
- **Daemon (R7):** reused exactly — `getPolyforgeOpsStatus()`
  (`pf --json ops status`) resolving = 可达; throwing = 不可达 + pf's own
  stderr (≤512 through `PolyforgeError`); pf absent → `daemon: null`, no probe
  attempted. No second probe, no Node-direct UDS.

## Session chat ids (pi#121)

The pane/session tab labels carry a display-only ` · <id>` suffix with the
session's polyforge chat id, so a panel/watcher `chat_id` can be matched to
its tab character for character. Resolution is server-side
(`lib/session-chat-id.ts` + the route above):

- **Live-session gate** — only a session this server has started or attached
  resolves: a live wrapper in `lib/rpc-manager.ts` when the request arrives.
  A session that is not live (an old history session opened in a tab after a
  server restart, or one released while idle before it was ever resolved)
  gets no suffix and spawns no pf — pi-web never mints a chat id for a chat
  pf-chat did not run in. A session first resolved while live keeps its
  cached id after it is released.
- **Cache** — a successful id is cached per sessionId for the life of the
  process (the daemon mapping is immutable). Failures (pf absent, daemon
  unreachable, bad shape, timeout) never land in the cache, so a later
  render or refresh retries.
- **Client** — `hooks/useSessionChatIds.ts`: lazy, once per surface when it
  first renders the id (a pane tab on desktop, the current session on
  mobile), plus at most two bounded retries while the answer is null (the
  first request races the tab's own SSE attach). Gated on pf presence
  (`usePolyforge`'s mount probe): a pf-less install issues no request at
  all. Absent answers render no suffix and raise no error.
- **Rendering** — the suffix is display-only: `shortenCandidate` in the text
  (exactly the panel's chat-id rendering; the full id at ~21 chars), the
  FULL id on the hover title. Surfaces: the desktop pane headers and their
  overflow entries (`components/SplitPaneLayout.tsx`), and the mobile
  current-session element — the mobile toolbar's session-stats button
  (`data-mobile-toolbar-stats`; the mobile layout has no session-name
  header). The suffix is never persisted into `tab.label`, the session
  name, the `.jsonl` or rename inputs; the sidebar session list and the
  document title get none.

## Sanitization (the machine shape never leaves the server)

`sanitizeOpsStatus` keeps only queue running/max and per-job
wi/slug/status/stepAgeSec/idleAgeSec/candidate/spawnN — `env_names`,
`workspaces`, `workflows_dir`, `machine_id`, `origin`, `session_fingerprint`
are dropped. `sanitizeWatch` maps events to
`{at,kind,step?,model?,from?,to?,cause?,gate?,target?,status?}` using a
per-kind body whitelist (pi#112): `step_started` → step+model;
`candidate_switched` → step+from+to; `step_failed`/`step_dead` → step+cause;
`rewind` → gate+target; `terminal` → status; every other kind (including
unknown kinds) → step only. Never leaves the sanitizer: question,
question_id, detail, evidence, error, answered_by, local_commit/commits,
files, reason, disposition, effort, resume, failure_count, from_model/
to_model, archived, version, commit_ms/push_ms/pushed, spawn_n — in
particular `needs_input` carries kind and step only, never the question
text. Raw event bodies are dropped. `progress` and `job` leave only through
the pi#117 whitelists: progress passes `command` (masked + truncated
server-side, below), `command_age_sec`, `tool_calls` and `recent_files`
(an array of path strings; anything that is not an array of strings
degrades to absent, never an error); `job` passes only a chat `origin` —
`kind:"chat"` plus `chat_id`/`owner`, every other origin field dropped,
and any other kind degrades the whole origin to absent. Step order is
execution order: started steps by `started_at` ascending, unstarted last,
ties by name; started steps carry their `startedAt` (pi#117) for the
client-side timing display, unstarted steps carry none.

**Summarize lane (pi#119).** The four flat wire fields leave only through
their own whitelist: `summary` (a trimmed non-empty string, verbatim — the
lane's own bound is 200 chars, no server-side cap), `summary_age_sec` (a
finite number, kept only together with `summary`), `summary_error` (a
trimmed non-empty string, verbatim, capped at 512 chars like the pf-stderr
cap — **no masking**: the dispatch design carries no credential in the
summarize argv, logs or artifacts, so raw-never-faked holds literally) and
`summary_capped` (kept only when the wire value is exactly `true`). Each
field is absent when missing or malformed on the wire, never an error, and
no other machine field leaks.

**Command redaction (pi#117).** `progress.command` leaves the server only
after `redactPolyforgeCommand` (`lib/polyforge-status.ts`, pure, exported
for tests) masks credential-shaped substrings — token prefixes (`sk-`,
`ghp_`, `npm_`), assignments whose name ends in `API_KEY`,
`token=`/`password=`/`passwd=` values (the `=` forms, flags included), and
the `--password <value>` flag form — and then truncates to ~120 chars.
Over-masking only costs display fidelity; under-masking leaks, so the
value patterns are greedy `\S+`. The raw machine command never reaches a
response. Masking is server-side only; the regexes carry no lookbehind
(repo rule).

`execution.declared_steps` (pi#114, raw shape proposed to companion WI
#213) is sanitized by `sanitizeDeclaredSteps` to the client shape
`declared_steps: [{id}] | null`: each entry contributes only its trimmed
non-empty `id`, in declaration order — field `on_fail` (and every other declared field, e.g. `path`) is dropped server-side, never reaching a response.
Absent, null, non-array, empty, or any entry without a valid id degrades
the whole field to `null` (pure, never throws, so the 2xx no-error-surface
contract holds); `steps`/`events` are unaffected either way.

## Step flow graph (pi#114)

The selected detail renders the steps as a flow graph instead of a plain
chip row (`buildStepGraph` in `components/PolyforgePanel.tsx`, pure):

- **Nodes** — one node per step, `role="list"`/`role="listitem"`,
  display-only (no click handler, no navigation). A node shows the 24-char
  cut step name plus a status dot; the full untruncated name and the
  translated status label (`polyforge.stepStatus.*`) are carried in the
  node's `title` and `aria-label`. Colours: done green (#16a34a), failed
  red (#dc2626), blocked amber (#d97706), in_progress `var(--accent)`,
  pending/cancelled/unknown gray (`var(--text-dim)`). Only the
  in_progress node's dot pulses (`.pf-step-node-pulse`, reusing the
  existing `pulse` keyframes); `prefers-reduced-motion: reduce` disables
  the animation.
- **Order and sequence edges** — with a valid `declared_steps`, nodes
  follow the declaration order; declared ids missing from `steps` render
  as pending gray placeholders; steps absent from the declaration are
  appended in started-at fallback order with no edges. Solid inline
  connectors (`→`, aria-hidden) join consecutive declared nodes only —
  never the last declared node to an appended extra, and never two
  extras. Without usable `declared_steps` (absent/malformed → `null`),
  the graph falls back to the started-at order and edges every consecutive
  pair within the prefix up to and including the last non-pending step, so
  never-started steps trail unedged. This prefix rule matters after a pf
  rewind: `applyRewindRangeLocked` resets rewound steps to `pending` while
  keeping `step_started_at`, so pending steps can sit inside the started
  segment and must stay connected (pf stamps `started_at` only on claim, so a
  step that never started is always pending). `on_fail` targets are
  not part of the node model, so they are never drawn. The node row is a
  `flex-wrap` container with `overflow: hidden` — rows wrap in the 460 px
  dock and the mobile sheet with no horizontal scroll; a connector that
  lands at a line end simply ends that line.
- **Rewind edges** — the tail's `rewind` events are deduplicated by
  gate→target pair: each distinct pair whose gate AND target are both nodes
  renders as one dashed chip on its own line under the node row,
  `title`/`aria-label`
  `${polyforge.eventKind.rewind}: gate → target` (existing keys, no new
  i18n labels). Rewinds outside the tail window or with an unknown
  endpoint are not drawn, and no dashed element exists in the panel
  otherwise.
- **Step status display** — the graph nodes are the only step status
  display in every event mode (simple, verbose, invalid): status colour
  plus the full name and translated status label in each node's
  `title`/`aria-label`. The pre-graph per-step name+status chip row was
  removed in pi#116; the dashed rewind chips under the node row are
  unaffected. The mode toggle behavior is unchanged and stays
  client-side.

## Detail rows (pi#117)

The selected detail renders the sanitized `progress`, per-step timing and
chat-origin data as display-only rows between the step flow graph and the
event tail. The whole block is absent when the snapshot carries none of it
(absent → no row, no placeholder); nothing in it is clickable and no row
issues a request.

- **Command** — `progress.command` (already masked + truncated
  server-side) in mono, with its age from `command_age_sec` beside the
  label (`Command · 2h 2m`); the full value rides the row's `title`.
  Shown only when `command` is present.
- **Tool calls** — the `tool_calls` count, when present (0 renders).
- **Recent files** — one ellipsized mono row per `recent_files` entry, the
  full path on `title`; anything that is not an array of strings degrades
  to absent server-side (never an error).
- **Per-step timing** — `buildStepTimings` (pure, exported): every started
  step shows its `started_at` (HH:MM:SS like the event tail); a done step's
  duration is its started_at → the NEXT started step's started_at (the
  steps array is execution-ordered, so the next entry, when started, is
  it); the in_progress step shows a live age since its started_at,
  computed at render from `Date.now()` — the 3 s watch poll re-renders, so
  the age stays live without a dedicated timer. Failed/blocked/cancelled
  started steps show started_at only; never-started steps show no row;
  an unparseable started_at degrades that step to no timing. The rows
  carry no status labels — the graph nodes stay the only step status
  display (pi#116).
- **Origin** — only for chat origins with something to show: `chat_id`
  (24-char cut, full value on `title`) and `owner` as plain text; the
  whole row is absent otherwise (the wire only carries chat origins).

## Summary block (pi#119)

The selected detail renders the summarize lane's narration as one
display-only block between the step flow graph and the pi#117 detail
rows: the summary line (verbatim, wrapping — no ellipsis), its age from
`summary_age_sec` formatted like `command_age_sec` (`Summary · 2h 2m`),
an amber cap-reached marker when `summary_capped` is true, and
`summary_error` on its own error-styled (red, mono) line — the error may
show together with an older summary. The whole block is absent when all
four fields are absent: no heading, placeholder or loading text, and
nothing in it is clickable or issues a request. The 3 s watch poll
refreshes the age (as it does `command_age_sec`); no client-side
ticking between polls. The job-list rows show none of it.

## Detail scroll region (pi#120)

With a job selected, the whole detail — the header (back button, slug,
updated/current step), the step flow graph, the summary block, the detail
rows, the event-mode toggle and the event tail — is ONE vertical scroll
region: the container under the job list (`flex: 1; min-height: 0;
overflow-y: auto`). No nested vertical scroller exists inside the detail
(the event tail is a plain block since pi#120), so every event-tail row is
reachable by scrolling that one region at any sheet height and in the
desktop dock — the old layout stacked the blocks as non-shrinking children
of an `overflow: hidden` column and clipped everything below the fold once
the fixed blocks plus the job list exceeded the available height (the tail
collapsed to zero). The panel's top header (title / refresh / close) stays
outside the region and visible. Horizontal behavior is unchanged: the graph
still wraps with no horizontal scroll. The same component renders the
mobile sheet and the desktop dock, so both get the fix.

## Client behavior

- `hooks/usePolyforge.ts`: one status fetch at mount decides presence; a
  pf-less install never polls again. With pf: 3 s cadence while the panel is
  open, 30 s while closed (the badge = queue running count; no badge while the
  daemon is down). With a selection while open: watch polls every 3 s; a null
  status keeps the previous snapshot, so the selection survives the job
  leaving the job list until the user deselects. Stale responses are dropped
  by sequence counters (effect cleanups advance them, never reset to an
  observation + 1). `refreshStatus` returns its settle promise (pi#113) so a
  manual caller can show in-flight state; the mount probe and the interval
  polls ignore it.
- `components/PolyforgePanel.tsx`: all jobs on the machine (no owner filter);
  the candidate is shortened client-side to 24 chars + `…`; unknown status
  values pass through raw (known ones use `polyforge.*` keys present in en,
  zh-CN and zh-TW). The selected detail's header hoists over the watchStatus
  split and carries a back button (`polyforge.deselect`) calling
  `onSelect(null)` — the deselect gesture survives the job leaving the list
  and the snapshot still loading. A blocked WI shows its status only — no question text
  exists in the client by construction. Manual refresh (pi#113): the refresh
  button's click spins its icon and disables the button until the status
  fetch settles, floored at ~400 ms; further clicks in the window are ignored;
  failure returns to idle with no button-specific error state (the panel's
  error text is the only error signal). The busy state is written only by the
  click path — background polls never spin or disable the button.
- `components/AppShell.tsx`: the button renders iff pf is present,
  independent of chat visibility; opening the Polyforge panel closes bg-tasks
  and vice versa (mutually exclusive dock slot: mobile bottom sheet both) —
  enforced on every path that opens either panel, including
  the bg-task terminal notification's jump: its onClick closes the Polyforge
  panel before showing bg-tasks, so the jump never lands on a covered dock.
  **Mobile sheet heights (pi#120):** both mobile sheets (Polyforge and
  bg-tasks, the same dock slot) open at 62 % of their container and resize
  by dragging a top-edge handle (`.pf-sheet-resize-handle`, one shared
  mechanism `hooks/useResizableSheet.ts`, two consumers). The drag is
  continuous under touch and mouse pointer events alike, clamped to
  [30 %, 90 %] of the same container the 62 % resolves against
  (`lib/panel-layout.ts`: `SHEET_*_HEIGHT_PCT`, `clampSheetHeightPct`,
  `parseStoredSheetHeightPct`); dragging past either bound just clamps —
  it never dismisses (the backdrop tap stays the only dismiss gesture; the
  handle is a DOM child of the sheet, above the backdrop), and the handle's
  `touch-action: none` keeps the page from scrolling or pull-to-refresh
  while it is dragged. Each sheet persists its own dragged height under its
  own localStorage key (`pi-web:polyforge-sheet-height`,
  `pi-web:bg-tasks-sheet-height`, the pi#117 uncoupled-widths convention);
  absent/invalid/out-of-range reads as the 62 % default. Keyboard resize
  (arrows, Home/End, Enter/double-click reset) mirrors the dock handle.
  **Desktop dock width (pi#117):** the Polyforge dock opens at 460 px and
  resizes through the shared `useResizablePanel` hook via a left-edge
  drag handle (`.pf-dock-resize-handle`, keyboard + double-click reset
  included), clamped to [340 px, 90 vw] (`lib/panel-layout.ts`:
  `POLYFORGE_DOCK_*`), persisted globally under the localStorage key
  `pi-web:polyforge-dock-width` (absent/invalid reads as 460; the same
  convention as `pi-web:polyforge-event-mode`). The handle is a DOM child
  of the dock (it straddles the dock's left edge), so the pi#113 outside-
  pointerdown dismissal counts it as part of the dock — dragging never
  closes the dock. The bg-tasks dock in the same slot stays fixed at
  340 px, uncoupled from the Polyforge width; the desktop keeps no height
  resize at all (the pi#120 sheet resizers serve the mobile branches only,
  their refs attaching to nothing while the desktop renders).
  Desktop dock dismissal (pi#113): while the dock is open, a `pointerdown`
  anywhere outside its own DOM (`data-pf-dock`) closes it — the press is
  never eaten (no `preventDefault`/`stopPropagation`; the dock is an overlay,
  so nothing under it unmounts mid-click), so the same click still performs
  its normal action on its target. The topbar toggle (`data-pf-toggle`) is
  exempt: its own click already ends closed, and a pointerdown dismissal
  there would close-then-reopen. The listener exists only while the desktop
  dock is open; the mobile sheet keeps its backdrop tap and the bg-tasks dock
  gets no outside-click close.
- **Event tail display modes (pi#112):** panel-local state with a global
  localStorage key `pi-web:polyforge-event-mode` (`"simple"|"verbose"`;
  absent/invalid reads as simple). Simple mode (the default) collapses each
  consecutive run of noise events (`published`, `transcript_missing`,
  `exec_init`) into one gray `sync ×N` row (×1 included); verbose mode renders
  every event on its own row with the raw kind shown inline and noise kinds
  de-emphasized individually (whole row in `var(--text-dim)`, the same
  treatment as the sync row), while meaningful neutral rows keep their values
  in `var(--text)` for clear contrast against grayed noise. Every row puts
  the raw kind and full whitelisted field values in its hover `title`, and
  renders whitelisted values as mono spans (`step · model`,
  `step · from → to`, `step · cause`, `gate → target`, terminal status, or
  lone step), ellipsized at 24 chars like the job candidate. The mode toggle
  uses the action-label model: its label names the mode it switches to
  (`Simple`/`Verbose`) and it carries no `aria-pressed` state.
  Severity emphasis: `needs_input` amber (#d97706); `step_failed`,
  `step_dead`, `push_failed`, `envelope_rejected`, `needs_recovery` and
  `terminal` failed red (#dc2626); `terminal` completed green (#16a34a);
  `terminal` cancelled and all other kinds neutral. The mode toggle lives in
  the event-tail area of the selected detail and is purely client-side — no
  network request on toggle.
