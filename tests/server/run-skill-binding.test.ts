import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createRunSkillBinding,
  openRunSkillBinding,
} from '../../src/server/run-skill-binding.js'
import type { ExportedAgentBinding } from '../../src/server/exported-skill.js'

let root: string

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function agent(slug: string, name = slug, kind: ExportedAgentBinding['kind'] = 'bespoke'): ExportedAgentBinding {
  const ownership = kind === 'bespoke' ? `\n<!-- cwc:node:node-${slug}:workflow:wf-1 -->` : ''
  const content = `---\nname: ${name}\ndescription: Bound agent\n---\n\nOriginal ${slug} instructions.${ownership}\n`
  return { slug, scope: 'user', kind, content, contentHash: hash(content) }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-run-binding-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('run skill binding', () => {
  it('creates a namespaced plugin from exact skill and owned-agent bytes', async () => {
    const skillContent = `---\nname: cwc-flow\ndescription: Flow\ndisable-model-invocation: true\n---\n\nInvoke with \`subagent_type: "writer"\`. Then invoke \`subagent_type: "shared-reviewer"\`.\n<!-- cwc:bespoke-agents:writer -->\n<!-- cwc:workflow:wf-1 -->`
    const writer = agent('writer')
    const sharedReviewer = agent('shared-reviewer', 'shared-reviewer', 'reference')
    const binding = await createRunSkillBinding({
      root,
      runId: 'run-1',
      workflowId: 'wf-1',
      skillSlug: 'cwc-flow',
      skillContent,
      skillContentHash: hash(skillContent),
      agents: [sharedReviewer, writer],
    })

    const pluginName = binding.invocationSlug.split(':')[0]
    const boundSkill = await fs.readFile(path.join(binding.pluginDir, 'skills', 'cwc-flow', 'SKILL.md'), 'utf-8')
    expect(boundSkill).toContain(`subagent_type: "${pluginName}:writer"`)
    expect(boundSkill).toContain(`subagent_type: "${pluginName}:shared-reviewer"`)
    expect(await fs.readFile(path.join(binding.pluginDir, 'agents', 'writer.md'), 'utf-8')).toBe(writer.content)
    expect(await fs.readFile(path.join(binding.pluginDir, 'agents', 'shared-reviewer.md'), 'utf-8')).toBe(sharedReviewer.content)
    await expect(openRunSkillBinding({
      root,
      runId: 'run-1',
      workflowId: 'wf-1',
      skillSlug: 'cwc-flow',
      authority: binding.authority,
    })).resolves.toMatchObject({
      pluginDir: binding.pluginDir,
      invocationSlug: binding.invocationSlug,
      authority: binding.authority,
    })

    await binding.cleanup()
    await expect(fs.access(binding.pluginDir)).rejects.toThrow()
  })

  it('refuses a changed durable snapshot on resume', async () => {
    const skillContent = '---\nname: cwc-flow\ndescription: Flow\n---\n\nDo it.\n<!-- cwc:workflow:wf-1 -->'
    const binding = await createRunSkillBinding({
      root,
      runId: 'run-2',
      workflowId: 'wf-1',
      skillSlug: 'cwc-flow',
      skillContent,
      skillContentHash: hash(skillContent),
      agents: [],
    })
    await fs.writeFile(path.join(binding.pluginDir, 'skills', 'cwc-flow', 'SKILL.md'), 'changed')

    await expect(openRunSkillBinding({
      root,
      runId: 'run-2',
      workflowId: 'wf-1',
      skillSlug: 'cwc-flow',
      authority: binding.authority,
    })).rejects.toThrow('skill changed')
  })

  it('fails closed on an owned agent whose dispatch name does not match frontmatter', async () => {
    const skillContent = '---\nname: cwc-flow\ndescription: Flow\n---\n\nUse `subagent_type: "writer"`.\n<!-- cwc:bespoke-agents:writer -->\n<!-- cwc:workflow:wf-1 -->'
    await expect(createRunSkillBinding({
      root,
      runId: 'run-3',
      workflowId: 'wf-1',
      skillSlug: 'cwc-flow',
      skillContent,
      skillContentHash: hash(skillContent),
      agents: [agent('writer', 'other-agent')],
    })).rejects.toThrow('mismatched frontmatter name')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('fails closed instead of leaving a namespaced dispatch mutable', async () => {
    const skillContent = '---\nname: cwc-flow\ndescription: Flow\n---\n\nUse `subagent_type: "third-party:reviewer"`.\n<!-- cwc:bespoke-agents:- -->\n<!-- cwc:workflow:wf-1 -->'
    await expect(createRunSkillBinding({
      root,
      runId: 'run-namespaced',
      workflowId: 'wf-1',
      skillSlug: 'cwc-flow',
      skillContent,
      skillContentHash: hash(skillContent),
      agents: [],
    })).rejects.toThrow('cannot be bound immutably')
    expect(await fs.readdir(root)).toEqual([])
  })
})
