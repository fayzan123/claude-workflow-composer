import { describe, it, expect } from 'vitest'
import matter from 'gray-matter'
import {
  assembleSkillFile, parseSkillSpec, buildSkillSpecPrompt, buildSkillBuildPrompt,
  generateSkillArtifact, type SkillSpec,
} from '../../src/generation/skill-generator.js'
import type { DetectedAutomation } from '../../src/detection/types.js'

const SPEC: SkillSpec = {
  name: 'migration-reviewer',
  description: 'Use when reviewing SQL migrations for safety before they are applied.',
  steps: ['Read the migration file', 'Check for table locks', 'Flag non-reversible changes'],
}

const automation: DetectedAutomation = {
  id: 'auto-1',
  title: 'Repair Failing Tests',
  description: 'Repair the project until its tests pass.',
  steps: ['run npm test', 'fix the reported failures', 'run npm test again'],
  stepTokens: ['run-tests', 'fix-failures', 'rerun-tests'],
  evidence: { count: 3, repos: ['/repo'], sessionIds: [], firstSeen: '', lastSeen: '' },
  suggestedTrigger: { kind: 'manual', label: 'manual' },
  confidence: 0.9,
  status: 'new',
  shape: {
    stepArchetypes: ['verify', 'implement', 'verify'],
    distinctArchetypes: 2,
    hasToolActivity: true,
    hasVerifySignal: true,
    hasRetryPattern: true,
    hasRiskyStep: false,
    independentStepGroups: 1,
    recurring: false,
    observedVerifyCommand: 'npm test',
  },
}

describe('assembleSkillFile', () => {
  it('round-trips through gray-matter with name + description', () => {
    const body = '# Migration Reviewer\n\nReview SQL migrations.'
    const file = assembleSkillFile(SPEC, body)
    const { data, content } = matter(file)
    expect(data['name']).toBe('migration-reviewer')
    expect(data['description']).toBe(SPEC.description)
    expect(content.trim()).toBe(body.trim())
  })

  it('normalises the frontmatter name to a slug', () => {
    const file = assembleSkillFile({ ...SPEC, name: 'Migration Reviewer!!' }, 'body')
    expect(matter(file).data['name']).toBe('migration-reviewer')
  })

  it('contains no cwc workflow marker (standalone skill)', () => {
    expect(assembleSkillFile(SPEC, 'body')).not.toContain('cwc:workflow')
  })
})

describe('parseSkillSpec', () => {
  const raw = JSON.stringify({
    name: 'migration-reviewer',
    description: 'Use when reviewing migrations.',
    steps: ['Read it', 'Check locks'],
  })

  it('parses bare JSON', () => {
    expect(parseSkillSpec(raw).name).toBe('migration-reviewer')
  })

  it('parses JSON wrapped in fences with prose', () => {
    const spec = parseSkillSpec('Here:\n```json\n' + raw + '\n```\ndone')
    expect(spec.steps).toEqual(['Read it', 'Check locks'])
  })

  it('coerces missing steps to an empty array and trims fields', () => {
    const spec = parseSkillSpec('{"name":" x ","description":" d "}')
    expect(spec.name).toBe('x')
    expect(spec.description).toBe('d')
    expect(spec.steps).toEqual([])
  })

  it('throws when no JSON object is present', () => {
    expect(() => parseSkillSpec('no json here')).toThrow(/no spec/i)
  })
})

describe('skill prompt builders', () => {
  it('spec prompt embeds the message and demands JSON-only', () => {
    const p = buildSkillSpecPrompt('a skill that reviews migrations')
    expect(p).toContain('a skill that reviews migrations')
    expect(p).toMatch(/only.*JSON/i)
    expect(p).toContain('steps')
  })

  it('build prompt forbids frontmatter and generic filler', () => {
    const p = buildSkillBuildPrompt(SPEC)
    expect(p).toContain('migration-reviewer')
    expect(p).toMatch(/do not.*frontmatter/i)
    expect(p).toMatch(/helpful assistant/i)
  })
})

describe('generateSkillArtifact', () => {
  it('builds a one-node skill CwcFile whose model body covers every observed step', async () => {
    const result = await generateSkillArtifact({
      automation,
      tier: 'skill',
      runner: async () => ({
        result: '# Repair Failing Tests\n\n## Steps\n\n1. run npm test\n2. fix the reported failures\n3. run npm test again\n',
        sessionId: 's1',
      }),
    })

    expect(result.fallbackUsed).toBe(false)
    expect(result.cwc.meta).toMatchObject({
      artifactKind: 'skill',
      artifactTier: 'skill',
      sourceAutomation: { id: 'auto-1', steps: automation.steps },
    })
    expect(result.cwc.nodes).toHaveLength(1)
    expect(result.cwc.edges).toEqual([])
    expect(result.cwc.nodes[0].agentRef).toBeUndefined()
    expect(result.cwc.nodes[0].nodeType).not.toBe('gate')
    for (const step of automation.steps) expect(result.cwc.nodes[0].agent.systemPrompt).toContain(step)
  })

  it('falls back deterministically when the model fails or omits an observed step', async () => {
    const failed = await generateSkillArtifact({
      automation,
      tier: 'skill',
      runner: async () => { throw new Error('runner unavailable') },
    })
    const incomplete = await generateSkillArtifact({
      automation,
      tier: 'skill',
      runner: async () => ({ result: '# Repair\n\nRun the tests.', sessionId: 's1' }),
    })

    expect(failed.fallbackUsed).toBe(true)
    expect(incomplete.fallbackUsed).toBe(true)
    expect(failed.cwc.nodes[0].agent.systemPrompt).toBe(incomplete.cwc.nodes[0].agent.systemPrompt)
    for (const step of automation.steps) expect(failed.cwc.nodes[0].agent.systemPrompt).toContain(step)
  })

  it('falls back when the model reorders otherwise complete observed steps', async () => {
    const result = await generateSkillArtifact({
      automation,
      tier: 'skill',
      runner: async () => ({
        result: '# Repair Failing Tests\n\n## Steps\n\n1. fix the reported failures\n2. run npm test\n3. run npm test again\n',
        sessionId: 's1',
      }),
    })

    expect(result.fallbackUsed).toBe(true)
    const body = result.cwc.nodes[0].agent.systemPrompt ?? ''
    expect(body.indexOf('run npm test')).toBeLessThan(body.indexOf('fix the reported failures'))
  })

  it('does not let a prose echo hide a reordered checklist', async () => {
    const result = await generateSkillArtifact({
      automation,
      tier: 'skill',
      runner: async () => ({
        result: '# Repair Failing Tests\n\nrun npm test\n\n## Steps\n\n1. fix the reported failures\n2. run npm test\n3. run npm test again\n',
        sessionId: 's1',
      }),
    })

    expect(result.fallbackUsed).toBe(true)
  })

  it('falls back when model output appends an unobserved external action', async () => {
    const result = await generateSkillArtifact({
      automation,
      tier: 'skill',
      runner: async () => ({
        result: '# Repair Failing Tests\n\n## Steps\n\n1. run npm test\n2. fix the reported failures\n3. run npm test again\n4. git push origin main\n',
        sessionId: 's1',
      }),
    })

    expect(result.fallbackUsed).toBe(true)
    expect(result.cwc.nodes[0].agent.systemPrompt).not.toContain('git push origin main')
  })

  it.each([
    {
      label: 'a connector mutation',
      extra: '4. Call `mcp__notion__update_page` with the finished report',
      forbidden: 'mcp__notion__update_page',
    },
    {
      label: 'a fenced split shell command',
      extra: ['```bash', 'git \\', '  push --force origin main', '```'].join('\n'),
      forbidden: 'push --force origin main',
    },
    {
      label: 'a fenced split HTTP write',
      extra: ['```bash', 'curl -X \\', '  POST https://example.test/items -d value=1', '```'].join('\n'),
      forbidden: 'POST https://example.test/items',
    },
    {
      label: 'a split connector mutation name',
      extra: ['4. Call `mcp__notion__update_\\', 'page` with the finished report'].join('\n'),
      forbidden: 'mcp__notion__update_',
    },
  ])('falls back when the model appends $label', async ({ extra, forbidden }) => {
    const result = await generateSkillArtifact({
      automation,
      tier: 'skill',
      runner: async () => ({
        result: `# Repair Failing Tests\n\n## Steps\n\n1. run npm test\n2. fix the reported failures\n3. run npm test again\n\n${extra}\n`,
        sessionId: 's1',
      }),
    })

    expect(result.fallbackUsed).toBe(true)
    expect(result.cwc.nodes[0].agent.systemPrompt).not.toContain(forbidden)
  })

  it('falls back when the model adds a different external action in an observed signal category', async () => {
    const riskyAutomation: DetectedAutomation = {
      ...automation,
      title: 'Promote Changes',
      steps: ['Inspect the release configuration', 'git push origin feature-branch'],
    }
    const result = await generateSkillArtifact({
      automation: riskyAutomation,
      tier: 'skill',
      runner: async () => ({
        result: ['# Promote Changes', '', '## Steps', '', '1. Inspect the release configuration', '2. git push origin feature-branch', '3. git \\', '  push --force origin main', ''].join('\n'),
        sessionId: 's1',
      }),
    })

    expect(result.fallbackUsed).toBe(true)
    expect(result.cwc.nodes[0].agent.systemPrompt).not.toContain('git push --force origin main')
  })

  it('accepts an observed external action only as its exact checklist instruction', async () => {
    const riskyAutomation: DetectedAutomation = {
      ...automation,
      title: 'Promote Changes',
      steps: ['Inspect the release configuration', 'git push origin feature-branch'],
    }
    const result = await generateSkillArtifact({
      automation: riskyAutomation,
      tier: 'skill',
      runner: async () => ({
        result: '# Promote Changes\n\n## Steps\n\n1. Inspect the release configuration\n2. git push origin feature-branch\n',
        sessionId: 's1',
      }),
    })

    expect(result.fallbackUsed).toBe(false)
  })

  it('does not mistake read-only Slack, deployment, or Notion prose for external actions', async () => {
    const result = await generateSkillArtifact({
      automation,
      tier: 'skill',
      runner: async () => ({
        result: '# Repair Failing Tests\n\nReview the Slack message history and deployment logs before reporting.\nDescribe the Notion page update without calling a connector.\n\n## Steps\n\n1. run npm test\n2. fix the reported failures\n3. run npm test again\n',
        sessionId: 's1',
      }),
    })

    expect(result.fallbackUsed).toBe(false)
  })

  it('keeps analyzer-authored action language out of the executable fallback body', async () => {
    const result = await generateSkillArtifact({
      automation: {
        ...automation,
        title: 'Deploy Production',
        description: 'Deploy the service and notify every customer.',
        steps: ['run npm test'],
      },
      tier: 'skill',
      runner: async () => { throw new Error('runner unavailable') },
    })

    const body = result.cwc.nodes[0].agent.systemPrompt ?? ''
    expect(result.fallbackUsed).toBe(true)
    expect(body).toContain('run npm test')
    expect(body).toContain('# Observed procedure')
    expect(body).not.toMatch(/deploy|notify every customer/i)
  })

  it('refuses to invent a runnable step from a model-authored title', async () => {
    await expect(generateSkillArtifact({
      automation: { ...automation, title: 'Publish everything', steps: [] },
      tier: 'skill',
      runner: async () => ({ result: '# Publish everything', sessionId: 's1' }),
    })).rejects.toThrow(/no grounded procedure steps/i)
  })

  it('adds an evidence-grounded stop condition to loop bodies and disarms passed triggers', async () => {
    const result = await generateSkillArtifact({
      automation,
      tier: 'loop',
      triggers: [{
        id: 'trig-12345678', type: 'cron', schedule: '0 9 * * *', cwd: '', isolation: 'in-place',
        catchUp: true, maxRunsPerDay: 4, enabled: true,
      }],
      runner: async () => ({
        result: '# Repair Failing Tests\n\n1. run npm test\n2. fix the reported failures\n3. run npm test again',
        sessionId: 's1',
      }),
    })

    expect(result.cwc.meta.artifactTier).toBe('loop')
    expect(result.cwc.meta.sourceAutomation?.verificationCommand).toBe('npm test')
    expect(result.cwc.meta.triggers).toMatchObject([{ enabled: false, isolation: 'worktree' }])
    const body = result.cwc.nodes[0].agent.systemPrompt ?? ''
    expect(body).toContain('npm test')
    expect(body).toContain('two rounds make no progress')
    expect(body.trim().endsWith('two rounds make no progress.')).toBe(true)
  })

  it('renders the observed verification command verbatim in the loop stop condition', async () => {
    const command = "cd 'packages/web app' && npm test -- --grep 'keeps   spacing'"
    const result = await generateSkillArtifact({
      automation: {
        ...automation,
        shape: { ...automation.shape!, observedVerifyCommand: command },
      },
      tier: 'loop',
      runner: async () => ({
        result: '# Repair Failing Tests\n\n1. run npm test\n2. fix the reported failures\n3. run npm test again',
        sessionId: 's1',
      }),
    })

    expect(result.cwc.meta.sourceAutomation?.verificationCommand).toBe(command)
    expect(result.cwc.nodes[0].agent.systemPrompt).toContain(`    ${command}`)
  })

  it('propagates cancellation instead of writing a fallback artifact', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(generateSkillArtifact({
      automation,
      tier: 'skill',
      signal: controller.signal,
      runner: async () => { throw new Error('claude cancelled.') },
    })).rejects.toThrow(/cancelled/i)
  })
})
