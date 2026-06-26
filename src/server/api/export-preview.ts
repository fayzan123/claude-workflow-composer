import { Router as createRouter } from 'express'
import type { CwcFile } from '../../schema.js'
import { resolveExportPaths, type ExportTarget } from '../../exporter.js'
import { agentSlug, slugify } from '../../slugify.js'
import { buildAgentFileContent, buildWorkflowSkillContent } from '../../file-writer.js'
import { generateOrchestratorBody, OverrideInfo } from '../../prose-generator.js'
import { resolveSkill } from '../../skill-resolver.js'
import * as path from 'node:path'

export function exportPreviewRouter() {
  const router = createRouter()

  router.post('/', async (req, res) => {
    const { cwcFile, target } = req.body as { cwcFile: CwcFile; target: ExportTarget }
    if (!cwcFile || !target) return void res.status(400).json({ error: 'cwcFile and target required' })
    if (target.type === 'project' && (!target.projectDir || !path.isAbsolute(target.projectDir))) {
      return void res.status(400).json({ error: 'projectDir must be an absolute path' })
    }
    if (target.type === 'user' && target.userDir && !path.isAbsolute(target.userDir)) {
      return void res.status(400).json({ error: 'userDir must be an absolute path' })
    }
    try {
      const warnings: string[] = []
      const workflowId = cwcFile.meta.id
      const { agentsDir, skillsDir } = resolveExportPaths(target)
      const workflowSlug = 'cwc-' + slugify(cwcFile.meta.name)

      const files: { path: string; content: string }[] = []
      const nodeOverrides: Record<string, OverrideInfo> = {}

      for (const node of cwcFile.nodes) {
        if (node.agentRef) {
          // Ref node — don't generate an agent file; collect overrides for orchestrator
          for (const skillSlug of node.agent.skills ?? []) {
            const r = await resolveSkill(skillSlug)
            if (!r.found) warnings.push(`Skill not found: ${skillSlug} — install it on the target machine`)
          }
          const hasOverrides = (node.agent.skills ?? []).length > 0
            || (node.agent.tools ?? []).length > 0
            || (node.agent.systemPrompt ?? '').trim().length > 0
            || (node.agent.completionCriteria ?? '').trim().length > 0
          if (hasOverrides) {
            nodeOverrides[node.id] = {
              skills: node.agent.skills,
              tools: node.agent.tools,
              systemPrompt: node.agent.systemPrompt,
              completionCriteria: node.agent.completionCriteria,
            }
          }
          continue
        }
        if (node.nodeType === 'gate') continue

        const slug = agentSlug(node.agent.name)
        const resolvedSkills = await Promise.all(
          (node.agent.skills ?? []).map(async (s) => {
            const r = await resolveSkill(s)
            if (!r.found) warnings.push(`Skill not found: ${s} — install it on the target machine`)
            return r
          })
        )
        const content = buildAgentFileContent(node, resolvedSkills, workflowId)
        files.push({ path: path.join(agentsDir, `${slug}.md`), content })
      }

      const observabilityEnabled = cwcFile.meta.observability?.enabled !== false
      const orchestratorBody = generateOrchestratorBody(
        cwcFile.nodes, cwcFile.edges, cwcFile.meta.name, nodeOverrides,
        observabilityEnabled ? { observability: { workflowId: cwcFile.meta.id, workflowSlug } } : {},
      )
      const allowModelInvocation = cwcFile.meta.modelInvocation === 'auto'
      const skillContent = buildWorkflowSkillContent(cwcFile.meta.name, cwcFile.meta.description, orchestratorBody, workflowId, allowModelInvocation)
      files.push({ path: path.join(skillsDir, workflowSlug, 'SKILL.md'), content: skillContent })

      res.json({ files, warnings })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
