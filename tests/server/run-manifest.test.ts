import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  RUN_MANIFEST_VERSION,
  RunManifestConflictError,
  RunManifestValidationError,
  RunManifestVersionError,
  createRunManifestStore,
  parseRunManifest,
} from '../../src/server/run-manifest.js'

let runsDir: string

function input(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-1',
    workflowId: 'wf-1',
    workflowSkillSlug: 'cwc-flow',
    triggerId: 'manual',
    requestedIsolation: 'worktree' as const,
    originalCwd: path.join(runsDir, 'repo'),
    requestedBaseRef: 'HEAD',
    ...overrides,
  }
}

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-manifests-'))
})

afterEach(async () => {
  await fs.rm(runsDir, { recursive: true, force: true })
})

describe('RunManifestStore', () => {
  it('creates and reads a versioned manifest beside the JSONL location', async () => {
    const store = createRunManifestStore(runsDir)
    const created = await store.create(input())

    expect(created).toMatchObject({
      version: RUN_MANIFEST_VERSION,
      source: 'managed',
      lifecycleState: 'claimed',
      disposition: 'unavailable',
      actionError: null,
    })
    const file = path.join(runsDir, 'wf-1', 'run-1.manifest.json')
    const persisted = JSON.parse(await fs.readFile(file, 'utf-8')) as Record<string, unknown>
    expect(persisted.runId).toBe('run-1')
    await expect(store.read('wf-1', 'run-1')).resolves.toEqual(created)
  })

  it('rejects duplicate creation without replacing the first authority record', async () => {
    const store = createRunManifestStore(runsDir)
    const first = await store.create(input())

    await expect(store.create(input({ originalCwd: '/different' }))).rejects.toBeInstanceOf(RunManifestConflictError)
    await expect(store.read('wf-1', 'run-1')).resolves.toEqual(first)
  })

  it('uses atomic replacement and leaves no temp files after transitions', async () => {
    const store = createRunManifestStore(runsDir)
    await store.create(input())
    await store.transition('wf-1', 'run-1', manifest => ({ ...manifest, lifecycleState: 'preparing' }))

    const files = await fs.readdir(path.join(runsDir, 'wf-1'))
    expect(files).toEqual(['run-1.manifest.json'])
    await expect(store.read('wf-1', 'run-1')).resolves.toMatchObject({ lifecycleState: 'preparing' })
  })

  it('serializes concurrent transitions against the latest persisted state', async () => {
    const store = createRunManifestStore(runsDir)
    await store.create(input())

    const first = store.transition('wf-1', 'run-1', async manifest => {
      await new Promise(resolve => setTimeout(resolve, 30))
      return { ...manifest, lifecycleState: 'preparing', failureReason: 'first' }
    })
    const second = store.transition('wf-1', 'run-1', manifest => ({
      ...manifest,
      lifecycleState: 'worktree_created',
      failureReason: `${manifest.failureReason ?? ''}+second`,
    }))

    await Promise.all([first, second])
    const final = await store.read('wf-1', 'run-1')
    expect(final).toMatchObject({ lifecycleState: 'worktree_created', failureReason: 'first+second' })
    expect(final?.transitions.map(transition => transition.lifecycleState)).toEqual([
      'claimed',
      'preparing',
      'worktree_created',
    ])
  })

  it('persists an immutable run artifact binding across later transitions', async () => {
    const store = createRunManifestStore(runsDir)
    await store.create(input())
    const runtimeBinding = { id: '0123456789abcdef', hash: 'a'.repeat(64) }
    await store.transition('wf-1', 'run-1', manifest => ({ ...manifest, runtimeBinding }))
    await store.transition('wf-1', 'run-1', manifest => ({ ...manifest, lifecycleState: 'running' }))

    await expect(store.read('wf-1', 'run-1')).resolves.toMatchObject({ runtimeBinding })
    await expect(store.transition('wf-1', 'run-1', manifest => ({
      ...manifest,
      runtimeBinding: { ...runtimeBinding, hash: 'b'.repeat(64) },
    }))).rejects.toThrow('runtimeBinding cannot change')
  })

  it('keeps the exclusive transaction across multiple durable transitions', async () => {
    const store = createRunManifestStore(runsDir)
    await store.create(input())
    const seen: string[] = []

    const operation = store.withRun('wf-1', 'run-1', async transaction => {
      seen.push(`start:${transaction.current().lifecycleState}`)
      await transaction.transition(manifest => ({ ...manifest, disposition: 'applying' }))
      await new Promise(resolve => setTimeout(resolve, 25))
      await transaction.transition(manifest => ({ ...manifest, disposition: 'ready' }))
      seen.push('end')
    })
    const competing = store.transition('wf-1', 'run-1', manifest => {
      seen.push(`competing:${manifest.disposition}`)
      return { ...manifest, lifecycleState: 'preparing' }
    })

    await Promise.all([operation, competing])
    expect(seen).toEqual(['start:claimed', 'end', 'competing:ready'])
  })

  it('recovers reads and transitions after constructing a new store instance', async () => {
    const firstProcess = createRunManifestStore(runsDir)
    await firstProcess.create(input())
    await firstProcess.transition('wf-1', 'run-1', manifest => ({ ...manifest, lifecycleState: 'running' }))

    const restarted = createRunManifestStore(runsDir)
    expect((await restarted.read('wf-1', 'run-1'))?.lifecycleState).toBe('running')
    await restarted.transition('wf-1', 'run-1', manifest => ({ ...manifest, lifecycleState: 'paused', sessionId: 'session-1' }))
    expect((await firstProcess.read('wf-1', 'run-1'))?.lifecycleState).toBe('paused')
  })

  it('rejects unsafe path identifiers before touching the filesystem', async () => {
    const store = createRunManifestStore(runsDir)
    await expect(store.create(input({ runId: '../escape' }) as never)).rejects.toBeInstanceOf(RunManifestValidationError)
    await expect(store.create(input({ workflowId: '..' }) as never)).rejects.toBeInstanceOf(RunManifestValidationError)
    await expect(store.create(input({ runId: '.' }) as never)).rejects.toBeInstanceOf(RunManifestValidationError)
    await expect(store.read('../escape', 'run-1')).rejects.toBeInstanceOf(RunManifestValidationError)
    await expect(store.read('..', 'run-1')).rejects.toBeInstanceOf(RunManifestValidationError)
    expect(await fs.readdir(runsDir)).toEqual([])
  })
})

describe('parseRunManifest', () => {
  it('rejects malformed JSON structures and unsupported versions', async () => {
    expect(() => parseRunManifest(null)).toThrow(RunManifestValidationError)
    expect(() => parseRunManifest({ version: RUN_MANIFEST_VERSION + 1 })).toThrow(RunManifestVersionError)

    const dir = path.join(runsDir, 'wf-1')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'run-1.manifest.json'), '{bad json')
    const store = createRunManifestStore(runsDir)
    await expect(store.read('wf-1', 'run-1')).rejects.toThrow('malformed JSON')
  })

  it('rejects a branch that is not owned by the manifest run', async () => {
    const store = createRunManifestStore(runsDir)
    const manifest = await store.create(input())
    expect(() => parseRunManifest({
      ...manifest,
      branch: 'main',
    })).toThrow('branch is not the CWC branch owned by this run')
  })
})
