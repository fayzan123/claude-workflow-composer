# Claude Workflow Composer

A visual desktop app for composing multi-agent coding workflows for [Claude Code](https://claude.ai). Drag agents, attach skills, wire handoffs, and export to `.claude/` — no YAML editing required.

## Quick Start

```bash
npm run build && npm start
```

Opens a browser at `http://localhost:3579`. Create a workflow by dragging agents from the sidebar onto the canvas, connecting them, and exporting.

## Lifecycle

### Build

Drag an **existing agent** from the sidebar (`~/.claude/agents/`) onto the canvas to create a **reference node** — it points to that agent file by slug rather than duplicating it. Drag from **"New / Blank Agent"** to create a **bespoke node** — the exporter generates a new agent file for it.

Connect nodes by dragging between handles. Each connection becomes a **handoff** with a trigger description and optional context artifacts (files, text, JSON) passed between agents. Mark any node as a **terminal** (`Complete`, `Escalated`, or `Aborted`) to define workflow end states.

Edit any node's completion criteria, tool access, skills, and system prompt in the **Node Panel**. The first node can also have a **start trigger** describing what initiates the workflow.

The client runs **real-time validation** — duplicate slugs, empty names, disconnected nodes, and missing completion criteria all surface immediately as warnings or errors in the top bar.

### Export

Click **Export** in the top bar. Choose a **target directory** — either your project's `.claude/` or `~/.claude/`. Review a **preview** of every file that will be written (files are generated server-side but not saved yet). Confirm to write.

The exporter does:

- **Bespoke nodes**: writes an agent `.md` file to `.claude/agents/<slug>.md` with frontmatter (name, description, color, model, tools), system prompt, completion criteria, skill references, and an ownership comment.
- **Reference nodes**: writes nothing — the `exportedSlug` is set to the existing agent's slug so the orchestrator routes to it directly.
- **Workflow skill**: generates an orchestrator skill at `.claude/skills/<workflow-slug>/SKILL.md` with `disable-model-invocation: true`. The orchestrator body is produced by BFS-traversing the node/edge graph into natural-language steps.
- **Rename handling**: if a node was renamed (slug changed), the old owned file is deleted and the new one is written.
- **Conflict detection**: every file carries an ownership HTML comment. Before overwriting or deleting, the exporter verifies ownership — it never touches files created by other workflows or by hand.

The **preview** endpoint lets you review the full set of files that *would* be written before confirming, with all warnings surfaced (unresolved skills, foreign file overwrites, etc.).

### Run

From a terminal with Claude Code, invoke the workflow skill:

```
claude ~/.claude/skills/<workflow-slug>/SKILL.md
```

The orchestrator skill's body instructs Claude to delegate every implementation step to sub-agents via the Agent tool — it never reads or writes files directly. Each step references an agent by name; Claude Code resolves it to the agent's `.md` file (or the existing agent file for reference nodes) and loads its system prompt, tools, and completion criteria.

### Delete

The **export delete** endpoint (`POST /api/export/delete`) scans every exported file, checks its ownership comment, and only removes files owned by the current workflow. Reference nodes have nothing to delete — they didn't write any files.

## Features

- **Visual canvas** using React Flow with background grid, minimap, zoom controls, and drag-to-connect
- **Left sidebar** with two tabs: My Agents (searchable, draggable) and Skills (searchable, draggable onto selected nodes)
- **Right panels**: Node Editor (name, description, criteria, tools, skills, system prompt, terminal type) and Edge Editor (trigger, label, context artifacts)
- **Export modal** with target selection, file preview, and warning display
- **Auto-save** (500ms debounced) to `~/.cwc/workflows/` — no manual saving needed
- **Recent files** on the home screen (max 10, persisted to `~/.cwc/recents.json`)
- **Markdown preview** — click any agent or skill card to view its source file
- **Claude Code detection** on startup — warns if `~/.claude/` is missing
- **Real-time validation** — missing names, duplicate slugs, disconnected nodes, empty workflows
- **Open in editor** — view any agent or skill file in your system editor

## Architecture

```
Client (React + React Flow)       Server (Express :3579)
┌─────────────────────────┐       ┌─────────────────────┐
│ TemplatePicker           │ ──►  │ /api/workflows      │
│ TopBar                   │ ◄──  │ /api/recents        │
│ Sidebar (Agents/Skills)  │ ──►  │ /api/agents         │
│ Canvas (React Flow)      │ ──►  │ /api/skills         │
│ NodePanel / EdgePanel    │ ──►  │ /api/export         │
│ ExportFlow (modal)       │ ──►  │ /api/export/preview │
│ useWorkflow (reducer)    │      │ /api/export/delete  │
│ useAutoSave (debounced)  │      │ /api/health         │
└─────────────────────────┘       └─────────────────────┘
                                          │
                                          ▼
Core Library                     ┌─────────────────────┐
                                  │ bfs.ts               │
                                  │ conflict-detector.ts │
                                  │ exporter.ts          │
                                  │ file-writer.ts       │
                                  │ prose-generator.ts   │
                                  │ skill-resolver.ts    │
                                  │ slugify.ts           │
                                  └─────────────────────┘

Storage:
  ~/.cwc/
    recents.json          Recent file paths (max 10)
    workflows/            Saved .cwc workflow files
    server.pid            PID of running server
  ~/.claude/
    agents/*.md           Agent definitions (read + written)
    skills/*/SKILL.md     User skills (read by sidebar)
    plugins/cache/...     Plugin skills (read by sidebar)
```

## Key Concepts

| Concept | Description |
|---|---|
| **CwcFile** | JSON file format (`.cwc`) representing a full workflow: metadata, nodes, edges |
| **Bespoke node** | A node whose agent definition is authored in the UI — exporter writes a new `.md` file |
| **Reference node** | A node with an `agentRef` slug pointing to an existing agent on disk — exporter writes nothing |
| **Handoff** | A directed edge between nodes with a trigger description and optional context artifacts |
| **Terminal edge** | An edge with no target node — marks a workflow end state (complete/escalated/aborted) |
| **Ownership comment** | An HTML comment appended to every exported file: `<!-- cwc:node:<id>:workflow:<id> -->` |
| **Orchestrator skill** | The workflow skill generated on export — a Claude Code skill that delegates via Agent tool |
| **Conflict detection** | Reads the ownership comment from a file on disk to determine if this workflow can safely overwrite/delete it |

## Development

```bash
npm run dev:server          # Watch-mode server compilation
npm run dev:client          # Vite dev server with HMR (port 5173, proxies /api to :3579)
npm test                    # Run all tests (Vitest)
npm run typecheck           # Type-check server + client
npm run build               # Production build (server + client)
```

### CLI

```bash
npx cwc                    # Start server and open browser
npx cwc stop               # Stop server
```

## Tests

16 test files / 89 tests covering:

- **BFS traversal**: linear chains, back-edges, fan-out, multi-root, terminal edges
- **Prose generation**: start triggers, bold wrapping, context artifacts, Oxford comma, back-edge ordering
- **File writer**: frontmatter, skills block, ownership comments, workflow skill generation
- **Exporter**: full integration with real temp filesystem, rename cleanup, skill resolution, re-export, conflict warnings
- **Validation**: empty workflows, missing names, duplicate slugs, disconnected nodes
- **Graph layout**: horizontal spacing, fan-out vertical spacing, back-edge stability
- **HTTP endpoints**: all 12 API routes tested with real server instances
- **Slugify**: special chars, truncation, hyphen collapse, empty input
- **Conflict detection**: owned, foreign, absent, malformed states
- **Skill resolution**: namespaced (plugin) and non-namespaced (user) skill lookup
