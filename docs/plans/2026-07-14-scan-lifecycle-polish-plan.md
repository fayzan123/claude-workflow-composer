# Scan Lifecycle Polish Implementation Plan

**Design:** `docs/specs/2026-07-14-scan-lifecycle-polish-design.md`

## 1. Make Dismissal Reversible

- Add a guarded restore route beside dismiss in `automation-scan.ts`.
- Persist the candidate's pre-dismiss status/detail so Undo is state-preserving.
- Add the client API method and an actionable toast primitive.
- Offer Undo after a successful dismissal and reconcile through the server.
- Extend the automation-scan API test through dismiss and restore.

## 2. Move Scan Completion To The Shell

- Extend the app-level automation watcher with transition-based scan notifications.
- Suppress already-terminal scan state during watcher initialization.
- Add a Review action that routes to `/detect`.
- Remove the duplicate route-local completion effect.

## 3. Reconcile Fallback State

- Merge persisted log entries during the one-second GET fallback.
- Export and test the deterministic log merge helper.

## 4. Persist Preferences And Respect Motion

- Add validated local storage helpers for the scan model.
- Read on mount and write on selection.
- Stop the promoting pulse and use immediate log scrolling under reduced motion.

## 5. Verify

```bash
npx vitest run tests/server/automation-scan.test.ts
npx vitest run tests/client/scan-state.test.ts tests/client/scan-watcher.test.ts
npx vitest run tests/client/scan-log.test.ts tests/client/scan-preferences.test.ts
npm run typecheck
npm test
npm run build
```

Review the combined diff and leave `task.md` untouched.
