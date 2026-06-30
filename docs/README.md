# docs/

Design specs and implementation plans for non-trivial changes to Claude Workflow Composer.

These are the durable artifacts of how features get built here:

1. **Brainstorm → spec.** A feature starts as a structured design conversation that resolves the
   open questions (scope, trade-offs, safety) before any code. The agreed design is written to
   `specs/YYYY-MM-DD-<topic>-design.md`.
2. **Spec → plan.** The approved spec becomes a task-by-task implementation plan in
   `plans/YYYY-MM-DD-<topic>-plan.md` — bite-sized, test-first steps with exact files and code.
3. **Plan → implementation.** The plan is executed (TDD, real-filesystem tests, frequent commits).
4. **Review & polish.** The diff is reviewed for correctness, then UI/UX is patched against
   `DESIGN.md`.

## Layout

- `specs/` — what we're building and why (the design, locked before implementation).
- `plans/` — how we'll build it (the step-by-step execution plan).

Each spec has a matching plan with the same date and topic. Older entries are kept as a record of
the decisions behind shipped features, not as live documentation — for current behavior, read the
source and `AGENTS.md`.
