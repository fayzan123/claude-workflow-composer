import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import matter from 'gray-matter'
import type { CwcFile, CwcNode } from './schema.js'
import { slugify, agentSlug } from './slugify.js'
import { generateOrchestratorBody, collectNodeOverrides } from './prose-generator.js'
import { resolveSkill, SkillResolution } from './skill-resolver.js'
import { buildAgentFileContent, buildWorkflowSkillContent } from './file-writer.js'
import { detectConflict } from './conflict-detector.js'

export type ExportTarget =
  | { type: 'project'; projectDir: string }
  | { type: 'user'; userDir?: string }

export interface ExportOptions {
  skillsDir: string          // where workflow skill is written
  userSkillsDir?: string     // override for ~/.claude/skills/ (test injection)
}

export interface ExportResult {
  updatedCwc: CwcFile
  warnings: string[]
}

const AGENT_OWNERSHIP_REGEX = /^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/
const WORKFLOW_OWNERSHIP_REGEX = /^<!-- cwc:workflow:[^:\s>]+ -->$/

async function safeReadFile(p: string): Promise<string | null> {
  try { return await fs.readFile(p, 'utf-8') } catch { return null }
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

async function resolveSkillWithOverride(slug: string, userSkillsDir?: string): Promise<SkillResolution> {
  if (!slug.includes(':') && userSkillsDir) {
    const skillMdPath = path.join(userSkillsDir, slug, 'SKILL.md')
    try {
      const content = await fs.readFile(skillMdPath, 'utf-8')
      const { data } = matter(content)
      return { slug, description: typeof data.description === 'string' ? data.description : null, found: true }
    } catch {
      // Fall through to normal resolution
    }
  }
  return resolveSkill(slug)
}

export async function exportWorkflow(
  cwc: CwcFile,
  target: ExportTarget,
  opts: ExportOptions,
): Promise<ExportResult> {
  const warnings: string[] = []
  const workflowId = cwc.meta.id
  const workflowSlug = 'cwc-' + slugify(cwc.meta.name)

  const agentsDir =
    target.type === 'project'
      ? path.join(target.projectDir, '.claude', 'agents')
      : path.join(target.userDir ?? os.homedir(), '.claude', 'agents')

  await ensureDir(agentsDir)

  const updatedNodes: CwcNode[] = []
  const nodeOverrides = collectNodeOverrides(cwc.nodes)

  for (const node of cwc.nodes) {
    if (node.agentRef) {
      // Ref node — points to an existing agent; don't write a new file
      const refSlug = node.agentRef
      if (node.exportedSlug && node.exportedSlug !== refSlug) {
        const oldPath = path.join(agentsDir, `${node.exportedSlug}.md`)
        const oldContent = await safeReadFile(oldPath)
        if (oldContent !== null) {
          const status = detectConflict(oldContent, AGENT_OWNERSHIP_REGEX, workflowId)
          if (status === 'owned') {
            await fs.unlink(oldPath)
          }
        }
      }

      // Resolve ref node's skills for warnings
      for (const skillSlug of node.agent.skills ?? []) {
        const resolved = await resolveSkillWithOverride(skillSlug, opts.userSkillsDir)
        if (!resolved.found) {
          warnings.push(`Skill not found: ${skillSlug} — install it on the target machine`)
        }
      }

      // Warn if the referenced agent file doesn't exist on the target machine
      const refPath = path.join(agentsDir, `${refSlug}.md`)
      const refContent = await safeReadFile(refPath)
      if (refContent === null) {
        warnings.push(`Referenced agent not found: ${refSlug} — install it on the target machine`)
      }

      updatedNodes.push({ ...node, exportedSlug: refSlug })
      continue
    }

    const newSlug = agentSlug(node.agent.name)
    const agentPath = path.join(agentsDir, `${newSlug}.md`)

    // Rename: old file cleanup
    if (node.exportedSlug && node.exportedSlug !== newSlug) {
      const oldPath = path.join(agentsDir, `${node.exportedSlug}.md`)
      const oldContent = await safeReadFile(oldPath)
      if (oldContent !== null) {
        const status = detectConflict(oldContent, AGENT_OWNERSHIP_REGEX, workflowId)
        if (status === 'owned') {
          await fs.unlink(oldPath)
        }
      }
      // If file missing (null): skip delete, proceed to write new file
    }

    // Resolve skills
    const resolvedSkills: SkillResolution[] = []
    for (const skillSlug of node.agent.skills ?? []) {
      const resolved = await resolveSkillWithOverride(skillSlug, opts.userSkillsDir)
      if (!resolved.found) {
        warnings.push(`Skill not found: ${skillSlug} — install it on the target machine`)
      }
      resolvedSkills.push(resolved)
    }

    const content = buildAgentFileContent(node, resolvedSkills, workflowId)
    await fs.writeFile(agentPath, content, 'utf-8')
    updatedNodes.push({ ...node, exportedSlug: newSlug })
  }

  // Generate workflow skill
  const observabilityEnabled = cwc.meta.observability?.enabled !== false
  const orchestratorBody = generateOrchestratorBody(
    updatedNodes, cwc.edges, cwc.meta.name, nodeOverrides,
    observabilityEnabled ? { observability: { workflowId: cwc.meta.id, workflowSlug } } : {},
  )
  const skillContent = buildWorkflowSkillContent(cwc.meta.name, cwc.meta.description, orchestratorBody, workflowId)
  const skillDir = path.join(opts.skillsDir, workflowSlug)
  await ensureDir(skillDir)
  const skillFilePath = path.join(skillDir, 'SKILL.md')
  const existingSkill = await safeReadFile(skillFilePath)
  if (existingSkill !== null) {
    const status = detectConflict(existingSkill, WORKFLOW_OWNERSHIP_REGEX, workflowId)
    if (status === 'foreign') {
      warnings.push(`Workflow skill at ${skillFilePath} belongs to a different workflow — overwriting`)
    } else if (status === 'absent') {
      warnings.push(`Workflow skill at ${skillFilePath} was not created by this workflow — overwriting`)
    }
  }
  await fs.writeFile(skillFilePath, skillContent, 'utf-8')

  const updatedCwc: CwcFile = {
    ...cwc,
    nodes: updatedNodes,
    meta: { ...cwc.meta, updated: new Date().toISOString() },
  }

  return { updatedCwc, warnings }
}
