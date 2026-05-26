# Workflow Lifecycle Improvements — Design Spec

*Date: 2026-05-26*
*Status: Approved for implementation*

---

## Overview

This spec covers 10 targeted improvements to how workflows are created, saved, listed, renamed, and deleted. No architectural changes — each item is localized and independently shippable. Items are grouped by layer (server, client, UI).

---

## Item 1: Surface auto-save errors

**Problem:** `useAutoSave` accepts an `onError` callback but `App.tsx` never passes one. Failed saves produce zero feedback.

**Design:**
- Add `saveError: Error | null` state to `App.tsx`.
- Pass `(err) => setSaveError(err)` as the `onError` argument to `useAutoSave`.
- Add an `onSuccess` callback to `useAutoSave`. To avoid `onSuccess` exceptions being swallowed into `onError`, use a success-flag pattern:
  ```ts
  let succeeded = false
  try {
    await api.workflows.save(...)
    succeeded = true
  } catch (err) {
    onErrorRef.current?.(err as Error)
  } finally {
    setIsSaving(false)
    setHasPendingTimer(false)
  }
  if (succeeded) onSuccessRef.current?.()
  ```
  Store `onSuccess` in a ref (`onSuccessRef`) for the same reason `onError` is stored in `onErrorRef` (avoids stale closure, keeps it out of effect deps).
- `flush()` (see Item 8) must also use this pattern so it calls `onSuccess` correctly.
- `App.tsx` passes `() => setSaveError(null)` as `onSuccess`, clearing the error on the next successful save.
- In `TopBar`, replace the plain "Saved" indicator with a red "Save failed" state when `saveError` is set. Clicking it dismisses it; the next successful save also clears it automatically.
- No modal, no toast library — inline badge state only.

---

## Item 2: Fix `projectDir` for project export

**Problem:** `App.tsx` derives `projectDir` from the `.cwc` file path, which is always inside `~/.cwc/workflows/`. "Export to Project" therefore writes to `~/.cwc/workflows/.claude/` — completely wrong.

**Design:**
- Remove the `projectDir` prop derivation from `App.tsx` and stop passing it to `ExportFlow`.
- In `ExportFlow`, add component state: `const [projectDir, setProjectDir] = useState(() => localStorage.getItem('cwc:lastProjectDir') ?? '')`. This single state variable is used for both the export text input and the delete-target Project button.
- When the user selects "Project" export, show a text input bound to `projectDir` / `setProjectDir`. Validate that the value is non-empty and starts with `/` before enabling the preview step.
- On successful preview (entering the `confirming` step), write `localStorage.setItem('cwc:lastProjectDir', projectDir)` so repeat exports don't require re-typing.
- The delete-target Project button uses the same `projectDir` state. If `projectDir` is empty, the button is disabled with tooltip "Export to a project directory first".

**`Sidebar` / `MyAgentsTab`:** `Sidebar` also receives `projectDir` from `App.tsx` and forwards it to `MyAgentsTab` to load project-specific agents from `<projectDir>/.claude/agents/`. This prop is currently broken for the same root-cause reason (it resolves to `~/.cwc/workflows/`). However, fixing `Sidebar`'s `projectDir` requires a different mechanism (the user specifying their working project) and is out of scope for this item. For now: **stop passing `projectDir` to `Sidebar` from `App.tsx`**. `MyAgentsTab` will fall back to user-level agents only (`api.agents()` with no argument), which is correct and honest behavior. The project-agents feature is deferred to Approach C.

---

## Item 3 + 4 + 5: Full workflow list (replacing recents as primary source)

**Note on Items 3, 4, 5:** These three items overlap and are resolved together. Item 3 (enrich recents endpoint) and Item 4 (stale cleanup) become moot once Item 5 switches the home screen to `GET /api/workflows/list`. Implementing Item 3's recents enrichment separately would produce dead code. The plan is: implement Item 5 (switch to `workflows/list`) and let it subsume 3 and 4.

**Problem:** The home screen shows at most 10 recently-opened workflows; names are derived from file slugs, not `meta.name`; stale recents fail silently.

**Design:**
- Switch the home screen from `GET /api/recents` to `GET /api/workflows/list` as the primary data source.
- Update `GET /api/workflows/list` to return `{ path: string; name: string; nodeCount: number; updated: string }[]` — currently returns `{ path, name, updated }`, so `nodeCount` (= `nodes.length`) must be added to the server handler.
- Update `client/src/lib/api.ts`: `workflows.list()` return type changes from `{ path: string; name: string; updated: string }[]` to `{ path: string; name: string; nodeCount: number; updated: string }[]`.
- Sort the list by `updated` descending by default. All `.cwc` files in `~/.cwc/workflows/` are included — no 10-item cap.
- The "Recent" tab label changes to "Workflows".
- `recents.json` is still maintained server-side (write on open/create/delete) for future use, but the home screen no longer reads from it. The existing `api.recents.add(path)` call in `handleOpenRecent` in `App.tsx` is kept as-is — it still writes to the recents file for future use.
- Stale files (unreadable/missing) are filtered from `workflows/list` server-side, same as the existing behavior.
- If a workflow disappears between list-load and click, the stale entry must be removed from `TemplatePicker`'s list. Change `onOpenRecent` prop type from `(path: string) => void` to `(path: string) => Promise<void>`. `TemplatePicker` wraps the call: `onOpenRecent(item.path).catch(() => { setWorkflows(ws => ws.filter(w => w.path !== item.path)); /* show inline error */ })`. In `App.tsx`, `handleOpenRecent` re-throws only when `api.workflows.read` fails (the 404 case). Errors from `api.recents.add` are swallowed and not re-thrown — those are non-critical writes that should not cause the stale-entry UI to trigger.

**`TemplatePicker` state type migration:** The component currently stores `useState<string[]>` for recents. This must change to `useState<WorkflowListItem[]>` where `WorkflowListItem = { path: string; name: string; nodeCount: number; updated: string }`. All usages must be updated:
- `recents.map((path) => ...)` → `workflows.map((item) => ...)`, using `item.path`, `item.name`, `item.nodeCount`, `item.updated`
- `handleDelete(path: string)` stays the same signature (pass `item.path`)
- Stale entry removal: `setWorkflows(ws => ws.filter(w => w.path !== path))`
- Tab badge: `workflows.length`
- `formatPath()` utility is no longer needed and can be removed
- `api.recents.list()` call is replaced by `api.workflows.list()`

---

## Item 6: Show metadata in workflow list

**Problem:** Each workflow card shows only name and directory path. Hard to distinguish similar workflows.

**Design:**
- Each card in the workflow list shows:
  - Name (from `meta.name`)
  - Updated timestamp formatted as relative time ("2 days ago", "just now") using a small inline utility — no date library dependency. Implement as a pure function `relativeTime(isoString: string): string` in `TemplatePicker.tsx` using `Date.now() - new Date(isoString).getTime()` with thresholds (< 60s → "just now", < 3600s → "X min ago", < 86400s → "X hr ago", else → "X days ago").
  - Node count ("3 agents")
- Directory path is shown as a secondary line (kept from current design, already truncated with `~`).

---

## Item 7: Delete confirmation

**Problem:** Clicking the trash icon immediately deletes the workflow file and its exports. No confirmation, no undo.

**Design:**
- Add a `deletingPath: string | null` state to `TemplatePicker`.
- First trash click sets `deletingPath` to that workflow's path. The card enters a "confirming" state showing two buttons: "Confirm delete" (destructive) and "Cancel".
- Pressing Escape or clicking elsewhere resets `deletingPath` to null. Use the same `useEffect` + `document.addEventListener('keydown', ...)` + `document.addEventListener('mousedown', ...)` pattern already used in `TopBar` for the errors/warnings popovers. The effect depends on `!!deletingPath` so it only attaches when a confirmation is pending.
- Actual delete only fires on "Confirm delete".
- No modal overlay — inline card state only, same pattern as GitHub's inline confirmations.

---

## Item 8: Rename with file rename

**Problem:** Editing the workflow name in TopBar updates `meta.name` but the `.cwc` file path never changes.

**Design:**

**New server endpoint:** `POST /api/workflows/rename`
- Body: `{ oldPath: string; newName: string }`
- Computes `newSlug = slugify(newName)`, derives `newPath` in the same directory as `oldPath`.
- If `newPath === oldPath` (slug unchanged), returns `{ path: oldPath, renamed: false }` — no-op.
- If `newPath` already exists, returns `400 { error: 'A workflow with that name already exists' }`.
- Otherwise: reads old file, updates `meta.name` in content, writes to `newPath`, deletes `oldPath`, updates `recents.json` (replace old path with new path).
- Returns `{ path: newPath, renamed: true }`.

**Client changes:**
- `TopBar` continues to dispatch `SET_META` on every keystroke (unchanged). This keeps `meta.name` live in the `.cwc` content and auto-saves the new name to the file. `onRename` fires additionally on `onBlur`/Enter to also rename the file itself.
- `TopBar` receives `onRename: (newName: string) => void`. On name input `onBlur` (and Enter key), `TopBar` always calls `onRename(currentName.trim())`. Do not attempt to compare against "last persisted name" — the server returns `{ renamed: false }` as a no-op when the slug is unchanged, and a network round-trip on every blur is cheap. This avoids needing to track a baseline in the client.
- `App.tsx` implements `onRename`: flushes the pending save, calls the rename API, updates `workflowPath`.
- On `renamed: false` (slug unchanged): nothing to do — the flush already saved the updated name.
- On rename error: `App.tsx` sets a `renameError` string that is passed to `TopBar` as a prop and displayed inline.

**Race condition between auto-save and rename — requires Item 9 to be implemented first:**
Item 9 changes the cleanup effect to stop resetting `isSaving`/`hasPendingTimer`. Item 8's `flush()` depends on that cleanup change being in place, otherwise the cleanup effect triggered by the `SET_META` dispatch (which changes `workflow`, re-running the effect) will reset `isSaving` to `false` mid-flush. Implement Item 9 before Item 8.

- Add a `flush(): Promise<void>` function to `useAutoSave`'s return value. `flush` cancels any pending timer, immediately `await`s `api.workflows.save(filePath, workflow)`, calls `onSuccess` on success, calls `onError` on failure, clears `hasPendingTimer` and `isSaving` in `finally`.
- **`flush` must be a stable function reference** (memoized with `useCallback(fn, [])`) so `App.tsx` can call it in an async handler without re-creating it on every render.
- **`flush` must read `filePath` and `workflow` via refs**, not closure values, to avoid stale captures. Add `workflowRef` and `filePathRef` that are kept in sync with the latest props in a `useEffect` (same pattern as `onErrorRef`):
  ```ts
  const workflowRef = useRef(workflow)
  const filePathRef = useRef(filePath)
  useEffect(() => { workflowRef.current = workflow; filePathRef.current = filePath })
  ```
- **Updated `useAutoSave` return type:** `{ isSaving: boolean; isDirty: boolean; flush: () => Promise<void> }`
- `App.tsx` implements `onRename(newName: string)` as:
  1. `await flush()`
  2. `const result = await api.workflows.rename(workflowPath, newName)`
  3. If `result.renamed`: `setWorkflowPath(result.path)`
  4. If error: set rename error state for TopBar to display.

**Post-rename and delete export:** After removing the `projectDir` prop from `App.tsx` (Item 2), `ExportFlow` uses `localStorage` key `cwc:lastProjectDir` for both the export and delete-project flows. The `delete-target` step also reads this value. If `lastProjectDir` is set, the Project delete button shows the stored path and is enabled. If `lastProjectDir` is empty, the Project button is disabled with tooltip "Export to a project directory first". This means a user who has never exported to a project in this browser cannot delete a project export from the UI in this session — they would need to export first. This is an acceptable limitation for now.

**`useAutoSave` after rename:** After `setWorkflowPath(newPath)`, the hook receives the new `filePath` on the next render and saves to the correct new path. No special handling needed beyond the flush described above.

---

## Item 9: Unsaved changes guard

**Problem:** Clicking home while a save is pending can silently discard changes.

**Design:**
- Add `isDirty: boolean` to `useAutoSave`'s return value.
- Currently `setIsSaving(true)` fires immediately when a change is detected — before the 500ms debounce fires. Move `setIsSaving(true)` to inside the `setTimeout` callback so it only becomes `true` when the save is actually in-flight. This makes `isSaving` mean "save is in flight" (not "change detected").
- Add a new `hasPendingTimer` boolean state (initial value: `false`): set to `true` when the debounce timer is scheduled, set to `false` in the `finally` block of the save (not in the cleanup effect). Do not reset it in the cleanup effect — the cleanup fires on every keystroke (because `workflow` changes each time), and resetting there causes `isDirty` to flicker to `false` between keystrokes. Only `finally` clears it.
- `isDirty = hasPendingTimer || isSaving`.
- The cleanup effect should only call `clearTimeout(timerRef.current)` — it should NOT call `setIsSaving(false)` or `setHasPendingTimer(false)`. Those are cleared in `finally` only.
- On unmount: the cleanup fires and cancels the pending timer, but if a save is in-flight `finally` never runs on the unmounted component — `hasPendingTimer` and `isSaving` are left true in abandoned state. This is harmless because React discards the state with the component. No special handling needed.
- In `App.tsx`, the `onHome` handler checks `isDirty` (which already includes `isSaving`). If true, shows an inline confirmation in the TopBar: "Changes still saving — leave anyway?" with "Leave" and "Stay" buttons. Do not check `isSaving || isDirty` — that double-counts `isSaving`; just check `isDirty`.
- "Leave" navigates home. Any pending timer is cancelled (via the effect cleanup that runs on unmount). Any in-flight `fetch` completes in the background but its result is ignored — the component is gone. No `AbortController` needed; the worst case is a completed write to a file the user navigated away from, which is harmless.
- "Stay" dismisses the confirmation, auto-save continues.
- Implemented as a small `showLeaveConfirm` boolean state in `App.tsx` — no library needed.

---

## Item 10: Fix slugification inconsistency

**Problem:** `GET /api/workflows/default-path` has inline slug logic (`name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)`) instead of using the shared `slugify()` from `src/slugify.ts`.

**Design:**
- Import `slugify` in `src/server/api/workflows.ts`.
- Replace the inline regex with `slugify(name) || 'untitled'`. Do not add `.slice(0, 64)` — `slugify.ts` already applies that limit internally.
- **Note on behavioral difference:** The two implementations differ for names containing punctuation other than spaces and underscores. The inline regex converts any non-alphanumeric character to `-` (e.g. `"foo.bar"` → `"foo-bar"`), while `slugify.ts` removes non-alphanumeric, non-hyphen characters without inserting a separator (e.g. `"foo.bar"` → `"foobar"`). After this change, `default-path` will use `slugify.ts` behavior. This affects only edge-case names with dots or special chars — `slugify.ts` is the correct source of truth since it's what the export uses.

---

## Data flow summary

```
Home screen
  └─ GET /api/workflows/list  →  [{ path, name, nodeCount, updated }]
       (replaces GET /api/recents as primary source)

Rename
  └─ TopBar blur/Enter
       └─ POST /api/workflows/rename  →  { path, renamed }
            └─ App updates workflowPath state

Export (project target)
  └─ User types absolute path in ExportFlow
       └─ POST /api/export/preview  →  { files, warnings }
            └─ POST /api/export  →  { updatedCwc, warnings }

Auto-save errors
  └─ useAutoSave onError  →  App.saveError state  →  TopBar badge
```

---

## Files touched

| File | Change |
|------|--------|
| `src/server/api/workflows.ts` | Add `/rename` route; fix slugification; add `nodeCount` to `/list` response |
| `src/server/api/recents.ts` | No changes needed (home screen no longer reads recents) |
| `client/src/hooks/useAutoSave.ts` | Add `onSuccess` callback; add `hasPendingTimer` state; expose `isDirty` |
| `client/src/lib/api.ts` | Update `workflows.list` return type to include `nodeCount`; add `workflows.rename` call; remove `recents.list` usage from home screen (keep API method for write operations) |
| `client/src/App.tsx` | Wire `onError`/`onSuccess` for auto-save; add `onRename`; unsaved guard state; remove `projectDir` derivation; remove `projectDir` prop from `ExportFlow` and `Sidebar` calls |
| `client/src/components/TopBar.tsx` | Save-error state display; `onRename` callback on blur/Enter; leave confirmation |
| `client/src/components/Sidebar.tsx` | Remove `projectDir` prop (forwarded to `MyAgentsTab`; removing it means `MyAgentsTab` shows user-level agents only — correct for now) |
| `client/src/components/sidebar/MyAgentsTab.tsx` | `projectDir` prop becomes optional-unused; `api.agents()` called with no argument |
| `client/src/components/TemplatePicker.tsx` | Use `workflows/list`; show enriched metadata; inline delete confirmation |
| `client/src/components/ExportFlow.tsx` | Replace `projectDir` prop with text input; persist `lastProjectDir` to localStorage |

---

## Out of scope (Approach C, next phase)

- Duplicate/copy workflow
- Custom save location (workflows outside `~/.cwc/workflows/`)
- Search/filter on home screen
- Workflow skill slug orphan cleanup on rename (tracked separately)
