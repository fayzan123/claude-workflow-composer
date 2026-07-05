import { Router as createRouter } from 'express'
import { resolveExportPaths, type ExportTarget } from '../../export/exporter.js'
import type { CwcFile } from '../../schema.js'
import { detectConflict } from '../../export/conflict-detector.js'
import { agentSlug, workflowSkillSlug, slugify } from '../../slugify.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const AGENT_OWNERSHIP_REGEX = /^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/
const WORKFLOW_OWNERSHIP_REGEX = /^<!-- cwc:workflow:[^:\s>]+ -->$/

async function safeReadFile(p: string): Promise<string | null> {
  try { return await fs.readFile(p, 'utf-8') } catch { return null }
}

export interface DeleteExportResult {
  deleted: string[]
  skipped: string[]
  notFound: string[]
}

export async function deleteExport(cwc: CwcFile, target: ExportTarget): Promise<DeleteExportResult> {
  const workflowId = cwc.meta.id
  const workflowSlug = workflowSkillSlug(cwc.meta.name)
  const legacyWorkflowSlug = slugify(cwc.meta.name)
  const { agentsDir, skillsDir } = resolveExportPaths(target)

  const deleted: string[] = []
  const skipped: string[] = []
  const notFound: string[] = []

  for (const node of cwc.nodes) {
    if (node.agentRef) {
      // Ref nodes point to pre-existing agent files — never delete them
      continue
    }
    const slug = node.exportedSlug ?? agentSlug(node.agent.name)
    const agentPath = path.join(agentsDir, `${slug}.md`)
    const content = await safeReadFile(agentPath)
    if (content === null) {
      notFound.push(agentPath)
      continue
    }
    const status = detectConflict(content, AGENT_OWNERSHIP_REGEX, workflowId)
    if (status === 'owned') {
      await fs.unlink(agentPath)
      deleted.push(agentPath)
    } else {
      skipped.push(agentPath)
    }
  }

  for (const slug of [workflowSlug, legacyWorkflowSlug]) {
    const skillDir = path.join(skillsDir, slug)
    const skillFilePath = path.join(skillDir, 'SKILL.md')
    const skillContent = await safeReadFile(skillFilePath)
    if (skillContent !== null) {
      const status = detectConflict(skillContent, WORKFLOW_OWNERSHIP_REGEX, workflowId)
      if (status === 'owned') {
        await fs.rm(skillDir, { recursive: true, force: true })
        deleted.push(skillDir)
      } else {
        skipped.push(skillFilePath)
      }
      break  // found the skill dir (new or legacy), no need to check the other
    }
  }

  return { deleted, skipped, notFound }
}

export function exportDeleteRouter() {
  const router = createRouter()

  router.post('/', async (req, res) => {
    const { cwcFile, target } = req.body as { cwcFile: CwcFile; target: ExportTarget }
    if (!cwcFile || !target) return void res.status(400).json({ error: 'cwcFile and target required' })
    if (target.type === 'project' && (!target.projectDir || !path.isAbsolute(target.projectDir))) return void res.status(400).json({ error: 'projectDir must be an absolute path' })
    if (target.type === 'user' && target.userDir && !path.isAbsolute(target.userDir)) return void res.status(400).json({ error: 'userDir must be an absolute path' })
    try {
      const result = await deleteExport(cwcFile, target)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
