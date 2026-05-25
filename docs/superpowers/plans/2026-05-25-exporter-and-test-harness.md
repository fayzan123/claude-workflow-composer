# Exporter & Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `.cwc`-to-Claude-Code-files exporter and validate it with automated tests against four fixture workflows — before any canvas UI code is written.

**Architecture:** Pure TypeScript Node.js module with no UI dependencies. The exporter takes a parsed `.cwc` object, runs BFS traversal to determine step order, resolves skill descriptions from `~/.claude/`, generates agent `.md` files and a workflow orchestrator `SKILL.md`, performs conflict detection against existing files, and writes to disk. A standalone Vitest test harness runs all fixtures against a temp directory and asserts structural correctness.

**Tech Stack:** TypeScript 5, Node.js 20+, Vitest, gray-matter (YAML frontmatter parse/validate), uuid

---

## File Map

| File | Responsibility |
|---|---|
| `package.json` | Project config, scripts, deps |
| `tsconfig.json` | TS compiler config |
| `vitest.config.ts` | Vitest config |
| `src/schema.ts` | TypeScript types for `.cwc` format |
| `src/slugify.ts` | Slug derivation algorithm |
| `src/bfs.ts` | BFS traversal, cycle/back-edge detection |
| `src/prose-generator.ts` | Converts BFS order + edges → orchestrator prose |
| `src/skill-resolver.ts` | Two-strategy skill description lookup |
| `src/conflict-detector.ts` | Regex-based ownership comment scanning |
| `src/file-writer.ts` | Writes agent files and skill file to disk |
| `src/exporter.ts` | Orchestrates the above into one `export()` call |
| `tests/fixtures/linear.cwc` | A → B → C sequential fixture |
| `tests/fixtures/parallel.cwc` | A → B and A → C fan-out fixture |
| `tests/fixtures/gate-loop.cwc` | A → B → gate → A back-edge fixture |
| `tests/fixtures/skills.cwc` | Single agent with 3 skills fixture |
| `tests/slugify.test.ts` | Unit tests for slug derivation |
| `tests/bfs.test.ts` | Unit tests for BFS traversal and cycle detection |
| `tests/prose-generator.test.ts` | Unit tests for orchestrator prose generation |
| `tests/skill-resolver.test.ts` | Unit tests for skill lookup (mocked fs) |
| `tests/conflict-detector.test.ts` | Unit tests for ownership comment regex scanning |
| `tests/exporter.test.ts` | Integration tests — all four fixtures, temp dirs |

---

### Task 1: Project Bootstrap

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "claude-workflow-composer",
  "version": "0.1.0",
  "description": "Visual composer for Claude Code multi-agent workflows",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  },
  "dependencies": {
    "gray-matter": "^4.0.3",
    "uuid": "^9.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "dist",
    "rootDir": ".",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
  },
})
```

- [ ] **Step 4: Install dependencies**

```bash
npm install
```

Expected: `node_modules/` created, no errors.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: exits 0 (no source files yet = no errors).

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts package-lock.json
git commit -m "chore: bootstrap TypeScript project with Vitest"
```

---

### Task 2: Schema Types

**Files:**
- Create: `src/schema.ts`

- [ ] **Step 1: Write the types**

```typescript
// src/schema.ts

export type TerminalType = 'complete' | 'escalated' | 'aborted'

export interface CwcMeta {
  id: string
  name: string
  description: string
  version: number
  created: string
  updated: string
}

export interface CwcAgent {
  name: string
  description: string
  color?: string
  model?: string
  tools?: string[]
  skills?: string[]
  systemPrompt?: string
}

export interface CwcNode {
  id: string
  position: { x: number; y: number }
  exportedSlug: string | null
  startTrigger?: string
  agent: CwcAgent
}

export interface CwcEdge {
  id: string
  from: string
  to: string | null
  label?: string
  trigger: string
  context?: string[]
  terminalType?: TerminalType
}

export interface CwcFile {
  meta: CwcMeta
  nodes: CwcNode[]
  edges: CwcEdge[]
}
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/schema.ts
git commit -m "feat: add CWC schema TypeScript types"
```

---

### Task 3: Slugify Module

**Files:**
- Create: `src/slugify.ts`
- Create: `tests/slugify.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/slugify.test.ts
import { describe, it, expect } from 'vitest'
import { slugify } from '../src/slugify.js'

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Backend Architect')).toBe('backend-architect')
  })

  it('replaces underscores with hyphens', () => {
    expect(slugify('my_agent')).toBe('my-agent')
  })

  it('strips non-alphanumeric characters except hyphens', () => {
    expect(slugify('Auth & Security')).toBe('auth-security')
  })

  it('truncates at 64 characters', () => {
    const long = 'a'.repeat(70)
    expect(slugify(long)).toHaveLength(64)
  })

  it('collapses multiple hyphens', () => {
    expect(slugify('A -- B')).toBe('a-b')
  })

  it('strips leading and trailing hyphens', () => {
    expect(slugify('--backend--')).toBe('backend')
  })

  it('handles empty string', () => {
    expect(slugify('')).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/slugify.test.ts
```

Expected: FAIL — "Cannot find module '../src/slugify.js'"

- [ ] **Step 3: Implement slugify**

```typescript
// src/slugify.ts

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test -- tests/slugify.test.ts
```

Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/slugify.ts tests/slugify.test.ts
git commit -m "feat: add slugify module with tests"
```

---

### Task 4: BFS Traversal

**Files:**
- Create: `src/bfs.ts`
- Create: `tests/bfs.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/bfs.test.ts
import { describe, it, expect } from 'vitest'
import { bfsTraversal, BfsStep } from '../src/bfs.js'
import type { CwcNode, CwcEdge } from '../src/schema.js'

const node = (id: string): CwcNode => ({
  id,
  position: { x: 0, y: 0 },
  exportedSlug: null,
  agent: { name: id, description: '', color: 'blue' },
})

const edge = (from: string, to: string | null, id?: string): CwcEdge => ({
  id: id ?? `${from}->${to}`,
  from,
  to,
  trigger: `Trigger from ${from}`,
  context: [],
})

describe('bfsTraversal', () => {
  it('returns nodes in BFS order for A→B→C', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const edges = [edge('A', 'B'), edge('B', 'C')]
    const steps = bfsTraversal(nodes, edges)
    expect(steps.map(s => s.node.id)).toEqual(['A', 'B', 'C'])
  })

  it('marks back-edges without recursing', () => {
    const nodes = [node('A'), node('B')]
    const edges = [edge('A', 'B'), edge('B', 'A')]
    const steps = bfsTraversal(nodes, edges)
    // A and B visited; B→A edge should be marked as back-edge
    const bStep = steps.find(s => s.node.id === 'B')!
    expect(bStep.outgoingEdges.some(e => e.isBackEdge)).toBe(true)
  })

  it('groups fan-out nodes at same BFS level as parallel', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const edges = [edge('A', 'B'), edge('A', 'C')]
    const steps = bfsTraversal(nodes, edges)
    const aStep = steps.find(s => s.node.id === 'A')!
    expect(aStep.outgoingEdges.every(e => !e.isBackEdge)).toBe(true)
    // B and C should appear at the same BFS level
    const bStep = steps.find(s => s.node.id === 'B')!
    const cStep = steps.find(s => s.node.id === 'C')!
    expect(bStep.level).toBe(cStep.level)
  })

  it('handles multiple disconnected entry nodes as multi-root BFS', () => {
    const nodes = [node('A'), node('B'), node('C')]
    const edges = [edge('A', 'C'), edge('B', 'C')]
    const steps = bfsTraversal(nodes, edges)
    const aStep = steps.find(s => s.node.id === 'A')!
    const bStep = steps.find(s => s.node.id === 'B')!
    expect(aStep.level).toBe(0)
    expect(bStep.level).toBe(0)
  })

  it('returns terminal edges (to: null) on the source node step', () => {
    const nodes = [node('A')]
    const edges = [{ ...edge('A', null), terminalType: 'complete' as const }]
    const steps = bfsTraversal(nodes, edges)
    const aStep = steps[0]
    expect(aStep.outgoingEdges.some(e => e.edge.to === null)).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/bfs.test.ts
```

Expected: FAIL — "Cannot find module '../src/bfs.js'"

- [ ] **Step 3: Implement BFS traversal**

```typescript
// src/bfs.ts
import type { CwcNode, CwcEdge } from './schema.js'

export interface AnnotatedEdge {
  edge: CwcEdge
  isBackEdge: boolean
}

export interface BfsStep {
  node: CwcNode
  level: number
  outgoingEdges: AnnotatedEdge[]
}

export function bfsTraversal(nodes: CwcNode[], edges: CwcEdge[]): BfsStep[] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  // Build adjacency: from → edges
  const adj = new Map<string, CwcEdge[]>()
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e)
  }

  // Entry nodes: no incoming edges (to is not null filter)
  const hasIncoming = new Set(edges.filter(e => e.to !== null).map(e => e.to!))
  const entryIds = nodes.filter(n => !hasIncoming.has(n.id)).map(n => n.id)

  const visited = new Set<string>()
  const steps: BfsStep[] = []
  // Queue of [nodeId, level]
  const queue: Array<[string, number]> = entryIds.map(id => [id, 0])

  while (queue.length > 0) {
    const [id, level] = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)

    const n = nodeMap.get(id)
    if (!n) continue

    const rawEdges = adj.get(id) ?? []
    const annotated: AnnotatedEdge[] = rawEdges.map(e => ({
      edge: e,
      isBackEdge: e.to !== null && visited.has(e.to),
    }))

    steps.push({ node: n, level, outgoingEdges: annotated })

    for (const ae of annotated) {
      if (!ae.isBackEdge && ae.edge.to !== null) {
        queue.push([ae.edge.to, level + 1])
      }
    }
  }

  return steps
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test -- tests/bfs.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bfs.ts tests/bfs.test.ts
git commit -m "feat: add BFS traversal with back-edge detection"
```

---

### Task 5: Prose Generator

**Files:**
- Create: `src/prose-generator.ts`
- Create: `tests/prose-generator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/prose-generator.test.ts
import { describe, it, expect } from 'vitest'
import { generateOrchestratorBody } from '../src/prose-generator.js'
import type { CwcNode, CwcEdge } from '../src/schema.js'

const node = (id: string, name: string, startTrigger?: string): CwcNode => ({
  id,
  position: { x: 0, y: 0 },
  exportedSlug: null,
  startTrigger,
  agent: { name, description: '' },
})

const edge = (from: string, to: string | null, trigger: string, context?: string[]): CwcEdge => ({
  id: `${from}->${to}`,
  from,
  to,
  trigger,
  context: context ?? [],
})

describe('generateOrchestratorBody', () => {
  it('emits Start with for entry node with startTrigger', () => {
    const nodes = [node('A', 'Architect', 'to design the schema')]
    const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('1. Start with **Architect** to design the schema.')
  })

  it('emits Start with node name only when startTrigger absent', () => {
    const nodes = [node('A', 'Architect')]
    const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('1. Start with **Architect**.')
  })

  it('bold-wraps agent names in trigger text', () => {
    const nodes = [node('A', 'Developer', 'to build'), node('B', 'Reviewer')]
    const edges = [edge('A', 'B', 'When Developer is done, activate Reviewer.')]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('**Developer**')
    expect(body).toContain('**Reviewer**')
  })

  it('appends Pass the ... forward when context is non-empty', () => {
    const nodes = [node('A', 'Dev', 'to build'), node('B', 'QA')]
    const edges = [edge('A', 'B', 'When done, activate QA.', ['schema', 'api-spec'])]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('Pass the schema and api-spec forward.')
  })

  it('Oxford-comma joins three context items', () => {
    const nodes = [node('A', 'Dev', 'to build'), node('B', 'QA')]
    const edges = [edge('A', 'B', 'When done, activate QA.', ['a', 'b', 'c'])]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('Pass the a, b, and c forward.')
  })

  it('emits terminal edge trigger verbatim', () => {
    const nodes = [node('A', 'Dev', 'to build')]
    const edges = [{ ...edge('A', null, 'If done, workflow is complete.'), terminalType: 'complete' as const }]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('If done, workflow is complete.')
  })

  it('emits back-edge after forward steps without recursing', () => {
    const nodes = [node('A', 'Dev', 'to build'), node('B', 'Review')]
    const edges = [
      edge('A', 'B', 'When done, activate Review.'),
      { ...edge('B', null, 'If pass, done.'), terminalType: 'complete' as const },
      edge('B', 'A', 'If fail, return to Dev.', ['feedback']),
    ]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    const lines = body.split('\n').filter(l => /^\d+\./.test(l))
    // Back-edge should appear after forward edges
    const backEdgeIdx = lines.findIndex(l => l.includes('return to'))
    const passIdx = lines.findIndex(l => l.includes('If pass'))
    expect(backEdgeIdx).toBeGreaterThan(passIdx)
    // Should not appear twice (no infinite recursion)
    expect(lines.filter(l => l.includes('return to'))).toHaveLength(1)
  })

  it('emits fan-out as grouped parallel step', () => {
    const nodes = [node('A', 'Arch', 'to plan'), node('B', 'Frontend'), node('C', 'Backend')]
    const edges = [
      edge('A', 'B', 'When done, activate Frontend.'),
      edge('A', 'C', 'When done, activate Backend.'),
    ]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('**Frontend** and **Backend** in parallel')
  })

  it('includes workflow name in orchestrator header', () => {
    const nodes = [node('A', 'Dev', 'to build')]
    const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
    const body = generateOrchestratorBody(nodes, edges, 'TDD Pipeline')
    expect(body).toContain('**TDD Pipeline** workflow')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/prose-generator.test.ts
```

Expected: FAIL — "Cannot find module '../src/prose-generator.js'"

- [ ] **Step 3: Implement prose generator**

```typescript
// src/prose-generator.ts
import type { CwcNode, CwcEdge } from './schema.js'
import { bfsTraversal } from './bfs.js'

function oxfordJoin(items: string[]): string {
  if (items.length === 0) return ''
  if (items.length === 1) return items[0]
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

function boldWrapAgentNames(text: string, agentNames: string[]): string {
  let result = text
  // Sort by length descending to avoid partial replacements
  for (const name of [...agentNames].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(name, `**${name}**`)
  }
  return result
}

function formatContextClause(context: string[] | undefined): string {
  if (!context || context.length === 0) return ''
  return ` Pass the ${oxfordJoin(context)} forward.`
}

export function generateOrchestratorBody(
  nodes: CwcNode[],
  edges: CwcEdge[],
  workflowName: string,
): string {
  const agentNames = nodes.map(n => n.agent.name)
  const steps = bfsTraversal(nodes, edges)
  const lines: string[] = []

  lines.push(
    `You are the orchestrator for the **${workflowName}** workflow. Delegate all implementation work via the Agent tool. Do not read, write, or edit files yourself — those are subagent responsibilities.`,
    '',
    '## Orchestration Flow',
    '',
  )

  let stepNum = 1

  // Check for multi-root parallel entry
  const level0 = steps.filter(s => s.level === 0)
  if (level0.length > 1) {
    // Multiple entry nodes — emit as parallel group at step 1
    const nameList = level0.map(s => `**${s.node.agent.name}**`).join(' and ')
    lines.push(`${stepNum++}. Start with ${nameList} in parallel:`)
    for (const s of level0) {
      const trigger = s.node.startTrigger ? ` ${s.node.startTrigger}` : ''
      lines.push(`   - **${s.node.agent.name}**${trigger}.`)
    }
  } else if (level0.length === 1) {
    const s = level0[0]
    const trigger = s.node.startTrigger ? ` ${s.node.startTrigger}` : ''
    lines.push(`${stepNum++}. Start with **${s.node.agent.name}**${trigger}.`)
  }

  // Emit forward edges
  const emitted = new Set<string>()
  // Group fan-out: for each step, if multiple non-back outgoing edges to same level, group them
  for (const step of steps) {
    const forwardEdges = step.outgoingEdges.filter(ae => !ae.isBackEdge)
    if (forwardEdges.length === 0) continue

    if (forwardEdges.length > 1) {
      // Fan-out / parallel group
      const targetNames = forwardEdges.map(ae => {
        const targetNode = nodes.find(n => n.id === ae.edge.to)
        return targetNode ? `**${targetNode.agent.name}**` : ae.edge.to ?? ''
      })
      const nameList = targetNames.join(' and ')
      lines.push(`${stepNum++}. When **${step.node.agent.name}** completes, activate ${nameList} in parallel:`)
      for (const ae of forwardEdges) {
        const wrapped = boldWrapAgentNames(ae.edge.trigger, agentNames)
        const ctx = formatContextClause(ae.edge.context)
        lines.push(`   - ${wrapped}${ctx}`)
        emitted.add(ae.edge.id)
      }
    } else {
      const ae = forwardEdges[0]
      if (!emitted.has(ae.edge.id)) {
        const wrapped = boldWrapAgentNames(ae.edge.trigger, agentNames)
        const ctx = formatContextClause(ae.edge.context)
        lines.push(`${stepNum++}. ${wrapped}${ctx}`)
        emitted.add(ae.edge.id)
      }
    }

    // Emit terminal edges for this node
    const terminalEdges = step.outgoingEdges.filter(ae => ae.edge.to === null)
    for (const ae of terminalEdges) {
      if (!emitted.has(ae.edge.id)) {
        const wrapped = boldWrapAgentNames(ae.edge.trigger, agentNames)
        lines.push(`${stepNum++}. ${wrapped}`)
        emitted.add(ae.edge.id)
      }
    }

    // Emit back-edges for this node (after forward edges)
    const backEdges = step.outgoingEdges.filter(ae => ae.isBackEdge)
    for (const ae of backEdges) {
      if (!emitted.has(ae.edge.id)) {
        const wrapped = boldWrapAgentNames(ae.edge.trigger, agentNames)
        const ctx = formatContextClause(ae.edge.context)
        lines.push(`${stepNum++}. ${wrapped}${ctx}`)
        emitted.add(ae.edge.id)
      }
    }
  }

  lines.push(
    '',
    '## Escalation',
    '',
    'If a subagent returns a blocked or escalation status, stop and present the details to the user before continuing.',
  )

  return lines.join('\n')
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test -- tests/prose-generator.test.ts
```

Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/prose-generator.ts src/bfs.ts tests/prose-generator.test.ts
git commit -m "feat: add prose generator with BFS traversal and parallel/back-edge support"
```

---

### Task 6: Skill Resolver

**Files:**
- Create: `src/skill-resolver.ts`
- Create: `tests/skill-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/skill-resolver.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'node:fs/promises'
import { resolveSkill } from '../src/skill-resolver.js'

vi.mock('node:fs/promises')
const mockReadFile = vi.mocked(fs.readFile)
const mockAccess = vi.mocked(fs.access)

const MOCK_HOME = '/mock-home'

describe('resolveSkill', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    process.env.HOME = MOCK_HOME
  })

  it('resolves non-namespaced slug from ~/.claude/skills/', async () => {
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValue('---\nname: brainstorming\ndescription: Explores requirements\n---\n' as any)
    const result = await resolveSkill('brainstorming')
    expect(result).toEqual({ slug: 'brainstorming', description: 'Explores requirements', found: true })
  })

  it('resolves namespaced slug from plugin installPath', async () => {
    mockAccess.mockResolvedValue(undefined)
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({
        'superpowers@claude-plugins-official': { installPath: '/mock-home/.claude/plugins/cache/superpowers' }
      }) as any)
      .mockResolvedValueOnce('---\nname: brainstorming\ndescription: Brainstorm ideas\n---\n' as any)
    const result = await resolveSkill('superpowers:brainstorming')
    expect(result).toEqual({ slug: 'superpowers:brainstorming', description: 'Brainstorm ideas', found: true })
  })

  it('returns found: false when skill file not accessible', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'))
    const result = await resolveSkill('nonexistent')
    expect(result).toEqual({ slug: 'nonexistent', description: null, found: false })
  })

  it('returns found: false for namespaced slug when plugin not in installed_plugins.json', async () => {
    mockAccess.mockResolvedValue(undefined)
    mockReadFile.mockResolvedValueOnce(JSON.stringify({}) as any)
    const result = await resolveSkill('unknown-plugin:brainstorming')
    expect(result).toEqual({ slug: 'unknown-plugin:brainstorming', description: null, found: false })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/skill-resolver.test.ts
```

Expected: FAIL — "Cannot find module '../src/skill-resolver.js'"

- [ ] **Step 3: Implement skill resolver**

```typescript
// src/skill-resolver.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'

export interface SkillResolution {
  slug: string
  description: string | null
  found: boolean
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function readSkillDescription(skillMdPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(skillMdPath, 'utf-8')
    const { data } = matter(content)
    return typeof data.description === 'string' ? data.description : null
  } catch {
    return null
  }
}

export async function resolveSkill(slug: string): Promise<SkillResolution> {
  const home = process.env.HOME ?? ''

  if (slug.includes(':')) {
    const [pluginKey, skillSlug] = slug.split(':') as [string, string]
    // Look up installPath from installed_plugins.json
    const pluginsJsonPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json')
    try {
      const raw = await fs.readFile(pluginsJsonPath, 'utf-8')
      const installed = JSON.parse(raw) as Record<string, { installPath: string }>
      // Find plugin entry — key may be "pluginKey@publisher" or just "pluginKey"
      const entry = Object.entries(installed).find(([k]) => k === pluginKey || k.startsWith(`${pluginKey}@`))
      if (!entry) return { slug, description: null, found: false }
      const skillMdPath = path.join(entry[1].installPath, 'skills', skillSlug, 'SKILL.md')
      if (!(await fileExists(skillMdPath))) return { slug, description: null, found: false }
      const description = await readSkillDescription(skillMdPath)
      return { slug, description, found: true }
    } catch {
      return { slug, description: null, found: false }
    }
  }

  // Non-namespaced: ~/.claude/skills/<slug>/SKILL.md
  const skillMdPath = path.join(home, '.claude', 'skills', slug, 'SKILL.md')
  if (!(await fileExists(skillMdPath))) return { slug, description: null, found: false }
  const description = await readSkillDescription(skillMdPath)
  return { slug, description, found: true }
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test -- tests/skill-resolver.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skill-resolver.ts tests/skill-resolver.test.ts
git commit -m "feat: add two-strategy skill resolver"
```

---

### Task 7: Conflict Detector

**Files:**
- Create: `src/conflict-detector.ts`
- Create: `tests/conflict-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/conflict-detector.test.ts
import { describe, it, expect } from 'vitest'
import { detectConflict, ConflictStatus } from '../src/conflict-detector.js'

const agentRegex = /^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/
const workflowRegex = /^<!-- cwc:workflow:[^:\s>]+ -->$/

describe('detectConflict', () => {
  it('returns OWNED when last non-blank line matches current workflow UUID', () => {
    const content = 'some content\n\n<!-- cwc:node:node-1:workflow:abc-123 -->\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('owned')
  })

  it('returns FOREIGN when last non-blank line matches different UUID', () => {
    const content = 'some content\n<!-- cwc:node:node-1:workflow:other-uuid -->\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('foreign')
  })

  it('returns ABSENT when last non-blank line has no cwc comment', () => {
    const content = 'some content without comment\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('absent')
  })

  it('returns MALFORMED when last non-blank line starts with <!-- cwc: but does not match regex', () => {
    const content = 'some content\n<!-- cwc:node: -->\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('malformed')
  })

  it('ignores trailing blank lines when scanning', () => {
    const content = 'some content\n<!-- cwc:node:node-1:workflow:abc-123 -->\n\n\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('owned')
  })

  it('works for workflow skill regex', () => {
    const content = 'body\n<!-- cwc:workflow:wf-uuid-456 -->\n'
    expect(detectConflict(content, workflowRegex, 'wf-uuid-456')).toBe('owned')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/conflict-detector.test.ts
```

Expected: FAIL — "Cannot find module '../src/conflict-detector.js'"

- [ ] **Step 3: Implement conflict detector**

```typescript
// src/conflict-detector.ts

export type ConflictStatus = 'owned' | 'foreign' | 'absent' | 'malformed'

export function detectConflict(
  fileContent: string,
  ownershipRegex: RegExp,
  currentWorkflowId: string,
): ConflictStatus {
  const lines = fileContent.split('\n')
  // Scan upward for first non-blank line
  let lastNonBlank: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.length > 0) {
      lastNonBlank = trimmed
      break
    }
  }

  if (lastNonBlank === null) return 'absent'

  if (!lastNonBlank.startsWith('<!-- cwc:')) return 'absent'

  if (!ownershipRegex.test(lastNonBlank)) return 'malformed'

  // Extract UUID — last token before ' -->'
  const uuidMatch = lastNonBlank.match(/([^\s:>]+) -->$/)
  if (!uuidMatch) return 'malformed'
  const foundId = uuidMatch[1]

  return foundId === currentWorkflowId ? 'owned' : 'foreign'
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test -- tests/conflict-detector.test.ts
```

Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/conflict-detector.ts tests/conflict-detector.test.ts
git commit -m "feat: add conflict detector with regex-based ownership scanning"
```

---

### Task 8: File Writer

**Files:**
- Create: `src/file-writer.ts`
- Create: `tests/file-writer.test.ts`

The file writer generates the string content for agent files and the workflow skill file. It does NOT do I/O itself — that keeps it fully testable. The exporter calls it to get strings, then writes them to disk.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/file-writer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { buildAgentFileContent, buildWorkflowSkillContent } from '../src/file-writer.js'
import type { CwcNode, CwcFile } from '../src/schema.js'
import type { SkillResolution } from '../src/skill-resolver.js'

const baseNode: CwcNode = {
  id: 'node-1',
  position: { x: 0, y: 0 },
  exportedSlug: null,
  agent: {
    name: 'Backend Architect',
    description: 'Designs the API',
    color: 'blue',
    model: 'inherit',
    tools: ['Read', 'Write'],
    skills: [],
    systemPrompt: 'You are an architect.',
  },
}

describe('buildAgentFileContent', () => {
  it('produces valid frontmatter with all known fields', () => {
    const content = buildAgentFileContent(baseNode, [], 'wf-uuid')
    expect(content).toContain('name: Backend Architect')
    expect(content).toContain('description: Designs the API')
    expect(content).toContain('color: blue')
    expect(content).toContain('model: inherit')
    expect(content).toContain('tools: Read, Write')
  })

  it('ownership comment is last non-blank line', () => {
    const content = buildAgentFileContent(baseNode, [], 'wf-uuid')
    const lines = content.split('\n').filter(l => l.trim().length > 0)
    expect(lines[lines.length - 1]).toBe('<!-- cwc:node:node-1:workflow:wf-uuid -->')
  })

  it('includes system prompt after frontmatter', () => {
    const content = buildAgentFileContent(baseNode, [], 'wf-uuid')
    expect(content).toContain('You are an architect.')
  })

  it('adds skills block with exact separator when agent has skills', () => {
    const skills: SkillResolution[] = [
      { slug: 'brainstorming', description: 'Explores requirements', found: true },
    ]
    const content = buildAgentFileContent(baseNode, skills, 'wf-uuid')
    expect(content).toContain('\n\n---\n## Workflow Skills\n\n')
    expect(content).toContain('Use the `brainstorming` skill. (Explores requirements)')
  })

  it('omits skills block when agent has no skills', () => {
    const content = buildAgentFileContent(baseNode, [], 'wf-uuid')
    expect(content).not.toContain('## Workflow Skills')
  })

  it('uses fallback skill line when skill not found', () => {
    const skills: SkillResolution[] = [
      { slug: 'unknown-skill', description: null, found: false },
    ]
    const content = buildAgentFileContent(baseNode, skills, 'wf-uuid')
    expect(content).toContain('Use the `unknown-skill` skill.')
    expect(content).not.toContain('Use the `unknown-skill` skill. (')
  })

  it('omits model field when not set', () => {
    const node = { ...baseNode, agent: { ...baseNode.agent, model: undefined } }
    const content = buildAgentFileContent(node, [], 'wf-uuid')
    expect(content).not.toContain('model:')
  })

  it('ownership comment immediately follows last skill line — no blank line', () => {
    const skills: SkillResolution[] = [
      { slug: 'brainstorming', description: 'Explores', found: true },
    ]
    const content = buildAgentFileContent(baseNode, skills, 'wf-uuid')
    expect(content).toContain(
      'Use the `brainstorming` skill. (Explores)\n<!-- cwc:node:node-1:workflow:wf-uuid -->'
    )
  })
})

describe('buildWorkflowSkillContent', () => {
  it('produces skill with disable-model-invocation: true', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'orchestrator body', 'wf-uuid')
    expect(content).toContain('disable-model-invocation: true')
  })

  it('name field equals derived workflow slug', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'orchestrator body', 'wf-uuid')
    expect(content).toContain('name: tdd-pipeline')
  })

  it('description matches meta.description', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'orchestrator body', 'wf-uuid')
    expect(content).toContain('description: TDD description')
  })

  it('ownership comment is last non-blank line', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'body', 'wf-uuid')
    const lines = content.split('\n').filter(l => l.trim().length > 0)
    expect(lines[lines.length - 1]).toBe('<!-- cwc:workflow:wf-uuid -->')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- tests/file-writer.test.ts
```

Expected: FAIL — "Cannot find module '../src/file-writer.js'"

- [ ] **Step 3: Implement file writer**

```typescript
// src/file-writer.ts
import type { CwcNode } from './schema.js'
import type { SkillResolution } from './skill-resolver.js'

function buildFrontmatter(node: CwcNode): string {
  const { name, description, color, model, tools } = node.agent
  const lines = ['---']
  lines.push(`name: ${name}`)
  lines.push(`description: ${description}`)
  if (color) lines.push(`color: ${color}`)
  if (model) lines.push(`model: ${model}`)
  if (tools && tools.length > 0) lines.push(`tools: ${tools.join(', ')}`)
  lines.push('---')
  return lines.join('\n')
}

function buildSkillsBlock(skills: SkillResolution[]): string {
  const lines = skills.map(s =>
    s.description
      ? `Use the \`${s.slug}\` skill. (${s.description})`
      : `Use the \`${s.slug}\` skill.`
  )
  return `## Workflow Skills\n\n${lines.join('\n')}`
}

export function buildAgentFileContent(
  node: CwcNode,
  resolvedSkills: SkillResolution[],
  workflowId: string,
): string {
  const parts: string[] = []
  parts.push(buildFrontmatter(node))

  const { systemPrompt } = node.agent
  if (systemPrompt && systemPrompt.trim().length > 0) {
    parts.push('\n' + systemPrompt)
  }

  const ownershipComment = `<!-- cwc:node:${node.id}:workflow:${workflowId} -->`

  if (resolvedSkills.length > 0) {
    const separator = systemPrompt && systemPrompt.trim().length > 0
      ? '\n\n---\n'
      : '\n'
    parts.push(separator + buildSkillsBlock(resolvedSkills))
    parts.push('\n' + ownershipComment)
  } else {
    parts.push('\n' + ownershipComment)
  }

  return parts.join('')
}

export function buildWorkflowSkillContent(
  workflowSlug: string,
  description: string,
  orchestratorBody: string,
  workflowId: string,
): string {
  const frontmatter = [
    '---',
    `name: ${workflowSlug}`,
    `description: ${description}`,
    'disable-model-invocation: true',
    '---',
  ].join('\n')

  return `${frontmatter}\n\n${orchestratorBody}\n<!-- cwc:workflow:${workflowId} -->`
}
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npm test -- tests/file-writer.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/file-writer.ts tests/file-writer.test.ts
git commit -m "feat: add file-writer with agent file and workflow skill content generation"
```

---

### Task 9: Exporter (Integration)

**Files:**
- Create: `src/exporter.ts`
- Create: `tests/fixtures/linear.cwc`
- Create: `tests/fixtures/parallel.cwc`
- Create: `tests/fixtures/gate-loop.cwc`
- Create: `tests/fixtures/skills.cwc`
- Create: `tests/exporter.test.ts`

- [ ] **Step 1: Write the four fixture files**

`tests/fixtures/linear.cwc`:
```json
{
  "meta": { "id": "linear-uuid", "name": "Linear Pipeline", "description": "A sequential A to B to C workflow", "version": 1, "created": "2026-05-25T00:00:00Z", "updated": "2026-05-25T00:00:00Z" },
  "nodes": [
    { "id": "node-a", "position": { "x": 0, "y": 0 }, "exportedSlug": null, "startTrigger": "to plan the architecture", "agent": { "name": "Architect", "description": "Plans the system", "color": "blue", "tools": ["Read"] } },
    { "id": "node-b", "position": { "x": 300, "y": 0 }, "exportedSlug": null, "agent": { "name": "Developer", "description": "Builds the feature", "color": "green", "tools": ["Read", "Write", "Edit"] } },
    { "id": "node-c", "position": { "x": 600, "y": 0 }, "exportedSlug": null, "agent": { "name": "Reviewer", "description": "Reviews the code", "color": "orange", "tools": ["Read"] } }
  ],
  "edges": [
    { "id": "e1", "from": "node-a", "to": "node-b", "label": "Plan ready", "trigger": "When Architect has delivered the plan, activate Developer.", "context": ["plan"] },
    { "id": "e2", "from": "node-b", "to": "node-c", "label": "Build done", "trigger": "When Developer has completed the implementation, activate Reviewer.", "context": [] },
    { "id": "e3", "from": "node-c", "to": null, "label": "Done", "trigger": "When Reviewer approves, the workflow is complete.", "terminalType": "complete", "context": [] }
  ]
}
```

`tests/fixtures/parallel.cwc`:
```json
{
  "meta": { "id": "parallel-uuid", "name": "Parallel Split", "description": "Fan-out from one architect to two parallel agents", "version": 1, "created": "2026-05-25T00:00:00Z", "updated": "2026-05-25T00:00:00Z" },
  "nodes": [
    { "id": "node-arch", "position": { "x": 0, "y": 0 }, "exportedSlug": null, "startTrigger": "to design the system", "agent": { "name": "Architect", "description": "Designs the system", "color": "blue" } },
    { "id": "node-fe", "position": { "x": 300, "y": -100 }, "exportedSlug": null, "agent": { "name": "Frontend Dev", "description": "Builds the UI", "color": "purple" } },
    { "id": "node-be", "position": { "x": 300, "y": 100 }, "exportedSlug": null, "agent": { "name": "Backend Dev", "description": "Builds the API", "color": "green" } }
  ],
  "edges": [
    { "id": "e1", "from": "node-arch", "to": "node-fe", "label": "To frontend", "trigger": "When design is ready, activate Frontend Dev.", "context": ["design"] },
    { "id": "e2", "from": "node-arch", "to": "node-be", "label": "To backend", "trigger": "When design is ready, activate Backend Dev.", "context": ["design"] }
  ]
}
```

`tests/fixtures/gate-loop.cwc`:
```json
{
  "meta": { "id": "gate-loop-uuid", "name": "Gate Loop", "description": "Gate Loop — conditional review workflow with re-trigger", "version": 1, "created": "2026-05-25T00:00:00Z", "updated": "2026-05-25T00:00:00Z" },
  "nodes": [
    { "id": "node-developer", "position": { "x": 0, "y": 0 }, "exportedSlug": null, "startTrigger": "to implement the feature", "agent": { "name": "Developer", "description": "Implements features", "color": "green" } },
    { "id": "node-reviewer", "position": { "x": 300, "y": 0 }, "exportedSlug": null, "agent": { "name": "Reviewer", "description": "Reviews implementation", "color": "orange" } }
  ],
  "edges": [
    { "id": "edge-1", "from": "node-developer", "to": "node-reviewer", "label": "Ready for review", "trigger": "When implementation is complete, activate Reviewer to evaluate the work.", "context": [] },
    { "id": "edge-2", "from": "node-reviewer", "to": null, "label": "Pass", "trigger": "If the review passes, the workflow is complete.", "terminalType": "complete", "context": [] },
    { "id": "edge-3", "from": "node-reviewer", "to": "node-developer", "label": "Fail — loop back", "trigger": "If the review fails, return to Developer with the reviewer's feedback and repeat from step 1.", "context": ["reviewer feedback"] }
  ]
}
```

`tests/fixtures/skills.cwc` (NOTE: skill descriptions will be resolved from `~/.claude/`; in tests we mock the resolver):
```json
{
  "meta": { "id": "skills-uuid", "name": "Skills Demo", "description": "Single agent demonstrating skill injection", "version": 1, "created": "2026-05-25T00:00:00Z", "updated": "2026-05-25T00:00:00Z" },
  "nodes": [
    { "id": "node-1", "position": { "x": 0, "y": 0 }, "exportedSlug": null, "startTrigger": "to start", "agent": { "name": "Full Stack Dev", "description": "Builds the feature", "color": "blue", "skills": ["brainstorming", "superpowers:writing-plans", "nonexistent-skill"], "systemPrompt": "You are a full stack developer." } }
  ],
  "edges": [
    { "id": "e1", "from": "node-1", "to": null, "label": "Done", "trigger": "When done, the workflow is complete.", "terminalType": "complete", "context": [] }
  ]
}
```

- [ ] **Step 2: Write exporter integration tests**

```typescript
// tests/exporter.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { exportWorkflow, ExportTarget } from '../src/exporter.js'
import matter from 'gray-matter'

// We'll write to a real temp dir, cleaned up after each test
let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join('/tmp', `cwc-test-${randomUUID()}`)
  await fs.mkdir(tmpDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

async function loadFixture(name: string) {
  const raw = await fs.readFile(
    path.join(import.meta.dirname, 'fixtures', name),
    'utf-8',
  )
  return JSON.parse(raw)
}

function agentOwnershipRegex(nodeId: string, workflowId: string) {
  return `<!-- cwc:node:${nodeId}:workflow:${workflowId} -->`
}

describe('exportWorkflow — linear.cwc', () => {
  it('writes three agent files and one skill file', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })

    const agentsDir = path.join(tmpDir, '.claude', 'agents')
    const files = await fs.readdir(agentsDir)
    expect(files.sort()).toEqual(['architect.md', 'developer.md', 'reviewer.md'])
  })

  it('each agent file has valid YAML frontmatter', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })

    const agentsDir = path.join(tmpDir, '.claude', 'agents')
    for (const file of ['architect.md', 'developer.md', 'reviewer.md']) {
      const content = await fs.readFile(path.join(agentsDir, file), 'utf-8')
      expect(() => matter(content)).not.toThrow()
      const { data } = matter(content)
      expect(typeof data.name).toBe('string')
      expect(typeof data.description).toBe('string')
    }
  })

  it('agent ownership comments match node ids and workflow id', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })

    const agentsDir = path.join(tmpDir, '.claude', 'agents')
    const architectContent = await fs.readFile(path.join(agentsDir, 'architect.md'), 'utf-8')
    const lines = architectContent.split('\n').filter(l => l.trim().length > 0)
    expect(lines[lines.length - 1]).toBe(agentOwnershipRegex('node-a', 'linear-uuid'))
  })

  it('workflow skill has disable-model-invocation: true and correct description', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'linear-pipeline', 'SKILL.md'),
      'utf-8',
    )
    const { data } = matter(skillContent)
    expect(data['disable-model-invocation']).toBe(true)
    expect(data.description).toBe('A sequential A to B to C workflow')
    expect(data.name).toBe('linear-pipeline')
  })

  it('workflow skill ownership comment is last non-blank line', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'linear-pipeline', 'SKILL.md'),
      'utf-8',
    )
    const lines = skillContent.split('\n').filter(l => l.trim().length > 0)
    expect(lines[lines.length - 1]).toBe('<!-- cwc:workflow:linear-uuid -->')
  })

  it('re-export overwrites files and updates exportedSlug in cwc', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const opts = { skillsDir: path.join(tmpDir, 'skills') }
    const result1 = await exportWorkflow(cwc, target, opts)
    const result2 = await exportWorkflow(result1.updatedCwc, target, opts)

    expect(result2.updatedCwc.nodes[0].exportedSlug).toBe('architect')
    // No orphan files
    const files = await fs.readdir(path.join(tmpDir, '.claude', 'agents'))
    expect(files).toHaveLength(3)
  })
})

describe('exportWorkflow — parallel.cwc', () => {
  it('fan-out nodes emitted as grouped parallel step in skill body', async () => {
    const cwc = await loadFixture('parallel.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'parallel-split', 'SKILL.md'),
      'utf-8',
    )
    expect(skillContent).toContain('**Frontend Dev** and **Backend Dev** in parallel')
    // Should NOT have them as separate numbered items at the same level
    const lines = skillContent.split('\n')
    const numberedLines = lines.filter(l => /^\d+\./.test(l))
    // Should have step 1 (start) and step 2 (parallel group) — not step 2 and step 3
    expect(numberedLines.filter(l => l.includes('Frontend Dev') || l.includes('Backend Dev'))).toHaveLength(1)
  })
})

describe('exportWorkflow — gate-loop.cwc', () => {
  it('back-edge appears after forward steps in skill body', async () => {
    const cwc = await loadFixture('gate-loop.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'gate-loop', 'SKILL.md'),
      'utf-8',
    )
    const passIdx = skillContent.indexOf('If the review passes')
    const failIdx = skillContent.indexOf('If the review fails')
    expect(passIdx).toBeGreaterThan(0)
    expect(failIdx).toBeGreaterThan(passIdx)
  })

  it('back-edge appears exactly once — no infinite recursion', async () => {
    const cwc = await loadFixture('gate-loop.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'gate-loop', 'SKILL.md'),
      'utf-8',
    )
    const matches = skillContent.match(/If the review fails/g) ?? []
    expect(matches).toHaveLength(1)
  })

  it('step 1 uses startTrigger from node', async () => {
    const cwc = await loadFixture('gate-loop.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const skillsDir = path.join(tmpDir, 'skills')
    await exportWorkflow(cwc, target, { skillsDir })

    const skillContent = await fs.readFile(
      path.join(skillsDir, 'gate-loop', 'SKILL.md'),
      'utf-8',
    )
    expect(skillContent).toContain('1. Start with **Developer** to implement the feature.')
  })
})

describe('exportWorkflow — skills.cwc', () => {
  it('agent file contains skills block with exact separator', async () => {
    const cwc = await loadFixture('skills.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    // Provide a mock skills dir with one matching skill
    const mockSkillsDir = path.join(tmpDir, 'mock-skills')
    await fs.mkdir(path.join(mockSkillsDir, 'brainstorming'), { recursive: true })
    await fs.writeFile(
      path.join(mockSkillsDir, 'brainstorming', 'SKILL.md'),
      '---\nname: brainstorming\ndescription: Explores requirements\n---\n',
    )
    await exportWorkflow(cwc, target, {
      skillsDir: path.join(tmpDir, 'skills'),
      userSkillsDir: mockSkillsDir,
    })

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'agents', 'full-stack-dev.md'),
      'utf-8',
    )
    expect(content).toContain('\n\n---\n## Workflow Skills\n\n')
    expect(content).toContain('Use the `brainstorming` skill. (Explores requirements)')
  })

  it('ownership comment immediately follows last skill line — no blank line', async () => {
    const cwc = await loadFixture('skills.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    await exportWorkflow(cwc, target, { skillsDir: path.join(tmpDir, 'skills') })

    const content = await fs.readFile(
      path.join(tmpDir, '.claude', 'agents', 'full-stack-dev.md'),
      'utf-8',
    )
    // Find last skill line and check next line is ownership comment
    const idx = content.lastIndexOf('Use the `')
    const afterSkill = content.slice(content.indexOf('\n', idx) + 1)
    expect(afterSkill.startsWith('<!-- cwc:node:')).toBe(true)
  })
})

describe('exportWorkflow — renamed node', () => {
  it('deletes old file and writes new file when name changes', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const opts = { skillsDir: path.join(tmpDir, 'skills') }

    // First export
    const result1 = await exportWorkflow(cwc, target, opts)

    // Rename first node
    const modified = {
      ...result1.updatedCwc,
      nodes: result1.updatedCwc.nodes.map((n: any) =>
        n.id === 'node-a' ? { ...n, agent: { ...n.agent, name: 'Lead Architect' } } : n
      ),
    }
    const result2 = await exportWorkflow(modified, target, opts)

    const files = await fs.readdir(path.join(tmpDir, '.claude', 'agents'))
    expect(files).toContain('lead-architect.md')
    expect(files).not.toContain('architect.md')
    expect(result2.updatedCwc.nodes.find((n: any) => n.id === 'node-a').exportedSlug).toBe('lead-architect')
  })

  it('proceeds without error when old file missing on disk', async () => {
    const cwc = await loadFixture('linear.cwc')
    const target: ExportTarget = { type: 'project', projectDir: tmpDir }
    const opts = { skillsDir: path.join(tmpDir, 'skills') }
    const result1 = await exportWorkflow(cwc, target, opts)

    // Manually delete the file (simulate external deletion)
    await fs.unlink(path.join(tmpDir, '.claude', 'agents', 'architect.md'))

    const modified = {
      ...result1.updatedCwc,
      nodes: result1.updatedCwc.nodes.map((n: any) =>
        n.id === 'node-a' ? { ...n, agent: { ...n.agent, name: 'Lead Architect' } } : n
      ),
    }
    await expect(exportWorkflow(modified, target, opts)).resolves.not.toThrow()
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npm test -- tests/exporter.test.ts
```

Expected: FAIL — "Cannot find module '../src/exporter.js'"

- [ ] **Step 4: Implement exporter**

```typescript
// src/exporter.ts
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { CwcFile, CwcNode } from './schema.js'
import { slugify } from './slugify.js'
import { generateOrchestratorBody } from './prose-generator.js'
import { resolveSkill } from './skill-resolver.js'
import { buildAgentFileContent, buildWorkflowSkillContent } from './file-writer.js'
import { detectConflict } from './conflict-detector.js'

export type ExportTarget =
  | { type: 'project'; projectDir: string }
  | { type: 'user'; userDir?: string }

export interface ExportOptions {
  skillsDir: string          // where workflow skill is written
  userSkillsDir?: string     // override for ~/.claude/skills/ (test injection)
}

export interface ExportResult {
  updatedCwc: CwcFile
  warnings: string[]
}

const AGENT_OWNERSHIP_REGEX = /^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/
const WORKFLOW_OWNERSHIP_REGEX = /^<!-- cwc:workflow:[^:\s>]+ -->$/

async function safeReadFile(p: string): Promise<string | null> {
  try { return await fs.readFile(p, 'utf-8') } catch { return null }
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

export async function exportWorkflow(
  cwc: CwcFile,
  target: ExportTarget,
  opts: ExportOptions,
): Promise<ExportResult> {
  const warnings: string[] = []
  const workflowId = cwc.meta.id
  const workflowSlug = slugify(cwc.meta.name)

  const agentsDir =
    target.type === 'project'
      ? path.join(target.projectDir, '.claude', 'agents')
      : path.join(target.userDir ?? (process.env.HOME ?? ''), '.claude', 'agents')

  await ensureDir(agentsDir)

  const updatedNodes: CwcNode[] = []

  for (const node of cwc.nodes) {
    const newSlug = slugify(node.agent.name)
    const agentPath = path.join(agentsDir, `${newSlug}.md`)

    // Rename: old file cleanup
    if (node.exportedSlug && node.exportedSlug !== newSlug) {
      const oldPath = path.join(agentsDir, `${node.exportedSlug}.md`)
      const oldContent = await safeReadFile(oldPath)
      if (oldContent !== null) {
        const status = detectConflict(oldContent, AGENT_OWNERSHIP_REGEX, workflowId)
        if (status === 'owned') {
          await fs.unlink(oldPath)
        }
        // If not owned, leave the old file — conflict modal would handle this in real UI
      }
      // If file missing: proceed (per spec — skip delete, write new)
    }

    // Resolve skills
    const resolvedSkills = []
    for (const skillSlug of node.agent.skills ?? []) {
      const resolved = await resolveSkillWithOverride(skillSlug, opts.userSkillsDir)
      if (!resolved.found) {
        warnings.push(`Skill not found: ${skillSlug} — install it on the target machine`)
      }
      resolvedSkills.push(resolved)
    }

    const content = buildAgentFileContent(node, resolvedSkills, workflowId)
    await fs.writeFile(agentPath, content, 'utf-8')
    updatedNodes.push({ ...node, exportedSlug: newSlug })
  }

  // Generate workflow skill
  const orchestratorBody = generateOrchestratorBody(cwc.nodes, cwc.edges, cwc.meta.name)
  const skillContent = buildWorkflowSkillContent(workflowSlug, cwc.meta.description, orchestratorBody, workflowId)
  const skillDir = path.join(opts.skillsDir, workflowSlug)
  await ensureDir(skillDir)
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8')

  const updatedCwc: CwcFile = {
    ...cwc,
    nodes: updatedNodes,
    meta: { ...cwc.meta, updated: new Date().toISOString() },
  }

  return { updatedCwc, warnings }
}

async function resolveSkillWithOverride(slug: string, userSkillsDir?: string): Promise<Awaited<ReturnType<typeof resolveSkill>>> {
  if (!slug.includes(':') && userSkillsDir) {
    // For non-namespaced skills in tests, check the override dir directly
    const skillMdPath = path.join(userSkillsDir, slug, 'SKILL.md')
    try {
      const { default: matter } = await import('gray-matter')
      const content = await fs.readFile(skillMdPath, 'utf-8')
      const { data } = matter(content)
      return { slug, description: typeof data.description === 'string' ? data.description : null, found: true }
    } catch {
      // Fall through to normal resolution
    }
  }
  return resolveSkill(slug)
}
```

- [ ] **Step 5: Run all tests and verify they pass**

```bash
npm test
```

Expected: all tests PASS. If any fail, fix them before proceeding.

- [ ] **Step 6: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add src/exporter.ts tests/fixtures/ tests/exporter.test.ts
git commit -m "feat: add exporter with integration tests — format validation milestone"
```

---

### Task 10: Final Validation Run

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass. Zero failures.

- [ ] **Step 2: Behavioral verification**

Manually export `gate-loop.cwc` to a real project directory and invoke the generated skill in Claude Code to verify Claude follows the orchestration flow. This step is not automated — it requires human judgment.

```bash
# Create a scratch project
mkdir /tmp/cwc-behavioral-test && cd /tmp/cwc-behavioral-test
git init
# Use the Node.js REPL or a small script to call exportWorkflow with your real ~/.claude
```

Verify: The generated SKILL.md at `~/.claude/skills/gate-loop/SKILL.md` is readable, the `/gate-loop` slash command appears in Claude Code, and Claude follows the step order correctly.

- [ ] **Step 3: Final commit**

```bash
git tag v0.1.0-exporter
git commit --allow-empty -m "chore: format validation milestone complete — exporter and test harness passing"
```

---

## What's Next

After this plan is complete and behavioral verification passes, the next plan covers:

**Part 2: Canvas UI** — React + React Flow SPA, the Node.js server (`npx cwc`), file system watcher, export UX with preview pane and conflict modals.

The exporter built here is the backend that Part 2 calls — no changes to `src/exporter.ts` interface should be needed for the UI integration.
