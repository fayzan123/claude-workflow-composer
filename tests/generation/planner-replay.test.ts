import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractJsonObject } from '../../src/json-extract.js'
import { compile } from '../../src/generation/compiler.js'
import { validatePlan } from '../../src/generation/plan-schema.js'
import { fullStack, lawFirm, npmRelease } from './fixtures/automations.js'

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'planner-replays')
const fixtures = { 'law-firm': lawFirm, 'npm-release': npmRelease, 'full-stack-feature': fullStack }
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(file => file.endsWith('.json')) : []
const d = files.length ? describe : describe.skip

d('planner replay -> compile -> rubric', () => {
  for (const file of files) {
    const name = file.replace(/\.json$/, '') as keyof typeof fixtures
    it(`${name}: real planner output validates and compiles to a valid graph`, () => {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8')
      const json = extractJsonObject(raw)
      const fixture = fixtures[name]
      expect(json).toBeTruthy()
      expect(fixture).toBeDefined()
      const plan = validatePlan(JSON.parse(json!), fixture.automation.steps.length)
      expect(plan).not.toBeNull()
      const cwc = compile({ automation: fixture.automation, plan, catalog: { skills: [], agents: [], cards: [] }, triggers: [] })
      const ids = new Set(cwc.nodes.map(node => node.id))
      for (const edge of cwc.edges) if (edge.to !== null) expect(ids.has(edge.to)).toBe(true)
      expect(cwc.edges.filter(edge => edge.to === null)).toHaveLength(1)
    })
  }
})

if (!files.length) {
  // eslint-disable-next-line no-console
  console.warn('[planner-replay] no replay fixtures committed yet - run scripts/capture-planner-replays.ts before cutover.')
}
