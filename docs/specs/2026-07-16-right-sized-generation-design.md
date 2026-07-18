# Right-Sized Generation: Artifact Tier Classifier

**Date:** 2026-07-16
**Status:** Implemented
**Scope:** Detection → generation → export. Reorders the product roadmap: this becomes the
next major stage after Stage 1 (run manifests, Apply/Discard). Stage 2 (deployment registry)
proceeds with artifact-kind awareness; Stages 4–6 move behind this work.

## Implementation notes

The implementation deliberately strengthens a few details from the initial design:

- Any observed risky external action recommends the gate-capable `workflow` tier, even when
  it is the final or only risky step. This favors safety over the narrower original ordering
  heuristic; users can still choose another tier explicitly.
- Version 2 metadata adds `artifactTier` and `sourceAutomation` alongside `artifactKind`.
  This preserves verify-only loop identity and the observed steps/verification condition needed
  for faithful skill-to-workflow graduation.
- Workflow-to-skill demotion also permits one terminal-only edge from the single bespoke node.
  It must be a context-free `complete` edge; its finish condition and the agent's other exported
  semantics are folded into the skill body instead of being discarded.
- The exporter safely reconciles the current owned target during kind transitions, but the
  multi-target deployment registry remains the next roadmap stage rather than being folded
  into this implementation.
- Managed launches take a short, leased snapshot of the verified skill and every plain filesystem-backed dispatched agent
  into a private namespaced plugin. The server-owned manifest retains that binding through
  approval pauses, so a concurrent re-export cannot change what a bypass-permissions run or
  resume executes. Namespaced plugin-agent dispatches fail closed until their installed bytes
  can also be resolved and snapshotted.
- Exported skills declare their bespoke dispatch slugs in a canonical ownership-adjacent
  marker. Managed runs require every declared bespoke agent to remain workflow-owned and
  preserve undeclared agents as references while snapshotting their exact installed bytes.
  Missing or malformed reference agents fail closed instead of changing resolution inside
  an isolated worktree.
- The binding source is the selected checkout, not the temporary worktree, so untracked
  project exports work with the default isolated loop/run path while still executing exact
  leased bytes.
- Model-authored skill bodies must cover observed steps monotonically and may contain an
  external-action line only when that exact instruction was observed; otherwise generation
  stays in-tier through the deterministic fallback.
- Explicit skill graduation scans the current edited body as authoritative input. External
  action signals absent from retained/extracted phases force a read-only entry preflight and
  approval gate before any generated agent receives the body. With no current numbered
  checklist, graduation preserves the body as one phase instead of resurrecting stale
  detection steps; risky multi-phase graduation shares only non-action context across gates.
- Workflow planning must preserve the structural evidence that selected the tier. Observed
  independent groups compile to real fan-out/join edges; undersized or serialized model plans
  fall back deterministically, parallel terminal branches join before completion, and risky
  siblings share one resumable approval boundary.
- Rule add/remove revalidates guidance-file identity and content immediately before atomic
  rename, so an editor save racing CWC is preserved and reported as a conflict.
- Export leases canonicalize filesystem aliases through the nearest existing ancestor. A
  workflow deployment stages every file before publishing and retains exact old-byte backups
  plus reversible deletion backups until the authorized `.cwc` recipe CAS commits. A later
  file or recipe failure restores the entire prior deployment; post-commit refresh failures
  cannot turn success into a false error response.
- If a successful isolated setup writes output but final deployment revalidation rejects the
  launch, CWC checkpoints that output onto the managed result branch and exposes Discard
  instead of force-removing a dirty worktree.

## Problem

CWC generates a multi-agent canvas workflow for every promoted detection because the workflow
is the product's only native artifact. The artifact shape is chosen by what CWC is, not by what
the repetition needs. Consequences observed in practice:

- A linear single-role procedure becomes a one-node "workflow" — a skill wearing workflow
  clothing, with orchestrator prose, agent files, and dispatch overhead it does not need.
  (This is the "single-node workflow" complaint from the first user interview.)
- The generated artifact is heavier to run, edit, and trust than the thing the user actually
  repeated.
- The output contradicts current practitioner consensus. Anthropic's agent guidance is to use
  the simplest pattern that works and reserve multi-agent designs for context pollution,
  genuine parallelism, or specialization. The 2026 "agentic loops" shift (Karpathy, Cherny,
  Willison, Steinberger) converges on: small artifact + recurrence + verification, not graphs.

Detection is not the problem. Repetitions found by the scanner are good; the generator wastes
them by compiling every one to the same maximal shape.

## Direction

Reframe generation as an **automation compiler with a classifier**. Detection evidence first
passes through a deterministic classifier that picks the smallest artifact tier that captures
the repetition. Only the workflow tier engages the existing planner/compiler path and the
canvas. The canvas is demoted from "the product" to "the editor for the multi-agent tier."

The managed-run harness (worktree isolation, gates, Apply/Discard, run logging) is orthogonal
to tier: any side-effectful artifact can run through it. This is CWC's differentiator over a
hand-written slash command — a loop you can watch, gate, and roll back.

## Artifact Tiers

| Tier       | Artifact produced                                                                                                         | When                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `rule`     | A suggested CLAUDE.md / AGENTS.md line (user applies explicitly)                                                          | Repeated instruction with no meaningful tool activity                                   |
| `skill`    | One plain Claude Code skill (`SKILL.md`), no orchestrator, no agent files                                                 | Linear, single-role procedure — the expected majority case                              |
| `loop`     | The `skill` tier plus a disarmed `CwcTrigger` (cron) and/or a verification condition, run through the managed-run harness | Recurring procedure, or one with an observed verify-fix-retry pattern                   |
| `workflow` | Today's output: canvas graph, exported orchestrator skill + agent files                                                   | Genuine parallelism, ≥3 distinct roles, or a risky step that needs a gate between roles |

Future tier (explicitly out of scope here): compiling the canvas to a Claude Code dynamic
workflow script (`.claude/workflows/*.js`). It slots in as a second export shape of the
`workflow` tier and must not block this stage.

## Classifier

### Inputs

`DetectedAutomation` alone is too thin (`steps`, `stepTokens`, `evidence` counts). The scan
pipeline already holds the matched `TaskUnit`s (`tools[]`, `commands[]`, `promptText`,
timestamps) when it builds the digest. At scan time, derive a `shape` feature block and persist
it on the automation so classification never needs to re-open transcripts:

```ts
// src/detection/types.ts
export interface AutomationShape {
  stepArchetypes: string[]; // archetype id per step, via matchArchetype()
  distinctArchetypes: number;
  hasToolActivity: boolean; // any tools/commands in matched units
  hasVerifySignal: boolean; // 'verify' archetype present, or test/build commands observed
  hasRetryPattern: boolean; // verify commands repeated within a single unit
  hasRiskyStep: boolean; // any archetype with risky: true (publish, communicate)
  independentStepGroups: number; // step groups with no data/order dependency (1 = strictly linear)
  independentStepIndexes?: number[]; // exact consecutive sibling indexes; required when groups > 1
  recurring: boolean; // suggestedTrigger.kind === 'schedule' || evidence.timing present
  observedMutatingTools?: string[]; // exact safe connector tool names retained for workflow agents
}

export interface DetectedAutomation {
  // ...existing fields
  shape?: AutomationShape; // absent on automations from older scans
}
```

Parallel evidence is deliberately conservative. CWC requires an explicit parallel phrase plus
two or more consecutive, same-role sibling steps grounded by their subject tokens, then persists
their exact indexes. A later independent review after implementation is not fan-out. When in
doubt, return 1 (linear); ambiguous persisted counts without indexes never change execution
order. Overcounting groups inflates workflows — the failure mode this design exists to eliminate.

### Decision procedure

Deterministic, ordered, first match wins. No model call.

1. `workflow` safety override — any `hasRiskyStep`, including a prompt-only, final, or sole
   risky instruction. The gate-capable tier is always the conservative recommendation.
2. `rule` — `!hasToolActivity` and evidence.count ≥ 3. The repetition is an instruction, not
   a procedure.
3. `workflow` structure — either `independentStepGroups ≥ 2`, or
   `distinctArchetypes ≥ 3` with a role shift between read-only and write archetypes.
4. `loop` — `recurring`, or (`hasVerifySignal && hasRetryPattern`).
5. `skill` — everything else. The default is the smallest procedural artifact.

Properties:

- **Downgrade-safe, never upgrade-silent.** The planner may still simplify within a tier, but
  nothing below the classifier may escalate a `skill` into a `workflow`. Escalation is a user
  action (see Graduation).
- **User override.** The promotion UI shows the predicted tier and lets the user pick another
  before generation. Override is recorded on the automation (`statusDetail`) for later tuning.
- **Missing shape.** Automations persisted before this change (`shape` absent) classify as
  `workflow` — identical to today's behavior, no migration required.

### Placement

`classifyAutomation(automation): ArtifactTier` lives in `src/generation/classifier.ts` as a
pure core module (no Express, no I/O), reusing `matchArchetype` from
`src/generation/archetypes.ts`. Shape derivation lives beside the digest builder in
`src/detection/` where the TaskUnits are in hand.

## Generation per tier

- **`rule`:** No generation call. Produce the suggested line deterministically from the
  repeated `promptText` core. Surfaced in Detect UI with an explicit "append to CLAUDE.md /
  AGENTS.md" action; CWC never edits those files without the click, and appends inside
  `<!-- cwc:rule:<automationId> -->` markers so it can be found and removed later.
- **`skill`:** Reuse the existing standalone path (`src/generation/skill-generator.ts`
  `SkillSpec` / `assembleSkillFile`), grounded in the observed steps with the same exact
  step-coverage requirement the workflow planner enforces today. One Claude call, one file.
  Fallback when the call fails: deterministic SKILL.md from the observed step checklist
  (mirror of the existing `fallback-plan.ts` behavior).
- **`loop`:** The `skill` generation plus a `CwcTrigger` prefilled from
  `suggestedTrigger.cron`, `enabled: false` (imported/generated automation is never armed),
  `isolation: 'worktree'` by default. When `hasVerifySignal`, the skill body ends with an
  explicit verification step and a stop condition ("stop when <verify command> passes or two
  rounds make no progress" — the observed verify command, not an invented one).
- **`workflow`:** Planner prompt → `validatePlan` → `compile` → canvas. Mutating connector
  tool names observed in the matched transcript units are retained exactly on the bespoke agent
  behind the corresponding approval boundary. Ambiguous tools are delayed to the last risky
  phase; reference-agent reuse is declined when its immutable tool contract cannot express the
  observed capability.

## Persistence and schema

Keep `CwcFile` as the universal container rather than inventing a parallel store. Extend meta:

```ts
export interface CwcMeta {
  // ...existing fields
  artifactKind?: "workflow" | "skill"; // absent = 'workflow' (back-compatible)
}
```

- A `skill`/`loop`-tier artifact is a `CwcFile` with `artifactKind: 'skill'` and exactly one
  bespoke node holding the skill content mapping (agent name/description → frontmatter,
  systemPrompt → body). Loops are `artifactKind: 'skill'` plus `meta.triggers`.
- `rule` suggestions are not `CwcFile`s. They live on the `DetectedAutomation` record and in
  the target markdown file only.
- Structural rule, enforced by the Stage 3 canonical parser when it lands: `artifactKind:
'skill'` requires exactly one non-gate node and no edges. Until then, the export and run
  paths validate it locally.
- This is a `version` bump for `.cwc` and must be one of the first migrations the Stage 3
  parser knows.

## Export per tier

- **`skill`:** Write `~/.claude/skills/<slug>/SKILL.md` (or project-scoped) — a plain skill,
  no `cwc-` prefix, no orchestrator prose, no agent `.md` files. Keep the existing ownership
  comment `<!-- cwc:workflow:<id> -->` so `conflict-detector.ts` works unchanged. Keep the
  `disable-model-invocation: true` default and the `modelInvocation: 'auto'` opt-out exactly
  as today. `export-preview` must branch on `artifactKind` in the same commit as the exporter.
- **`loop`:** Same file as `skill`. The trigger stays CWC-side (in the `.cwc` meta), arming it
  is the existing Automate flow. Managed runs already invoke `claude -p "/<slug>"`, which
  resolves a plain skill identically to an orchestrator skill — the run harness needs no
  changes for loops.
- **`workflow`:** Unchanged.
- Deployment registry (roadmap Stage 2) records `artifactKind` per deployment from day one.

## Runs

A loop-tier run uses the same managed harness as a workflow: JSONL events, Apply/Discard on
isolated results, and gates after graduation are all inherited. Launch now additionally binds
the exact verified runnable bytes into a per-run plugin; this hardening is tier-independent and
prevents deployment changes from racing a headless run. This is deliberate: the loop tier is
where CWC's run observability becomes the product's answer to "everyone runs loops in a terminal
with no dashboard."

## Graduation and demotion

- **Graduate (skill → workflow):** One-click in the editor. Sets `artifactKind: 'workflow'`,
  splits the single node's checklist into nodes via the existing fallback compiler, opens the
  canvas. The next export writes the orchestrator + agents and removes the plain skill file it
  owns (existing rename-reconciliation machinery; `exportedWorkflowSlug` already covers the
  old path).
- **Demote (workflow → skill):** Offered only when the graph is a single non-gate node with no
  edges. Otherwise hidden — never collapse a real graph automatically.
- Both directions are explicit user actions with an export-preview diff before files change.

## UI

- **Detect:** Each automation card shows the predicted tier as a badge (Rule / Skill / Loop /
  Workflow). Promotion dialog: "Generate as: <predicted> (recommended)" with the other tiers
  selectable. Rule cards replace "Promote" with "Add rule…" (target file picker: user
  CLAUDE.md vs project AGENTS.md).
- **Editor:** `artifactKind: 'skill'` opens a focused single-artifact editor (name,
  description, body, trigger panel) — not the canvas. "Open as workflow" is the graduation
  action. Reuse existing form components; no new visual language (per DESIGN.md, no palette or
  layout changes).
- **Home:** Workflow list shows the kind badge; filters treat skills and workflows uniformly.

## Delivery stages

Each stage ships behind its own tests, then typecheck + full suite + build.

- **A — Classifier + skill tier (the core fix):** `AutomationShape` derivation, classifier,
  `artifactKind` schema bump, skill-tier generation reusing `skill-generator.ts`, skill-tier
  export + export-preview, promotion-dialog tier choice, minimal skill editor. Workflow tier
  untouched.
- **B — Loop tier:** trigger prefill (disarmed), verification stop-condition in generated
  skill body, loop badge in Runs/Automate surfaces.
- **C — Rule tier:** suggestion rendering + explicit append/remove with `cwc:rule` markers.
- **D — Graduation/demotion** and registry `artifactKind` integration (can merge into Stage 2
  registry work if that lands first).

## Testing

- Classifier: pure-function table tests — one fixture per decision row, plus adversarial
  fixtures (risky-step-last, verify-only automation, prompt-only repetition, borderline
  two-archetype linear flow must stay `skill`).
- Shape derivation: real transcript fixtures through the existing scan pipeline in temp dirs.
- Skill-tier generation: fake Claude runner (existing `tests/helpers/make-bin.ts` pattern),
  including malformed-output fallback to the deterministic checklist skill.
- Export: temp-dir round-trip proving a skill-tier export writes exactly one file, ownership
  comment intact, `export-preview` byte-identical to the real write; graduation removes the
  owned skill file and writes the orchestrator set.
- Back-compat: pre-`shape` automation classifies as `workflow`; pre-`artifactKind` `.cwc`
  loads, edits, and exports unchanged.

## Success measures

- ≥ half of promoted detections in dogfooding classify below `workflow` (if not, the
  classifier thresholds are wrong — revisit before shipping wide).
- A skill-tier promotion produces one file the user can read in one screen and run as
  `/<slug>` immediately.
- Zero silent tier escalation: no code path turns a classified skill into a workflow without
  a user action.
- Loop-tier artifacts run through the managed harness with unchanged manifest/Apply/Discard
  guarantees.

## Non-goals

- No dynamic-workflow-script export (future tier of `workflow`).
- No Codex/ChatGPT anything (history wise) (later roadmap stages).
- No automatic edits to CLAUDE.md/AGENTS.md; rule application is always an explicit action.
- No auto-arming of generated triggers.
- No new visual design language; the skill editor composes existing components.
- No provider-neutral runtime. Claude Code remains the deployment target and runtime.
