# Scan Lifecycle And Re-entry Design

**Date:** 2026-07-14
**Status:** Approved for implementation
**Scope:** Claude Workflow Composer Detect and Home surfaces

## Problem

The latest history scan is persisted and `/detect` can rehydrate it, but Home does
not consistently expose that route. While a scan is running, the only scan CTA is
disabled. Completed low-confidence, empty, dismissed, and failed results can also
hide the review path or present a new scan as the only action. A server restart can
leave a persisted `running` result that no process owns.

The result is a false impression that scan state was lost even though it remains in
`~/.cwc/automation-scan.json`.

## Decisions

1. **Review and start are different actions.** Viewing the active/latest scan routes
   to `/detect` and never starts a scan. Starting again remains an explicit secondary
   action.
2. **Every non-idle state is reviewable.** Running, done, error, generation-active,
   generation-failed, and generation-complete states retain a route to Detect.
3. **Confidence affects previews, not existence.** Home may tease only stronger
   candidates, but it must derive whether results exist from all visible candidates.
4. **Interrupted work is terminalized.** On server startup, a persisted scan marked
   `running` becomes an actionable interrupted error because no in-memory job can
   still own it.
5. **Generation completion has a destination.** The completed candidate exposes
   **Open workflow** when its persisted generation state contains a workflow id.
   CWC does not force navigation after the user has left Detect.
6. **No scan-history expansion in this change.** The store continues to retain the
   latest scan only. A later scan-history feature requires its own storage design.
7. **Replacement scans do not erase decisions.** While a replacement scan is running
   or failed, CWC retains the prior dismissed/promoted results internally. Partial
   replacement results stay hidden, and the decisions reconcile onto the next
   successful result set by automation id.

## Home State Contract

| State | Primary action | Secondary action |
| --- | --- | --- |
| idle | Scan my history | none |
| running | View active scan | none |
| done with results | Review automations | Scan again |
| done without results | View last scan | Scan again |
| error | Review failed scan | Try again |
| generation active | View generation | Cancel when available |
| generation complete | Open workflow or Review automations | Scan again |

Home also exposes a stable **History scan** navigation action outside conditional
hero content so future hero changes cannot remove route discoverability.

## Recovery Contract

When `createScanStore()` loads a persisted `status: 'running'` result, it sets:

- `status: 'error'`
- `finishedAt` to the recovery time
- an error explaining that the server restarted before the scan completed
- a matching error log entry so the reason is visible in Detect
- no partially analyzed candidates exposed as completed results
- the prior completed result set retained for decision reconciliation

The recovered state is persisted so subsequent restarts and clients see the same
terminal result.

## Testing

- Extract Home state derivation into a pure helper and cover every state above.
- Add a real-filesystem scan-store restart test.
- Cover failed and interrupted replacement scans without losing dismiss/promote decisions.
- Cover low-confidence results independently from teaser filtering.
- Cover promoted candidate behavior with and without a completed workflow id.
- Run focused client/server tests, then typecheck, the full suite, and build.

## Non-goals

- Multiple saved scans or scan comparison.
- Codex or ChatGPT ingestion.
- Analysis-provider changes.
- Automatic navigation when background work finishes.
