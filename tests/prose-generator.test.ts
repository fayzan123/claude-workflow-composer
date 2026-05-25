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
