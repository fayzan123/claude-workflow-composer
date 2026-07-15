# Data Preservation Hardening Implementation Plan

**Design:** `docs/specs/2026-07-14-data-preservation-hardening-design.md`

## 1. Add Atomic Workflow Creation

- Add server tests for sequential and concurrent same-name creation.
- Add `POST /api/workflows/create` with exclusive-write suffix allocation.
- Add the client API method and switch Home creation to it.
- Keep save-by-path unchanged for autosave.
- Reserve rename destinations with an exclusive write and preserve the losing source on
  collision.
- Reserve a workflow through deletion so active/paused runs block it and new runs cannot race
  the final unlink.

## 2. Checkpoint Isolated Runs

- Add `checkpointWorktree()` tests for clean and dirty worktrees.
- Commit tracked/untracked non-ignored work using a command-local CWC identity.
- Call checkpoint after pause classification and before terminal cleanup.
- Checkpoint changes from a failed setup command before cleaning up its worktree.
- Preserve and report the worktree if checkpointing fails.
- Retry checkpointing from orphan cleanup before forced removal, and retain directories
  whose Git ownership/linkage cannot be verified.

## 3. Verify Lifecycle Regressions

- Serialize event appends per run and make external-event admission atomic with the append.
- Record a server-owned resume marker before accepting logger events from an approved resume.
- Cover terminal/external append ordering and resume reopening in run-store and route tests.

```bash
npx vitest run tests/server/workflows.test.ts
npx vitest run tests/server/run-isolation.test.ts tests/server/run-launcher.test.ts tests/server/runs-gates.test.ts
npm run typecheck
npm test
npm run build
```

Review filesystem and process behavior on the full macOS/Linux test path and rely on CI
for the Windows Node 20/22 matrix.
