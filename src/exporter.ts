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

export interface ExportPaths {
  agentsDir: string
  skillsDir: string
}

export class ExportConflictError extends Error {
  constructor(message: string, readonly filePath: string) {
    super(message)
    this.name = 'ExportConflictError'
  }
}

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

export function resolveExportPaths(target: ExportTarget, opts?: { skillsDir?: string }): ExportPaths {
  if (target.type === 'project') {
    if (!target.projectDir || !path.isAbsolute(target.projectDir)) {
      throw new Error('projectDir must be an absolute path')
    }
    return {
      agentsDir: path.join(target.projectDir, '.claude', 'agents'),
      skillsDir: opts?.skillsDir ?? path.join(target.projectDir, '.claude', 'skills'),
    }
  }

  if (target.userDir && !path.isAbsolute(target.userDir)) {
    throw new Error('userDir must be an absolute path')
  }
  const userDir = target.userDir ?? os.homedir()
  return {
    agentsDir: path.join(userDir, '.claude', 'agents'),
    skillsDir: opts?.skillsDir ?? path.join(userDir, '.claude', 'skills'),
  }
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
  const { agentsDir, skillsDir } = resolveExportPaths(target, { skillsDir: opts.skillsDir })

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

    if (node.nodeType === 'gate') {
      updatedNodes.push({ ...node })   // gates own no files and no slug
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

    const content = buildAgentFileContent(node, resolvedSkills, workflowId, newSlug)
    const existingAgent = await safeReadFile(agentPath)
    if (existingAgent !== null) {
      const status = detectConflict(existingAgent, AGENT_OWNERSHIP_REGEX, workflowId)
      if (status !== 'owned') {
        throw new ExportConflictError(`Agent file at ${agentPath} was not created by this workflow. Rename the agent or remove the file before exporting.`, agentPath)
      }
    }
    await fs.writeFile(agentPath, content, 'utf-8')
    updatedNodes.push({ ...node, exportedSlug: newSlug })
  }

  // Generate workflow skill
  const observabilityEnabled = cwc.meta.observability?.enabled !== false
  const orchestratorBody = generateOrchestratorBody(
    updatedNodes, cwc.edges, cwc.meta.name, nodeOverrides,
    observabilityEnabled ? { observability: { workflowId: cwc.meta.id, workflowSlug } } : {},
  )
  const allowModelInvocation = cwc.meta.modelInvocation === 'auto'
  const skillContent = buildWorkflowSkillContent(cwc.meta.name, cwc.meta.description, orchestratorBody, workflowId, allowModelInvocation)

  // Workflow rename reconciliation: if the name changed since the last export, the old
  // skills/<oldSlug>/ dir would linger as an orphaned, runnable skill (and show up as a
  // phantom "deployed" workflow). Remove it — but only if this workflow owns it.
  const prevSlug = cwc.meta.exportedWorkflowSlug
  if (prevSlug && prevSlug !== workflowSlug) {
    const oldSkillFile = path.join(skillsDir, prevSlug, 'SKILL.md')
    const oldSkillContent = await safeReadFile(oldSkillFile)
    if (oldSkillContent !== null && detectConflict(oldSkillContent, WORKFLOW_OWNERSHIP_REGEX, workflowId) === 'owned') {
      await fs.rm(path.join(skillsDir, prevSlug), { recursive: true, force: true })
    }
  }

  const skillDir = path.join(skillsDir, workflowSlug)
  await ensureDir(skillDir)
  const skillFilePath = path.join(skillDir, 'SKILL.md')
  const existingSkill = await safeReadFile(skillFilePath)
  if (existingSkill !== null) {
    const status = detectConflict(existingSkill, WORKFLOW_OWNERSHIP_REGEX, workflowId)
    if (status === 'foreign') {
      throw new ExportConflictError(`Workflow skill at ${skillFilePath} belongs to a different workflow. Rename the workflow or remove the existing skill before exporting.`, skillFilePath)
    } else if (status === 'absent') {
      throw new ExportConflictError(`Workflow skill at ${skillFilePath} was not created by this workflow. Rename the workflow or remove the existing skill before exporting.`, skillFilePath)
    }
  }
  await fs.writeFile(skillFilePath, skillContent, 'utf-8')

  const updatedCwc: CwcFile = {
    ...cwc,
    nodes: updatedNodes,
    meta: { ...cwc.meta, updated: new Date().toISOString(), exportedWorkflowSlug: workflowSlug },
  }

  return { updatedCwc, warnings }
}
