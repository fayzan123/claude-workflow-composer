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
