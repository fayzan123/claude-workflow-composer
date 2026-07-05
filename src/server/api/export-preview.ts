import { Router as createRouter } from 'express'
import type { CwcFile } from '../../schema.js'
import { applyExportedNodeSlugs, resolveExportPaths, resolveSkillWithOverride, type ExportTarget } from '../../export/exporter.js'
import { agentSlug, workflowSkillSlug } from '../../slugify.js'
import { buildAgentFileContent, buildWorkflowSkillContent } from '../../export/file-writer.js'
import { collectNodeOverrides, generateOrchestratorBody } from '../../workflow/prose-generator.js'
import * as path from 'node:path'

export function exportPreviewRouter() {
  const router = createRouter()

  router.post('/', async (req, res) => {
    const { cwcFile, target, skillsDir } = req.body as { cwcFile: CwcFile; target: ExportTarget; skillsDir?: string }
    if (!cwcFile || !target) return void res.status(400).json({ error: 'cwcFile and target required' })
    if (target.type === 'project' && (!target.projectDir || !path.isAbsolute(target.projectDir))) {
      return void res.status(400).json({ error: 'projectDir must be an absolute path' })
    }
    if (target.type === 'user' && target.userDir && !path.isAbsolute(target.userDir)) {
      return void res.status(400).json({ error: 'userDir must be an absolute path' })
    }
    if (skillsDir && !path.isAbsolute(skillsDir)) {
      return void res.status(400).json({ error: 'skillsDir must be an absolute path' })
    }
    try {
      const warnings: string[] = []
      const workflowId = cwcFile.meta.id
      const { agentsDir, skillsDir: resolvedSkillsDir } = resolveExportPaths(target, { skillsDir })
      const workflowSlug = workflowSkillSlug(cwcFile.meta.name)

      const files: { path: string; content: string }[] = []
      const updatedNodes = applyExportedNodeSlugs(cwcFile.nodes)
      const nodeOverrides = collectNodeOverrides(cwcFile.nodes)

      for (const node of cwcFile.nodes) {
        if (node.agentRef) {
          // Ref node — don't generate an agent file.
          for (const skillSlug of node.agent.skills ?? []) {
            const r = await resolveSkillWithOverride(skillSlug)
            if (!r.found) warnings.push(`Skill not found: ${skillSlug} — install it on the target machine`)
          }
          continue
        }
        if (node.nodeType === 'gate') continue

        const slug = agentSlug(node.agent.name)
        const resolvedSkills = await Promise.all(
          (node.agent.skills ?? []).map(async (s) => {
            const r = await resolveSkillWithOverride(s)
            if (!r.found) warnings.push(`Skill not found: ${s} — install it on the target machine`)
            return r
          })
        )
        const content = buildAgentFileContent(node, resolvedSkills, workflowId, slug)
        files.push({ path: path.join(agentsDir, `${slug}.md`), content })
      }

      const observabilityEnabled = cwcFile.meta.observability?.enabled !== false
      const orchestratorBody = generateOrchestratorBody(
        updatedNodes, cwcFile.edges, cwcFile.meta.name, nodeOverrides,
        observabilityEnabled ? { observability: { workflowId: cwcFile.meta.id, workflowSlug } } : {},
      )
      const allowModelInvocation = cwcFile.meta.modelInvocation === 'auto'
      const skillContent = buildWorkflowSkillContent(cwcFile.meta.name, cwcFile.meta.description, orchestratorBody, workflowId, allowModelInvocation)
      files.push({ path: path.join(resolvedSkillsDir, workflowSlug, 'SKILL.md'), content: skillContent })

      res.json({ files, warnings })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
