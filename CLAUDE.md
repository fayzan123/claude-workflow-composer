# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run dev:server          # Watch-mode TypeScript compilation for server
npm run dev:client          # Vite HMR dev server at :5173 (proxies /api → :3579)

# Testing
npm test                    # Run all tests (Vitest, one-shot)
npm run test:watch          # Vitest in watch mode
npx vitest run tests/bfs.test.ts   # Run a single test file

# Type checking
npm run typecheck           # Check server + client (both tsconfigs)

# Build & run
npm run build               # Production build: tsc + vite
npm start                   # Run from dist/ (requires build first)
```

## Architecture

This is a full-stack TypeScript app: an Express server (`src/`) serving a React client (`client/src/`), packaged as an npx-runnable CLI (`bin/cwc.js`).

**Server** (`src/server/`) — Express at `:3579`. `createApp()` in `src/server/index.ts` wires all routers. Each API route lives in `src/server/api/`. The server has no database — workflows are plain `.cwc` JSON files on disk under `~/.cwc/workflows/`.

**Core library** (`src/`) — Pure TypeScript modules with no Express dependency:
- `schema.ts` — canonical types: `CwcFile`, `CwcNode`, `CwcEdge`, `CwcAgent`
- `exporter.ts` — orchestrates the full export: conflict detection, file writes, slug resolution
- `bfs.ts` — BFS traversal of the node/edge graph used by prose generation
- `prose-generator.ts` — converts graph traversal into natural-language orchestrator steps
- `file-writer.ts` — builds agent `.md` frontmatter and workflow `SKILL.md` content
- `conflict-detector.ts` — reads ownership HTML comments (`<!-- cwc:node:ID:workflow:ID -->`) to determine whether a file is safe to overwrite
- `skill-resolver.ts` — resolves skill slugs against `~/.claude/skills/` (user) and `~/.claude/plugins/cache/` (plugins)
- `slugify.ts` — slug normalization shared by server and core
- `run-events.ts` — `RunEvent` type + `validateRunEvent()` for the runs API

**Runs subsystem** (`src/server/`) — observability for exported workflows:
- `run-store.ts` — JSONL persistence under `~/.cwc/runs/<workflowId>/`, run summaries (running/stale/final), in-memory child-process registry, event fan-out to SSE subscribers
- `workflow-runner.ts` — spawns `claude -p "/<slug>" --permission-mode acceptEdits` for Test Runs (prompt via stdin; SIGTERM → aborted, timeout → error)
- `api/runs.ts` — `POST /events` (ingest from exported skills' curl instructions), `GET /` (summaries), `GET /:runId/events`, `GET /stream` (SSE), `POST /test` (spawn), `POST /:runId/stop`

**Client** (`client/src/`) — React 19 + React Flow (`@xyflow/react`). State lives in `useWorkflow.ts` (a `useReducer` over `CwcFile`), persisted via `useAutoSave.ts` (500ms debounce to `/api/workflows`). Components: `Canvas.tsx` (React Flow canvas), `Sidebar.tsx` (agents/skills tabs), `TopBar.tsx` (validation + export trigger), `ExportFlow.tsx` (multi-step export modal), `WorkflowNode.tsx` (custom node renderer), `panels/NodePanel.tsx` and `panels/EdgePanel.tsx` (right-side editors).

**Storage layout:**
```
~/.cwc/
  recents.json          # Last 10 opened workflow paths
  workflows/            # .cwc JSON files
  runs/<workflowId>/    # Run event logs, one .jsonl per run
~/.claude/
  agents/*.md           # Agent definitions (read + written by exporter)
  skills/*/SKILL.md     # User skills (sidebar reads these)
  plugins/cache/...     # Plugin skills (sidebar reads these)
```

## Key Data Model

`CwcFile` (the `.cwc` format) contains `meta`, `nodes[]`, and `edges[]`.

- **`CwcNode`** has an `agent` (`CwcAgent`) with name/description/completionCriteria/tools/skills/systemPrompt/model, a canvas `position`, an optional `agentRef` (makes it a reference node), and `exportedSlug` (set after first export).
- **`CwcEdge`** has `from`/`to` node IDs (`to: null` = terminal edge), a `trigger` string, optional `label`, optional `context` artifacts, and optional `terminalType`.
- **Reference node** — `agentRef` is set; exporter writes nothing and uses `agentRef` as the slug in the orchestrator.
- **Bespoke node** — no `agentRef`; exporter writes an agent `.md` file with an ownership comment.

## Export Flow

`POST /api/export` calls `exportWorkflow()` in `src/exporter.ts`, which:
1. For each bespoke node: slugifies the name, checks conflict (reads ownership comment), writes agent `.md` via `buildAgentFileContent()`
2. For renamed nodes: deletes the old file if this workflow owns it
3. BFS-traverses the graph to generate orchestrator prose via `generateOrchestratorBody()`
4. Writes the workflow `SKILL.md` via `buildWorkflowSkillContent()`
5. Returns `{ updatedCwc, warnings }` — caller persists the updated CwcFile (with new `exportedSlug` values)

`POST /api/export/preview` runs the same logic but returns file contents without writing.
`POST /api/export/delete` removes all files owned by the workflow.

## Testing

Tests live in `tests/` (server tests in `tests/server/`, core tests at `tests/*.test.ts`). No client-side tests. Tests use real temp filesystems (via `fs.mkdtemp`) rather than mocks — don't introduce mocks for filesystem operations. Run a single file with `npx vitest run tests/<file>.test.ts`.

The `AppOptions` interface in `src/server/index.ts` accepts `workflowsDir`, `userHomeDir`, `recentsPath`, `runsDir`, and `claudeBinPath` overrides specifically for test injection — use these instead of mocking. Fake `claude` binaries for runner tests are built with `tests/helpers/make-bin.ts` (platform-aware: plain shebang script on POSIX, `.cmd` shim on Windows).
