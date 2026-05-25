import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'
import type { CwcFile, CwcNode } from './schema.js'
import { slugify } from './slugify.js'
import { generateOrchestratorBody } from './prose-generator.js'
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
  const workflowSlug = slugify(cwc.meta.name)

  const agentsDir =
    target.type === 'project'
      ? path.join(target.projectDir, '.claude', 'agents')
      : path.join(target.userDir ?? (process.env.HOME ?? ''), '.claude', 'agents')

  await ensureDir(agentsDir)

  const updatedNodes: CwcNode[] = []

  for (const node of cwc.nodes) {
    const newSlug = slugify(node.agent.name)
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
  const orchestratorBody = generateOrchestratorBody(cwc.nodes, cwc.edges, cwc.meta.name)
  const skillContent = buildWorkflowSkillContent(workflowSlug, cwc.meta.description, orchestratorBody, workflowId)
  const skillDir = path.join(opts.skillsDir, workflowSlug)
  await ensureDir(skillDir)
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillContent, 'utf-8')

  const updatedCwc: CwcFile = {
    ...cwc,
    nodes: updatedNodes,
    meta: { ...cwc.meta, updated: new Date().toISOString() },
  }

  return { updatedCwc, warnings }
}
