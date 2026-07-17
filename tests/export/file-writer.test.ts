import { describe, it, expect, vi } from 'vitest'
import { buildAgentFileContent, buildManagedSkillContent, buildWorkflowSkillContent } from '../../src/export/file-writer.js'
import type { CwcNode, CwcFile } from '../../src/schema.js'
import type { SkillResolution } from '../../src/export/skill-resolver.js'
import matter from 'gray-matter'

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
    // name is the slug (what Claude Code matches subagent_type against), not the title
    expect(content).toContain('name: backend-architect')
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

  it('produces parseable frontmatter when description contains a colon (name is slugified)', () => {
    const node = {
      ...baseNode,
      agent: { ...baseNode.agent, name: 'Backend: Architect', description: 'Reviews code: finds bugs' },
    }
    const content = buildAgentFileContent(node, [], 'wf-uuid')
    expect(() => matter(content)).not.toThrow()
    const { data } = matter(content)
    expect(data.name).toBe('backend-architect')
    expect(data.description).toBe('Reviews code: finds bugs')
  })

  it('escapes quotes and special leading characters in the description', () => {
    const node = {
      ...baseNode,
      agent: { ...baseNode.agent, name: '# Lead "Dev"', description: '@mention {curly}' },
    }
    const content = buildAgentFileContent(node, [], 'wf-uuid')
    expect(() => matter(content)).not.toThrow()
    const { data } = matter(content)
    expect(data.name).toBe('lead-dev')
    expect(data.description).toBe('@mention {curly}')
  })

  it('honors an explicit slug override for the name field', () => {
    const content = buildAgentFileContent(baseNode, [], 'wf-uuid', 'custom-slug')
    expect(content).toContain('name: custom-slug')
  })

  it('leaves simple values unquoted', () => {
    const content = buildAgentFileContent(baseNode, [], 'wf-uuid')
    expect(content).toContain('name: backend-architect')
    expect(content).toContain('description: Designs the API')
  })
})

describe('buildWorkflowSkillContent', () => {
  it('produces skill with disable-model-invocation: true', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'orchestrator body', 'wf-uuid')
    expect(matter(content).data['disable-model-invocation']).toBe(true)
  })

  it('keeps disable-model-invocation: true when model invocation is explicitly disallowed', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'body', 'wf-uuid', false)
    expect(matter(content).data['disable-model-invocation']).toBe(true)
  })

  it('omits disable-model-invocation when model invocation is allowed', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'TDD description', 'body', 'wf-uuid', true)
    const { data } = matter(content)
    expect(data).not.toHaveProperty('disable-model-invocation')
    expect(content).not.toContain('disable-model-invocation')
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

  it('declares bespoke agent slugs immediately before workflow ownership', () => {
    const content = buildWorkflowSkillContent(
      'tdd-pipeline',
      'TDD description',
      'body',
      'wf-uuid',
      false,
      ['writer', 'architect'],
    )
    const lines = content.split('\n').filter(line => line.trim().length > 0)
    expect(lines.at(-2)).toBe('<!-- cwc:bespoke-agents:architect,writer -->')
    expect(lines.at(-1)).toBe('<!-- cwc:workflow:wf-uuid -->')
  })

  it('produces parseable frontmatter when description contains a colon', () => {
    const content = buildWorkflowSkillContent('tdd-pipeline', 'Pipeline: builds and tests', 'body', 'wf-uuid')
    expect(() => matter(content)).not.toThrow()
    expect(matter(content).data.description).toBe('Pipeline: builds and tests')
  })
})

describe('buildManagedSkillContent', () => {
  it('uses the plain slug and direct body with the existing ownership marker', () => {
    const content = buildManagedSkillContent(
      'migration-reviewer',
      'Use when reviewing migrations.',
      '\n# Migration Reviewer\n\nReview the migration.\n',
      'skill-owner',
    )
    const parsed = matter(content)
    expect(parsed.data).toMatchObject({
      name: 'migration-reviewer',
      description: 'Use when reviewing migrations.',
      'disable-model-invocation': true,
    })
    expect(parsed.content).toContain('# Migration Reviewer')
    expect(content).toContain('<!-- cwc:bespoke-agents:- -->')
    expect(content.split('\n').filter(Boolean).at(-1)).toBe('<!-- cwc:workflow:skill-owner -->')
  })

  it('omits disable-model-invocation when explicitly allowed', () => {
    const content = buildManagedSkillContent('plain-skill', 'Use when needed.', '# Body', 'owner', true)
    expect(matter(content).data).not.toHaveProperty('disable-model-invocation')
  })
})
