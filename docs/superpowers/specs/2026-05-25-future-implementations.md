# Future Implementations

*Date: 2026-05-25*
*Status: Reference document — not a build plan. Synthesizes design decisions, product direction, and deferred features.*

---

## v0 Scope: What We're Building Now

The v0 product is a clean, honest workflow composer with zero fake data.

**What v0 is:**
- A canvas where users build workflows using **their own agents** (`~/.claude/agents/`) and **their own skills** (`~/.claude/skills/`)
- Each canvas node = one of the user's real agents, dragged from the My Agents sidebar tab
- Skills are attributes attached to a node — not standalone nodes. A skill modifies how an agent behaves, not what step it occupies in the graph
- Workflows export to a real orchestrator `SKILL.md` + agent `.md` files that actually run in Claude Code

**What v0 is not:**
- There is no built-in agent Library with hardcoded/fake agents
- There are no pre-built templates (these are deferred until the template system is honest)
- There is no Playground or learn mode (deferred — see below)
- There are no community features

**Why this matters:** The previous Library tab and template system contained hardcoded agent definitions referencing skills (`ai-development-guide`, `coding-principles`, `testing-principles`) that don't exist in any user's installation. Workflows built from that data would silently fail. v0 removes all of it and only surfaces what's real.

---

## The Agent / Skill Distinction

This distinction is foundational to every product decision below.

**Agents** (`.md` files in `~/.claude/agents/`) are workers. Each one is a separate Claude context — its own system prompt, role, and expertise. When a workflow node runs, the orchestrator invokes that agent via the `Agent` tool. The agent does its task, returns its output, and the orchestrator moves to the next step. Agents are the **WHO** of a workflow.

**Skills** (`.md` files in `~/.claude/skills/`) are procedures. They're not separate agents — they're instructions injected into an agent's context when the agent needs to follow a specific technique. The `tdd` skill doesn't do TDD on its own; it teaches the agent in that node how to approach TDD. Skills are the **HOW** of a node's behavior.

Implication for the canvas:
- **Nodes are agents.** Dragging from My Agents creates a node.
- **Skills are node attributes.** Dragging from Skills attaches to an existing node, not the canvas.
- A skill should never be a standalone node — that would be architecturally incorrect.

---

## Deferred Feature 1: Playground / Learn Mode

**The problem it solves:** New users have no context for what a workflow is or how to build one. Pointing them straight at an empty canvas with only their real agents serves experienced users, not newcomers.

**What Playground is:** A separate, sandboxed environment with fictional agents, fictional skills, and guided tutorial workflows. Users can experiment freely — drag fake agents, build fake pipelines, export to a throwaway directory — without touching their real `~/.claude/` setup.

**What it is not:** Training wheels or a lesser mode. Playground is a full product lane for learning. The distinction should feel like choosing a lane, not toggling a flag.

**Entry point:** The landing page offers two explicit entry points — "Learn how workflows work" and "Build with your agents" — rather than a settings toggle. The choice is made at the start of each session, not buried in configuration.

**UX rules:**
- Playground mode must be clearly labeled at all times (persistent indicator, like Stripe's test mode banner)
- Playground workflows are non-exportable to real `~/.claude/` — the export button is disabled or writes to a sandboxed temp directory only
- Playground agents and skills are explicitly labeled as fictional in the UI (e.g. "Example Agent")
- The fake agent and template data currently in `agentLibrary.ts` and `templates.ts` belongs in Playground, not the real builder — relocate it there when Playground is built

**Implementation note:** The current hardcoded Library data (`agentLibrary.ts`) is the correct seed content for Playground. It just belongs in the wrong place. When Playground ships, that data moves into a Playground-specific module. The real builder's sidebar never shows it.

---

## Deferred Feature 2: Template System with Dependency Resolution

**The problem it solves:** Pre-built templates are valuable for discovery and onboarding, but they can't reference personal agent slugs (those are private) and they can't reference fake agents (those don't work). The only honest template is one that references real, publicly available agents and skills — and handles the case where the user doesn't have them installed.

**How it works:**
1. Each template ships with a manifest: a list of required agents and skills with public source URLs (GitHub raw links, registry entries, etc.)
2. When a user selects a template, the app diffs the manifest against what's installed in `~/.claude/agents/` and `~/.claude/skills/`
3. A modal shows the user: "This template needs 3 agents and 1 skill. You already have 2 of them. Install the missing ones?" — with a list and a single confirm button
4. Missing agents/skills are downloaded from their source URLs and written to `~/.claude/` automatically
5. The template opens with all nodes pointing to real installed agents

**Installation behavior:**
- Files are downloaded and written to `~/.claude/agents/` or `~/.claude/skills/` (same places Claude Code reads from)
- After install, they appear in My Agents and Skills automatically — no separate step
- If the user already has an agent with the same slug, the install is skipped (no overwrite without explicit consent)
- Failed downloads show a clear error: which agent/skill failed and why

**Source repositories to reference** (to be linked when building this feature):
- Public agent repos with consistent manifest formats (TBD — requires ecosystem coordination)
- The template manifest format is `template-manifest.json` alongside each template definition

**What doesn't ship with templates:** The user's personal agents. Templates are portable — they work for any user who has (or can install) the listed dependencies.

---

## Deferred Feature 3: Agent & Skill Library

*Synthesized from `docs/superpowers/plans/2026-05-25-agent-skill-library.md`.*

The Library is a dedicated section of the UI for discovering, importing, and authoring the building blocks that the canvas then assembles. It is explicitly **not** part of the canvas — building agents/skills and composing them into workflows are two different jobs.

**Three panels:**

**Installed** — lists everything in `~/.claude/agents/` and `~/.claude/skills/`. Lets users preview the raw markdown (same MarkdownViewer component already built), edit metadata, and delete entries. This is the "what do I have?" panel.

**Browse Community** — discovers agents and skills from curated public repositories. Users can preview and one-click install into their local `~/.claude/`. Sources include public GitHub repos with a `registry.json` manifest. Installation is a simple file write — no package manager, no lock file. A `cwc-source` metadata field tracks where each entry came from, enabling "check for updates."

**Create New** — a structured form for creating a new agent or skill from scratch: name, description, system prompt, tools, skills. On save, writes the file to `~/.claude/` and makes it immediately available on the canvas.

**Build order:**
1. Canvas composer (v0 — current)
2. Library: Installed panel (shows what's already in `~/.claude/`)
3. Library: Create New (form to author agents/skills)
4. Library: Browse Community (connect to external repos)

Community browsing is last because it depends on external repos having a consistent manifest format — that needs ecosystem coordination outside this project.

**Integration with canvas:** Once an agent or skill exists in the library (installed or created), it appears in the My Agents / Skills sidebar tabs on the canvas. The canvas never edits agents/skills directly — it references them. Changes to an agent in the Library propagate to any workflow that references it.

---

## Deferred Feature 4: Observability

*Synthesized from `docs/superpowers/specs/2026-05-24-composition-schema-design.md`, v1.5 Roadmap section.*

Observability is the key differentiator of the product and the immediate post-v1 priority. It requires runtime integration that doesn't exist in v0 — but the architecture is clear.

**Architecture:** `npx cwc` already runs a local Node.js server. In v1.5, this server also exposes a local MCP server on a separate port. When the composer exports a workflow, it injects the MCP server configuration into the orchestrator skill. The skill calls the MCP server to log events — workflow started, agent invoked, artifact produced, workflow completed.

**Fire-and-forget:** MCP logging calls are non-blocking. If the composer is not running when the workflow is invoked, the MCP calls fail silently and the workflow continues normally. Observability is opt-in by nature — run `npx cwc` alongside Claude Code to get logs.

**What it unlocks:**
- Real-time run dashboard — see which step the workflow is on as it executes
- Agent invocation log — which agents were called, when, and how long they ran
- Artifact trace — which artifacts were produced, at which paths, by which agents
- Context visibility — see which context affected which outputs (directly addresses the reliability gap the CCW reference implementation identified)
- Run history — compare across multiple invocations, identify which steps succeed or fail consistently

**Schema impact:** The orchestrator skill gains an `mcpServers` section when exported with observability enabled. The `.cwc` schema gains `"observability": { "enabled": boolean }` in `meta`. No v0 schema changes required — purely additive.

---

## Other Deferred Items

*From `docs/superpowers/specs/2026-05-24-composition-schema-design.md`, Out of Scope section.*

| Item | Why deferred |
|---|---|
| MCP wiring | No project-level MCP config format exists in Claude Code today |
| Parallel convergence | Multiple edges feeding one downstream node; deferred to v2 |
| Stopping points on nodes | No canvas UI for `[Stop]` gates; deferred to v2 |
| Zip export | Bundled workflow sharing; deferred to v2 |
| Reverse import | `.claude/` → `.cwc` reconstruction; tractable once schema is stable |
| AI-assisted agent generation | Requires Claude API key UX in composer settings; design TBD |
| Agent Teams substrate | Monitor Anthropic's roadmap — may become the right substrate for deterministic sequential handoffs once stabilized |

---

## Existing Plan Documents

The following implementation plans remain valid and are not superseded by this document:

| Plan | Path | Status |
|---|---|---|
| Composition Schema Design | `docs/superpowers/specs/2026-05-24-composition-schema-design.md` | Complete spec — exporter and schema are built |
| Exporter & Test Harness | `docs/superpowers/plans/2026-05-25-exporter-and-test-harness.md` | Complete plan — Phase 1 reference |
| Canvas UI & Server | `docs/superpowers/plans/2026-05-25-canvas-ui.md` | Complete plan — Phase 2 reference |
| Skill & Agent Markdown Viewer | `docs/superpowers/plans/2026-05-25-skill-agent-markdown-viewer.md` | Complete plan — implemented |
| Agent & Skill Library | `docs/superpowers/plans/2026-05-25-agent-skill-library.md` | Future plan — Deferred Feature 3 above |
