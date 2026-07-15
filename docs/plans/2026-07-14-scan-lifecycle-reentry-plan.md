# Scan Lifecycle And Re-entry Implementation Plan

**Design:** `docs/specs/2026-07-14-scan-lifecycle-reentry-design.md`

## 1. Make Home State Deterministic

- Extract a pure helper for Home scan presentation and actions.
- Derive result existence from all non-dismissed automations.
- Keep confidence filtering limited to preview selection.
- Render explicit running, empty, error, generation, and completed states.
- Add focused client logic tests.

## 2. Preserve Route Discoverability

- Add a stable Home **History scan** action.
- Route review actions to `/detect` without `autostart`.
- Keep `?autostart=1` only on explicit new-scan actions.

## 3. Recover Interrupted Scans

- Reconcile persisted `running` scan results during store creation.
- Persist an interrupted terminal error with `finishedAt` and a visible log entry.
- Hide partial candidates while retaining the prior completed set until a replacement succeeds.
- Reconcile dismissed/promoted decisions across failed and interrupted replacements.
- Add a temp-filesystem reload regression test.

## 4. Complete Promotion Handoff

- When generation has a workflow id for a promoted candidate, show **Open workflow**.
- Keep regeneration available as a secondary action.
- Do not auto-navigate on background completion.

## 5. Verify

```bash
npx vitest run tests/server/scan-store.test.ts
npx vitest run tests/client/scan-state.test.ts
npm run typecheck
npm test
npm run build
```

Review the final diff for unrelated changes and confirm `task.md` remains untouched.
