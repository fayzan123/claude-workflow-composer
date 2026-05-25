# Phase 2 Handoff — Claude Workflow Composer

## What This Project Is

**Claude Workflow Composer** (`npx cwc`) is a local web UI for visually authoring Claude Code multi-agent workflows. Users drag agents onto a canvas, wire handoffs between them, and export a working slash-command workflow directly into their Claude installation — no code required.

The output is a standard Claude Code skill orchestrator (`/<workflow-slug>`) backed by a set of agent files. Everything lands in `~/.claude/` or `.claude/` depending on export target. Nothing leaves the machine.

---

## What Was Built in Phase 1

Phase 1 built and fully tested the **exporter backend** — the layer that translates a `.cwc` workflow file into Claude-readable files. It has zero UI; it's a pure TypeScript library.

**Tag:** `v0.1.0-exporter` on `main`

### Source files (`src/`)

| File | Responsibility |
|---|---|
| `schema.ts` | TypeScript types for the `.cwc` format (`CwcFile`, `CwcNode`, `CwcEdge`, `CwcArtifact`, etc.) |
| `slugify.ts` | `slugify(name)` → kebab-case slug, max 64 chars |
| `bfs.ts` | Multi-root BFS traversal with back-edge detection; returns `BfsStep[]` |
| `prose-generator.ts` | `generateOrchestratorBody()` — converts BFS steps into orchestrator skill prose |
| `skill-resolver.ts` | Two-strategy skill resolver: `~/.claude/skills/` and namespaced plugin skills |
| `conflict-detector.ts` | Scans existing files for ownership comments; returns `owned/foreign/absent/malformed` |
| `file-writer.ts` | Pure string generators: `buildAgentFileContent()` and `buildWorkflowSkillContent()` |
| `exporter.ts` | Integration layer — reads `.cwc`, calls all modules, writes to real filesystem |

### Key types (schema.ts)

```typescript
interface CwcFile {
  meta: CwcMeta          // id, name, description, version, created, updated
  nodes: CwcNode[]
  edges: CwcEdge[]
}

interface CwcNode {
  id: string
  position: { x: number; y: number }
  exportedSlug: string | null   // null before first export
  startTrigger?: string         // entry nodes only — "to design the schema"
  agent: CwcAgent
}

interface CwcAgent {
  name: string
  description: string
  completionCriteria: string    // required, empty string = not set
  color?: string
  model?: string
  tools?: string[]
  skills?: string[]             // non-namespaced or "plugin:slug"
  systemPrompt?: string
}

interface CwcEdge {
  id: string
  from: string
  to: string | null             // null = terminal edge
  label?: string
  trigger: string               // always emitted verbatim
  context?: CwcArtifact[]
  terminalType?: 'complete' | 'escalated' | 'aborted'  // UI only, not emitted
}

interface CwcArtifact {
  name: string
  type: 'file' | 'text' | 'json'
  path?: string   // required when type === 'file'
}
```

### Exporter API

```typescript
import { exportWorkflow } from './src/exporter.js'

const result = await exportWorkflow(cwcFile, target, opts)
// result.updatedCwc  — CwcFile with exportedSlug fields populated
// result.warnings    — string[] of non-fatal issues (skills not found, etc.)
```

**ExportTarget:**
```typescript
type ExportTarget =
  | { type: 'project'; projectDir: string }   // writes to <projectDir>/.claude/agents/
  | { type: 'user'; userDir?: string }         // writes to ~/.claude/agents/
```

**ExportOptions:**
```typescript
interface ExportOptions {
  skillsDir: string          // where workflow SKILL.md is written
  userSkillsDir?: string     // test injection override for ~/.claude/skills/
}
```

### What the exporter produces

**Agent file** (`.claude/agents/<slug>.md`):
```markdown
---
name: Backend Architect
description: Designs the API and data model
color: blue
model: inherit
tools: Read, Write, WebSearch
---

You are a senior backend architect...

## Completion Criteria

Before returning, verify: A design document has been written...

---
## Workflow Skills

Use the `brainstorming` skill. (Explores requirements)
<!-- cwc:node:node-1:workflow:<uuid> -->
```

**Workflow skill** (`~/.claude/skills/<workflow-slug>/SKILL.md`):
```markdown
---
name: tdd-pipeline
description: Test-driven development workflow
disable-model-invocation: true
---

You are the orchestrator for the **TDD Pipeline** workflow...

## Orchestration Flow

1. Start with **Backend Architect** to design the schema.
2. When the architect delivers the design, activate **Developer**. Pass the Design Doc (`docs/design.md`) forward.
3. If review passes, the workflow is complete.
4. If review fails, return to **Developer** with feedback. Pass the reviewer feedback forward.

## Escalation

If a subagent returns a blocked status, stop and present details to the user.
<!-- cwc:workflow:<uuid> -->
```

### Running tests / typecheck
```bash
npm test          # 61 tests, all passing
npm run typecheck # tsc --noEmit, clean
```

---

## Phase 2 Goal

Build the **React canvas UI + Node.js server** — the `npx cwc` product that users actually interact with.

### Architecture

```
npx cwc
  └─ Node.js server (detached background process)
       ├─ Serves the React SPA
       ├─ REST/WebSocket API for all file system operations
       │    ├─ Read/write .cwc files
       │    ├─ Scan ~/.claude/agents/ and .claude/agents/
       │    ├─ Run the exporter (calls exportWorkflow())
       │    └─ Maintain ~/.cwc/recents.json
       └─ Writes PID to ~/.cwc/server.pid
```

- `npx cwc` — start server + open browser, reuse if already running
- `npx cwc stop` — kill background process
- Browser SPA — React + React Flow for the canvas
- Server handles ALL file system operations; browser never touches disk directly

### Design decisions locked in

1. **Template-first UX** — on "New Workflow", user sees a template picker grid, not a blank canvas
2. **completionCriteria is required** on every agent node (already in schema, already exported)
3. **Agent authoring: three paths** — drag from Library, AI-generate (one sentence → GPT fills fields), or manual form. No blank-form-only UX.
4. **Built-in agent library** (~20–30 curated agents) in left sidebar; drag to canvas copies full definition into `.cwc` node
5. **My Agents tab** — read-only scan of `~/.claude/agents/` and `.claude/agents/` at launch; searchable + grouped by source directory
6. **Edge context = typed artifacts** — already in schema (`CwcArtifact[]`); canvas renders them as chips on edges
7. **Observability is v1.5**, not v1 — MCP server injected post-export; fire-and-forget
8. **My Agents: searchable + grouped by directory**, no further categorization
9. **Canvas validation is continuous** — warnings as yellow node indicators; only two hard export blocks: empty workflow and any node with empty `agent.name`
10. **File-anywhere save** — standard file dialog; `~/.cwc/recents.json` tracks last 10 paths
11. **Auto-save on every canvas change** — 500ms debounce, no "unsaved" state
12. **Detached server** — `npx cwc stop` to kill; terminal can be closed immediately after `npx cwc`

### Canvas UX details

**Left sidebar — Agents panel:**
- Library tab: curated ~20–30 agents, drag to canvas copies full definition
- My Agents tab: scanned from `~/.claude/agents/` + `.claude/agents/`, searchable, grouped by directory
- Create button: "Describe it" (AI) or "Build it" (manual form)

**Left sidebar — Skills panel:**
- Lists `~/.claude/skills/` and plugin-cache skills
- Drag onto an existing node → added to `node.agent.skills`

**Right panel (on node click):**
- name, description, systemPrompt, completionCriteria ("How will you know this agent succeeded?")
- tools (multi-select), skills (chips), derived slug shown live as "Will export as: `backend-architect`"
- `startTrigger` field appears only on entry nodes (no incoming edges)

**Right panel (on edge click):**
- trigger (prose field), artifacts (typed context), terminalType (if terminal edge), display label

**Export flow:**
- Preview pane shows exact file contents before any writes
- Conflict modals for foreign/absent ownership (overwrite or cancel — atomic, no partial writes)
- Export target: "This project only" or "All my projects"

### Node layout algorithm (for templates / import)
- BFS-ordered, left-to-right per level
- 300px horizontal spacing, 200px vertical spacing between levels

### Out of scope for v1
- MCP wiring
- Parallel convergence (multi-edge fan-in)
- Zip export
- Community library
- Live execution visualization

---

## Spec and plan documents

```
docs/superpowers/specs/2026-05-24-composition-schema-design.md  ← full product spec
docs/superpowers/plans/2026-05-25-exporter-and-test-harness.md  ← Phase 1 plan (already done)
```

The spec is the source of truth for all behavior. Read it before writing the Phase 2 plan.

---

## Tech stack so far

```json
{
  "type": "module",
  "dependencies": {
    "gray-matter": "^4.0.3",
    "uuid": "^9.0.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

ESM TypeScript throughout (`"module": "NodeNext"`). All imports use `.js` extensions. Tests in `tests/`, source in `src/`, compiled output in `dist/`.

Phase 2 will need to add (at minimum): React, React Flow, Express or similar Node.js HTTP server, a bundler (Vite), and a CLI entry point.

---

## How to start Phase 2

1. Read `docs/superpowers/specs/2026-05-24-composition-schema-design.md` in full
2. Run `npm test` to verify Phase 1 baseline is clean
3. Write the Phase 2 implementation plan to `docs/superpowers/plans/YYYY-MM-DD-canvas-ui.md`
4. Execute plan task by task using subagent-driven development
