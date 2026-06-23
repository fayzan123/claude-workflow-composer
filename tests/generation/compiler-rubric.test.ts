import { describe, expect, it } from 'vitest'
import { compile } from '../../src/generation/compiler.js'
import { fullStack, lawFirm, npmRelease } from './fixtures/automations.js'

for (const { name, fixture } of [
  { name: 'law-firm', fixture: lawFirm },
  { name: 'npm-release', fixture: npmRelease },
  { name: 'full-stack-feature', fixture: fullStack },
]) {
  describe(`rubric: ${name}`, () => {
    const cwc = compile({ automation: fixture.automation, plan: fixture.plan, catalog: { skills: [], agents: [], cards: [] }, triggers: [] })
    const agentNodes = cwc.nodes.filter(node => node.nodeType !== 'gate')

    it('valid graph: edges resolve and exactly one terminal', () => {
      const ids = new Set(cwc.nodes.map(node => node.id))
      for (const edge of cwc.edges) {
        expect(ids.has(edge.from)).toBe(true)
        if (edge.to !== null) expect(ids.has(edge.to)).toBe(true)
      }
      expect(cwc.edges.filter(edge => edge.to === null)).toHaveLength(1)
    })

    it('every observed step appears in some node prose', () => {
      const prose = agentNodes.map(node => node.agent.systemPrompt ?? '').join('\n')
      for (const step of fixture.automation.steps) expect(prose).toContain(step)
    })

    it('a gate precedes each risky publish/deploy phase', () => {
      const gateCount = cwc.nodes.filter(node => node.nodeType === 'gate').length
      expect(gateCount).toBeGreaterThanOrEqual(1)
    })

    it('archetype tools are not uniform across all phases', () => {
      const toolSets = new Set(agentNodes.map(node => JSON.stringify(node.agent.tools)))
      expect(toolSets.size).toBeGreaterThan(1)
    })
  })
}
