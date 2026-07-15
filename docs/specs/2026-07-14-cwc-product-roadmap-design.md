# CWC Product Roadmap Design

**Date:** 2026-07-14
**Status:** Direction approved; each major stage still requires its own focused design review
**Scope:** Product and architecture priorities after the July reliability pass

## Product Direction

Claude Workflow Composer remains a local-first tool for finding repeated development work,
composing it into a graph, and exporting that graph as Claude Code agents and a workflow skill.
The near-term goal is not to become a generic agent platform. It is to make the existing loop
trustworthy and complete:

1. detect repeated work;
2. generate and edit a workflow;
3. export it to Claude Code;
4. run it in isolation;
5. review the result; and
6. deliberately apply or discard that result.

Codex and ChatGPT are useful inputs to that loop, but they are separate concerns. Adding Codex
history does not imply a Codex workflow runtime. Adding a Codex analysis backend does not change
where CWC exports workflows. Through every committed stage in this roadmap, generated workflows
still target Claude Code and CWC-managed runs still invoke the Claude Code CLI.

## Baseline After P0

The July reliability work establishes the baseline this roadmap builds on:

- History scans remain reachable from Home, survive navigation, recover interrupted state, and
  hand a generated workflow back to the composer.
- Detection rejects weak or invented evidence, generation requires exact observed-step coverage,
  and risky first phases receive a read-only preflight before an approval gate.
- Workflow creation uses collision-safe exclusive writes, including concurrent same-name creates.
- Isolated runs checkpoint dirty tracked and untracked work before removing a worktree; a failed
  checkpoint retains the worktree instead of discarding the result.
- Trigger arming covers execution-sensitive fields, cron and webhook firing share multi-target
  fan-out, concurrent state writes are serialized, and partial webhook success is reported honestly.
- A workflow is claimed before preconditions, worktree creation, or setup begins; targets from one
  trigger delivery share that claim without admitting an unrelated concurrent launch.
- Token-exempt external run events cannot forge server-owned run metadata or authorize privileged
  diff, approval, rejection, or cleanup actions; per-run serialization closes admission after a
  managed terminal event.
- Active and paused runs block workflow deletion, deletion reserves the workflow against a racing
  launch, and project paths accept Windows drive and UNC forms as well as POSIX paths.

These safeguards reduce immediate data-loss risk. They do not yet provide a durable server-owned
record of a managed run, a way to apply a completed isolated result, or a complete record of where
a workflow has been exported. Those are the next two priorities.

## Architectural Boundaries

CWC will model four independent axes:

| Axis | Current default | Roadmap change |
|------|-----------------|----------------|
| History source | Local Claude Code transcripts | Add Codex history, then explicit ChatGPT export import |
| Analysis/planning backend | Claude Code CLI | Optionally add a Codex CLI backend after source support |
| Deployment target | Claude Code user/project agents and skills | Add a registry; do not add a new target |
| Workflow runtime | Claude Code CLI, optionally through CWC isolation | No change in this roadmap |

Provider names must not become a proxy for another axis. A scan request selects a history source
and an analysis backend independently. A `.cwc` file remains provider-neutral graph data, while
export and run screens state that its concrete deployment/runtime is Claude Code.

## Stage 1: Apply Or Discard Isolated Results

### Problem

Run JSONL events currently serve both as a timeline and as the closest thing to run authority.
They are appropriate for append-only observation but are not a sufficient authorization record
for Git mutations. A completed isolated run keeps a result branch, yet Runs only shows its diff;
the user must leave CWC and manually locate and integrate the branch.

### Server-owned run manifest

Every CWC-managed run gets an atomically written manifest beside its event log under
`~/.cwc/runs/<workflowId>/`. The manifest is server-owned and is never accepted through
`POST /api/runs/events`. It records, at minimum:

- run, workflow, workflow-skill, and trigger identity;
- managed source and lifecycle state;
- requested isolation mode and original cwd;
- repository identity, base ref, and resolved base SHA;
- worktree path and CWC-created branch when isolated;
- preserved result SHA after checkpointing;
- result disposition: `unavailable`, `ready`, `applying`, `applied`, or `discarded`;
- creation and last-transition timestamps.

Manifest writes use temp-file plus rename and serialize transitions per run. JSONL remains the
user-visible timeline; the manifest becomes the authority for diff, approve/reject, cleanup,
Apply, and Discard. Legacy event-only runs remain readable but do not gain privileged actions.

### Apply

Apply is offered only for a terminal, successful, CWC-managed isolated run with a preserved
result SHA and `ready` disposition. Before mutation the server verifies all of the following:

- the recorded repository and destination still resolve to the same Git repository;
- the destination worktree has no staged, unstaged, or untracked changes;
- destination `HEAD` still equals the manifest's base SHA;
- the result SHA still exists, is the head of the recorded CWC branch, and descends from base SHA;
- no run disposition transition is already in progress.

The server then fast-forwards the destination with Git's `--ff-only` behavior. It does not merge,
rebase, cherry-pick, stash, reset, or resolve conflicts. On success it records the applied SHA and
may remove the now-redundant CWC branch. A failed preflight makes no repository change and returns
an actionable reason.

### Discard

Discard is offered for a terminal managed isolated result that is still `ready`. After explicit
confirmation, the server re-verifies the recorded branch and result SHA, deletes only that
CWC-owned branch, and records `discarded`. Discard never removes the user's destination checkout
or any foreign ref. Rejection of a paused approval gate remains its existing action and is not
renamed to Discard.

### UX

Runs keeps the current timeline and diff. A completed isolated run adds a compact result action
area with Apply and Discard, preflight failure text, and the final disposition. Actions disable
while a transition is pending and refresh from server state after completion or restart.

## Stage 2: Deployment Registry

### Problem

`meta.exportedWorkflowSlug` supports rename reconciliation for one slug, while the Home deployed
view discovers only user-scoped skills. A workflow can be exported to user scope and several
projects, but CWC has no authoritative inventory of those deployments. This weakens delete,
rename, trigger validation, and user confidence.

### Registry design

CWC adds an atomic registry under `~/.cwc/` with one entry per workflow and export target. Each
entry records:

- a stable deployment id and workflow id;
- target scope (`user` or `project`) and normalized target root;
- workflow skill slug;
- owned agent and skill paths written by the export;
- export time and a content/ownership fingerprint sufficient for reconciliation;
- state for a missing, stale, or present deployment.

The registry is an index, not permission to overwrite or delete files. Existing ownership
comments and conflict detection remain the final filesystem authority. Registry updates occur
only after a successful export, and deletion removes an entry only after owned-file cleanup
succeeds or records a recoverable stale state.

Home's Deployed view becomes workflow-aware and shows every known user/project deployment.
Test-run and trigger preflight can consult the registry for useful errors, but must still verify
the actual `SKILL.md` on disk immediately before execution.

Existing user-scoped exports can be discovered from ownership markers during migration. Existing
project exports cannot be globally searched safely; they enter the registry on the next export or
when the user selects that project.

## Stage 3: Canonical `.cwc` Parsing, Import, Duplicate, And Share

### Problem

`CwcFile` is currently a compile-time TypeScript interface. Several filesystem and HTTP
boundaries use `JSON.parse(... as CwcFile)`, while generation has separate partial validation.
That is not a safe basis for importing files, migrations, or sharing workflows.

### Canonical parser

A pure core module becomes the only untrusted `.cwc` ingress. It:

- checks object shape, supported `meta.version`, sizes, and primitive limits;
- validates unique workflow/node/edge/trigger ids and graph references;
- validates terminal edges, gate constraints, artifacts, paths, trigger enums, and numeric bounds;
- runs sequential, deterministic migrations for older supported versions;
- rejects future versions without rewriting them;
- returns structured field errors and a normalized `CwcFile`;
- never reads the filesystem, executes commands, or silently enables automation.

Server workflow reads, creation, saves, export requests, scheduler scans, trigger lookup, and
generated JSON adopt this parser. Composer validation remains responsible for authoring quality
warnings; it does not replace structural parsing.

### Import and duplicate

Import accepts explicit local JSON content, parses it, and creates a new collision-safe managed
workflow without modifying the source file. Duplicate uses the same pure cloning transform. Both:

- assign a new workflow id and fresh timestamps;
- clear deployment identity and exported node slugs;
- regenerate node, edge, and trigger ids where necessary;
- disable every trigger and remove webhook tokens;
- preserve graph intent and non-secret trigger configuration;
- never copy run history or deployment-registry entries.

### Portable share

A portable export applies the same safety transform before download: no local deployment identity,
no webhook token, no enabled automation, and no run data. Importing the result is therefore no
more privileged than duplicating a local workflow. Arbitrary bundles, executable installers, and
automatic installation of referenced skills or agents are out of scope.

## Stage 4: Codex As A History Source

Detection first extracts a `HistorySource` contract that yields normalized `TaskUnit` records and
source-specific diagnostics. Existing Claude transcript discovery/parsing becomes the first
adapter with golden tests proving no detection regression.

The Codex adapter uses the supported local Codex App Server history interface (`thread/list` and
`thread/read`) rather than reading undocumented rollout files. It maps user turns, cwd/repository
context, timestamps, tool calls, and commands into the same bounded `TaskUnit` representation.
Source provenance is carried into diagnostics and evidence so a result can explain where its
examples came from.

The scan screen gains an explicit history-source choice and availability state. Claude Code
history remains the default. Source collection stays local, applies the same truncation/redaction
limits, and never uploads raw transcripts beyond the locally invoked analysis backend.

This stage does **not** change generation, export, or workflow execution: a workflow detected from
Codex history is still composed for and run by Claude Code.

## Stage 5: Optional Codex Analysis And Planning Backend

After Codex history works independently, CWC extracts a `ModelBackend` contract for bounded text
generation, structured result parsing, streaming progress, cancellation, model selection, and
diagnostics. The existing Claude Code runners become the default adapter. A Codex CLI adapter uses
its supported non-interactive JSON interface.

Backend selection is explicit and persisted as a local preference. Availability checks and model
choices are backend-specific. Detection source and model backend remain independently selectable;
for example, a user may analyze Codex history with Claude or Claude history with Codex.

Compiler validation and deterministic fallback remain backend-independent. A backend can propose
a plan, but cannot relax exact evidence coverage, risk gates, `.cwc` parsing, export ownership, or
run isolation.

This is an analysis/planning option only. It does not add Codex agents, Codex skills, or a Codex
workflow runner.

## Stage 6: ChatGPT Explicit Local Export

ChatGPT history enters CWC only through a user-selected local data export. The first supported
form is the extracted `conversations.json`; archive ingestion follows only with a reviewed parser
and strict entry-count, expanded-size, nesting, traversal, and timeout limits.

The adapter extracts bounded user/assistant turn sequences into `TaskUnit` records and reports
what was skipped. It does not scrape chatgpt.com, reuse browser cookies, call private endpoints,
or claim that conversational evidence contains tool/command detail it does not have. Lower-fidelity
evidence must be labeled and may require a higher repetition threshold before promotion.

## Follow-on Backlog

After the committed stages, prioritize based on observed usage:

- Scan filters for source, repository, and date; fair per-repository digest budgets; reproducible
  scan metadata; and limited-history controls.
- Run indexes, retention controls, provenance, duration/cost budgets, and clearer stale recovery.
- Composer ergonomics such as auto-layout, duplicate node, copy/paste, and multi-select while
  preserving the current canvas visual language.
- A browser smoke harness for Home -> Scan -> Home -> Scan, generation handoff, same-name create,
  export, and fake Test Run flows.

A non-Claude deployment target or workflow runtime requires a separate capability-matrix design
based on concrete demand. It is not implied by Codex or ChatGPT input support and is not scheduled
by this roadmap.

## Cross-cutting Requirements

- Preserve packaged-mode auth, loopback binding, CORS restrictions, and token checks.
- Treat filesystem paths, Git refs, imported JSON, provider output, and event payloads as
  untrusted input.
- Keep filesystem writes atomic and ownership-checked; use real temporary repositories in tests.
- Provide dependency injection through `createApp()` for stores, runners, and provider adapters.
- Keep output deterministic where practical and run the Windows/macOS/Linux-sensitive path suite.
- Ship each stage behind focused acceptance tests, then run typecheck, the full test suite, and
  production build before moving to the next stage.

## Success Measures

- A user can inspect an isolated result and apply or discard it without leaving CWC or risking
  unrelated repository work.
- CWC can answer where every newly exported workflow is deployed and reconcile those files safely.
- Every `.cwc` ingress follows one versioned parser, and import/duplicate never arms automation or
  inherits deployment identity.
- Codex history can produce grounded candidates without changing Claude Code export/runtime.
- A selected analysis backend can fail or return malformed output without bypassing deterministic
  validation and fallback behavior.
- ChatGPT support operates only on explicit local exports and accurately labels evidence limits.

## Non-goals

- A generic multi-provider workflow runtime.
- Exporting Codex-native agents, plugins, or skills in these stages.
- ChatGPT account access, scraping, or background synchronization.
- Automatic merge conflict resolution, stashing, rebasing, or applying onto a moved/dirty checkout.
- Cloud accounts, hosted workflow storage, marketplace distribution, or collaboration.
- Broad visual redesign of the composer.
