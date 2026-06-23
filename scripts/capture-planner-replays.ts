import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../src/server/claude-runner.js'
import { buildPlannerPrompt } from '../src/generation/planner-prompt.js'
import { fullStack, lawFirm, npmRelease } from '../tests/generation/fixtures/automations.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, 'tests', 'generation', 'fixtures', 'planner-replays')

const fixtures = [
  ['law-firm', lawFirm],
  ['npm-release', npmRelease],
  ['full-stack-feature', fullStack],
] as const

await fs.mkdir(outDir, { recursive: true })

for (const [name, fixture] of fixtures) {
  const prompt = buildPlannerPrompt(fixture.automation, { skills: [], agents: [], cards: [] })
  const out = await runClaude(prompt, { model: process.env['CWC_PLANNER_MODEL'] ?? 'claude-sonnet-4-6' })
  await fs.writeFile(path.join(outDir, `${name}.json`), out.result)
  console.log(`captured ${name}`)
}
