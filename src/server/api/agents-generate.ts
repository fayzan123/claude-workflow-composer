import { Router as createRouter } from 'express'
import { runClaude as defaultRunner, type ClaudeRunner } from '../claude-runner.js'
import {
  buildSpecPrompt, buildBuildPrompt, parseSpec, assembleAgentFile, type AgentSpec,
} from '../../agent-generator.js'
import { agentSlug } from '../../slugify.js'

export function agentsGenerateRouter(runner: ClaudeRunner = defaultRunner) {
  const router = createRouter()

  // POST /spec  { message, sessionId? } -> { spec, sessionId }
  router.post('/spec', async (req, res) => {
    const message = req.body?.message
    const sessionId = req.body?.sessionId
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'message is required' })
      return
    }
    try {
      // First turn sends the full prompt; later turns resume and send only the message.
      const prompt = sessionId ? message : buildSpecPrompt(message)
      const out = await runner(prompt, sessionId ? { resume: sessionId } : {})
      const spec = parseSpec(out.result)
      res.json({ spec, sessionId: out.sessionId })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Generation failed' })
    }
  })

  // POST /build  { spec, sessionId? } -> { content, slug }
  router.post('/build', async (req, res) => {
    const spec = req.body?.spec as AgentSpec | undefined
    const sessionId = req.body?.sessionId as string | undefined
    if (!spec || typeof spec.name !== 'string' || spec.name.trim() === '') {
      res.status(400).json({ error: 'spec with a name is required' })
      return
    }
    try {
      const out = await runner(buildBuildPrompt(spec), sessionId ? { resume: sessionId } : {})
      const content = assembleAgentFile(spec, out.result)
      res.json({ content, slug: agentSlug(spec.name) })
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Generation failed' })
    }
  })

  return router
}
