import { Router as createRouter } from 'express'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'
import { ownedExportedSkillId } from '../exported-skill.js'
import { withExportTargetLease } from '../../export/target-lease.js'

export interface ExportedWorkflowEntry {
  slug: string
  ownerId: string
  name: string
  description: string
  skillDir: string
}

export function exportedWorkflowsRouter(homeDir: string) {
  const router = createRouter()
  const skillsDir = path.join(homeDir, '.claude', 'skills')

  async function isRegularDirectory(directory: string): Promise<boolean> {
    try {
      return (await fs.lstat(directory)).isDirectory()
    } catch {
      return false
    }
  }

  async function isRegularFile(filePath: string): Promise<boolean> {
    try {
      return (await fs.lstat(filePath)).isFile()
    } catch {
      return false
    }
  }

  router.get('/', async (_req, res) => {
    const results: ExportedWorkflowEntry[] = []
    try {
      const dirs = await fs.readdir(skillsDir)
      for (const slug of dirs) {
        const skillDir = path.join(skillsDir, slug)
        const skillFile = path.join(skillDir, 'SKILL.md')
        try {
          if (!await isRegularDirectory(skillDir) || !await isRegularFile(skillFile)) continue
          const raw = await fs.readFile(skillFile, 'utf-8')
          const ownerId = ownedExportedSkillId(raw)
          if (!ownerId) continue
          const { data } = matter(raw)
          results.push({
            slug,
            ownerId,
            name: String(data['name'] ?? slug),
            description: String(data['description'] ?? ''),
            skillDir: path.join(skillsDir, slug),
          })
        } catch { /* skip */ }
      }
    } catch { /* skills dir missing */ }
    res.json(results)
  })

  router.delete('/', async (req, res) => {
    const slug = req.query['slug']
    const expectedOwnerId = req.query['ownerId']
    if (typeof slug !== 'string' || slug === '') return void res.status(400).json({ error: 'slug required' })
    if (!/^[a-z0-9-]+$/.test(slug)) return void res.status(400).json({ error: 'invalid slug' })
    if (typeof expectedOwnerId !== 'string' || expectedOwnerId.length === 0 || expectedOwnerId.length > 200
      || /[:\s>]/.test(expectedOwnerId)) {
      return void res.status(409).json({ error: 'observed export owner required; refresh the deployed list before deleting' })
    }

    const skillDir = path.join(skillsDir, slug)
    const resolvedSkillsDir = path.resolve(skillsDir)
    const resolvedSkillDir = path.resolve(skillDir)
    if (!resolvedSkillDir.startsWith(resolvedSkillsDir + path.sep)) {
      return void res.status(403).json({ error: 'skill path outside skills directory' })
    }

    try {
      await withExportTargetLease([path.dirname(skillsDir), skillsDir], async () => {
        // Do not traverse a symlink at either directory level. In particular, a
        // symlinked artifact directory could otherwise redirect unlink(SKILL.md)
        // outside ~/.claude/skills even though the lexical slug check passed.
        if (!await isRegularDirectory(skillsDir) || !await isRegularDirectory(skillDir)) {
          return void res.status(404).json({ error: 'not found' })
        }

        const skillFile = path.join(skillDir, 'SKILL.md')
        if (!await isRegularFile(skillFile)) {
          return void res.status(404).json({ error: 'not found' })
        }
        let ownerId: string | null
        try {
          ownerId = ownedExportedSkillId(await fs.readFile(skillFile, 'utf-8'))
          if (!ownerId) return void res.status(403).json({ error: 'not a CWC-exported artifact' })
          if (ownerId !== expectedOwnerId) {
            return void res.status(409).json({ error: 'export owner changed; refresh the deployed list before deleting' })
          }
        } catch {
          return void res.status(404).json({ error: 'not found' })
        }

        // Revalidate both the regular-file shape and exact owner immediately
        // before unlinking. A generic CWC marker must not authorize deleting a
        // file that an external process replaced with another artifact's output.
        if (!await isRegularFile(skillFile)) return void res.status(404).json({ error: 'not found' })
        let latestOwnerId: string | null
        try {
          latestOwnerId = ownedExportedSkillId(await fs.readFile(skillFile, 'utf-8'))
        } catch {
          return void res.status(404).json({ error: 'not found' })
        }
        if (latestOwnerId !== expectedOwnerId) {
          return void res.status(409).json({ error: 'export changed during deletion' })
        }

        await fs.unlink(skillFile)
        try {
          await fs.rmdir(skillDir)
          res.json({ deleted: skillDir })
        } catch (err) {
          if (typeof err === 'object' && err !== null && 'code' in err
            && ['ENOTEMPTY', 'EEXIST'].includes(String((err as NodeJS.ErrnoException).code))) {
            return void res.json({ deleted: skillFile, preservedDirectory: skillDir })
          }
          throw err
        }
      })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  return router
}
