import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withExportTargetLease } from '../../src/export/target-lease.js'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-target-lease-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('export target lease', () => {
  it.skipIf(process.platform === 'win32')('serializes real and symlink aliases with nonexistent descendants', async () => {
    const realProject = path.join(root, 'real-project')
    const aliasProject = path.join(root, 'alias-project')
    await fs.mkdir(realProject)
    await fs.symlink(realProject, aliasProject, 'dir')

    let releaseFirst!: () => void
    const holdFirst = new Promise<void>(resolve => { releaseFirst = resolve })
    let firstEntered!: () => void
    const firstDidEnter = new Promise<void>(resolve => { firstEntered = resolve })
    let secondEntered = false

    const first = withExportTargetLease(
      [path.join(realProject, '.claude', 'skills')],
      async () => {
        firstEntered()
        await holdFirst
      },
    )
    await firstDidEnter
    const second = withExportTargetLease(
      [path.join(aliasProject, '.claude', 'skills')],
      async () => { secondEntered = true },
    )

    await new Promise(resolve => setTimeout(resolve, 20))
    expect(secondEntered).toBe(false)
    releaseFirst()
    await Promise.all([first, second])
    expect(secondEntered).toBe(true)
  })
})
