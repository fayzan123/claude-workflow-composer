import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { exportWorkflow } from '../../src/export/exporter.js'
import { deleteExport } from '../../src/server/api/export-delete.js'
import type { CwcFile } from '../../src/schema.js'

describe('deleteExport', () => {
  it('deletes files from the supplied userDir, not the process home directory', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-delete-export-'))
    const now = new Date().toISOString()
    const cwc: CwcFile = {
      meta: { id: 'wf-delete', name: 'Delete Me', description: '', version: 1, created: now, updated: now },
      nodes: [{
        id: 'n1',
        position: { x: 0, y: 0 },
        exportedSlug: null,
        agent: { name: 'Owned Agent', description: '', completionCriteria: 'done' },
      }, {
        id: 'g1',
        position: { x: 1, y: 0 },
        exportedSlug: null,
        nodeType: 'gate',
        agent: { name: 'Approval Gate', description: '', completionCriteria: '' },
      }],
      edges: [
        { id: 'e1', from: 'n1', to: 'g1', trigger: 'review' },
        { id: 'e2', from: 'g1', to: null, trigger: 'done', terminalType: 'complete' },
      ],
    }
    const target = { type: 'user' as const, userDir: tmp }
    const first = await exportWorkflow(cwc, target, { skillsDir: path.join(tmp, '.claude', 'skills') })

    const result = await deleteExport(first.updatedCwc, target)

    expect(result.deleted.some(p => p.endsWith(path.join('.claude', 'agents', 'owned-agent.md')))).toBe(true)
    expect(result.deleted.some(p => p.endsWith(path.join('.claude', 'skills', 'cwc-delete-me')))).toBe(true)
    expect([...result.deleted, ...result.skipped, ...result.notFound].some(p => p.includes('approval-gate'))).toBe(false)
    await expect(fs.access(path.join(tmp, '.claude', 'agents', 'owned-agent.md'))).rejects.toThrow()
    await expect(fs.access(path.join(tmp, '.claude', 'skills', 'cwc-delete-me'))).rejects.toThrow()
    await fs.rm(tmp, { recursive: true, force: true })
  })
})
