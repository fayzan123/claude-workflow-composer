# Composition Schema Design

*Date: 2026-05-24*
*Project: Claude Workflow Composer*
*Scope: Internal workflow data model, exporter, and format validation milestone*

---

## Context

Claude Workflow Composer is a local web UI launched via `npx cwc`. Users drag agents onto a canvas, wire handoffs between them, attach skills, and export a working workflow — a slash-command entry point backed by a skill orchestrator and a set of specialized subagents — directly into their Claude installation.

The architecture is a Node.js server (handles all file system operations against `~/.claude/` and `.claude/`) paired with a browser-based SPA. Nothing leaves the machine. `npx cwc` starts the server and opens the UI in the user's default browser. No installation, no code signing, no Gatekeeper friction.

The product is a no-code GUI. UX clarity is a first-class constraint throughout: abstractions must make sense to a user who has never read a YAML file, errors must be plain-English modals with obvious actions, and technical implementation details (slugs, file paths, frontmatter) must be invisible unless directly relevant to a decision the user is making.

This spec covers the load-bearing piece to solve before any UI code: the composition schema (what a workflow looks like as a data structure), how it maps to files Claude Code actually consumes, and how we validate that the exported files work before building the canvas on top of them.

---

## What Claude Code Actually Reads

Research into the live `~/.claude/` directory and the [claude-code-workflows](https://github.com/shinpr/claude-code-workflows) reference implementation surfaces the following ground truth.

**Agent files** — `.claude/agents/<slug>.md` (project-scoped, version-controllable) or `~/.claude/agents/<slug>.md` (user-scoped, available across all projects) with YAML frontmatter:

```yaml
---
name: Backend Architect
description: Senior backend architect specializing in...
color: blue
model: inherit
tools: Read, Write, Edit
---

Agent system prompt content...
```

Known frontmatter fields: `name`, `description`, `color`, `model`, `tools`. No native `skills`, `mcpServers`, or `handoff` fields exist in the format.

**Skills** — live in `~/.claude/skills/<slug>/SKILL.md`. Each skill is a directory containing a `SKILL.md` with `name` and `description` frontmatter fields. Skills can also ship inside plugins at `~/.claude/plugins/cache/<publisher>/<plugin>/<version>/skills/<slug>/SKILL.md`; plugin-bundled skills are namespaced (e.g. `superpowers:brainstorming`).

**Skill orchestrators** — the primary orchestration mechanism. A workflow is a skill with `disable-model-invocation: true` in its frontmatter. The skill's body contains the full orchestration flow: agent sequence, decision tables, and handoff conditions. The user invokes it via slash command (e.g. `/tdd-pipeline`). Claude reads the skill, becomes the orchestrator, and calls subagents via the `Agent` tool.

**Handoffs** — expressed as prose instructions inside the orchestrator skill body. Claude follows them as behavioral instructions. No native machine-readable handoff format exists in Claude Code.

**MCPs** — configured in the Claude Desktop app's preferences, not in `.claude/`. MCP wiring is out of scope for v1.

**CLAUDE.md** — a project context file read by every session at startup. It is *not* used for workflow orchestration. Routing logic lives in agent `description` fields and orchestrator skill bodies, not CLAUDE.md prose.

---

## Schema Design

### Approach

The composer uses a **node-edge graph** as its internal data model. Nodes = agent cards on the canvas. Edges = handoff arrows. The exporter traverses this graph to generate the orchestrator skill body.

Cycles (back-edges) are permitted to support gate-loop patterns. The exporter detects back-edges during BFS traversal and emits appropriate conditional prose rather than looping infinitely.

**Traversal order:** BFS (breadth-first), with same-level nodes sorted by insertion order for deterministic output. Fan-out (one source node, multiple targets at the same BFS level) is treated as a parallel group and emitted as a grouped step rather than separate numbered items (see Exporter section).

**BFS root(s):** Entry nodes are nodes with no incoming edges. BFS is seeded with all entry nodes simultaneously (multi-root BFS). Same-level insertion-order sorting applies across all roots. If a workflow has multiple disconnected entry nodes, they are treated as a parallel group at step 1 (same format as fan-out parallel steps).

The composer's native file format is `.cwc` (Claude Workflow Composer) — a single JSON file per workflow.

### File Structure

```json
{
  "meta": {
    "id": "<uuid-v4>",
    "name": "TDD Pipeline",
    "description": "Test-driven development workflow with review gate",
    "version": 1,
    "created": "2026-05-24T00:00:00Z",
    "updated": "2026-05-24T00:00:00Z"
  },
  "nodes": [...],
  "edges": [...]
}
```

`version` is an integer incremented on breaking schema changes. If `version` exceeds the composer's maximum supported version, the app surfaces a clear error: "This workflow was created with a newer version of Claude Workflow Composer. Update the app to open it." The file is not parsed. `updated` is written by the composer on every save.

### Node Schema

Each node represents one agent on the canvas:

```json
{
  "id": "node-1",
  "position": { "x": 100, "y": 200 },
  "exportedSlug": "backend-architect",
  "startTrigger": "to design the schema and API spec",
  "agent": {
    "name": "Backend Architect",
    "description": "Designs the API and data model before implementation begins",
    "color": "blue",
    "model": "inherit",
    "tools": ["Read", "Write", "WebSearch"],
    "skills": ["brainstorming", "writing-plans"],
    "systemPrompt": "You are a senior backend architect..."
  }
}
```

**Field notes:**
- `position` — canvas layout coordinates, always required, never null. Initial positions (templates, future import) are assigned by the BFS layout algorithm: nodes placed left-to-right per BFS level with 300px horizontal spacing and 200px vertical spacing between levels. The canvas derives the slug from `agent.name` and displays it live as the user types — the derived slug is shown in the UI to make file naming transparent without exposing path syntax.
- `startTrigger` — optional user-authored phrase for entry nodes (nodes with no incoming edges). Emitted as step 1 of the orchestrator skill: `"Start with **{Name}** {startTrigger}."`. If absent or empty on an entry node, the exporter emits `"Start with **{Name}**."` with no additional text. On non-entry nodes, `startTrigger` is ignored. The canvas shows this field only when the node has no incoming edges and labels it "What does this agent do first?" to keep the abstraction non-technical.
- `exportedSlug` — the slug written to disk on the most recent export. Null if the node has never been exported. On export, if the current derived slug differs from `exportedSlug`, the exporter detects a rename: deletes the old file (after ownership check), writes the new file, and updates `exportedSlug`. If the old file does not exist on disk (deleted externally), the delete step is skipped and the exporter proceeds to write the new file. If the old file exists but fails the ownership check, the exporter surfaces an error rather than leaving the stale file.
- `tools` — array of Claude Code tool names; exported as comma-separated `tools:` frontmatter
- `skills` — array of skill slugs (non-namespaced or `plugin:slug` namespaced); exported as behavioral instruction block injected into the agent's system prompt
- `model` — optional; defaults to `"inherit"` if omitted

### Edge Schema

Each edge represents a handoff between two agents:

```json
{
  "id": "edge-1",
  "from": "node-1",
  "to": "node-2",
  "label": "Architecture approved",
  "trigger": "When the architect has delivered a schema and API spec, activate Backend Developer.",
  "context": ["schema", "api-spec"]
}
```

**Field notes:**
- `trigger` — prose authored by the user in the composer; emitted as one numbered line in the orchestrator skill body, with agent names bold-formatted. The exporter's only transformation is: numbering, bold-wrapping substrings that exactly match any node's `agent.name`. The `trigger` field is always emitted verbatim for all edges, including terminal edges — the `terminalType` field does not replace or modify the trigger text.
- `context` — optional free-text list of named outputs to pass forward. If present and non-empty, the exporter appends "Pass the `<items>` forward." to the trigger line. Items are joined Oxford-comma style: `["schema"]` → `"schema"`; `["schema", "api-spec"]` → `"schema and api-spec"`; `["a", "b", "c"]` → `"a, b, and c"`. If omitted or empty, no "Pass the..." clause is emitted.
- `label` — short display label shown on the canvas arrow; not emitted to the skill body
- `terminalType` — present only on edges with `"to": null` (terminal edges). Values: `"complete"` | `"escalated"` | `"aborted"`. Default: `"complete"`. Used by the canvas UI to categorize the terminal outcome and display plain-English options ("Workflow complete", "Escalate to human review", "Abort workflow") when authoring the trigger text. The `terminalType` value is NOT emitted to the skill body — the `trigger` field is the sole source of terminal step prose.

---

## Exporter

The exporter translates a `.cwc` file into two outputs: agent files and a workflow skill.

### Export Target

At export time, the user selects where agent files are written:

- **This project only** — writes to `.claude/agents/` relative to a project directory the user selects. Files are project-scoped and version-controllable.
- **All my projects** — writes to `~/.claude/agents/`. Files are available across all Claude Code sessions.

The workflow skill always writes to `~/.claude/skills/<workflow-slug>/` regardless of agent target, since skills are user-scoped by convention.

The export target is stored in the `.cwc` file so re-exports default to the same location. The user can change it per-export.

### Prerequisite Check

On app launch, the composer checks for the existence of `~/.claude/`. If absent, a setup screen is shown: "Claude Code doesn't appear to be installed. Install it first, then come back." with a link to the Claude Code install page. If `~/.claude/skills/` does not exist, it is created silently on first export — this is normal for fresh Claude Code installs.

### Slug Generation

The file slug for each agent is derived from the agent name by: lowercasing, replacing spaces and underscores with hyphens, stripping non-alphanumeric characters except hyphens, and truncating at 64 characters.

Examples: `Backend Architect` → `backend-architect`, `Auth & Security` → `auth-security`.

The **workflow slug** is derived from `meta.name` using the same algorithm. It is used as the skill directory name (`~/.claude/skills/<workflow-slug>/`), the `name` field in the workflow skill's YAML frontmatter, and the slash-command entry point (`/<workflow-slug>`). Example: `TDD Pipeline` → `tdd-pipeline`.

The derived slug is shown live in the canvas UI as the user types the agent name, so file naming is transparent without requiring the user to understand file path syntax.

Slug uniqueness within a workflow is enforced at two layers:
1. **Live validation (canvas)** — inline error shown on the conflicting node as the agent name is typed or changed, before export is attempted
2. **Export validation (hard stop)** — re-validated at export time as defense-in-depth

Two nodes that produce the same slug cannot coexist in the same workflow.

### Preview Pane

Before any files are written, the exporter renders a preview pane showing the exact content of every file that will be created or updated: each agent `.md` and the workflow `SKILL.md`. Files are shown as rendered markdown (not raw), so non-technical users can read what will be generated. The user must confirm before the exporter writes to disk.

The preview pane also surfaces any warnings (e.g. skills not found in the cache) and shows a clear message for any file that will be overwritten: "This file already exists and will be updated."

### Agent Files

One `.md` per node, written to the selected export target. The full emitted file:

```markdown
---
name: Backend Architect
description: Designs the API and data model before implementation begins
color: blue
model: inherit
tools: Read, Write, WebSearch
---

You are a senior backend architect...

---
## Workflow Skills

Use the `brainstorming` skill. (Explores user intent, requirements and design before implementation)
Use the `writing-plans` skill. (Creates structured implementation plans)
<!-- cwc:node:node-1:workflow:uuid-v4 -->
```

The ownership comment on the last line identifies this file as generated by a specific node within a specific workflow. The exporter always ensures this comment is the final non-blank line of the emitted file.

**Skills lookup:** Two-strategy resolution:
1. **Non-namespaced slug** (e.g., `brainstorming`) → `~/.claude/skills/<slug>/SKILL.md`
2. **Namespaced slug** (e.g., `superpowers:brainstorming`) → parse the prefix, look up `installPath` from `~/.claude/plugins/installed_plugins.json` → `<installPath>/skills/<slug>/SKILL.md`

Each skill line template: `Use the \`<slug>\` skill. (<description from SKILL.md>)`

If a skill is not found via either strategy, fallback: `Use the \`<slug>\` skill.` (no description). The exporter surfaces a warning in the preview pane listing any skills not found, since they require installation on the target machine. Skill descriptions embedded in agent files may drift if plugins are updated after export; re-export to refresh them.

**Skills block exact format:** When `systemPrompt` is non-empty, the skills block is separated from it by `\n\n---\n## Workflow Skills\n\n` — that is: blank line, `---` on its own line, `## Workflow Skills` immediately on the next line (no blank line between `---` and the heading), then a blank line before the first skill line. When `systemPrompt` is empty, the skills block begins immediately after the frontmatter closing `---\n` with `\n## Workflow Skills\n\n`. The ownership comment follows immediately after the last skill line with no blank line between them. When the agent has no skills, no `## Workflow Skills` section appears; the ownership comment is the last non-blank line.

### Conflict Detection

Before writing any file, the exporter scans the existing file from the bottom upward for the first non-blank line and matches it against the ownership comment pattern using the following rules:

**Agent files** — match regex: `/^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/` (trimmed line)
**Workflow skill** — match regex: `/^<!-- cwc:workflow:[^:\s>]+ -->$/` (trimmed line)

A line that starts with `<!-- cwc:` but does not fully match the regex is classified as **malformed**.

Resolution:
- Regex matches and UUID segment equals **current workflow's UUID** → safe to overwrite; preview pane shows "This file will be updated."
- Regex matches and UUID segment equals **a different UUID** → conflict modal: "This file belongs to another workflow. Overwrite it?" Requires explicit user confirmation.
- Last non-blank line does **not** start with `<!-- cwc:` → comment **absent**; conflict modal: "This file wasn't created by this workflow. Overwrite it?" Requires explicit user confirmation.
- Last non-blank line starts with `<!-- cwc:` but does not fully match the regex → **malformed**; treat as unowned; conflict modal shown.

Conflict modals have two options: "Overwrite" and "Cancel export." No partial writes — if the user cancels, no files are touched.

### Rename and Delete Handling

**Rename:** When a node's agent name changes and produces a different slug, `exportedSlug` in the `.cwc` differs from the derived slug. On export, the exporter: (1) checks ownership of the old file, (2) deletes it if owned, (3) writes the new file, (4) updates `exportedSlug`. If the old file fails the ownership check, the exporter surfaces the conflict modal rather than leaving the stale file orphaned.

**Workflow delete:** The composer provides a delete workflow action that:
1. Reads the `.cwc` to enumerate every `exportedSlug` and the workflow UUID
2. Checks ownership on every agent file and the skill file
3. Deletes only files the workflow owns
4. Files that fail the ownership check are listed in a modal: "These files couldn't be safely removed. Delete them manually if needed." The user can proceed or cancel.
5. Deletes the `.cwc` itself only after all owned files are successfully removed
6. If any step fails, the operation halts — nothing is deleted until the entire set is confirmed safe

### Workflow Skill (Orchestrator Entry Point)

The exporter generates a skill at `~/.claude/skills/<workflow-slug>/SKILL.md`. This is the workflow's entry point — the user invokes it via `/<workflow-slug>`.

The full emitted skill:

```markdown
---
name: tdd-pipeline
description: Test-driven development workflow with review gate
disable-model-invocation: true
---

You are the orchestrator for the **TDD Pipeline** workflow. Delegate all implementation work via the Agent tool. Do not read, write, or edit files yourself — those are subagent responsibilities.

## Orchestration Flow

1. Start with **Backend Architect** to design the schema and API spec.
2. When the architect has delivered a schema and API spec, activate **Backend Developer**. Pass the schema and api-spec forward.
3. When implementation is complete, activate **Code Reviewer** to gate the work before merging.
4. If the review passes, the workflow is complete.
5. If the review fails, return to **Backend Developer** with the reviewer's feedback and repeat from step 1. Pass the reviewer feedback forward.

## Escalation

If a subagent returns a blocked or escalation status, stop and present the details to the user before continuing.
<!-- cwc:workflow:uuid-v4 -->
```

The `description` field is derived from `meta.description` in the `.cwc` file — one source of truth, consumed by both the composer's workflow library UI and Claude's autonomous routing.

**Parallel step format:** When a node has multiple outgoing edges to nodes at the same BFS level (fan-out), the exporter emits them as a grouped step:

```
2. When A completes, activate **B** and **C** in parallel:
   - [B's trigger text]
   - [C's trigger text]
```

Parallel fan-out in v1 is best-effort instructed concurrency — Claude is instructed to activate both agents, but actual simultaneous execution depends on Claude's runtime behavior with the `Agent` tool. If the preview validation shows Claude serializes them anyway, the grouped format still correctly signals intent and avoids implying B must precede C. True parallel execution is a v2 concern tied to Agent Teams stabilization.

**Terminal edge prose:** Terminal edges are emitted using their `trigger` field verbatim (same as all other edges). The `terminalType` value is not emitted. The canvas uses `terminalType` to pre-populate the trigger text field when the user first creates a terminal edge:
- `"complete"` pre-fills: "If [condition], the workflow is complete."
- `"escalated"` pre-fills: "If [condition], escalate to human review."
- `"aborted"` pre-fills: "If [condition], abort the workflow."
The user can edit this text freely before exporting.

---

## Templates

The composer ships with built-in workflow templates to give users a starting point. Templates are pre-authored `.cwc` files bundled with the app. Opening a template creates a copy — templates themselves are read-only.

**v1 built-in templates:**

| Template | Pattern | Use case |
|---|---|---|
| Feature Implementation | Architect → Developer → Reviewer | Build a new feature end-to-end |
| Code Review Gate | Developer → Reviewer → loop or complete | Review-gated implementation |
| Bug Diagnosis | Investigator → Solver | Diagnose and fix a problem |
| Research & Write | Researcher → Writer | Research a topic and produce a document |

Templates are the primary onboarding surface for new users. The empty canvas is never the first thing a user sees.

---

## Format Validation Milestone

Before any canvas or UI work begins, the exporter is validated structurally. This is a hard gate.

### Test Harness

A standalone test harness (not part of the final app) that:
1. Reads hand-crafted `.cwc` fixture files
2. Runs them through the exporter
3. Validates output structurally via automated assertions
4. No runtime Claude invocation — behavioral verification is done by the developer trying the exported workflow in a real project

### Isolation

Automated assertions write to a temp directory (`/tmp/cwc-test-<uuid>/`) auto-deleted after each run. The real `~/.claude/` is never touched by the test harness.

### Test Workflows

| Fixture | Pattern | What it validates |
|---|---|---|
| `linear.cwc` | A → B → C | Baseline: sequential orchestration flow, slug generation, ownership comments |
| `parallel.cwc` | A → B and A → C (pure split) | Parallel grouped step format |
| `gate-loop.cwc` | A → B → gate → A (conditional back-edge) | Cycle detection, back-edge ordering, terminal edge prose |
| `skills.cwc` | Single agent with 3 skills | Skill lookup (two-strategy), behavioral instruction injection, plugin warning |

Convergence (multiple edges feeding one downstream node) is deferred to v2.

**`gate-loop.cwc` fixture (relevant fields):**

```json
"nodes": [
  { "id": "node-developer", "startTrigger": "to implement the feature", "agent": { "name": "Developer", ... } },
  { "id": "node-reviewer", "agent": { "name": "Reviewer", ... } }
],
"edges": [
  {
    "id": "edge-1", "from": "node-developer", "to": "node-reviewer",
    "label": "Ready for review",
    "trigger": "When implementation is complete, activate Reviewer to evaluate the work.",
    "context": []
  },
  {
    "id": "edge-2", "from": "node-reviewer", "to": null,
    "label": "Pass",
    "trigger": "If the review passes, the workflow is complete.",
    "terminalType": "complete",
    "context": []
  },
  {
    "id": "edge-3", "from": "node-reviewer", "to": "node-developer",
    "label": "Fail — loop back",
    "trigger": "If the review fails, return to Developer with the reviewer's feedback and repeat from step 1.",
    "context": ["reviewer feedback"]
  }
]
```

Expected orchestrator skill output:

```markdown
---
name: gate-loop
description: Gate Loop — conditional review workflow with re-trigger
disable-model-invocation: true
---

You are the orchestrator for the **Gate Loop** workflow. Delegate all implementation work via the Agent tool. Do not read, write, or edit files yourself — those are subagent responsibilities.

## Orchestration Flow

1. Start with **Developer** to implement the feature.
2. When implementation is complete, activate **Reviewer** to evaluate the work.
3. If the review passes, the workflow is complete.
4. If the review fails, return to **Developer** with the reviewer's feedback and repeat from step 1. Pass the reviewer feedback forward.

## Escalation

If a subagent returns a blocked or escalation status, stop and present the details to the user before continuing.
<!-- cwc:workflow:gate-loop-uuid -->
```

### Pass Criteria

All assertions are automated (zero Claude token cost):

- [A] Agent `.md` files parse as valid YAML frontmatter without error
- [A] When agent has skills and non-empty systemPrompt: file contains exact byte sequence `\n\n---\n## Workflow Skills\n\n` (no blank line between `---` and `##`) after system prompt body, followed by skill lines, with ownership comment immediately after the last skill line (no blank line)
- [A] When agent has no skills: no `## Workflow Skills` section; ownership comment is last non-blank line
- [A] Agent ownership comment matches `/^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/` on last non-blank line with current node-id and workflow-id
- [A] Workflow skill has `disable-model-invocation: true` in frontmatter
- [A] Workflow skill `name` frontmatter equals the slug derived from `meta.name`
- [A] Workflow skill `description` matches `meta.description` from the `.cwc`
- [A] Workflow skill ownership comment matches `/^<!-- cwc:workflow:[^:\s>]+ -->$/` on last non-blank line with current workflow UUID
- [A] Re-export overwrites agent files and skill file in place; `exportedSlug` values updated in `.cwc`; no orphan files created
- [A] Renamed node: old file removed, new file written, `exportedSlug` updated
- [A] Renamed node where old file missing on disk: write proceeds without error, `exportedSlug` updated
- [A] `gate-loop.cwc`: step 1 emits "Start with **Developer** to implement the feature." (from `startTrigger`); back-edge step emitted after forward steps; back-edge not traversed recursively; terminal edge step uses `trigger` field verbatim
- [A] `parallel.cwc`: fan-out nodes emitted as grouped parallel step, not separate numbered items

Behavioral verification (does Claude follow the flow correctly?) is done by the developer running the exported workflow in a real project after the automated assertions pass. Any pattern Claude does not reliably follow is marked **unsupported in v1** and excluded from the canvas.

---

## Out of Scope for v1

- **MCP wiring** — no project-level MCP config format exists in Claude Code today
- **Parallel convergence** — multiple edges feeding one downstream node; deferred to v2
- **Import from existing `.claude/`** — parsing agent files and skills back into a graph; deferred to v2
- **Stopping points on nodes** — no canvas UI for marking `[Stop]` gates; deferred to v2
- **Structured handoff contracts** — typed JSON input/output contracts between agents; v1 uses user-authored prose only
- **Zip export** — bundled export for sharing; deferred to v2
- **Community library** — workflow upload/fork/discover; built after core composer ships
- **Live execution visualization** — runtime agent state display is out of scope

---

## Open Questions

None blocking v1. Items to revisit in v2:
- Agent Teams (experimental in Claude Code) may become the right substrate for deterministic sequential handoffs once stabilized; monitor Anthropic's roadmap
- Structured handoff contracts (typed JSON per agent) would significantly increase reliability; requires a contract editor in the canvas
- Convergence node type for parallel splits that rejoin
- Schema version migration strategy (v1 → v2+ readers); v1 readers surface a clear error on unknown versions
- Import direction (`.claude/` + `~/.claude/skills/` → `.cwc`) becomes tractable once the schema is stable
- Stopping points as a first-class canvas concept; requires `stopBefore: boolean` on nodes and conditional skill body generation
