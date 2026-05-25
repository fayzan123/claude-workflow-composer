import { describe, it, expect } from 'vitest'
import { generateOrchestratorBody } from '../src/prose-generator.js'
import type { CwcNode, CwcEdge, CwcArtifact } from '../src/schema.js'

const node = (id: string, name: string, startTrigger?: string): CwcNode => ({
  id,
  position: { x: 0, y: 0 },
  exportedSlug: null,
  startTrigger,
  agent: { name, description: '', completionCriteria: '' },
})

const artifact = (name: string, type: CwcArtifact['type'] = 'text', path?: string): CwcArtifact => ({
  name, type, ...(path ? { path } : {}),
})

const edge = (from: string, to: string | null, trigger: string, context?: CwcArtifact[]): CwcEdge => ({
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

  it('appends Pass the ... forward for text artifacts', () => {
    const nodes = [node('A', 'Dev', 'to build'), node('B', 'QA')]
    const edges = [edge('A', 'B', 'When done, activate QA.', [artifact('schema'), artifact('api-spec')])]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('Pass the schema and api-spec forward.')
  })

  it('includes file path in artifact label for file artifacts', () => {
    const nodes = [node('A', 'Dev', 'to build'), node('B', 'QA')]
    const edges = [edge('A', 'B', 'When done, activate QA.', [artifact('Design Doc', 'file', 'docs/design.md')])]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('Pass the Design Doc (`docs/design.md`) forward.')
  })

  it('Oxford-comma joins three context items', () => {
    const nodes = [node('A', 'Dev', 'to build'), node('B', 'QA')]
    const edges = [edge('A', 'B', 'When done, activate QA.', [artifact('a'), artifact('b'), artifact('c')])]
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
      edge('B', 'A', 'If fail, return to Dev.', [artifact('feedback')]),
    ]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    const lines = body.split('\n').filter(l => /^\d+\./.test(l))
    const backEdgeIdx = lines.findIndex(l => l.includes('return to'))
    const passIdx = lines.findIndex(l => l.includes('If pass'))
    expect(backEdgeIdx).toBeGreaterThan(passIdx)
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
