# AGENTS.md

This file gives durable repository guidance to Codex and other coding agents. Keep it accurate, compact, and focused on conventions that should apply across tasks. Put narrower overrides in a nested `AGENTS.md` or `AGENTS.override.md` near the code they govern.

## Project Identity

Claude Workflow Composer (CWC) is a local-first, full-stack TypeScript app for finding repeated Claude Code work and turning it into runnable multi-agent workflows. It has:

- An Express server under `src/server/`.
- A React 19 + React Flow client under `client/src/`.
- Pure core TypeScript modules under `src/`.
- An npx-runnable CLI entry under `bin/`.
- Local storage under `~/.cwc/` and exported Claude assets under `~/.claude/` or project-local `.claude/`.

The trust model is local and filesystem-based. Be conservative around auth, CORS, filesystem writes, shell execution, exported agent files, workflow skills, and automation runs.

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
npx vitest run tests/bfs.test.ts
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
- `workflow-runner.ts` spawns `claude -p "/<slug>" --permission-mode bypassPermissions` for Test Runs.
- `run-isolation.ts` manages git worktrees for isolated runs.
- `run-launcher.ts` coordinates isolation setup, process spawn, finish classification, and orphan worktree cleanup.
- `automation-state.ts`, `automation-scheduler.ts`, and `trigger-targets.ts` manage cron/webhook trigger state and firing.
- `notifier.ts` sends macOS notifications and optional webhooks.
- `scan-store.ts`, `streaming-analyzer.ts`, and `api/automation-scan.ts` support history scanning and workflow promotion.

Do not relax auth, loopback binding, token checks, or CORS behavior without an explicit security-driven task.

### Core Library

Core modules in `src/` should remain independent of Express:

- `schema.ts` is the canonical `.cwc` type model.
- `exporter.ts` orchestrates export, conflict checks, slug resolution, file writes, and rename reconciliation.
- `file-writer.ts` renders agent Markdown and workflow `SKILL.md` frontmatter/content.
- `conflict-detector.ts` reads ownership comments to decide whether a file is safe to overwrite.
- `bfs.ts` and `prose-generator.ts` turn the graph into orchestrator prose.
- `skill-resolver.ts` resolves skill slugs from user and plugin skill directories.
- `slugify.ts` is shared slug normalization.
- `run-events.ts` defines and validates run event payloads.

Generation and detection are also core behavior:

- `detection/transcript-parser.ts` finds and parses local Claude Code transcripts.
- `detection/digest-builder.ts`, `analysis-prompt.ts`, and `analyzer.ts` build compact analysis prompts and parse detected automations.
- `generation/generate.ts` selects reusable agents/skills, asks Claude for a plan, and compiles a workflow.
- `generation/compiler.ts` and related files validate/compile planner output, with fallback behavior when planning fails.
- `generation/agent-generator.ts`, `generation/skill-generator.ts`, and `generation/workflow-generator.ts` are the standalone single-artifact generators (Claude-CLI driven). `generation/workflow-generator.ts` is also the legacy workflow-generation path, still reachable with `CWC_LEGACY_GEN=1`.

### Client

The client lives in `client/src/` and uses React 19, React Router, and `@xyflow/react`.

- `views/HomeDashboard.tsx`, `DetectView.tsx`, and `WorkflowView.tsx` are the main surfaces.
- Workflow modes live under `views/modes/`: Build, Runs, and Automate.
- `hooks/useWorkflow.ts` owns the reducer over `CwcFile`.
- `hooks/useAutoSave.ts` persists workflows with a 500ms debounce.
- `hooks/useRunEvents.ts` handles SSE run events.
- Reusable chrome and controls live in `components/`.
- Client helpers live in `client/src/lib/`.

There are client logic tests under `tests/client/`, but no browser/E2E test harness. UI rendering changes are usually verified with `npm run typecheck`, focused tests where available, and manual inspection.

### CLI

`bin/cwc.ts` is the source CLI entry. The build writes `dist/bin/cwc.js` and marks it executable. `package.json` exposes `cwc` from `dist/bin/cwc.js`.

## Data Model

`CwcFile` contains `meta`, `nodes`, and `edges`.

- `CwcMeta` includes workflow identity, timestamps, `observability?: { enabled: boolean }`, `modelInvocation?: 'off' | 'auto'`, `triggers?: CwcTrigger[]`, and `exportedWorkflowSlug`.
- `modelInvocation` defaults to safe behavior: absent or `'off'` keeps `disable-model-invocation: true` in exported workflow skills. Only `'auto'` omits that frontmatter line.
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
- Workflow skill files include `<!-- cwc:workflow:<workflowId> -->`.
- Never overwrite or delete a file unless `conflict-detector.ts` verifies this workflow owns it.
- Rename cleanup may delete old owned files, but must not touch foreign or hand-authored files.
- `export-preview` must match real export frontmatter and content decisions. When export behavior changes, update preview and real export together.
- Agent frontmatter `name` must be the slug used for `subagent_type`; Claude Code resolves dispatch against this field, not the filename.
- Workflow skills are written under a `cwc-<workflow-slug>` directory and generated from BFS traversal.
- Reference nodes can carry workflow-specific overrides; those are surfaced in orchestrator prose instead of writing a new agent file.
- Missing referenced skills or agents should produce warnings, not silent rewrites.

## Runs And Automation

Runs are side-effectful. Preserve the distinction between a workflow recipe and the CWC run harness.

- Test Runs and scheduler-fired runs use `run-launcher.ts` and `workflow-runner.ts`.
- Worktree isolation protects the user's main checkout when `isolation: 'worktree'`.
- In-place runs are explicitly allowed by configuration and can modify the selected cwd.
- Approval gates depend on run logging, the CWC inbox, resumable sessions, and reviewer approve/reject actions.
- Shell preconditions skip firing on non-zero exit; setup commands run after the run starts and fail the run on non-zero exit.
- Logging from exported orchestrators is best-effort and must not block workflow completion.
- Do not treat `modelInvocation: 'auto'` as equivalent to a CWC-managed run. Auto-invoked skills run outside the isolated-run harness.

## Storage Layout

```text
~/.cwc/
  recents.json
  workflows/
  runs/<workflowId>/
  worktrees/
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
- Keep app surfaces dense, legible, and workflow-focused. Avoid marketing-page patterns inside the app.
- Respect reduced-motion preferences for animation.

Do not introduce broad palette, typography, radius, elevation, or motion changes without explicit approval.

## Documentation

- Keep `README.md` user-facing and accurate when behavior changes.
- This file is the single source of durable agent guidance. `CLAUDE.md` is a one-line `@AGENTS.md` import, so editing this file updates guidance for Claude Code and Codex/other agents at once. Do not keep a separate copy in `CLAUDE.md`.
- Specs live in `docs/specs/` and implementation plans in `docs/plans/` (see `docs/README.md`). Use them for any change large enough to need staged execution.
- Do not update historical plan docs just to match current code unless the task is specifically documentation maintenance.

## Common Pitfalls

- Forgetting to update `export-preview.ts` when changing export output.
- Treating gates as ordinary agents; gates do not write agent files.
- Breaking agent dispatch by putting a human title instead of the slug in agent frontmatter `name`.
- Mocking filesystem behavior that should be covered with temp directories.
- Relaxing auth/CORS for packaged mode while fixing local dev friction.
- Running automation tests against real `~/.cwc` or `~/.claude` paths.
- Removing legacy generation without checking `CWC_LEGACY_GEN=1` and its tests.
- Assuming README architecture snippets are newer than the source tree. Inspect source before relying on docs.
