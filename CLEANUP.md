# Lean Cleanup Ledger

Date: 2026-06-23
Branch: `chore/lean-cleanup`
Base branch: `feat/automation-native-generation`

## Baseline

- `npm test`: 545/545 passing, 71 files passed, 1 skipped (`tests/generation/planner-replay.test.ts`)
- `npm run typecheck`: clean
- `npm run build`: clean, with the existing Vite chunk-size warning
- Measured source/test tree:
  - Server TS files under `src/`: 65
  - Client TS/TSX files under `client/src/`: 62
  - Test TS files under `tests/`: 74
  - CSS files under `client/src/`: 34
  - Approx LOC under inspected roots: server 5,924; client 18,456; tests 7,295
- Stray build cruft check with `rg --files -g 'node_modules.broken*' -g 'dist' -g '*.tsbuildinfo' -g '.DS_Store'`: no tracked files reported

## Inventory Commands Run

- `npx --yes knip`
- `npx --yes ts-prune`
- `npx --yes depcheck`
- Manual `rg` cross-checks for every strong candidate
- Manual CSS selector scan comparing `.css` class selectors against client TS/TSX string usage

## Findings Before Deletion

### A. Unused Files

Strong candidates:

- `client/src/components/TopBar.tsx`
- `client/src/components/TopBar.css`
  - Evidence: `knip` reports `TopBar.tsx` unused. `rg` over `src`, `client/src`, `tests`, `scripts`, `bin`, and package/config files finds only self references. Active workflow chrome is now in `client/src/views/WorkflowView.tsx` and `client/src/components/shell/WorkflowHeader.tsx`.

- `client/src/components/panels/TriggersSection.tsx`
- `client/src/components/panels/TriggersSection.css`
  - Evidence: `knip` reports `TriggersSection.tsx` unused. `rg` finds only self references outside docs. Current automation UI is `client/src/views/modes/AutomateMode.tsx` plus `client/src/components/automate/AutomationModal.tsx`.

- `client/src/components/RunPanel.tsx`
  - Evidence: `knip` reports the TSX file unused. Current run UI is `client/src/views/modes/RunsMode.tsx`, `client/src/components/runs/InboxItem.tsx`, `client/src/components/runs/SettingsBlock.tsx`, and `client/src/components/runs/format.ts`.
  - Note: do not delete `client/src/components/RunPanel.css` wholesale. `RunsMode.tsx` intentionally imports it because `InboxItem` and `SettingsBlock` still use `run-panel__*` class names.

False positives / protected:

- `src/server/start.ts`
  - Protected entry point. Referenced by `package.json` `dev:api` as `dist/src/server/start.js` and by `bin/cwc.ts` runtime startup.

- `client/src/env.d.ts`
  - Vite type reference included by `client/tsconfig.json`. No current `import.meta.env` usage, but removing it narrows the client typing surface.

- `scripts/capture-planner-replays.ts`
  - Manual replay capture script referenced by `tests/generation/fixtures/planner-replays/README.md` and by the skipped replay test warning. Keep until the native generation cutover/golden fixture path is resolved.

### B. Unused Exports / Functions / Types

Unexport-only candidates, not behavior deletions:

- Module-local constants/functions exported only for no external consumer:
  - `client/src/lib/theme.ts`: `THEME_STORAGE_KEY`, `applyThemePreference`
  - `client/src/views/HomeDashboard.tsx`: `untilTime`
  - `src/agent-generator.ts`: `VALID_TOOLS`, `VALID_COLORS`
  - `src/generation/archetypes.ts`: `ARCHETYPES`
  - `src/generation/compiler.ts`: `defaultDeps`
  - `src/generation/reuse-gate.ts`: `MIN_MATCHES`
  - `src/generation/risk-scanner.ts`: `RISK_RE`
  - `src/run-events.ts`: `RUN_EVENT_TYPES`, `RUN_STATUSES`
  - `src/server/api/automation-scan.ts`: `SCAN_MODELS`
  - `src/server/index.ts`: `startServer`
  - `src/server/run-store.ts`: `STALE_AFTER_MS`
  - `src/server/security.ts`: `createServerToken`

Type/interface unexport-only candidates:

- `client/src/components/WorkflowNode.tsx`: `WorkflowNodeData`
- `src/bfs.ts`: `AnnotatedEdge`
- `src/detection/digest-builder.ts`: `DigestLine`
- `src/detection/types.ts`: `InferredTrigger`
- `src/generation/plan-schema.ts`: `PlanReuse`
- `src/schema.ts`: `CwcMeta`
- `src/server/automation-state.ts`: `TriggerState`
- `src/server/claude-runner.ts`: `RunClaudeOptions`, `RunClaudeResult`
- `src/server/scan-store.ts`: `GenerationState`, `ScanResult`
- `src/server/streaming-analyzer.ts`: `StreamingRunResult`

Riskier export findings:

- `src/detection/analyzer.ts`: `analyzeUnits`
  - Evidence: runtime code imports `buildAnalysisContext` and `parseAutomations`; only tests import `analyzeUnits`.
  - Suggested handling: either keep as test helper/public convenience, or remove the function and rewrite tests to exercise the runtime pieces directly. This is a small behavior-surface reduction but changes tests.

- `client/src/types.ts`: re-exported `CwcMeta`, `CwcArtifact`
  - Evidence: `CwcArtifact` is used through direct schema imports in current code; `client/src/types.ts` is a convenience barrel. Avoid pruning individual type re-exports without checking future client imports.

### C. Duplicate / Superseded Code

- `client/src/components/RunPanel.tsx` is superseded by `RunsMode.tsx` plus `components/runs/*`.
- `client/src/components/panels/TriggersSection.tsx` is superseded by `AutomateMode.tsx` plus `AutomationModal.tsx`.
- `client/src/components/TopBar.tsx` is superseded by `WorkflowView.tsx` plus `WorkflowHeader.tsx`.
- `src/workflow-generator.ts` remains a legacy generation path and type home. It is still runtime-reachable through `CWC_LEGACY_GEN=1`, still tested, and still supplies generation catalog types.

### D. Unused Dependencies

Strong removal candidates:

- `ws`
- `@types/ws`

Evidence:

- `knip` and `depcheck` both report them unused.
- `rg` finds no imports/requires of `ws`, `WebSocket`, or `WebSocketServer` in `src`, `client`, `tests`, `scripts`, or `bin`.
- `npm ls ws @types/ws vite` shows both are direct package entries.

Do not "fix" in this cleanup without separate sign-off:

- `depcheck` reports missing `vite` for `client/vite.config.ts`; current build succeeds because `vite` is available transitively through `@vitejs/plugin-react`/`vitest`. Adding `vite` would be dependency surface work, not dead-code removal.

### E. Dead CSS Selectors

Strong CSS candidates:

- Delete all selectors in `client/src/components/TopBar.css` if `TopBar.tsx` is deleted.
- Delete all selectors in `client/src/components/panels/TriggersSection.css` if `TriggersSection.tsx` is deleted.
- Prune unused selectors from `client/src/components/RunPanel.css` after deleting `RunPanel.tsx`. Keep selectors used by `InboxItem.tsx` and `SettingsBlock.tsx`.

`RunPanel.css` selectors unused after excluding `RunPanel.tsx`:

- `run-panel__close`
- `run-panel__empty`
- `run-panel__event`
- `run-panel__event--run_completed`
- `run-panel__event-agent`
- `run-panel__event-cost`
- `run-panel__event-msg`
- `run-panel__event-type`
- `run-panel__gear`
- `run-panel__header`
- `run-panel__list`
- `run-panel__meta`
- `run-panel__pause-label`
- `run-panel__pause-toggle`
- `run-panel__run`
- `run-panel__run--open`
- `run-panel__status--aborted`
- `run-panel__status--complete`
- `run-panel__status--error`
- `run-panel__status--escalated`
- `run-panel__status--paused`
- `run-panel__status--running`
- `run-panel__status--stale`
- `run-panel__stop`
- `run-panel__summary-cost`
- `run-panel__summary-outcome`
- `run-panel__timeline`
- `run-panel__timeline-summary`
- `run-panel__toggle-btn`
- `run-panel__toggle-btn--on`
- `run-panel__when`

CSS false positives:

- React Flow classes in `client/src/components/Canvas.css` are library-owned DOM classes.
- Dynamic status/modifier classes such as `runs-mode__run-status--${status}`, `automate-mode__pill--${state}`, `toast--${tone}`, and `gen-agent__msg--${role}` are runtime-composed and should stay.
- `client/src/views/WorkflowView.css` contains likely stale runs/automate layout selectors, but removing them should be a separate, small CSS batch after checking current `WorkflowView.tsx` mode wrappers.

### F. Leftover Dev Comments / Debug Code

No obvious removable debug code found.

- `console.log`/`console.error` in `bin/cwc.ts` and `src/server/index.ts` are CLI/server output.
- `console.warn` in `tests/generation/planner-replay.test.ts` explains the skipped replay fixture state.
- `client/src/views/DetectHero.tsx` has a `viewTransition` comment and option; it appears intentional UI code, not a debug leftover.
- Several `eslint-disable-line react-hooks/exhaustive-deps` comments exist despite no lint setup. They document intentional effect dependencies and should not be removed in this behavior-preserving pass.

## Flagged But Not Removed

- Legacy workflow generation:
  - `src/server/api/automation-scan.ts` still has `CWC_LEGACY_GEN=1`.
  - `tests/server/automation-scan.test.ts` still asserts the legacy path.
  - `tests/generation/planner-replay.test.ts` is skipped because no replay fixtures are committed.
  - The plan doc says legacy removal is gated on real goldens/replay fixtures. Removing it now would change runtime behavior and violate the requested constraints.

- Starter templates:
  - `client/src/templates/index.ts` exports three templates and `HomeDashboard.tsx` renders all via `TEMPLATES.map`. Removing any template would remove visible starter UI.

- `HelpModal.tsx` and `HomeDashboard.tsx` inline icons:
  - Icons are locally used. Cleanup here would be a visual/code-style refactor, not dead-code removal.

## Proposed Batches For Sign-Off

1. Remove obsolete client components:
   - Delete `client/src/components/TopBar.tsx`
   - Delete `client/src/components/TopBar.css`
   - Delete `client/src/components/panels/TriggersSection.tsx`
   - Delete `client/src/components/panels/TriggersSection.css`
   - Delete `client/src/components/RunPanel.tsx`
   - Prune only unused old-panel selectors from `client/src/components/RunPanel.css`

2. Remove unused dependencies:
   - Remove `ws` from `dependencies`
   - Remove `@types/ws` from `devDependencies`
   - Update `package-lock.json` via npm install/package-lock update only, no dependency upgrades

3. Unexport module-local symbols:
   - Convert safe `export const`/`export function`/`export interface` findings to local declarations where there is no external consumer.

4. Optional later batch:
   - Investigate and possibly remove `analyzeUnits` plus its direct tests, or keep it as an intentional test/public helper.
   - Investigate stale `WorkflowView.css` selectors after confirming no mode-specific wrappers still use them.

## Changes Applied

### Batch 1: obsolete client component cleanup

Status: applied and verified.

Removed:

- `client/src/components/TopBar.tsx`
- `client/src/components/TopBar.css`
- `client/src/components/panels/TriggersSection.tsx`
- `client/src/components/panels/TriggersSection.css`
- `client/src/components/RunPanel.tsx`

Pruned:

- `client/src/components/RunPanel.css`
  - Removed old panel shell, run list, run timeline, global pause, gear, and status selectors tied only to deleted `RunPanel.tsx`.
  - Kept shared inbox, diff, and settings selectors used by `client/src/components/runs/InboxItem.tsx` and `client/src/components/runs/SettingsBlock.tsx`.

Evidence:

- `rg` found no active references/imports of `TopBar`, `TriggersSection`, or `RunPanel.tsx`.
- A CSS selector scan of the remaining `RunPanel.css` found 24 selectors and no literal-missing candidates against active client TS/TSX source.
- Diffstat before ledger update: 6 files changed, 1 insertion, 1,744 deletions.
- Built client CSS changed from 165.87 kB gzip 22.08 kB to 161.20 kB gzip 21.59 kB.

Verification after code change:

- `npm test`: 545/545 passing, 1 skipped replay fixture test.
- `npm run typecheck`: clean.
- `npm run build`: clean, with the existing Vite chunk-size warning.
