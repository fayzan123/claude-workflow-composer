import { describe, it, expect } from 'vitest'
import { historyReducer, type HistoryState } from '../../client/src/hooks/useWorkflow.ts'
import type { CwcFile, CwcAgent } from '../../client/src/types.ts'

function emptyWorkflow(): CwcFile {
  const now = new Date().toISOString()
  return {
    meta: { id: 'wf1', name: 'Test', description: '', version: 1, created: now, updated: now },
    nodes: [],
    edges: [],
  }
}

function initial(): HistoryState {
  return { past: [], present: emptyWorkflow(), future: [], lastKey: null }
}

const agent: CwcAgent = { name: 'A', description: '', completionCriteria: '', systemPrompt: '', tools: [], skills: [] }

function skill(): CwcFile {
  const cwc = emptyWorkflow()
  return {
    ...cwc,
    meta: {
      ...cwc.meta,
      name: 'Review changes',
      description: 'Review a focused change.',
      artifactKind: 'skill',
      artifactTier: 'skill',
      exportedWorkflowSlug: 'review-changes',
    },
    nodes: [{
      id: 'skill-step',
      position: { x: 0, y: 0 },
      exportedSlug: null,
      agent: {
        name: 'Review changes',
        description: 'Review a focused change.',
        completionCriteria: 'The review is complete.',
        systemPrompt: '1. Inspect the diff\n2. Run focused tests\n3. Summarize the findings',
      },
    }],
  }
}

function historyFor(present: CwcFile): HistoryState {
  return { past: [], present, future: [], lastKey: null }
}

describe('historyReducer', () => {
  it('records a node add and undoes it', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    expect(s.present.nodes).toHaveLength(1)
    expect(s.past).toHaveLength(1)

    const undone = historyReducer(s, { type: 'UNDO' })
    expect(undone.present.nodes).toHaveLength(0)
    expect(undone.future).toHaveLength(1)
  })

  it('redoes an undone action', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'UNDO' })
    s = historyReducer(s, { type: 'REDO' })
    expect(s.present.nodes).toHaveLength(1)
    expect(s.future).toHaveLength(0)
  })

  it('restores a deleted node via undo', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    s = historyReducer(s, { type: 'REMOVE_NODE', payload: { nodeId } })
    expect(s.present.nodes).toHaveLength(0)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes).toHaveLength(1)
    expect(s.present.nodes[0].id).toBe(nodeId)
  })

  it('coalesces consecutive edits to the same node into one undo step', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    const pastAfterAdd = s.past.length

    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'a' } } })
    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'ab' } } })
    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'abc' } } })

    // Three keystrokes add exactly one undo step on top of the add.
    expect(s.past).toHaveLength(pastAfterAdd + 1)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes[0].agent.description).toBe('')
  })

  it('does not coalesce edits to different nodes', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 1, y: 1 } } })
    const [n1, n2] = s.present.nodes
    const base = s.past.length

    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId: n1.id, agent: { description: 'x' } } })
    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId: n2.id, agent: { description: 'y' } } })
    expect(s.past).toHaveLength(base + 2)
  })

  it('coalesces consecutive moves of the same node into one undo step', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    const pastAfterAdd = s.past.length

    s = historyReducer(s, { type: 'MOVE_NODE', payload: { nodeId, position: { x: 10, y: 10 } } })
    s = historyReducer(s, { type: 'MOVE_NODE', payload: { nodeId, position: { x: 20, y: 20 } } })
    s = historyReducer(s, { type: 'MOVE_NODE', payload: { nodeId, position: { x: 30, y: 30 } } })

    expect(s.past).toHaveLength(pastAfterAdd + 1)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes[0].position).toEqual({ x: 0, y: 0 })
  })

  it('clears the redo stack on a new action after undo', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'UNDO' })
    expect(s.future).toHaveLength(1)
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 5, y: 5 } } })
    expect(s.future).toHaveLength(0)
  })

  it('UNDO/REDO at the boundaries are no-ops', () => {
    const s = initial()
    expect(historyReducer(s, { type: 'UNDO' })).toBe(s)
    expect(historyReducer(s, { type: 'REDO' })).toBe(s)
  })

  it('LOAD resets history', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'LOAD', payload: emptyWorkflow() })
    expect(s.past).toHaveLength(0)
    expect(s.future).toHaveLength(0)
  })

  it('REMOVE_NODE cascades deletion of every connected edge', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 1, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 2, y: 0 } } })
    const [n1, n2, n3] = s.present.nodes
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: n2.id, trigger: 'a→b' } })
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n2.id, to: n3.id, trigger: 'b→c' } })
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n2.id, to: null, trigger: 'done', terminalType: 'complete' } })

    s = historyReducer(s, { type: 'REMOVE_NODE', payload: { nodeId: n2.id } })
    // Incoming, outgoing, AND terminal edges of n2 all go with it.
    expect(s.present.edges).toHaveLength(0)
    expect(s.present.nodes.map((n) => n.id)).toEqual([n1.id, n3.id])
  })

  it('undo after a node deletion restores its cascaded edges too', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 1, y: 0 } } })
    const [n1, n2] = s.present.nodes
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: n2.id, trigger: 'go' } })
    s = historyReducer(s, { type: 'REMOVE_NODE', payload: { nodeId: n1.id } })
    expect(s.present.edges).toHaveLength(0)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes).toHaveLength(2)
    expect(s.present.edges).toHaveLength(1)
    expect(s.present.edges[0].trigger).toBe('go')
  })

  it('UPDATE_EDGE changes only the targeted edge and is undoable', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 1, y: 0 } } })
    const [n1, n2] = s.present.nodes
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: n2.id, trigger: 'first' } })
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n2.id, to: null, trigger: 'second' } })
    const [e1, e2] = s.present.edges

    s = historyReducer(s, { type: 'UPDATE_EDGE', payload: { edgeId: e1.id, trigger: 'changed', label: 'L' } })
    expect(s.present.edges.find((e) => e.id === e1.id)).toMatchObject({ trigger: 'changed', label: 'L' })
    expect(s.present.edges.find((e) => e.id === e2.id)?.trigger).toBe('second')

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.edges.find((e) => e.id === e1.id)?.trigger).toBe('first')
  })

  it('REMOVE_EDGE deletes only the targeted edge', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const n1 = s.present.nodes[0]
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: null, trigger: 'a', terminalType: 'complete' } })
    s = historyReducer(s, { type: 'ADD_EDGE', payload: { from: n1.id, to: null, trigger: 'b', terminalType: 'aborted' } })
    const e1 = s.present.edges[0]
    s = historyReducer(s, { type: 'REMOVE_EDGE', payload: { edgeId: e1.id } })
    expect(s.present.edges).toHaveLength(1)
    expect(s.present.edges[0].trigger).toBe('b')
  })

  it('coalesces consecutive SET_META edits into one undo step', () => {
    let s = initial()
    s = historyReducer(s, { type: 'SET_META', payload: { name: 'A' } })
    s = historyReducer(s, { type: 'SET_META', payload: { name: 'Ab' } })
    s = historyReducer(s, { type: 'SET_META', payload: { name: 'Abc' } })
    expect(s.past).toHaveLength(1)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.meta.name).toBe('Test')
  })

  it('caps the undo stack at 100 entries', () => {
    let s = initial()
    for (let i = 0; i < 130; i++) {
      s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: i, y: 0 } } })
    }
    expect(s.past).toHaveLength(100)
    // The retained history is the most recent 100 states.
    expect(s.past[s.past.length - 1].nodes).toHaveLength(129)
    expect(s.past[0].nodes).toHaveLength(30)
  })

  it('UPDATE_EXPORTED_SLUG does not touch the undo stack', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    const pastBefore = s.past.length
    s = historyReducer(s, { type: 'UPDATE_EXPORTED_SLUG', payload: { nodeId, slug: 'a' } })
    expect(s.past).toHaveLength(pastBefore)
    expect(s.present.nodes[0].exportedSlug).toBe('a')

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.nodes).toHaveLength(0)
  })

  it('UPDATE_EXPORTED_SLUG survives undoing an edit to an existing node', () => {
    let s = initial()
    s = historyReducer(s, { type: 'ADD_NODE', payload: { agent, position: { x: 0, y: 0 } } })
    const nodeId = s.present.nodes[0].id
    s = historyReducer(s, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'changed' } } })
    const pastBefore = s.past.length

    s = historyReducer(s, { type: 'UPDATE_EXPORTED_SLUG', payload: { nodeId, slug: 'exported-a' } })

    expect(s.past).toHaveLength(pastBefore)
    expect(s.present.nodes[0].exportedSlug).toBe('exported-a')

    s = historyReducer(s, { type: 'UNDO' })

    expect(s.present.nodes[0].agent.description).toBe('')
    expect(s.present.nodes[0].exportedSlug).toBe('exported-a')
  })

  it('SET_EXPORTED_WORKFLOW_SLUG does not touch the undo stack or disappear on undo', () => {
    let s = initial()
    s = historyReducer(s, { type: 'SET_META', payload: { name: 'Renamed' } })
    const pastBefore = s.past.length

    s = historyReducer(s, { type: 'SET_EXPORTED_WORKFLOW_SLUG', payload: { slug: 'cwc-renamed' } })

    expect(s.past).toHaveLength(pastBefore)
    expect(s.present.meta.exportedWorkflowSlug).toBe('cwc-renamed')

    s = historyReducer(s, { type: 'UNDO' })

    expect(s.present.meta.name).toBe('Test')
    expect(s.present.meta.exportedWorkflowSlug).toBe('cwc-renamed')
  })

  it('updates skill identity and body atomically', () => {
    let s = historyFor(skill())
    s = historyReducer(s, {
      type: 'UPDATE_SKILL',
      payload: { name: 'Audit changes', description: 'Audit one patch.', body: 'Check the patch carefully.' },
    })

    expect(s.present.meta).toMatchObject({ name: 'Audit changes', description: 'Audit one patch.' })
    expect(s.present.nodes[0].agent).toMatchObject({
      name: 'Audit changes',
      description: 'Audit one patch.',
      systemPrompt: 'Check the patch carefully.',
    })

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.meta.name).toBe('Review changes')
    expect(s.present.nodes[0].agent.name).toBe('Review changes')
  })

  it('keeps a verify-only loop tier synchronized with its editable stop condition', () => {
    const original = skill()
    original.meta.artifactTier = 'loop'
    original.meta.sourceAutomation = { steps: ['Repair failures'], verificationCommand: 'npm test' }
    original.nodes[0].agent.systemPrompt = '# Repair\n\n## Verification stop condition\n\nRun npm test.'

    let state = historyReducer(historyFor(original), {
      type: 'UPDATE_SKILL',
      payload: { body: '# Repair\n\nRun npm test once.' },
    })
    expect(state.present.meta.artifactTier).toBe('skill')

    state = historyReducer(state, {
      type: 'UPDATE_SKILL',
      payload: { body: '# Repair\n\n## Verification stop condition\n\nRun npm test.' },
    })
    expect(state.present.meta.artifactTier).toBe('loop')
  })

  it('keeps a scheduled skill in the loop tier when its stop-condition prose changes', () => {
    const original = skill()
    original.meta.artifactTier = 'loop'
    original.meta.triggers = [{
      id: 'trigger-1', type: 'cron', schedule: '0 9 * * *', cwd: '/tmp/project',
      isolation: 'worktree', catchUp: false, maxRunsPerDay: 1, enabled: false,
    }]

    const state = historyReducer(historyFor(original), {
      type: 'UPDATE_SKILL',
      payload: { body: '# Review\n\nReview once per scheduled run.' },
    })

    expect(state.present.meta.artifactTier).toBe('loop')
  })

  it('graduates a numbered skill into a sequential workflow and preserves deployment metadata', () => {
    const original = skill()
    original.meta.triggers = [{
      id: 'trigger-1',
      type: 'cron',
      schedule: '0 9 * * 1',
      cwd: '/tmp/project',
      isolation: 'worktree',
      catchUp: false,
      maxRunsPerDay: 1,
      enabled: false,
    }]
    let s = historyFor(original)
    s = historyReducer(s, { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })

    expect(s.present.meta).toMatchObject({
      artifactKind: 'workflow',
      artifactTier: 'workflow',
      exportedWorkflowSlug: 'review-changes',
    })
    expect(s.present.meta.triggers).toEqual(original.meta.triggers)
    expect(s.present.nodes).toHaveLength(3)
    expect(s.present.edges).toHaveLength(3)
    expect(s.present.edges.at(-1)).toMatchObject({ to: null, terminalType: 'complete' })
    expect(s.present.nodes.every((node) => node.agent.systemPrompt?.includes('Original skill instructions'))).toBe(true)

    s = historyReducer(s, { type: 'UNDO' })
    expect(s.present.meta.artifactKind).toBe('skill')
    expect(s.present.nodes).toHaveLength(1)
  })

  it('uses one current-body phase instead of resurrecting stale retained steps', () => {
    const original = skill()
    original.meta.sourceAutomation = { steps: ['Collect evidence', 'Publish the release'] }
    original.nodes[0].agent.systemPrompt = '# Current procedure\n\nRun focused tests and summarize the result.'
    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })

    expect(result.present.nodes).toHaveLength(1)
    expect(result.present.nodes[0].agent.systemPrompt).toContain('Run focused tests and summarize the result.')
    expect(result.present.nodes.every(node => !node.agent.systemPrompt?.includes('Publish the release'))).toBe(true)
    expect(result.present.nodes.every(node => node.nodeType !== 'gate')).toBe(true)
  })

  it('prefers the current edited checklist over retained detection steps when graduating', () => {
    const original = skill()
    original.meta.sourceAutomation = { steps: ['Collect stale evidence', 'Verify the stale result'] }
    original.nodes[0].agent.systemPrompt = '1. Inspect the current diff\n2. Run the current verification'
    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })

    expect(result.present.nodes.map((node) => node.agent.description)).toEqual([
      'Inspect the current diff',
      'Run the current verification',
    ])
    expect(result.present.nodes.every(node => !node.agent.description.includes('stale'))).toBe(true)
  })

  it('demotes a lone workflow with a terminal edge and retains automation/deployment identity', () => {
    const original = skill()
    original.meta.artifactKind = 'workflow'
    original.meta.artifactTier = 'workflow'
    original.meta.name = 'Review pipeline'
    original.nodes[0].agent.name = 'Release Reviewer'
    original.nodes[0].exportedSlug = 'release-reviewer'
    original.nodes[0].startTrigger = 'Start when a release candidate needs review.'
    original.nodes[0].agent.skills = ['release-checks']
    original.nodes[0].agent.tools = ['Read', 'Bash']
    original.nodes[0].agent.model = 'sonnet'
    original.nodes[0].agent.completionCriteria = 'The release evidence is summarized.'
    original.meta.triggers = [{
      id: 'trigger-1',
      type: 'cron',
      schedule: '0 9 * * *',
      cwd: '/tmp/project',
      isolation: 'worktree',
      catchUp: false,
      maxRunsPerDay: 1,
      enabled: false,
    }]
    original.edges = [{ id: 'done', from: 'skill-step', to: null, trigger: 'Done', terminalType: 'complete' }]

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'skill' } })
    expect(result.present.meta).toMatchObject({
      version: 2,
      artifactKind: 'skill',
      artifactTier: 'loop',
      exportedWorkflowSlug: 'review-changes',
      name: 'Review pipeline',
    })
    expect(result.present.meta.triggers).toEqual(original.meta.triggers)
    expect(result.present.edges).toEqual([])
    expect(result.present.nodes[0].agent.name).toBe('Review pipeline')
    expect(result.present.nodes[0].exportedSlug).toBe('release-reviewer')
    expect(result.present.nodes[0].startTrigger).toBeUndefined()
    expect(result.present.nodes[0].agent.systemPrompt).toContain('Start when a release candidate needs review.')
    expect(result.present.nodes[0].agent.systemPrompt).toContain('/release-checks')
    expect(result.present.nodes[0].agent.systemPrompt).toContain('`Read`, `Bash`')
    expect(result.present.nodes[0].agent.systemPrompt).toContain('`sonnet`')
    expect(result.present.nodes[0].agent.systemPrompt).toContain('The release evidence is summarized.')
    expect(result.present.nodes[0].agent.systemPrompt).toContain('Finish this skill when: Done')
  })

  it.each([
    {
      sourceAutomation: { steps: ['Repair the failures'], verificationCommand: 'npm test' },
      expected: 'run this observed verification command',
      evidence: 'npm test',
    },
    {
      sourceAutomation: { steps: ['Repair the failures'], verificationStep: 'Check the rendered page' },
      expected: 'repeat this observed verification step',
      evidence: 'Check the rendered page',
    },
  ])('preserves verification and no-progress stop semantics when demoting a loop', ({ sourceAutomation, expected, evidence }) => {
    const original = skill()
    original.meta.artifactKind = 'workflow'
    original.meta.artifactTier = 'workflow'
    original.meta.sourceAutomation = sourceAutomation
    original.nodes[0].agent.systemPrompt = '# Repair failures\n\nRepair each reported failure.'
    original.edges = [{ id: 'done', from: 'skill-step', to: null, trigger: 'Done', terminalType: 'complete' }]

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'skill' } })
    const body = result.present.nodes[0].agent.systemPrompt ?? ''
    expect(result.present.meta.artifactTier).toBe('loop')
    expect(body).toContain('## Verification stop condition')
    expect(body).toContain(expected)
    expect(body).toContain(evidence)
    expect(body).toContain('two rounds make no progress')
  })

  it('preserves quoted whitespace in a verification command during demotion', () => {
    const command = "cd 'packages/web app' && npm test -- --grep 'keeps   spacing'"
    const original = skill()
    original.meta.artifactKind = 'workflow'
    original.meta.artifactTier = 'workflow'
    original.meta.sourceAutomation = { steps: ['Repair the failures'], verificationCommand: command }
    original.edges = [{ id: 'done', from: 'skill-step', to: null, trigger: 'Done', terminalType: 'complete' }]

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'skill' } })

    expect(result.present.nodes[0].agent.systemPrompt).toContain(`    ${command}`)
  })

  it('makes a successful kind-changing export an undo boundary', () => {
    let state = historyFor(skill())
    state = historyReducer(state, { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })
    const deployed: CwcFile = {
      ...state.present,
      meta: { ...state.present.meta, exportedWorkflowSlug: 'cwc-review-changes' },
      nodes: state.present.nodes.map(node => ({
        ...node,
        exportedSlug: node.nodeType === 'gate' ? null : `deployed-${node.id}`,
      })),
    }

    const source = state.present
    state = historyReducer(state, { type: 'COMMIT_EXPORT', payload: { source, deployed } })
    expect(state.past).toEqual([])
    expect(state.future).toEqual([])
    expect(state.present).toBe(deployed)

    const afterUndo = historyReducer(state, { type: 'UNDO' })
    expect(afterUndo).toBe(state)
    expect(afterUndo.present.meta.artifactKind).toBe('workflow')
    expect(afterUndo.present.nodes.filter(node => node.nodeType !== 'gate').every(node => node.exportedSlug)).toBe(true)
  })

  it('retains same-deployment-shape undo history and propagates export identity', () => {
    let state = historyFor(skill())
    state = historyReducer(state, { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })
    const nodeId = state.present.nodes[0].id
    state = historyReducer(state, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'Edited after conversion' } } })
    const deployed: CwcFile = {
      ...state.present,
      meta: {
        ...state.present.meta,
        exportedWorkflowSlug: 'cwc-review-changes',
        pendingExportCleanup: { skillSlugs: ['review-changes'] },
      },
      nodes: state.present.nodes.map(node => ({ ...node, exportedSlug: node.nodeType === 'gate' ? null : `deployed-${node.id}` })),
    }

    const source = state.present
    state = historyReducer(state, { type: 'COMMIT_EXPORT', payload: { source, deployed } })
    expect(state.past).toHaveLength(1)
    state = historyReducer(state, { type: 'UNDO' })
    expect(state.present.meta.artifactKind).toBe('workflow')
    expect(state.present.meta.exportedWorkflowSlug).toBe('cwc-review-changes')
    expect(state.present.meta.pendingExportCleanup).toEqual({ skillSlugs: ['review-changes'] })
    expect(state.present.nodes.filter(node => node.nodeType !== 'gate').every(node => node.exportedSlug)).toBe(true)
  })

  it('clears runnable and pending cleanup deployment identity together', () => {
    const present = skill()
    present.meta.pendingExportCleanup = { skillSlugs: ['obsolete-skill'] }
    const state = historyReducer(historyFor(present), { type: 'CLEAR_EXPORT_STATE' })

    expect(state.present.meta.exportedWorkflowSlug).toBeUndefined()
    expect(state.present.meta.pendingExportCleanup).toBeUndefined()
  })

  it('preserves a same-shape edit made while export is in flight', () => {
    let state = historyFor(skill())
    state = historyReducer(state, { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })
    const source = state.present
    const deployed: CwcFile = {
      ...source,
      meta: { ...source.meta, exportedWorkflowSlug: 'cwc-review-changes' },
      nodes: source.nodes.map(node => ({ ...node, exportedSlug: node.nodeType === 'gate' ? null : `deployed-${node.id}` })),
    }
    const nodeId = source.nodes[0].id
    state = historyReducer(state, { type: 'UPDATE_NODE', payload: { nodeId, agent: { description: 'New local edit' } } })

    state = historyReducer(state, { type: 'COMMIT_EXPORT', payload: { source, deployed } })
    expect(state.present.nodes.find(node => node.id === nodeId)?.agent.description).toBe('New local edit')
    expect(state.present.nodes.find(node => node.id === nodeId)?.exportedSlug).toBe(`deployed-${nodeId}`)
    expect(state.present.meta.exportedWorkflowSlug).toBe('cwc-review-changes')
  })

  it('preserves a cross-shape edit made while export is in flight', () => {
    let state = historyFor(skill())
    const source = state.present
    const deployed: CwcFile = {
      ...source,
      meta: { ...source.meta, exportedWorkflowSlug: 'review-changes' },
    }

    state = historyReducer(state, { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })
    const graduatedNodeIds = state.present.nodes.map(node => node.id)
    const historyLength = state.past.length

    state = historyReducer(state, { type: 'COMMIT_EXPORT', payload: { source, deployed } })

    expect(state.present.meta.artifactKind).toBe('workflow')
    expect(state.present.nodes.map(node => node.id)).toEqual(graduatedNodeIds)
    expect(state.present.meta.exportedWorkflowSlug).toBe('review-changes')
    expect(state.past).toHaveLength(historyLength)
  })

  it('retains cleanup authority for an agent removed while export is in flight', () => {
    let state = historyFor(skill())
    state = historyReducer(state, { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })
    const source = JSON.parse(JSON.stringify(state.present)) as CwcFile
    const removedNode = source.nodes[1]
    const deployed: CwcFile = {
      ...source,
      meta: { ...source.meta, exportedWorkflowSlug: 'cwc-review-changes' },
      nodes: source.nodes.map(node => ({
        ...node,
        exportedSlug: node.nodeType === 'gate' ? null : `deployed-${node.id}`,
      })),
    }

    state = historyReducer(state, { type: 'REMOVE_NODE', payload: { nodeId: removedNode.id } })
    state = historyReducer(state, { type: 'COMMIT_EXPORT', payload: { source, deployed } })

    expect(state.present.nodes.some(node => node.id === removedNode.id)).toBe(false)
    expect(state.present.meta.pendingExportCleanup?.agentSlugs).toContain(`deployed-${removedNode.id}`)
  })

  it('queues a deployed agent slug for cleanup when its node is removed', () => {
    const deployed = skill()
    deployed.meta.artifactKind = 'workflow'
    deployed.meta.artifactTier = 'workflow'
    deployed.nodes[0].exportedSlug = 'deployed-reviewer'
    const state = historyReducer(historyFor(deployed), {
      type: 'REMOVE_NODE',
      payload: { nodeId: deployed.nodes[0].id },
    })

    expect(state.present.meta.pendingExportCleanup).toEqual({ agentSlugs: ['deployed-reviewer', 'review-changes'] })
  })

  it('queues both old and current agent paths after an incomplete deployed rename', () => {
    const deployed = skill()
    deployed.meta.artifactKind = 'workflow'
    deployed.meta.artifactTier = 'workflow'
    deployed.nodes[0].exportedSlug = 'old-reviewer'
    deployed.nodes[0].agent.name = 'Current Reviewer'

    const state = historyReducer(historyFor(deployed), {
      type: 'REMOVE_NODE',
      payload: { nodeId: deployed.nodes[0].id },
    })

    expect(state.present.meta.pendingExportCleanup).toEqual({
      agentSlugs: ['current-reviewer', 'old-reviewer'],
    })
  })

  it('uses fallback phase grouping and inserts approval safety for risky graduation', () => {
    const original = skill()
    original.meta.sourceAutomation = {
      steps: ['Run the focused tests', 'Lint the changed files', 'Publish the release'],
    }
    original.nodes[0].agent.systemPrompt = [
      '1. Run the focused tests',
      '2. Lint the changed files',
      '3. Publish the release',
    ].join('\n')
    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })

    const runnableNodes = result.present.nodes.filter((node) => node.nodeType !== 'gate')
    expect(runnableNodes).toHaveLength(2)
    expect(runnableNodes[0].agent.description).toContain('Run the focused tests → Lint the changed files')
    expect(result.present.nodes.some((node) => node.nodeType === 'gate')).toBe(true)
    expect(result.present.edges.at(-1)).toMatchObject({ to: null, terminalType: 'complete' })
  })

  it('adds a read-only preflight before an approval gate when the first phase is risky', () => {
    const original = skill()
    original.meta.sourceAutomation = { steps: ['Send the release announcement'] }
    original.nodes[0].agent.systemPrompt = 'Send the release announcement.'
    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })

    expect(result.present.nodes.map((node) => node.nodeType ?? 'agent')).toEqual(['agent', 'gate', 'agent'])
    expect(result.present.nodes[0].agent.name).toBe('Preflight Review')
    expect(result.present.nodes[0].agent.tools).toEqual(['Read'])
    expect(result.present.nodes[0].agent.systemPrompt).toMatch(/do not publish, deploy, push, send/i)
  })

  it('gates an exact mutating source connector even when the edited prose misses risk scanning', () => {
    const original = skill()
    const connectorTool = 'mcp__notion__update_page'
    original.nodes[0].agent.tools = ['Read', connectorTool]
    original.nodes[0].agent.systemPrompt = 'Update the Notion page with the current review status.'

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })
    const gateIndex = result.present.nodes.findIndex(node => node.nodeType === 'gate')
    const toolNodeIndexes = result.present.nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.agent.tools?.includes(connectorTool))

    expect(gateIndex).toBeGreaterThan(0)
    expect(result.present.nodes[0].agent.name).toBe('Preflight Review')
    expect(result.present.nodes[0].agent.tools).toEqual(['Read'])
    expect(result.present.nodes.slice(0, gateIndex)
      .every(node => !node.agent.tools?.includes(connectorTool))).toBe(true)
    expect(toolNodeIndexes).toHaveLength(1)
    expect(toolNodeIndexes[0].index).toBeGreaterThan(gateIndex)
    expect(toolNodeIndexes[0].node.agent.systemPrompt).toContain(`Use \`${connectorTool}\` only after the immediately preceding approval gate has been approved`)
    expect(toolNodeIndexes[0].node.agent.systemPrompt).toContain('Do not use this tool for another phase or for an inferred action.')
  })

  it('gates an edited unstructured external action that is absent from retained phases', () => {
    const original = skill()
    original.meta.sourceAutomation = { steps: ['Collect the release evidence', 'Verify the release candidate'] }
    original.nodes[0].agent.systemPrompt = '# Current release procedure\n\nDeploy the approved build to production.'

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })

    expect(result.present.nodes.slice(0, 2).map(node => node.nodeType ?? 'agent')).toEqual(['agent', 'gate'])
    expect(result.present.nodes[0].agent.name).toBe('Preflight Review')
    expect(result.present.nodes[0].agent.systemPrompt).toContain('Deploy the approved build to production.')
    const gateIndex = result.present.nodes.findIndex(node => node.nodeType === 'gate')
    const gatedInstructionNodes = result.present.nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.agent.systemPrompt?.includes('Entry-gated source instructions'))
    expect(gatedInstructionNodes).toHaveLength(1)
    expect(gatedInstructionNodes[0].index).toBeGreaterThan(gateIndex)
  })

  it('entry-gates a changed external action even when its risk category was retained', () => {
    const original = skill()
    original.meta.sourceAutomation = {
      steps: ['Run the focused tests', 'git push origin feature-branch'],
    }
    original.nodes[0].agent.systemPrompt = 'Run the focused tests, then git push --force origin main.'

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })

    expect(result.present.nodes.slice(0, 2).map(node => node.nodeType ?? 'agent')).toEqual(['agent', 'gate'])
    expect(result.present.nodes[0].agent.name).toBe('Preflight Review')
    expect(result.present.nodes[0].agent.systemPrompt).toContain('git push --force origin main')
    const gateIndex = result.present.nodes.findIndex(node => node.nodeType === 'gate')
    const gatedInstructionNodes = result.present.nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node }) => node.agent.systemPrompt?.includes('Entry-gated source instructions'))
    expect(gatedInstructionNodes).toHaveLength(1)
    expect(gatedInstructionNodes[0].index).toBeGreaterThan(gateIndex)
  })

  it('withholds an exact later risky checklist step from agents before its gate', () => {
    const original = skill()
    original.meta.sourceAutomation = {
      steps: ['Run the focused tests', 'git push origin feature-branch'],
    }
    original.nodes[0].agent.systemPrompt = '1. Run the focused tests\n2. git push origin feature-branch'

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })

    const gateIndex = result.present.nodes.findIndex(node => node.nodeType === 'gate')
    expect(gateIndex).toBeGreaterThan(0)
    const preGateAgents = result.present.nodes.slice(0, gateIndex).filter(node => node.nodeType !== 'gate')
    expect(preGateAgents.some(node => node.agent.tools?.includes('Bash'))).toBe(true)
    expect(preGateAgents.every(node => !node.agent.systemPrompt?.includes('git push origin feature-branch'))).toBe(true)
    expect(result.present.nodes.slice(gateIndex + 1)
      .some(node => node.agent.systemPrompt?.includes('git push origin feature-branch'))).toBe(true)
  })

  it('preserves non-action operational constraints across a risky checklist graduation', () => {
    const original = skill()
    const constraint = 'Keep the rollout at 10% in us-east-1.'
    original.meta.sourceAutomation = { steps: ['Build the release', 'Deploy the release to production'] }
    original.nodes[0].agent.systemPrompt = [
      '# Procedure',
      '',
      constraint,
      '',
      '1. Build the release',
      '2. Deploy the release to production',
    ].join('\n')

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })
    const phaseNodes = result.present.nodes.filter(node => /^node-graduate-p\d+$/.test(node.id))
    const gateIndex = result.present.nodes.findIndex(node => node.nodeType === 'gate')

    expect(gateIndex).toBeGreaterThan(0)
    expect(phaseNodes).toHaveLength(2)
    expect(phaseNodes.every(node => node.agent.systemPrompt?.includes(constraint))).toBe(true)
    expect(result.present.nodes.slice(0, gateIndex)
      .every(node => !node.agent.systemPrompt?.includes('Deploy the release to production'))).toBe(true)
  })

  it('does not leak a second risky phase into the agent behind the first gate', () => {
    const original = skill()
    const productionTool = 'mcp__vercel__deploy_production'
    original.nodes[0].agent.tools = [productionTool]
    original.meta.sourceAutomation = {
      steps: ['Publish the build to staging', 'Review the metrics', 'Deploy the build to production'],
    }
    original.nodes[0].agent.systemPrompt = [
      '1. Publish the build to staging',
      '2. Review the metrics',
      '3. Deploy the build to production',
    ].join('\n')

    const result = historyReducer(historyFor(original), { type: 'CONVERT_ARTIFACT', payload: { to: 'workflow' } })
    const productionAgentIndex = result.present.nodes.findIndex(node =>
      node.nodeType !== 'gate' && node.agent.systemPrompt?.includes('Deploy the build to production'))
    const precedingGateIndex = result.present.nodes
      .map((node, index) => ({ node, index }))
      .filter(({ node, index }) => node.nodeType === 'gate' && index < productionAgentIndex)
      .at(-1)?.index ?? -1

    expect(productionAgentIndex).toBeGreaterThan(0)
    expect(precedingGateIndex).toBeGreaterThan(0)
    expect(result.present.nodes.slice(0, precedingGateIndex)
      .filter(node => node.nodeType !== 'gate')
      .every(node => !node.agent.systemPrompt?.includes('Deploy the build to production'))).toBe(true)
    expect(result.present.nodes.slice(0, productionAgentIndex)
      .every(node => !node.agent.tools?.includes(productionTool))).toBe(true)
    expect(result.present.nodes[productionAgentIndex].agent.tools).toContain(productionTool)
  })

  it('refuses unsafe demotion when the workflow contains multiple agents', () => {
    const original = skill()
    original.meta.artifactKind = 'workflow'
    original.meta.artifactTier = 'workflow'
    original.nodes.push({ ...original.nodes[0], id: 'second-step' })
    const state = historyFor(original)
    expect(historyReducer(state, { type: 'CONVERT_ARTIFACT', payload: { to: 'skill' } })).toBe(state)
  })
})
