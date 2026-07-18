import { describe, expect, it } from 'vitest'
import type { CwcFile } from '../../src/schema.ts'
import {
  artifactKindOf,
  artifactTierAfterTriggerChange,
  artifactTierOf,
  canDemoteArtifact,
  currentArtifactSlug,
  deployedArtifactSlug,
  extractNumberedChecklist,
  hasExplicitLoopStop,
} from '../../client/src/lib/artifact.ts'

function artifact(overrides: Partial<CwcFile['meta']> = {}): CwcFile {
  return {
    meta: {
      id: 'artifact-1',
      name: 'Triage Incidents',
      description: 'Triage one incident safely.',
      version: 2,
      created: '',
      updated: '',
      artifactKind: 'skill',
      artifactTier: 'skill',
      ...overrides,
    },
    nodes: [{
      id: 'step-1',
      position: { x: 0, y: 0 },
      exportedSlug: null,
      agent: {
        name: 'Triage Incidents',
        description: 'Triage one incident safely.',
        completionCriteria: 'The incident is categorized.',
        systemPrompt: 'Inspect the incident and record its severity.',
      },
    }],
    edges: [],
  }
}

describe('artifact helpers', () => {
  it('resolves a focused skill identity without a workflow prefix', () => {
    const cwc = artifact()
    expect(artifactKindOf(cwc)).toBe('skill')
    expect(artifactTierOf(cwc)).toBe('skill')
    expect(currentArtifactSlug(cwc)).toBe('triage-incidents')
  })

  it('uses persisted deployment identity after a rename', () => {
    const cwc = artifact({ exportedWorkflowSlug: 'old-triage-name' })
    cwc.meta.name = 'New triage name'
    cwc.nodes[0].agent.name = 'New triage name'
    expect(currentArtifactSlug(cwc)).toBe('new-triage-name')
    expect(deployedArtifactSlug(cwc)).toBe('old-triage-name')
  })

  it('distinguishes a loop from a plain skill', () => {
    expect(artifactTierOf(artifact({ artifactTier: 'loop' }))).toBe('loop')
  })

  it('allows demotion of a one-agent workflow with only a terminal edge', () => {
    const cwc = artifact({ artifactKind: 'workflow', artifactTier: 'workflow' })
    cwc.edges = [{ id: 'done', from: 'step-1', to: null, trigger: 'Done', terminalType: 'complete' }]
    expect(canDemoteArtifact(cwc)).toBe(true)
    cwc.edges.push({ id: 'extra', from: 'step-1', to: null, trigger: 'Abort', terminalType: 'aborted' })
    expect(canDemoteArtifact(cwc)).toBe(false)
  })

  it('rejects lossy terminal edges during demotion', () => {
    const cwc = artifact({ artifactKind: 'workflow', artifactTier: 'workflow' })
    cwc.edges = [{ id: 'done', from: 'step-1', to: null, trigger: 'Done', terminalType: 'aborted' }]
    expect(canDemoteArtifact(cwc)).toBe(false)
    cwc.edges[0].terminalType = 'complete'
    cwc.edges[0].context = [{ name: 'report', type: 'text' }]
    expect(canDemoteArtifact(cwc)).toBe(false)
  })

  it('keeps skill and loop tiers synchronized with recurrence and verification', () => {
    const cwc = artifact()
    const trigger = {
      id: 'trigger-1', type: 'cron' as const, schedule: '0 9 * * *', cwd: '',
      isolation: 'worktree' as const, catchUp: false, maxRunsPerDay: 1, enabled: false,
    }
    expect(artifactTierAfterTriggerChange(cwc, [trigger])).toBe('loop')
    expect(artifactTierAfterTriggerChange(cwc, [])).toBe('skill')

    cwc.meta.sourceAutomation = { steps: ['Verify the result'], verificationStep: 'Verify the result' }
    expect(hasExplicitLoopStop(cwc)).toBe(false)
    expect(artifactTierAfterTriggerChange(cwc, [])).toBe('skill')
    cwc.nodes[0].agent.systemPrompt += '\n\n## Verification stop condition\n\nVerify the result. Stop when it passes or two rounds make no progress.'
    expect(hasExplicitLoopStop(cwc)).toBe(true)
    expect(artifactTierAfterTriggerChange(cwc, [])).toBe('loop')
  })

  it('extracts only clear top-level numbered procedures', () => {
    expect(extractNumberedChecklist(`Intro\n\n1. Inspect the diff\n2) Run focused tests\n\n\`\`\`md\n3. Ignore fenced examples\n\`\`\``))
      .toEqual(['Inspect the diff', 'Run focused tests'])
    expect(extractNumberedChecklist('1. Only one explicit step')).toEqual([])
  })

  it('stops at a heading so a later numbered list is not merged into the procedure', () => {
    const body = [
      '## Steps', '', '1. Fetch data', '2. Transform data', '',
      '## Troubleshooting', '', '1. Check the logs', '2. Restart the service',
    ].join('\n')
    expect(extractNumberedChecklist(body)).toEqual(['Fetch data', 'Transform data'])
  })
})
