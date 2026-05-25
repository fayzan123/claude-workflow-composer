import { it, expect } from 'vitest'
import { AGENT_LIBRARY } from '../../client/src/lib/agentLibrary.ts'

it('every agent has name, description, and completionCriteria', () => {
  for (const agent of AGENT_LIBRARY) {
    expect(agent.name).toBeTruthy()
    expect(agent.description).toBeTruthy()
    expect(agent.completionCriteria).toBeDefined()
  }
})

it('has at least 16 agents', () => {
  expect(AGENT_LIBRARY.length).toBeGreaterThanOrEqual(16)
})

it('agents that use skills have valid skill name strings', () => {
  for (const agent of AGENT_LIBRARY) {
    if (agent.skills) {
      for (const skill of agent.skills) {
        expect(typeof skill).toBe('string')
        expect(skill.length).toBeGreaterThan(0)
      }
    }
  }
})

it('Task Executor and Quality Fixer have coding-principles and testing-principles skills', () => {
  const executor = AGENT_LIBRARY.find((a) => a.name === 'Task Executor')!
  const fixer = AGENT_LIBRARY.find((a) => a.name === 'Quality Fixer')!
  expect(executor.skills).toContain('coding-principles')
  expect(executor.skills).toContain('testing-principles')
  expect(fixer.skills).toContain('coding-principles')
  expect(fixer.skills).toContain('testing-principles')
})
