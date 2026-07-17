import { describe, it, expect } from 'vitest'
import {
  slugify, agentSlug, skillSlug, workflowSkillSlug,
  currentArtifactSkillSlug, deployedArtifactSkillSlug,
} from '../src/slugify.js'
import type { CwcFile } from '../src/schema.js'

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

  it('does not leave a trailing hyphen when truncation lands on a separator', () => {
    expect(slugify(`${'a'.repeat(63)}-tail`)).toBe('a'.repeat(63))
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

describe('agentSlug', () => {
  it('slugifies normal names', () => {
    expect(agentSlug('Backend Architect')).toBe('backend-architect')
  })

  it('falls back to "agent" when name has no slug-able characters', () => {
    expect(agentSlug('🎉')).toBe('agent')
    expect(agentSlug('---')).toBe('agent')
    expect(agentSlug('')).toBe('agent')
  })
})

describe('skillSlug', () => {
  it('slugifies a name', () => { expect(skillSlug('Migration Reviewer')).toBe('migration-reviewer') })
  it('falls back to "skill" for an empty slug', () => { expect(skillSlug('🎉')).toBe('skill') })
})

describe('workflowSkillSlug', () => {
  it('adds the CWC prefix to a slugified workflow name', () => {
    expect(workflowSkillSlug('Release Prep')).toBe('cwc-release-prep')
  })

  it('falls back to cwc-workflow for an empty workflow slug', () => {
    expect(workflowSkillSlug('🎉')).toBe('cwc-workflow')
    expect(workflowSkillSlug('')).toBe('cwc-workflow')
  })

  it('keeps the prefixed workflow skill name within 64 characters', () => {
    expect(workflowSkillSlug('a'.repeat(100))).toHaveLength(64)
    expect(workflowSkillSlug(`${'a'.repeat(59)} long tail`)).not.toMatch(/-$/)
  })
})

describe('artifact skill slugs', () => {
  function artifact(): CwcFile {
    return {
      meta: { id: 'wf', name: 'Release Prep', description: '', version: 1, created: '', updated: '' },
      nodes: [{
        id: 'n', position: { x: 0, y: 0 }, exportedSlug: null,
        agent: { name: 'Direct Release Prep', description: '', completionCriteria: '' },
      }],
      edges: [],
    }
  }

  it('keeps the cwc prefix when artifactKind is absent', () => {
    expect(currentArtifactSkillSlug(artifact())).toBe('cwc-release-prep')
  })

  it('uses the single node name for a managed plain skill', () => {
    const cwc = artifact()
    cwc.meta.artifactKind = 'skill'
    expect(currentArtifactSkillSlug(cwc)).toBe('direct-release-prep')
  })

  it('prefers the persisted deployment slug until the renamed artifact is re-exported', () => {
    const cwc = artifact()
    cwc.meta.artifactKind = 'skill'
    cwc.meta.exportedWorkflowSlug = 'old-release-prep'
    expect(deployedArtifactSkillSlug(cwc)).toBe('old-release-prep')
  })
})
