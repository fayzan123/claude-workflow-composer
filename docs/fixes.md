# Open issues — ranked by importance

## 1. Conditional branches silently rendered as parallel execution
`prose-generator.ts:105` — any node with >1 forward edge becomes "invoke X and Y in parallel". But each edge already carries a trigger (e.g. "if tests fail" vs "if tests pass"). A router/conditional pattern — arguably the most common multi-agent shape — gets exported as "always run both at once," which is wrong. The data model has no notion of parallel fan-out vs conditional branch, so the orchestrator can't distinguish them. This undercuts the core value prop.

## 2. No undo/redo + destructive delete on autosave
Delete/Backspace removes a node instantly (`Canvas.tsx:107`), autosaved 500ms later, with no undo. For a visual editor this is a serious safety/UX hole.

## 3. Workflow description is never editable and ships empty
`TemplatePicker.tsx:99` creates workflows with `description: ''`. `TopBar` only edits `meta.name`. There is no field anywhere in the editor for `meta.description` — yet `exportWorkflow` writes it as the orchestrator skill's `description:` frontmatter. Every exported skill therefore has a blank description.

## 4. No orchestrator preview
The BFS prose is the actual product, but you only see it buried in the export modal's file preview. A live "Orchestrator preview" panel would build trust and catch the parallel-vs-conditional problem (#1) immediately.

## 5. Skill entry has no autocomplete
`NodePanel.tsx:56` — skill entry is raw free-text with no autocomplete against installed skills. Typos only surface as export warnings, despite the Sidebar already having the full installed-skills list.

## 6. No templates
The README sells "discover what good pipelines look like" and a "community library," but the New tab has only a Blank Canvas button. Bundling 3–4 real starter `.cwc` files (review→fix→verify, plan→implement→test, research→summarize) would do more for adoption than any other single change.

## 7. `tools`/`skills` overrides on reference nodes are misleading
The override annotation (`prose-generator.ts:48`) tells the orchestrator a ref node has "tools (X)", but the Agent tool can't grant a subagent tools its `.md` file doesn't declare — tool scope comes from the agent file. `model` override is real; `systemPrompt` is appendable; but `tools` and `skills` overrides on refs are aspirational prose the runtime can't enforce. Worth either removing or relabeling honestly.
