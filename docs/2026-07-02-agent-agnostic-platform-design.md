# Agent-Agnostic Automation Platform — Vision & Architecture

**Date:** 2026-07-02
**Status:** Vision-level spec. Each phase below gets its own `docs/plans/` entry before implementation.
**Scope:** Product direction + target architecture + rebuild-vs-evolve decision. Not a task list.

---

## 1. Product Thesis

The product is a **resident automation miner**: a locally running tool that continuously
observes the coding-agent sessions you already have on disk, detects repeated work across
*all* of your agents, and closes the loop from observation to running automation:

```
observe → detect → suggest (notify) → export (skill) → run (scheduled, isolated)
```

Three properties define it:

1. **Agent-agnostic input.** It reads session history from every agent on the machine —
   Claude Code, Codex CLI, Cursor, OpenClaw, and whatever ships next — not just one vendor.
2. **Simplest sufficient artifact.** A detected automation exports as a single `SKILL.md`
   (the Agent Skills open standard) by default — portable across ~32 tools, token-cheap
   (instructions run inline in the session; no orchestrator prose, no subagent context
   spin-up), and vendor-neutral. It is *promoted* to a multi-agent workflow graph only
   when it needs something a flat skill cannot express: approval gates, parallel fan-out,
   per-step isolation, or heterogeneous models/permissions per step.
3. **Resident posture.** It is not an app you remember to open. It runs scheduled scans,
   notifies you when it finds new repeated work ("you've done X 4 times this week — skill
   ready"), and keeps your exported automations running on triggers.

The dependency mechanic: detection acquires users; the scheduler retains them. Once a
user's nightly workflow fires through this tool's cron trigger in an isolated worktree,
uninstalling it breaks their pipeline.

## 2. Why This Wins (Market Facts, as of 2026-07)

- **Anthropic shipped `/insights`** in Claude Code: it mines your last 30 days of
  transcripts and produces a friction report. This validates the demand ("mine my
  history") and commoditizes the *report*. A report-only tool is now racing the vendor on
  the vendor's own data. `/insights` stops at the report; it does not produce a running
  automation. Our loop ends in one.
- **Agent Skills became an open standard** (Anthropic spec, 2025-12-18). ~32 tools support
  `SKILL.md` as of early 2026: Claude Code, Codex CLI, ChatGPT, Cursor, Gemini CLI, VS
  Code/Copilot, OpenClaw, Goose, Amp, Windsurf, Cline, OpenCode, JetBrains Junie, and
  more. **The output-format question is solved.** We write one artifact format; per-tool
  differences are placement paths and small frontmatter quirks.
- **The input side is structurally un-Sherlockable.** Anthropic will never scan your Codex
  history; OpenAI will never mine your Claude transcripts; Cursor won't parse OpenClaw
  logs. Only a neutral third party can render "your repeated work across your whole agent
  fleet." Cross-vendor ingestion is the moat, and it is also the hard engineering (N
  undocumented, drifting local formats) — hard is good when it's the defensible part.
- Evidence from users so far (n=1 interview + 1 failed install, so: directional):
  Detect's output moment lands ("worked like a chart"); generation latency/quality and
  install friction leak; cross-machine transcript parsing is fragile.

## 3. The Rebuild Question

The instinct: CWC is accreted pivots — canvas first, detect bolted on later — so if
detect-to-automation is the product, start a clean repo; AI assistance makes rebuilds
cheap.

The instinct is taken seriously here, and the answer is grounded in the code, not in
"never rewrite" folklore:

**a) Detect is not actually built on the canvas.** `src/server/api/automation-scan.ts`
(the full detect → suggest → promote pipeline) imports core modules only:
`detection/transcript-parser`, `detection/analyzer`, `generation/*`, `schema`, stores,
and runners. It imports nothing from `client/`. The single canvas artifact in the data
model is `CwcNode.position: {x, y}` — one field, trivially made optional/derived. The
pipeline was built on the **graph IR**, and the canvas is one *client* of that IR.

**b) The real accreted-pivot flaw is narrower than "the canvas" — and it is a wiring
bug, not a platform bug.** The genuine legacy of canvas-first history is that the
detection promotion path forces *every* automation into `CwcFile` workflow shape:
`automation-scan.ts` → `generateWorkflow()` → nodes/edges → orchestrator `SKILL.md` +
agent files. For a single linear procedure — the common case — that output is a skill
wearing an orchestrator costume: it pays subagent-dispatch token overhead, adds an agent
file, and becomes runtime-specific, all for zero benefit. (This is exactly what the
first user interview flagged as "single-node output.") Meanwhile the codebase *already
contains* a standalone plain-skill generator — `generation/skill-generator.ts`
(`buildSkillSpecPrompt` → `buildSkillBuildPrompt` → `assembleSkillFile`) — that is
simply not wired into detection. The fix is an artifact-classification step (§4) that
makes single-skill the default output and reserves the graph for automations that need
orchestration. The graph IR itself remains correct for that minority: a gated, parallel,
multi-stage automation *is* a DAG, and any clean-room rebuild re-arrives at nodes +
edges + triggers. What must not survive is workflow shape as the *mandatory* output and
view data as *mandatory* IR fields — both are pipeline changes, not architecture
replacements.

**c) What a rewrite actually costs is not typing time.** AI regenerates code fast. What
it regenerates slowly — in users' laps — is the encoded correctness: 567 tests covering
Windows paths and process timing, export ownership/conflict safety, slug collision and
rename reconciliation, port-collision hardening, transcript quirks. That knowledge lives
in the test suite and was paid for in bugs. A fresh repo restarts that ledger at zero.

**d) The scarce resource is user signal, not code cleanliness.** With one interview and
one failed second install, months of heads-down rebuilding produce a second unvalidated
product. Every phase below ships something a user can run that week.

**Decision (revised 2026-07-02, after the surface unification in §4):** Fresh repo and
identity — **not** fresh code. "New repo" and "rewrite" are separate decisions. The
surface unification (one skill list, document-first, canvas as a Diagram tab, CLI/daemon
posture) obsoletes nearly all of `client/` — and the client was the main argument for
evolving in place. What survives is the pure-TS core (parsers, analyzer, generators,
exporter safety, run harness, scheduler, notifier, schema) — portable modules with
tests. When the shell dies and the organs are portable, a new shell in a new repo is a
transplant, not a rewrite.

**The one hard migration rule:** core modules move to the new repo *with their tests,
unmodified except import paths*. Get each module green in the new home before any
refactor. The failure mode is not starting the new repo — it is "while I'm moving this,
let me redo it," which silently converts a transplant into a ground-up rewrite and
resets the 567-test correctness ledger.

**Repo choreography:** Phase 0 executes in CWC now (it serves the open Detect bug and
the 2026-07-06 user call regardless). The new repo scaffolds CLI-first and receives
modules in phase order: detection + skill-generator + export at Phases 0–1; harness/
scheduler/notifier at Phase 3; a fresh Diagram-tab client against the new IA at Phase 2+.
CWC stays published and untouched as the predecessor; its README points forward once the
Phase 2 cross-agent demo exists — which is also when the new name gets decided, with
evidence behind it.

**Structural guard against canvas lock-in** (acceptance criterion, enforced from Phase 2
onward): *the full loop — scan → detect → suggest → export → run — must complete with the
`client/` directory deleted.* If that test passes, the canvas is a feature, not a
foundation, and the lock-in fear is dissolved by construction.

## 4. Target Architecture

```
┌────────────────────────── SOURCES (per-agent parsers) ──────────────────────────┐
│ claude-code (~/.claude/projects/*.jsonl)   codex (~/.codex/sessions)            │
│ cursor (state.vscdb sqlite)                openclaw (session logs)    …next     │
└──────────────┬──────────────────────────────────────────────────────────────────┘
               │  normalize → TaskUnit[]  (graceful degradation + per-source diagnostics)
               ▼
        ┌─────────────┐      pluggable engine: claude -p │ codex exec │ local model
        │  ANALYZER    │ ──── digest → DetectedAutomation[]
        └──────┬──────┘
               ▼
        ┌─────────────┐
        │ SUGGESTIONS  │ ──── scan-store + notifier ("found 2 new repeated workflows")
        └──────┬──────┘
               ▼
        ┌─────────────┐      simplest sufficient artifact
        │  CLASSIFY    │ ──── skill (DEFAULT) ────────────────┐
        └──────┬──────┘                                       │
               │ workflow (needs gates/parallel/isolation)    │
               ▼                                              │
        ┌─────────────┐                                       │
        │  IR (.cwc)   │  graph; positions optional           │
        └──────┬──────┘                                       │
               ▼                                              ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  ARTIFACT COMPILER                                              │
   │  skill path:    plain SKILL.md (skill-generator) — portable     │
   │  workflow path: orchestrator SKILL.md + agents/*.md (BFS/prose) │
   │  both: placement map per tool + ownership comments              │
   └──────────┬─────────────────────────────────────────────────────┘
              ▼
   ┌───────────────────────┐
   │  RUNTIMES              │ ──── claude -p today; codex exec, others behind the same
   └───────────────────────┘        spawn interface (worktree isolation, gates, JSONL events)

SURFACES (clients of the pipeline, in priority order):
  1. CLI      — `cwc detect` one-shot scan, terminal output, inline export
  2. Daemon   — `cwc watch` scheduled scans + notifications (launchd/login item)
  3. App      — one list of skills (suggested + installed); document view default,
                Diagram tab appears only on skills with orchestration structure
```

### One user-facing artifact: the skill

The two-artifact model (skill vs. workflow) is internal only. To the user, **everything
the product produces is a skill** — which is already true at the artifact level: a
workflow's exported form is a `SKILL.md` (orchestrator) plus agent files. The product
model follows the artifact:

- A **simple skill**'s body is the procedure, inline. Its detail view is a document:
  rendered SKILL.md, the detection evidence that produced it, inline editing, and
  actions — Install, Test run, Add schedule.
- A **structured skill**'s body carries orchestration (subagent dispatch, gates,
  parallel steps). Its detail view is the same document, plus a **Diagram tab** — the
  canvas, demoted from app mode to view mode, editing the `.cwc` graph behind the skill
  (markdown edit/preview-toggle analogy).
- "Workflow" disappears from user-facing vocabulary. `.cwc` remains the internal IR for
  structured skills; classification (§ above) decides a skill's internal shape, not a
  user-visible type. The flow never forks: notify → open suggestion → read skill →
  install → optionally schedule — identical for both shapes.
- Scheduling is uniform because the runner spawns a *slug* (`claude -p "/<slug>"`), not
  a graph: any skill, either shape, attaches to a cron trigger and runs through the
  harness (isolation, run log, gates where present, notifications).

### Artifact classification (the core correction to today's pipeline)

Today, promotion compiles every detection into a `CwcFile` workflow. In the target
architecture, classification chooses the **simplest sufficient artifact**:

- **Skill (default).** A single `SKILL.md` generated by the existing
  `generation/skill-generator.ts` path. Runs inline in whatever agent invokes it: no
  orchestrator prose, no subagent context spin-up, no agent files, portable to every
  SKILL.md-compatible tool. Most detected repetitions are linear procedures and land
  here.
- **Workflow (promotion).** A `.cwc` graph, chosen only when the automation requires
  capabilities a flat skill cannot express:
  - an **approval gate** (pause mid-run, CWC inbox, resume on approve/reject)
  - **parallel fan-out** across agents
  - **per-step isolation** (worktree per stage) or per-step model/permission choices
  - **scheduled unattended runs** that need the run harness (event log, finish
    classification, notifications)
- **Lint rule:** a workflow whose graph has one node and no gate/trigger-specific needs
  is a classification bug by definition — the compiler collapses it to a plain skill.
- Skills remain *upgradeable*: a skill can later be wrapped as a node in a workflow (the
  existing reference-node mechanism), so choosing the simple artifact first costs
  nothing.

```ts
// classification result carried on the suggestion
type ArtifactKind = 'skill' | 'workflow'
interface ClassifiedAutomation extends DetectedAutomation {
  kind: ArtifactKind
  promotionReasons?: ('gate' | 'parallel' | 'isolation' | 'multi-model')[]  // required when kind === 'workflow'
}
```

### Key interfaces (sketch)

```ts
// src/detection/source.ts — generalization of today's transcript-parser two-function shape
export interface SessionSource {
  id: string                                    // 'claude-code' | 'codex' | ...
  discover(homeDir: string): Promise<string[]>  // today: findTranscripts()
  parse(ref: string): Promise<TaskUnit[]>       // today: parseSession()
}
// Contract: parse failures are per-source diagnostics, never scan-fatal.
// Each source ships with fixture transcripts + a drift test.

// src/detection/engine.ts — analysis engine behind the digest
export interface AnalysisEngine {
  id: string                                    // 'claude' | 'codex' | ...
  analyze(digest: string, opts: EngineOpts): Promise<DetectedAutomation[]>
}

// src/server/runtime.ts — runtime behind Test Runs / scheduled runs
export interface AgentRuntime {
  id: string
  spawnHeadless(skillSlug: string, opts: RunOpts): ChildProcess  // today: claude -p "/<slug>"
  supportsSubagents: boolean                                     // gates workflow-vs-skill compile
}
```

### Portability boundary (be precise about what travels)

- **Single skills** (the common detect output): fully portable via `SKILL.md`. Write once,
  place into each tool's skills directory with ownership comments, same conflict-detector
  safety rules as today.
- **Multi-agent workflows** (subagent dispatch, gates, isolation): per-runtime. Compile
  them for runtimes that support the constructs; otherwise the neutral orchestrator is
  *our own runner* — it already owns isolation, gates, and event logging, and only needs
  the spawned binary to become configurable.

## 5. Module Map (exists / adapts / new)

| Target component        | Today                                                        | Work        |
| ----------------------- | ------------------------------------------------------------ | ----------- |
| Source: claude-code     | `detection/transcript-parser.ts`                             | **adapt** — wrap in `SessionSource`, harden, add diagnostics |
| Sources: codex/cursor/… | —                                                            | **new** — one implementation per agent, fixture-tested |
| Digest + analysis       | `detection/digest-builder.ts`, `analyzer.ts`, `streaming-analyzer.ts` | **adapt** — engine behind `AnalysisEngine` |
| Suggestion store/promote| `scan-store.ts`, `api/automation-scan.ts` (already seeds disabled cron triggers) | exists |
| Scheduled scans         | `automation-scheduler.ts` (croner), `automation-state.ts`    | **adapt** — point existing scheduler at scans, not just triggers |
| Notifications           | `notifier.ts` (macOS + webhooks)                             | exists |
| Artifact classification | — (promotion hardwired to workflows)                         | **new** — `ClassifiedAutomation`, skill-default + lint rule |
| Skill artifact path     | `generation/skill-generator.ts` (spec → body → assemble)     | **adapt** — wire into detect promotion as the default output |
| IR                      | `schema.ts` (`CwcFile`)                                      | **adapt** — `position` optional, auto-layout on import |
| Artifact compiler       | `export/*` (writer, conflict-detector, skill-resolver)       | **adapt** — placement map for non-Claude skills dirs |
| Runtimes                | `workflow-runner.ts`, `run-launcher.ts`, `run-isolation.ts`  | **adapt** — binary behind `AgentRuntime` |
| CLI surface             | `bin/cwc.ts` (server launcher)                               | **new** — `detect` / `watch` subcommands |
| Daemon surface          | —                                                            | **new** — launchd/login-item packaging of `watch` |
| Canvas surface          | `client/`                                                    | exists — demoted to optional editor; feature-frozen during Phases 0–4 |

Rough ratio: ~70% exists or adapts, ~30% new — and the new parts (sources, daemon, CLI
surface) are exactly the parts a ground-up rebuild would also have to write from scratch.

## 6. Phases

Each phase ships something a user can run. Each gets its own plan doc.

**Phase 0 — Ingestion hardening (now).**
Structured logging through the detection path; `cwc detect --debug` emits a redacted
diagnostic bundle; parser tolerates transcript schema drift (unknown entry types skip
with a counted warning, never crash the scan).
*Accept:* the open cross-machine Detect bug is diagnosable from one pasted bundle,
without a live debugging session.

**Phase 1 — Headless detect + skill-default output (the new front door).**
`npx claude-cwc detect`: scan → terminal findings (the "chart" moment) → inline
"export skill? [y/N]" → pointer to canvas for the workflow-shaped minority. No server,
no browser required. This phase also lands artifact classification: single-procedure
detections export as a plain `SKILL.md` via `skill-generator` (no graph, no agent
files, no orchestrator overhead); only gate/parallel/isolation-needing detections
produce `.cwc` workflows.
*Accept:* first value moment ≤ 2 minutes from a cold `npx` on a fresh machine; a linear
detected automation produces exactly one `SKILL.md` and nothing else; no exported
workflow has a single-node graph.

**Phase 2 — Second source + the unified chart.**
One additional `SessionSource` (choose by asking interviewees what they run — Codex CLI
is the likely candidate; check OpenClaw's session format given its adoption). Detect
output labels findings per-agent and cross-agent.
*Accept:* the "repeated work across Claude Code + Codex" demo exists — the screenshot no
first-party tool can produce. **The `client/`-deleted loop test passes.**
*Gate:* rename/repositioning conversation opens only after this phase validates with
real users.

**Phase 3 — Resident posture.**
`cwc watch`: scheduled scans via existing croner machinery, notifier pings on new
suggestions, login-item install (`cwc watch --install`). Weekly digest cadence default.
*Accept:* zero-interaction week ends with a genuinely useful notification.

**Phase 4 — Placement targets.**
Exporter placement map writes the same `SKILL.md` into each detected tool's skills
directory, with ownership comments and existing conflict-detector rules.
*Accept:* one detected automation, exported once, invocable from two different agents.

**Phase 5 — Pluggable engines and runtimes.**
`AnalysisEngine` + `AgentRuntime` implementations beyond Claude, driven by what
interviewed users actually run. Workflows compile per-runtime; skills stay universal.
*Accept:* full loop completes on a machine whose only agent is not Claude Code.

## 7. Risks

- **Format drift (highest, permanent).** Every source format changes under us. Mitigate:
  per-source fixtures + drift tests, graceful per-source degradation, Phase 0 diagnostics
  so field breakage is debuggable async.
- **Privacy.** A resident daemon reading all agent transcripts is trust-sensitive.
  Local-first is non-negotiable and a headline feature: no transcript content leaves the
  machine except to the user's own chosen analysis engine; `--debug` bundles are redacted.
- **Vendor sherlocking.** `/insights` grows toward suggestion. Defense is the input side
  (cross-vendor) and the loop's back half (scheduled, isolated execution). Never compete
  on report quality alone.
- **Scope creep back into the canvas.** Canvas is feature-frozen until Phase 4; the
  `client/`-deleted test keeps the pipeline honest.
- **Naming debt.** "Claude Workflow Composer" contradicts the neutral-layer story.
  Deliberately deferred to the Phase 2 gate — evidence before identity.

## 8. Open Questions

1. **Second source:** Codex CLI vs Cursor vs OpenClaw — decide from interview data
   (stargazer DMs + 2026-07-06 call), not assumption.
2. **Daemon distribution:** plain login-item CLI vs menu-bar app vs installer script.
   Start with the CLI login item (cheapest, cross-platform-ish); revisit after Phase 3
   retention data.
3. **New name:** the fresh repo is decided (§3); the *name* is still decided at the
   Phase 2 gate, once the cross-agent demo gives the positioning evidence. The repo can
   start under a working title.
