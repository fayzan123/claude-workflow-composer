# Skill & Agent Markdown Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users click any skill or agent card in the sidebar to view its full raw markdown in a modal, with an "Open in editor" button that opens the file in the system editor.

**Architecture:** Add two server endpoints — one to read raw file content (restricted to `.claude` paths), one to open a file in the system editor. Add a shared `MarkdownViewer` modal component. Wire click handlers into `SkillsPanel` and `MyAgentsTab`. Skills API gains `filePath` so the client knows which file to fetch.

**Tech Stack:** Express (server), React + CSS Modules pattern (client), Node `child_process.exec` for system open, existing fetch-based `api` client.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `src/server/api/skills.ts` | Add `filePath` to `SkillEntry` |
| Create | `src/server/api/file-content.ts` | `GET /api/file-content?path=` — read raw file, restricted to `.claude` |
| Create | `src/server/api/open-file.ts` | `POST /api/open-file` — open path in system editor |
| Modify | `src/server/index.ts` | Register two new routers |
| Modify | `client/src/lib/api.ts` | Add `api.fileContent(path)` and `api.openFile(path)` |
| Create | `client/src/components/MarkdownViewer.tsx` | Modal: raw markdown display + Open in editor button |
| Create | `client/src/components/MarkdownViewer.css` | Modal styles |
| Modify | `client/src/components/sidebar/SkillsPanel.tsx` | Click card → open modal |
| Modify | `client/src/components/sidebar/MyAgentsTab.tsx` | Click card → open modal |

---

### Task 1: Add `filePath` to `SkillEntry` and skills API response

**Files:**
- Modify: `src/server/api/skills.ts`

- [ ] **Step 1: Add `filePath` to the `SkillEntry` interface**

In `src/server/api/skills.ts`, change:

```ts
export interface SkillEntry {
  slug: string
  name: string
  description: string
  source: 'user' | 'plugin'
  namespacedSlug: string
}
```

to:

```ts
export interface SkillEntry {
  slug: string
  name: string
  description: string
  source: 'user' | 'plugin'
  namespacedSlug: string
  filePath: string
}
```

- [ ] **Step 2: Populate `filePath` in the user skills scan**

In the user skills loop (around line 30), change:

```ts
skills.push({ slug, name: ..., description: ..., source: 'user', namespacedSlug: slug })
```

to:

```ts
skills.push({ slug, name: ..., description: ..., source: 'user', namespacedSlug: slug, filePath: skillFile })
```

- [ ] **Step 3: Populate `filePath` in the plugin skills scan**

In the plugin skills loop (around line 50), change:

```ts
skills.push({ slug, name: ..., description: ..., source: 'plugin', namespacedSlug: `${pluginName}:${slug}` })
```

to:

```ts
skills.push({ slug, name: ..., description: ..., source: 'plugin', namespacedSlug: `${pluginName}:${slug}`, filePath: skillFile })
```

- [ ] **Step 4: Verify the server builds**

```bash
cd /Users/fayzanmalik/Documents/GitHub/claude-workflow-composer
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/server/api/skills.ts
git commit -m "feat: add filePath to SkillEntry response"
```

---

### Task 2: Create `GET /api/file-content` endpoint

**Files:**
- Create: `src/server/api/file-content.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Create the endpoint file**

Create `src/server/api/file-content.ts`:

```ts
import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

export function fileContentRouter() {
  const router = createRouter()

  router.get('/', async (req, res) => {
    const filePath = req.query['path'] as string | undefined
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter required' })
      return
    }

    // Restrict to .claude directory to prevent arbitrary file reads.
    // Use claudeDir + path.sep to avoid matching ~/.claudeevil/ etc.
    const homeDir = os.homedir()
    const claudeDir = path.join(homeDir, '.claude')
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(claudeDir + path.sep)) {
      res.status(403).json({ error: 'Access restricted to .claude directory' })
      return
    }

    try {
      const content = await fs.readFile(resolved, 'utf-8')
      res.json({ content })
    } catch {
      res.status(404).json({ error: 'File not found' })
    }
  })

  return router
}
```

- [ ] **Step 2: Register the router in `src/server/index.ts`**

Add import at top:
```ts
import { fileContentRouter } from './api/file-content.js'
```

Add route after the skills router:
```ts
app.use('/api/file-content', fileContentRouter())
```

- [ ] **Step 3: Verify the server builds**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/server/api/file-content.ts src/server/index.ts
git commit -m "feat: add GET /api/file-content endpoint"
```

---

### Task 3: Create `POST /api/open-file` endpoint

**Files:**
- Create: `src/server/api/open-file.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Create the endpoint file**

Create `src/server/api/open-file.ts`:

```ts
import { Router as createRouter } from 'express'
import * as path from 'node:path'
import * as os from 'node:os'
import { exec } from 'node:child_process'

export function openFileRouter() {
  const router = createRouter()

  router.post('/', (req, res) => {
    const { path: filePath } = req.body as { path?: string }
    if (!filePath) {
      res.status(400).json({ error: 'path body field required' })
      return
    }

    // Restrict to .claude directory.
    // Use claudeDir + path.sep to avoid matching ~/.claudeevil/ etc.
    const claudeDir = path.join(os.homedir(), '.claude')
    const resolved = path.resolve(filePath)
    if (!resolved.startsWith(claudeDir + path.sep)) {
      res.status(403).json({ error: 'Access restricted to .claude directory' })
      return
    }

    // Use platform-appropriate open command
    const cmd = process.platform === 'darwin' ? `open "${resolved}"` : `xdg-open "${resolved}"`
    exec(cmd, (err) => {
      if (err) {
        res.status(500).json({ error: 'Failed to open file' })
        return
      }
      res.json({ opened: true })
    })
  })

  return router
}
```

- [ ] **Step 2: Register the router in `src/server/index.ts`**

Add import:
```ts
import { openFileRouter } from './api/open-file.js'
```

Add route:
```ts
app.use('/api/open-file', openFileRouter())
```

- [ ] **Step 3: Verify build**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/server/api/open-file.ts src/server/index.ts
git commit -m "feat: add POST /api/open-file endpoint"
```

---

### Task 4: Add client API methods

**Files:**
- Modify: `client/src/lib/api.ts`

- [ ] **Step 1: Add `fileContent` and `openFile` to the api object**

In `client/src/lib/api.ts`, add to the `api` export object:

```ts
fileContent: (filePath: string) =>
  req<{ content: string }>('GET', `/file-content?path=${encodeURIComponent(filePath)}`),

openFile: (filePath: string) =>
  req<{ opened: boolean }>('POST', '/open-file', { path: filePath }),
```

- [ ] **Step 2: Verify TypeScript is happy**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/api.ts
git commit -m "feat: add fileContent and openFile api methods"
```

---

### Task 5: Create `MarkdownViewer` modal component

**Files:**
- Create: `client/src/components/MarkdownViewer.tsx`
- Create: `client/src/components/MarkdownViewer.css`

- [ ] **Step 1: Create the CSS file**

Create `client/src/components/MarkdownViewer.css`:

```css
.markdown-viewer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.markdown-viewer {
  background: var(--color-surface, #1e1e1e);
  border: 1px solid var(--color-border, #333);
  border-radius: 8px;
  width: min(720px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.markdown-viewer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border, #333);
  flex-shrink: 0;
}

.markdown-viewer__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text, #e0e0e0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  margin-right: 12px;
}

.markdown-viewer__actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.markdown-viewer__open-btn {
  font-size: 12px;
  padding: 4px 10px;
  background: var(--color-accent, #4a9eff);
  color: #fff;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.markdown-viewer__open-btn:hover {
  opacity: 0.85;
}

.markdown-viewer__close-btn {
  font-size: 16px;
  line-height: 1;
  background: none;
  border: none;
  color: var(--color-text-muted, #888);
  cursor: pointer;
  padding: 4px 6px;
}

.markdown-viewer__close-btn:hover {
  color: var(--color-text, #e0e0e0);
}

.markdown-viewer__body {
  overflow-y: auto;
  flex: 1;
  padding: 0;
}

.markdown-viewer__pre {
  margin: 0;
  padding: 16px;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text, #e0e0e0);
  white-space: pre-wrap;
  word-break: break-word;
}

.markdown-viewer__loading,
.markdown-viewer__error {
  padding: 24px 16px;
  font-size: 13px;
  color: var(--color-text-muted, #888);
  text-align: center;
}

.markdown-viewer__error {
  color: var(--color-error, #f87171);
}
```

- [ ] **Step 2: Create the component**

Create `client/src/components/MarkdownViewer.tsx`:

```tsx
import React, { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.ts'
import './MarkdownViewer.css'

interface Props {
  filePath: string
  title: string
  onClose: () => void
}

export function MarkdownViewer({ filePath, title, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.fileContent(filePath)
      .then((r) => setContent(r.content))
      .catch(() => setError('Could not load file content.'))
  }, [filePath])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose()
  }

  async function handleOpen() {
    try {
      await api.openFile(filePath)
    } catch {
      // silently ignore — file may open fine even if response fails
    }
  }

  return (
    <div className="markdown-viewer-overlay" ref={overlayRef} onClick={handleOverlayClick}>
      <div className="markdown-viewer" role="dialog" aria-modal="true" aria-label={title}>
        <div className="markdown-viewer__header">
          <span className="markdown-viewer__title">{title}</span>
          <div className="markdown-viewer__actions">
            <button className="markdown-viewer__open-btn" onClick={handleOpen}>
              Open in editor
            </button>
            <button className="markdown-viewer__close-btn" onClick={onClose} aria-label="Close">
              ×
            </button>
          </div>
        </div>
        <div className="markdown-viewer__body">
          {!content && !error && <div className="markdown-viewer__loading">Loading…</div>}
          {error && <div className="markdown-viewer__error">{error}</div>}
          {content && <pre className="markdown-viewer__pre">{content}</pre>}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add client/src/components/MarkdownViewer.tsx client/src/components/MarkdownViewer.css
git commit -m "feat: add MarkdownViewer modal component"
```

---

### Task 6: Wire `MarkdownViewer` into `SkillsPanel`

**Files:**
- Modify: `client/src/components/sidebar/SkillsPanel.tsx`

- [ ] **Step 1: Add state and import**

At the top of `SkillsPanel.tsx`, add:

```tsx
import { MarkdownViewer } from '../MarkdownViewer.tsx'
```

Inside the component, add state:

```tsx
const [viewing, setViewing] = useState<{ filePath: string; title: string } | null>(null)
```

- [ ] **Step 2: Add drag-guard ref and make cards clickable**

The cards are already `draggable`. Without a guard, finishing a drag gesture fires `onClick` and opens the modal unintentionally. Add a ref at the top of the component:

```tsx
const isDragging = useRef(false)
```

On each skill card `div`, add three handlers (keep existing `onDragStart`):

```tsx
onDragStart={(e) => { isDragging.current = true; /* existing setData call */ }}
onDragEnd={() => { isDragging.current = false }}
onClick={() => { if (!isDragging.current) setViewing({ filePath: skill.filePath, title: skill.name }) }}
```

Do NOT change `.skills-panel__card`'s cursor in the CSS — it already has `cursor: grab` which is correct for draggable items.

- [ ] **Step 3: Render the modal**

At the bottom of the component return, before the closing `</div>`, add:

```tsx
{viewing && (
  <MarkdownViewer
    filePath={viewing.filePath}
    title={viewing.title}
    onClose={() => setViewing(null)}
  />
)}
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add client/src/components/sidebar/SkillsPanel.tsx
git commit -m "feat: click skill card to view markdown"
```

---

### Task 7: Wire `MarkdownViewer` into `MyAgentsTab`

**Files:**
- Modify: `client/src/components/sidebar/MyAgentsTab.tsx`

- [ ] **Step 1: Add state and import**

At the top of `MyAgentsTab.tsx`, add:

```tsx
import { MarkdownViewer } from '../MarkdownViewer.tsx'
```

Inside the component, add state:

```tsx
const [viewing, setViewing] = useState<{ filePath: string; title: string } | null>(null)
```

- [ ] **Step 2: Add drag-guard ref and make cards clickable**

Same drag-guard pattern as SkillsPanel. Add a ref at the top of the component:

```tsx
const isDragging = useRef(false)
```

On each agent card `div`, keep existing `draggable` and `onDragStart`, then add:

```tsx
onDragStart={(e) => { isDragging.current = true; /* existing setData call */ }}
onDragEnd={() => { isDragging.current = false }}
onClick={() => { if (!isDragging.current) setViewing({ filePath: agent.filePath, title: agent.name }) }}
```

The card already has `cursor: grab` via CSS — do not override it.

- [ ] **Step 3: Render the modal**

At the bottom of the component return, before the closing `</div>`, add:

```tsx
{viewing && (
  <MarkdownViewer
    filePath={viewing.filePath}
    title={viewing.title}
    onClose={() => setViewing(null)}
  />
)}
```

- [ ] **Step 4: Verify TypeScript**

```bash
cd client && npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add client/src/components/sidebar/MyAgentsTab.tsx
git commit -m "feat: click agent card to view markdown"
```

---

### Task 8: Smoke test end-to-end

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

- [ ] **Step 2: Open app in browser, navigate to editor**

Open a workflow. In the sidebar, switch to the Skills tab.

- [ ] **Step 3: Click a skill card**

Expected: modal opens, shows full SKILL.md content

- [ ] **Step 4: Click "Open in editor"**

Expected: file opens in system editor (VS Code, TextEdit, etc.)

- [ ] **Step 5: Press Escape**

Expected: modal closes

- [ ] **Step 6: Click outside the modal**

Expected: modal closes

- [ ] **Step 7: Switch to My Agents tab, click an agent card**

Expected: agent's markdown file content shown in modal

- [ ] **Step 8: Final commit if any fixes were needed**

```bash
git add -p
git commit -m "fix: smoke test corrections for markdown viewer"
```
