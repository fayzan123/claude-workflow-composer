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
- Clear `saveError` on each successful save (add `onSuccess` callback to `useAutoSave`, or clear it in the effect when a new save starts).
- In `TopBar`, replace the plain "Saved" indicator with a red "Save failed" state when `saveError` is set. Clicking it (or the next successful save) dismisses it.
- No modal, no toast library — inline badge state only.

---

## Item 2: Fix `projectDir` for project export

**Problem:** `App.tsx` derives `projectDir` from the `.cwc` file path, which is always inside `~/.cwc/workflows/`. "Export to Project" therefore writes to `~/.cwc/workflows/.claude/` — completely wrong.

**Design:**
- Remove the `projectDir` prop derivation from `App.tsx` entirely.
- In `ExportFlow`, when the user selects "Project" export, show a text input: "Project directory (absolute path)". Pre-fill with an empty string or the last-used project dir (stored in `localStorage`).
- Validate that the entered path is non-empty and absolute before enabling the preview step.
- Persist the last-used project dir in `localStorage` key `cwc:lastProjectDir` so repeat exports to the same project don't require re-typing.

---

## Item 3: Recents enriched with real metadata

**Problem:** The home screen derives workflow names from the file path slug via `formatPath()`, not from the actual `meta.name` field. Renamed workflows show the wrong name.

**Design:**
- Update `GET /api/recents` to return enriched objects: `{ path: string; name: string; nodeCount: number; updated: string }` instead of raw path strings.
- Server reads each `.cwc` file and extracts `meta.name`, `meta.updated`, and `nodes.length`. Paths where the file is missing or unreadable are filtered out of the response silently (this handles stale cleanup — see Item 4).
- Client replaces `formatPath()` name display with `item.name` directly.
- The `api.recents.list()` return type changes from `string[]` to the enriched array.

---

## Item 4: Stale recents cleanup

**Problem:** Clicking a stale recent silently no-ops. The entry persists in the list with no feedback.

**Design:**
- Stale entries are already filtered at the server level by Item 3's enriched endpoint (missing files are dropped from the response).
- If a file goes missing between list-load and click (race condition), `handleOpenRecent` catches the error and shows an inline message: "This workflow was deleted or moved." The entry is removed from the displayed list via `setRecents(r => r.filter(p => p.path !== path))`.
- No persistent stale state — stale entries disappear on next list load.

---

## Item 5: Full workflow list (not just recents)

**Problem:** The home screen shows at most 10 recently-opened workflows. Workflows beyond that limit, or created outside the app, are invisible.

**Design:**
- Replace `GET /api/recents` as the data source with `GET /api/workflows/list`, which scans all `.cwc` files in `~/.cwc/workflows/` and returns `{ path, name, nodeCount, updated }`.
- Sort the list by `updated` descending by default.
- `recents.json` is still maintained (for future use / sort boosting) but the home screen no longer depends on it as the primary source.
- The "Recent" tab label changes to "Workflows".
- The `MAX_RECENTS = 10` cap is removed from the home screen display (the cap remains in `recentsRouter` for its own file, but the display is unlimited).
- `GET /api/workflows/list` already exists and returns the right shape — it just needs the `nodeCount` field added.

---

## Item 6: Show metadata in workflow list

**Problem:** Each workflow card shows only name and directory path. Hard to distinguish similar workflows.

**Design:**
- Each card in the workflow list shows:
  - Name (from `meta.name`)
  - Updated timestamp formatted as relative time ("2 days ago", "just now") using a small inline utility — no date library dependency.
  - Node count ("3 agents")
- Directory path is shown as a secondary line (kept from current design, already truncated with `~`).

---

## Item 7: Delete confirmation

**Problem:** Clicking the trash icon immediately deletes the workflow file and its exports. No confirmation, no undo.

**Design:**
- Add a `deletingPath: string | null` state to `TemplatePicker`.
- First trash click sets `deletingPath` to that workflow's path. The card enters a "confirming" state showing two buttons: "Confirm delete" (destructive) and "Cancel".
- Clicking anywhere else on the page or pressing Escape resets `deletingPath` to null (cancel).
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
- `TopBar` name input `onBlur` (and Enter key): if name changed, call `api.workflows.rename(workflowPath, newName)`.
- On success: update `workflowPath` state in `App.tsx` to the returned `newPath`.
- On `renamed: false` (slug same): nothing — auto-save already handled the name change in content.
- On error: show inline warning in TopBar ("A workflow with that name already exists").
- Add `onRename: (newPath: string) => void` prop to `TopBar`; `App.tsx` implements it by calling `setWorkflowPath(newPath)`.

**Note:** After rename, `useAutoSave` automatically uses the new path because it reads `workflowPath` from props. No special handling needed.

---

## Item 9: Unsaved changes guard

**Problem:** Clicking home while a save is pending can silently discard changes.

**Design:**
- Add `isDirty: boolean` to `useAutoSave`'s return value. `isDirty` is true from the moment the debounce timer starts until the save completes (i.e., `isSaving || pendingTimer`).
- In `App.tsx`, the `onHome` handler checks `isSaving || isDirty`. If true, shows an inline confirmation in the TopBar: "Changes still saving — leave anyway?" with "Leave" and "Stay" buttons.
- "Leave" navigates home and discards the pending save.
- "Stay" dismisses the confirmation, auto-save continues.
- Implemented as a small `showLeaveConfirm` boolean state in `App.tsx` — no library needed.

---

## Item 10: Fix slugification inconsistency

**Problem:** `GET /api/workflows/default-path` has inline slug logic (`name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)`) instead of using the shared `slugify()` from `src/slugify.ts`.

**Design:**
- Import `slugify` in `src/server/api/workflows.ts`.
- Replace the inline regex with `slugify(name).slice(0, 64) || 'untitled'`.
- Verify `slugify.ts` produces equivalent output (it should — same logic). If there's any difference, `slugify.ts` is the source of truth.

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
| `src/server/api/recents.ts` | Enrich GET response with `name`, `nodeCount`, `updated` |
| `client/src/hooks/useAutoSave.ts` | Add `onSuccess` callback; expose `isDirty` |
| `client/src/lib/api.ts` | Update `recents.list` return type; add `workflows.rename` call |
| `client/src/App.tsx` | Wire `onError`/`onSuccess` for auto-save; add `onRename`; unsaved guard state; fix `projectDir` removal |
| `client/src/components/TopBar.tsx` | Save-error state display; rename on blur/Enter; leave confirmation |
| `client/src/components/TemplatePicker.tsx` | Use `workflows/list`; show enriched metadata; inline delete confirmation |
| `client/src/components/ExportFlow.tsx` | Replace `projectDir` prop with text input; persist `lastProjectDir` to localStorage |

---

## Out of scope (Approach C, next phase)

- Duplicate/copy workflow
- Custom save location (workflows outside `~/.cwc/workflows/`)
- Search/filter on home screen
- Workflow skill slug orphan cleanup on rename (tracked separately)
