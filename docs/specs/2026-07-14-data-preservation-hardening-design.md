# Data Preservation Hardening Design

**Date:** 2026-07-14
**Status:** Approved for implementation
**Scope:** Workflow lifecycle, managed-run authority, and isolated-run cleanup

## Problem

Two existing flows can silently discard user work:

1. Home asks the server for a predictable default workflow path and then saves with
   overwrite semantics. Creating the same blank/template workflow again can replace the
   first `.cwc` file.
2. Completed isolated runs force-remove their worktree and retain only the branch. Any
   tracked or untracked changes the agent did not commit disappear during cleanup.

Autosave must continue overwriting the workflow file the user already opened, and an
explicit gate rejection must continue discarding its isolated branch. The unsafe behavior
is limited to *creation* and *successful/failed run cleanup*.

## Decisions

### Collision-safe creation

- Add a dedicated create endpoint. The server derives a slug and atomically reserves
  `<slug>.cwc`, then `<slug>-2.cwc`, and so on using an exclusive filesystem write.
- Retry only on `EEXIST`; surface every other filesystem failure.
- Existing save-by-path remains overwrite-capable for autosave.
- Home creates through the new endpoint instead of composing default-path plus save.
- Rename reserves its destination with the same exclusive-write guarantee, so concurrent
  renames cannot overwrite one another.
- Deletion acquires a workflow reservation before checking persisted run state and holds it
  through unlink. New managed launches cannot enter between the active-run check and deletion.
- Active and paused managed runs block deletion with an actionable conflict response.

### Managed event ordering

- Server and external event appends serialize per run.
- External event admission checks the latest server-owned event inside that serialized append;
  a managed terminal or pause closes admission atomically.
- Approval writes a server-owned resume marker before spawning the resumed process, reopening
  observational logging without allowing external events to forge lifecycle authority.

### Isolated-run checkpoint

- Before removing a non-paused run worktree, inspect Git status. If dirty, stage all
  non-ignored tracked/untracked changes and create one deterministic CWC result commit.
- Use a command-local CWC Git identity, disable signing, and skip hooks. Do not mutate the
  repository's Git configuration.
- Keep the run branch, as today, so Runs diff can show the complete result after cleanup.
- If checkpointing fails, mark the run errored with an actionable retained-worktree path
  and do not remove the worktree.
- Gate pause continues to keep the live worktree. Explicit rejection remains the only
  lifecycle action that deliberately discards the isolated branch.
- A failed setup command checkpoints any changes it made before cleanup. A clean setup
  failure still removes its empty branch.
- Orphan cleanup retries checkpointing before removing a completed/stale CWC worktree.
  If Git linkage cannot be verified, it retains the directory for manual recovery.

## Acceptance Criteria

- Sequential and concurrent same-name creates return distinct paths and preserve every
  workflow id.
- Concurrent renames to one destination preserve the losing source file.
- A workflow cannot be deleted while a managed run is active or paused, and a new launch cannot
  race an already admitted delete.
- Autosave still updates an existing path.
- A completed isolated run that writes tracked and untracked files leaves both on its
  retained branch after the worktree is removed.
- A clean run does not create an empty checkpoint commit.
- A checkpoint failure never force-removes the dirty worktree.
- Paused and explicitly rejected lifecycle behavior remains unchanged.
- A setup failure that changed files leaves those files on the retained result branch.
- An unverifiable orphan directory is retained rather than force-removed.
- A terminal managed event wins its append race with later external logging.

## Non-goals

- User-selectable workflow filenames.
- Automatically merging a run branch into the user's base branch.
- Preserving ignored build artifacts.
- Changing in-place run behavior.
