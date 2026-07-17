# Claude Workflow Composer

[![CI](https://github.com/fayzan123/claude-workflow-composer/actions/workflows/ci.yml/badge.svg)](https://github.com/fayzan123/claude-workflow-composer/actions/workflows/ci.yml)

**Find the work you keep repeating in Claude Code — and turn it into the smallest useful automation.** CWC scans your local Claude Code history, surfaces the tasks you do by hand again and again, and recommends a rule, skill, managed loop, or multi-agent workflow. Runnable artifacts can be edited, exported, tested, scheduled, and monitored locally.

![Claude Workflow Composer demo](demo.gif)

---

## Start here: scan your history

Run `npx claude-cwc`, then click **Scan my history** on the dashboard. CWC reads your Claude Code sessions, clusters the work you repeat, and recommends the lightest artifact that fits each candidate. Review or override that recommendation before CWC generates anything. The visual canvas is reserved for work that genuinely needs a multi-agent workflow.

## The Problem

Turning repeated Claude Code work into a reliable automation usually means choosing and maintaining several different primitives:

1. Hand-writing agent `.md` files with YAML frontmatter
2. Manually authoring orchestrator skills with `disable-model-invocation: true` and sequenced handoff prose
3. Deciding whether the work needs a durable instruction, one skill, a recurring loop, or a multi-agent graph
4. No visual representation of a pipeline before running it
5. No unified way to test, schedule, observe, and share the result

CWC makes that sizing decision explicit while keeping the filesystem output inspectable.

---

## Quick Start

```bash
npx claude-cwc
```

Opens a browser at `http://localhost:3579`. The local server binds to loopback and protects API calls with a per-run local token.

Use **Detect automations** from the Home dashboard to scan your local Claude Code history, find repeated work, review rule suggestions, and generate ready-to-edit skills, loops, or workflows from the strongest candidates.

On first run, CWC may offer to install an optional Claude Code skill at `~/.claude/skills/cwc-generate-workflow/SKILL.md`. That skill lets you ask Claude Code to generate a `.cwc` workflow from plain English. Remove it with:

```bash
npx claude-cwc uninstall-skill
```

```bash
npx claude-cwc stop    # Stop the server
```

On macOS, install the background service if you want scheduled automations to keep running after reboot:

```bash
npx claude-cwc install-service
npx claude-cwc uninstall-service
```

### Troubleshooting: Detect fails or finds nothing

If a history scan errors out or reports no automations when you expect some, run the offline health check:

```bash
npx claude-cwc doctor --bundle
```

It checks your environment (Claude binary, transcript discovery, per-file parsing) without invoking Claude, prints a verdict, and writes `cwc-doctor-bundle.json`. The bundle is redacted — it contains counts, versions, entry-type tallies, and project folder names, never your prompts, commands, or conversation content — so it's safe to attach to a [GitHub issue](https://github.com/fayzan123/claude-workflow-composer/issues). After a failed in-app scan, the same diagnostics are available at `http://localhost:3579/api/automation-scan/diagnostics`.

Or from source:

```bash
npm run build && npm start
```

---

## How It Works

```
Scan local Claude Code history
  → Classify each repetition as Rule, Skill, Loop, or Workflow
  → Review the recommendation and choose a different tier when needed
  → Edit a skill directly, or refine a multi-agent workflow on the canvas
  → Add schedules/webhooks in Automate mode when the artifact should run itself
  → Preview every file that will be written before exporting
  → Export to ~/.claude/ or a project's .claude/
  → Run directly in Claude Code or through CWC's managed-run harness
```

The exporter writes directly to `~/.claude/` (user-scoped) or `.claude/` inside any project directory (project-scoped, version-controllable). Conflict detection ensures it never touches files it doesn't own.

### Build and edit

Skill and loop artifacts open in a focused editor for their name, description, and Markdown body, with loop status and a direct link to Automate settings alongside it. They are stored as `.cwc` files for the same autosave, export, and managed-run behavior as workflows, but do not pretend to be agent graphs.

Choose **Open as workflow** to graduate a skill or loop explicitly. The current edited body is authoritative: a numbered checklist seeds focused phases, while an unstructured body becomes one phase without resurrecting removed detection steps. Safe operational constraints remain available across phases, and external actions stay behind their approval boundaries. A workflow can be converted back to a skill only when it contains one bespoke agent and no real handoff; an optional terminal edge is safe to discard. Both conversions are explicit, undoable editor actions, and the next export previews the resulting file changes.

For workflow artifacts, drag an **existing agent** from the sidebar (`~/.claude/agents/` or project `.claude/agents/`) onto the canvas to create a **reference node** — it points to that agent file by slug rather than duplicating it. Drag **New Agent** to create a **bespoke node** — the exporter generates a new agent file for it. Drag **Approval Gate** to add a human checkpoint.

Connect nodes by dragging between handles. Each connection becomes a **handoff** with a trigger description and optional context artifacts (files, text, JSON) passed between agents. Mark any node as a **terminal** (`Complete`, `Escalated`, or `Aborted`) to define workflow end states.

Edit any node's completion criteria, tool access, skills, and system prompt in the **Node Panel**. The first node can also have a **start trigger** describing what initiates the workflow.

Real-time validation surfaces duplicate slugs, empty names, disconnected nodes, and missing completion criteria in the workflow header before you export.

Use **Generate agent** or **Generate skill** in the sidebar to draft reusable Claude Code assets from a plain-English description. CWC gives you an editable spec first, then writes the file into `~/.claude/agents/` or `~/.claude/skills/`. The **Discover** sidebar tab links to community agent and skill repositories.

### Export

Click **Export** in the artifact header. Choose a target directory (`~/.claude/` or any project's `.claude/`). Review a **preview** of every file that will be written or removed. Confirm to apply it.

The exporter:

- **Plain skill / loop** → writes exactly one `.claude/skills/<slug>/SKILL.md`, with no `cwc-` prefix, orchestrator prose, or agent files. A loop's trigger remains in its `.cwc` metadata and is armed separately in CWC.
- **Workflow skill** → generates an orchestrator at `.claude/skills/cwc-<workflow-slug>/SKILL.md` and writes agent files for its bespoke nodes. By default the skill includes `disable-model-invocation: true`; the export modal can opt an artifact into autonomous Claude invocation outside CWC's isolated-run harness. The orchestrator body is produced by BFS-traversing the graph into natural-language steps.
- **Bespoke workflow nodes** → writes an agent `.md` file with frontmatter (name, description, color, model, tools), system prompt, completion criteria, skill references, and an ownership comment.
- **Reference nodes** → writes nothing — the `exportedSlug` is set to the existing agent's slug so the orchestrator routes to it directly.
- **Rename and conversion handling** → stages the complete new deployment, retains exact rollback bytes for replaced and removed paths, and publishes the new `.cwc` deployment identity inside the same transaction. A recipe conflict or later write failure restores the entire prior deployment.
- **Conflict detection** → every managed file carries an ownership HTML comment. Before overwriting or deleting, the exporter verifies ownership — it never touches files created by other artifacts or by hand.

### Run

From any Claude Code session, invoke the exported artifact by its skill name:

```
/plain-skill-name        # skill or loop
/cwc-workflow-name       # multi-agent workflow
```

Plain skills run their instructions directly. A workflow orchestrator delegates its implementation steps to sub-agents via the Agent tool; Claude Code resolves each agent name to its `.md` file and loads its prompt, tools, and completion criteria.

You can also use **Test run** from CWC after exporting a skill, loop, or workflow. Test runs spawn Claude Code headlessly with `--permission-mode bypassPermissions`, use a chosen working directory, and can run in a git worktree or in-place. Rules are guidance-file edits, not runnable artifacts.

At launch, CWC binds the exact verified skill and every plain filesystem-backed dispatched agent into a private, namespaced plugin for that run. This carries untracked or dirty project exports and reference agents into isolated worktrees without changing their bytes. Exported skills carry a `cwc:bespoke-agents` declaration so reference agents remain externally owned while missing, replaced, shadowed, or malformed dependencies fail closed. Namespaced plugin-agent dispatches are refused by managed runs until CWC can resolve and snapshot their exact installed bytes; they never fall through to mutable code under `bypassPermissions`. Dispatching exports created before this metadata was introduced must be re-exported once. Later exports or deletes cannot change an active run halfway through. Approval gates retain and revalidate the same binding across server restarts; a missing or changed binding is never replaced with the current deployment during resume.

Completed isolated runs stay reviewable in **Runs** regardless of artifact tier. CWC checkpoints tracked and untracked output onto the run's `cwc/<artifact-skill>/<runId>` branch, removes the temporary worktree, and offers two deliberate result actions:

- **Apply result** — fast-forwards the original checkout only when it is still the same repository, completely clean (including untracked files), and still at the recorded base commit. CWC never stashes, resets, rebases, cherry-picks, creates a merge commit, or resolves conflicts.
- **Discard** — after an inline confirmation, deletes only the exact CWC result branch recorded by the run. A renamed, moved, foreign, or checked-out branch is preserved.

Each managed run has a server-owned `<runId>.manifest.json` beside its JSONL timeline. The manifest records repository/base/worktree/result authority, immutable runtime-binding authority, and the Apply/Discard disposition. Exported artifact logging can append timeline events, but `POST /api/runs/events` cannot create or change a manifest and event-only legacy runs never receive Git actions.

The result endpoints are `GET /api/runs/:runId/diff`, `POST /api/runs/:runId/apply`, and `POST /api/runs/:runId/discard`; each requires the matching `workflowId`, and Discard additionally requires `confirmed: true`. Preflight conflicts return `409` with an actionable reason and leave both the destination and result branch unchanged.

### Automate

Open a runnable artifact's **Automate** mode to add schedules and webhooks. Generated loop schedules start disabled and are never armed without an explicit user action:

- **Cron** — use the schedule builder or enter a custom cron expression (e.g. `0 9 * * 1-5` for weekdays at 9 am).
- **Webhook** — CWC generates an inbound local URL (`POST http://localhost:3579/api/triggers/<token>`) to fire the artifact.
- **Working directory / targets** — choose where the automation runs, including optional additional repos for fan-out.
- **Isolation** — use a git worktree for an isolated branch, or run in-place when you explicitly want the current checkout.
- **Precondition** — a shell command that must succeed before CWC starts the run.
- **Setup command** — a shell command CWC runs after the run starts, before Claude begins.

Workflow artifacts can add a **gate node** (drag from the "Gate" section of the sidebar) at any point. When the run reaches a gate it:
1. Commits all changes to a `cwc/<runId>` branch and pauses.
2. Posts a diff of the working branch to the approval inbox in Runs mode and on the Home dashboard.
3. Waits — the reviewer reads the diff, writes an optional note, and clicks **Approve** or **Reject**.
4. On approval, the run resumes in the same Claude Code session from the gate point.

The Home dashboard has an **Automations** widget that globally pauses or resumes scheduled/webhook runs without deleting or disarming triggers. Runs mode shows live/history timelines, approval inbox items, diffs, Apply/Discard state for completed isolated results, a stop button for active CWC-managed runs, and notification settings (macOS banners and/or a webhook URL).

### Detect

Click **Detect automations** on the Home dashboard to scan your local Claude Code history for repeated work. CWC parses local transcript files, builds compact digests, asks Claude to cluster recurring tasks, and shows candidates with evidence, confidence, observed steps, and a suggested trigger.

Each candidate receives a deterministic recommendation:

- **Rule** — a repeated instruction with no meaningful tool activity. CWC shows the suggested line and only adds it after you explicitly choose user-level `~/.claude/CLAUDE.md` or an evidence project's `AGENTS.md`. Owned marker blocks make the rule removable without rewriting surrounding guidance.
- **Skill** — a linear, single-role procedure. CWC generates one readable skill with a deterministic checklist fallback if generation fails.
- **Loop** — a skill with an observed schedule or verify/retry pattern. CWC preserves observed verification, seeds any generated trigger disabled, and defaults automation isolation to a worktree.
- **Workflow** — work with genuine independent branches or role changes, or any risky external action such as publishing or communicating. This conservative safety rule keeps gate-capable work on the canvas.

When history shows a mutating MCP/connector tool, CWC keeps its exact observed name on one
approval-gated bespoke agent. It does not broaden every phase's tool access or silently attach the
capability to a reference agent with a different immutable tool policy.

The promotion dialog marks the recommendation and lets you choose another tier. The selected tier is recorded with the candidate; CWC never silently escalates a smaller artifact into a workflow. Rules are applied immediately to the chosen guidance file, while skills, loops, and workflows are saved as `.cwc` artifacts and opened for review.

### Delete

`POST /api/export/delete` scans exported files, checks their ownership comments, and only removes files owned by the current artifact. Reference nodes have nothing to delete — they didn't write any files.

---

## Features

- **Visual canvas** — React Flow with background grid, minimap, zoom controls, and drag-to-connect
- **Right-sized generation** — deterministic Rule / Skill / Loop / Workflow recommendations with an explicit tier override before generation
- **Focused skill editor** — edit one skill's identity and Markdown without canvas overhead; graduate it to a workflow or safely demote a one-node workflow
- **Theme toggle** — switch between light and dark mode from the Home dashboard or workflow header
- **Left sidebar** — My Agents (searchable, draggable from user/project `.claude/agents/`), Skills (searchable, draggable onto selected nodes), and Discover links for community assets
- **Generate agent / skill** — draft new reusable Claude Code assets from plain English, refine the spec, then save to `~/.claude/`
- **Right panels** — Node Editor (name, description, criteria, tools, skills, system prompt, terminal type) and Edge Editor (trigger, label, context artifacts)
- **Export modal** — target selection, full file preview, warning display before writing anything
- **Auto-save** — 500ms debounced save to `~/.cwc/workflows/`, no manual saving needed
- **Saved artifacts** — home screen lists `.cwc` skills, loops, and workflows from `~/.cwc/workflows/`; opened paths are also tracked in `~/.cwc/recents.json`
- **Markdown preview** — click any agent or skill card to view its source file
- **Open in editor** — view any agent or skill file in your system editor
- **Claude Code detection** — warns on startup if `~/.claude/` is missing
- **Test run** — launch an exported skill, loop, or workflow headlessly from the UI (`--permission-mode bypassPermissions`, user-chosen working directory, worktree or in-place isolation) and stop it mid-run
- **Live run view** — the active node pulses on the canvas, completed nodes get a check, and events stream into a timeline panel
- **Run history** — JSONL timelines and server-owned managed-run manifests persist under `~/.cwc/runs/` with status, duration, source, cost, and isolated-result disposition
- **Automate mode** — attach cron schedules or webhook URLs to a runnable artifact, choose targets/isolation, add preconditions/setup commands, and arm trusted triggers
- **Approval gates** — insert a gate node into any workflow; when reached the run pauses and posts a diff of its working branch, a reviewer approves or rejects from the inbox (or terminal), the run resumes on the same session
- **Isolated runs** — Test Run (and scheduler-fired runs) create a git worktree on a CWC-owned branch so the main checkout stays untouched during execution; completed results can be reviewed, safely fast-forwarded, or explicitly discarded
- **Notifications** — macOS banner + optional webhook on run complete, gate pause, and approval request; configured from Runs mode
- **Global pause** — one Home dashboard toggle suspends all scheduled and webhook automation runs without disarming triggers
- **Detect automations** — scans local Claude Code transcripts, clusters repeated work, streams progress, classifies candidates by artifact tier, and supports explicit rule application or `.cwc` generation

---

## Architecture

```
Client (React + React Flow)             Server (Express :3579)
┌──────────────────────────────┐        ┌─────────────────────────────┐
│ HomeDashboard                 │ ────► │ /api/workflows              │
│ DetectView + DetectHero       │ ◄───► │ /api/automation-scan (+SSE) │
│ WorkflowView + WorkflowHeader │ ────► │ /api/recents                │
│ BuildMode / SkillBuildMode    │ ────► │ /api/agents                 │
│   Sidebar                     │ ────► │ /api/skills                 │
│   Canvas (React Flow)         │ ────► │ /api/agents/generate        │
│   StepDrawer                  │ ────► │ /api/skills/generate        │
│   OrchestratorPreview         │ ────► │ /api/export/preview         │
│ RunsMode                      │ ◄───► │ /api/runs (+SSE)            │
│ AutomateMode                  │ ────► │ /api/automations            │
│ RunModal                      │ ────► │ /api/triggers               │
│ ExportFlow                    │ ────► │ /api/export                 │
│ useWorkflow/useAutoSave       │ ────► │ /api/export/delete          │
└──────────────────────────────┘        │ /api/exported-workflows     │
                                        │ /api/file-content           │
                                        │ /api/open-file              │
                                        │ /api/service-status         │
                                        │ /api/claude-check           │
                                        │ /api/health                 │
                                        └─────────────────────────────┘

Core library:
  schema.ts                 Canonical .cwc types
  slugify.ts                Shared slug normalization
  run-events.ts             Run event schema and validation
  workflow/bfs.ts           Graph traversal
  workflow/prose-generator.ts
                            Orchestrator prose generation
  export/exporter.ts        Export orchestration, slug reconciliation, conflict checks
  export/file-writer.ts     Agent and workflow skill Markdown output
  export/conflict-detector.ts
                            Ownership-comment detection
  export/skill-resolver.ts  User/plugin skill lookup
  detection/*               Claude Code transcript parsing, digesting, analysis
  generation/classifier.ts  Deterministic artifact-tier selection
  generation/generate.ts    Tier-aware skill/loop/workflow generation
  generation/*              Skill generation and workflow planning/compilation

Server modules:
  security.ts               API token cookie, auth middleware, CORS rules
  launcher.ts               CLI/server launch and port-collision handling
  run-store.ts              JSONL run persistence and SSE fan-out
  run-manifest.ts           Versioned managed-run authority and serialized transitions
  run-skill-binding.ts      Immutable per-run skill/agent plugin snapshots
  workflow-runner.ts        Headless Claude Code process spawning
  run-isolation.ts          Git worktrees, verified diffs, Apply/Discard preflight and mutation
  run-launcher.ts           Test/scheduled/webhook run lifecycle
  automation-state.ts       Trigger arm/pause/fire bookkeeping
  automation-scheduler.ts   Cron trigger evaluation
  trigger-targets.ts        Target repo fan-out resolution
  scan-store.ts             Detection scan, classification, rule, and generation state
  rule-files.ts             Owned CLAUDE.md/AGENTS.md rule-block edits
  streaming-analyzer.ts     Streaming Claude analysis runner
  notifier.ts               macOS and webhook notifications
  config.ts                 Notification config persistence

Storage:
  ~/.cwc/
    recents.json              Recent file paths (max 10)
    workflows/                Saved .cwc skill, loop, and workflow artifacts
    runs/<workflowId>/        <runId>.jsonl timelines + <runId>.manifest.json managed authority
    worktrees/                Git worktrees plus .skill-bindings/ for active/paused run plugins
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
| **Artifact tier**      | The right-sized result for a repetition: Rule, Skill, Loop, or Workflow                                      |
| **CwcFile**            | Versioned JSON container (`.cwc`) for runnable skills, loops, and workflows: metadata, nodes, and edges       |
| **Rule**               | An explicitly applied, ownership-marked instruction in user `CLAUDE.md` or an evidence project's `AGENTS.md` |
| **Plain skill**        | A single procedural skill exported at `.claude/skills/<slug>/SKILL.md`, with no agent dispatch               |
| **Loop**               | A plain skill with recurrence and/or an observed verification condition, runnable through CWC's managed harness |
| **Bespoke node**       | A node whose agent definition is authored in the UI — exporter writes a new `.md` file                       |
| **Reference node**     | A node with an `agentRef` slug pointing to an existing agent on disk — exporter writes nothing               |
| **Handoff**            | A directed edge with a trigger description and optional context artifacts                                    |
| **Terminal edge**      | An edge with no target node — marks a workflow end state (complete/escalated/aborted)                        |
| **Ownership comment**  | Managed agents use `cwc:node` markers and managed skills use `cwc:workflow` markers for safe writes/deletes  |
| **Orchestrator skill** | The workflow skill generated at `.claude/skills/cwc-<workflow-slug>/SKILL.md` — a Claude Code skill that delegates via Agent tool |
| **Conflict detection** | Reads the ownership comment from a file on disk to determine if this workflow can safely overwrite/delete it |
| **Gate node**          | A `nodeType: 'gate'` node that pauses a run at a checkpoint, diffs the branch, and waits for approval       |
| **Trigger**            | A cron or webhook definition stored in artifact metadata; the scheduler/webhook router fires armed, enabled triggers |
| **Isolation**          | Worktree mode creates a `cwc/<runId>` branch so the main checkout is never modified by an automated run     |
| **Model invocation**   | Per-artifact export option. Off keeps `disable-model-invocation: true`; auto omits it so Claude may invoke the skill outside CWC's run harness |
| **Detection scan**     | Local Claude Code history analysis that clusters repeated tasks and recommends an artifact tier              |

---

## Why Open Source

This tool has filesystem access to `~/.claude/`. Open source is the trust model: there is no CWC-hosted backend, and the local Node.js server is the entire app backend. The server binds to `127.0.0.1`, restricts cross-origin API access, and protects packaged-app API requests with a per-run local token.

---

## Development

This project uses npm and `package-lock.json`. `package.json` declares Node `>=18`; CI runs Node 20 and 22 on Ubuntu and Windows.

```bash
npm run dev:server          # Watch-mode TypeScript compilation to dist/
npm run dev:api             # Local API at :3579 with CWC_DISABLE_AUTH=1
npm run dev:client          # Vite dev server with HMR (port 5173, proxies /api to :3579)
npm test                    # Run all tests (Vitest)
npm run typecheck           # Type-check server + client
npm run build               # Production build (server + client + bundled skill)
npm start                   # Run the built CLI/server from dist/
```

For local development, run `dev:server`, `dev:api`, and `dev:client` in separate terminals. `dev:api` intentionally disables packaged-app API auth so Vite can talk to the server; do not carry that behavior into packaged mode.

Durable coding-agent guidance lives in `AGENTS.md`; Claude Code-specific guidance lives in `CLAUDE.md`. Keep them in sync when changing repo conventions.

### Tests

The Vitest suite covers:

- **BFS traversal**: linear chains, back-edges, fan-out, multi-root, terminal edges
- **Prose generation**: start triggers, bold wrapping, context artifacts, Oxford comma, back-edge ordering
- **File writer**: frontmatter, skills block, ownership comments, plain and orchestrator skill generation
- **Exporter**: temp-filesystem integration for both artifact kinds, rename/conversion cleanup, skill resolution, preview parity, and hard conflicts for foreign or hand-authored files
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
- **Automation detection**: transcript parsing, shape derivation, tier classification, streamed scan logs, tier override, rule application, artifact generation/cancellation, and trigger seeding
- **Help copy and theme preference**: glossary terms, control hints, light/dark theme parsing, and dashboard event helpers

---

## Contributing

PRs welcome. The codebase is TypeScript end-to-end (client + server + core library). Run `npm test` and `npm run typecheck` before submitting.

If you build an artifact you're proud of, share the `.cwc` file — that's how the community library grows.

---

## License

MIT
