import { Router as createRouter } from 'express'
import { runClaude as defaultRunner, type ClaudeRunner } from '../claude-runner.js'
import {
  buildSkillSpecPrompt, buildSkillBuildPrompt, parseSkillSpec, assembleSkillFile, type SkillSpec,
} from '../../generation/skill-generator.js'
import { skillSlug } from '../../slugify.js'

export function skillsGenerateRouter(runner: ClaudeRunner = defaultRunner) {
  const router = createRouter()

  router.post('/spec', async (req, res) => {
    const message = req.body?.message
    const sessionId = req.body?.sessionId
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'message is required' })
      return
    }
    try {
      const prompt = sessionId ? message : buildSkillSpecPrompt(message)
      const out = await runner(prompt, sessionId ? { resume: sessionId } : {})
      const spec = parseSkillSpec(out.result)
      res.json({ spec, sessionId: out.sessionId })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Generation failed' })
    }
  })

  router.post('/build', async (req, res) => {
    const spec = req.body?.spec as SkillSpec | undefined
    const sessionId = req.body?.sessionId as string | undefined
    if (!spec || typeof spec.name !== 'string' || spec.name.trim() === '') {
      res.status(400).json({ error: 'spec with a name is required' })
      return
    }
    try {
      const normSpec = { ...spec, name: spec.name.trim() }
      const out = await runner(buildSkillBuildPrompt(normSpec), sessionId ? { resume: sessionId } : {})
      const content = assembleSkillFile(normSpec, out.result)
      res.json({ content, slug: skillSlug(normSpec.name) })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Generation failed' })
    }
  })

  return router
}
