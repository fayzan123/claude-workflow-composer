# Future Plan: Agent & Skill Library

*Status: Deferred — implement after the canvas composer is stable*

---

## Scope Boundary (What This Is NOT)

The graph canvas is strictly for **composing** agents and skills into workflows — arranging them in order, drawing handoffs, configuring execution. Building, editing, browsing, or downloading individual agents and skills is explicitly out of scope for the canvas.

This plan covers the separate **Agent & Skill Library** feature: a dedicated section of the UI for discovering, importing, and authoring the building blocks that the canvas then assembles.

---

## Why Separate

Mixing authoring of agents/skills directly into the canvas conflates two different jobs:

- **Canvas job:** "How do I connect these pieces into a pipeline?"
- **Library job:** "What are the pieces, where do I get them, how do I customize them?"

Keeping them separate keeps the canvas focused and fast to use. Users who just want to compose pre-built agents don't need a markdown editor in their way. Users who want to build agents from scratch don't need the canvas in their face.

---

## Feature Overview

A **Library tab** (or dedicated route `/library`) in the cwc UI with three panels:

### 1. Installed
Lists all agents and skills currently installed in `~/.claude/agents/` and `~/.claude/skills/` (and `.claude/` project-scoped equivalents). Shows name, description, source (local / community / imported). Lets users edit metadata, preview the raw markdown, and delete entries.

### 2. Browse Community
Discover agents and skills from curated external repositories. Users can browse, preview, and one-click install into their local `~/.claude/`. Sources include:

| Repository | What It Contains |
|---|---|
| [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) | Ready-made agents for common coding roles |
| [obra/superpowers](https://github.com/obra/superpowers) | Skills / orchestrator patterns |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Frontend design skills and agents |
| cwc community uploads | Workflows shared by other cwc users (future) |

Installation clones the file into the appropriate `~/.claude/` directory and marks it with a `cwc-source` metadata field for tracking.

### 3. Create New
A structured form (not a free-form markdown editor) for creating a new agent or skill from scratch:
- **Agent:** name, description, model, system prompt, allowed tools, allowed skills
- **Skill:** name, description, trigger phrases, SKILL.md body (with live preview of what Claude will see)

On save, writes the file to `~/.claude/` and makes it immediately available on the canvas.

---

## Integration with Canvas

Once an agent or skill exists in the library (installed or created), it appears as a draggable node in the canvas sidebar. The canvas never edits agents/skills directly — it only references them by name. Changes to an agent in the Library propagate to any canvas workflow that references it.

---

## Implementation Notes (for when this is built)

- The Browse Community panel fetches a manifest from each repo's `registry.json` (or similar) rather than cloning the whole repo. Repos that don't have a manifest can be browsed via the GitHub API.
- Installation is a simple file write — no package manager, no lock file, no dependency graph. Agents and skills are markdown files.
- The `cwc-source` metadata field enables "check for updates" in the Installed panel.
- Conflict detection (same name already installed from different source) should use the same logic as the canvas exporter's conflict detection.
- The Create New form should validate against the same schema the exporter uses, so a manually-created agent can be exported in a workflow without issues.

---

## What to Build First (Canvas → Library order)

1. **Canvas composer** (current focus) — lets users compose existing agents and skills visually and export workflows
2. **Library: Installed panel** — shows what's already in `~/.claude/`, basic edit/delete
3. **Library: Create New** — structured form to author agents/skills
4. **Library: Browse Community** — connect to external repos for discovery and one-click install

Community browsing is last because it depends on external repos having a consistent manifest format, which needs ecosystem coordination.
