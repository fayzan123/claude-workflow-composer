# Open issues — ranked by importance

## ~~1. Conditional branches silently rendered as parallel execution~~ ✓ Fixed
Added `dispatchMode?: 'parallel' | 'conditional'` to `CwcNode` (`schema.ts`). NodePanel exposes a Dispatch Mode dropdown. `prose-generator.ts` now emits "evaluate the result and invoke exactly one of the following branches" for conditional nodes vs. the parallel fan-out prose. Default remains parallel (no behaviour change for existing workflows).

## ~~2. No undo/redo + destructive delete on autosave~~ ✓ Fixed
`useWorkflow.ts` now wraps the reducer in a past/present/future history stack with `UNDO`/`REDO` actions; rapid text edits to the same field coalesce into one undo step. Canvas handles ⌘Z / ⇧⌘Z (ignored while typing in inputs), and TopBar has Undo/Redo buttons gated on `canUndo`/`canRedo`. Delete is now reversible. Covered by `tests/client/history.test.ts`.

## ~~3. Workflow description is never editable and ships empty~~ ✓ Fixed
`TopBar.tsx` now has a `top-bar__desc-input` field bound to `meta.description` via `SET_META`, so exported orchestrator skills get a real `description:` frontmatter.

## 4. No orchestrator preview
The BFS prose is the actual product, but you only see it buried in the export modal's file preview. A live "Orchestrator preview" panel would build trust immediately.

## ~~5. Skill entry has no autocomplete~~ ✓ Fixed
`NodePanel.tsx` now fetches installed skills via `api.skills()` and shows a filtered suggestion dropdown as you type. Picking a suggestion inserts its `namespacedSlug`; free-text entry still works for skills that aren't installed yet.

## ~~6. No templates~~ ✓ Fixed
`TemplatePicker.tsx` renders a Starter Templates grid from `client/src/templates/` alongside the Blank Canvas button.

## 7. `tools`/`skills` overrides on reference nodes are misleading
The override annotation (`prose-generator.ts:48`) tells the orchestrator a ref node has "tools (X)", but the Agent tool can't grant a subagent tools its `.md` file doesn't declare — tool scope comes from the agent file. `model` override is real; `systemPrompt` is appendable; but `tools` and `skills` overrides on refs are aspirational prose the runtime can't enforce. Worth either removing or relabeling honestly.
