import { Router as createRouter } from 'express'
import type { CwcFile } from '../../schema.js'
import type { ExportTarget } from '../../exporter.js'
import { slugify } from '../../slugify.js'
import { buildAgentFileContent, buildWorkflowSkillContent } from '../../file-writer.js'
import { generateOrchestratorBody } from '../../prose-generator.js'
import { resolveSkill } from '../../skill-resolver.js'
import * as path from 'node:path'
import * as os from 'node:os'

export function exportPreviewRouter() {
  const router = createRouter()

  router.post('/', async (req, res) => {
    const { cwcFile, target } = req.body as { cwcFile: CwcFile; target: ExportTarget }
    if (!cwcFile || !target) return void res.status(400).json({ error: 'cwcFile and target required' })
    if (target.type === 'project' && !path.isAbsolute(target.projectDir)) {
      return void res.status(400).json({ error: 'projectDir must be an absolute path' })
    }
    try {
      const warnings: string[] = []
      const workflowId = cwcFile.meta.id
      const agentsDir = target.type === 'project'
        ? path.join(target.projectDir, '.claude', 'agents')
        : path.join(target.userDir ?? os.homedir(), '.claude', 'agents')
      const workflowSlug = slugify(cwcFile.meta.name)
      const skillsDir = target.type === 'project'
        ? path.join(target.projectDir, '.claude', 'skills')
        : path.join(target.userDir ?? os.homedir(), '.claude', 'skills')

      const files: { path: string; content: string }[] = []

      for (const node of cwcFile.nodes) {
        const slug = slugify(node.agent.name)
        const resolvedSkills = await Promise.all(
          (node.agent.skills ?? []).map(async (s) => {
            const r = await resolveSkill(s)
            if (!r.found) warnings.push(`Skill not found: ${s}`)
            return r
          })
        )
        const content = buildAgentFileContent(node, resolvedSkills, workflowId)
        files.push({ path: path.join(agentsDir, `${slug}.md`), content })
      }

      const orchestratorBody = generateOrchestratorBody(cwcFile.nodes, cwcFile.edges, cwcFile.meta.name)
      const skillContent = buildWorkflowSkillContent(workflowSlug, cwcFile.meta.description, orchestratorBody, workflowId)
      files.push({ path: path.join(skillsDir, workflowSlug, 'SKILL.md'), content: skillContent })

      res.json({ files, warnings })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
