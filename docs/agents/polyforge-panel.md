# Polyforge dock panel (pi#108)

A read-only Polyforge panel in the shared dock slot (the bg-tasks slot): a topbar
button + right dock (desktop) / bottom sheet (mobile), a job list, and a selected
work item's steps and event tail. Files: `lib/polyforge-status.ts`,
`app/api/polyforge/**`, `hooks/usePolyforge.ts`, `components/PolyforgePanel.tsx`,
the `polyforge.*` wiring in `components/AppShell.tsx`.

## Route contracts (degradation-first)

- `GET /api/polyforge/status` → 200 `{pfPresent:boolean, status:{queue:{running,max},
  jobs:[{wi,slug,status,stepAgeSec,idleAgeSec,candidate,spawnN}]} | null, error?}`.
  Pf absent answers `{pfPresent:false,status:null}` (no error, the client stops
  polling); daemon down / auth failure / hang answer `{pfPresent:true,status:null,error}`.
- `GET /api/polyforge/watch?wi=<slug|wi_id>` → 200 `{status:{wi,slug,workflowStatus,
  currentStep,updatedAt,steps:[{name,status}],declared_steps:[{id}]|null,
  events:[{at,kind,summary?}]} | null, error?}`.
  A malformed `wi` answers 400 and never spawns pf.
- There is no 5xx path on either route, and every failure answers decodable
  JSON: the e2e suite treats any 5xx as a browser error. Both routes re-check
  `isApiRequestAllowed` in-route (`lib/request-security.ts`) and answer 403 JSON
  on refusal.

## Subprocess contract

- All pf reads go through `execFileAsync` from `lib/exec-file.ts` (no shell);
  the ref is one closed argv positional, validated by `isPolyforgeWiRef`
  BEFORE any spawn.
- Presence probe: `pf --version`, 3 s timeout, cached module-side for 60 s
  (a CLI installed while the server runs appears after a reload once the TTL
  expires). The UI affordance is gated on presence, never on daemon
  reachability.
- Ops: `pf --json ops status`, 10 s timeout. Watch: `pf --json watch <ref>
  --once --events 40`, 10 s timeout. **`--once` is mandatory** — without it
  `pf watch` is the resident watcher and streams forever.
- Failure text is pf's own stderr, capped at 512 chars. Error strings are
  never built from `process.env`: a stale `POLYFORGE_V1_API_KEY` inherited by
  the child must leak nothing (values, not names, are the secret).

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
text. `progress`, raw event bodies and `job` are dropped. Step order is
execution order: started steps by `started_at` ascending, unstarted last,
ties by name.

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
  the graph falls back to the started-at order and edges only consecutive
  started steps, so unstarted steps trail unedged. `on_fail` targets are
  not part of the node model, so they are never drawn. The node row is a
  `flex-wrap` container with `overflow: hidden` — rows wrap in the 340 px
  dock and the mobile sheet with no horizontal scroll; a connector that
  lands at a line end simply ends that line.
- **Rewind edges** — each taken `rewind` event in the sanitized 40-event
  tail whose gate AND target are both nodes renders as one dashed chip on
  its own line under the node row, `title`/`aria-label`
  `${polyforge.eventKind.rewind}: gate → target` (existing keys, no new
  i18n labels). Rewinds outside the tail window or with an unknown
  endpoint are not drawn, and no dashed element exists in the panel
  otherwise.
- **Verbose chips** — in Verbose event mode, the pre-graph
  name+status chips render below the graph in addition to the nodes; in
  simple mode (the default, and for an invalid stored mode) only the
  graph shows. The mode toggle behavior is unchanged and stays
  client-side.

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
  and vice versa (mutually exclusive dock slot: 340 px right dock / 62 %
  mobile sheet) — enforced on every path that opens either panel, including
  the bg-task terminal notification's jump: its onClick closes the Polyforge
  panel before showing bg-tasks, so the jump never lands on a covered dock.
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
