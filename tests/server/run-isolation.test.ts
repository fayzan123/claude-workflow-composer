// tests/server/run-isolation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { isGitRepo, resolveBaseSha, createWorktree, removeWorktree, getDiff } from '../../src/server/run-isolation.js'

let repo: string
let wtRoot: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim()
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-iso-repo-'))
  wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-iso-wt-'))
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'])
  await fs.writeFile(path.join(repo, 'a.txt'), 'one\n')
  git('add', '-A'); git('commit', '-m', 'init')
})
afterEach(async () => {
  await fs.rm(wtRoot, { recursive: true, maxRetries: 5, retryDelay: 100 })
  await fs.rm(repo, { recursive: true, maxRetries: 5, retryDelay: 100 })
})

describe('isGitRepo / resolveBaseSha', () => {
  it('detects repos and non-repos', async () => {
    expect(await isGitRepo(repo)).toBe(true)
    expect(await isGitRepo(os.tmpdir())).toBe(false)
  })
  it('resolves HEAD and named refs; throws on garbage', async () => {
    expect(await resolveBaseSha(repo, 'HEAD')).toBe(git('rev-parse', 'HEAD'))
    expect(await resolveBaseSha(repo, 'main')).toBe(git('rev-parse', 'main'))
    await expect(resolveBaseSha(repo, 'no-such-ref')).rejects.toThrow()
  })
})

describe('createWorktree / removeWorktree', () => {
  it('creates a worktree on a new branch at baseRef and reports baseSha', async () => {
    const info = await createWorktree(repo, 'cwc-flow', 'run-1', 'HEAD', wtRoot)
    expect(info.branch).toBe('cwc/cwc-flow/run-1')
    expect(info.baseSha).toBe(git('rev-parse', 'HEAD'))
    expect(info.worktreePath).toBe(path.join(wtRoot, 'run-1'))
    const head = execFileSync('git', ['-C', info.worktreePath, 'branch', '--show-current'], { encoding: 'utf-8' }).trim()
    expect(head).toBe('cwc/cwc-flow/run-1')
  })
  it('remove keeps the branch when asked, deletes it otherwise', async () => {
    const a = await createWorktree(repo, 'f', 'run-keep', 'HEAD', wtRoot)
    await removeWorktree(repo, a.worktreePath, a.branch, { keepBranch: true })
    expect(git('branch', '--list', a.branch)).toContain(a.branch)

    const b = await createWorktree(repo, 'f', 'run-del', 'HEAD', wtRoot)
    await removeWorktree(repo, b.worktreePath, b.branch, { keepBranch: false })
    expect(git('branch', '--list', b.branch)).toBe('')
    await expect(fs.access(b.worktreePath)).rejects.toThrow()
  })
})

describe('getDiff', () => {
  it('returns committed diff against baseSha plus uncommitted status', async () => {
    const info = await createWorktree(repo, 'f', 'run-d', 'HEAD', wtRoot)
    await fs.writeFile(path.join(info.worktreePath, 'a.txt'), 'two\n')
    execFileSync('git', ['-C', info.worktreePath, 'commit', '-am', 'change'])
    await fs.writeFile(path.join(info.worktreePath, 'b.txt'), 'new\n')
    const d = await getDiff(info.worktreePath, info.baseSha)
    expect(d.diff).toContain('-one')
    expect(d.diff).toContain('+two')
    expect(d.status).toContain('b.txt')
  })

  it('diffs a kept branch from the repo after its worktree is removed', async () => {
    const info = await createWorktree(repo, 'f', 'run-kept', 'HEAD', wtRoot)
    await fs.writeFile(path.join(info.worktreePath, 'a.txt'), 'two\n')
    execFileSync('git', ['-C', info.worktreePath, 'commit', '-am', 'change'])
    await removeWorktree(repo, info.worktreePath, info.branch, { keepBranch: true })

    // Worktree is gone; diff the surviving branch from the main repo checkout.
    const d = await getDiff(repo, info.baseSha, info.branch)
    expect(d.diff).toContain('-one')
    expect(d.diff).toContain('+two')
    expect(d.status).toContain('a.txt')
  })
})
