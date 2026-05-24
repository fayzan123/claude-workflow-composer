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

**Skills** — live in the superpowers plugin cache (`~/.claude/plugins/cache/.../skills/`), not in `.claude/agents/`. Each skill is a `SKILL.md` with a `name` slug and `description` field. There is no file-level linkage between agents and skills — the connection is behavioral: an agent's system prompt instructs it to invoke specific skills via the `Skill` tool at runtime.

**Handoffs** — no native machine-readable format exists. Workflow orchestration is expressed as prose in `CLAUDE.md`, which Claude reads and follows as instructions.

**MCPs** — configured in the Claude Desktop app's preferences, not in `.claude/`. No project-level MCP config file exists in the current Claude Code format. MCP wiring is out of scope for v1.

---

## Schema Design

### Approach

The composer uses a **node-edge graph** as its internal data model. This maps 1:1 to the canvas (nodes = agent cards, edges = handoff arrows), supports parallel paths, and gives the exporter a traversable structure to generate CLAUDE.md prose from.

Cycles (back-edges) are permitted in the graph to support gate-loop patterns. The exporter detects back-edges by tracking visited nodes during traversal and emits appropriate conditional prose rather than looping infinitely.

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

`version` is an integer incremented on breaking schema changes. Readers encountering an unknown version must surface an error rather than silently misparse. `updated` is written by the composer on every save.

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
- `skills` — array of skill slugs; exported as a behavioral instruction block injected into the agent's system prompt (see Exporter section)
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
- `trigger` — prose string authored by the user in the composer; emitted verbatim as one numbered line in the CLAUDE.md orchestration list, with agent names bold-formatted. The exporter's only transformation is numbering, bold-wrapping agent names that match node names, and prepending "Start with" for the first node in traversal order.
- `context` — optional free-text list of named outputs to pass forward, authored by the user (no validation against a schema). If present and non-empty, the exporter appends "Pass the `<items joined by comma and 'and'>` forward." to the trigger line. If omitted or an empty array, no "Pass the..." clause is emitted. Items are joined with Oxford-comma style: `["schema"]` → `"schema"`; `["schema", "api-spec"]` → `"schema and api-spec"`; `["a", "b", "c"]` → `"a, b, and c"`.
- `label` — short display label shown on the canvas arrow; not emitted to CLAUDE.md

---

## Exporter

The exporter translates a `.cwc` file into two outputs: agent files and a CLAUDE.md section.

### Slug Generation

The file slug for each agent is derived from the agent name by: lowercasing, replacing spaces and underscores with hyphens, stripping non-alphanumeric characters except hyphens, and truncating at 64 characters.

Examples: `Backend Architect` → `backend-architect`, `Auth & Security` → `auth-security`.

Slug uniqueness within a workflow is enforced at validation time with a hard error (not a warning). Two nodes that produce the same slug cannot coexist in the same workflow.

### Agent Files

One `.md` per node, written to `.claude/agents/<slug>.md`. The full emitted file looks like:

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
<!-- cwc:node:node-1:workflow:uuid-v4 -->
```

The ownership comment on the last line identifies this file as generated by a specific node within a specific workflow. This comment is what conflict detection reads to determine whether the exporter owns the file. The exporter always ensures this comment is the final non-blank line of the emitted file; no trailing content appears after it.

**Skills block generation:** The template for each skill line is:

```
Use the `<slug>` skill. (<description from SKILL.md>)
```

The exporter reads the skill's `description` field from its `SKILL.md` in the plugin cache and embeds it parenthetically as context for the agent. Example for slug `brainstorming` with description `"Explores user intent, requirements and design before implementation"`:

```
Use the `brainstorming` skill. (Explores user intent, requirements and design before implementation)
```

If a skill is not found in the plugin cache, the fallback line is: `Use the \`<slug>\` skill.` (no description). The exporter surfaces a warning listing any skills not found in the plugin cache, since they require plugin installation on the target machine.

**Skills block exact format:** When `systemPrompt` is non-empty, the skills block is separated from it by `\n\n---\n`. When `systemPrompt` is empty, the skills block begins immediately after the frontmatter closing `---` with no separator. The block header is always `## Workflow Skills\n\n`. The ownership comment follows on the line immediately after the last skill line with no blank line between them.

**Note on skills portability:** Skill behavioral instructions only work if the corresponding plugin is installed on the target machine.

### Conflict Detection

Before writing any agent file, the exporter scans the entire existing file line by line (from the bottom upward) for the first non-blank line matching the pattern `<!-- cwc:node:*:workflow:<uuid> -->`. Scanning upward from the last non-blank line handles editors that normalize files with trailing newlines.

- If the comment is present with the **current workflow's UUID** → safe to overwrite
- If the comment is present with a **different workflow's UUID** → error: owned by another cwc workflow, requires explicit user confirmation
- If the comment is **absent** → error: file was not generated by cwc, requires explicit user confirmation
- If the file is **malformed** (no last line readable) → error: treat as unowned

### CLAUDE.md Section

The exporter manages a fenced block within the project's `CLAUDE.md`. Three cases:

**(a) CLAUDE.md does not exist:** The exporter creates the file and writes the fenced block.

**(b) CLAUDE.md exists with no cwc fence:** The exporter appends the fenced block at the end of the file.

**(c) CLAUDE.md exists with a matching cwc fence (same UUID):** The exporter replaces the block in place, preserving its position in the file.

If a fence open tag exists without a close tag (malformed fence), the exporter surfaces an error and does not write — it will not attempt to repair an ambiguously malformed CLAUDE.md.

Multiple workflows targeting the same CLAUDE.md are supported. Each workflow's fenced block is identified by its own UUID, so blocks do not interfere with each other.

**(d) CLAUDE.md exists with a cwc fence whose UUID does not match the current workflow:** The exporter treats this as case (b) — no matching fence exists — and appends a new fenced block at the end of the file. The existing block for the other workflow is left intact.

The emitted block looks like:

```markdown
<!-- cwc:workflow:uuid-v4 -->
## Workflow: TDD Pipeline

This project uses a multi-agent workflow. Follow this orchestration:

1. Start with **Backend Architect** to design the schema and API spec.
2. When the architect has delivered a schema and API spec, activate **Backend Developer**. Pass the schema and api-spec forward.
3. When implementation is complete, activate **Code Reviewer** to gate the work before merging.
<!-- /cwc:workflow:uuid-v4 -->
```

---

## Format Validation Milestone

Before any canvas or UI work begins, the exporter is validated against real Claude Code consumption. This is a hard gate.

### Test Harness

A standalone test harness (not part of the final app) that:
1. Reads hand-crafted `.cwc` fixture files
2. Runs them through the exporter
3. Validates the output structurally (automated assertions)
4. Writes to an isolated sandbox for manual Claude behavior verification

### Isolation

**Automated assertions** — exporter writes to a temp directory (`/tmp/cwc-test-<uuid>/`) that is auto-deleted after each run. The real `~/.claude/` and any live project are never touched.

**Manual verification** — a `test/sandbox/` directory inside the repo serves as a throwaway Claude Code project for human-in-the-loop verification. A `--clean` flag resets it to baseline. This directory is `.gitignore`d.

### Test Workflows

Four fixture workflows covering the key patterns:

| Fixture | Pattern | What it validates |
|---|---|---|
| `linear.cwc` | A → B → C | Baseline: sequential handoff prose generation |
| `parallel.cwc` | A → B and A → C (pure split, no convergence) | Parallel split in CLAUDE.md prose |
| `gate-loop.cwc` | A → B → gate → A (conditional back-edge) | Cycle detection, conditional re-trigger prose |
| `skills.cwc` | Single agent with 3 skills | Behavioral instruction injection and plugin warning |

Convergence (multiple edges feeding one downstream node) is deferred to v2. The `parallel.cwc` fixture tests pure split only.

**`gate-loop.cwc` fixture edge definitions and expected output:**

The fixture defines three edges. The `trigger` field on each edge is what the exporter emits verbatim (numbered, agent names bolded):

```json
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

`"to": null` represents a terminal edge (workflow end). The exporter emits the steps in traversal order, back-edges last.

Expected CLAUDE.md output:

```markdown
<!-- cwc:workflow:gate-loop-uuid -->
## Workflow: Gate Loop

This project uses a multi-agent workflow. Follow this orchestration:

1. Start with **Developer** to implement the feature.
2. When implementation is complete, activate **Reviewer** to evaluate the work.
3. If the review passes, the workflow is complete.
4. If the review fails, return to **Developer** with the reviewer's feedback and repeat from step 1. Pass the reviewer feedback forward.
<!-- /cwc:workflow:gate-loop-uuid -->
```

### Pass Criteria

For each fixture — **A = automated assertion, M = manual human verification:**

- [A] Agent `.md` files parse as valid YAML frontmatter without error
- [A] When agent has skills: file contains the byte sequence `\n\n---\n## Workflow Skills\n\n` after the system prompt, followed by skill lines, with the ownership comment immediately after the last skill line (no blank line between)
- [A] When agent has no skills: no `## Workflow Skills` section appears; ownership comment is present as the last non-blank line
- [A] Ownership comment matches pattern `<!-- cwc:node:<node-id>:workflow:<workflow-id> -->` on the last non-blank line
- [A] CLAUDE.md fenced block is present and well-formed: open tag `<!-- cwc:workflow:<uuid> -->` and close tag `<!-- /cwc:workflow:<uuid> -->` match and are non-empty
- [A] Re-export replaces the fenced block in place; content before and after the block is byte-identical to the pre-export state
- [M] Claude activates the correct agent at the correct step (verified in `test/sandbox/`)
- [M] Claude follows the gate-loop re-trigger condition correctly

### Handling Failures

Any pattern that Claude does not reliably follow from CLAUDE.md prose is marked as **unsupported in v1** and excluded from the composer's canvas, rather than shipped broken. The unsupported pattern list is documented and becomes a v2 priority.

---

## Out of Scope for v1

- **MCP wiring** — no project-level MCP config format exists in Claude Code today
- **Parallel convergence** — multiple edges feeding one downstream node; deferred to v2
- **Import from existing `.claude/`** — parsing arbitrary CLAUDE.md prose back into a graph is deferred to v2; recommended as a high-value v2 feature
- **Zip export** — bundled export for sharing; deferred to v2 (requires defining internal zip directory structure as its own spec)
- **Community library** — workflow upload/fork/discover layer is built after the core composer ships
- **Live execution visualization** — runtime agent state display is out of scope

---

## Open Questions

None blocking v1. Items to revisit in v2:
- If Anthropic ships a native workflow format, the exporter gains a new target; the internal schema stays stable
- Import direction (`.claude/` → `.cwc`) becomes tractable once the schema is stable and well-adopted
- Convergence node type for parallel splits that rejoin
- Schema version migration strategy (v1 → v2+ readers, automated `.cwc` upgrade) is deferred to v2; v1 readers must surface a clear error on unknown versions rather than silently misparsing
