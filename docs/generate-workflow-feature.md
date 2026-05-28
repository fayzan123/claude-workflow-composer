# Feature: AI Workflow Generation via Claude Code Skill

## Overview

A `generate-workflow` skill that ships with CWC. The user invokes it inside Claude Code
with a plain-English description. Claude Code writes a valid `.cwc` file to
`~/.cwc/workflows/`. The user opens CWC and the workflow appears in the Workflows tab,
fully built — nodes with system prompts, completion criteria, tools, and wired edges —
ready to inspect, tune, and export.

No API key. No in-app chat. Claude Code is the AI engine.

---

## User Flow

```
1. User runs Claude Code in any project
2. User invokes: /generate-workflow
3. Claude Code asks: "Describe the workflow you want to build"
4. User types: "Code review pipeline — diff analysis, security audit, fix critical
   issues, sign off before PR"
5. Claude Code generates a complete .cwc JSON file
6. Saves to: ~/.cwc/workflows/code-review-pipeline.cwc
7. User opens CWC (npx claude-cwc)
8. Workflow appears in Workflows tab
9. User clicks it — full canvas loads with all agents and edges
10. User tunes as needed, exports to ~/.claude/
```

---

## Skill Design

The skill ships as `~/.claude/skills/cwc-generate-workflow/SKILL.md`.

It contains:
- The complete CwcFile JSON schema with field descriptions
- Validation rules CWC enforces (so Claude Code generates valid files)
- Node positioning guidelines (so nodes render in a readable layout)
- Bespoke-only rule (no agentRef — all nodes must be self-contained)
- Save path and filename convention
- Output confirmation message to the user

---

## Schema the Skill Must Know

```typescript
CwcFile {
  meta: {
    id: string          // UUID — must be crypto.randomUUID() equivalent
    name: string        // Human-readable workflow name
    description: string // One sentence describing what the workflow does
    version: 1
    created: string     // ISO 8601
    updated: string     // ISO 8601
  }
  nodes: CwcNode[]
  edges: CwcEdge[]
}

CwcNode {
  id: string                              // UUID
  position: { x: number, y: number }     // Canvas coordinates (see Layout below)
  exportedSlug: null                      // Always null for new workflows
  startTrigger?: string                   // Entry node only: what kicks this off
  dispatchMode?: 'parallel' | 'conditional' // Only set if node has >1 outgoing edge
  agent: {
    name: string              // Short, title-case agent name
    description: string       // One sentence role description
    completionCriteria: string // Specific, testable: what does "done" look like?
    color?: string            // 'blue' | 'cyan' | 'green' | 'orange' | 'red' | 'purple' | 'yellow'
    tools?: string[]          // Subset of: Read, Write, Edit, Bash, WebSearch, WebFetch, Agent
    skills?: string[]         // Leave empty — no local skill dependencies
    systemPrompt?: string     // Full agent persona and instructions
    model?: string            // Leave unset — user chooses
  }
}

CwcEdge {
  id: string          // UUID
  from: string        // node.id of source node
  to: string | null   // node.id of target node, or null for terminal edge
  trigger: string     // When/why this handoff happens (one sentence)
  label?: string      // Optional short label shown on the edge
  terminalType?: 'complete' | 'escalated' | 'aborted'  // Only on terminal edges (to: null)
}
```

---

## Validation Rules CWC Enforces

The skill must generate files that pass these or the workflow will show errors on load:

- Every node `id` must be unique
- Every edge `from` and `to` must reference a valid node `id` (or null for terminal)
- At least one node must exist
- Every node `agent.name` must be non-empty
- No two nodes can have the same `agent.name` (duplicate slug warning)
- `exportedSlug` must be `null` (not missing, not a string)
- Terminal edges: `to: null` and `terminalType` set
- Non-terminal edges: `to` is a valid node id, no `terminalType`

---

## Node Layout Guidelines

Nodes stacking at `{x:0, y:0}` ruins the canvas. The skill must generate readable positions:

**Sequential pipeline** (most common):
```
Node 1: { x: 100, y: 300 }
Node 2: { x: 450, y: 300 }
Node 3: { x: 800, y: 300 }
Node 4: { x: 1150, y: 300 }
```

**Parallel fan-out from one node:**
```
Root:      { x: 100, y: 300 }
Branch A:  { x: 450, y: 150 }
Branch B:  { x: 450, y: 450 }
Merge:     { x: 800, y: 300 }
```

**Conditional router (dispatchMode: 'conditional'):**
```
Router:    { x: 100, y: 300 }
Path A:    { x: 450, y: 150 }
Path B:    { x: 450, y: 450 }
```
Each path has its own terminal edge (to: null).

Horizontal spacing: 350px minimum between sequential nodes.
Vertical spacing: 300px between parallel branches.

---

## Save Path Convention

```
~/.cwc/workflows/[slugified-name]-[timestamp].cwc
```

Slugification: lowercase, spaces to hyphens, strip special chars.
Timestamp suffix (YYYYMMDD-HHmm) prevents overwriting existing workflows.

Example: `~/.cwc/workflows/code-review-pipeline-20260528-1423.cwc`

---

## Skill Installation

On first run, the `cwc.js` bin script detects that the skill has never been prompted,
shows a clear explanation, and asks the user yes/no before touching `~/.claude/`.

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Workflow Composer — optional skill install           │
│                                                              │
│  CWC includes a Claude Code skill that lets you generate    │
│  workflows from plain English descriptions directly inside  │
│  Claude Code — no API key needed.                           │
│                                                              │
│  This would install one file:                               │
│    ~/.claude/skills/cwc-generate-workflow/SKILL.md          │
│                                                              │
│  You can uninstall it anytime by deleting that file, or     │
│  by running: npx claude-cwc uninstall-skill                 │
│                                                              │
│  Install the skill? (y/N):                                  │
└─────────────────────────────────────────────────────────────┘
```

- User answers **y**: skill written to `~/.claude/skills/cwc-generate-workflow/SKILL.md`,
  flag written to `~/.cwc/.skill-version` (stores the CWC version that installed it)
- User answers **n** (or Enter): skipped, flag still written so they aren't prompted again
- Flag missing: prompt again on next run

**Skill updates:** When CWC ships a new version with an improved skill, compare the
version in `~/.cwc/.skill-version` against the current CWC version. If outdated and
the skill file exists, prompt once: "A newer version of the generate-workflow skill is
available. Update it? (y/N)". If the user previously said no to install, do not re-prompt
on updates.

---

## Potential Collisions and Conflicts

### 1. Timestamp suffix prevents file overwrites
Without it, generating two "code review" workflows overwrites the first.
**Resolution:** timestamp suffix in filename (see Save Path Convention above).

### 2. CWC open while skill writes a file
CWC auto-saves the *active* workflow every 500ms. If a user has CWC open and
Claude Code writes a *new* file, there is no collision — auto-save only writes
to the currently loaded workflow path, not to new files.

**Live reload (shipping with this feature):** TemplatePicker polls
`GET /api/workflows` every 3 seconds when the Workflows tab is active. When a
new file appears, the list updates in place — no page refresh needed. Polling
stops when the user switches away from the Workflows tab or opens a workflow.
Implementation: `setInterval` in the TemplatePicker Workflows tab, cleared on
tab switch. Low risk — one lightweight API call every 3s, same endpoint already
used on mount.

### 3. Schema drift
As CWC adds new fields (e.g., `dispatchMode` was just added), the skill's
embedded schema description could become outdated. Generated files with missing
optional fields will still load — CWC treats unrecognized/missing optional fields
gracefully. Required fields (`id`, `name`, `exportedSlug: null`) are unlikely to
change.
**Resolution:** Skill documents optional fields clearly. Core required fields are
stable. Review skill when bumping minor version.

### 4. Invalid tool names
If Claude Code hallucinates a tool name (e.g., "HTTPRequest" instead of "WebFetch"),
the tool appears in the NodePanel but fails silently at export/runtime.
**Resolution:** Skill explicitly lists the valid tool names and instructs Claude Code
to use only those exact strings.

### 5. Does this make templates useless?
Partially. Templates serve: (a) instant-start with zero Claude Code interaction,
(b) examples of high-quality agent specs, (c) users who don't want to describe
their workflow in words.
Generated workflows serve: (a) custom workflows tailored to the user's description,
(b) workflows aware of the user's actual codebase.
They are complementary. Templates remain useful as starting points and examples.

### 6. Skill name collision
If a user already has a skill at `~/.claude/skills/cwc-generate-workflow/`, a future
CWC update shipping a new version of the skill would not overwrite it.
**Resolution:** Skill is namespaced `cwc:generate-workflow`. Install script checks
for existing file and prompts before overwriting.

### 7. recents.json not updated
The skill saves to `~/.cwc/workflows/` but does not write to `~/.cwc/recents.json`.
The workflow appears in Workflows tab (full file scan) but not in a hypothetical
recents list. This is fine — recents are added when the user *opens* a workflow
in CWC, not when it's created externally.

### 8. Node IDs must be UUIDs
If Claude Code generates `"node-1"` style IDs, CWC renders them fine (IDs are
opaque strings internally) but edge references must still match exactly.
**Resolution:** Skill instructs Claude Code to generate UUIDs using a simple format
or unique strings. Consistency between node IDs and edge from/to references is
what matters — not UUID format specifically.

---

## What This Does NOT Do

- Does not replace the visual editor — generated workflows are starting points, not
  finished products
- Does not generate reference nodes (`agentRef`) — all nodes are bespoke and
  self-contained
- Does not export automatically — user still previews and confirms before writing
  to `~/.claude/`
- Does not require CWC to be running — skill works entirely in Claude Code

---

## Decisions Made

| Question | Decision |
|----------|----------|
| Skill installation | First-run prompt with full explanation, y/N. Flag prevents re-prompting. |
| Live reload | Poll /api/workflows every 3s when Workflows tab is active. |
| Description field (fixes.md #3) | Fix it in the same pass — generated workflows populate it, editor should expose it. Add description field to TopBar alongside the name field. |
| Few-shot examples in skill | Yes — embed the 3 template agents as quality examples so Claude Code knows the bar. |

## Skill Update Behavior

Silent auto-update. If the user said yes to install, CWC silently overwrites
`~/.claude/skills/cwc-generate-workflow/SKILL.md` on each run when the installed
version differs from the current CWC version. No prompt. The skill is open source
and deletable at any time.
