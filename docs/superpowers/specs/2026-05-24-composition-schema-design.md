# Composition Schema Design

*Date: 2026-05-24*
*Project: Claude Workflow Composer*
*Scope: Internal workflow data model, exporter, and format validation milestone*

---

## Context

Claude Workflow Composer is a Tauri desktop app for visually authoring multi-agent Claude Code workflows. Users drag agents onto a canvas, attach skills and MCPs, wire handoffs, and export working config files directly into their project.

This spec covers the load-bearing piece the product analysis identified as the thing to solve before any UI code: the composition schema — what a workflow looks like as a data structure, how it maps to files Claude Code actually consumes, and how we validate that the exported files work before building the canvas on top of them.

---

## What Claude Code Actually Reads

Research into the live `~/.claude/` directory surfaces the following ground truth:

**Agent files** — `.claude/agents/<slug>.md` with YAML frontmatter:

```yaml
---
name: Backend Architect
description: Senior backend architect specializing in...
color: blue
model: inherit          # optional; inherits parent model if omitted
tools: Read, Write, Edit  # optional; comma-separated, restricts available tools
---

Agent system prompt content...
```

**Known frontmatter fields:** `name`, `description`, `color`, `model`, `tools`. No native `skills`, `mcpServers`, or `handoff` fields exist.

**Skills** — live in the superpowers plugin cache (`~/.claude/plugins/cache/.../skills/`), not in `.claude/agents/`. Each skill is a `SKILL.md` with a `name` slug and `description`. There is no file-level linkage between agents and skills — the connection is behavioral: an agent's system prompt instructs it to invoke specific skills via the `Skill` tool at runtime.

**Handoffs** — no native machine-readable format exists. Workflow orchestration is expressed as prose in `CLAUDE.md`, which Claude reads and follows as instructions.

**MCPs** — configured in the Claude Desktop app's preferences, not in `.claude/`. No project-level MCP config file exists in the current Claude Code format. MCP wiring is out of scope for v1.

---

## Schema Design

### Approach

The composer uses a **node-edge graph** as its internal data model. This maps 1:1 to the canvas (nodes = agent cards, edges = handoff arrows), supports parallel paths and branching, and gives the exporter a traversable structure to generate CLAUDE.md prose from.

The composer's native file format is `.cwc` (Claude Workflow Composer) — a single JSON file per workflow.

### File Structure

```json
{
  "meta": {
    "id": "<uuid-v4>",
    "name": "TDD Pipeline",
    "description": "Test-driven development workflow with review gate",
    "version": "1",
    "created": "2026-05-24T00:00:00Z"
  },
  "nodes": [...],
  "edges": [...]
}
```

### Node Schema

Each node represents one agent on the canvas:

```json
{
  "id": "node-1",
  "position": { "x": 100, "y": 200 },
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
- `position` — canvas layout coordinates; stored in `.cwc`, ignored by exporter
- `tools` — array of Claude Code tool names; exported as comma-separated `tools:` frontmatter
- `skills` — array of skill slugs; exported as a behavioral instruction block injected into the agent's system prompt (not a frontmatter field, since no native field exists)
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
- `trigger` — prose string; becomes one line of CLAUDE.md orchestration
- `context` — optional list of named outputs to pass forward; translated to CLAUDE.md instructions like "Pass the schema and api-spec from the architect to the developer"
- `label` — short display label shown on the canvas arrow; not emitted to CLAUDE.md

---

## Exporter

The exporter translates a `.cwc` file into two outputs: agent files and a CLAUDE.md section.

### Agent Files

One `.md` per node, written to `.claude/agents/<slug>.md`. The slug is derived from the agent name (`Backend Architect` → `backend-architect`).

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

When doing design or planning work, use the `brainstorming` skill.
When creating implementation plans, use the `writing-plans` skill.
```

The skills block is injected at the bottom, separated from the user-authored system prompt by a horizontal rule. This creates a clear boundary between hand-authored and generated content, and makes it easy to inspect or manually edit.

**Note on skills portability:** Skill behavioral instructions only work if the corresponding plugin is installed on the target machine. The exporter surfaces a warning listing any skills that require plugin installation.

### CLAUDE.md Section

The exporter appends (or updates) a fenced block in the project's `CLAUDE.md`:

```markdown
<!-- cwc:workflow:<uuid> -->
## Workflow: TDD Pipeline

This project uses a multi-agent workflow. Follow this orchestration:

1. Start with **Backend Architect** to design the schema and API spec.
2. When the architect has delivered a schema and API spec, activate **Backend Developer**. Pass the schema and api-spec forward.
3. When implementation is complete, activate **Code Reviewer** to gate the work before merging.
<!-- /cwc:workflow:<uuid> -->
```

The UUID-fenced block lets the exporter locate and replace its own section on re-export without touching anything outside the fence. User content outside the block is never modified.

### Conflict Detection

Before writing any agent file, the exporter checks if a file with that slug already exists and was not generated by this workflow (identified by a `<!-- cwc:node:<id> -->` comment in the file). If a conflict is found, the exporter surfaces a warning and requires explicit user confirmation before overwriting.

### Zip Export

Same output as direct filesystem export, bundled into a `.zip` for sharing workflows without a target project open.

---

## Format Validation Milestone

Before any canvas or UI work begins, the exporter is validated against real Claude Code consumption. This is a hard gate.

### Test Harness

A standalone test harness (not part of the final app) that:
1. Reads hand-crafted `.cwc` fixture files
2. Runs them through the exporter
3. Validates the output structurally (YAML parsing, file presence, fence integrity)
4. Writes to an isolated environment for manual Claude behavior verification

### Isolation

**Automated assertions** — exporter writes to a temp directory (`/tmp/cwc-test-<uuid>/`) that is auto-deleted after each run. The real `~/.claude/` and any live project are never touched.

**Manual verification** — a `test/sandbox/` directory inside the repo serves as a throwaway Claude Code project for human-in-the-loop verification. A `--clean` flag resets it to baseline. This directory is `.gitignore`d.

### Test Workflows

Four fixture workflows covering the key patterns:

| Fixture | Pattern | What it validates |
|---|---|---|
| `linear.cwc` | A → B → C | Baseline: sequential handoff prose generation |
| `parallel.cwc` | A → B and C → D | Parallel split and convergence in CLAUDE.md |
| `gate-loop.cwc` | A → B → gate → A (on fail) | Conditional re-trigger edge |
| `skills.cwc` | Single agent with 3 skills | Behavioral instruction injection and plugin warning |

### Pass Criteria

For each fixture:
- [ ] Agent `.md` files have valid YAML frontmatter
- [ ] Skills block appears in system prompt, correctly formatted
- [ ] CLAUDE.md fenced block is present, well-formed, and contains expected orchestration prose
- [ ] Re-export updates the fenced block without corrupting surrounding CLAUDE.md content
- [ ] Manual: Claude activates the correct agent at the correct step (verified in `test/sandbox/`)

### Handling Failures

Any pattern that Claude does not reliably follow from CLAUDE.md prose is marked as **unsupported in v1** and excluded from the composer's canvas, rather than shipped broken. The unsupported pattern list is documented and becomes a v2 priority.

---

## Out of Scope for v1

- **MCP wiring** — no project-level MCP config format exists in Claude Code today
- **Import from existing `.claude/`** — parsing arbitrary CLAUDE.md prose back into a graph is deferred to v2; recommended as a high-value v2 feature
- **Community library** — workflow upload/fork/discover layer is built after the core composer ships
- **Live execution visualization** — runtime agent state display is out of scope

---

## Open Questions

None blocking v1. Items to revisit in v2:
- If Anthropic ships a native workflow format, the exporter gains a new target; the internal schema stays stable
- Import direction (`.claude/` → `.cwc`) becomes tractable once the schema is stable and well-adopted
