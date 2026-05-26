import { Router as createRouter } from 'express'
import type { ExportTarget } from '../../exporter.js'
import type { CwcFile } from '../../schema.js'
import { detectConflict } from '../../conflict-detector.js'
import { slugify } from '../../slugify.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

const AGENT_OWNERSHIP_REGEX = /^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/
const WORKFLOW_OWNERSHIP_REGEX = /^<!-- cwc:workflow:[^:\s>]+ -->$/

async function safeReadFile(p: string): Promise<string | null> {
  try { return await fs.readFile(p, 'utf-8') } catch { return null }
}

export interface DeleteExportResult {
  deleted: string[]
  skipped: string[]
}

export async function deleteExport(cwc: CwcFile, target: ExportTarget): Promise<DeleteExportResult> {
  const workflowId = cwc.meta.id
  const workflowSlug = slugify(cwc.meta.name)

  const homeDir = os.homedir()
  const agentsDir =
    target.type === 'project'
      ? path.join(target.projectDir, '.claude', 'agents')
      : path.join(homeDir, '.claude', 'agents')

  const skillsDir =
    target.type === 'project'
      ? path.join(target.projectDir, '.claude', 'skills')
      : path.join(homeDir, '.claude', 'skills')

  const deleted: string[] = []
  const skipped: string[] = []

  for (const node of cwc.nodes) {
    const slug = node.exportedSlug ?? slugify(node.agent.name)
    const agentPath = path.join(agentsDir, `${slug}.md`)
    const content = await safeReadFile(agentPath)
    if (content === null) {
      skipped.push(agentPath)
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

  const skillDir = path.join(skillsDir, workflowSlug)
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
  } else {
    skipped.push(skillFilePath)
  }

  return { deleted, skipped }
}

export function exportDeleteRouter() {
  const router = createRouter()

  router.post('/', async (req, res) => {
    const { cwcFile, target } = req.body as { cwcFile: CwcFile; target: ExportTarget }
    if (!cwcFile || !target) return void res.status(400).json({ error: 'cwcFile and target required' })
    try {
      const result = await deleteExport(cwcFile, target)
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
