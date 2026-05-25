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
    completionCriteria: '',
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

  it('injects completion criteria block when completionCriteria is non-empty', () => {
    const node = { ...baseNode, agent: { ...baseNode.agent, completionCriteria: 'All tests pass.' } }
    const content = buildAgentFileContent(node, [], 'wf-uuid')
    expect(content).toContain('## Completion Criteria\n\nBefore returning, verify: All tests pass.')
  })

  it('omits completion criteria block when completionCriteria is empty', () => {
    const content = buildAgentFileContent(baseNode, [], 'wf-uuid')
    expect(content).not.toContain('## Completion Criteria')
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
