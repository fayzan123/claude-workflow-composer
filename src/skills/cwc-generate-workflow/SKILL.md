---
name: cwc-generate-workflow
description: Generates a Claude Workflow Composer (.cwc) workflow file from a plain-English description and saves it to ~/.cwc/workflows/ so it appears immediately in the CWC canvas. Use when the user asks to "generate a workflow", "create a CWC workflow", "build a multi-agent pipeline", or anything similar.
---

# Generate CWC Workflow

You are generating a complete, valid `.cwc` workflow file for Claude Workflow Composer.
The user will describe what they want. You will produce a fully-specified workflow with
rich agent system prompts, clear completion criteria, and correct graph wiring — then
save it to `~/.cwc/workflows/` so it appears in the CWC canvas immediately.

---

## Step 1 — Understand the request

If the user's description is ambiguous on a critical point (e.g. "what codebase is this for?" or "sequential or parallel?"), ask **one** clarifying question. Otherwise make sensible defaults explicit in the workflow and proceed.

Read any relevant project files with the Read tool to make the workflow context-aware.

---

## Step 2 — Design the workflow

Plan the agents and edges before writing JSON. Think about:

- **How many agents?** 3–6 is the sweet spot. Under 3 is usually just one agent doing everything. Over 6 is usually better split into two workflows.
- **Sequential or parallel?** Sequential pipelines (A → B → C) are simpler and correct for dependent work. Parallel fan-out (A → B + C → D) makes sense when B and C are truly independent.
- **Conditional branches?** Use `dispatchMode: "conditional"` on the routing node when exactly one of multiple paths should run based on the output.
- **What does each agent actually do?** Be specific. "Reviewer" is too vague. "Reads the git diff, categorises findings by severity with file:line references, writes FINDINGS.md" is correct.

---

## Step 3 — Write the workflow JSON

Produce a single valid JSON object matching this exact schema:

```typescript
{
  meta: {
    id: string           // generate a unique ID: use Date.now() + Math.random() pattern
    name: string         // short, title-case workflow name
    description: string  // one sentence: what this workflow does
    version: 1
    created: string      // current ISO 8601 datetime
    updated: string      // same as created
  }
  nodes: Array<{
    id: string                             // unique ID per node, e.g. "node-1", "node-2"
    position: { x: number, y: number }    // see Layout Guidelines below
    exportedSlug: null                     // ALWAYS null — never a string
    startTrigger?: string                  // entry node only: what initiates the workflow
    dispatchMode?: "parallel" | "conditional"  // only set when node has >1 outgoing edges
    agent: {
      name: string              // short title-case name, e.g. "Code Reviewer"
      description: string       // one sentence role summary
      completionCriteria: string // specific and testable — what does "done" look like?
      color?: string            // one of: blue cyan green orange red purple yellow
      tools?: string[]          // use ONLY these exact strings: Read Write Edit Bash WebSearch WebFetch Agent TodoWrite
      skills?: string[]         // leave as empty array []
      systemPrompt?: string     // full agent persona and instructions (see Quality Bar below)
      model?: string            // omit — let user decide
    }
    agentRef?: never             // NEVER set agentRef — all nodes must be bespoke
  }>
  edges: Array<{
    id: string           // unique ID per edge, e.g. "edge-1"
    from: string         // must match a node id exactly
    to: string | null    // must match a node id exactly, OR null for terminal edges
    trigger: string      // one sentence: when/why this handoff happens
    label?: string       // optional short label shown on the arrow
    terminalType?: "complete" | "escalated" | "aborted"  // required when to is null
  }>
}
```

### Validation rules — the file will show errors in CWC if you break these:

- Every node `id` must be unique across the nodes array
- Every edge `from` must match a node `id` exactly
- Every edge `to` must match a node `id` exactly, OR be `null`
- Terminal edges: `to` is `null` AND `terminalType` is set
- Non-terminal edges: `to` is a node id AND `terminalType` is omitted
- `exportedSlug` must be `null` (not missing, not a string, not undefined)
- Every node `agent.name` must be non-empty
- No two nodes should have the same `agent.name`
- `skills` must be an array (empty `[]` is fine, never omit it)

### Layout Guidelines — nodes must not stack at 0,0:

**Sequential pipeline:**
```
node-1: { x: 100, y: 300 }
node-2: { x: 450, y: 300 }
node-3: { x: 800, y: 300 }
node-4: { x: 1150, y: 300 }
```

**Parallel fan-out (one node → two branches → merge):**
```
root:     { x: 100, y: 300 }
branch-a: { x: 450, y: 150 }
branch-b: { x: 450, y: 450 }
merge:    { x: 800, y: 300 }
```

**Conditional router (one node → two mutually exclusive paths):**
```
router:   { x: 100, y: 300 }
path-a:   { x: 450, y: 150 }
path-b:   { x: 450, y: 450 }
```
Each path has its own terminal edge (`to: null`).

Minimum 350px horizontal spacing between sequential nodes.
Minimum 300px vertical spacing between parallel branches.

---

## Step 4 — Quality bar for system prompts

This is the most important part. Weak system prompts produce weak agents.

**A good system prompt:**
- Opens with "You are **[Agent Name]**, ..." and states the specific role
- Has a "Your Mission" section describing the exact task
- Lists concrete deliverables (what files to read, what files to write, what format)
- Has "Critical Rules" the agent must never break
- Is specific to THIS workflow — not generic advice

**A bad system prompt:**
- "You are a helpful assistant that reviews code"
- Generic bullet points that could apply to any agent
- No mention of what files to read/write or what format to use

### Few-shot examples of high-quality agents:

**Example 1 — Diff Analyst (sequential pipeline, first node)**
```
name: "Diff Analyst"
description: "Reads the git diff for the current branch and categorises every change by risk."
completionCriteria: "Has produced DIFF_FINDINGS.md with every changed file reviewed, findings by severity (Critical/High/Medium/Low) with file:line references, and a summary count per category."
color: "orange"
tools: ["Bash", "Read", "Write"]
systemPrompt: |
  You are **Diff Analyst**, a senior engineer who reviews code changes before they ship.

  ## Your Mission
  Run `git diff main...HEAD` to get the full diff. Review every changed file.

  ## What You Look For
  **Correctness** — off-by-one errors, null dereferences, unhandled promise rejections,
  race conditions, missing error handling on paths touching external systems.

  **Performance** — N+1 query patterns, synchronous blocking on the hot path,
  unbounded arrays iterated without pagination.

  **Maintainability** — magic numbers, dead code, commented-out blocks.

  ## Output
  Write DIFF_FINDINGS.md:
  ```
  # Diff Analysis
  ## Summary
  Critical: N  High: N  Medium: N  Low: N
  ## Critical
  - `path/file.ts:42` — [finding]: [why it matters]
  ## High / Medium / Low
  ...
  ```
  Findings without file:line references will not be acted on.
```

**Example 2 — Implementation Engineer (sequential pipeline, middle node)**
```
name: "Implementation Engineer"
description: "Implements the technical spec fully, working through every task in dependency order with tests for each."
completionCriteria: "All items in SPEC.md component breakdown implemented, acceptance criteria verified via Bash, build passes with no TypeScript errors."
color: "green"
tools: ["Read", "Write", "Edit", "Bash"]
systemPrompt: |
  You are **Implementation Engineer**, an engineer who builds exactly what is specified.

  ## Your Mission
  Read SPEC.md end to end before writing a single line of code. Then implement every
  item in the component breakdown in dependency order: data model → data layer → API → UI.

  ## How You Work
  For each item: implement it, write a test, run the test with Bash, fix until it passes,
  move to the next item only when the current one is done and tested.

  After all items: go through each AC in SPEC.md, verify it passes, write results
  to IMPLEMENTATION_DONE.md.

  ## Critical Rules
  - No skipped ACs. If one can't be implemented as specified, document the deviation.
  - No TODOs in shipped code. Note out-of-scope work in IMPLEMENTATION_DONE.md.
  - Run the full test suite before finishing. No regressions.
```

**Example 3 — QA Verifier (sequential pipeline, final node)**
```
name: "QA Verifier"
description: "Independently verifies the implementation against every acceptance criterion, runs tests, checks edge cases, produces a SHIP or REWORK verdict."
completionCriteria: "QA_REPORT.md written with each AC marked pass/fail with evidence, test suite results included, final SHIP or REWORK verdict given."
color: "orange"
tools: ["Read", "Bash", "Write"]
systemPrompt: |
  You are **QA Verifier**, a quality engineer who verifies independently of whoever built it.

  ## Your Mission
  Read SPEC.md for the acceptance criteria. Do NOT just read the implementer's notes —
  verify each AC yourself using Bash.

  ## How You Verify
  For each numbered AC: read it, exercise the behaviour with Bash or by reading code,
  mark Pass or Fail with evidence.

  Beyond ACs, test edges: empty input, max-size input, duplicate requests, missing
  dependency.

  Run the full test suite. Note regressions separately from pre-existing failures.

  ## Output
  Write QA_REPORT.md:
  ```
  # QA Report
  ## Test Suite
  X passed, Y failed
  ## Acceptance Criteria
  | AC | Status | Evidence |
  | AC-1 | ✅ Pass | curl returned 200 with expected body |
  | AC-2 | ❌ Fail | Returns 500 when email is null |
  ## Verdict
  SHIP / REWORK
  Required fixes: ...
  ```

  ## Critical Rules
  - REWORK if any AC fails. No partial passes.
  - Every finding cites evidence — test output, curl result, or specific code line.
```

---

## Step 5 — Save the file

Determine the save path:

```bash
# Ensure the directory exists
mkdir -p ~/.cwc/workflows

# Generate filename: slugified name + timestamp
# e.g. ~/.cwc/workflows/code-review-pipeline-20260528-1423.cwc
```

Use Bash to write the file:

```bash
cat > ~/.cwc/workflows/[slugified-name]-[YYYYMMDD-HHmm].cwc << 'CWCEOF'
[your JSON here]
CWCEOF
```

Verify it was written:
```bash
cat ~/.cwc/workflows/[filename].cwc | head -5
```

---

## Step 6 — Confirm to the user

Tell the user:
- The workflow name and how many agents it has
- The filename it was saved to
- "Open Claude Workflow Composer (`npx claude-cwc`) and you'll see it in the Workflows tab."

If CWC is already running, tell them to click the home icon to return to the Workflows tab — the new workflow will appear within a few seconds.
