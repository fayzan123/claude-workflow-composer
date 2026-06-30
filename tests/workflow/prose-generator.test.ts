import { describe, it, expect } from 'vitest'
import { generateOrchestratorBody, OverrideInfo } from '../../src/workflow/prose-generator.js'
import type { CwcNode, CwcEdge, CwcArtifact } from '../../src/schema.js'

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
  it('emits Invoke with subagent_type for entry node with startTrigger', () => {
    const nodes = [node('A', 'Architect', 'to design the schema')]
    const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('**Architect**')
    expect(body).toContain('subagent_type: "architect"')
    expect(body).toContain('to design the schema')
  })

  it('emits Invoke with subagent_type for entry node without startTrigger', () => {
    const nodes = [node('A', 'Architect')]
    const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
    const body = generateOrchestratorBody(nodes, edges, 'My Workflow')
    expect(body).toContain('**Architect**')
    expect(body).toContain('subagent_type: "architect"')
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

  describe('node overrides', () => {
    it('emits override annotation for entry node with skills', () => {
      const nodes = [node('A', 'Frontend Dev', 'to build the UI')]
      const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
      const overrides: Record<string, OverrideInfo> = { A: { skills: ['design-system', 'tailwind'] } }
      const body = generateOrchestratorBody(nodes, edges, 'Test', overrides)
      expect(body).toContain('Workflow-specific configuration: additional skills (design-system, tailwind).')
    })

    it('emits override annotation for entry node with tools', () => {
      const nodes = [node('A', 'Dev')]
      const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
      const overrides: Record<string, OverrideInfo> = { A: { tools: ['Read', 'Write', 'Edit'] } }
      const body = generateOrchestratorBody(nodes, edges, 'Test', overrides)
      expect(body).toContain('Workflow-specific configuration: tools (Read, Write, Edit).')
    })

    it('emits override annotation with skills + tools + prompt combined', () => {
      const nodes = [node('A', 'Dev')]
      const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
      const overrides: Record<string, OverrideInfo> = {
        A: { skills: ['testing'], tools: ['Bash'], systemPrompt: 'You are a tester.' },
      }
      const body = generateOrchestratorBody(nodes, edges, 'Test', overrides)
      expect(body).toContain('additional skills (testing)')
      expect(body).toContain('tools (Bash)')
      expect(body).toContain('prompt "You are a tester."')
    })

    it('emits no annotation when overrides are empty', () => {
      const nodes = [node('A', 'Dev')]
      const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
      const overrides: Record<string, OverrideInfo> = {}
      const body = generateOrchestratorBody(nodes, edges, 'Test', overrides)
      expect(body).not.toContain('Workflow-specific configuration')
    })

    it('emits override annotation for fan-out target nodes', () => {
      const nodes = [node('A', 'Arch'), node('B', 'Frontend'), node('C', 'Backend')]
      const edges = [edge('A', 'B', 'Activate Frontend.'), edge('A', 'C', 'Activate Backend.')]
      const overrides: Record<string, OverrideInfo> = {
        B: { skills: ['react'] },
        C: { skills: ['api-design'] },
      }
      const body = generateOrchestratorBody(nodes, edges, 'Test', overrides)
      expect(body).toContain('additional skills (react)')
      expect(body).toContain('additional skills (api-design)')
      // override annotation follows the fan-out sub-item
      const lines = body.split('\n')
      const reactLine = lines.findIndex(l => l.includes('additional skills (react)'))
      const frontendLine = lines.findIndex(l => l.includes('**Frontend**'))
      expect(reactLine).toBeGreaterThan(frontendLine)
    })

    it('emits override annotation for back-edge target node', () => {
      const nodes = [node('A', 'Dev'), node('B', 'Review')]
      const edges = [
        edge('A', 'B', 'Activate Review.'),
        { ...edge('B', 'A', 'If fail, return to Dev.'), context: [artifact('feedback')] },
      ]
      const overrides: Record<string, OverrideInfo> = { A: { skills: ['fix-code'] } }
      const body = generateOrchestratorBody(nodes, edges, 'Test', overrides)
      expect(body).toContain('Workflow-specific configuration: additional skills (fix-code).')
    })

    it('emits completion criteria in override annotation', () => {
      const nodes = [node('A', 'Dev')]
      const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
      const overrides: Record<string, OverrideInfo> = { A: { completionCriteria: 'All tests pass' } }
      const body = generateOrchestratorBody(nodes, edges, 'Test', overrides)
      expect(body).toContain('Workflow-specific configuration: completion "All tests pass".')
    })

    it('truncates long system prompt in override annotation', () => {
      const longPrompt = 'x'.repeat(200)
      const nodes = [node('A', 'Dev')]
      const edges = [{ ...edge('A', null, 'Done.'), terminalType: 'complete' as const }]
      const overrides: Record<string, OverrideInfo> = { A: { systemPrompt: longPrompt } }
      const body = generateOrchestratorBody(nodes, edges, 'Test', overrides)
      expect(body).toContain('"xxx')
      expect(body).toContain('...')
    })
  })
})

describe('run logging instrumentation', () => {
  const nodes = [
    { id: 'n1', position: { x: 0, y: 0 }, exportedSlug: 'researcher', agent: { name: 'Researcher', description: '', completionCriteria: 'done' } },
    { id: 'n2', position: { x: 1, y: 0 }, exportedSlug: 'writer', agent: { name: 'Writer', description: '', completionCriteria: 'done' } },
  ]
  const edges = [
    { id: 'e1', from: 'n1', to: 'n2', trigger: 'Research is complete.' },
    { id: 'e2', from: 'n2', to: null, trigger: 'Draft delivered.', terminalType: 'complete' as const },
  ]
  const obs = { workflowId: 'wf-abc', workflowSlug: 'cwc-pipeline' }

  it('emits a Run Logging section with the curl template and run id rule', () => {
    const body = generateOrchestratorBody(nodes as never, edges as never, 'Pipeline', {}, { observability: obs })
    expect(body).toContain('## Run Logging')
    expect(body).toContain('http://localhost:3579/api/runs/events')
    expect(body).toContain('-m 1')
    expect(body).toContain('|| true')
    expect(body).toContain('"workflowId":"wf-abc"')
    expect(body).toContain('"workflowSlug":"cwc-pipeline"')
    expect(body).toMatch(/run-\$\(date \+%s\)/)
  })

  it('lists every node with its id and slug for step events', () => {
    const body = generateOrchestratorBody(nodes as never, edges as never, 'Pipeline', {}, { observability: obs })
    expect(body).toContain('`n1` → agent `researcher`')
    expect(body).toContain('`n2` → agent `writer`')
    expect(body).toContain('step_started')
    expect(body).toContain('step_completed')
    expect(body).toContain('run_completed')
  })

  it('emits nothing when observability is not passed', () => {
    const body = generateOrchestratorBody(nodes as never, edges as never, 'Pipeline', {})
    expect(body).not.toContain('## Run Logging')
    expect(body).not.toContain('/api/runs/events')
  })
})

describe('approval gates', () => {
  const nodes = [
    { id: 'n1', position: { x: 0, y: 0 }, exportedSlug: 'researcher', agent: { name: 'Researcher', description: '', completionCriteria: 'done' } },
    { id: 'g1', position: { x: 1, y: 0 }, exportedSlug: null, nodeType: 'gate' as const, agent: { name: 'Review plan', description: 'summarize the planned changes', completionCriteria: '' } },
    { id: 'n2', position: { x: 2, y: 0 }, exportedSlug: 'writer', agent: { name: 'Writer', description: '', completionCriteria: 'done' } },
  ]
  const edges = [
    { id: 'e1', from: 'n1', to: 'g1', trigger: 'Research is complete.' },
    { id: 'e2', from: 'g1', to: 'n2', trigger: 'Write the report.' },
    { id: 'e3', from: 'n2', to: null, trigger: 'Done.', terminalType: 'complete' as const },
  ]

  it('emits pause prose for the gate instead of an Agent invocation', () => {
    const body = generateOrchestratorBody(nodes as never, edges as never, 'Flow', {})
    expect(body).toContain('Approval gate "Review plan"')
    expect(body).toContain('commit all work so far')
    expect(body).toContain('awaiting_approval')
    expect(body).toContain('END YOUR TURN')
    expect(body).not.toContain('subagent_type: "review-plan"')
    expect(body).toContain('summarize the planned changes')   // reviewer instructions included
  })

  it('marks steps after the gate as post-approval continuations', () => {
    const body = generateOrchestratorBody(nodes as never, edges as never, 'Flow', {})
    expect(body).toMatch(/After this gate is approved[\s\S]*Writer/)
  })

  it('gate event prose includes node id when observability is on', () => {
    const body = generateOrchestratorBody(nodes as never, edges as never, 'Flow', {}, { observability: { workflowId: 'wf-1', workflowSlug: 'cwc-flow' } })
    expect(body).toContain('`g1`')
  })
})
