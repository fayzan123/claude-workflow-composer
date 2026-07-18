# AGENTS.md

This file gives durable repository guidance to Codex and other coding agents. Keep it accurate, compact, and focused on conventions that should apply across tasks. Put narrower overrides in a nested `AGENTS.md` or `AGENTS.override.md` near the code they govern.

## Project Identity

Claude Workflow Composer (CWC) is a local-first, full-stack TypeScript app for finding repeated Claude Code work and compiling it into the smallest fitting artifact: an owned guidance rule, plain skill, managed loop, or multi-agent workflow. It has:

- An Express server under `src/server/`.
- A React 19 + React Flow client under `client/src/`.
- Pure core TypeScript modules under `src/`.
- An npx-runnable CLI entry under `bin/`.
- Local storage under `~/.cwc/` and exported Claude assets under `~/.claude/` or project-local `.claude/`.

The trust model is local and filesystem-based. Be conservative around auth, CORS, filesystem writes, guidance-file edits, shell execution, exported skills/agents, and automation runs.

## Current Product Roadmap

The approved roadmap is maintained in:

- `docs/specs/2026-07-14-cwc-product-roadmap-design.md`
- `docs/plans/2026-07-14-cwc-product-roadmap-plan.md`
- `docs/specs/2026-07-16-right-sized-generation-design.md`

Read all three before starting roadmap work. Stage 1 and right-sized generation are implemented: managed runs have server-owned manifests and safe Apply/Discard, while detection now classifies and produces rules, skills, loops, or workflows. Proceed next in this order:

1. Deployment registry across user and project exports.
2. Canonical `.cwc` parsing, migrations, import, duplicate, and portable sharing.
3. Codex as an additional history source without changing Claude Code export/runtime.
4. Optional Codex analysis/planning backend, independently selectable from history source.
5. ChatGPT ingestion only from an explicit local data export.

Keep history source, analysis backend, deployment target, artifact tier, and workflow runtime as independent concepts. Through the approved roadmap, Claude Code remains the deployment target and managed-run runtime. Do not jump ahead to provider abstraction before deployment tracking and canonical parsing are complete.

## Commands

Use these commands from the repository root.

This project uses npm with `package-lock.json`. `package.json` declares Node `>=18`; CI currently exercises Node 20 and 22.

```bash
# Development: run all three in separate terminals
npm run dev:server          # tsc --watch, writes dist/
npm run dev:api             # API at :3579 with CWC_DISABLE_AUTH=1 for Vite dev
npm run dev:client          # Vite at :5173, proxies /api to :3579

# Validation
npm test                    # Vitest one-shot
npm run test:watch          # Vitest watch mode
npm run typecheck           # server + client TypeScript
npm run build               # production build

# Focused tests
npx vitest run tests/workflow/bfs.test.ts
npx vitest run tests/server/runs.test.ts
```

`npm run dev:api` intentionally disables the token gate because Vite serves the HTML and the server cannot set the packaged-app auth cookie. The packaged server (`npm start` / `bin/cwc`) must remain authenticated.

CI runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` on Ubuntu and Windows with Node 20 and 22. If a change is platform-sensitive, account for both OS families.

## Working Rules

- Read the relevant code before changing it. Prefer `rg` / `rg --files` for discovery.
- Keep edits scoped to the requested behavior. Do not do opportunistic cleanup unless it is required for the task.
- Do not revert or overwrite unrelated user changes. Check `git status --short` when the worktree context matters.
- Use the repo's existing style: TypeScript strict mode, ESM, single quotes, no semicolons, and local `.js` extensions for NodeNext imports in server/core TypeScript.
- Do not add production dependencies without a clear reason. If a dependency change is necessary, update `package-lock.json` without unrelated upgrades.
- For filesystem behavior, prefer real filesystem tests over mocks. This repo deliberately tests with temp directories.
- Keep generated/exported content deterministic where practical. Avoid timestamps or randomness in tests unless injected or asserted loosely.

## Architecture

### Server

`src/server/index.ts` exposes `createApp(opts)` and wires all routers. Keep routes in `src/server/api/`. Use `AppOptions` for dependency injection in tests instead of mocking module internals.

Important server modules:

- `security.ts` installs the UI token cookie, requires API tokens in packaged mode, and restricts CORS.
- `run-store.ts` persists JSONL run events and summaries under `~/.cwc/runs/<workflowId>/`.
- `run-manifest.ts` atomically persists versioned managed-run authority and serializes lifecycle/result transitions per run.
- `run-skill-binding.ts` snapshots the verified runnable skill and every plain filesystem-backed dispatched agent into a namespaced, per-run plugin; manifests bind paused/resumed runs to that immutable snapshot. Managed runs fail closed on namespaced plugin-agent dispatches until their exact bytes can be resolved.
- `workflow-runner.ts` spawns `claude -p "/<slug>" --permission-mode bypassPermissions` for Test Runs.
- `run-isolation.ts` manages git worktrees plus verified diff, fast-forward Apply, and exact-branch Discard operations.
- `run-launcher.ts` coordinates isolation setup, process spawn, finish classification, and orphan worktree cleanup.
- `automation-state.ts`, `automation-scheduler.ts`, and `trigger-targets.ts` manage cron/webhook trigger state and firing.
- `notifier.ts` sends macOS notifications and optional webhooks.
- `scan-store.ts`, `streaming-analyzer.ts`, and `api/automation-scan.ts` support history scanning, tier recommendations/overrides, and artifact generation.
- `automation-activity.ts` synchronously excludes scans, promotions, and rule-file mutations across router awaits.
- `rule-files.ts` and `api/automation-rules.ts` apply and remove serialized, ownership-marked rule blocks in approved guidance files.

Do not relax auth, loopback binding, token checks, or CORS behavior without an explicit security-driven task.

### Core Library

Core modules in `src/` should remain independent of Express:

- `schema.ts` is the canonical `.cwc` type model.
- `slugify.ts` is shared slug normalization.
- `run-events.ts` defines and validates run event payloads.
- `export/exporter.ts` orchestrates export, conflict checks, slug resolution, file writes, and rename reconciliation.
- `export/file-transaction.ts` retains reversible same-filesystem deletion backups until deployment and recipe authority commit together.
- `export/file-writer.ts` renders agent Markdown plus plain and orchestrator `SKILL.md` frontmatter/content.
- `export/conflict-detector.ts` reads ownership comments to decide whether a file is safe to overwrite.
- `export/skill-resolver.ts` resolves skill slugs from user and plugin skill directories.
- `workflow/bfs.ts` and `workflow/prose-generator.ts` turn the graph into orchestrator prose.

Generation and detection are also core behavior:

- `detection/transcript-parser.ts` finds and parses local Claude Code transcripts.
- `detection/digest-builder.ts`, `analysis-prompt.ts`, and `analyzer.ts` build compact analysis prompts and parse detected automations.
- `detection/automation-shape.ts` derives persisted classifier inputs while the matched task units are available, including exact indexes for grounded parallel siblings and exact safe names for observed mutating connector tools.
- `generation/classifier.ts` deterministically recommends `rule`, `skill`, `loop`, or `workflow`; missing shape remains `workflow` for compatibility, and any risky external action recommends `workflow`.
- `generation/generate.ts` dispatches skill/loop generation or the existing workflow planner/compiler without silent tier escalation.
- `generation/skill-generator.ts` produces the one-node skill container and deterministic checklist fallback used by the skill and loop tiers. Model bodies are accepted only with ordered observed-step coverage and textually grounded external-action lines.
- `generation/compiler.ts` and related files validate/compile planner output, with fallback behavior when planning fails.
- `generation/agent-generator.ts` and `generation/workflow-generator.ts` are the standalone Claude-CLI-driven generators. `generation/workflow-generator.ts` is also the legacy workflow-generation path, still reachable with `CWC_LEGACY_GEN=1`.

### Client

The client lives in `client/src/` and uses React 19, React Router, and `@xyflow/react`.

- `views/HomeDashboard.tsx`, `DetectView.tsx`, and `WorkflowView.tsx` are the main surfaces.
- Artifact modes live under `views/modes/`: the workflow canvas or focused `SkillBuildMode`, plus artifact-aware Runs and Automate surfaces.
- `hooks/useWorkflow.ts` owns the reducer over `CwcFile`.
- `hooks/useAutoSave.ts` persists `.cwc` artifacts with a 500ms debounce.
- `hooks/useRunEvents.ts` handles SSE run events.
- Reusable chrome and controls live in `components/`.
- Client helpers live in `client/src/lib/`.

There are client logic tests under `tests/client/`, but no browser/E2E test harness. UI rendering changes are usually verified with `npm run typecheck`, focused tests where available, and manual inspection.

### CLI

`bin/cwc.ts` is the source CLI entry. The build writes `dist/bin/cwc.js` and marks it executable. `package.json` exposes `cwc` from `dist/bin/cwc.js`.

## Data Model

`CwcFile` is the universal runnable-artifact container and contains `meta`, `nodes`, and `edges`. Current files use schema version 2; version-1 files without artifact fields remain workflow artifacts.

- `CwcMeta.artifactKind?: 'workflow' | 'skill'` controls the export/editor shape; absent means `workflow` for compatibility.
- `CwcMeta.artifactTier?: 'workflow' | 'skill' | 'loop'` distinguishes loop semantics from the shared `skill` container. Kind/tier combinations must remain consistent.
- `CwcMeta.sourceAutomation?: { id?, steps, verificationCommand?, verificationStep? }` preserves detection provenance and loop verification. The current edited skill body—not retained steps—is executable authority during skill-to-workflow graduation.
- Other metadata includes artifact identity, timestamps, `observability?: { enabled: boolean }`, `modelInvocation?: 'off' | 'auto'`, `triggers?: CwcTrigger[]`, and `exportedWorkflowSlug`.
- `exportedWorkflowSlug` always names the runnable skill written by the latest successful export. Failed obsolete-skill cleanup is retried through `pendingExportCleanup.skillSlugs`, never by rolling back the runnable identity.
- `modelInvocation` schema semantics stay safe: absent or `'off'` keeps `disable-model-invocation: true` in exported skills, and only `'auto'` omits that frontmatter line. Detection-generated skill/loop artifacts explicitly set `'auto'` at generation time (auto-discovery is the product payoff; the export flow surfaces the switch). Workflow artifacts and legacy files remain off by default.
- A skill/loop container has exactly one bespoke non-gate node and no edges. The node's agent fields map to skill frontmatter/body; loops add a trigger and/or observed verification semantics.
- Rules are not `CwcFile`s. Their suggestion, selected target, and application record remain on `DetectedAutomation` and in the owned guidance-file block.
- `DetectedAutomation.generatedArtifactTier` belongs to `generatedArtifactId`; do not infer it from `selectedTier`, which may describe a later failed/cancelled override or rule application.
- `CwcNode` contains canvas position, an `agent`, optional `agentRef`, optional `startTrigger`, optional `dispatchMode`, optional `nodeType`, and `exportedSlug`.
- `nodeType: 'gate'` nodes pause a run at an approval checkpoint. Gates do not write agent files.
- `agentRef` nodes are reference nodes. They point to existing agent slugs and do not write new agent files.
- Nodes without `agentRef` and without `nodeType: 'gate'` are bespoke agent nodes. Export writes agent `.md` files for them.
- `CwcEdge` connects `from` to `to`, where `to: null` is a terminal edge. Terminal edges require `terminalType`.
- Edge `context` artifacts may be `file`, `text`, or `json`; file artifacts use `path`.
- `CwcTrigger` covers cron/webhook automation settings, target cwd(s), isolation mode, base ref, precondition/setup shell commands, catch-up, daily cap, and enabled state.

## Export Rules

Export behavior is safety-critical.

- User-scoped export writes to `~/.claude/agents` and `~/.claude/skills`.
- Project-scoped export writes to `<project>/.claude/agents` and `<project>/.claude/skills`.
- Bespoke agent files include `<!-- cwc:node:<nodeId>:workflow:<workflowId> -->`.
- All managed skill files include `<!-- cwc:workflow:<workflowId> -->` for backward-compatible ownership detection.
- Plain skill/loop artifacts write one `.claude/skills/<slug>/SKILL.md` with no `cwc-` prefix, orchestrator prose, or agent files.
- Workflow artifacts write `.claude/skills/cwc-<workflow-slug>/SKILL.md` plus bespoke agent files generated from BFS traversal.
- Every exported skill carries a canonical `cwc:bespoke-agents` declaration immediately before its ownership marker. Managed runs use it to enforce bespoke ownership while snapshotting exact installed bytes for both bespoke and reference agents; dispatching legacy exports must be re-exported before running.
- Never overwrite or delete a file unless `export/conflict-detector.ts` verifies this artifact owns it.
- Rename cleanup may delete old owned files, but must not touch foreign or hand-authored files.
- HTTP export/delete must persist the recipe revision inside the exporter's reversible deployment boundary. A recipe CAS/I/O failure restores all prior deployment bytes; post-commit refresh hooks are best-effort.
- Artifact-kind transitions reconcile the previously exported owned skill path. Preview must show the same writes/deletions as the real export; a multi-target deployment registry is still future work.
- `export-preview` must match real export frontmatter and content decisions. When export behavior changes, update preview and real export together.
- Agent frontmatter `name` must be the slug used for `subagent_type`; Claude Code resolves dispatch against this field, not the filename.
- Reference nodes can carry workflow-specific overrides; those are surfaced in orchestrator prose instead of writing a new agent file.
- Missing referenced skills or agents should produce warnings, not silent rewrites.

Rule application is also safety-critical.

- A user rule targets `~/.claude/CLAUDE.md`; a project rule targets `<evidence-repo>/AGENTS.md`. Do not permit an arbitrary project path outside that automation's evidence.
- Application is always an explicit UI/API action and writes a paired `<!-- cwc:rule:<automationId> -->` / `<!-- /cwc:rule:<automationId> -->` block.
- Preserve all surrounding user content, serialize concurrent edits per path, revalidate file identity/content immediately before atomic rename, and refuse malformed owned blocks, external-edit races, symlinks, or non-regular target files.

## Runs And Automation

Runs are side-effectful. Preserve the distinction between a runnable artifact and the CWC run harness.

- Test Runs and scheduler/webhook-fired runs use `run-launcher.ts` and `workflow-runner.ts` for both plain skill/loop slugs and `cwc-`-prefixed workflow slugs.
- Before a managed process starts, the launcher revalidates the selected checkout's deployed bytes under the export lease and publishes a private namespaced plugin under the worktrees root. This carries untracked project exports into isolated worktrees; export/delete may proceed after spawn without changing the bytes that run or a later gate resume will load.
- Rules are guidance-file edits and never enter the run harness.
- Worktree isolation protects the user's main checkout when `isolation: 'worktree'`.
- In-place runs are explicitly allowed by configuration and can modify the selected cwd.
- Approval gates depend on run logging, the CWC inbox, resumable sessions, and reviewer approve/reject actions.
- Shell preconditions skip firing on non-zero exit; setup commands run after the run starts and fail the run on non-zero exit.
- If deployment revalidation rejects an isolated launch after setup produced files, checkpoint that output as a failed discardable result; never force-delete the dirty worktree.
- Logging from exported skills/orchestrators is best-effort and must not block artifact completion.
- JSONL events are observational only. Diff, approve/reject, cleanup, Apply, and Discard require a valid matching server-owned manifest.
- Apply requires the original clean checkout at the recorded base and uses only Git fast-forward behavior. Discard deletes only the verified CWC result ref after explicit confirmation.
- Generated loop triggers are disabled and unarmed until explicit user action. Verification-only loops may have no schedule.
- Do not treat `modelInvocation: 'auto'` as equivalent to a CWC-managed run. Auto-invoked skills run outside the isolated-run harness.

## Storage Layout

```text
~/.cwc/
  recents.json
  workflows/
  runs/<workflowId>/        # <runId>.jsonl + managed <runId>.manifest.json
  worktrees/
    .skill-bindings/       # private verified plugins retained only for active/paused runs
  automation-state.json
  automation-scan.json
  config.json
  server.pid

~/.claude/
  agents/*.md
  skills/*/SKILL.md
  plugins/cache/...
```

Tests should use temp directories and `AppOptions` path overrides rather than writing to real user locations.

## Testing Guidance

- Run the narrowest useful test first, then broaden based on risk.
- For core/export changes, run the relevant `tests/*.test.ts` file and usually `npm run typecheck`.
- For server route changes, use `createApp()` with test paths and injected runners/stores; avoid network-bound tests when the router can be exercised directly.
- For runner tests, use fake Claude binaries from `tests/helpers/make-bin.ts`.
- For scheduler/run-isolation behavior, account for process timing and Windows path/process differences.
- For UI state/helpers, check `tests/client/` for existing focused coverage.
- Before considering broad or release-impacting work complete, run `npm test`, `npm run typecheck`, and `npm run build` unless the user asked for a smaller verification scope.

## Design And UI Rules

Always read `DESIGN.md` before making visual or UI changes.

Follow the established direction:

- Precise, warm, and alive dev-tool UI.
- Light theme is the default; dark theme is first-class.
- Warm-neutral surfaces, teal primary accent, semantic warning/success/error colors.
- Canvas and node visual language are the product signature.
- Use existing tokens in `client/src/index.css` and component CSS before adding new styling primitives.
- Keep app surfaces dense, legible, and automation-focused. The canvas remains the workflow tier's signature; plain skills use the focused editor. Avoid marketing-page patterns inside the app.
- Respect reduced-motion preferences for animation.

Do not introduce broad palette, typography, radius, elevation, or motion changes without explicit approval.

## Documentation

- Keep `README.md` user-facing and accurate when behavior changes.
- This file is the single source of durable agent guidance. `CLAUDE.md` is a one-line `@AGENTS.md` import, so editing this file updates guidance for Claude Code and Codex/other agents at once. Do not keep a separate copy in `CLAUDE.md`.
- Specs live in `docs/specs/` and implementation plans in `docs/plans/` (see `docs/README.md`). Use them for any change large enough to need staged execution.
- Do not update historical plan docs just to match current code unless the task is specifically documentation maintenance.

## Common Pitfalls

- Forgetting to update `export-preview.ts` when changing export output.
- Treating an absent `artifactKind` as a skill; legacy files always resolve to `workflow`.
- Losing `artifactTier` or `sourceAutomation` during edits/conversion, which breaks loop identity or faithful graduation.
- Resurrecting retained `sourceAutomation.steps` after the user removed them from a skill body; provenance is never executable authority during graduation.
- Relabeling an existing generated artifact from a later attempt's `selectedTier`; preserve `generatedArtifactTier` independently.
- Reintroducing the `cwc-` prefix or agent files for a plain skill/loop export.
- Invoking every artifact with a workflow-derived slug instead of the artifact-aware deployed slug helper.
- Relaxing the classifier's safety override: any detected risky external action must recommend the gate-capable workflow tier.
- Reducing observed connector mutations to a boolean; generated gated agents must retain the exact safe tool names needed to execute the detected work.
- Treating an ambiguous "independently" phrase as fan-out. Parallel generation requires exact persisted sibling indexes; a count alone must not change execution order.
- Applying a detected rule automatically, outside its evidence repos, or without paired ownership markers.
- Treating gates as ordinary agents; gates do not write agent files.
- Breaking agent dispatch by putting a human title instead of the slug in agent frontmatter `name`.
- Mocking filesystem behavior that should be covered with temp directories.
- Relaxing auth/CORS for packaged mode while fixing local dev friction.
- Running automation tests against real `~/.cwc` or `~/.claude` paths.
- Removing legacy generation without checking `CWC_LEGACY_GEN=1` and its tests.
- Assuming README architecture snippets are newer than the source tree. Inspect source before relying on docs.
- Reconstructing Git authority from run events or exposing Apply/Discard for legacy, in-place, paused, or unpreserved results.
