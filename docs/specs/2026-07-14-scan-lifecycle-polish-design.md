# Scan Lifecycle Polish Design

**Date:** 2026-07-14
**Status:** Approved for implementation
**Scope:** Reversible candidate dismissal and reliable Detect notifications/state

## Problem

The primary scan re-entry path is now reliable, but several smaller lifecycle gaps can
still make persisted state look lost. Dismissal has no reverse operation, scan completion
is only announced while Detect is mounted, the GET fallback does not recover log entries
missed by SSE, the model choice resets on every visit, and one motion state ignores the
user's reduced-motion preference.

## Decisions

1. **Dismissal is reversible.** The server exposes a restore operation that returns a
   dismissed candidate to its prior `new`, promoted, cancelled, or failed state. Detect
   removes the card immediately and offers an **Undo** toast action. The server remains
   the source of truth; legacy dismissed records without origin metadata restore to `new`.
2. **The shell owns scan completion notifications.** The existing app-level automation
   watcher announces scan completion/failure on every route. Route-local scan toasts are
   removed to prevent duplicates. Notifications include a **Review** action.
3. **Polling is a complete fallback.** Each fallback GET merges persisted log entries as
   well as status, generation, and candidate state, so an SSE disconnect is recoverable.
4. **Model selection is a browser preference.** Store the last valid model key in
   `localStorage`; it is not part of the scan result or server configuration.
5. **Reduced motion applies to every Detect animation.** The promoting pulse stops and
   log auto-scroll becomes immediate when reduced motion is requested.

## Safety And Failure Behavior

- Restore is rejected while workflow generation is active, matching dismissal.
- Restore returns `404` for an unknown candidate and `409` for a candidate that is not
  currently dismissed.
- An Undo failure refreshes persisted state and surfaces an error; it does not recreate a
  client-only candidate.
- A terminal scan that existed before the app loaded does not produce a stale toast.

## Non-goals

- Multiple saved scans or scan comparison.
- Restoring candidates from older scans.
- Cross-device preference synchronization.
- Codex or ChatGPT ingestion.

## Acceptance Criteria

- Dismiss then Undo restores the same persisted candidate and its prior lifecycle state.
- A scan observed in progress produces one completion/failure toast even off Detect.
- A stale completed scan produces no toast on app load.
- GET polling restores missed log entries without duplicates.
- A valid selected model survives remount; invalid stored values fall back to Sonnet.
- Detect has no active animation or smooth auto-scroll under reduced motion.
