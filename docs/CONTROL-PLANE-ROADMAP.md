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
