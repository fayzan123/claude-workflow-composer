# Workflow Lifecycle Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 bugs and gaps in how workflows are created, saved, listed, renamed, exported, and deleted.

**Architecture:** Server-first (Tasks 1–2 add the rename endpoint and `nodeCount` to the list), then the hook overhaul (Task 3), then App wiring (Task 4), then UI components (Tasks 5–9). Task ordering matters: Task 3 (useAutoSave) must be complete before Task 4 (App), and Task 4 before Tasks 5–9.

**Tech Stack:** TypeScript, Express (server), React + vitest (client), Node.js `fs/promises` for file ops.

---

## File Map

| File | What changes |
|------|-------------|
| `src/server/api/workflows.ts` | Add `nodeCount` to `/list`; replace inline slugify; add `POST /rename` route |
| `client/src/lib/api.ts` | Update `workflows.list` return type; add `workflows.rename` method |
| `client/src/hooks/useAutoSave.ts` | Full overhaul: `hasPendingTimer`, `isDirty`, `onSuccess`, `flush`, ref sync, cleanup fix |
| `client/src/App.tsx` | Wire `onError`/`onSuccess`/`onRename`; unsaved guard; remove `projectDir` derivation |
| `client/src/components/TopBar.tsx` | Save-error badge; `onRename` on blur/Enter; leave-confirm UI |
| `client/src/components/ExportFlow.tsx` | Remove `projectDir` prop; add localStorage-backed text input for project dir |
| `client/src/components/Sidebar.tsx` | Remove `projectDir` prop |
| `client/src/components/sidebar/MyAgentsTab.tsx` | Remove `projectDir` prop; call `api.agents()` with no arg |
| `client/src/components/TemplatePicker.tsx` | Switch to `workflows/list`; state type migration; metadata display; delete confirmation |
| `tests/server/workflows.test.ts` | Add tests for `nodeCount` in list, rename endpoint (success/no-op/conflict/missing) |

---

## Task 1: Server — `nodeCount` in list + fix slugification

**Files:**
- Modify: `src/server/api/workflows.ts`
- Test: `tests/server/workflows.test.ts`

- [ ] **Step 1: Write failing test for `nodeCount` in list response**

Add to `tests/server/workflows.test.ts` (after the existing list test):

```ts
it('GET /api/workflows/list includes nodeCount', async () => {
  const filePath = path.join(tmpDir, 'counted.cwc')
  const cwc: CwcFile = {
    ...FIXTURE_CWC,
    nodes: [
      { id: 'n1', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'A', description: '', completionCriteria: '' } },
      { id: 'n2', position: { x: 0, y: 0 }, exportedSlug: null, agent: { name: 'B', description: '', completionCriteria: '' } },
    ],
  }
  await fs.writeFile(filePath, JSON.stringify(cwc), 'utf-8')
  const { status, body } = await httpGet('/api/workflows/list')
  expect(status).toBe(200)
  const items = body as { path: string; nodeCount: number }[]
  const item = items.find((i) => i.path === filePath)
  expect(item?.nodeCount).toBe(2)
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npx vitest run tests/server/workflows.test.ts
```

Expected: FAIL — `nodeCount` is `undefined`.

- [ ] **Step 3: Update `/list` handler to include `nodeCount` and fix slugification**

In `src/server/api/workflows.ts`, make these changes:

```ts
import { slugify } from '../../slugify.js'    // ADD THIS IMPORT at top

// In router.get('/default-path', ...) — replace the inline slug logic:
// OLD:
//   const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'untitled'
// NEW:
const slug = slugify(name) || 'untitled'

// In router.get('/list', ...) — update the map to add nodeCount:
// OLD:
//   return { path: fullPath, name: cwc.meta.name, updated: cwc.meta.updated }
// NEW:
return { path: fullPath, name: cwc.meta.name, updated: cwc.meta.updated, nodeCount: cwc.nodes.length }
```

- [ ] **Step 4: Run tests to confirm passing**

```bash
npx vitest run tests/server/workflows.test.ts
```

Expected: all existing tests + new `nodeCount` test PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/workflows.ts tests/server/workflows.test.ts
git commit -m "feat: add nodeCount to workflow list, use shared slugify in default-path"
```

---

## Task 2: Server — `POST /api/workflows/rename` endpoint

**Files:**
- Modify: `src/server/api/workflows.ts`
- Test: `tests/server/workflows.test.ts`

- [ ] **Step 1: Write failing tests for rename**

Add to `tests/server/workflows.test.ts`. The rename endpoint needs a `recentsPath` to update — update the single existing `beforeAll` in place (do not add a second `beforeAll`). Add `recentsPath` to the existing `createApp` call:

```ts
// Inside the existing beforeAll, replace the createApp call:
const recentsPath = path.join(tmpDir, 'recents.json')
const app = createApp({ staticDir: null, workflowsDir: tmpDir, recentsPath })
```

Then add the tests:

```ts
it('POST /api/workflows/rename renames the file and returns new path', async () => {
  const oldPath = path.join(tmpDir, 'rename-me.cwc')
  await fs.writeFile(oldPath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status, body } = await httpPost('/api/workflows/rename', { oldPath, newName: 'Brand New Name' })
  expect(status).toBe(200)
  const result = body as { path: string; renamed: boolean }
  expect(result.renamed).toBe(true)
  expect(result.path).toContain('brand-new-name.cwc')
  // old file gone, new file has updated name
  await expect(fs.access(oldPath)).rejects.toThrow()
  const raw = await fs.readFile(result.path, 'utf-8')
  expect(JSON.parse(raw).meta.name).toBe('Brand New Name')
})

it('POST /api/workflows/rename returns renamed:false when slug is unchanged', async () => {
  const filePath = path.join(tmpDir, 'same-slug.cwc')
  await fs.writeFile(filePath, JSON.stringify({ ...FIXTURE_CWC, meta: { ...FIXTURE_CWC.meta, name: 'Same Slug' } }), 'utf-8')
  const { status, body } = await httpPost('/api/workflows/rename', { oldPath: filePath, newName: 'Same Slug' })
  expect(status).toBe(200)
  expect((body as { renamed: boolean }).renamed).toBe(false)
  // file still exists at same path
  await expect(fs.access(filePath)).resolves.toBeUndefined()
})

it('POST /api/workflows/rename returns 400 when target name already exists', async () => {
  const existingPath = path.join(tmpDir, 'already-exists.cwc')
  const sourcePath = path.join(tmpDir, 'source-wf.cwc')
  await fs.writeFile(existingPath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  await fs.writeFile(sourcePath, JSON.stringify(FIXTURE_CWC), 'utf-8')
  const { status } = await httpPost('/api/workflows/rename', { oldPath: sourcePath, newName: 'Already Exists' })
  expect(status).toBe(400)
})

it('POST /api/workflows/rename returns 404 when source file is missing', async () => {
  const { status } = await httpPost('/api/workflows/rename', {
    oldPath: path.join(tmpDir, 'ghost.cwc'),
    newName: 'New Name',
  })
  expect(status).toBe(404)
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/server/workflows.test.ts
```

Expected: 4 new tests FAIL with 404 (route doesn't exist yet).

- [ ] **Step 3: Implement the rename endpoint**

Add to `src/server/api/workflows.ts` inside `workflowsRouter`, before `return router`:

```ts
router.post('/rename', async (req, res) => {
  const { oldPath, newName } = req.body as { oldPath: string; newName: string }
  if (!oldPath || !newName) return void res.status(400).json({ error: 'oldPath and newName required' })

  const newSlug = slugify(newName) || 'untitled'
  const dir = path.dirname(oldPath)
  const newPath = path.join(dir, `${newSlug}.cwc`)

  if (newPath === oldPath) return void res.json({ path: oldPath, renamed: false })
  if (await fs.access(newPath).then(() => true).catch(() => false)) {
    return void res.status(400).json({ error: 'A workflow with that name already exists' })
  }

  let raw: string
  try {
    raw = await fs.readFile(oldPath, 'utf-8')
  } catch {
    return void res.status(404).json({ error: 'not found' })
  }

  const cwc: CwcFile = JSON.parse(raw)
  cwc.meta.name = newName
  cwc.meta.updated = new Date().toISOString()
  await fs.writeFile(newPath, JSON.stringify(cwc, null, 2), 'utf-8')
  await fs.unlink(oldPath)

  // Update recents.json if it exists
  try {
    const recentsRaw = await fs.readFile(recentsPath, 'utf-8')
    const recents: string[] = JSON.parse(recentsRaw)
    const updated = recents.map((p) => (p === oldPath ? newPath : p))
    await fs.writeFile(recentsPath, JSON.stringify(updated, null, 2), 'utf-8')
  } catch { /* recents file missing or corrupt — skip */ }

  res.json({ path: newPath, renamed: true })
})
```

**Important:** The `workflowsRouter` function currently takes only `workflowsDir: string`. It needs to also accept `recentsPath` to update recents on rename. Update the signature and `createApp` call:

In `src/server/api/workflows.ts`:
```ts
// Change function signature:
export function workflowsRouter(workflowsDir: string, recentsPath: string) {
```

In `src/server/index.ts`:
```ts
// Update the call (recPath already computed above wfDir):
app.use('/api/workflows', workflowsRouter(wfDir, recPath))
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/server/workflows.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/workflows.ts src/server/index.ts tests/server/workflows.test.ts
git commit -m "feat: add POST /api/workflows/rename endpoint"
```

---

## Task 3: Client API types

**Files:**
- Modify: `client/src/lib/api.ts`

- [ ] **Step 1: Update `workflows.list` return type and add `workflows.rename`**

In `client/src/lib/api.ts`:

```ts
// Change workflows.list return type:
//   list: () => req<{ path: string; name: string; updated: string }[]>('GET', '/workflows/list'),
// to:
list: () => req<{ path: string; name: string; nodeCount: number; updated: string }[]>('GET', '/workflows/list'),

// Add rename method to workflows object:
rename: (oldPath: string, newName: string) =>
  req<{ path: string; renamed: boolean }>('POST', '/workflows/rename', { oldPath, newName }),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api.ts
git commit -m "feat: update api.ts with nodeCount in list type and workflows.rename"
```

---

## Task 4: `useAutoSave` overhaul

**Files:**
- Modify: `client/src/hooks/useAutoSave.ts`

This task implements Items 9 (dirty tracking) and 1 (onSuccess) together, and adds `flush()` required by Item 8. All three changes are in one file and are interdependent.

- [ ] **Step 1: Rewrite `useAutoSave.ts`**

Replace the entire file content with:

```ts
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CwcFile } from '../types.ts'
import { api } from '../lib/api.ts'

interface UseAutoSaveOptions {
  onError?: (err: Error) => void
  onSuccess?: () => void
}

export function useAutoSave(
  workflow: CwcFile,
  filePath: string | null,
  options?: UseAutoSaveOptions,
): { isSaving: boolean; isDirty: boolean; flush: () => Promise<void> } {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevRef = useRef<string>('')
  const onErrorRef = useRef(options?.onError)
  const onSuccessRef = useRef(options?.onSuccess)
  const workflowRef = useRef(workflow)
  const filePathRef = useRef(filePath)

  const [isSaving, setIsSaving] = useState(false)
  const [hasPendingTimer, setHasPendingTimer] = useState(false)

  // Keep refs in sync with latest values (avoids stale closures in flush/callbacks)
  useEffect(() => {
    onErrorRef.current = options?.onError
    onSuccessRef.current = options?.onSuccess
    workflowRef.current = workflow
    filePathRef.current = filePath
  })

  const runSave = useCallback(async () => {
    const fp = filePathRef.current
    const wf = workflowRef.current
    if (!fp) return
    setIsSaving(true)
    let succeeded = false
    try {
      await api.workflows.save(fp, wf)
      succeeded = true
    } catch (err) {
      onErrorRef.current?.(err as Error)
    } finally {
      setIsSaving(false)
      setHasPendingTimer(false)
    }
    if (succeeded) onSuccessRef.current?.()
  }, []) // stable — reads everything via refs

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    await runSave()
  }, [runSave])

  useEffect(() => {
    if (!filePath) return
    const serialized = JSON.stringify(workflow)
    if (serialized === prevRef.current) return
    prevRef.current = serialized

    // Cancel any existing pending timer (don't clear dirty state — will be cleared in finally)
    if (timerRef.current) clearTimeout(timerRef.current)

    setHasPendingTimer(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      runSave()
    }, 500)

    // Cleanup: cancel timer only. Do NOT reset isSaving or hasPendingTimer here —
    // this cleanup runs on every keystroke and would cause dirty state to flicker.
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [workflow, filePath, runSave])

  return { isSaving, isDirty: hasPendingTimer || isSaving, flush }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd client && npx tsc --noEmit
```

Expected: errors because `App.tsx` still uses old `{ isSaving }` destructuring — that's fine for now, it still compiles since `isSaving` is still returned. Fix: the old call in App.tsx was `const { isSaving } = useAutoSave(editorWorkflow, workflowPath)` — the new signature takes an options object as third arg. The destructuring still works; the missing `options` arg is fine (optional). Confirm no errors beyond App.tsx's unused `isSaving` passthrough.

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/useAutoSave.ts
git commit -m "feat: overhaul useAutoSave — add isDirty, onSuccess, flush, fix cleanup"
```

---

## Task 5: `App.tsx` — wire everything

**Files:**
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Rewrite `App.tsx`**

Replace the entire file:

```tsx
import React, { useState, useCallback } from 'react'
import type { CwcFile } from './types.ts'
import { api } from './lib/api.ts'
import { TemplatePicker } from './components/TemplatePicker.tsx'
import { useWorkflow } from './hooks/useWorkflow.ts'
import { useAutoSave } from './hooks/useAutoSave.ts'
import { validateWorkflow } from './lib/validation.ts'
import { ReactFlowProvider } from '@xyflow/react'
import { Canvas } from './components/Canvas.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { NodePanel } from './components/panels/NodePanel.tsx'
import { EdgePanel } from './components/panels/EdgePanel.tsx'
import { TopBar } from './components/TopBar.tsx'
import { ExportFlow } from './components/ExportFlow.tsx'
import './App.css'

type Screen = 'home' | 'editor'

function viewTransition(fn: () => void) {
  if (document.startViewTransition) {
    document.startViewTransition(fn)
  } else {
    fn()
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home')
  const [workflow, setWorkflow] = useState<CwcFile | null>(null)
  const [workflowPath, setWorkflowPath] = useState<string | null>(null)
  const [showExport, setShowExport] = useState(false)
  const [saveError, setSaveError] = useState<Error | null>(null)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false)

  const { workflow: editorWorkflow, dispatch } = useWorkflow(workflow ?? undefined)
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const validation = validateWorkflow(editorWorkflow)
  const { isSaving, isDirty, flush } = useAutoSave(editorWorkflow, workflowPath, {
    onError: (err) => setSaveError(err),
    onSuccess: () => setSaveError(null),
  })

  const handleSelectNode = useCallback((id: string | null) => {
    viewTransition(() => {
      setSelectedNodeId(id)
      if (id) setSelectedEdgeId(null)
    })
  }, [])

  const handleSelectEdge = useCallback((id: string | null) => {
    viewTransition(() => {
      setSelectedEdgeId(id)
      if (id) setSelectedNodeId(null)
    })
  }, [])

  function openWorkflow(cwc: CwcFile, path: string) {
    setWorkflow(cwc)
    setWorkflowPath(path)
    dispatch({ type: 'LOAD', payload: cwc })
    setScreen('editor')
  }

  async function handleOpenRecent(path: string): Promise<void> {
    const cwc = await api.workflows.read(path) // throws on 404 — caller handles it
    try { await api.recents.add(path) } catch { /* non-critical */ }
    openWorkflow(cwc, path)
  }

  async function handleRename(newName: string) {
    if (!workflowPath) return
    setRenameError(null)
    try {
      await flush()
      const result = await api.workflows.rename(workflowPath, newName)
      if (result.renamed) setWorkflowPath(result.path)
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Rename failed')
    }
  }

  function handleHomeClick() {
    if (isDirty) {
      setShowLeaveConfirm(true)
    } else {
      goHome()
    }
  }

  function goHome() {
    setScreen('home')
    setWorkflow(null)
    setWorkflowPath(null)
    setShowLeaveConfirm(false)
    setSaveError(null)
    setRenameError(null)
  }

  if (screen === 'home') {
    return (
      <div className="app">
        <TemplatePicker onSelect={openWorkflow} onOpenRecent={handleOpenRecent} />
      </div>
    )
  }

  const selectedNode = selectedNodeId ? editorWorkflow.nodes.find((n) => n.id === selectedNodeId) ?? null : null
  const selectedEdge = selectedEdgeId ? editorWorkflow.edges.find((e) => e.id === selectedEdgeId) ?? null : null
  const isEntryNode = selectedNode ? !editorWorkflow.edges.some((e) => e.to === selectedNode.id) : false
  const terminalEdge = selectedNode ? (editorWorkflow.edges.find((e) => e.from === selectedNode.id && e.to === null) ?? null) : null

  return (
    <div className="app app--editor">
      <TopBar
        workflow={editorWorkflow}
        validation={validation}
        isSaving={isSaving}
        saveError={saveError}
        renameError={renameError}
        showLeaveConfirm={showLeaveConfirm}
        dispatch={dispatch}
        onExport={() => setShowExport(true)}
        onHome={handleHomeClick}
        onRename={handleRename}
        onLeaveConfirm={goHome}
        onLeaveCancel={() => setShowLeaveConfirm(false)}
        onDismissSaveError={() => setSaveError(null)}
      />
      <div className="app__editor-body">
        <Sidebar />
        <ReactFlowProvider>
          <Canvas
            workflow={editorWorkflow}
            dispatch={dispatch}
            validation={validation}
            onSelectNode={handleSelectNode}
            onSelectEdge={handleSelectEdge}
            selectedNodeId={selectedNodeId}
            selectedEdgeId={selectedEdgeId}
          />
        </ReactFlowProvider>
        {selectedNode && (
          <NodePanel
            node={selectedNode}
            isEntryNode={isEntryNode}
            terminalEdge={terminalEdge}
            dispatch={dispatch}
            onClose={() => handleSelectNode(null)}
            onDelete={() => {
              dispatch({ type: 'REMOVE_NODE', payload: { nodeId: selectedNode.id } })
              handleSelectNode(null)
            }}
          />
        )}
        {selectedEdge && (
          <EdgePanel
            edge={selectedEdge}
            dispatch={dispatch}
            onClose={() => handleSelectEdge(null)}
          />
        )}
      </div>
      {showExport && (
        <ExportFlow
          workflow={editorWorkflow}
          dispatch={dispatch}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd client && npx tsc --noEmit
```

Expected: errors on `TopBar` and `Sidebar` and `ExportFlow` props (those components haven't been updated yet). That's expected — fix those in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat: wire onError/onSuccess/onRename in App, add unsaved guard, remove projectDir"
```

---

## Task 6: `TopBar.tsx` — save-error badge, rename, leave confirmation

**Files:**
- Modify: `client/src/components/TopBar.tsx`
- Modify: `client/src/components/TopBar.css` (add styles for new states)

- [ ] **Step 1: Update `TopBar` props interface and implementation**

Replace the entire `TopBar.tsx`:

```tsx
import React, { useState, useRef, useEffect } from 'react'
import type { CwcFile } from '../types.ts'
import type { WorkflowAction } from '../hooks/useWorkflow.ts'
import type { ValidationResult } from '../lib/validation.ts'
import './TopBar.css'

interface Props {
  workflow: CwcFile
  validation: ValidationResult
  isSaving: boolean
  saveError: Error | null
  renameError: string | null
  showLeaveConfirm: boolean
  dispatch: React.Dispatch<WorkflowAction>
  onExport: () => void
  onHome: () => void
  onRename: (newName: string) => void
  onLeaveConfirm: () => void
  onLeaveCancel: () => void
  onDismissSaveError: () => void
}

export function TopBar({
  workflow, validation, isSaving, saveError, renameError, showLeaveConfirm,
  dispatch, onExport, onHome, onRename, onLeaveConfirm, onLeaveCancel, onDismissSaveError,
}: Props) {
  const [errorsOpen, setErrorsOpen] = useState(false)
  const [warningsOpen, setWarningsOpen] = useState(false)
  const errorsBadgeRef = useRef<HTMLButtonElement>(null)
  const errorsPopoverRef = useRef<HTMLDivElement>(null)
  const warningsBadgeRef = useRef<HTMLButtonElement>(null)
  const warningsPopoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!errorsOpen) return
    function handleClick(e: MouseEvent) {
      if (!errorsPopoverRef.current?.contains(e.target as Node) && !errorsBadgeRef.current?.contains(e.target as Node)) {
        setErrorsOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setErrorsOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('mousedown', handleClick); document.removeEventListener('keydown', handleKey) }
  }, [errorsOpen])

  useEffect(() => {
    if (!warningsOpen) return
    function handleClick(e: MouseEvent) {
      if (!warningsPopoverRef.current?.contains(e.target as Node) && !warningsBadgeRef.current?.contains(e.target as Node)) {
        setWarningsOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setWarningsOpen(false) }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('mousedown', handleClick); document.removeEventListener('keydown', handleKey) }
  }, [warningsOpen])

  function handleNameChange(e: React.ChangeEvent<HTMLInputElement>) {
    dispatch({ type: 'SET_META', payload: { name: e.target.value } })
  }

  function handleNameBlur() {
    onRename(workflow.meta.name.trim() || 'Untitled Workflow')
  }

  function handleNameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  function nodeNameFor(nodeId: string | undefined) {
    if (!nodeId) return null
    const node = workflow.nodes.find((n) => n.id === nodeId)
    return node?.agent.name?.trim() || 'Untitled agent'
  }

  const hasErrors = validation.errors.length > 0
  const hasWarnings = validation.warnings.length > 0

  // Leave confirmation takes priority over everything else in the status area
  if (showLeaveConfirm) {
    return (
      <header className="top-bar">
        <button className="top-bar__home-btn" onClick={onHome} type="button" title="Back to home">
          {/* home icon svg — same as below */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </button>
        <div className="top-bar__name-wrap">
          <span className="top-bar__leave-msg">Changes are still saving — leave anyway?</span>
        </div>
        <div className="top-bar__status">
          <button className="top-bar__leave-btn top-bar__leave-btn--confirm" onClick={onLeaveConfirm} type="button">Leave</button>
          <button className="top-bar__leave-btn top-bar__leave-btn--cancel" onClick={onLeaveCancel} type="button">Stay</button>
        </div>
      </header>
    )
  }

  return (
    <header className="top-bar">
      <button className="top-bar__home-btn" onClick={onHome} type="button" title="Back to home">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
      </button>

      <div className="top-bar__name-wrap">
        <input
          className="top-bar__name-input"
          type="text"
          value={workflow.meta.name}
          onChange={handleNameChange}
          onBlur={handleNameBlur}
          onKeyDown={handleNameKeyDown}
          aria-label="Workflow name"
          placeholder="Workflow name"
        />
        <div className="top-bar__meta">
          {workflow.nodes.length} agent{workflow.nodes.length !== 1 ? 's' : ''}
          {workflow.edges.length > 0 && ` · ${workflow.edges.length} handoff${workflow.edges.length !== 1 ? 's' : ''}`}
        </div>
        {renameError && (
          <div className="top-bar__rename-error" role="alert">{renameError}</div>
        )}
      </div>

      <div className="top-bar__status">
        {saveError ? (
          <button
            className="top-bar__save-indicator top-bar__save-indicator--error"
            onClick={onDismissSaveError}
            type="button"
            title="Click to dismiss"
          >
            <span className="top-bar__save-dot" />
            Save failed
          </button>
        ) : (
          <span className={`top-bar__save-indicator ${isSaving ? 'top-bar__save-indicator--saving' : 'top-bar__save-indicator--saved'}`}>
            <span className="top-bar__save-dot" />
            {isSaving ? 'Saving' : 'Saved'}
          </span>
        )}

        {hasErrors && (
          <div className="top-bar__badge-wrap">
            <button
              ref={errorsBadgeRef}
              className="top-bar__badge top-bar__badge--error"
              onClick={() => setErrorsOpen((o) => !o)}
              type="button"
              aria-expanded={errorsOpen}
            >
              {validation.errors.length} error{validation.errors.length !== 1 ? 's' : ''}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4 }}>
                <polyline points={errorsOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
              </svg>
            </button>
            {errorsOpen && (
              <div ref={errorsPopoverRef} className="top-bar__popover top-bar__popover--error" role="dialog" aria-label="Workflow errors">
                <p className="top-bar__popover-heading">Fix before exporting</p>
                <ul className="top-bar__popover-list">
                  {validation.errors.map((err, i) => (
                    <li key={i} className="top-bar__popover-item">
                      <span className="top-bar__popover-msg">{err.message}</span>
                      {err.nodeId && <span className="top-bar__popover-node">{nodeNameFor(err.nodeId)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!hasErrors && hasWarnings && (
          <div className="top-bar__badge-wrap">
            <button
              ref={warningsBadgeRef}
              className="top-bar__badge top-bar__badge--warning"
              onClick={() => setWarningsOpen((o) => !o)}
              type="button"
              aria-expanded={warningsOpen}
            >
              {validation.warnings.length} warning{validation.warnings.length !== 1 ? 's' : ''}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 4 }}>
                <polyline points={warningsOpen ? '18 15 12 9 6 15' : '6 9 12 15 18 9'} />
              </svg>
            </button>
            {warningsOpen && (
              <div ref={warningsPopoverRef} className="top-bar__popover top-bar__popover--warning" role="dialog" aria-label="Workflow warnings">
                <p className="top-bar__popover-heading">Warnings</p>
                <ul className="top-bar__popover-list">
                  {validation.warnings.map((w, i) => (
                    <li key={i} className="top-bar__popover-item">
                      <span className="top-bar__popover-msg">{w.message}</span>
                      {w.nodeId && <span className="top-bar__popover-node">{nodeNameFor(w.nodeId)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <button
          className="top-bar__export-btn"
          onClick={onExport}
          disabled={!validation.canExport}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export
        </button>
      </div>
    </header>
  )
}
```

- [ ] **Step 2: Add CSS for new states to `TopBar.css`**

Open `client/src/components/TopBar.css` and append:

```css
.top-bar__save-indicator--error {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-error, #e53e3e);
  font-size: inherit;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
}
.top-bar__save-indicator--error .top-bar__save-dot {
  background: var(--color-error, #e53e3e);
}
.top-bar__rename-error {
  font-size: 11px;
  color: var(--color-error, #e53e3e);
  margin-top: 2px;
}
.top-bar__leave-msg {
  font-size: 13px;
  color: var(--color-text-secondary);
}
.top-bar__leave-btn {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
}
.top-bar__leave-btn--confirm {
  background: var(--color-error, #e53e3e);
  color: #fff;
  border-color: var(--color-error, #e53e3e);
}
.top-bar__leave-btn--cancel {
  background: transparent;
  color: var(--color-text-secondary);
  border-color: var(--color-border);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd client && npx tsc --noEmit
```

Expected: errors only from `ExportFlow` (still expects `projectDir` prop). That's fixed next.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/TopBar.tsx client/src/components/TopBar.css
git commit -m "feat: TopBar — save-error badge, rename on blur, leave confirmation"
```

---

## Task 7: `ExportFlow.tsx` — remove `projectDir` prop, add localStorage text input

**Files:**
- Modify: `client/src/components/ExportFlow.tsx`

- [ ] **Step 1: Remove `projectDir` from Props and add localStorage state**

At the top of `ExportFlow.tsx`, update the `Props` interface and component:

```tsx
// Remove projectDir from Props:
interface Props {
  workflow: CwcFile
  dispatch: React.Dispatch<WorkflowAction>
  onClose: () => void
  // projectDir is REMOVED
}

// Inside ExportFlow component, add:
const [projectDir, setProjectDir] = useState(() => localStorage.getItem('cwc:lastProjectDir') ?? '')
```

- [ ] **Step 2: Replace "Project" export button with text input flow**

In the `target-select` step, replace the Project button with a form that shows the text input:

```tsx
{/* Replace the existing Project button block with: */}
<div className="export-flow-project-input">
  <label className="export-flow-project-input__label" htmlFor="project-dir-input">
    Project directory
  </label>
  <input
    id="project-dir-input"
    className="export-flow-project-input__field"
    type="text"
    value={projectDir}
    onChange={(e) => setProjectDir(e.target.value)}
    placeholder="/absolute/path/to/project"
    spellCheck={false}
  />
  <button
    className="export-flow-target-btn"
    onClick={handleProjectExport}
    disabled={!projectDir.startsWith('/')}
    type="button"
    title={!projectDir.startsWith('/') ? 'Enter an absolute path starting with /' : undefined}
  >
    <span className="export-flow-target-btn__icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
    </span>
    <span className="export-flow-target-btn__label">Project</span>
    <span className="export-flow-target-btn__path">{projectDir ? shortenPath(projectDir) + '/' : ''}</span>
  </button>
</div>
```

- [ ] **Step 3: Save to localStorage on successful preview and update `handleProjectExport`**

```tsx
// Update handleProjectExport:
function handleProjectExport() {
  runPreview({ type: 'project', projectDir })
}

// In runPreview, after setStep('confirming'), save to localStorage:
// Add inside the try block, before setStep('confirming'):
localStorage.setItem('cwc:lastProjectDir', target.type === 'project' ? target.projectDir : '')
```

Actually, more precisely — save to localStorage right before calling `runPreview` in `handleProjectExport`:

```tsx
function handleProjectExport() {
  localStorage.setItem('cwc:lastProjectDir', projectDir)
  runPreview({ type: 'project', projectDir })
}
```

- [ ] **Step 4: Update delete-target Project button to use `projectDir` state**

In the `delete-target` step, replace `!projectDir` guards and the `projectDir!` assertion:

```tsx
// Change runDelete call for project:
onClick={() => runDelete({ type: 'project', projectDir })}
disabled={!projectDir.startsWith('/')}
title={!projectDir.startsWith('/') ? 'Export to a project directory first' : undefined}
```

Also update the path display:
```tsx
<span className="export-flow-target-btn__path">
  {projectDir ? shortenPath(projectDir) + '/' : ''}
</span>
```

- [ ] **Step 5: Verify TypeScript compiles with no errors**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors (App.tsx no longer passes `projectDir` to ExportFlow).

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ExportFlow.tsx
git commit -m "feat: ExportFlow — localStorage-backed project dir input, remove projectDir prop"
```

---

## Task 8: `Sidebar` + `MyAgentsTab` — remove `projectDir`

**Files:**
- Modify: `client/src/components/Sidebar.tsx`
- Modify: `client/src/components/sidebar/MyAgentsTab.tsx`

- [ ] **Step 1: Remove `projectDir` from both components**

In `client/src/components/Sidebar.tsx`:
```tsx
// Remove Props interface entirely (or remove projectDir from it)
// Change: export function Sidebar({ projectDir }: Props)
// To:
export function Sidebar() {
  // ... remove all references to projectDir
  // Change: <MyAgentsTab projectDir={projectDir} />
  // To:
  // <MyAgentsTab />
}
```

In `client/src/components/sidebar/MyAgentsTab.tsx`:
```tsx
// Remove Props interface (or remove projectDir from it)
// Change: export function MyAgentsTab({ projectDir }: Props)
// To:
export function MyAgentsTab() {
  // Change: api.agents(projectDir)
  // To:
  api.agents()
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/Sidebar.tsx client/src/components/sidebar/MyAgentsTab.tsx
git commit -m "fix: remove broken projectDir from Sidebar/MyAgentsTab, show user agents only"
```

---

## Task 9: `TemplatePicker.tsx` — full overhaul

**Files:**
- Modify: `client/src/components/TemplatePicker.tsx`

This task implements Items 3/4/5 (workflow list), Item 6 (metadata), and Item 7 (delete confirmation) together since they all live in this component.

- [ ] **Step 1: Write test for `relativeTime` utility**

Add a new test file `tests/client/relative-time.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

// Import the utility — it'll be exported from TemplatePicker.tsx's module.
// Since it's a pure function we can test it directly once extracted.
// Inline the implementation here for test-first:
function relativeTime(isoString: string, now: number): string {
  const diff = now - new Date(isoString).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const days = Math.floor(hr / 24)
  return `${days} days ago`
}

describe('relativeTime', () => {
  const NOW = new Date('2026-05-26T12:00:00Z').getTime()

  it('returns "just now" for < 60s ago', () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now')
  })
  it('returns "X min ago" for < 1hr ago', () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago')
  })
  it('returns "X hr ago" for < 24hr ago', () => {
    expect(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3 hr ago')
  })
  it('returns "X days ago" for older', () => {
    expect(relativeTime(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe('2 days ago')
  })
})
```

- [ ] **Step 2: Run test to confirm it passes** (it's written inline, no import yet)

```bash
npx vitest run tests/client/relative-time.test.ts
```

Expected: PASS (tests are self-contained).

- [ ] **Step 3: Rewrite `TemplatePicker.tsx`**

Replace the entire file:

```tsx
import { useEffect, useState, useRef } from 'react'
import { api } from '../lib/api.ts'
import type { CwcFile } from '../types.ts'
import './TemplatePicker.css'

type WorkflowListItem = { path: string; name: string; nodeCount: number; updated: string }

interface Props {
  onSelect: (cwc: CwcFile, path: string) => void
  onOpenRecent: (path: string) => Promise<void>
}

type Tab = 'new' | 'workflows'

export function relativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const days = Math.floor(hr / 24)
  return `${days} days ago`
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

export function TemplatePicker({ onSelect, onOpenRecent }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowListItem[]>([])
  const [notInstalled, setNotInstalled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('new')
  const [creating, setCreating] = useState(false)
  const [deletingPath, setDeletingPath] = useState<string | null>(null)
  const confirmRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.claudeCheck().then((r) => { if (!r.installed) setNotInstalled(true) }).catch(() => {})
    api.workflows.list().then((items) => {
      setWorkflows(items.slice().sort((a, b) => b.updated.localeCompare(a.updated)))
    }).catch(() => {})
  }, [])

  // Escape / outside-click to cancel delete confirmation
  useEffect(() => {
    if (!deletingPath) return
    function handleKey(e: KeyboardEvent) { if (e.key === 'Escape') setDeletingPath(null) }
    function handleClick(e: MouseEvent) {
      if (!confirmRef.current?.contains(e.target as Node)) setDeletingPath(null)
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('mousedown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('mousedown', handleClick)
    }
  }, [deletingPath])

  async function handleDelete(path: string) {
    try {
      let cwcFile: CwcFile | undefined
      try { cwcFile = await api.workflows.read(path) } catch { /* corrupted or missing */ }
      if (cwcFile) {
        try { await api.deleteExport(cwcFile, { type: 'user' }) } catch { /* best-effort */ }
      }
      await api.workflows.delete(path)
      await api.recents.remove(path)
      setWorkflows((ws) => ws.filter((w) => w.path !== path))
    } catch {
      setWorkflows((ws) => ws.filter((w) => w.path !== path))
    } finally {
      setDeletingPath(null)
    }
  }

  async function handleNewWorkflow() {
    setError(null)
    setCreating(true)
    try {
      const cwc: CwcFile = {
        meta: {
          id: crypto.randomUUID(),
          name: 'Untitled Workflow',
          description: '',
          version: 1,
          created: new Date().toISOString(),
          updated: new Date().toISOString(),
        },
        nodes: [],
        edges: [],
      }
      const pathRes = await fetch(`/api/workflows/default-path?name=${encodeURIComponent(cwc.meta.name)}`)
      const { path: resolvedPath } = await pathRes.json() as { path: string }
      await api.workflows.save(resolvedPath, cwc)
      await api.recents.add(resolvedPath)
      onSelect(cwc, resolvedPath)
    } catch {
      setError('Failed to create workflow. Is the server running?')
      setCreating(false)
    }
  }

  if (notInstalled) {
    return (
      <div className="template-picker">
        <div className="template-picker__notice">
          <div className="template-picker__notice-icon">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
            </svg>
          </div>
          <h2 className="template-picker__notice-title">Claude Code not found</h2>
          <p className="template-picker__notice-desc">Install Claude Code first, then relaunch <code>npx cwc</code>.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="template-picker">
      <header className="template-picker__header">
        <div className="template-picker__logo">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-primary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <h1 className="template-picker__title">Workflow Composer</h1>
        <p className="template-picker__subtitle">
          Visually compose multi-agent workflows for Claude Code.
          Drag agents, attach skills, wire handoffs, and export.
        </p>
      </header>

      <div className="template-picker__tabs">
        <button
          className={`template-picker__tab${activeTab === 'new' ? ' template-picker__tab--active' : ''}`}
          onClick={() => setActiveTab('new')}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14" /><path d="M5 12h14" />
          </svg>
          New Workflow
        </button>
        <button
          className={`template-picker__tab${activeTab === 'workflows' ? ' template-picker__tab--active' : ''}`}
          onClick={() => setActiveTab('workflows')}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
          Workflows
          {workflows.length > 0 && <span className="template-picker__tab-badge">{workflows.length}</span>}
        </button>
      </div>

      {error && (
        <div className="template-picker__error">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" />
          </svg>
          {error}
        </div>
      )}

      {activeTab === 'new' && (
        <section className="template-picker__section">
          <button
            className="template-card template-card--blank"
            onClick={handleNewWorkflow}
            disabled={creating}
            type="button"
          >
            <div className="template-card__icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" /><path d="M5 12h14" />
              </svg>
            </div>
            <span className="template-card__title">Blank Canvas</span>
            <span className="template-card__desc">Start from scratch with your own agents and skills</span>
          </button>
        </section>
      )}

      {activeTab === 'workflows' && (
        <section className="template-picker__section">
          {workflows.length === 0 ? (
            <div className="template-picker__empty-state">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" />
              </svg>
              <p className="template-picker__empty-text">No workflows yet.</p>
              <p className="template-picker__empty-hint">Create a new workflow to get started.</p>
            </div>
          ) : (
            <div className="template-picker__recent-list">
              {workflows.map((item) => {
                const dir = shortenPath(item.path).replace(/\/[^/]*\.cwc$/, '')
                const isConfirming = deletingPath === item.path
                return (
                  <div key={item.path} className={`template-picker__recent-item${isConfirming ? ' template-picker__recent-item--confirming' : ''}`}>
                    <button
                      className="template-picker__recent-link"
                      onClick={() => {
                        onOpenRecent(item.path).catch(() => {
                          setWorkflows((ws) => ws.filter((w) => w.path !== item.path))
                          setError('That workflow was deleted or moved.')
                        })
                      }}
                      type="button"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <div className="template-picker__recent-info">
                        <span className="template-picker__recent-name">{item.name}</span>
                        <span className="template-picker__recent-meta">
                          {item.nodeCount} agent{item.nodeCount !== 1 ? 's' : ''} · {relativeTime(item.updated)}
                        </span>
                        <span className="template-picker__recent-dir">{dir}</span>
                      </div>
                    </button>
                    {isConfirming ? (
                      <div ref={confirmRef} className="template-picker__confirm-delete">
                        <span className="template-picker__confirm-msg">Delete?</span>
                        <button
                          className="template-picker__confirm-btn template-picker__confirm-btn--yes"
                          onClick={() => handleDelete(item.path)}
                          type="button"
                        >
                          Delete
                        </button>
                        <button
                          className="template-picker__confirm-btn template-picker__confirm-btn--no"
                          onClick={() => setDeletingPath(null)}
                          type="button"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="template-picker__recent-delete"
                        onClick={() => setDeletingPath(item.path)}
                        aria-label="Delete workflow"
                        type="button"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="3 6 5 6 21 6" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Add CSS for new metadata and confirm-delete styles to `TemplatePicker.css`**

Append to `client/src/components/TemplatePicker.css`:

```css
.template-picker__recent-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}
.template-picker__recent-meta {
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.template-picker__recent-item--confirming {
  background: var(--color-surface-raised, #f9f9f9);
}
.template-picker__confirm-delete {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  flex-shrink: 0;
}
.template-picker__confirm-msg {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.template-picker__confirm-btn {
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  border: 1px solid transparent;
}
.template-picker__confirm-btn--yes {
  background: var(--color-error, #e53e3e);
  color: #fff;
  border-color: var(--color-error, #e53e3e);
}
.template-picker__confirm-btn--no {
  background: transparent;
  color: var(--color-text-secondary);
  border-color: var(--color-border);
}
```

- [ ] **Step 5: Update the `relative-time` test to import from the component**

Change `relativeTime` to accept an optional `now` parameter so it's deterministically testable without fake timers. Update the exported function in `TemplatePicker.tsx`:

```ts
// In TemplatePicker.tsx, change:
export function relativeTime(isoString: string, now = Date.now()): string {
  const diff = now - new Date(isoString).getTime()
  // ... rest unchanged
}
```

Then update `tests/client/relative-time.test.ts` to import from the component and pass `now` explicitly:

```ts
import { describe, it, expect } from 'vitest'
import { relativeTime } from '../../client/src/components/TemplatePicker.tsx'

const NOW = new Date('2026-05-26T12:00:00Z').getTime()

describe('relativeTime', () => {
  it('returns "just now" for < 60s ago', () => {
    expect(relativeTime(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now')
  })
  it('returns "X min ago" for < 1hr ago', () => {
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5 min ago')
  })
  it('returns "X hr ago" for < 24hr ago', () => {
    expect(relativeTime(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe('3 hr ago')
  })
  it('returns "X days ago" for older', () => {
    expect(relativeTime(new Date(NOW - 2 * 86400_000).toISOString(), NOW)).toBe('2 days ago')
  })
})
```

- [ ] **Step 6: Run full test suite**

```bash
npx vitest run
```

Expected: all tests PASS.

- [ ] **Step 7: Verify TypeScript compiles clean**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add client/src/components/TemplatePicker.tsx client/src/components/TemplatePicker.css tests/client/relative-time.test.ts
git commit -m "feat: TemplatePicker — workflow list with metadata, delete confirmation, stale cleanup"
```

---

## Final verification

- [ ] **Run full test suite one more time**

```bash
npx vitest run
```

Expected: all tests PASS.

- [ ] **Build to confirm no TypeScript or bundler errors**

```bash
npm run build
```

Expected: clean build with no errors.

- [ ] **Manual smoke test**

Start the dev server (`npx cwc` or `npm run dev`) and verify:
1. Home screen shows "Workflows" tab with real names, node counts, and relative timestamps
2. Creating a new workflow saves correctly
3. Renaming a workflow in TopBar renames the file (check `~/.cwc/workflows/`)
4. Delete confirmation appears before deleting
5. Export → Project shows a text input, persists in localStorage on next open
6. Clicking home while actively typing triggers the leave confirmation
7. Auto-save errors show a "Save failed" badge in the TopBar
8. Stale workflow entry removed from list when clicked
