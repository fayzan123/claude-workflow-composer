# Claude Workflow Composer

[![CI](https://github.com/fayzan123/claude-workflow-composer/actions/workflows/ci.yml/badge.svg)](https://github.com/fayzan123/claude-workflow-composer/actions/workflows/ci.yml)

**Find the work you keep repeating in Claude Code — and turn it into runnable workflows.** CWC scans your local Claude Code history, surfaces the tasks you do by hand again and again, and generates a multi-agent workflow you can run, schedule, and monitor. When you want to build one by hand, there's a visual canvas for that too.

![Claude Workflow Composer demo](demo.gif)

---

## Start here: scan your history

Run `npx claude-cwc`, then click **Scan my history** on the dashboard. CWC reads your Claude Code sessions, clusters the work you repeat, and offers the strongest candidates as one-click workflows. The visual canvas (below) is there when you want to compose or refine one yourself.

## The Problem

Building multi-agent workflows in Claude Code today means:

1. Hand-writing agent `.md` files with YAML frontmatter
2. Manually authoring orchestrator skills with `disable-model-invocation: true` and sequenced handoff prose
3. No visual representation of the pipeline before running it
4. No way to share a complete, working workflow with someone else
5. No way to discover what good pipelines look like

The authoring experience is entirely text-based. You can't see what you're building until you run it.

---

## Quick Start

```bash
npx claude-cwc
```

Opens a browser at `http://localhost:3579`. The local server binds to loopback and protects API calls with a per-run local token.

Use **Detect automations** from the Home dashboard to scan your local Claude Code history, find repeated work, and generate a ready-to-edit workflow from the strongest candidates.

```bash
npx claude-cwc stop    # Stop the server
```

On macOS, install the background service if you want scheduled automations to keep running after reboot:

```bash
npx claude-cwc install-service
npx claude-cwc uninstall-service
```

Or from source:

```bash
npm run build && npm start
```

---

## How It Works

```
Drag agents onto a canvas
  → Connect them with handoff arrows (author trigger conditions)
  → Edit each agent's system prompt, tools, skills, and completion criteria
  → Add schedules/webhooks in Automate mode when the workflow should run itself
  → Preview every file that will be written before exporting
  → Export → writes agent .md files + orchestrator SKILL.md to ~/.claude/
  → Invoke the workflow by name in Claude Code
```

The exporter writes directly to `~/.claude/` (user-scoped) or `.claude/` inside any project directory (project-scoped, version-controllable). Conflict detection ensures it never touches files it doesn't own.

### Build

Drag an **existing agent** from the sidebar (`~/.claude/agents/`) onto the canvas to create a **reference node** — it points to that agent file by slug rather than duplicating it. Drag from **"New / Blank Agent"** to create a **bespoke node** — the exporter generates a new agent file for it.

Connect nodes by dragging between handles. Each connection becomes a **handoff** with a trigger description and optional context artifacts (files, text, JSON) passed between agents. Mark any node as a **terminal** (`Complete`, `Escalated`, or `Aborted`) to define workflow end states.

Edit any node's completion criteria, tool access, skills, and system prompt in the **Node Panel**. The first node can also have a **start trigger** describing what initiates the workflow.

Real-time validation surfaces duplicate slugs, empty names, disconnected nodes, and missing completion criteria immediately in the top bar — before you export.

Use **Generate agent** or **Generate skill** in the sidebar to draft reusable Claude Code assets from a plain-English description. CWC gives you an editable spec first, then writes the file into `~/.claude/agents/` or `~/.claude/skills/`.

### Export

Click **Export** in the top bar. Choose a target directory (`~/.claude/` or any project's `.claude/`). Review a **preview** of every file that will be written. Confirm to write.

The exporter:

- **Bespoke nodes** → writes an agent `.md` file with frontmatter (name, description, color, model, tools), system prompt, completion criteria, skill references, and an ownership comment.
- **Reference nodes** → writes nothing — the `exportedSlug` is set to the existing agent's slug so the orchestrator routes to it directly.
- **Workflow skill** → generates an orchestrator skill at `.claude/skills/<workflow-slug>/SKILL.md`. By default it includes `disable-model-invocation: true`; the export modal can opt a single workflow into autonomous Claude invocation. The orchestrator body is produced by BFS-traversing the node/edge graph into natural-language steps.
- **Rename handling** → if a node was renamed, the old owned file is deleted and the new one is written.
- **Conflict detection** → every file carries an ownership HTML comment. Before overwriting or deleting, the exporter verifies ownership — it never touches files created by other workflows or by hand.

### Run

From any Claude Code session, invoke the workflow by its skill name:

```
/workflow-name
```

The orchestrator skill delegates every implementation step to sub-agents via the Agent tool. Each step references an agent by name; Claude Code resolves it to the agent's `.md` file and loads its system prompt, tools, and completion criteria.

### Automate

Open a workflow's **Automate** mode to add schedules and webhooks:

- **Cron** — use the schedule builder or enter a custom cron expression (e.g. `0 9 * * 1-5` for weekdays at 9 am).
- **Webhook** — CWC generates an inbound local URL; send an HTTP `POST` to fire the workflow.
- **Working directory / targets** — choose where the automation runs, including optional additional repos for fan-out.
- **Isolation** — use a git worktree for an isolated branch, or run in-place when you explicitly want the current checkout.
- **Precondition** — a shell command that must succeed before CWC starts the run.
- **Setup command** — a shell command CWC runs after the run starts, before Claude begins.

Add a **gate node** (drag from the "Gate" section of the sidebar) at any point in the workflow. When the run reaches a gate it:
1. Commits all changes to a `cwc/<runId>` branch and pauses.
2. Posts a diff of the working branch to the inbox in the Run panel.
3. Waits — the reviewer reads the diff, writes an optional note, and clicks **Approve** or **Reject**.
4. On approval, the run resumes in the same Claude Code session from the gate point.

The **Run panel** header has an **Automations** toggle that globally suspends all scheduled runs without disarming triggers, and a **⚙** gear that opens notification settings (macOS banners and/or a webhook URL).

### Detect

Click **Detect automations** on the Home dashboard to scan your local Claude Code history for repeated work. CWC parses local transcript files, builds compact digests, asks Claude to cluster recurring tasks, and shows candidates with evidence, confidence, observed steps, and a suggested trigger.

Click **Generate workflow** on a candidate to promote it into a real `.cwc` workflow. CWC looks for matching local skills and existing agents, asks Claude to compose the workflow, validates the generated graph, seeds disabled schedule triggers when appropriate, and opens the workflow for review.

### Delete

`POST /api/export/delete` scans every exported file, checks its ownership comment, and only removes files owned by the current workflow. Reference nodes have nothing to delete — they didn't write any files.

---

## Features

- **Visual canvas** — React Flow with background grid, minimap, zoom controls, and drag-to-connect
- **Theme toggle** — switch between light and dark mode from the Home dashboard or workflow header
- **Left sidebar** — My Agents (searchable, draggable from `~/.claude/agents/`) and Skills (searchable, draggable onto selected nodes)
- **Generate agent / skill** — draft new reusable Claude Code assets from plain English, refine the spec, then save to `~/.claude/`
- **Right panels** — Node Editor (name, description, criteria, tools, skills, system prompt, terminal type) and Edge Editor (trigger, label, context artifacts)
- **Export modal** — target selection, full file preview, warning display before writing anything
- **Auto-save** — 500ms debounced save to `~/.cwc/workflows/`, no manual saving needed
- **Recent files** — home screen shows last 10 workflows, persisted to `~/.cwc/recents.json`
- **Markdown preview** — click any agent or skill card to view its source file
- **Open in editor** — view any agent or skill file in your system editor
- **Claude Code detection** — warns on startup if `~/.claude/` is missing
- **▶ Test Run** — launch an exported workflow headlessly from the UI (`--permission-mode bypassPermissions`, user-chosen working directory, worktree or in-place isolation) and stop it mid-run
- **Live run view** — the active node pulses on the canvas, completed nodes get a check, and events stream into a timeline panel
- **Run history** — every run of every exported workflow (started from CWC *or* any terminal) persists to `~/.cwc/runs/` with status, duration, source, and cost
- **Automate mode** — attach cron schedules or webhook URLs to a workflow, choose targets/isolation, add preconditions/setup commands, and arm trusted triggers
- **Approval gates** — insert a gate node into any workflow; when reached the run pauses and posts a diff of its working branch, a reviewer approves or rejects from the inbox (or terminal), the run resumes on the same session
- **Isolated runs** — Test Run (and scheduler-fired runs) create a git worktree on a `cwc/<runId>` branch so the main checkout is always untouched; the worktree is removed after the run completes
- **Notifications** — macOS banner + optional webhook on run complete, gate pause, and approval request; configured from the settings gear in the Run panel
- **Global pause** — one toggle in the Run panel suspends all scheduled automation runs without disarming triggers
- **Detect automations** — scans local Claude Code transcripts, clusters repeated work, streams progress, suggests automations, and promotes a candidate into a `.cwc` workflow with matching skills/agents reused when possible

---

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
│ RunModal / RunPanel      │ ──►  │ /api/export/delete  │
│ useWorkflow (reducer)    │      │ /api/runs (+SSE)    │
│ useAutoSave (debounced)  │      │ /api/automations    │
│ useRunEvents (SSE)       │ ◄──  │ /api/triggers       │
│ Detect automations       │ ◄──  │ /api/automation-scan│
└─────────────────────────┘       └─────────────────────┘
                                          │
                                          ▼
Core Library                     ┌─────────────────────────┐
                                  │ bfs.ts                   │
                                  │ conflict-detector.ts     │
                                  │ exporter.ts              │
                                  │ file-writer.ts           │
                                  │ prose-generator.ts       │
                                  │ skill-resolver.ts        │
                                  │ slugify.ts               │
                                  │ run-events.ts            │
                                  └─────────────────────────┘

Server modules                   ┌─────────────────────────┐
                                  │ run-store.ts             │
                                  │ workflow-runner.ts       │
                                  │ run-isolation.ts         │
                                  │ run-launcher.ts          │
                                  │ automation-state.ts      │
                                  │ automation-scheduler.ts  │
                                  │ notifier.ts              │
                                  │ config.ts                │
                                  └─────────────────────────┘

Storage:
  ~/.cwc/
    recents.json              Recent file paths (max 10)
    workflows/                Saved .cwc workflow files
    runs/<workflowId>/        Run event logs (one .jsonl per run)
    worktrees/                Git worktrees for isolated runs (auto-cleaned)
    automation-state.json     Global pause flag + per-trigger arm state
    automation-scan.json      Latest history scan, suggestions, promotion state, and logs
    config.json               Notification settings (macos, webhookUrl)
    server.pid                PID of running server
  ~/.claude/
    agents/*.md               Agent definitions (read + written)
    skills/*/SKILL.md         User skills (read by sidebar)
    plugins/cache/...         Plugin skills (read by sidebar)
```

---

## Key Concepts

| Concept                | Description                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| **CwcFile**            | JSON file format (`.cwc`) representing a full workflow: metadata, nodes, edges                               |
| **Bespoke node**       | A node whose agent definition is authored in the UI — exporter writes a new `.md` file                       |
| **Reference node**     | A node with an `agentRef` slug pointing to an existing agent on disk — exporter writes nothing               |
| **Handoff**            | A directed edge with a trigger description and optional context artifacts                                    |
| **Terminal edge**      | An edge with no target node — marks a workflow end state (complete/escalated/aborted)                        |
| **Ownership comment**  | HTML comment appended to every exported file: `<!-- cwc:node:<id>:workflow:<id> -->`                         |
| **Orchestrator skill** | The workflow skill generated on export — a Claude Code skill that delegates via Agent tool                   |
| **Conflict detection** | Reads the ownership comment from a file on disk to determine if this workflow can safely overwrite/delete it |
| **Gate node**          | A `nodeType: 'gate'` node that pauses a run at a checkpoint, diffs the branch, and waits for approval       |
| **Trigger**            | A cron / webhook / manual definition attached to a workflow node; scheduler evaluates it on each tick        |
| **Isolation**          | Worktree mode creates a `cwc/<runId>` branch so the main checkout is never modified by an automated run     |

---

## Why Open Source

This tool has filesystem access to `~/.claude/`. Open source is the trust model — no cloud dependency, and the local Node.js server is the entire backend. The server binds to `127.0.0.1`, restricts cross-origin API access, and protects packaged-app API requests with a per-run local token.

---

## Development

```bash
npm run dev:server          # Watch-mode server compilation
npm run dev:client          # Vite dev server with HMR (port 5173, proxies /api to :3579)
npm test                    # Run all tests (Vitest)
npm run typecheck           # Type-check server + client
npm run build               # Production build (server + client)
```

### Tests

479 tests across 61 files (run `npm test` for the current count) covering:

- **BFS traversal**: linear chains, back-edges, fan-out, multi-root, terminal edges
- **Prose generation**: start triggers, bold wrapping, context artifacts, Oxford comma, back-edge ordering
- **File writer**: frontmatter, skills block, ownership comments, workflow skill generation
- **Exporter**: full integration with real temp filesystem, rename cleanup, skill resolution, re-export, hard conflict failures for foreign or hand-authored files
- **Validation**: empty workflows, missing names, duplicate slugs, disconnected nodes
- **Graph layout**: horizontal spacing, fan-out vertical spacing, back-edge stability
- **HTTP endpoints**: all API routes tested with real server instances
- **Slugify**: special chars, truncation, hyphen collapse, empty input
- **Conflict detection**: owned, foreign, absent, malformed states
- **Server hardening**: local API token enforcement, workflow path confinement, export target path validation
- **Skill resolution**: namespaced (plugin) and non-namespaced (user) skill lookup
- **Claude runner**: binary resolution (incl. Windows shims), stdin prompt delivery, timeout/error envelopes
- **Undo history**: coalescing, redo-stack clearing, edge cascade on node delete, history cap
- **Run isolation**: worktree create/remove, diff generation, git detection
- **Run launcher**: fireWorkflow lifecycle, worktree + in-place paths, classifyAndFinish
- **Automation scheduler**: cron firing, precondition checks, daily cap, global pause gate
- **Automation state**: arm/disarm, paused flag persistence, trigger hashing
- **Gate endpoints**: approve (resume), reject, 409 on wrong state, diff response
- **Notifier**: macOS toast, webhook POST, event filtering
- **Automation detection**: transcript parsing, digest building, analysis parsing, streamed scan logs, model allowlist, promote/cancel workflow generation, and trigger seeding
- **Help copy and theme preference**: glossary terms, control hints, light/dark theme parsing, and dashboard event helpers

---

## Contributing

PRs welcome. The codebase is TypeScript end-to-end (client + server + core library). Run `npm test` and `npm run typecheck` before submitting.

If you build a workflow you're proud of, share the `.cwc` file — that's how the community library grows.

---

## License

MIT
