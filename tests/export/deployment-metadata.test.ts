import { describe, expect, it } from 'vitest'
import {
  agentDispatchTypes,
  buildBespokeAgentDeclaration,
  parseBespokeAgentDeclaration,
  unsupportedAgentDispatchTypes,
  unqualifiedAgentDispatchSlugs,
} from '../../src/export/deployment-metadata.js'

describe('deployment metadata', () => {
  it('writes and parses a canonical sorted bespoke-agent declaration', () => {
    const marker = buildBespokeAgentDeclaration(['writer', 'architect', 'writer'])
    const content = `body\n${marker}\n<!-- cwc:workflow:wf-1 -->\n`

    expect(marker).toBe('<!-- cwc:bespoke-agents:architect,writer -->')
    expect(parseBespokeAgentDeclaration(content)).toEqual(['architect', 'writer'])
  })

  it('represents an all-reference workflow explicitly', () => {
    const content = `body\n${buildBespokeAgentDeclaration([])}\n<!-- cwc:workflow:wf-1 -->`
    expect(parseBespokeAgentDeclaration(content)).toEqual([])
  })

  it('rejects missing, misplaced, duplicate, and non-canonical declarations', () => {
    expect(parseBespokeAgentDeclaration('body\n<!-- cwc:workflow:wf-1 -->')).toBeNull()
    expect(parseBespokeAgentDeclaration('<!-- cwc:bespoke-agents:writer -->\nbody\n<!-- cwc:workflow:wf-1 -->')).toBeNull()
    expect(parseBespokeAgentDeclaration('body\n<!-- cwc:bespoke-agents:writer,writer -->\n<!-- cwc:workflow:wf-1 -->')).toBeNull()
    expect(parseBespokeAgentDeclaration('body\n<!-- cwc:bespoke-agents:writer,architect -->\n<!-- cwc:workflow:wf-1 -->')).toBeNull()
  })

  it('extracts only unqualified dispatch slugs', () => {
    const content = 'Use `subagent_type: "writer"`, `subagent_type: "plugin:reviewer"`, `subagent_type: \'unsafe/value\'`, and `subagent_type: "writer"`.'
    expect(agentDispatchTypes(content)).toEqual(['plugin:reviewer', 'unsafe/value', 'writer'])
    expect(unqualifiedAgentDispatchSlugs(content)).toEqual(['writer'])
    expect(unsupportedAgentDispatchTypes(content)).toEqual(['plugin:reviewer', 'unsafe/value'])
  })
})
