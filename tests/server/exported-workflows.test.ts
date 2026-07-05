import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import http from 'node:http'
import { createApp } from '../../src/server/index.js'

async function withServer<T>(fn: (baseUrl: string, homeDir: string) => Promise<T>): Promise<T> {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-exported-workflows-'))
  const app = createApp({ staticDir: null, userHomeDir: homeDir, enableNotifier: false })
  const server = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const port = (server.address() as { port: number }).port
  try {
    return await fn(`http://localhost:${port}`, homeDir)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(homeDir, { recursive: true, force: true })
  }
}

async function writeSkill(homeDir: string, slug: string, content: string) {
  const dir = path.join(homeDir, '.claude', 'skills', slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf-8')
  return dir
}

async function deleteWorkflow(baseUrl: string, slug: string) {
  return fetch(`${baseUrl}/api/exported-workflows?slug=${encodeURIComponent(slug)}`, {
    method: 'DELETE',
  })
}

describe('exportedWorkflowsRouter', () => {
  it('rejects traversal slugs without deleting outside directories', async () => {
    await withServer(async (baseUrl, homeDir) => {
      const victim = path.join(homeDir, 'outside-victim')
      await fs.mkdir(victim, { recursive: true })
      await fs.writeFile(path.join(victim, 'keep.txt'), 'do not delete', 'utf-8')

      const res = await deleteWorkflow(baseUrl, '../../outside-victim')

      expect(res.status).toBe(400)
      await expect(fs.access(path.join(victim, 'keep.txt'))).resolves.toBeUndefined()
    })
  })

  it('refuses to delete hand-authored skills without a CWC workflow marker', async () => {
    await withServer(async (baseUrl, homeDir) => {
      const dir = await writeSkill(
        homeDir,
        'hand-authored',
        '---\nname: hand-authored\ndescription: Mine\n---\nDo useful work.',
      )

      const res = await deleteWorkflow(baseUrl, 'hand-authored')

      expect(res.status).toBe(403)
      await expect(fs.access(path.join(dir, 'SKILL.md'))).resolves.toBeUndefined()
    })
  })

  it('deletes exported workflow skills that carry the CWC workflow marker', async () => {
    await withServer(async (baseUrl, homeDir) => {
      const dir = await writeSkill(
        homeDir,
        'cwc-owned-workflow',
        '---\nname: cwc-owned-workflow\ndescription: Exported\n---\nRun it.\n<!-- cwc:workflow:wf-owned -->\n',
      )

      const res = await deleteWorkflow(baseUrl, 'cwc-owned-workflow')
      const body = await res.json() as { deleted: string }

      expect(res.status).toBe(200)
      expect(body.deleted).toBe(dir)
      await expect(fs.access(dir)).rejects.toThrow()
    })
  })
})
