# Per-Workflow Model-Invocation Opt-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user opt a single workflow into autonomous Claude model-invocation, defaulting to off (current safe behavior), so its exported `SKILL.md` omits `disable-model-invocation: true` only when explicitly enabled.

**Architecture:** Mirror the existing `observability?: { enabled: boolean }` precedent end-to-end. A new optional `CwcMeta.modelInvocation: 'off' | 'auto'` (absent = off) is resolved to a boolean at the two export call sites and threaded into `buildWorkflowSkillContent`, which conditionally emits the frontmatter line. The client exposes a default-off checkbox in the export modal via the existing `SET_META` dispatch.

**Tech Stack:** TypeScript, Node `fs/promises`, Vitest (real temp filesystems, no mocks), React 19, `gray-matter` for frontmatter parsing in tests.

## Global Constraints

- Default is OFF: absent or `'off'` → `SKILL.md` keeps `disable-model-invocation: true`. Only `'auto'` omits it. (verbatim safety contract)
- Schema flag is a string enum `'off' | 'auto'`, NOT a boolean — leaves room for a future `'recommend'` mode with no migration.
- No gating: opt-in is allowed for any workflow regardless of whether it has an approval gate.
- Tests use real temp filesystems via `fs.mkdtemp`/`fs.mkdir` — no mocks for filesystem operations.
- Preview (`export-preview.ts`) MUST produce identical frontmatter to real export (`exporter.ts`).
- This repo has NO client-side tests; the UI task is verified by `npm run typecheck` + manual check, not an automated test.
- Run the full suite with `npm test`; a single file with `npx vitest run tests/<file>.test.ts`.

---

### Task 1: Conditional frontmatter in `buildWorkflowSkillContent`

**Files:**
- Modify: `src/file-writer.ts:85-100` (`buildWorkflowSkillContent`)
- Test: `tests/file-writer.test.ts` (extend the existing `describe('buildWorkflowSkillContent', …)` block at line 131)

**Interfaces:**
- Consumes: nothing new.
- Produces: `buildWorkflowSkillContent(name: string, description: string, orchestratorBody: string, workflowId: string, allowModelInvocation?: boolean): string` — new 5th parameter defaults to `false`. When `false`/omitted, output contains `disable-model-invocation: true`; when `true`, that line is absent. Task 2 calls this with the resolved boolean.

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside the existing `describe('buildWorkflowSkillContent', () => { … })` in `tests/file-writer.test.ts`:

```ts
  it('omits disable-model-invocation when model invocation is allowed', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'body', 'wf-uuid', true)
    expect(content).not.toContain('disable-model-invocation')
  })

  it('keeps disable-model-invocation: true when model invocation is explicitly disallowed', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'body', 'wf-uuid', false)
    expect(content).toContain('disable-model-invocation: true')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/file-writer.test.ts -t "model invocation"`
Expected: the "omits" test FAILS — current code always emits `disable-model-invocation: true`, so `not.toContain` fails. (The "keeps … false" test passes already, since the 5th arg is currently ignored.)

- [ ] **Step 3: Add the parameter and make the line conditional**

In `src/file-writer.ts`, replace the function signature and frontmatter array:

```ts
export function buildWorkflowSkillContent(
  name: string,
  description: string,
  orchestratorBody: string,
  workflowId: string,
  allowModelInvocation = false,
): string {
  const frontmatter = [
    '---',
    `name: ${yamlScalar(name)}`,
    `description: ${yamlScalar(description)}`,
    ...(allowModelInvocation ? [] : ['disable-model-invocation: true']),
    '---',
  ].join('\n')

  return `${frontmatter}\n\n${orchestratorBody}\n<!-- cwc:workflow:${workflowId} -->`
}
```

- [ ] **Step 4: Run the file-writer tests to verify they pass**

Run: `npx vitest run tests/file-writer.test.ts`
Expected: PASS. The pre-existing 4-argument tests (e.g. "produces skill with disable-model-invocation: true") still pass because the new param defaults to `false`.

- [ ] **Step 5: Commit**

```bash
git add src/file-writer.ts tests/file-writer.test.ts
git commit -m "feat(file-writer): conditional disable-model-invocation via allowModelInvocation flag"
```

---

### Task 2: Schema field + thread through both export call sites

**Files:**
- Modify: `src/schema.ts:26-36` (`CwcMeta`)
- Modify: `src/exporter.ts:182`
- Modify: `src/server/api/export-preview.ts:71`
- Test: `tests/exporter.test.ts` (add to the `describe('exportWorkflow — linear.cwc', …)` block, alongside the existing test at line 101)

**Interfaces:**
- Consumes: `buildWorkflowSkillContent(…, allowModelInvocation)` from Task 1.
- Produces: `CwcMeta.modelInvocation?: 'off' | 'auto'`. Both export paths resolve `meta.modelInvocation === 'auto'` to the boolean passed to `buildWorkflowSkillContent`. Task 3 (UI) writes this field via `SET_META`.

- [ ] **Step 1: Write the failing tests**

Add these two `it` blocks inside `describe('exportWorkflow — linear.cwc', () => { … })` in `tests/exporter.test.ts`:

```ts
  it('omits disable-model-invocation when meta.modelInvocation is auto', async () => {
    const cwc = await loadFixture('linear.cwc')
    cwc.meta.modelInvocation = 'auto'
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-linear-pipeline', 'SKILL.md'),
      'utf-8',
    )
    expect(skillContent).not.toContain('disable-model-invocation')
  })

  it("keeps disable-model-invocation: true when meta.modelInvocation is 'off'", async () => {
    const cwc = await loadFixture('linear.cwc')
    cwc.meta.modelInvocation = 'off'
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'cwc-linear-pipeline', 'SKILL.md'),
      'utf-8',
    )
    expect(matter(skillContent).data['disable-model-invocation']).toBe(true)
  })
```

(The absent-flag default-safe case is already covered by the existing test "workflow skill has disable-model-invocation: true and correct fields" at line 101.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/exporter.test.ts -t "modelInvocation"`
Expected: the "auto" test FAILS — the exporter ignores the field, so `disable-model-invocation` is still present. (TypeScript may also flag `cwc.meta.modelInvocation` until Step 3 adds it to the type; the JSON fixture loads as `any`, so the assignment itself compiles, but add the schema field in Step 3 regardless.)

- [ ] **Step 3: Add the schema field**

In `src/schema.ts`, add to `CwcMeta` immediately after the `observability` line (line 33):

```ts
  modelInvocation?: 'off' | 'auto'       // absent = 'off' (SKILL.md keeps disable-model-invocation: true)
```

- [ ] **Step 4: Resolve and pass the flag in the real exporter**

In `src/exporter.ts`, replace the `buildWorkflowSkillContent` call at line 182:

```ts
  const allowModelInvocation = cwc.meta.modelInvocation === 'auto'
  const skillContent = buildWorkflowSkillContent(
    cwc.meta.name, cwc.meta.description, orchestratorBody, workflowId, allowModelInvocation,
  )
```

- [ ] **Step 5: Resolve and pass the flag in the preview endpoint**

In `src/server/api/export-preview.ts`, replace the `buildWorkflowSkillContent` call at line 71:

```ts
      const allowModelInvocation = cwcFile.meta.modelInvocation === 'auto'
      const skillContent = buildWorkflowSkillContent(
        cwcFile.meta.name, cwcFile.meta.description, orchestratorBody, workflowId, allowModelInvocation,
      )
```

NOTE: keep the first four arguments exactly as they were before in `export-preview.ts` — only append `, allowModelInvocation`. If the original call was `buildWorkflowSkillContent(cwcFile.meta.name, cwcFile.meta.description, orchestratorBody, workflowId)`, the new call is that plus `, allowModelInvocation`. Do not otherwise alter the first four args.

- [ ] **Step 6: Run the exporter tests + full suite to verify they pass**

Run: `npx vitest run tests/exporter.test.ts`
Expected: PASS (new auto/off tests + existing line-101 absent-default test all green).

Run: `npm test`
Expected: full suite PASS (547+ tests).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors in server or client tsconfigs.

- [ ] **Step 8: Commit**

```bash
git add src/schema.ts src/exporter.ts src/server/api/export-preview.ts tests/exporter.test.ts
git commit -m "feat(export): per-workflow modelInvocation flag threaded into SKILL.md frontmatter"
```

---

### Task 3: Export modal toggle + help copy + warning styling

**Files:**
- Modify: `client/src/components/ExportFlow.tsx` (after the observability `FieldHint` at line 184)
- Modify: `client/src/lib/help-copy.ts` (`CONTROL_HINTS` map, around line 52)
- Modify: `client/src/components/ExportFlow.css` (after `.export-flow__obs-toggle` at line 486)

**Interfaces:**
- Consumes: `CwcMeta.modelInvocation` (Task 2); existing `SET_META` reducer action (`useWorkflow.ts:25`, payload type `Partial<CwcFile['meta']>`); existing `FieldHint` component and `CONTROL_HINTS` lookup.
- Produces: a default-off checkbox that sets `meta.modelInvocation` to `'auto'`/`'off'`; persisted automatically by `useAutoSave`. No new exported symbols.

- [ ] **Step 1: Add the help-copy entry**

In `client/src/lib/help-copy.ts`, add to the `CONTROL_HINTS` map immediately after the `'export.observability'` line:

```ts
  'export.modelInvocation': 'Lets Claude discover and run this workflow on its own. Off is safer — on means it runs without CWC\'s isolated-run harness.',
```

- [ ] **Step 2: Add the toggle + warning to the export modal**

In `client/src/components/ExportFlow.tsx`, immediately after the existing `<FieldHint id="export.observability" />` (line 184), insert:

```tsx
            <label className="export-flow__obs-toggle export-flow__invoke-toggle">
              <input
                type="checkbox"
                checked={workflow.meta.modelInvocation === 'auto'}
                onChange={(e) =>
                  dispatch({ type: 'SET_META', payload: { modelInvocation: e.target.checked ? 'auto' : 'off' } })
                }
              />
              Let Claude run this workflow automatically (no isolated-run safety)
            </label>
            <FieldHint id="export.modelInvocation" />
            {workflow.meta.modelInvocation === 'auto' && (
              <p className="export-flow__invoke-warning">
                Claude can invoke this workflow on its own — it runs in your real working
                directory with no worktree isolation, no run tracking, and no stop control.
                Leave this off unless you want autonomous execution.
              </p>
            )}
```

(Verify the in-scope identifiers `workflow` and `dispatch` match those already used by the observability toggle a few lines above — they do at lines 177-179. Reuse the exact same names.)

- [ ] **Step 3: Add the warning style**

In `client/src/components/ExportFlow.css`, after the `.export-flow__obs-toggle { … }` rule (ends ~line 495), add:

```css
.export-flow__invoke-warning {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-warning-light);
  color: var(--color-warning-dark);
  font-size: var(--text-sm);
  line-height: 1.5;
}
```

(These warning custom properties already exist — used in `client/src/components/Canvas.css:107-108`. Per `DESIGN.md`, amber/warning is the correct hue for caution.)

- [ ] **Step 4: Typecheck the client**

Run: `npm run typecheck`
Expected: no errors. (`SET_META` accepts `Partial<CwcFile['meta']>`, and `modelInvocation` is now a valid optional key from Task 2.)

- [ ] **Step 5: Manual verification (no client tests exist)**

Run the dev stack (`npm run dev:server`, `npm run dev:api`, `npm run dev:client`), open the export modal:
- Confirm the new checkbox is UNCHECKED by default for a fresh workflow.
- Check it → the amber warning appears; reopen the modal → it stays checked (autosaved).
- Uncheck it → warning disappears.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/ExportFlow.tsx client/src/lib/help-copy.ts client/src/components/ExportFlow.css
git commit -m "feat(client): export-modal toggle for per-workflow model invocation with warning"
```

---

### Task 4: Migration note in project memory

**Files:**
- Modify: `/Users/fayzanmalik/.claude/projects/-Users-fayzanmalik-Documents-GitHub-claude-workflow-composer/memory/project-state.md` (and its `MEMORY.md` index line)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Record the migration behavior**

Add a line to the project-state memory noting: existing `.cwc` files and already-exported `SKILL.md`s have no `modelInvocation` → treated as `'off'` → stay safe-by-default with `disable-model-invocation: true`; opting a workflow in requires a re-export to regenerate its `SKILL.md`. No automatic migration is performed or needed.

- [ ] **Step 2: No commit needed** (memory lives outside the repo).

---

## Self-Review

**1. Spec coverage:**
- Schema enum `'off' | 'auto'`, absent = off → Task 2 Step 3. ✓
- Conditional frontmatter line → Task 1. ✓
- Both call sites (exporter + preview) resolve the flag identically → Task 2 Steps 4-5. ✓
- Client default-off toggle with honest warning + FieldHint, warning hue per DESIGN.md → Task 3. ✓
- No gating, no recommender → not implemented (correctly out of scope). ✓
- Migration note → Task 4. ✓
- Tests cover both frontmatter branches in file-writer (Task 1) and exporter (Task 2). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code and exact commands. ✓

**3. Type consistency:** `buildWorkflowSkillContent(name, description, orchestratorBody, workflowId, allowModelInvocation?)` is defined in Task 1 and called with the appended boolean in Task 2 (both sites). `CwcMeta.modelInvocation: 'off' | 'auto'` defined in Task 2 Step 3 and read in Steps 4-5 and Task 3. `SET_META` payload type matches. ✓
