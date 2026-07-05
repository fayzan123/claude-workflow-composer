# Bug Audit — Findings & Fix Plan (2026-07-04)

Full-codebase audit at commit `176f2d2` (v0.11.7, main). 24 findings: 4 High, 8 Medium, 12 Low.
All line numbers reference that commit; verify with the quoted code before editing since lines drift.

## Progress (updated 2026-07-05)

**Batches 1–8 are IMPLEMENTED and REVIEWED.** Fixed: F1 through F24. Each fixed finding below
carries a `Status: FIXED` line describing what shipped. Validation after batches 6–8:
focused tests green, `npm run typecheck` green, `npm test` green (629 passed, 1 skipped), and
`npm run build` green.

The review pass found two defects in the initial batch-1–5 implementation, both corrected before
commit:

1. **F3/F4 conflict:** the new `fireWorkflow` skill gate checked only the user skills dir, which
   would have blocked trigger firing for project-scoped exports (a regression — they worked
   before the gate existed). Corrected: the gate now accepts the skill in either
   `<skillsDir>/<slug>/SKILL.md` or `<cwd>/.claude/skills/<slug>/SKILL.md`, matching the
   `POST /runs/test` dual check. Test: triggers-webhook "fires when the skill exists only
   project-scoped in the trigger cwd".
2. **F12 semantics:** the first implementation treated `maxRunsPerDay < 1` as *uncapped*, which
   would have silently converted legacy `0`-valued triggers (the artifact of the very input bug
   being fixed) from "never fires" to "unlimited fires" on upgrade. Corrected: non-positive or
   non-finite caps mean **never fire** (server-side), while the client clamps all new saves
   to ≥ 1 and shows a hint. Do not re-flip this without reading the comment in
   `automation-state.ts` `canFire`.

The batch-6–8 review pass applied two hardening corrections before commit:

1. The F22 tree-kill test originally built nested `node -e` scripts with JSON-escaped quoting —
   unparseable through cmd.exe + msvcrt argv rules on the Windows CI leg — with a 500ms spawn
   budget too tight for slow runners. Rewritten to use script files, a 3s timeout, and a
   settle-then-sample quiescence assertion.
2. `killProcessTree`'s POSIX SIGKILL escalation now skips once the direct child has exited
   (its orphans reparent to init, so re-walking the dead PID finds nothing and risks PID reuse).

Note on test coverage: `useAutoSave` (F8/F21) has no direct hook test — the repo's client tests
are pure-logic only (no hook-render harness), consistent with how the hook was untested before.
If a hook harness is ever added, cover: failed save keeps `isDirty` true and retries, suspend/
resume queues edits made during a rename, and the saved-snapshot ref only advances on success.

**Remaining work:** none in this plan.

One flake observed during validation (single failure in one of five full-suite runs, gone on
rerun) — consistent with the known process-timing sensitivity of the gate/worktree tests, not
introduced by these changes.

---

## How to work this plan (read first)

- Follow AGENTS.md. In particular: TypeScript strict, ESM, single quotes, no semicolons,
  `.js` extensions on relative imports in server/core code, real-filesystem tests with temp dirs
  (no fs mocks), `AppOptions` injection instead of module mocking.
- **Pitfall from AGENTS.md that applies to several fixes here:** when export *output* changes,
  `src/server/api/export-preview.ts` and `src/export/exporter.ts` must change together, and
  preview must byte-match real export decisions.
- Validation loop per fix: run the narrowest matching test file first
  (`npx vitest run tests/<area>/<file>.test.ts`), then `npm run typecheck`. Before declaring the
  batch done: `npm test`, `npm run typecheck`, `npm run build`.
- Existing test dirs to extend: `tests/server/`, `tests/export/`, `tests/workflow/`,
  `tests/client/`, `tests/detection/`, `tests/generation/` (check `rg --files tests` for exact
  names). Fake claude binaries come from `tests/helpers/make-bin.ts`.
- CI runs Ubuntu + Windows, Node 20 + 22. Anything touching process spawning, paths, or kill
  behavior must account for Windows (`.cmd` shims, `taskkill`, `path.sep`).
- Do NOT relax auth, CORS, loopback binding, or token checks while fixing anything (AGENTS.md
  rule). The token-exempt endpoints (`POST /api/runs/events`, `POST /api/triggers/*`) are
  intentional; leave them.

---

## Recommended fix order

Fixes are grouped so shared root causes are handled once. Suggested batches:

| Batch | Findings | Theme | Status |
|-------|----------|-------|--------|
| 1 | F2 | Path traversal / unguarded recursive delete | ✅ DONE |
| 2 | F1, F3, F9, F13 | The rename/slug lifecycle (one root cause) | ✅ DONE |
| 3 | F4 | Project-scoped exports can't Test Run | ✅ DONE |
| 4 | F5, F6, F18, F19 | Run lifecycle correctness | ✅ DONE |
| 5 | F7, F10, F12 | Automation/scheduler papercuts | ✅ DONE |
| 6 | F8, F21 | Autosave data loss + rename race | ✅ DONE |
| 7 | F11, F14, F16 | Export edge cases | ✅ DONE |
| 8 | F15, F17, F20, F22, F23, F24 | Low-severity cleanup | ✅ DONE |

Batch 2 is the big one: F1, F3, F9, F13 all stem from "the workflow skill slug is derived live
from `meta.name` and the export result is never persisted." Fix F1 first within the batch; F3 and
F9 become simpler once a durable `exportedWorkflowSlug` exists.

---

## HIGH severity

### F1 — `exportedWorkflowSlug` is never persisted; rename reconciliation is dead code

- **Status: FIXED.** New `SET_EXPORTED_WORKFLOW_SLUG` reducer action (bypasses the undo stack; also mapped over past/future snapshots so undo cannot resurrect a stale slug — `UPDATE_EXPORTED_SLUG` got the same treatment). `ExportFlow` dispatches it from `res.updatedCwc.meta`; autosave persists it. Tests in `tests/client/history.test.ts`.

- **Severity:** High. Renaming a workflow and re-exporting leaves the old
  `~/.claude/skills/cwc-<old-slug>/` on disk forever: a phantom "Deployed" entry that Claude Code
  can still invoke.
- **Root cause:** `exportWorkflow()` returns `updatedCwc` with
  `meta.exportedWorkflowSlug = workflowSlug` (`src/export/exporter.ts:214`) and uses the *previous*
  value to delete the old skill dir on rename (`src/export/exporter.ts:188-195`). But the server
  never writes the `.cwc` file — the client owns persistence — and the client only applies
  per-node slugs: `client/src/components/ExportFlow.tsx:61-65` dispatches `UPDATE_EXPORTED_SLUG`
  per node and drops `updatedCwc.meta` on the floor. `grep -rn exportedWorkflowSlug` hits only
  `src/export/exporter.ts` — nothing reads or writes it anywhere else.
- **Fix sketch:**
  1. Add a reducer action in `client/src/hooks/useWorkflow.ts` (e.g.
     `SET_EXPORTED_WORKFLOW_SLUG` or extend `UPDATE_EXPORTED_SLUG` handling) that sets
     `meta.exportedWorkflowSlug` **without landing on the undo stack** — mirror how
     `UPDATE_EXPORTED_SLUG` is special-cased in `historyReducer`
     (`useWorkflow.ts:126-127`). It must also not bump `meta.updated` unnecessarily (or it's fine
     to; autosave will fire either way).
  2. In `ExportFlow.tsx` after a successful export, dispatch it with
     `res.updatedCwc.meta.exportedWorkflowSlug`.
  3. Autosave then persists it; the exporter's existing reconciliation path starts working.
- **Tests:** client reducer test in `tests/client/` (action bypasses undo, sets meta field);
  extend the exporter rename test in `tests/export/` to assert old skill dir removal when
  `exportedWorkflowSlug` present (likely already exists — verify it passes with a cwc that has
  the field, then add an end-to-end-ish test that the client dispatch path produces a cwc
  containing the field, in `tests/client/`).
- **Gotcha:** undo/redo must not resurrect a stale slug — that's why it must bypass history.

### F2 — `DELETE /api/exported-workflows` allows path traversal and ignores ownership

- **Status: FIXED.** Slug regex `^[a-z0-9-]+$` + resolved-path containment + `WORKFLOW_ID_REGEX` ownership check before `fs.rm`. Tests in `tests/server/exported-workflows.test.ts` (traversal, hand-authored refusal, legit delete).

- **Severity:** High (destroys data outside CWC ownership; only delete endpoint with no guard).
- **Where:** `src/server/api/exported-workflows.ts:41-58`.
- **Behavior:** `const skillDir = path.join(skillsDir, slug)` then
  `fs.rm(skillDir, { recursive: true, force: true })`. A slug of `../../Documents/foo` escapes
  `~/.claude/skills` and recursively deletes an arbitrary directory. There is also no check that
  the target contains the `<!-- cwc:workflow:... -->` marker, so any hand-authored skill can be
  deleted by slug.
- **Fix sketch:**
  1. Validate the slug: `/^[a-z0-9-]+$/` (same regex the agents/skills POST routes use at
     `src/server/api/agents.ts:65` and `src/server/api/skills.ts:73`). Reject otherwise with 400.
  2. Belt-and-braces: after `path.join`, verify
     `path.resolve(skillDir).startsWith(path.resolve(skillsDir) + path.sep)`.
  3. Require the skill's `SKILL.md` to match `WORKFLOW_ID_REGEX`
     (already defined at top of this file, line 6) before deleting; return 400/403 "not a
     CWC-exported workflow" otherwise. Note the GET route in this same file already filters to
     marker-bearing dirs, so the UI only ever sends valid slugs — this change is API hardening,
     not a UI behavior change.
- **Tests:** temp-dir test in `tests/server/`: traversal slug → 400 and nothing deleted;
  non-CWC skill dir → refused; legit exported dir → deleted. Use `createApp()` with
  `userHomeDir` pointed at a temp dir.

### F3 — Scheduler and webhook fire the current-name slug with no exported-skill check

- **Status: FIXED.** Scheduler and webhook route prefer `meta.exportedWorkflowSlug ?? workflowSkillSlug(name)`; `fireWorkflow` gained a skill-existence gate (skillsDir threaded via `FireOptions`) that skips with reason `skill not exported`. Review correction: the gate checks BOTH the user skillsDir and `<cwd>/.claude/skills` so project-scoped exports keep firing. Tests in automation-scheduler + triggers-webhook test files.

- **Severity:** High. After "rename, forget to re-export," every trigger fire spawns
  `claude -p "/cwc-<new-slug>" --permission-mode bypassPermissions` in the target repo. The slash
  command doesn't resolve, so the model free-runs on literal prompt text with full permissions —
  token burn at best, unintended in-place repo changes at worst — and records `complete`.
- **Where:**
  - Scheduler slug derivation: `src/server/automation-scheduler.ts:39`
    (`workflowSlug: 'cwc-' + slugify(cwc.meta.name)`).
  - Webhook route: `src/server/api/triggers.ts:68` (same expression).
  - Contrast with the guarded path: `src/server/api/runs.ts:69` checks
    `fs.existsSync(path.join(opts.skillsDir, workflowSlug, 'SKILL.md'))` before a Test Run.
- **Fix sketch (after F1 lands):**
  1. Prefer `cwc.meta.exportedWorkflowSlug` when present, falling back to the derived slug.
  2. Add a skill-existence pre-check in `fireWorkflow()` (`src/server/run-launcher.ts`) or at the
     two call sites: if `<skillsDir>/<slug>/SKILL.md` is missing, return
     `{ fired: false, reason: 'skill not exported' }` — the scheduler already records
     skip reasons via `onSkip`, and the webhook route already maps `fired:false` to a 409.
     `fireWorkflow` currently has no `skillsDir` — thread it through `FireOptions` from
     `createApp` (it already computes `path.join(homeDir, '.claude', 'skills')` at
     `src/server/index.ts:129`).
  3. Keep the check consistent with F4's resolution (project-dir skills), or scope it to
     user-dir skills only for triggers and document that.
- **Tests:** extend scheduler/trigger tests in `tests/server/`: trigger fire with missing skill →
  skip recorded with reason, no spawn (assert via injected `fireOne` or fake bin from
  `tests/helpers/make-bin.ts`).

### F4 — Project-scoped exports can never be Test Run

- **Status: FIXED.** `POST /runs/test` accepts the skill in user OR `<cwd>/.claude/skills`; RunModal preflight demoted from hard block to informational warning (server validates on start). Test: runs-test-run "allows a run when the workflow skill exists only in the selected project".

- **Severity:** High (a first-class export target is unusable with a core feature).
- **Where:**
  - Server gate: `src/server/api/runs.ts:69` checks only `opts.skillsDir`, which `createApp`
    hardwires to the *user* dir: `skillsDir: path.join(homeDir, '.claude', 'skills')`
    (`src/server/index.ts:129`).
  - Client preflight: `client/src/components/RunModal.tsx:45-51` checks
    `api.exportedWorkflows.list()`, which scans only `~/.claude/skills`
    (`src/server/api/exported-workflows.ts`).
- **Behavior:** export to `<project>/.claude/skills`, open Test Run → "workflow not exported: no
  skill found for /<slug>" even though `claude` running in that cwd would resolve the project
  skill fine.
- **Fix sketch:**
  1. Server: in the `/test` handler, also check
     `path.join(cwd, '.claude', 'skills', workflowSlug, 'SKILL.md')` (cwd is in the request body
     and already validated as an existing directory a few lines up). Worktree-isolation note:
     the worktree is created *from* cwd, so a project skill committed to the repo exists in the
     worktree too; an **uncommitted** `.claude/` dir does NOT propagate into a worktree — if you
     want to be thorough, warn (not block) when the skill exists only untracked. Minimal correct
     fix: accept the run if the skill exists in either location.
  2. Client: `RunModal` preflight can't see project dirs from `exportedWorkflows.list()`.
     Simplest correct fix: when the user-dir check fails, don't hard-block — let the server
     decide (the server error message is already good). I.e. change `exported === false` from a
     hard gate to a warning banner, or add a lightweight server endpoint that answers
     "is /<slug> runnable from <cwd>?" and call that instead.
- **Tests:** `tests/server/runs.test.ts` — POST /test with a skill only in
  `<cwd>/.claude/skills` succeeds (temp dirs; inject fake claude bin).

---

## MEDIUM severity

### F5 — Reject can tear down a still-running run's worktree

- **Status: FIXED.** `RunStore.isActive(runId)` added; approve and reject both 409 ("still finishing") while the run is in the active registry. Test 4d in `tests/server/runs-gates.test.ts` exercises the race window with a delayed fake bin.

- **Where:** `src/server/api/runs.ts:200-217` (reject handler) vs the masking logic in
  `src/server/run-store.ts:104-109`.
- **Root cause:** `listRuns` deliberately reports a run as `running` while it's still in the
  active registry, even if the child already wrote `awaiting_approval`. But reject reads raw
  events (`store.getEvents`) and accepts `last.type === 'awaiting_approval'`, so in the window
  between the child logging `awaiting_approval` and the parent's `classifyAndFinish`, reject can:
  append `run_completed: aborted`, then `removeWorktree --force` under the live process; later
  `classifyAndFinish` appends `run_paused`/`run_completed` **after** the terminal event.
- **Fix sketch:** at the top of the reject handler, reject with 409 if the run is still active:
  the store already exposes what's needed — add e.g. `isActive(runId): boolean` to `RunStore`
  (trivial: `activeRuns.has(runId)`) and 409 with "run is still finishing — try again in a
  moment" when true. Apply the same guard to approve (approve currently checks
  `hasActiveTestRun(workflowId)` which covers it for the same workflow, but `isActive(runId)` is
  the precise check).
- **Tests:** `tests/server/` — register a run as active, write an `awaiting_approval` event,
  POST reject → 409, worktree untouched; release the run → reject succeeds.

### F6 — maxBuffer overflow (and any SIGTERM) reported as "Run stopped."

- **Status: FIXED.** maxBuffer detected via `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`/message → `error: 'Run output exceeded 10MB.'`; other uninitiated signals → error naming the signal. CWC-initiated stop/timeout still classify via the `stopped`/`timedOut` flags (checked first). Tests in workflow-runner.test.ts (chatty bin + external SIGTERM).

- **Where:** `src/server/workflow-runner.ts:89-96`. `if (e.killed || e.signal === 'SIGTERM')`
  → `aborted / 'Run stopped.'`. Node SIGTERMs the child itself when `maxBuffer` (10 MB) is
  exceeded, so an over-chatty run ends as a calm "Run stopped."
- **Fix sketch:** the runner already tracks `stopped` and `timedOut` flags — those are the only
  legitimate abort sources. When neither flag is set and the child died by signal, classify as
  `error` with a message; detect the maxBuffer case explicitly
  (`err.message` contains `'maxBuffer'` / `err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'`)
  and say so ("run output exceeded 10MB").
- **Windows note:** on win32 the stop path uses `taskkill`, not SIGTERM — verify the `stopped`
  flag (not the signal) is what drives classification there.
- **Tests:** fake bin (from `tests/helpers/make-bin.ts`) that spews > maxBuffer → result status
  `error` mentioning output size; existing stop/timeout tests still pass.

### F7 — Scheduler records a skip every 30 s while paused / daily-capped / busy

- **Status: FIXED.** `dueOccurrence()` replaces `isDue()`; `recordSkip` takes the occurrence and dedupes on (occurrence, reason) with the early return BEFORE `save()`, so repeated ticks add neither skips nor disk writes. `lastSkippedOccurrence` added to `TriggerState`. Test: 10 paused ticks → `skippedCount === 1`, `lastFiredAt` unchanged.

- **Where:** `src/server/automation-scheduler.ts:72-93` (`tick`). When the pause/cap/busy
  branches skip, nothing consumes the due-ness (only `recordFire` advances `lastFiredAt`), so the
  same trigger is due again next tick: `skippedCount` inflates ~2,880/day, `lastSkip` churns, and
  `automation-state.json` is rewritten every 30 s.
- **Fix sketch:** dedupe skip recording — e.g. only `recordSkip` when the reason differs from the
  current `lastSkip.reason`, or when the due occurrence changes (compare
  `new Cron(t.schedule).nextRun(lastFiredAt)` to the one last skipped, storing
  `lastSkippedOccurrence` in `TriggerState`). Do NOT advance `lastFiredAt` on a pause-skip:
  the intent is that resuming fires the pending occurrence (or drops it under `catchUp: false`
  via the existing missed-firing branch). Keep `skippedCount` semantics as "skipped occurrences,"
  not "skipped ticks."
- **Where state lives:** `src/server/automation-state.ts` (`TriggerState`, `recordSkip`).
- **Tests:** `tests/server/` scheduler test with injected `now()` — paused trigger over 10 ticks
  records ≤ 1 skip per due occurrence; file not rewritten every tick (can assert `save` count via
  a spy on an injected state, or mtime).

### F8 — Failed autosave silently loses the edit

- **Status: FIXED.** `useAutoSave` advances its saved snapshot only after
  `api.workflows.save` succeeds; failed saves keep `isDirty` true and can retry against the latest
  workflow/path.

- **Where:** `client/src/hooks/useAutoSave.ts:62-73`. `prevRef.current = serialized` is set when
  the timer is *scheduled*, not when the save *succeeds*. A failed save (server down, disk error)
  never retries — identical state compares equal forever — and `isDirty` returns false (timer
  cleared in `finally`), so `WorkflowHeader`'s "leave anyway?" confirm doesn't trip. Only signal
  is the dismissible "Save failed" pill.
- **Fix sketch:** move the `prevRef.current` assignment into the success path of `runSave` (store
  the serialized snapshot on the ref only after `api.workflows.save` resolves). Add a
  `hasFailedSave` state that keeps `isDirty` true until a subsequent save succeeds; optionally
  schedule a retry with backoff. Careful: `runSave` reads `workflowRef.current` (latest), so on
  success set `prevRef.current = JSON.stringify(workflowRef.current)` — the value actually saved.
- **Tests:** `tests/client/` (there's an existing autosave test file — extend it): failing save →
  `isDirty` stays true and the next state change (or flush) retries the same content.

### F9 — Export preview diverges from real export

- **Status: FIXED.** Preview now uses shared `applyExportedNodeSlugs()` + `collectNodeOverrides()` + `resolveSkillWithOverride` and accepts `skillsDir` like the real export route. Byte-equality tests (preview SKILL.md === real export SKILL.md) cover the rename and ref-node-model cases in `tests/server/export-preview.test.ts`.

- **Where:** `src/server/api/export-preview.ts`. Two drifts plus one asymmetry:
  1. Line 68: preview passes the *original* `cwcFile.nodes` to `generateOrchestratorBody`,
    so after an agent rename the previewed orchestrator prose shows the STALE
    `exportedSlug` as `subagent_type` (`nodeSlug()` in
    `src/workflow/prose-generator.ts:29-31` prefers `exportedSlug` over the derived slug),
    while real export passes `updatedNodes` with the new slug (`src/export/exporter.ts:178`).
  2. Lines 38-48: preview's inline override collection for ref nodes omits `model`;
    the real path `collectNodeOverrides` (`src/workflow/prose-generator.ts:62-82`) includes it.
  3. Preview ignores the `skillsDir` override that the real export endpoint accepts
    (`src/server/api/export.ts:24-30`), and uses raw `resolveSkill` instead of the exporter's
    `resolveSkillWithOverride`.
- **Fix sketch:** make preview reuse the exporter's decisions instead of reimplementing:
  - Build "would-be updatedNodes" the same way export does: for bespoke nodes compute
    `agentSlug(node.agent.name)` and substitute it as `exportedSlug` before prose generation
    (or better, extract a shared pure helper in `src/export/` that both call).
  - Replace the inline override block with `collectNodeOverrides(cwcFile.nodes)`.
  - Accept and pass through `skillsDir` like the export route does.
- **Tests:** `tests/export/` or `tests/server/`: rename a node (stale `exportedSlug` set) →
  preview SKILL.md content equals real export SKILL.md content byte-for-byte; ref node with only
  a `model` override → annotation present in both.

### F10 — Arming a trigger with an empty cwd silently does nothing

- **Status: FIXED.** `armAndEnable` wrapped in try/catch with inline error; "Turn on"/"Arm" disabled with a reason when cwd is empty/relative; `AutomationModal` validates on save via `normalizeTriggerForSave`/`validateTriggerForSave` (absolute-path check covers POSIX, drive-letter, and UNC). Tests in `tests/client/trigger.test.ts`.

- **Where:**
  - `client/src/views/modes/AutomateMode.tsx:200` — `onClick={() => void armAndEnable(t)}`;
    `armAndEnable` awaits `api.automations.arm(t)` with no catch, so the server's 400
    ("trigger cwd required before arming", `src/server/api/automations.ts:28`) becomes an
    unhandled rejection; the button appears dead, no feedback, `pendingArmId` never clears.
  - `client/src/components/automate/AutomationModal.tsx` — Save has no validation; cwd can be
    empty or relative.
  - Detect-promoted cron triggers ship `cwd: ''` by design
    (`src/server/api/automation-scan.ts:299`), so this is the DEFAULT path for the product's
    main funnel.
- **Fix sketch:** (a) wrap `armAndEnable` in try/catch and surface the server error (toast or
  inline near the trust prompt); (b) in `AutomationModal.handleSave`, require a non-empty
  absolute cwd (same `startsWith('/')` heuristic ExportFlow uses; on Windows accept
  `path`-absolute — client-side, a simple `/^([a-zA-Z]:[\\/]|\/)/` check is fine) or disable
  Save with a hint; (c) optionally disable the "Turn on" button with a tooltip when
  `t.cwd.trim() === ''`.
- **Tests:** `tests/client/` if there's coverage for AutomateMode helpers; otherwise typecheck +
  manual verification per repo convention (no browser harness).

### F11 — Same-slug agents overwrite each other within one workflow

- **Status: FIXED.** `exportWorkflow` rejects duplicate bespoke-agent slugs, rename cleanup skips
  sibling live slugs, and compiler self-healing dedupes bespoke generated agents by slug. Tests in
  exporter/compiler coverage.

- **Where:** `src/export/exporter.ts:138-173`. Ownership check is per *workflow*
  (`detectConflict(..., workflowId)`), so two nodes whose names slugify identically both "own"
  the file — last write wins, first agent's file is silently replaced. Rename cleanup
  (lines 142-151) can likewise delete a *sibling node's* current file (node A's old slug ==
  node B's live slug), order-dependently.
- **Why the UI guard is insufficient:** `client/src/lib/validation.ts:16-37` blocks duplicate
  slugs in the editor, but (a) the export API doesn't re-validate, and (b) the generation
  compiler's `uniqueName`/`selfHeal` (`src/generation/compiler.ts:58-66, 232-248`) dedupe exact
  *names* only — "Run Tests." and "Run Tests" are distinct names with the same slug, so Detect
  promotion can produce colliding workflows that export silently wrong.
- **Fix sketch:**
  1. In `exportWorkflow`, precompute all bespoke-node slugs; if any duplicate, throw
    `ExportConflictError` naming the two agents (server-side enforcement of the client rule).
  2. In `selfHeal` (compiler), dedupe by `agentSlug(name)` instead of by raw name.
  3. For the rename-cleanup hazard: skip the old-file delete when the old slug equals another
    node's *current* slug in the same workflow.
- **Tests:** `tests/export/`: two nodes "Run Tests" / "Run Tests." → export throws conflict;
  compiler test: phases with punctuation-variant intents → distinct slugs.

### F12 — Clearing "Max runs per day" bricks the trigger

- **Status: FIXED.** Client: `normalizeMaxRunsPerDay` clamps to ≥ 1 (empty keeps previous value), `min={1}`, hint text added. Server: `canFire` treats non-finite or `< 1` as **never fire** — deliberately preserving legacy `0 = never` so old bugged triggers don't silently become uncapped (review correction; see comment in `automation-state.ts`).

- **Where:** `client/src/components/automate/AutomationModal.tsx:338`
  (`Number(e.target.value)` — empty string → 0, and typed negatives pass) +
  `src/server/automation-state.ts:64-68` (`maxRunsPerDay === 0` → never fire; negative → also
  never, via `runsCount < t.maxRunsPerDay`).
- **Behavior:** field cleared → saved as 0 → trigger shows "On" but every occurrence skips as
  "daily cap".
- **Fix sketch:** in the input handler, clamp: empty/NaN → keep previous or default 10; enforce
  min 0 with an explicit "0 = never fire" hint if 0 is meant to be a feature, otherwise min 1.
  Server side, treat NaN/negative as "no cap" or reject on arm — pick one and make
  `canFire` consistent.
- **Tests:** small unit test for whatever pure clamp helper you add; state test for
  `canFire` with 0/negative/NaN.

---

## LOW severity

### F13 — Empty/emoji-only workflow name exports to a skill dir literally named `cwc-`

- **Status: FIXED.** `workflowSkillSlug()` added to `src/slugify.ts` (`cwc-` prefix, `workflow` fallback) and used at all six call sites (exporter, export-delete, export-preview, scheduler, triggers, ExportFlow/WorkflowView). Tests in slugify.test.ts.

- **Where:** `'cwc-' + slugify(cwc.meta.name)` with no fallback, in FOUR places:
  `src/export/exporter.ts:91`, `src/server/api/export-preview.ts:26`,
  `src/server/automation-scheduler.ts:39`, `src/server/api/triggers.ts:68`.
  Contrast `agentSlug`/`skillSlug` fallbacks in `src/slugify.ts`.
- **Fix sketch:** add `workflowSkillSlug(name: string): string` to `src/slugify.ts` returning
  `'cwc-' + (slugify(name) || 'workflow')` and use it in all four sites (plus anywhere else
  `rg "cwc-' \+ slugify|'cwc-' \+"` finds). Keep preview/export identical (AGENTS.md).
- **Note:** the rename endpoint already falls back for the *filename*
  (`src/server/api/workflows.ts:109` — `slugify(newName) || 'untitled'`) but `meta.name` keeps
  the emoji string, which is how this state arises.

### F14 — `deleteExport` treats gates as agents

- **Status: FIXED.** `deleteExport` skips `nodeType === 'gate'` nodes alongside reference nodes;
  export-delete coverage asserts gate paths do not appear in deleted/skipped/notFound buckets.

- **Where:** `src/server/api/export-delete.ts:32-51`. Only `agentRef` nodes are skipped; gate
  nodes (`nodeType === 'gate'`, which never write files — see AGENTS.md) fall through, producing
  bogus `notFound` entries ("approval-gate.md") and potentially `skipped` noise if an unrelated
  file with that name exists.
- **Fix:** `if (node.agentRef || node.nodeType === 'gate') continue`.
- **Test:** extend the existing export-delete test with a gate node → no gate path in any bucket.

### F15 — External runs that pause never notify

- **Status: FIXED.** Notifier sends pause notifications for `awaiting_approval` and suppresses
  the immediate harness-side `run_paused` duplicate. Tests cover external pause notification and
  harness dedupe.

- **Where:** `src/server/notifier.ts:33-39`. Only `run_paused` notifies; terminal-launched
  ("external") runs emit only `awaiting_approval` (the harness-side `run_paused` comes from
  `classifyAndFinish`, which external runs don't go through). The comment says
  "paused: always notify."
- **Fix sketch:** notify on `awaiting_approval` when the run is NOT harness-managed. The notifier
  can't see the active registry today; simplest: also notify on `awaiting_approval` but dedupe
  per runId (keep a `Set<runId>` of already-notified pauses, cleared on `run_completed`), so
  harness runs don't double-notify when `run_paused` follows.
- **Tests:** notifier test with injected `execNotify` — external `awaiting_approval` notifies
  once; harness sequence `awaiting_approval` → `run_paused` notifies once total.

### F16 — `boldWrapAgentNames` produces broken markdown on substring agent names

- **Status: FIXED.** Agent-name bolding now uses one escaped alternation replacement so names are
  not re-matched inside already-bolded text. Test covers substring names.

- **Where:** `src/workflow/prose-generator.ts:16-22`. "Code Review" + "Review" →
  `**Code **Review****` (longest-first sorting doesn't prevent re-matching inside already-wrapped
  text).
- **Fix sketch:** single-pass replacement — build one alternation regex from all names
  (escape regex metacharacters!), longest-first within the alternation, and replace in one
  `String.replace(re, m => \`**${m}**\`)` call so wrapped output is never re-scanned. Skip names
  that are empty after trim.
- **Tests:** unit test in `tests/workflow/` with substring names; snapshot of orchestrator body.

### F17 — Two rapid `POST /automation-scan` both get 202

- **Status: FIXED.** Scan start now has a synchronous `scanStarting` claim across the diagnostics
  probe window; a concurrent start gets 409. Test uses a slow injected `claudeProbe`.

- **Where:** `src/server/api/automation-scan.ts:129-143`. `await envSnapshot(...)` sits between
  the `isRunning()` check and `runScan()`; the loser's `runScan` throws "already running", which
  is swallowed by `.catch(() => {})` after its 202 already went out.
- **Fix sketch:** add a synchronous claim: module-level `let scanStarting = false`; set it before
  the awaits, clear in a finally around `runScan` scheduling; check it alongside `isRunning()`.
  (Or move the claim into `scanStore.runScan` by splitting claim/execute.)
- **Tests:** fire two POSTs concurrently against `createApp` with a slow injected `claudeProbe` →
  exactly one 202 + one 409.

### F18 — Stop during the approve-resume window reports success but kills nothing

- **Status: FIXED.** Registry entries carry `stopRequested`; `stopRun` marks it, and `registerRun` re-invokes the (real) stop immediately when a request arrived during the placeholder window. `releaseRun` deletes the entry so resumed runs don't inherit stale requests. Test in run-store.test.ts.

- **Where:** `src/server/api/runs.ts:175` registers a placeholder no-op `stop` to claim the run;
  `POST /:runId/stop` (`runs.ts:117-123`) calls it and returns `{ stopped: true }`.
- **Fix sketch:** make the placeholder record a "stop requested" flag; when the real `stop` is
  registered at line 191, invoke it immediately if the flag is set. Or have `stopRun` return
  false for placeholder entries (tag the registry entry) so the client gets 404/409.
- **Tests:** server test simulating the window (register placeholder, call stop, register real
  stop with a spy → spy called).

### F19 — Run event `ts` never validated; garbage timestamps make runs "running" forever

- **Status: FIXED.** `validateRunEvent` requires `Number.isFinite(Date.parse(ts))`; `run-store.summarize` defends pre-existing bad timestamps (unparseable → `stale`, duration 0, sort-safe). Tests in run-events.test.ts + run-store.test.ts.

- **Where:** `src/run-events.ts:34-47` (validation) + `src/server/run-store.ts:58`
  (`Date.now() - Date.parse(last.ts) > STALE_AFTER_MS` — `NaN` comparison is always false →
  status stays `running`; durations become NaN).
- **Fix sketch:** in `validateRunEvent`, require `Number.isFinite(Date.parse(e.ts))`. Optionally
  defend `summarize` too (treat unparseable ts as stale).
- **Tests:** `tests/` run-events unit: bad ts → `{ ok: false }`; run-store: pre-existing bad-ts
  file still summarizes without NaN (defensive branch).

### F20 — InboxItem shows the "started from a terminal" message on a transient fetch failure

- **Status: FIXED.** Inbox event loading distinguishes failed loads from "loaded empty"; fetch
  failures leave events unknown, surface an error, and do not show the terminal-run resumability
  message.

- **Where:** `client/src/components/runs/InboxItem.tsx:32` — events fetch failure resolves to
  `[]`, and line 73 `approveDisabled = !hasPausedEvent && events !== null` treats `[]` as
  "loaded, no pause event" → disables Approve with a misleading explanation for a perfectly
  resumable run.
- **Fix sketch:** distinguish "failed to load" from "loaded empty": keep `events: RunEvent[] |
  null` and on fetch error leave it `null` (plus set a load-error message with a retry), instead
  of catching to `[]`.

### F21 — Rename/autosave race can resurrect the old workflow file

- **Status: FIXED.** `useAutoSave` exposes suspend/resume; `WorkflowView` suspends saves across
  flush + server rename + path swap, then resumes against the new path.

- **Where:** `client/src/views/WorkflowView.tsx:109-119` (`handleRename` flushes, then renames,
  then swaps `filePath`) + `client/src/hooks/useAutoSave.ts`. A keystroke between `flush()` and
  `setFilePath(result.path)` schedules a save against the OLD path; the server rename
  (`src/server/api/workflows.ts:103-138`) unlinks the old file, then the stale save re-creates
  it → two `.cwc` files with the same `meta.id` (workflow list/find-by-id becomes ambiguous).
- **Fix sketch:** add a "saving suspended" guard to `useAutoSave` (expose
  `suspend()/resume()` or a ref flag checked in `runSave`) and hold it across the rename;
  or have `runSave` re-read `filePathRef` AND compare against a "renaming in progress" marker.
  Server-side belt: `POST /workflows` could reject writes to a path whose content `meta.id`
  already exists at a different path — probably overkill; client fix suffices.

### F22 — Precondition/setup shell commands aren't tree-killed on timeout

- **Status: FIXED.** Launcher shell commands now manage timeouts manually and call
  `killProcessTree`; POSIX descendant cleanup was hardened to avoid PID 0 and to follow with
  best-effort SIGKILL. Test covers a timed-out shell command with a live descendant.

- **Where:** `src/server/run-launcher.ts:32-44` (`sh()` uses execFile's `timeout`, which signals
  only `sh`/`cmd` itself; children of a hung precondition survive). The repo already solved this
  class of problem in `src/server/process-tree.ts` (`killProcessTree`).
- **Fix sketch:** spawn without execFile's timeout and manage the timer manually, calling
  `killProcessTree(child)` — mirror the pattern in `src/server/claude-runner.ts:61-116`.
- **Windows note:** the `cmd /d /s /c` branch is exactly the shim case `process-tree.ts`
  documents.

### F23 — `readPackageVersion` breaks when the CLI runs from a source checkout

- **Status: FIXED.** CLI version lookup walks upward to the nearest `claude-cwc` `package.json`
  and falls back to `unknown`.

- **Where:** `bin/cwc.ts:294-299` resolves `../../package.json` relative to the compiled
  location (`dist/bin/` → package root: correct). From source (`bin/` → parent of the repo:
  wrong), the default command throws ENOENT before starting anything. Dev-only annoyance
  (`doctor` already guards with `.catch(() => 'unknown')` at line 308; `main()` at 329 doesn't).
- **Fix sketch:** reuse the walk-up-until-`name === 'claude-cwc'` logic from
  `src/server/api/health.ts:12-27` (extract to a shared helper), or wrap the main-path call in
  the same catch-to-'unknown'.

### F24 — Every node drag is a separate undo entry

- **Status: FIXED.** `MOVE_NODE` coalesces by node id in the history reducer; client history
  coverage verifies consecutive moves undo as one drag.

- **Where:** `client/src/hooks/useWorkflow.ts:103-109` — `coalesceKey` handles `SET_META` and
  `UPDATE_NODE` but not `MOVE_NODE`.
- **Fix sketch:** add `case 'MOVE_NODE': return \`move:${action.payload.nodeId}\`` so successive
  drags of the same node coalesce. (Drags of different nodes still create separate entries —
  correct.)
- **Test:** extend the existing history/undo test in `tests/client/`.

---

## Deliberate non-findings (do NOT "fix" these)

- `POST /api/runs/events` and `POST /api/triggers/*` are token-exempt on purpose (exported
  orchestrators and external webhook callers can't carry the session token). CORS rejects
  cross-origin browsers. Leave as is.
- The UI token cookie is issued to any local process that GETs `/` — same local trust boundary;
  by design.
- `npm run dev:api` disables auth via `CWC_DISABLE_AUTH=1` — intentional dev escape hatch.
- Scheduler-fired runs record `source: 'test'` — "test" means "CWC-harness-managed," not
  literally a test run.
- `hasActiveTestRun` matching by workflowId across triggers — intentional one-run-per-workflow
  concurrency rule.

## Cross-cutting facts an implementer will need

- Slug derivations that must stay in agreement (F1/F3/F9/F13 all touch this set):
  - workflow skill: `'cwc-' + slugify(meta.name)` — exporter.ts:91, export-preview.ts:26,
    automation-scheduler.ts:39, triggers.ts:68, WorkflowView.tsx:81, ExportFlow.tsx:68/284.
  - agent files & `subagent_type`: `agentSlug(name)` — frontmatter `name` MUST be this slug
    (dispatch resolves against it, not the filename — see memory of the v0.11.4 fix).
- Run event files: `~/.cwc/runs/<workflowId>/<runId>.jsonl`; `runId`/`workflowId` are path
  segments, validated by `SAFE_ID` in `src/run-events.ts:30`.
- The ownership markers: agent `<!-- cwc:node:<nodeId>:workflow:<workflowId> -->`, workflow
  `<!-- cwc:workflow:<workflowId> -->`; parsing lives in `src/export/conflict-detector.ts`
  (last non-blank line only).
- Port 3579 is canonical and hardcoded in exported orchestrator prose
  (`prose-generator.ts:243`) and the webhook URL UI — do not parameterize it as part of any fix.
- 594 tests green at audit time; `npm test`, `npm run typecheck`, `npm run build` must all pass
  before shipping any batch.
