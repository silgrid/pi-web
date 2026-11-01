# Polyforge dock panel (pi#108)

A read-only Polyforge panel in the shared dock slot (the bg-tasks slot): a topbar
button + right dock (desktop) / bottom sheet (mobile), a job card stream, and a selected
work item's steps and event tail. On a narrow phone (≤480px) the topbar button is
resident, immediately right of the toolbar's ⋯ (More) button and left of the
session-stats strip; the More overlay holds the other chat actions but never
the Polyforge button. Files: `lib/polyforge-status.ts`, `lib/polyforge-messages.ts`,
`lib/polyforge-messages-pure.ts`, `lib/polyforge-cards.ts`, `lib/polyforge-cards-pure.ts`,
`lib/polyforge-panel-preferences.ts`, `lib/polyforge-disclosure.ts`, `lib/polyforge-messages-collapse.ts`, `app/api/polyforge/**`,
`hooks/usePolyforge.ts`, `hooks/usePolyforgePanelPreferences.ts`, `hooks/usePolyforgeDisclosure.ts`, `hooks/usePolyforgeMessagesCollapse.ts`, `components/PolyforgePanel.tsx`,
`components/PolyforgeMessages.tsx`, the `polyforge.*` wiring in
`components/AppShell.tsx`, the dock width
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
  jobs:[{wi,slug,status,stepAgeSec,idleAgeSec,candidate,spawnN}],
  tasks:{running,completed}} | null, error?}`. `tasks` is the
  machine's one-shot task counts — the Work › Tasks badge and the Tasks
  list's re-read key; a missing or malformed machine `tasks` reads as zeros.
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
- `GET /api/polyforge/cards[?cursors=<JSON {wi: cursor}>]` → 200
  `{pfPresent, cards:[{job:{wi,slug,status,stepAgeSec,idleAgeSec,candidate,spawnN},
  goal?, startedAt?, steps:[{id, state:"timed"|"unstarted"|"unknown", durationSec?, runs}],
  currentStep?, progress:{available, entries:[{id, text}], cursor?, reset?}}]
  | null, error?}` — the whole Jobs-tab card stream in one read. An entry is
  assistant narration only and `currentStep` is `execution.json`'s
  `current_step` (both); see
  [Jobs tab card stream](#jobs-tab-card-stream). Pf absent answers
  `{pfPresent:false,cards:null}`; a failed `pf --json ops status` answers
  `{pfPresent:true,cards:null,error}` (pf's own bounded stderr only). Unreadable
  daemon files, unknown/malformed wi ids and malformed cursors degrade per card
  (fields absent, `available:false`), never 5xx; GET only (other methods 405),
  `isApiRequestAllowed` re-checked in-route (403 is the only non-2xx).
- `GET /api/polyforge/progress?wi=<wi_id>` → 200 `{available,
  entries:[{id, kind:"narration"|"tool", text}]}` — the selected job's
  execution progress: the current step's newest transcript tail (newest 50
  entries within 32 KiB of entry JSON), read from the daemon's own files with
  no pf spawn; see [Job detail layout and execution progress](#job-detail-layout-and-execution-progress).
  A `wi` that is not the daemon's `wi_…` id shape answers 400 before any file
  read; a shape-valid `wi` with no job in the daemon's `runtime-state.json`
  answers 400 `{error:"unknown work item"}` before any transcript read. A
  missing, outside-root, unreadable or partially written transcript (or a job
  record without a capsule) answers 200 `{available:false, entries:[]}` —
  never 5xx, no response names a path. GET only (other methods 405),
  `isApiRequestAllowed` re-checked in-route (403); the two 400s and the 403
  are the only non-2xx answers.
- `GET /api/polyforge/config?cwd=…` → 200
  `{pfPresent, pfVersion, capable, reason?, file?:{sha256,exists},
  items:[{key,value?,set?,source?,class,schema?,daemon?,stale_reason?}],
  mapped, daemonReachable?, reload?:{pending,overridden,maxConfigured?},
  summarize?, steps?, steps_complete?}`. Every fact comes from
  `pf --json config list`,
  `pf --json config workspace --cwd …` and `pf --json ops status`; an unknown
  class passes through verbatim, and a summarize item's `class` comes from
  pf's workspace read (never a UI copy). `daemonReachable:false` means the ops
  read failed. Capability is the `2.20.6` floor AND the list
  shape (`file.sha256` plus `class` on every item); below it the read is still
  200 with `capable:false` and a visible `reason`, and no workspace/write verb
  is spawned. api_key always carries set/unset only. adds, from
  the same workspace read: each `steps[]` entry's `source` (`file` |
  `default`), `class` (`live`) and `attrs` (`{<name>: {value?, declared,
  source, class, default?, schema?}}` — every attr an installed bundle
  declares for the step id plus every override the file declares), the
  unconditional `default` and `task` entries of every mapped project, and
  `memoryPolicy` (`{source, class, appendToDefault, default:{record, skip,
  declared}, projects:{<project>:{record, skip, declared}}}` — each project's
  OWN declared lists, never pre-merged; read-only).
- `POST /api/polyforge/config` the only write entry point.
  JSON body `{action:"set"|"unset", key, value?, cwd?, expect_state?}`; the
  exact writable allowlist is `max_concurrent_jobs`, `step_timeout`,
  `stall_window`, `summarize.models`, `summarize.language`,
  `summarize.interval_sec`, `api_key`. Every mutation is a `pf config set|unset`
  spawn; api_key goes on stdin only, never argv, and is never echoed in a
  response, error, log or history entry. pi-web writes neither config file.
  `expect_state` is the read snapshot `{file_sha256, values}`, so a refusal is
  a key-level diff. The result message names the key's reload class: a
  restart-only key says the value applies after a daemon restart, a down
  daemon says the next start. pf's CORE-409 refusal carries the key-level diff;
  the route returns it as a 4xx, never 5xx.
 extends the allowlist with the workspace step keys
  `steps.<project>.<step-id>.models` (a JSON list of candidates; the form's
  guard only checks non-empty strings — the candidate format is pf's
  judgment, pi-web carries no candidate validator) and
  `steps.<project>.<step-id>.attrs.<name>` (an integer ≥ 0, the one attr kind
  the panel edits): `parseStepWriteKey` / `stepValueError` in
  `lib/polyforge-config-schema.ts` are that one fact for the form and the
  route. They are workspace writes (`--cwd`, the yaml sha as CAS, the history
  keyed by the resolved workspace, rollback through the same path, a clear is
  `unset`). Their capability gate adds the card's `2.20.15` floor and the
  running daemon's own fact — `write_capable` of `pf --json workflows --cwd`
  — and refuses with `write_reason` (naming the floor) before any write
  spawn; pf's own `CORE-501` refusal is the same fact on the CLI side.
- `GET /api/polyforge/workflows?cwd=…` → 200
  `{pfPresent, pfVersion, capable, reason?, workflows: <pf workflows doc> | null,
  workspace: <declared values> | null}` — the Settings › Polyforge workflow
  card's read, assembled by `readPolyforgeWorkflows(cwd)` in
  `lib/polyforge-workflows.ts`: `pf --json workflows --cwd` (bundles, their
  steps in declared order with `model_candidates`, declared `attrs` and each
  mapped project's `effective` chain + `from`, `defaults.effective`, `task`,
  `bundle_errors`, `daemon_reachable`, `write_capable`/`write_reason`) and
  `pf --json config workspace --cwd` (the declared chains and attr overrides —
  the one declared-value source), both spawned afresh on every call: there is
  no module cache, so each ↻ click is a fresh read of the installed bundle
  files. The sanitizers (`sanitizeWorkflowsDoc`, `sanitizeWorkflowWorkspace`)
  keep only the documented fields. Floor:
  `POLYFORGE_WORKFLOW_CARD_MINIMUM_PF_VERSION = "2.20.15"` (the configuration
  panel's 2.20.6 floor is unchanged); below it, or with pf absent, the answer
  is `capable:false` with a visible `reason` and no read verb is spawned. A
  failed or undecodable read, an unreachable daemon (`daemon_reachable:false`)
  or a workflows-dir reason is the `reason` field — never 5xx. GET only (POST
  and every other method 405), `isApiRequestAllowed` re-checked in-route (403
  the only non-2xx). Step-chain and attr writes do not go here: they reuse
  `POST /api/polyforge/config`.
- `POST /api/polyforge/config/reload` `pf config reload` then
  an independent `pf --json ops status` read, so the response carries the
  daemon's own newly loaded values.
- `GET|POST /api/polyforge/config/history` the bounded
  (50-entry) panel history at `<agentDir>/polyforge-config-history.json`
  (mode 0600, newest first). POST is rollback: a fresh read, then the same CAS
  write path, recorded as a new entry; a workspace entry rolls back into its
  own resolved workspace (never the panel's current cwd) and a null old value
  rolls back to `unset`. api_key entries are `rollbackable:false`
  and store set/unset only.
- The panel these routes feed (`components/PolyforgeConfig.tsx`, styled in
  `app/settings.css`; layout in [settings-ui.md](settings-ui.md)): at ≤ 640px a
  config row puts the key and its class badge on one line (badge at the right
  end,) with the file value and the daemon value spanning the
  row below; the 640px breakpoint and the wider shared-column layout are
  unchanged.
  the summarize keys, the `[workspace]` mapping and the read-only
  `memory_policy` (from the config read's `memoryPolicy`) render as ONE
  工作区 / Workspace card, each row tagged with its source file (`cli.toml` /
  `.polyforge.yaml`) and keeping its own write path (mapping: cli.toml through
  pf; summarize: the yaml writer; memory_policy: none); the legend and the
  grid header of every card sit above its fold, so collapsing hides rows only.
  The read-only declared-candidates card and its disclosure region are gone —
  the workflow card ([below](#workflow-card)) carries those facts.
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
- There is no 5xx path on the read routes, every failure answers decodable
  JSON, and every new `app/api/polyforge/config*` route re-checks
  `isApiRequestAllowed` in-route (`lib/request-security.ts`), answering 403
  JSON on refusal. The writes are JSON-only POSTs. Reachability: they are
  available only under the authenticated pi-web surface (the proxy still
  enforces `PI_WEB_PASSWORD` when set).
- `GET /api/sessions/[id]/chat-id` (pi#121) → 200 `{chatId: string | null}`.
  Every absent case — pf absent, daemon unreachable, a bad token shape, a
  timeout, or a session this server never started or attached — answers
  `200 {chatId: null}`, never 4xx/5xx and never error text: the id feeds a
  cosmetic tab-label suffix, and any non-2xx fetch logs a browser console
  error that fails the e2e suite. The only non-2xx path is the same in-route
  `isApiRequestAllowed` 403. The id is shape-validated
  (`isChatIdToken`, `lib/session-chat-id.ts`) before it can reach a response;
  pf's stderr never does.

## Work tab

The dock's top-level tab strip (`role="tablist" data-pf-tabstrip="top"`)
reads, in DOM order, Work | Memory | Messages (工单 | 记忆 | 消息; zh-TW 工單;
order by owner 2026-10-30,);
the Messages unread dot stays its own element beside the Messages label and
the Work tab carries no count. The former Jobs and Tasks tabs are Work's
first two sub-tabs (作业/任务 in zh-CN, 作業/任務 in zh-TW, so the workflow jobs
and the one-shot tasks read apart from pi's own background-tasks surface),
followed by the read-only work item list (工单列表 / 工單列表 /
Work items, `polyforge.work.itemsTab`) — order 作业, 任务, 工单列表 — in their
own tablist (`data-pf-tabstrip="work"`) placed after the main area in the
DOM, beside it on the right in one `flex-direction: row` container at every
width (`aria-orientation="vertical"`): on desktop (viewport ≥ 641px,
`useIsMobile`, whatever the dock width) a ~72px text rail (`flex: 0 0 72px`,
`border-left`, the active one on `var(--bg-selected)` with an accent edge,
visible label with the badge under it); at ≤ 640px (replacing
the three-segment bar above the main area) a 40px icon rail
(`flex: 0 0 40px`, the same left border and accent edge) of ~40×40
icon-only buttons — a 16px stroke icon in the panel's 24-viewBox style
(`WORK_TAB_ICONS`, `aria-hidden`) with the running badge under it, each
button named by its existing tab copy (`aria-label` and `title` =
`polyforge.messages.jobsTab` / `polyforge.tasks.tab` /
`polyforge.work.itemsTab`). Because the rail stays the main area's next
sibling at both widths, switching a sub-tab never remounts the main area,
which renders the selected surface alone — the Jobs card stream with its
detail, `PolyforgeTasks`, or `PolyforgeWorkItems`.

**Badges.** Jobs and Tasks carry their running count from the one status
snapshot the existing 3 s/30 s status poll already reads — `queue.running` on
Jobs, `tasks.running` on Tasks (see the status route contract); no timer, no
task-list read. 工单列表 carries the count of `status ===
"running"` rows of its last list read (`workItemsRunning` in the hook): absent
until the first read in the page session, then kept — also while the surface
is unmounted — until the next list answer; it costs no read of its own. A
count of 0 stays visible in `var(--text-dim)` (a non-zero count is
`var(--accent)`); with no snapshot (daemon down) the Jobs/Tasks badges do not
render. The badge's accessible name is `polyforge.work.jobsRunning` /
`polyforge.work.tasksRunning` / `polyforge.work.itemsRunning`. The top-level
Work tab has no badge.

State: `usePolyforge` holds `activeTab` (`PolyforgeTab = "memory" |
"messages" | "work"`, default `"work"`), `workTab` (`PolyforgeWorkTab =
"jobs" | "tasks" | "items"`, default `"jobs"`) and `workItemsRunning`
(`number | null`,). The hook outlives the dock, so a
close/reopen keeps the sub-tab and the items badge; a reload resets all
three; nothing is written to storage. `openAnchor` (the Messages and Memory
work-item links) sets Work › Jobs and the selection — never 工单列表. The
cards poll is gated on `activeTab === "work" && workTab === "jobs"`; the
Tasks and work-item surfaces read only while they are mounted.

## Messages tab (layout redone in)

The Messages tab is the human
inbox, laid out like Slack: the contact list is a right-hand column (never
shrinking, flush with the panel's right edge) carrying the 单聊 and 群聊
sections (each always rendered, with its empty placeholder; any non-`direct`
kind is a group). On desktop its left divider is also a resize separator
: `role="separator"`, focusable, `aria-valuemin`/`max`/`now`,
dragged like the dock handle (left widens the list, right narrows it), with
the hook's arrows (±12, Shift ±32), Home/End and Enter/double-click reset. Its
width is bounded to 120px…min(480px, panel−200px) — the chat pane keeps at
least 200px, also after a dock drag — and defaults to the old 35% clamp
(120–220px), so a user who never drags sees today's width. A drag or key
commit stores the integer px globally under
`pi-web:polyforge-messages-list-width`; `persistClamp: false` means a dock
narrowed below the stored width only shrinks what is shown, and the list grows
back to the stored width when the dock widens (the surface also refits on its
own `ResizeObserver`, not just the window resize). The separator is absent on
mobile. The 单聊 area is one
flat list (`directRows`): the direct conversation rows first,
in their current order with their unread badges, then the **silent
contacts** — configured contacts (`contacts`) with no direct conversation —
sorted by display name, one row per peer (a contact that already has a
direct conversation adds no second row). Its empty placeholder shows only
when both are empty; 群聊 is unchanged. Rows carry an initial-plus-colour
avatar (FNV-1a hash of the peer or contact id — the hash input is never
rendered as text) and the ellipsized display name. There is **no compose
entry of its own**: no ＋新消息, no recipient picker, no typed-user-id field
(ruling 5 removed them) — a contact row is the whole gesture. To its left
sits the bubble stream pane: the open conversation's header shows the
peer's avatar and display name, own bubbles
are right-aligned with no name and no avatar, peer bubbles are left-aligned
with the avatar and name only on the first message of a consecutive run, and
every bubble keeps its timestamp (HH:MM from `created_at`), work-item
anchor and reply quote. Every identity surface renders the display name or
the 未知用户 placeholder with a ? avatar — a raw user id is never rendered,
titled or labelled anywhere. An absent or empty `peer_name` (the old-aihub
transient included) or a blank contact `display_name` is the placeholder,
never an id fallback. With nothing
open the left pane shows 选择一个会话 and acks nothing; the click on a
conversation row is the opening and acknowledgment gesture. Clicking a
silent contact (`selectContact`, its own `selectedContact` state, never a
fake conversation id) opens an empty pane with the contact's header and
avatar: no history read, no conversation created, nothing acknowledged. Its
first send addresses the contact's id; the send's own answer names the
conversation it started (`conversation_id` on the returned message), which
opens and replaces the contact selection, so the open never races the list
read; a refused send restores the draft and shows pf's 4xx text. When the
peer writes first instead, the open empty pane follows: once
the list read (the same 3 s open / 30 s closed poll, no new timer or request)
carries a direct conversation whose peer is the open contact
(`conversationForContact`), the pane opens that conversation through
`selectConversation`, as a row click would — no click needed, nothing lost
(the empty pane had no history). At every width — the ≤640px sheet
included (replacing the earlier one-view-at-a-time mobile
switch) — the same component keeps both panes side by side. On the mobile
sheet the list column stays the fixed `clamp(120px, 35%, 220px)` with its
left divider and no resize handle (about 131px at a 375px sheet, the 120px
floor at 320px;); the chat pane sits beside it, shows
选择一个会话 (`polyforge.messages.select`) while nothing is open — nothing is
auto-opened — and carries the ← back control that closes the open conversation
or contact. Inside an open conversation the
recipient is that conversation's peer (no recipient field at all — the
header names the peer), so a reply needs no typed user id.

**Project groups.** Between the 单聊 area and 群聊 the list
shows one group per project of the `cli.toml` `[workspace."<path>"]` mapping
(the same mapping `pf msg contacts` is built from; every section's
comma-separated list, trimmed, deduplicated, ordered by name; a project that is
not mapped makes no group, and no mapping renders today's list unchanged). A
group lists every human contact of that project — people who already have a
direct conversation included — by display name (blank names last); a person
in several mapped projects appears once in each group. A contact shown in any
group is no longer repeated as a silent row of the 单聊 area
(`contactsOutsideGroups`), while the direct **conversation** rows stay there
in their order with their unread badges; group rows carry **no unread badge**,
so unread is never counted twice. Each group's header is a button (project
name and contact count, `aria-expanded`/`aria-controls`) that folds it; groups
start expanded. The count is the group's contact count whether or not it is
folded, and follows an add or removal through the re-read. An empty mapped
project keeps its group with an explicit placeholder (该项目暂无联系人,
`data-empty-group`); a project whose own members read failed shows its failure
note with pf's text in that group only, and the other groups and the
conversations render normally. Clicking a group row opens that contact's
existing direct conversation (`conversationForContact`) or, when there is
none, the same empty contact pane a silent row opens — no conversation is
created and nothing is acknowledged. The groups, folding, notices, picker and
remove controls work the same in the ≤640px sheet; the #222 list width and the
mobile clamp with no handle are untouched.

**Collapse state.** The folded projects are stored in this browser under
`pi-web:polyforge-messages-collapsed` (`lib/polyforge-messages-collapse.ts`,
read through `hooks/usePolyforgeMessagesCollapse.ts`; the component and
`usePolyforge` never touch storage), following the #212 disclosure paradigm
with its own key: a JSON array of collapsed project names. An absent, blocked,
unreadable, corrupt or wrong-typed value reads as "all expanded"; a write is
guarded and merge-preserving (names of projects no longer mapped stay stored
and are ignored, since the list only asks about the groups it renders); a
write storage refuses still folds the group for the page session; a change
event plus `storage` keep the open page in step. It survives a reload; there
is no server copy and no cross-device sync.

**Membership management.** The admin probe is the users read
(`GET /api/polyforge/users`, one `pf --json users list`, admin-only in aihub):
`usePolyforge` reads it each time the open dock shows Messages — never at page
load or on another tab, so no other tab sees a new route or pf verb (not gated
on the presence probe: the route spawns nothing without pf); no timer. Only an answered read (`admin: true`) enables management;
any refusal, an unreachable pf or pf below the floor leaves every group
read-only with an explicit notice (管理项目成员需要管理员权限，当前分组为只读。),
and nothing renders while the answer is unknown. For an admin each group that
read its members gets an add control (+, labelled with the project), opening a
picker of the users read's humans that are not already in that group (machines
never arrive; the caller is dropped server-side, since re-adding it would
rewrite its own role), by display name or 未知用户; there is no role choice —
add is always `writer`. Each group row gets a remove control (×, labelled with
the display name and the project). Both go through one `window.confirm` naming
the project and the display name (or 未知用户); cancelling sends nothing. A
confirmed change POSTs once; on success the hook awaits a fresh list read
before resolving, so the group shows the change without waiting for the next
poll (no optimistic change). A refusal shows pf's text inline in that group
and leaves the displayed membership unchanged. Removing a member changes
project membership only: the direct conversation, its history and later sends
are untouched.

Files:
`lib/polyforge-messages.ts` (pf transport, argv validation,
sanitizers, capability floor, the grouping read, the users read and the
membership write), `lib/polyforge-messages-pure.ts` (client-safe
types, page merges, `ackDecision`, `splitAnchor`, the name/avatar/section
helpers, `directRows`, the flat direct area's row sequence,
`conversationForContact`, `buildProjectGroups` and `contactsOutsideGroups`),
`lib/polyforge-messages-collapse.ts` + `hooks/usePolyforgeMessagesCollapse.ts`
(the collapse key),
`app/api/polyforge/messages/**` (the four routes),
`app/api/polyforge/users/route.ts`, `app/api/polyforge/projects/members/route.ts`,
`components/PolyforgeMessages.tsx`.

**Routes** (all re-check `isApiRequestAllowed` in-route; every read answers
200 JSON, every write is a JSON-only POST):

- `GET /api/polyforge/messages` → 200
  `{pfPresent, pfVersion, capable, reason?, error?, conversations:[{id,kind,peer?,peer_name?,last_seq,unread,created_at}], contacts:[{id,display_name}], groups:[{project, contacts:[{id,display_name}], error?}]}`.
  Every branch carries both `contacts` and `groups`, except `?groups=0`: the
  hook's reads while the dock is closed or on another tab ask for no groups,
  so no `pf projects get` is spawned and `groups` is omitted from a capable
  answer (the pf-absent and below-floor answers still carry `groups:[]`; the
  hook ignores the field on such a read, and the landed groups stay until the
  next read made while Messages is shown). pf absent answers
  `{pfPresent:false,capable:false,conversations:[],contacts:[],groups:[]}`; below
  the floor `{pfPresent:true,pfVersion,capable:false,reason}` and **no
  message, contact or project verb is spawned**. `groups`
  comes from the same `pf --json config list` read that supplies the caller's
  id (its `[workspace."<path>"]` items are the mapping) plus one
  `pf --json projects get <project>` per mapped project, started the moment
  that read lands, concurrently with the contact and list reads, each bounded
  at the same 2 s `CONTACT_READ_TIMEOUT_MS` and never rejecting. Only the
  members' user ids are kept (roles and every other field are dropped
  server-side) and joined by id with the contact set, so machine members and
  the caller (absent from `pf msg contacts`) never enter a group and names
  come from the contacts. A project's failed or timed-out read is that
  group's own `error` (pf's text, capped) with `contacts:[]`; an unreadable
  mapping or a failed contact read answers `groups:[]` (no group over an
  unknown contact set). `contacts` comes from
  one independent `pf --json msg contacts` spawn started beside the list
  reads and bounded at 2 s (`CONTACT_READ_TIMEOUT_MS`,): the
  answer awaits it, so the list answer's latency is bounded by the slower of
  the list reads and that 2 s, never by a slow contact read; at the bound the
  poll answers `contacts:[]`. pf assembles it from the `cli.toml` `[workspace.*]` mapping at call
  time (the union of the caller's human co-members over every mapped
  project, deduplicated by user id; self and machine users are dropped by
  aihub, never re-classified here). A contact-read failure answers
  `contacts:[]` and leaves `capable`, `reason`, `error` and the conversation
  rows untouched; a list-read failure keeps the contact read's answer. All other list-read failures (a missing
  `user_id`, AUTH-401, an unreachable aihub or daemon) answer
  `{capable:true,error,conversations:[]}`: `capable:false` is reserved for pf
  absent or below the floor, so a poll blip never shows a false upgrade
  notice and an open conversation stays on screen. The server reads the
  caller's own id once from `pf --json config list` (`user_id`), drops every
  conversation it is not a member of, derives `peer` from `members`, takes
  `peer_name` from exactly the peer's own `member_names` key (only the
  peer's name, never the caller's), and drops both raw fields before the
  response: one list spawn, no per-conversation preview fan-out.
- `GET /api/polyforge/messages/[id][?before=<seq>|?after=<seq>]` → 200
  `{capable, messages:[{id,seq,text,about_wi?,reply_to?,created_at,mine,conversation_id?}], last_seq, has_older}`.
  `conversation_id?` is the message's own conversation, kept whenever the
  sanitized message carries it (the send's answer relies on it to open the
  conversation it landed in). No
  cursor asks for the newest page (`--before` above the newest, 50 rows);
  `before` is scroll-up (the page just below that sequence); `after` is the
  open conversation's forward refresh on the 3 s tick. `has_older` is true
  only when the page was full (aihub's `seq` is a global AUTOINCREMENT, so
  `seq == 1` is not an end-of-history signal). `mine` is derived from
  `sender_id` and the server-side pf user id; `sender_id` never leaves.
- `POST /api/polyforge/messages/ack` — `{conversation_id, seq}`; advances the
  caller's read cursor only. A non-positive/malformed seq is a 400 before any
  spawn; pf's typed refusal (past the newest = CORE-400, unknown conversation
  = CORE-404, non-member = AUTH-403) is its own 4xx. The response carries
  `{error}` only: there is no invented error-code field. pf runs with `--json`,
  so its stderr envelope `{code, detail}` (or plain `CODE: text`) is decoded
  and only `detail` reaches the panel.
- `POST /api/polyforge/messages/analyze` — `{message_id}`; one read-only
  `pf --json msg analyze` read. The conclusion exists only in the response
  and in component state; DAEMON-409 is a 409, DAEMON-500/unavailable is a
  200 `{error}` (this repo has no 5xx route path). The analyzer spawn waits
  at least five minutes (the ruling; a real one-shot is an LLM call).
- `GET /api/polyforge/users` → 200
  `{pfPresent, pfVersion, capable, reason?, admin, users:[{id,display_name}], error?}`.
  The admin probe and the membership picker's data: behind the Messages floor
  (below it nothing is spawned and `admin:false`), one `pf --json users list`
  (15 s read bound) and, concurrently, the caller's id from
  `pf --json config list`. Only `user_type: "human"` rows survive, each
  projected to exactly id + trimmed display name — no email, role,
  `user_type`, `api_tokens` or machine user reaches the browser — and the
  caller is dropped. `admin` is true only when `pf users list` answered; a
  refusal (non-admin, AUTH-403) or an unreachable pf is
  `{admin:false, users:[], error}` at 200. The in-route gate's 403 is the only
  non-200; there is no POST.
- `POST /api/polyforge/projects/members` JSON-only
  `{action: "add" | "remove", project, user_id}`; the one browser-reachable
  membership write, for the authenticated surface only (in-route gate 403,
  non-JSON 415). Before any membership spawn: an unparsable body is 400, pf
  below the floor is 400 with its reason, then the mapping is read
  (`pf --json config list`) and the body validated — the action, the project
  trimmed and exactly one mapped name, the user id shape — a refusal is 400.
  Then exactly one `pf --json projects members add <project> --user <id> --role writer`
  or `pf --json projects members remove <project> --user <id>` (15 s write
  bound). Success is `{ok:true}`; pf's typed refusal maps through
  `messageErrorStatus` to its 4xx with pf's text; DAEMON-500, an untyped or
  unreachable pf (and an unreadable mapping) answer 200 `{error}` — never 5xx.
  pi-web writes no config file and never calls aihub directly; nothing is
  logged.

**Capability floor.** `POLYFORGE_MESSAGES_MINIMUM_PF_VERSION = "2.20.12"` in
`lib/polyforge-messages.ts` (the release shipping `pf msg contacts`,
), checked with `probePolyforgeVersion` +
`isPolyforgeVersionBelowMinimum`. Below it the panel renders a visible
"pf upgrade required" state with the reason and spawns no message, contact,
`projects get`, `users list` or `projects members` verb; there is no read-only or conversation-only fallback, and at or above it
there is no separate "contacts unavailable" path. pf absent keeps the dock's existing degradation.

**Cadence.** Messages ride the dock's existing timers — 3 s while the panel is
open, 30 s while closed; the contacts and the project groups ride the same
list read (the groups only on reads made while the open dock shows Messages,
which also reads at once when Messages is shown or left); the users read runs
only when the open dock shows Messages — and the open
conversation refreshes on the 3 s tick with one forward `?after=` read. No new interval, websocket or push channel.

**Acknowledgment discipline.** One pure helper (`ackDecision`) makes the
decision: automatic ack only while the panel is open, Messages is the active
tab, a conversation is open and no local job has `status === "needs_input"`;
the acknowledged sequence is always the **newest displayed** one and never a
sequence already acked (an optimistic per-conversation stamp suppresses
duplicates). An explicit gesture (message click, scroll-to-bottom) acks the
newest displayed sequence even with a blocked job; a programmatic scroll is
never an explicit gesture (only wheel/touch/pointer/key input or a message
click is). Opening a hidden conversation never acks, and auto-tab-switch is
suppressed while blocked. Opening a conversation always positions the
history at the bottom — on selection change and on the first page load, even
while a local job is blocked; the blocked state suppresses only the
**arrival** scroll-to-bottom write, so no programmatic `onScroll` can turn
into an ack.

**Anchors and analysis.** `splitAnchor` makes only the work-item prefix
(`task-42`, `proj#12`, `wi_…`) clickable; the rest of a deep reference
renders as text and is never fetched. Clicking it switches to Jobs and runs
the existing watch read for that ref. The analyzer control renders only when
the sanitized message says `mine: false`; its conclusion is component state,
dropped when the dock closes, never written to storage or disk. Incoming
messages never enter a chat session, an agent turn or the composer.

**Sanitization.** The sanitizers are the only passport: a conversation keeps
id/kind/peer/peer_name/last_seq/unread/created_at, a contact keeps exactly
id/display_name (a valid user id — the send address, never rendered — and the
trimmed name, `""` when absent), a project group keeps its project name and
contacts of that same shape (plus its own `error`), a picker user keeps
exactly id/display_name of a human user, a message keeps
id/seq/text/about_wi/reply_to/created_at/mine plus its own optional
`conversation_id` (a conversation id, not an identity — the send's answer
carries it so its client can open the conversation the message landed in).
`sender_id`, `members` and any
unknown wire field are dropped; `peer_name` is read from exactly the peer's
own `member_names` key — only the peer's name ever leaves, never the
caller's; no route response, error, log line or history
entry carries the pf user id, api key, server address, an environment value
or another identity's unread state. pf's stderr is the only error text and is
capped at 512 chars; the routes never `console.*` a request or response body.

## Memory tab (browse mode)

Browse-or-search, then view, pull-only. `lib/polyforge-memory-pure.ts` is the
client-safe model (wire types incl. the browse page `PolyforgeMemoryPage`
`{items, total, next_cursor?}`, the six type filters, page size 20, result
limit 200, browse page size 20, collapse threshold 2000, validators,
newest-first sort, page slicer, `mergeMemoryPages` — the next browse page
appended in order, ids already shown skipped — the UTF-8 cap `capUtf8Bytes`
shared with the Tasks server, truncation test); `lib/polyforge-memory.ts` is
the server module;
`components/PolyforgeMemory.tsx` owns its state — no hook read, no timer, no
storage. Fetches: the scope read when the tab first renders; then, once the
scope is mapped and capable with a project selected, the current mode's first
read — browse page 1 by default (there is no "enter a keyword" state), the
keyword search after a non-empty submit; the same read again on a project,
type or tags change (a half-typed, invalid tag list reads nothing) and on every
submit (an empty submit returns to browse with the same project and filters);
"load more" for the next browse page; the single-memory read on selection.
Browse mode shows the project total and appends each next page after the rows
already shown (`mergeMemoryPages`, the list container stays mounted, so no
scroll jump); keyword mode is the #99 read unchanged — one 200-row answer,
newest-first, 20-row client pages, the narrowing notice at 200. Only the newest
list read lands (a sequence guard, like the detail reads). The `any` checkbox
applies at the next submit. An unmapped cwd or a below-floor pf issues no list
read. Back restores the list, page and filters from component state without
re-fetching.

**Routes.** `GET /api/polyforge/memory?cwd=…` is three faces: without `q`
and without `project` it is the SCOPE read (capability plus the cwd's
workspace projects, empty hit list, no memory verb); without `q` but with a
`project` (optional `type`, `tags`, `after`) it is one BROWSE page: exactly
one `pf --json recall --project <p> --limit 20 --sort updated [--after <c>]
[--tags …] [--type …]` with no query, answered as `hits`, `total` and, while
more entries remain, `next_cursor`; with `q` (plus `project`, `type`,
optional `tags`, optional `any=1`) it is the keyword SEARCH: exactly one
`pf --json recall --project <p> --limit 200 [<flags>] <q>` (`--type` is sent
only for the five non-`*` values in both modes).
`GET /api/polyforge/memory/[id]` is the single-memory read: one
`pf --json memory show <id>`. Both answer 200 JSON on every failure (pf
absent → `pfPresent:false`, below the floor → `capable:false` + reason, a
failed spawn → `error` with pf's own bounded stderr); the only non-2xx
answers are the in-route `isApiRequestAllowed` 403 and the 400s below.

**Validation order.** Shape validation (`validateMemorySearch`: a keyword
that is empty, starts with `-` or carries control bytes; `validateMemoryBrowse`:
a cursor that is empty, over 1024 bytes, starts with `-` or carries control
bytes — the cursor is opaque, never parsed or re-encoded; both: a project not
shaped like one, a type outside the six values, a bad tag list; on the show
route a malformed `mem_` id) answers 400 BEFORE any pf process, the version
probe included. Project MEMBERSHIP ("one of the projects the panel offered")
is judged against the same `pf config` read that fills the dropdown — that
read runs first and an off-list project answers 400 with no recall spawn,
but after the config read. Zero pf processes would need a per-cwd scope
cache, which the spec's non-goals forbid. An unmapped cwd answers 200 with
`mapped:false` and no recall.

**Passports.** A hit keeps exactly id/type/title/visibility/status/tags/
related/work_item_id/created_at/updated_at/content_len — the search and
browse responses carry no `content` or `content_excerpt`. A browse page adds a
finite non-negative `total` (the page length when pf's is missing or
malformed) and `next_cursor` only when it passes the cursor check. The detail adds `content`, cut to
at most 262144 UTF-8 bytes on a code-point boundary (`MEMORY_BODY_FORWARD_CAP`,
pf's own human-mode cap; `--json` is never capped by pf, so this cap is
ours). `owner_user_id`, `project_id`, `content_sha` and every unknown field
are dropped. There is no truncation wire field: the client compares the
body's UTF-8 byte length with `content_len` and shows the notice. The floor
is `POLYFORGE_MEMORY_MINIMUM_PF_VERSION = "2.20.12"` (the first pf whose
`recall` browses with no query, `--after`, `--sort`); below it every face
answers `capable:false` + reason, no memory verb is spawned and there is no
search-only fallback. pf's stderr is the only error text (capped at 512), and no
module or route calls `console.*` — a memory body never enters the log.

**Body collapse.** A body whose `content_len` exceeds 2000 renders inside a
CSS `maxHeight` clip with `overflow-y: hidden`; the markdown source is never
sliced, so fences, tables and links survive. Expanding removes the clip and
scrolls the body's end into view (the dock body is height-bounded, so
unclipping alone would leave the last lines below the fold); collapsing
restores the clip.

**References.** `work_item_id` leaves through the shell's existing
`openPfAnchor` (Work › Jobs + the existing watch read); a `related` id opens in
place through the same single-memory read; a null `work_item_id` renders no
link. `related` and the copy control use `lib/clipboard.ts` `copyText`.

**Project rule.** `readPolyforgeMemoryProjects(cwd)` is the config panel's
cwd→workspace rule in one place: `pf --json config workspace --cwd <cwd>`,
then the `[workspace."<name>"]` item of `pf --json config list`, split with
the shared `workspaceProjects` helper
(`components/polyforge-config-helpers.ts`). The config panel's own
sanitizer is untouched.

## Jobs tab card stream

Work › Jobs renders every `pf --json ops status` job as a compact
key-information card (`PolyforgeJobCard` in `components/PolyforgePanel.tsx`;
block layout, compact side-by-side cards), below
the unchanged queue line and above the selected detail.
(owner's intentional change, not a regression): the cards are ONE row that
scrolls left and right (`display: flex`, `flexWrap: nowrap`, the same gap 8
and padding 8) instead of a wrapping grid (`repeat(auto-fill, minmax(150px,
1fr))` until), and every card is a fixed 150px wide
(`JOB_CARD_WIDTH`, `flex: 0 0 150px`) — so the 460px dock, the 375px sheet
(beside its 40px icon rail) and the 340px dock all show one card row whose
cards keep their 150px width, a wider main area leaves free space at the
right and a narrower one scrolls rather than squeezes. The row is
`overflowX: auto` with `scrollbarWidth: "thin"` and a visible scrollbar (a
desktop mouse has no horizontal wheel, so a hidden bar would strand the cards
past the fold), native touch inertia and no scroll-snap; scrolled to the end
the last card is fully visible, nothing is vertically clipped or scrolled,
and the row scrolls whenever the cards exceed the main area (three 150px
cards plus the gaps already do at the 460px dock). The
cards keep their DOM order and their stable keys, so Tab order is unchanged,
focusing an off-screen card scrolls it into view natively, and the 3 s card
poll never resets the row's scroll position (no re-mount). The Tasks blocks
keep their grid;'s equal-width ruling now reads as the fixed
150px job card = the Tasks grid's 150px column minimum. Each card is in
`POLYFORGE_BLOCK_STYLE`
(`lib/panel-layout.ts`: no background, a `1px solid var(--border)` frame,
radius 6, padding `6px 8px` — the one block treatment the Tasks blocks share,
it was `8px 10px`, so the Tasks blocks are denser too); a
selected card is on `var(--bg-selected)`. pins the card's own
spacing: the outer column gap is 4, the title block's gap is 0 (was 2), the
slug row and the goal span are explicit 16px lines (`lineHeight: "16px"`, not
the inherited 18px), the needs-input badge is `padding 0 5px`,
`line-height 14px` (16px with its 1px border) against the dim status label's
16px, and the card overrides the shared block's vertical padding to `4px
8px` (left/right stay 8px; `POLYFORGE_BLOCK_STYLE` itself is untouched, so
the Tasks blocks keep `6px 8px`). A card with a goal is therefore 42px + its
title block (2 border + 8 padding + slug row + 32 goal): 58px with a one-line
slug, 74px with a two-line one.:
because a fixed 150px card leaves the slug row 85px beside the status label,
a 14-character slug wraps to two 16px lines in both locales, so
`e2e/polyforge-cards.mjs` S18 states the height bound against the measured
slug row — at most `43px + the slug row` (58px for a one-line slug, 74px for
the wrapped two-line row measured at the 460px and 340px docks; the old
100px/117px card fails it, and so does one that only removed the narration:
64px/80px) — and checks the
one-row /
150px-width / horizontally scrollable layout at the 460px dock, the 375px
sheet and the 340px dock. A card click (or Enter/Space) toggles the existing
slug selection, so the detail, the watch poll and pi#120's deselect behave as
before; a second click deselects. A work-item anchor selects by wi id, and a
card counts as selected for either its slug or its wi id.

- **Title:** one row with the slug on the left (`flex: 1 1 0`,
  `overflowWrap: "anywhere"`: a long slug wraps, never clipped) and the small
  localized status label at its right end (`paused` included; `flex: 0 1
  auto`, at most 60% of the row, ellipsized before it squeezes the slug;
 — it was a row of its own), then the work item's goal under
  them truncated to the title-length preference in code points with `…`
  (clamped to at most 2 lines, the full goal in the goal span's `title`).
  Never a nowrap slug + goal row: in a ~112px cell that squeezed the slug to a
  few characters and hid the goal ( review s14#2;
  `e2e/polyforge-cards.mjs` S18 checks the geometry, the fixed 150px width and
  the one-row horizontal scroll at 460/375/340). The
  model, `#spawnN`, step age and idle age left the card: the
  model (24 chars + `…`, full on hover), `#spawnN` and the two ages show in
  the job detail (a facts row below the detail's title row, DAG and
  execution progress — — from the status snapshot, so it shows
  even while the watch read loads). An unreadable work item renders the slug alone.
- **Needs-input marker:** a `needs_input` job shows its status
  label (`polyforge.jobStatus.needs_input`: 等待输入 / Needs input / 等待輸入)
  emphasized (`data-pf-needs-input`, amber `#d97706`, bold, framed) in place
  of the dim label at the right end of the slug's row (; it was a
  row of its own). It follows the job's status on the next status/cards read —
  no new request, poller or timer.
- **Running duration:** a `running` job's dim status label
  carries the job's age in whole minutes after it — `运行中 23m`, `running
  23m` — in the same element and colour (the `…m` suffix in every locale).
  `n = floor((now − card.startedAt) / 60s)`, the card's existing earliest
  `job_started`: the job's age, so it does not reset when the step changes and
  includes waiting time. Under a minute (and for a negative age from clock
  skew) it reads `0m`; at 60 minutes and beyond it stays in minutes (`125m`,
  never hours). No `startedAt` (including the status-only stand-in before the
  first card read) or an unparsable one keeps the bare label, and no other
  status gets a suffix. A 30s local render clock advances the value without a
  request or poll (the Tasks blocks' pattern); its `cardRunningMinutes` helper
  lives in `lib/polyforge-cards-pure.ts`.
- **No narration on the card (the owner's intentional reversal
  of the 32px narration):** the card holds only the
  slug/status row and the goal. The assistant narration stays visible in the
  job detail's execution progress and summary block (pi#119);
  `polyforge.card.noProgress` and `polyforge.card.progressUnavailable` are
  gone from all three locales. The cards read face still carries `progress`
  for the detail and the hook (see Whitelist), and the pipeline's retirement
  is a follow-up ticket.
- **No step information on the card:** no step names, step
  segments, durations, `×N` reruns or unstarted/unknown markers — the DAG and
  every step fact live in the job detail (see Step flow graph and the DAG
  timing line,). The cards read face still carries each card's `steps` (one entry per
  declared step in workflow order with its summed wall time over all runs,
  `runs`, and a state) and `currentStep`: a run opens at `step_started`
  and closes at the step's `step_done`/`step_failed`/`step_dead` or its next
  `step_started`; the current `in_progress` step's open run closes at the
  request's now (with no event, its `execution.json` `step_started_at` times
  it). A step with no readable start is `unstarted` when the execution record
  says `pending` (or has no entry), `skipped` when it says `skipped`, else
  `unknown`. In the job detail each graph node names its state in its
  `title`/`aria-label` (no visible status text), so `skipped`
  reads 已跳过 (Skipped / 已跳過) there and its dot is a hollow gray ring,
  never not-started or unknown. Never NaN or negative.

**Empty state.** With a status snapshot that lists no job the stream shows
`polyforge.empty` (暂无在跑作业 / No Polyforge jobs. / 目前沒有在跑作業) at once:
the stand-ins are the status jobs, so an empty stream before the first card
read already means "no jobs" — no `Loading…` flash. The zh
strings that called jobs 任务/工作 (`empty`, `deselect`, `selectJob`,
`eventKind.job_started`/`job_stopped`) now say 作业/作業.

**Order.** The server sorts (`sortPolyforgeCards`): ascending earliest
`job_started`, ties by wi id, cards without a readable start last by wi id. The
same files give the same order on every poll and after a reload; a new job
(later start) appends at the bottom. Once the first card read has landed, the
client renders the server order with `key={wi || slug}` and a memoized card, so
a poll updates the same DOM node. Before that read, the stand-in cards (see
Polling and preferences) follow `pf ops status` job order, so the first read
can reorder the list once. The keys stay the same, so no node is detached, and
a stand-in does not select, so a click during that reorder
cannot land on a neighbouring job.

**Daemon/capsule layout coupling (read-only, documented, may move with the
daemon).** Data root = `$POLYFORGE_DATA_DIR`, else `~/.local/share/polyforge`.
`lib/polyforge-cards.ts` reads: `runtime-state.json` `jobs[]` (`work_item_id`
→ `capsule_dir`); `events/wi-<wi>.jsonl` (whole up to 512 KiB,
else a 32 KiB head for `job_started` plus the newest 480 KiB); the capsule's
`capsule.json` `bundle_name` → `workflows/<bundle>/workflow.md` frontmatter
`steps[].id` (declared order; fallback: `execution.json` step keys by first
observed `step_started`, then the rest); `runtime-state/work-item.json`
`goal`; `runtime-state/execution.json` `current_step` and per-step
`status`/`step_started_at`; `runtime-state/spawn-journal.jsonl`'s newest line
(16 KiB tail) → the current step's `harness`, `step_id`, `started_at`,
`harness_session` and `transcript`. The transcript candidates, in order: the
harness's live file — pi: the newest `.jsonl` under
`step-agent-sessions/--<capsule path, separators → ->--/` unless that session
started before the step's `started_at` (then it is an earlier step's;
). A session is dated by its own start, never its last write — a
previous step's session can still be written after the next step starts: the
first record's `timestamp` (`{"type":"session",…}`), else the ISO timestamp in
its `<timestamp>_<uuid>.jsonl` name, else the file's mtime, with a 5 s
clock-skew allowance; claude: `claude-config/projects/<capsule path, non-alphanumerics →
->/<harness_session>.jsonl` — then the journal's `transcript` (the capsule's
`session/` copy, which the daemon completes only when the step ends: a pi copy
holds the prompt only, a claude one is absent while the step runs). The job
record's `transcript` is the job's first step and is never read. A candidate
must resolve (realpath) inside the capsule or the data root; an unknown
harness is `available:false`.

**Whitelist.** Only one entry kind is ever constructed:
assistant narration — the text blocks of pi `type:"message"` records and
claude `type:"assistant"` records with `message.role:"assistant"`, as
`{id, text}`. Tool calls (pi `toolCall`, claude `tool_use`: no name, command
or argument), tool results, thinking blocks, user/system records,
`api-request-blob` duplicates and every other field never become an entry, so
the response itself cannot carry tool activity (the guarantee holds at the
source, not in the client). Text is whitespace-collapsed, masked by the shared
`maskPolyforgeCredentials` (the `progress.command` rules — narration can
itself name a credential) and capped at 400 code points. A first-load window
with no record of the harness's format reads as `available:false`.
The job detail's execution progress is a separate, wider read
face over the same transcript resolution (`readProgressTail`,
`GET /api/polyforge/progress`): narration plus one masked tool-call line. The
card stream never uses it; its whitelist above is unchanged.

**Cursor and bounds.** A cursor is `c1.<16 hex identity>.<byte offset>`; the
identity hashes the resolved path, device, inode, harness and step, so a new
step, a replaced file or an offset past the end reads as a first load. The
client sends every card's cursor in the one request; the route keeps only
`wi_…` keys with values of that closed shape (anything else = no cursor), and
a cursor is never a path. First load: the newest 64 KiB of the transcript,
whole lines only, the newest 20 entries, `reset:true`. With a cursor: at most
64 KiB forward and at most 20 entries, the cursor stopping after the last whole
line consumed (a single line longer than the window is skipped). Per response:
at most 200 entries and 128 KiB of entry JSON across all cards; a card the
budget cannot serve gets no entries and keeps its cursor (none on a first
load). The client merges by entry id (a replay adds nothing), `reset` replaces,
and keeps the newest 200 entries per card.

**Polling and preferences.** One `GET /api/polyforge/cards` per tick, only
while the dock is open on Work › Jobs (`probed && pfPresent && panelOpen &&
activeTab === "work" && workTab === "jobs"`,), at the poll-interval preference (the cards route and
the status poll share one server-side `pf ops status` read — one spawn and one
snapshot for the queue line and the cards — only when the two polls fire within
the 1 s `OPS_STATUS_REUSE_MS` window, as they do when the dock opens on
Work › Jobs at the default 3 s; after a tab switch, or at another card interval,
the two timers can be out of phase and each read separately — see the Ops
transport line); an immediate read on
open, on returning to the tab and on an interval change; one request in
flight at a time (a busy tick is skipped). Each request is bounded at 15 s
(`CARD_REQUEST_TIMEOUT_MS`, `AbortController` + `setTimeout`, —
longer than the server's 10 s ops read): a request that never settles is
aborted, keeps the last cards and frees the slot, so the next tick retries.
A failed request or a `cards:null`
body keeps the last cards, order and lines (`nextCardSnapshot`); a successful
empty list shows the existing empty state. Before the first card read lands
(`cards === null`), each status-poll job renders as a stand-in card
(`statusOnlyCard` in `components/PolyforgePanel.tsx`). A stand-in shows the
slug and the status label (a `needs_input` job its 等待输入 marker row) from the
status poll, no goal, and an empty progress area, or the localized
"unavailable" state if the card read failed. It uses the same `key={wi || slug}`, so the real card
reuses its node. It carries no `data-pf-card`/`data-pf-card-wi`, so tests see
only real cards. It does not select: no click or key handler,
`aria-disabled`, and `pointer-events: none` (a pointer click falls through
until the real card replaces it), because the first card read may reorder the
stream once (see Order). With no status job to stand in, the empty state shows (see
Empty state); `Loading…`/`unavailable` show only without a status snapshot. Do not simplify this back to a `Loading…` list: the
first card read can be slow (`next dev` compiles the route on first use), and
the dock must show the running job at once (`e2e/polyforge-widget.mjs` S3).
The two preferences are
browser-only localStorage keys read through
`hooks/usePolyforgePanelPreferences.ts` (`useSyncExternalStore`, the server
snapshot is the default): `pi-web:polyforge-title-length` (default 60,
10–200 — raised it from 30 so a goal fills the two-line clamp;
a browser that stored 30 keeps 30) and `pi-web:polyforge-poll-interval` (seconds, default 3, 1–60).
Absent, corrupt, non-numeric or non-positive values read as the default; a
positive out-of-range value clamps. A save in Settings › Polyforge dispatches
`pi-web:polyforge-preferences` (and other tabs see `storage`), so the open
panel applies it without a reload. The status, watch and messages cadences
are unchanged; the Tasks and Memory tabs are untouched.

## Work items sub-tab

A read-only list of every `[workspace]`-mapped project's work items, with a
read-only detail. `lib/polyforge-work-items-pure.ts` is the client-safe model
(the row `PolyforgeWorkItemRow`, the detail `PolyforgeWorkItemDetail`,
`isPolyforgeWorkItemId` — `wi_` + alphanumerics —, the seven statuses
`POLYFORGE_WORK_ITEM_STATUSES` queued/running/paused/blocked/wrapped/failed/
canceled, `sortWorkItemsNewestFirst`, `workItemProjectOptions`,
`workItemsAtCap`, `filterWorkItemRows`, `workItemsRunningCount`);
`lib/polyforge-work-items.ts` is the server module.

**Routes.** `GET /api/polyforge/work-items` is exactly one merged
`pf --json queue` — no `--project`, `--status` or `--limit`, so pf answers
one `{items, total}` over every mapped project with its server default of the
latest 500 per project (`created_at DESC`) — answering
`{pfPresent, pfVersion, capable, reason?, items, total, error?}` with `items`
in pf's order (the client sorts) and `total` pf's total (else the sanitized
row count). `GET /api/polyforge/work-items/[id]` validates the id before any
probe or spawn (a malformed one answers 400), then makes exactly one
`pf --json file show <id>` and answers `{pfPresent, pfVersion, capable,
reason?, item, error?}`. Both spawn through `polyforgePfBin()` (`PF_BIN` else
bare `pf`; no direct aihub HTTP call), export GET only (any other method is
Next's 405), re-check `isApiRequestAllowed` in-route (403, no spawn), are
`force-dynamic`, and degrade with 200 — never 5xx, never `console.*`, no text
built from `process.env`. The list degrades as a whole: pf absent
(`pfPresent:false`), below the floor (`capable:false` + reason, no
queue/file verb spawned), one failing project (pf fails the whole verb), no
`[workspace]` mapping, a timeout (30 s), an answer over the 16 MiB buffer or
an undecodable document all answer `items: []`, `total: 0` and the reason
(pf's own stderr capped at 512, or a fixed text) — never a partial table.
The detail degrades to `item: null` the same way.

**Passports.** The sanitizers forward pf data verbatim (no trim, no
coercion). A list row keeps exactly `id, slug, project, status, priority,
bundle_name, goal, created_at`; a nullable field is null when pf sends null
or a wrong type; a row without a `wi_` id or a non-empty string slug is
omitted. A detail keeps exactly those plus `labels, milestone, reporter,
assignee, updated_at, closed_at, waiting_for, waiting_on, content,
content_len` (18 keys): `labels` keeps the string entries, `waiting_for` is
pf's derived list of unfinished blockers forwarded as `{slug, status}`
entries (null when absent), `waiting_on` the raw marker string, and
`content` is cut to `MEMORY_BODY_FORWARD_CAP` (262144) UTF-8 bytes on a
code-point boundary (`capUtf8Bytes`) with `content_len` the measured uncut
byte length. Content and the waiting facts never ride a list row; `attrs`,
`project_id`, `parent_id`, `seq`, `clean_pause`, `repo_inventory` and every
`session_*` field never leave the server.

**Surface.** `components/PolyforgeWorkItems.tsx` owns its list, filters,
search and detail state (no storage, no timer, no poll, no ↻ control, no
write control). It reads once when the sub-tab opens (the component mounts,
ref-guarded) and once more per change of `itemCountKey` while it stays
mounted: `PolyforgePanel` computes it with `workItemCountKey` as
`` `${queue.running}:${<completed|failed|cancelled jobs in jobs[]>}` `` from
the status snapshot (null without one); a ref holds the mount value, so
entering reads once, the mount value never re-reads and a null on either
side is no change; only the newest read writes. Every list answer reports
`workItemsRunningCount` to the hook for the badge. Nothing reads while Jobs,
Tasks, another tab or a closed dock is showing (unmounted); other machines'
changes appear on the next re-open or count-key change. The header shows the
total (`polyforge.workItems.total`) and, when one project contributed
exactly 500 rows (`workItemsAtCap`; 499 or 501 do not), the
`polyforge.workItems.capHint` (仅显示最近 500 条) with the capped project(s);
that project's filter option carries the same hint — inferred from the rows
already read, no extra read. Rows are globally newest first by `created_at`
(stable for equal instants, unparseable last) and every row renders in the
one scrolling list — no virtualisation, paging or list truncation (the real
merged list is about 1162 rows). Each row is one whole-row button showing
slug, the localized status (`polyforge.workItems.status.*`, unknown raw),
priority, bundle (`—` when null/empty), project and the goal clipped to one
line by CSS only. Above the list: a search box over slug/goal/project
(case-insensitive substring; content is never searched) and two selects —
status (`全部状态` + the seven statuses) and project (`全部项目` + the distinct
projects of the loaded list) — composed in the one `filterWorkItemRows`; a
change makes no request, and a reload resets them. Selecting a row makes one
detail read and replaces the list with the detail: the full goal
(unclipped), slug, status, priority, bundle, project, labels, milestone,
reporter, assignee, created/updated/closed, the waiting line
(`waiting_for` blockers when present, else `waiting_on`) and the content
through `MarkdownBody` with the Memory rules (collapsed over
`MEMORY_COLLAPSE_BYTES`, the `polyforge.workItems.truncated` notice when the
forwarded body is shorter than `content_len`; null content renders empty).
← 返回 restores the list with its filters and search and reads nothing.

**Floor.** `POLYFORGE_WORK_ITEMS_MINIMUM_PF_VERSION = "2.19.0"` (the earliest
tagged pf whose `queue` merges every mapped project without `--project` and
that carries `file show`), checked through the one 60 s-cached
`probePolyforgeVersion` + `isPolyforgeVersionBelowMinimum`.

## Tasks tab

A read-only view of every task of the local daemon (no project filter).
`lib/polyforge-tasks-pure.ts` is the client-safe model (the list row
`PolyforgeTaskRow` id/project/state/prompt_summary + the optional timing facts
and report_tail?/reporter?, the detail
`PolyforgeTaskDetail`, `isPolyforgeTaskId` — `task_` + 16 lowercase hex —
`splitTaskSections`: 正在运行 is exactly `state === "running"`, 全部 the rest,
both in pf's order, so every task is listed exactly once with the running ones
on top — `taskMatches`: a case-insensitive substring of the id,
project, state or prompt summary — and,, `taskReporterOptions`:
the distinct non-empty human `reporter` names of the whole list sorted
ascending plus whether any row is `TASK_REPORTER_MACHINE` (`machine`), with
`filterTaskRows`'s `reporter` term — `null`/absent matches every row, a value
an exact `row.reporter`); `lib/polyforge-tasks.ts` is the server
module.

**Routes.** `GET /api/polyforge/tasks` is one `pf --json task list`;
`GET /api/polyforge/tasks/[id]` is one `pf --json task show <id>`, the id
validated before any spawn (a malformed one answers 400). Both export GET
only — there is no spawn or cancel route or control, and any other method is
Next's 405 — re-check `isApiRequestAllowed` in-route (403), are
`force-dynamic`, and answer 200 JSON on every failure (pf absent →
`pfPresent:false`, below the floor → `capable:false` + reason with no task
verb spawned, a failed spawn → `error` with pf's own stderr capped at 512);
never 5xx, never `console.*`, no text built from `process.env`.

**Passports.** pf nests a task's spawn facts under `spec`; the sanitizers read
them only there. A list row keeps exactly
id/project/state/prompt_summary (pf ≥ 2.20.12's bounded first prompt line —
the list never carries the full prompt or the report) plus the three timing
facts started_at?/ended_at?/wall_consumed_ns? (; each absent when
pf has none — pf's zero time reads as absent, a non-numeric wall time is
dropped), so a block shows its duration without a detail read, plus
report_tail?/reporter? nine keys in all: `report_tail` is
pf's own bounded last non-empty report line (≤ 200 code points, an over-long
line already `…` + its last 199; `""` while running) forwarded exactly as sent,
never trimmed or re-cut, and `reporter` is the spawn-time human display name
or the sentinel `machine`; each travels only when pf sends a string (`""`
included), so a non-string value is absent, never coerced. Neither field
moves the floor: a 2.20.12 pf that lacks them still lists (its finished
blocks show 暂无报告 and the reporter filter offers only 全部发起人). The
unit pin, the routes source pin and e2e S13 name these nine keys (an owner-intended 2026-10-30
extension, not a relaxation). The detail passport is unchanged. A detail keeps
id/project/state/candidates/max_duration_ns/max_tokens/wall_consumed_ns/
tokens_consumed/created_at/started_at?/ended_at? (pf's zero time reads as
absent)/prompt/report/report_len/truncated; the report is cut to
`MEMORY_BODY_FORWARD_CAP` (262144) UTF-8 bytes on a code-point boundary with
the Memory tab's `capUtf8Bytes`, `report_len` is the measured uncut byte length (pf sends no such field), and
`truncated` is pf's own budget-cut flag. Error text, origin chat and delivery
marks never leave the server.

**Surface.** `components/PolyforgeTasks.tsx` owns its state (no hook read,
no poll, no storage) and reads on gestures only — one list read each time
the Tasks sub-tab opens (the component mounts), one per click of the search
row's ↻ button and one detail read per
selection; searching, clearing the search, filtering and going back read
nothing. The one automatic exception: `PolyforgePanel` passes
`taskCountKey` = the status snapshot's `` `${tasks.running}:${tasks.completed}` ``
(null without a snapshot), and while the sub-page stays mounted each change
of that key re-reads the list exactly once (a ref holds the mount value, so
entering the sub-tab still reads once; a null on either side is no change;
only the newest read writes). Nothing reads while Work › Jobs, another tab or
a closed dock is showing — the component is unmounted there. An empty list
shows `polyforge.tasks.empty` (暂无任务) plus `polyforge.tasks.emptyHint` (one
line: no one-shot task on this machine yet) instead of the two sections. It does NOT ride
the 3 s/30 s dock cadence: a background re-read under an open search would
change the list being searched, and the spec forbids a new cadence.

The manual refresh is the third list read: a 26px ↻ icon
button on the search box's own row, right of it (the box takes the remaining
width), with the sidebar refresh's icon; it renders in the list view only —
the 暂无任务 empty list included, but never on the detail or the loading,
not-installed, below-the-floor and first-read-failure notices. A click calls
the same `readList`, so it adds exactly one `GET /api/polyforge/tasks` read
and nothing else: no poll, no timer (a minimum spin duration included), no
storage, and the count-key re-read is unchanged. The button's busy state has
one source — the newest list read still in flight, whether the mount read, a
count change or the click started it: while it lasts the button is `disabled`,
`aria-busy="true"`, its icon carries `animate-spin`, and its title/aria-label
are `polyforge.refreshing` (Refreshing… / 正在刷新… / 重新整理中…, added to all
three locales; `polyforge.refresh` is the idle label). Disabled means a click
cannot stack a second read. Only the newest read (`listSeqRef`) clears the
state and writes the list or `listError` — the check and the writes are
paired — so a stale read that lands late, success or failure, neither ends the
spin nor overwrites newer data. A refresh in flight keeps the old list on
screen (never back to 加载中); a failed refresh keeps it too and shows the
bounded error above the list, and a success replaces the list and clears the
error. The search and the three filters are component state and are never
reset by a refresh.

The search
box filters both sections on the client (正在运行 above 全部), and so do two
selects below it: project — `polyforge.tasks.filterAllProjects`
(全部项目) then the distinct projects of the loaded list
(`taskProjectOptions`) — and state — 全部 / 运行中 / 已完成 / 已封顶 / 失败 / 中断
(`TASK_STATE_FILTERS`) — and,, reporter —
`polyforge.tasks.filterAllReporters` (全部发起人), the human display names
ascending, then `polyforge.tasks.reporterMachine` (机器发起, the `machine`
sentinel) last, each offered only when a row carries it; the options come
from the whole loaded list, never from the filtered rows, so no select
cascades into another. One pure `filterTaskRows` composes search, project,
state and reporter over the already-read rows: a change spawns no pf call and
no new read; the selections live in component memory only (no storage, URL,
hook or server field — a reload resets them to 全部); a list from a pf without
the field offers only 全部发起人; there is no model or time-range filter. Each section is
a responsive grid of discrete blocks (;:
`repeat(auto-fill, minmax(150px, 1fr))`, gap 8 — the one 150px
minimum the job cards share (was 112px); the Tasks grid stays
a grid while the job cards are one fixed-width row, so the shared number is
the grid's 150px column minimum = the job card's fixed 150px width rather
than an equal track count — so two blocks side by side at the 375px sheet
(beside its 40px rail) and the 460px dock, one per row at the 340px dock,
more as the main area widens — each in the shared
`POLYFORGE_BLOCK_STYLE`). A block is a button (the
whole block is the click/Enter/Space target; the id stays a secondary label
on its last line) showing a
state dot (`aria-hidden`; existing CSS variables only) and the localized
state text (`polyforge.tasks.state.*`, an unknown state raw), the duration,
the project and the prompt summary clipped to two lines
(`-webkit-line-clamp: 2`), then the report tail line directly
below the summary: a finished block's `report_tail` as plain text (React
escapes it, so Markdown stays literal) in `var(--text-muted)`, clipped to two
lines by CSS only (`-webkit-line-clamp: 2`, hidden overflow) — the client
never cuts it by code points or appends an ellipsis, pf's own leading `…`
stays. The placeholder is keyed on state, never on an empty tail: a running
block always shows the dim (`var(--text-dim)`) `polyforge.tasks.tailRunning`
(生成中…), even with a stale non-empty tail; any other block whose tail is
`""`, whitespace-only or absent (a pre-field pf) shows the dim
`polyforge.tasks.tailEmpty` (暂无报告), never an empty line. The tail rides the
one list read. Durations (`taskDurationSeconds`/`taskEndedAgo` in
`lib/polyforge-tasks-pure.ts`): a running task counts `now - started_at`; a
finished one shows `wall_consumed_ns` plus `polyforge.tasks.endedAgo` from
`ended_at`; an absent field renders `—`, never NaN. The running durations
tick on a local 1 s render clock (`setInterval` that only sets `now`, no
I/O) that exists only while a running task is listed and is cleared on
unmount — a clock, not a poll. The
detail shows status, project, candidates, the budget (wall and tokens,
consumed of limit), created/started/ended, the prompt, and the report through
`MarkdownBody` with the Memory tab's rules: collapsed behind a height clip
when `report_len` exceeds `MEMORY_COLLAPSE_BYTES` (2000), and the truncation
notice when the forwarded report is shorter than `report_len`
(`isMemoryBodyTruncated`) or pf marked it `truncated`. Not installed, below
the floor and failed reads render translated states. The surface is Work's
`"tasks"` sub-tab (`PolyforgeWorkTab` in `hooks/usePolyforge.ts`,
).

**Floor.** `POLYFORGE_TASKS_MINIMUM_PF_VERSION = "2.20.12"` (the first pf whose
task list carries `prompt_summary`), checked through the one
`probePolyforgeVersion` + `isPolyforgeVersionBelowMinimum`; no summary-less
fallback.

## Subprocess contract

- **Every spawn resolves `PF_BIN` first**: the one
  `polyforgePfBin()` in `lib/polyforge-pf-bin.ts` returns a non-empty `PF_BIN`
  when set, else the bare `pf` PATH lookup. `deploy-piweb.sh` resolves that
  value (the deploying shell's `PF_BIN`, else the tmux server's global one,
  else `pf` on the loop's pinned `PATH`) and pins it inside `LOOP_CMD`, so a
  hostile `respawn-window` cannot drop it; the deploy prints the resolved
  absolute path and `pf --version`. A `PF_BIN` pointing at a missing file is
  the ordinary absent case — the version probe fails, the panels read "not
  installed", nothing crashes. No call site spawns a bare `"pf"`, the
  chat-id route included.
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
- Ops: `pf --json ops status`, 10 s timeout, through one shared server-side
  reader (`getPolyforgeOpsStatus`,): concurrent calls share the
  in-flight read, a completed read is reused for 1 s (`OPS_STATUS_REUSE_MS`)
  and a failed read is never reused. The status route and the cards route
  share it: when their polls fire within that 1 s window (aligned when the
  dock opens on the Jobs tab at the default 3 s) one tick spawns one
  `pf ops status` and the queue line and the cards come from the same
  snapshot; out of phase (after a Jobs↔other tab switch, or at a card
  interval other than 3 s) each poll can spawn its own read and show a
  different snapshot. The detect reachability check
  (`readPolyforgeOpsStatus`, so an explicit re-check sees the daemon now) and
  `reloadPolyforgeConfig` keep their own independent reads. Watch: `pf --json watch <ref>
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

## Workflow card

The Settings › Polyforge workflow card reads `GET /api/polyforge/workflows`
and writes through `POST /api/polyforge/config`. Its row model is pure
(`lib/polyforge-workflows-pure.ts`, client-safe, type-only imports):

- **Project.** The selector lists `pf workflows`' `projects` (the cwd
  mapping's projects, in order) and defaults to the first
  (`defaultProject`), because the key space is `steps.<project>.<step-id>`.
- **Rows** (`buildWorkflowRows(doc, workspace, project)`): `default` first
  (the project-level fallback, `steps.<project>.default`), then one row per
  step id across every bundle, alphabetically — a step shared by several
  bundles is ONE row naming each bundle (sorted) with that bundle's own
  candidates — then `task` last (the bundle-less one-shot lane; it names no
  bundle). A row is `declared` when `steps.<project>.<id>.models` is declared
  in the yaml (declared-empty included) and otherwise renders 「继承」 /
  Inherited. Its effective chain and source level (`from`) are pf's
  (`effective.<project>`, `defaults.effective`, `task`): one chain when every
  bundle agrees, else one per bundle (`diverges`); none when no level governs
  (the harness default model runs). Declared attrs are the union of the
  bundles' declarations for the step id, with the yaml override (or the
  declaration's default) as the value.
- **Edits** are list operations only (`addCandidate` — trimmed, no duplicate —
  `removeCandidate`, `moveCandidate`); the candidate format is pf's judgment.

The card itself (`WorkflowCard` in `components/PolyforgeConfig.tsx`, after the
configuration cards; `aria-label` 「工作流」 / Workflow):

- **Reads.** One `GET /api/polyforge/workflows` when the section opens and one
  per click of the title line's 26px ↻ ('s pattern and keys,
  `polyforge.refresh` / `polyforge.refreshing`): disabled, `aria-busy` and
  `animate-spin` (the icon turns) while the newest read is in flight; a seq ref
  lets only the newest read write the card or end the spin. A failed read —
  not 200, `capable:false`, no document, or `daemon_reachable:false` — keeps
  the last good list and shows the reason as a `role="alert"` line. No timer,
  no cache.
- **Rows.** Each row (`li.polyforge-workflow-row`, from `buildWorkflowRows`)
  shows its id, the `live` badge and the next-dispatch note
  (`polyforge.settings.classLiveNote`), the bundles it appears in with their
  own candidates, the declared chain (Declared) or Inherited, the effective
  chain(s) with `From: <level>`, and the declared attrs
  (`question_batch_size` as 「每轮问题数（0 = 一次性全部）」). A note states that
  `pf submit --models` outranks every level; no control edits it.
- **Writes** fold under the `workflow` disclosure region (default closed;
  the #212 store, a draft or an error locks it open with the marker): chips
  with ↑/↓/× and a free-text add, Save (`set steps.<project>.<id>.models` with
  the full list), Clear (`unset`, falls back one level), and the integer attr
  field with Save/Clear. Every write is `POST /api/polyforge/config` with
  `expect_state:{file_sha256: <the read's yaml sha>, values:{}}`, then a fresh
  card read plus the panel's config/history read. Every write control is
  disabled while `write_capable` is false, and the card shows
  `polyforge.settings.workflowCapabilityHint` (the 2.20.15 floor) plus pf's
  `write_reason` as text.
- **Project.** A select of the mapped projects, defaulting to the first;
  switching re-renders that project's rows from the same read and drops the
  unsaved drafts; the disclosure state is the card's own, kept.

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
- **Daemon (R7):** `readPolyforgeOpsStatus()` — the unshared
  `pf --json ops status` read that bypasses the shared 1 s reuse
  (`getPolyforgeOpsStatus`,), so a forced re-check sees the
  daemon now — resolving = 可达; throwing = 不可达 + pf's own
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

`sanitizeOpsStatus` keeps only queue running/max, per-job
wi/slug/status/stepAgeSec/idleAgeSec/candidate/spawnN and
`tasks.running`/`tasks.completed` (; pf's `capped`, `failed`,
`interrupted` and `limit` task counters are dropped) — `env_names`,
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
  cut step name and a status dot only ( removed the visible
  status text had added); the full untruncated name and the
  translated status label (`polyforge.stepStatus.*`: 已完成 / 进行中 / 待开始 /
  已跳过 …, an unknown status raw) are carried in the node's `title` and
  `aria-label`, so assistive technology and hover still read every state, and
  a skipped step is named 已跳过, never unknown or not started. A started
  step's `title` also carries its start time (`<id> · <status> · HH:MM:SS`,
); the `aria-label` stays `<id> · <status>`. Colours: done green (#16a34a), failed
  red (#dc2626), blocked amber (#d97706), in_progress `var(--accent)`,
  pending/cancelled/unknown filled gray (`var(--text-dim)`); skipped alone is
  a hollow gray ring (transparent fill, `1.5px solid var(--text-dim)` border,
  border-box so it stays 7×7) — so skipped and pending read apart without
  text. The ring is the DAG dot's only; every other status dot (the job
  card's slug-row dot included) keeps its filled look. Only the
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
- **Timing line** — under each node, in the node's column
  (a sibling of the `role="listitem"`, never inside it, so the node keeps its
  exact name-only text), one `[data-pf-step-timing="<id>"]` line: `+<duration>`
  in the `formatCardDuration` form (`+45s`, `+3m 05s`) from `buildStepTimings`
  (a done step: its start → the next started step's start; the in_progress
  step: the live age at render, refreshed by the 3 s watch poll and the 2 s
  progress read), then `×N` when the selected card reports `runs > 1`.
  Failed/blocked/cancelled, never-started steps and a done step with no later
  start show no duration; a line with nothing to show is empty at the same
  14 px height, so the nodes stay aligned. Never NaN or negative. The line
  has no `title` and no status label.
- **Rewind edges** — the tail's `rewind` events are deduplicated by
  gate→target pair: each distinct pair whose gate AND target are both nodes
  renders as one dashed chip on its own line under the node row,
  `title`/`aria-label`
  `${polyforge.eventKind.rewind}: gate → target` (existing keys, no new
  i18n labels). Rewinds outside the tail window or with an unknown
  endpoint are not drawn, and no dashed element exists in the panel
  otherwise.
- **Step status display** — the graph nodes are the only step status
  display in every event mode (simple, verbose, invalid): the status dot
  (colour, the skipped hollow ring), plus the full name and the translated
  label in each node's `title`/`aria-label` (no visible label). The job card shows
  no step information: this graph is where the DAG lives. The pre-graph per-step name+status chip row was
  removed in pi#116; the dashed rewind chips under the node row are
  unaffected. The mode toggle behavior is unchanged and stays
  client-side.

## Detail rows (pi#117)

The selected detail renders the sanitized `progress` and chat-origin data
as display-only rows between the summary block and the event tail (the
per-step timing rows moved under the DAG nodes in — see Step
flow graph's timing line; the `polyforge.stepTiming` label left all three
locales). The whole block is absent when the snapshot carries none of it
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

With a job selected, the whole detail — the title row (back
button, slug, short title, status), the step flow graph with its timing
lines, the execution progress, the facts row, the summary block, the detail
rows, the event-mode toggle and the event tail — is ONE vertical scroll
region: the container under the job list (`flex: 1; min-height: 0;
overflow-y: auto`). No nested vertical scroller exists inside the detail
(the event tail is a plain block since pi#120; the execution progress lists
its entries inline,), so every event-tail row is
reachable by scrolling that one region at any sheet height and in the
desktop dock — the old layout stacked the blocks as non-shrinking children
of an `overflow: hidden` column and clipped everything below the fold once
the fixed blocks plus the job list exceeded the available height (the tail
collapsed to zero). The panel's top header (title / refresh / close) stays
outside the region and visible. Horizontal behavior is unchanged: the graph
still wraps with no horizontal scroll. The same component renders the
mobile sheet and the desktop dock, so both get the fix.

## Job detail layout and execution progress

**Order.** With a job selected the detail reads, top to bottom: the title
row → the step flow graph with a timing line under each node → the execution
progress → every block that existed before, in its original relative order
(the facts row, the summary block, the detail rows, the event-mode toggle,
the event tail). Nothing was removed: the step-timing rows moved into the
DAG and the old header merged into the title row.

**Title row** (`[data-pf-detail-title]`). One line: the deselect control,
the slug (the watch read's, else the selected job's, else the selection
ref), the short title (`flex: 1 1 0`, one nowrap line with CSS ellipsis) and
the localized job status (`polyforge.jobStatus.*`; the watch read's workflow
status once the job has left the list). The row's `title` carries the full
goal, the localized workflow status (the old header's visible label), the
update time (`polyforge.updatedAt`) and the current step
(`polyforge.currentStep`) — one per line. Without a readable goal the row
shows deselect + slug + status only, never an invented title.

**Short title.** `shortJobTitle(goal)` in `lib/polyforge-cards-pure.ts`, a
pure client-side heuristic: strip a conventional-commit `type(scope)!:`
prefix, cut at the first `——` / ` — ` / `：` / `:` / `。` / newline, trim; an
empty result is `undefined`. No model call, no server-side title, no reuse of
the card title-length preference — the one-line fit is CSS ellipsis.

**Execution progress** (`[data-pf-progress]`, `PolyforgeDetailProgress`).
A heading (`polyforge.progress.title`: 执行进度 / Execution progress / 執行進度),
then the selected job's current-step tail from
`GET /api/polyforge/progress?wi=` — every entry inline in the detail's one
scroll region (no `overflowY`, no virtualisation), newest last, one nowrap,
ellipsized line each (`[data-pf-progress-kind="narration"|"tool"]`, the
full text on `title`; tool lines in mono, dim). States: `polyforge.loading`
before the first answer, `polyforge.progress.empty` (暂无进度 / No progress
yet / 暫無進度) for an available tail with no entry,
`polyforge.progress.unavailable` (进度不可用 / Progress unavailable / 進度不可用)
when the transcript is not readable or the selected job has no wi — never a
fabricated line.

**Whitelist (the progress face only).** `progressEntries` in
`lib/polyforge-cards.ts`: an assistant text block → `{kind:"narration"}`
(whitespace-collapsed, masked, ≤ 400 code points, as on the card); a pi
`toolCall` / claude `tool_use` block → one `{kind:"tool"}` line
`<name>: <primary argument>` (the primary argument: a string `command`, else
the first string-valued argument in key order, else the name alone), masked
by `maskPolyforgeCredentials` and capped at `PROGRESS_TOOL_MAX` = 200 code
points. Tool results, thinking, user/system records, `api-request-blob` and
every other field produce nothing. `kind` is the one wire field added so the
client tells the two kinds apart without parsing a text prefix. The card
stream's whitelist (narration only) is unchanged.

**Read and bounds.** `readProgressTail(root, capsuleDir)` resolves the
current step's transcript with the card stream's `resolveTranscript` (spawn
journal's newest line → the harness's live session file → the capsule
`session/` copy, the same realpath containment), reads its newest 64 KiB
(`TRANSCRIPT_WINDOW_BYTES`) as whole lines only, and keeps the newest
`PROGRESS_MAX_ENTRIES` = 50 entries within `PROGRESS_MAX_BYTES` = 32 KiB of
entry JSON. Every answer is a fresh newest page; entry ids are
`<16 hex identity>.<offset>.<block>`, the identity hashing the path, device,
inode, harness and step, so a step change replaces the tail and can never
splice two steps (and no id names a path). It never throws: any failure is
`available:false`.

**Cadence.** `hooks/usePolyforgeProgress.ts` (modeled on `useMachineLoad`):
mounted only with the Jobs detail of a selected job (closing the dock or
deselecting unmounts it), keyed on the selected job's `wi` (a card click
stores the slug as the selection ref, so the wi comes from the selected job).
A `running` job: an immediate read, then one every `PROGRESS_POLL_MS` = 2000
ms — a fixed constant, no setting, never the card poll interval. Any other
status: exactly one read, no interval. A hidden page clears the interval and
aborts the request in flight (zero requests while hidden); becoming visible
reads at once. One request in flight, bounded at
`PROGRESS_REQUEST_TIMEOUT_MS` = 5000 ms. `nextProgressTail` keeps the last
good tail on a failed or degraded read (no flash, no error readout) and
replaces it wholesale on a usable one; another job never shows the previous
job's tail.

## Client behavior

- `hooks/usePolyforge.ts`: one status fetch at mount decides presence; a
  pf-less install never polls again. With pf: 3 s cadence while the panel is
  open, 30 s while closed (the badge = queue running count; no badge while the
  daemon is down). With a selection while open: watch polls every 3 s; a null
  status keeps the previous snapshot, so the selection survives the job
  leaving the job list until the user deselects. Stale status/watch responses
  are dropped by their sequence counters (effect cleanups advance them, never
  reset to an observation + 1); the Messages list read is accepted by
  LANDING order instead — the mount/dock-open/tab burst fires concurrent
  reads, the first body to land renders, and anything older than a landed
  response is discarded — and page writes guard by conversation identity
  (`selectedConversationRef`): a previous selection's in-flight page can
  never land under the current one. The first list read starts at mount,
  ungated on the presence probe — the route itself degrades (pf absent
  answers `{pfPresent:false}`, below the floor spawns no verb). Once the
  probe answers "absent" the effect reads nothing more (its re-runs on the
  probe landing and on dock toggles return first, and the dock button that
  reaches the tab is not rendered without pf), so a pf-less install issues
  exactly one messages request, at mount; the poll interval requires
  presence. `refreshStatus` returns its settle promise (pi#113) so a
  manual caller can show in-flight state; the mount probe and the interval
  polls ignore it.
- `components/PolyforgePanel.tsx`: all jobs on the machine (no owner filter),
  one card each (see [Jobs tab card stream](#jobs-tab-card-stream));
  the candidate (now in the detail's facts row), step ids, event values and
  the chat id are shortened client-side to 24 chars + `…`; unknown status
  values pass through raw (known ones use `polyforge.*` keys present in en,
  zh-CN and zh-TW). The selected detail's title row (; it was the
  detail header) hoists over the watchStatus split and carries a back button
  (`polyforge.deselect`) calling `onSelect(null)` — the deselect gesture
  survives the job leaving the list and the snapshot still loading. A blocked WI shows its status only — no question text
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
  dock is open and unpinned; the mobile sheet keeps its backdrop tap and the
  bg-tasks dock gets no outside-click close.
  **Desktop dock pin:** the dock header carries a pin control
  (`aria-pressed`, translated `polyforge.dock.pin`/`unpin`) rendered only on
  the desktop dock (`showPin`; the mobile sheet passes `showPin={false}` and
  keeps only its backdrop tap). The pin is AppShell state persisted globally
  under `pi-web:polyforge-dock-pinned` (`"1"` = pinned, absent/invalid =
  unpinned, guarded reads/writes like the other `pi-web:polyforge-*` keys).
  While pinned the outside-press listener above is not installed — an outside
  press still reaches its target and the dock stays open. The topbar toggle
  and the panel's close still close the dock and never clear the pin; only the
  pin control does. A one-shot mount effect reopens the dock when pinned and
  the `(max-width: 640px)` media query does not match (bg-tasks closes first,
  the shared-slot rule); the dock stays the same absolute overlay, so the chat
  is never resized.
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
