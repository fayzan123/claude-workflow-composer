# Managed Run Manifests And Isolated Result Actions

**Date:** 2026-07-15
**Status:** Implemented; awaiting review
**Scope:** Stage 1 of the approved product roadmap

## Trust Boundary

Managed run JSONL files remain append-only observational timelines. They can describe steps,
artifacts, gates, and terminal messages, but they cannot authorize filesystem or Git operations.
`POST /api/runs/events` sanitizes server-owned fields and never creates or transitions a manifest.

Every CWC-launched run instead receives `<runId>.manifest.json` beside its JSONL file. Only this
server-owned record can authorize diff, approval resume, rejection cleanup, orphan cleanup, Apply,
or Discard. Event-only legacy runs remain visible with every privileged action disabled.

## Durable State

Manifest version 1 records immutable run/workflow/skill/trigger identity, requested isolation and
base ref, the original cwd, canonical Git common-directory identity, resolved base SHA, CWC-created
worktree/branch, checkpointed result SHA, completion status, result disposition, action failure,
and creation/update/transition timestamps.

Lifecycle and result disposition are independent:

| Lifecycle examples | Meaning |
|---|---|
| `claimed` → `preparing` → `running` | Launch preparation and live execution |
| `paused` → `resuming` → `running` | Approval gate round-trip |
| `checkpointing` → `cleaning` | Process is done; preserve output before removing isolation |
| `completed`, `failed`, `aborted`, `rejected` | Managed terminal states |

| Disposition | Meaning |
|---|---|
| `unavailable` | No safely actionable preserved branch |
| `ready` | Exact result SHA is retained on the owned branch |
| `applying` / `discarding` | Durable in-progress marker for restart reconciliation |
| `applied` | Destination truthfully reached `appliedSha` |
| `discarded` | The verified result branch no longer exists |

Writes use a same-directory temporary file plus atomic rename. Each transition rereads the current
file and runs through a per-run serialized queue. Apply and Discard hold that same exclusive queue
for their full preflight, mutation, and final transition, so competing requests cannot both win.

## Git Operations

Apply is available only for a successful terminal worktree run with a `ready` result. Immediately
before mutation CWC verifies repository identity, a completely clean destination (including
untracked files), destination `HEAD === baseSha`, result-object existence, exact branch SHA, and
base ancestry. It invokes `git merge --ff-only <resultSha>` and records the resulting HEAD. It does
not stash, reset, rebase, cherry-pick, create a merge commit, or resolve conflicts.

Discard requires `confirmed: true`. CWC re-verifies repository identity, exact branch SHA, and that
the branch is not checked out in any worktree. It deletes the ref with Git's expected-old-SHA form,
so a branch that moves during the operation survives. It never deletes a checkout or working files.

Approval rejection first checkpoints pending non-ignored work, then verifies the paused worktree's
repository, current branch, clean state, and SHA, removes only that worktree, and deletes the same
expected CWC ref. A checkpoint or verification failure retains the recoverable data.

## Recovery

Checkpoint failure leaves the worktree in place, records an error terminal, and exposes neither
Apply nor Discard. Startup orphan cleanup considers only valid manifests and exact
`<worktreesRoot>/<runId>` paths. It can resume `checkpointing` or `cleaning`, but leaves paused,
legacy, malformed, unknown, or unverifiable directories untouched.

An interrupted `applying` request reconciles to `applied` when destination HEAD already equals the
result, retries from the unchanged base, or stops with an actionable conflict on any third state.
An interrupted `discarding` request can finalize when the verified branch is already absent.

## API And Runs UI

- `GET /api/runs/:runId/diff?workflowId=...`
- `POST /api/runs/:runId/apply` with `{ workflowId }`
- `POST /api/runs/:runId/discard` with `{ workflowId, confirmed: true }`

Missing input returns `400`, unknown runs return `404`, and state/preflight conflicts return `409`
without hiding the result branch. Run summaries carry manifest-derived disposition, result/applied
SHA, action availability, and the latest preflight failure.

Runs renders a compact result strip beside the existing timeline and diff. It prevents duplicate
submissions, uses an inline two-step Discard confirmation, retains failure text in context, and
refreshes the summary, timeline, and diff after each action. The strip stacks at narrow widths,
keeps both actions reachable, and uses coarse-pointer touch targets and existing theme/motion tokens.
