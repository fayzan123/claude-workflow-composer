# Control Plane Roadmap

> The thing that makes CWC un-replaceable by a Claude Code conversation is **isolated,
> gated, scheduled, audited autonomous runs**. That capability is the most complete part
> of the backend. The gaps below are all in the *operational trust surface* — persistence,
> completed-run visibility, liveness, and legibility — i.e. the reasons you'd actually open
> the app in the morning. This doc tracks closing them.

The loop we're optimizing for:

> "Every night, run my workflow on these repos. Pause at gates. In the morning I open CWC,
> see what each run did, review the diff, approve or reject from the inbox."

---

## Gaps

### 1. Completed-run diff review — **P0**

**Problem.** Morning review is blind for the exact runs you walked away from. On completion the
worktree is removed (`run-launcher.ts` `classifyAndFinish`, `keepBranch: true`), so the diff
endpoint's `getDiff(worktreePath, …)` reads a path that no longer exists → `diff: null`. The
`InboxItem` only renders a diff for `status === 'paused'` anyway. So an autonomously *completed*
run shows a timeline and a cost figure but **not what it changed**.

**Approach.** The run's branch (`cwc/<slug>/<runId>`) survives completion. Make the diff endpoint
resolve the diff against the surviving branch when the live worktree is gone:
- live worktree exists → `diff baseSha..HEAD` + `status --short` (unchanged, for paused runs)
- worktree gone but branch kept → `diff baseSha..<branch>` from the repo cwd
- in-place run (no worktree) → `diff baseSha..HEAD` from cwd (unchanged)

Surface the diff in the RunsMode **detail pane** for completed runs, not just the paused inbox.
No schema change, no storage bloat.

- [x] `getDiff` accepts an optional ref; branch-mode status uses `--stat`
- [x] `/:runId/diff` resolves live-worktree vs. kept-branch vs. in-place
- [x] RunsMode detail pane shows the diff for completed (not just paused) runs
- [x] Tests: completed worktree run still yields a diff after worktree removal

### 2. Boot / login persistence — **P0**

**Problem.** `cwc start` spawns the server `detached` + `unref()` (survives the launching
terminal — good), but it dies on reboot/logout. There's no launchd agent. "Every night" silently
means "every night I don't reboot." The unattended promise has an unadvertised asterisk.

**Approach.** Add a launchd user agent (`~/Library/LaunchAgents/com.cwc.server.plist`) installed
via `cwc install-service` / removed via `cwc uninstall-service`, with `RunAtLoad` + `KeepAlive`.
macOS-first (matches the notifier). Until installed, the UI should state the scheduler is
session-bound rather than implying 24/7.

- [x] `cwc install-service` writes + loads the launchd plist
- [x] `cwc uninstall-service` unloads + removes it
- [x] UI surfaces service state (persistent vs. session-bound)

### 3. Live dashboard — **P1**

**Problem.** The dashboard fetches "Recent runs" and "Needs approval" once on mount
(`HomeDashboard.tsx`); only the Workflows tab polls. Leave mission control open and it goes stale —
while a working SSE stream (`/api/runs/stream`) sits unused by the dashboard.

**Approach.** Subscribe the dashboard to `/api/runs/stream` and refresh the paused/recent widgets
on relevant events. Mostly plumbing; large perception payoff.

- [x] Dashboard subscribes to SSE and live-updates approvals + recent runs

### 4. Trigger legibility — **P1**

**Problem.** A trigger only fires if `armedHash === armHash(t)`; editing it silently disarms.
Easy to believe something is scheduled when it isn't. State already records `lastFiredAt`,
`lastSkip`, `runsCount` — it's just not surfaced.

**Approach.** Surface per-trigger status — `armed · next fire 2:00am · last run 6h ago ✓ ·
last skip: daily cap` — on the dashboard / Automate mode. Add an endpoint that returns computed
trigger status (armed, nextFireAt, lastFiredAt, lastSkip).

- [x] Endpoint returns computed trigger status (armed/nextFire/lastFired/lastSkip)
- [x] Dashboard / Automate mode renders it

### 5. Multi-repo target model — **P2**

**Problem.** A trigger fires one workflow in one `cwd`. Running one workflow across N repos = N
hand-maintained triggers. The fleet framing has no first-class model.

**Approach.** Let a workflow/trigger carry a list of target repos; fan one firing into N isolated
runs (respecting the concurrency cap). Schema + scheduler + UI.

- [x] Trigger carries `targets[]` (repo paths)
- [x] Scheduler fans one due trigger into N runs
- [x] UI to manage the target list

---

## Order of work

1, 2 (P0) → 3, 4 (P1) → 5 (P2). Items 1 and 3 most directly unblock dogfooding: #1 gives you
something worth reviewing, #3 makes the app feel alive.

---

## Dogfooding findings (2026-06-14)

Surfaced while smoke-testing the gate → review → approve loop. The diff *content* is correct;
the diff *viewer* (`RunsMode` `runs-mode__diff-body`) is bare-minimum. Follow-up polish:

- [x] **Color the diff (must-do, ~20 lines).** Done — `client/src/lib/diff-lines.ts`
  (`diffLineKind`, unit-tested) + colored line spans in `RunsMode` via `--color-success*` /
  `--color-error*` tokens.
- [ ] **Move the diff above the timeline (should-do).** It's currently last in the detail pane —
  you scroll past the whole event log to reach the thing you decide on. For review-then-approve
  it's the headline; put it at the top of the detail (or directly under the approval card).
- [ ] **Co-locate review + action.** Diff lives in the run detail; Approve/Reject live in the
  inbox card → scroll down to read, up to act. Put the diff in the same viewport as the buttons.

Decision standing: keep raw diff (not plain-English) — approver is a developer.

- [ ] **Schedules widget ignores global pause.** When automations are paused globally, the
  Schedules row still shows "on · next in 15h" — contradictory (it will NOT fire). The row should
  reflect the global pause (e.g. "on · paused globally", or mute/strike the next-fire time). The
  `/automations/triggers` rows could carry the global `paused` flag, or the dashboard already
  knows it (`globalPaused`) and can override the display.

- [ ] **Raw-cron escape hatch in the schedule modal.** Schedule UI is preset-only (frequency
  dropdown + time). Add a raw cron field under the existing **+ ADVANCED** disclosure that writes
  the same `CwcTrigger.schedule` string (no backend change — scheduler is already cron-capable),
  validates via `croner`, and renders the same `describeCron` + next-run preview. Keep presets as
  the default (progressive disclosure: presets for the 90%, raw cron for power users).

---

## Phase 2 — Agent execution transparency (the big one)

> Surfaced 2026-06-14 dogfooding. The biggest control-plane gap: the run timeline shows
> orchestrator-reported *milestones* ("Started / Finished / Produced File"), not the agent's
> actual reasoning, tool calls, and tool results. The rich trace is produced by `claude -p`
> and then **thrown away**. For an unattended control plane, trust comes from seeing *how/why*
> an agent did something, not just *that* it finished. This is more important than any single
> P0/P1 gap above and is its own project (brainstorm + plan before building).

**Root cause:** `src/server/workflow-runner.ts:59` spawns with `--output-format json`, which
buffers the whole run and emits one final JSON object; the runner (`:99-103`) reads only the
final `result`/`cost`/`session_id`. All intermediate turns are discarded. The timeline events
are self-reported by the exported skill orchestrator via `POST /api/runs/events` curls — coarse
by construction.

**Direction:** switch to `--output-format stream-json --verbose`; consume the child's stdout as
a line-delimited event stream (assistant text + `tool_use`, user `tool_result`, final result);
persist it (separate per-run transcript file) and surface a per-step "what the agent did" view,
reusing the existing SSE + run-store infra.

**Open questions / tradeoffs to scope:**
- [ ] Volume — stream-json is chatty; efficient storage + progressive rendering needed.
- [ ] Schema — current `RunEvent` is milestone-shaped; map the agent stream or store transcript alongside + add a dedicated view.
- [ ] Subagents — how much of a Task-delegated subagent's internal turns surface (needs a spike).
- [ ] Gate resume — capture the `--resume` session's stream too.

- [ ] Brainstorm + write a plan for Phase 2 before implementing.

---

## Product thesis — automations born from conversation (the demand problem)

> Surfaced 2026-06-14. This is strategy, not a feature. Captured to brainstorm as its own thing.
> It may be the actual product, not an addition to it.

**The real gap isn't *how* to make an automation — it's *if / why / when*.** The whole product
(and every workflow tool: Zapier, n8n) assumes the user arrives already knowing they want a
scheduled job, what it does, and when it runs. We built the *how* (presets, cron, targets) and
skipped the hard part: **most people — expert or not — can't answer "should this be automated,
and what should it be?" cold.** Writing `0 3 * * *` was never the barrier; *recognizing the
opportunity* is.

**Why this is the root gap, not a side issue.** It's the same root as "would anyone switch?"
People don't carry a backlog of automations they wish they had. So a build-it-yourself tool hands
them a blank canvas and waits for an intent they don't have. The canvas stays empty. **We serve
demand; we don't create it — and pre-formed demand for this barely exists yet.**

**The resolution (ties the whole strategy together).** Don't make the automation something you go
to a canvas to author. Make it **born from the conversation you're already having**, and
**discovered from repetition**:

> You work with Claude in the terminal as normal. You run the tests, fix the flakes, open a PR.
> You do it again two days later. The system notices the repeated shape and offers: "You've done
> this 3× this week — want it to run nightly and just show you the diff to approve?" Yes promotes
> that conversation into a scheduled, gated, observable workflow that then lives in CWC's control
> plane.

This fixes three things at once:
- **if/why/when gap** — you didn't have to know you wanted it; repetition surfaced it, and the
  "why" is self-evident (you keep doing it).
- **conversation-vs-GUI tension** — the automation is created *by talking*, not by leaving the
  conversation for a canvas. CWC's job becomes operating + auditing it (the part conversation
  can't do).
- **empty-canvas problem** — nobody starts blank; automations are discovered from real behavior.

Reframes CWC from "a place to build automations you already want" → "the system that notices
which repeated work *should* be automated, and gives the resulting agents a home." Demand-
**creating**, not demand-serving.

**Hard parts (don't sell the dream without these):**
- **Clippy risk** — behavior-based suggestion is powerful when right, infuriating when wrong. Bar
  for a sparse, well-timed, correct suggestion is high.
- **Needs to see your work** — discovery-from-repetition means mining Claude Code session history
  (`~/.claude`). Doable (the history exists) but a real privacy/trust design problem.
- **Scope** — bigger than the control plane; but it's the *acquisition funnel* for it. Without it
  the control plane is a beautiful empty room.

**Cheap near-term moves that point the same direction (no big build):**
- [ ] **Reframe templates by pain, not structure** — "Flaky tests eating your mornings," "stale
  PRs," "dependency drift" — not "Full-Stack Feature Builder." Let people recognize *their*
  problem.
- [ ] **Lead with "when X happens," not cron** — event triggers (on push, on PR open) map to
  *why* far better than a time-of-day the user has to invent. Webhook triggers already exist;
  surface them ahead of cron in the automation UI.

- [ ] Brainstorm this as its own product direction (separate from the control-plane gaps).

---

## Reality check & validation-first pivot (2026-06-14)

A hard reality-check (Reality Checker agent, evidence-verified against the code) on the
Promote-to-Automation direction. Verdict: **good engineering path, premature product path.**

**The core finding:** the engineering is real and tested, but **demand is unvalidated and the
roadmap itself concedes it** ("we serve demand; we don't create it — pre-formed demand barely
exists yet"). The damning logic: Promote-to-Automation, honestly scoped (the autonomous `Stop`
hook deferred), only fires when the user *already asked* — but such a user already knows what to
automate, so it does **not** solve the *if/why/when* gap the thesis claims. It's demand-*serving*,
not demand-*creating*; the demand-creating part is the deferred hook. The only usage evidence we
have is one contrived dogfood (an agent writing one note file).

**Decision: hold the Promote build. Validate demand first.** The Promote spec
(`docs/superpowers/specs/2026-06-14-promote-to-automation-design.md`) stands as a document and
its §1 has been corrected to say demand-*serving until the hook*. Do NOT start its implementation
plan until the gate below returns signal.

**Prioritized next steps:**
- [x] **launchd ↔ `cwc stop` reliability (P0).** Done — CLI is now service-aware: when a launchd
  service is installed it is the source of truth; `cwc` ensures it's loaded (no competing spawn /
  port collision) and `cwc stop` unloads it (no KeepAlive respawn). Precondition for a real
  unattended dogfood. *(branch `service-reliability-fix`)*
- [x] **§1 spec honesty correction** — Promote spec now states it's demand-serving until the hook.
- [ ] **Two-week self-dogfood on ONE real recurring job** (the gate for everything). Real repo,
  armed + gated, approve real diffs each morning. If the builder won't sustain it over just
  asking the terminal, no user will → pivot to what the dogfood reveals.
- [ ] **Cheap demand probes (no Promote build):** templates reframed *by pain*; lead with
  *"when X happens"* triggers. (Same as the two product-thesis bullets above.)
- [ ] **Remaining cheap prereqs:** global-pause legibility; ref-node `tools`/`skills` prose honesty
  (`prose-generator.ts:90-91`).
- [ ] **Only if the dogfood earns it:** build Promote — and treat the `Stop` hook (autonomous
  detection) as *the* feature, not the deferred afterthought.
