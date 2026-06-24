# Per-Workflow Model-Invocation Opt-In

**Date:** 2026-06-24
**Status:** Approved — ready for implementation plan

## Problem

Every exported CWC workflow `SKILL.md` is hard-coded with `disable-model-invocation: true`
(`src/file-writer.ts`, `buildWorkflowSkillContent`). This means Claude Code will never
autonomously discover or invoke these skills — they run only via explicit slash command, the cron
scheduler, inbound webhooks, or a Test Run.

That default is correct for safety: a workflow orchestrator is heavyweight and side-effectful
(spawns subagents, makes git commits, POSTs run-logging events, has approval gates that end the
turn). The run-lifecycle safety — git worktree isolation, base-SHA resolution, run IDs, SIGTERM
handling — lives **outside** the skill, in `src/server/run-launcher.ts` and `workflow-runner.ts`.
The `SKILL.md` is just the recipe; the launcher is the kitchen. If Claude auto-invoked an
orchestrator in an ordinary interactive session, it would fire the whole pipeline in the user's
**real** working directory with no isolation and no run tracking.

We want model-invocability to be a per-workflow choice the user controls, defaulting to **off**
(current safe behavior).

## Decisions (locked)

1. **No gating.** Opt-in is allowed for any workflow, not just those with an approval gate. Gating
   to gate-having workflows would imply a protection that does not exist: side effects (commits,
   file writes, subagent spawns) land *before* the gate, and the gate itself depends on the run
   harness (the `awaiting_approval` event + inbox + resumable `run_paused`) to actually halt — none
   of which exists in a plain interactive session. Instead: fully the user's call, with an honest
   warning in the UI.

2. **Two states this pass, enum-shaped for the future.** Ship `off` / `auto` now. Model the flag as
   a string enum so a future `recommend` mode (a thin "announcer" skill that surfaces the workflow
   and hands off to the explicit slash command instead of executing it) can be added with no
   migration. The recommender and any gating rule are **out of scope** this pass.

3. **Default OFF.** Absent flag = `off` = `disable-model-invocation: true` stays. The promotional
   value of "Claude surfaces a workflow automatically" is discoverability, which the future
   `recommend` mode provides safely; default-ON `auto` would instead fire uncontrolled,
   un-isolated execution in users' real repos and is the exact danger this feature exists to
   contain. Opting into auto-invocation is a deliberate, per-workflow action.

## Architecture

Mirrors the existing `observability?: { enabled: boolean }` precedent end-to-end (absent = safe
default; toggled in the export modal via `SET_META`; resolved at both export call sites).

### Schema — `src/schema.ts` (`CwcMeta`)

```ts
modelInvocation?: 'off' | 'auto'   // absent = 'off'
```

- `'off'` (or absent) → exported `SKILL.md` emits `disable-model-invocation: true` (today's behavior).
- `'auto'` → that line is omitted, so Claude Code can discover and invoke the workflow autonomously.

### Frontmatter generation — `src/file-writer.ts` (`buildWorkflowSkillContent`)

Add a resolved-boolean parameter `allowModelInvocation: boolean` (keeps the writer dumb — the enum
→ boolean resolution happens at the call sites). Behavior:

- `false` → frontmatter includes `disable-model-invocation: true` (unchanged from today).
- `true` → that line is omitted entirely; no other frontmatter changes.

Signature becomes:
`buildWorkflowSkillContent(name, description, orchestratorBody, workflowId, allowModelInvocation)`.

### Call sites (preview must match real export)

- `src/exporter.ts` (~line 182): `const allowModelInvocation = cwc.meta.modelInvocation === 'auto'`,
  passed into `buildWorkflowSkillContent`.
- `src/server/api/export-preview.ts` (~line 71): same resolution from `cwcFile.meta.modelInvocation`.

### Client UI — `client/src/components/ExportFlow.tsx`

A checkbox directly below the existing observability toggle, default **unchecked** (= `'off'`):

- `checked={workflow.meta.modelInvocation === 'auto'}`
- `onChange` → `dispatch({ type: 'SET_META', payload: { modelInvocation: e.target.checked ? 'auto' : 'off' } })`

`SET_META` already shallow-merges into `meta` and persists via `useAutoSave` — no reducer or
hook changes required.

**Copy** must be honest about the trade-off: enabling it lets Claude run the full pipeline in your
real working directory **without** the isolated-run harness — no worktree, no run tracking, no
SIGTERM control. Helper text uses the warning semantic hue defined in `DESIGN.md`
(`warning oklch(0.72 0.16 85)`), consistent with the gate/amber language. Add a matching
`FieldHint` entry in `client/src/lib/help-copy.ts`. `DESIGN.md` is consulted before finalizing the
visual treatment; the toggle reuses the existing `export-flow__obs-toggle` structure with a
distinct warning-toned note.

## Migration

Existing `.cwc` files and already-exported `SKILL.md`s have no `modelInvocation` → treated as
`'off'` → `disable-model-invocation: true` stays → **safe by default, no action required**. Opting
a workflow in requires a re-export to regenerate its `SKILL.md`. This is documented in the project
memory note on release.

## Testing (TDD, real temp filesystems, no mocks)

- **`file-writer`**: `buildWorkflowSkillContent(..., false)` → output contains
  `disable-model-invocation: true`; `buildWorkflowSkillContent(..., true)` → output does **not**
  contain that line.
- **`exporter`**: export a workflow with `meta.modelInvocation: 'auto'` → written `SKILL.md` omits
  the line; with the flag absent and with `'off'` → the line is present.

## Out of scope

- The `recommend` / announcer mode (deferred; schema is shaped to add it without migration).
- Any gating rule tying opt-in to the presence of an approval gate.
