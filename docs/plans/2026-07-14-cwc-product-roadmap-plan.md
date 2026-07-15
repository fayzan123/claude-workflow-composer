# CWC Product Roadmap Implementation Plan

**Design:** `docs/specs/2026-07-14-cwc-product-roadmap-design.md`

This is a staged plan, not one release-sized change. Complete and verify each stage independently.
Before implementation, turn each stage into a focused design addendum if source inspection exposes
an unresolved safety or compatibility choice.

## 0. Lock The Reliability Baseline

- Keep the current Claude Code transcript, planner, export, and run paths as golden behavior.
- Add no provider abstraction until Apply/Discard, deployment tracking, and canonical parsing land.
- Record representative `.cwc`, detection, export, and managed-run fixtures before changing their
  boundaries.
- Run the release validation commands and retain the results as the comparison baseline.

```bash
npm run typecheck
npm test
npm run build
```

## 1. Add Server-owned Run Manifests

### 1.1 Define and persist manifests

- Add `src/server/run-manifest.ts` with the versioned manifest type, structural parser, atomic
  temp-file/rename persistence, and per-run transition serialization.
- Store `<runId>.manifest.json` beside `<runId>.jsonl` under the existing workflow run directory.
- Reject unsafe ids and future manifest versions. Do not reconstruct authority from external
  event fields.
- Inject the manifest store through `AppOptions` so tests use temporary paths.
- Add `tests/server/run-manifest.test.ts` for create/read, atomic transition, malformed/future
  data, concurrent transition, and restart behavior.

### 1.2 Make managed lifecycle write the manifest

- Update `src/server/run-launcher.ts` to create the manifest before spawn, record resolved Git
  identity/base/worktree data, and transition it after checkpoint/classification.
- Update the approve/resume path in `src/server/api/runs.ts` from the same manifest rather than
  trusting privileged JSONL fields.
- Update `src/server/run-store.ts` summaries to expose only the manifest-derived result
  disposition needed by the client.
- Update orphan cleanup to consult manifest state. Legacy event-only runs remain visible but never
  receive privileged mutation actions.
- Extend `tests/server/run-launcher.test.ts`, `tests/server/runs-gates.test.ts`, and
  `tests/server/run-store.test.ts` with clean, dirty, paused, failed-checkpoint, legacy, and restart
  cases.

### 1.3 Authorize existing privileged routes from manifests

- Update diff, approve, reject, and cleanup logic in `src/server/api/runs.ts` to require a matching
  managed manifest and validate its lifecycle state.
- Keep `POST /api/runs/events` observational and unable to create or mutate a manifest.
- Extend `tests/server/runs.test.ts` with forged-event attempts against every privileged route.

### 1.4 Implement Apply and Discard Git operations

- Add pure preflight/result types and focused Git helpers in `src/server/run-isolation.ts`.
- Add `POST /api/runs/:runId/apply` and `POST /api/runs/:runId/discard` in
  `src/server/api/runs.ts`.
- Apply only when destination status is clean, destination `HEAD === baseSha`, the recorded result
  ref still points at `resultSha`, and `git merge --ff-only` can succeed.
- Discard only the verified CWC branch for a `ready` manifest. Serialize Apply/Discard so concurrent
  requests cannot both mutate state.
- On failure, preserve the branch and `ready` disposition unless the manifest can accurately record
  a non-retryable missing/tampered result.
- Add real-repository cases to `tests/server/run-isolation.test.ts` and
  `tests/server/runs.test.ts`: successful fast-forward, dirty destination, moved HEAD, missing ref,
  tampered ref, concurrent requests, repeated action, and discard ownership.

### 1.5 Surface result actions in Runs

- Extend run response types and `client/src/lib/api.ts` with disposition, Apply, and Discard.
- Add the compact action state to `client/src/views/modes/RunsMode.tsx` and its existing stylesheet.
- Require confirmation for Discard, keep failure text in context, prevent duplicate submission,
  and refresh timeline/diff/disposition after a transition.
- Add pure client-state tests under `tests/client/`; cover rendering and navigation later in the
  browser smoke harness.

### Stage 1 verification

```bash
npx vitest run tests/server/run-manifest.test.ts tests/server/run-isolation.test.ts
npx vitest run tests/server/run-launcher.test.ts tests/server/run-store.test.ts
npx vitest run tests/server/runs.test.ts tests/server/runs-gates.test.ts
npm run typecheck
npm test
npm run build
```

## 2. Add The Deployment Registry

### 2.1 Build the registry store

- Add `src/server/deployment-store.ts` with a versioned entry type, target normalization, atomic
  persistence, and status reconciliation.
- Default to `~/.cwc/deployments.json`; expose a path/store override in `AppOptions`.
- Treat registry data as an index only. Every destructive operation must re-read ownership markers
  with existing conflict detection.
- Add `tests/server/deployment-store.test.ts` for multiple targets per workflow, normalization,
  atomic replacement, missing paths, malformed data, and restart.

### 2.2 Register successful exports and deletions

- Extend `src/export/exporter.ts` to return the exact owned paths and workflow slug it wrote without
  weakening conflict checks.
- Pass the deployment store into `src/server/api/export.ts` and update it only after export succeeds.
- Pass it into `src/server/api/export-delete.ts`; remove or mark an entry stale only after verified
  cleanup reaches a truthful state.
- Keep `src/server/api/export-preview.ts` byte-consistent with real export decisions without
  mutating the registry.
- Extend `tests/export/exporter.test.ts`, `tests/server/export.test.ts`,
  `tests/server/export-delete.test.ts`, and `tests/server/export-preview.test.ts`.

### 2.3 Replace partial deployment discovery

- Add `src/server/api/deployments.ts` for list, reconcile, and targeted legacy discovery.
- Migrate ownership-marked user-scope exports on first load. Register project exports when that
  target is explicitly selected or exported again; never crawl arbitrary projects.
- Update trigger/Test Run preflight to use registry context for messages while retaining the final
  on-disk skill check.
- Update `client/src/lib/api.ts` and Home's Deployed tab in
  `client/src/views/HomeDashboard.tsx` to group deployments by workflow and show target scope/path.
- Add server tests for stale/missing/tampered entries and client logic tests for grouping.

### Stage 2 verification

```bash
npx vitest run tests/server/deployment-store.test.ts tests/server/export.test.ts
npx vitest run tests/server/export-delete.test.ts tests/server/export-preview.test.ts
npx vitest run tests/server/triggers-webhook.test.ts tests/server/runs-test-run.test.ts
npm run typecheck
npm test
npm run build
```

## 3. Canonicalize `.cwc` Files And Add Safe Portability

### 3.1 Implement the core parser and migrations

- Add `src/cwc/parser.ts`, `src/cwc/migrations.ts`, and `src/cwc/errors.ts` as pure modules.
- Keep `src/schema.ts` canonical for TypeScript types and define the current file-format version in
  one place.
- Validate bounded strings/arrays, ids, graph references, gates, terminals, artifacts, models,
  tools/skills, and trigger fields. Reject unsupported future versions.
- Add fixture-driven `tests/cwc/parser.test.ts` and `tests/cwc/migrations.test.ts`, including every
  malformed relationship and deterministic reparse.

### 3.2 Route every untrusted ingress through the parser

- Replace JSON casts in `src/server/api/workflows.ts`, `src/server/api/triggers.ts`,
  `src/server/api/automations.ts`, and `src/server/automation-scheduler.ts`.
- Parse request bodies in `src/server/api/export.ts`, `src/server/api/export-preview.ts`, and
  `src/server/api/export-delete.ts` before any filesystem operation.
- Reuse the structural parser from `src/generation/workflow-generator.ts`; keep generation-specific
  semantic checks and compiler fallback separate.
- Return structured 400/409 errors and never overwrite an invalid or future-version source file.
- Extend the matching route tests with malformed, oversized, old-version, and future-version cases.

### 3.3 Add a safe clone/portable transform

- Add `src/cwc/portable.ts` with deterministic id remapping and trigger sanitization.
- Clear workflow/node export identity, assign a new workflow id/timestamps, disable triggers,
  remove webhook tokens, and preserve valid graph intent.
- Add `tests/cwc/portable.test.ts` for id/reference remapping, secret removal, disabled automation,
  and stable output under an injected id/time source.

### 3.4 Add Import, Duplicate, and Share flows

- Add import and duplicate endpoints to `src/server/api/workflows.ts` using the canonical parser,
  portable transform, and existing exclusive creation helper.
- Add a portable-download response with a conservative body-size limit; do not accept archives in
  this stage.
- Add `client/src/lib/api.ts` methods and compact Home actions in
  `client/src/views/HomeDashboard.tsx`; use the existing error/toast patterns.
- Add server tests for collision-safe imports, unchanged source files, duplicate identity reset,
  and no inherited deployments/runs. Add pure client tests for action-state/error mapping.

### Stage 3 verification

```bash
npx vitest run tests/cwc/parser.test.ts tests/cwc/migrations.test.ts tests/cwc/portable.test.ts
npx vitest run tests/server/workflows.test.ts tests/server/export.test.ts
npx vitest run tests/server/automation-scheduler.test.ts tests/server/triggers-webhook.test.ts
npm run typecheck
npm test
npm run build
```

## 4. Add Codex History Without Changing Runtime

### 4.1 Extract the history-source contract

- Add `src/detection/history-source.ts` with source identity, availability, collection, normalized
  `TaskUnit`, and diagnostics contracts.
- Move existing Claude discovery/parsing orchestration behind
  `src/detection/sources/claude-code.ts`; keep `transcript-parser.ts`, `digest-builder.ts`, and
  analyzer behavior reusable.
- Add provider provenance to detection diagnostics/evidence without exposing raw transcript data.
- Add golden tests proving the Claude source produces the same task units, digest, candidate ids,
  and confidence from existing fixtures.

### 4.2 Implement a supported Codex history adapter

- Add a small injected App Server client under `src/server/` and
  `src/detection/sources/codex.ts`.
- Use supported `thread/list` and `thread/read` calls. Bound pagination, concurrency, text length,
  tool/command extraction, and cancellation.
- Normalize source-native session ids with provider provenance so ids cannot collide.
- Add fake-client tests for pagination, unavailable CLI, malformed threads, missing cwd, duplicate
  turns, truncation, cancellation, and diagnostics. Do not require a real Codex account in CI.

### 4.3 Add source selection to Detect

- Extend `src/server/api/automation-scan.ts` with a validated source id and injected source registry.
- Persist the selected source and provenance in scan state/diagnostics without changing the
  generated workflow target.
- Add source availability/list endpoints, `client/src/lib/api.ts` support, and a compact selector
  in `client/src/views/DetectView.tsx` using existing scan tokens and layout.
- Default existing users to Claude Code history. Clearly label Codex as an input source and Claude
  Code as the generated workflow target.
- Extend `tests/server/automation-scan.test.ts` and pure Detect state tests.

### Stage 4 verification

```bash
npx vitest run tests/detection tests/server/automation-scan.test.ts
npm run typecheck
npm test
npm run build
```

## 5. Add An Optional Codex Model Backend

### 5.1 Extract a backend contract

- Add `src/server/model-backend.ts` for one-shot/streamed text generation, cancellation,
  availability, model metadata, and normalized diagnostics.
- Wrap `src/server/claude-runner.ts` and `src/server/streaming-analyzer.ts` in the default Claude
  backend without changing their process-tree or timeout behavior.
- Change `src/generation/generate.ts` and scan orchestration to depend on the narrow backend
  contract. Keep compiler validation/fallback in core generation modules.
- Add adapter contract tests with deterministic fake backends.

### 5.2 Implement and expose the Codex backend

- Add `src/server/codex-runner.ts` using the supported non-interactive JSON CLI interface; retain
  bounded stdin, output, timeout, cancellation, and process-tree handling.
- Normalize progress rather than leaking provider-specific event JSON into the client.
- Persist an explicit backend preference in existing CWC config. Expose only models reported as
  supported by that backend.
- Update Detect's model control and generation status copy so history source and backend are
  visibly independent.
- Test missing binaries, malformed JSON, large output, timeout, cancellation, planner failure,
  and compiler fallback with fake binaries.

### 5.3 Re-run Claude golden coverage

- Prove the default remains Claude Code for scan analysis, workflow generation, export, and runs.
- Prove selecting Codex changes analysis/planning process invocation only; exported files and
  CWC-managed run commands remain Claude Code-compatible.

### Stage 5 verification

```bash
npx vitest run tests/server/claude-runner.test.ts tests/server/streaming-analyzer.test.ts
npx vitest run tests/server/codex-runner.test.ts tests/generation
npx vitest run tests/export tests/server/run-launcher.test.ts
npm run typecheck
npm test
npm run build
```

## 6. Add ChatGPT From Explicit Local Exports

### 6.1 Support extracted `conversations.json` first

- Add `src/detection/sources/chatgpt-export.ts` with a streaming/bounded parser for an explicitly
  selected local JSON export.
- Validate format and size before traversal, tolerate deleted/missing message nodes, preserve
  conversation provenance, and label the lack of tool/command evidence.
- Add redacted fixtures and tests for branching conversations, malformed nodes, duplicate turns,
  oversized text, cancellation, and lower-fidelity evidence thresholds.

### 6.2 Add explicit import UX

- Add a local-file selection/import endpoint with a dedicated conservative limit and no background
  account access.
- Register the imported dataset as an ephemeral or explicitly retained history source with clear
  delete controls. Never copy browser cookies or credentials.
- Add the source to Detect only after parsing succeeds and show its export date/coverage.

### 6.3 Consider ZIP only after a security review

- If archive convenience is justified, choose a maintained parser and document why the dependency
  is necessary.
- Reject absolute/traversal paths, links, nested archives, excess entry count, excess expanded
  bytes, compression bombs, and timeout breaches; extract only the expected conversations file.
- Keep direct `conversations.json` import as the dependency-light fallback.

### Stage 6 verification

```bash
npx vitest run tests/detection/chatgpt-export-source.test.ts
npx vitest run tests/server/automation-scan.test.ts
npm run typecheck
npm test
npm run build
```

## 7. Add Cross-stage Browser Smoke Coverage

- Introduce the smallest maintainable browser harness once the product flows above stabilize.
- Exercise Home -> Scan -> Home -> Scan, Generate -> Open workflow, two same-name creates,
  Import -> Duplicate, user/project deployment registry, and fake isolated Test Run -> Apply/Discard.
- Use temporary CWC/Claude homes and injected fake CLIs. Do not point browser tests at real
  `~/.cwc`, `~/.claude`, or user repositories.
- Run desktop and narrow viewport smoke paths; keep visual assertions focused on visibility,
  non-overlap, and reachable primary actions rather than brittle pixel snapshots.

## Release Gates For Every Stage

- Review all new filesystem deletes and Git mutations against server-owned authority and ownership
  markers.
- Verify token-exempt endpoints cannot acquire manifest, deployment, import, or provider authority.
- Verify Windows drive/UNC paths and POSIX paths where a stage accepts local paths.
- Update `README.md` only when user-visible behavior for that stage ships; do not rewrite historical
  design records.
- Run focused tests first, then the full release matrix:

```bash
npm run typecheck
npm test
npm run build
```

CI remains the final Ubuntu/Windows, Node 20/22 check. Process, path, Git, and file-permission
changes require local real-filesystem coverage before relying on that matrix.
