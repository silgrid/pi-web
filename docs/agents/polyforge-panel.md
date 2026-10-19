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
  currentStep,updatedAt,steps:[{name,status}],events:[{at,kind,summary?}]} | null, error?}`.
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

## Client behavior

- `hooks/usePolyforge.ts`: one status fetch at mount decides presence; a
  pf-less install never polls again. With pf: 3 s cadence while the panel is
  open, 30 s while closed (the badge = queue running count; no badge while the
  daemon is down). With a selection while open: watch polls every 3 s; a null
  status keeps the previous snapshot, so the selection survives the job
  leaving the job list until the user deselects. Stale responses are dropped
  by sequence counters (effect cleanups advance them, never reset to an
  observation + 1).
- `components/PolyforgePanel.tsx`: all jobs on the machine (no owner filter);
  the candidate is shortened client-side to 24 chars + `…`; unknown status
  values pass through raw (known ones use `polyforge.*` keys present in en,
  zh-CN and zh-TW). The selected detail's header hoists over the watchStatus
  split and carries a back button (`polyforge.deselect`) calling
  `onSelect(null)` — the deselect gesture survives the job leaving the list
  and the snapshot still loading. A blocked WI shows its status only — no question text
  exists in the client by construction.
- `components/AppShell.tsx`: the button renders iff pf is present,
  independent of chat visibility; opening the Polyforge panel closes bg-tasks
  and vice versa (mutually exclusive dock slot: 340 px right dock / 62 %
  mobile sheet) — enforced on every path that opens either panel, including
  the bg-task terminal notification's jump: its onClick closes the Polyforge
  panel before showing bg-tasks, so the jump never lands on a covered dock.
- **Event tail display modes (pi#112):** panel-local state with a global
  localStorage key `pi-web:polyforge-event-mode` (`"simple"|"verbose"`;
  absent/invalid reads as simple). Simple mode (the default) collapses each
  consecutive run of noise events (`published`, `transcript_missing`,
  `exec_init`) into one gray `sync ×N` row (×1 included); verbose mode renders
  every event on its own row with the raw kind shown inline and noise grayed
  individually. Every row puts the raw kind and full whitelisted field values
  in its hover `title`, and renders whitelisted values as mono spans
  (`step · model`, `from → to`, `step · cause`, `gate → target`, terminal
  status, or lone step), ellipsized at 24 chars like the job candidate.
  Severity emphasis: `needs_input` amber (#d97706); `step_failed`,
  `step_dead`, `push_failed`, `envelope_rejected`, `needs_recovery` and
  `terminal` failed red (#dc2626); `terminal` completed green (#16a34a);
  `terminal` cancelled and all other kinds neutral. The mode toggle lives in
  the event-tail area of the selected detail and is purely client-side — no
  network request on toggle.
