import type { DetectedAutomation } from '../detection/types.js'
import type { CwcFile, CwcTrigger } from '../schema.js'
import type { ClaudeRunner } from '../server/claude-runner.js'
import { buildCapabilityCards, listReusableAgents, listReusableSkills, selectRelevantAgents, selectRelevantSkills } from '../server/skill-catalog.js'
import { extractJsonObject } from '../json-extract.js'
import { compile } from './compiler.js'
import { buildPlannerPrompt } from './planner-prompt.js'

export interface GenerateWorkflowArgs {
  automation: DetectedAutomation
  homeDir: string
  runner: ClaudeRunner
  model?: string
  signal?: AbortSignal
  triggers?: CwcTrigger[]
  onLog?: (message: string) => void
}

function parsePlannerResult(text: string, onLog?: (message: string) => void): unknown {
  const json = extractJsonObject(text)
  if (!json) {
    onLog?.('Planner returned no JSON; compiling fallback workflow from observed steps.')
    return null
  }
  try {
    return JSON.parse(json)
  } catch {
    onLog?.('Planner returned invalid JSON; compiling fallback workflow from observed steps.')
    return null
  }
}

export async function generateWorkflow(args: GenerateWorkflowArgs): Promise<CwcFile> {
  const { automation, homeDir, runner, model, signal, onLog } = args
  onLog?.('Selecting matching skills and agents')
  const skills = selectRelevantSkills(await listReusableSkills(homeDir).catch(() => []), automation)
  const agents = selectRelevantAgents(await listReusableAgents(homeDir).catch(() => []), automation)

  onLog?.(`Reading ${Math.min(skills.length, 5)} skill and ${Math.min(agents.length, 5)} agent capability file(s)`)
  const cards = await buildCapabilityCards({ skills, agents, maxSkills: 5, maxAgents: 5 }).catch(() => [])
  const prompt = buildPlannerPrompt(automation, { skills, agents, cards })

  let plan: unknown = null
  try {
    onLog?.('Asking Claude to plan the workflow')
    const out = await runner(prompt, { model, signal })
    plan = parsePlannerResult(out.result, onLog)
  } catch (err) {
    // A deliberate cancel must propagate, not silently compile a fallback workflow.
    if (signal?.aborted || (err instanceof Error && /cancelled/i.test(err.message))) throw err
    onLog?.(`Planner failed; compiling fallback workflow from observed steps: ${err instanceof Error ? err.message : String(err)}`)
  }

  return compile({
    automation,
    plan,
    catalog: { skills, agents, cards },
    triggers: args.triggers ?? [],
    onLog,
  })
}
