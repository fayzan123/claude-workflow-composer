// tests/server/run-isolation.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  applyResultFastForward,
  checkpointWorktree,
  createWorktree,
  discardResultBranch,
  getDiff,
  getRepositoryIdentity,
  isGitRepo,
  removeVerifiedWorktree,
  removeWorktree,
  resolveBaseSha,
  type ManagedResultAuthority,
} from '../../src/server/run-isolation.js'

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

describe('checkpointWorktree', () => {
  it('does nothing when the worktree is clean', async () => {
    const info = await createWorktree(repo, 'f', 'run-clean', 'HEAD', wtRoot)
    const before = execFileSync('git', ['-C', info.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()

    expect(await checkpointWorktree(info.worktreePath, 'run-clean')).toBe(false)
    expect(execFileSync('git', ['-C', info.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()).toBe(before)
  })

  it('commits tracked and untracked run output with a deterministic identity and message', async () => {
    const info = await createWorktree(repo, 'f', 'run-dirty', 'HEAD', wtRoot)
    await fs.writeFile(path.join(info.worktreePath, 'a.txt'), 'changed\n')
    await fs.writeFile(path.join(info.worktreePath, 'new.txt'), 'created\n')

    expect(await checkpointWorktree(info.worktreePath, 'run-dirty')).toBe(true)
    expect(execFileSync('git', ['-C', info.worktreePath, 'status', '--porcelain'], { encoding: 'utf-8' })).toBe('')
    expect(execFileSync('git', ['-C', info.worktreePath, 'log', '-1', '--format=%s'], { encoding: 'utf-8' }).trim()).toBe('CWC run run-dirty result')
    expect(execFileSync('git', ['-C', info.worktreePath, 'log', '-1', '--format=%an <%ae>'], { encoding: 'utf-8' }).trim()).toBe('Claude Workflow Composer <cwc@localhost>')
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

async function readyResult(runId: string): Promise<ManagedResultAuthority> {
  const info = await createWorktree(repo, 'flow', runId, 'HEAD', wtRoot)
  await fs.writeFile(path.join(info.worktreePath, 'a.txt'), `${runId}\n`)
  execFileSync('git', ['-C', info.worktreePath, 'commit', '-am', `result ${runId}`])
  const resultSha = execFileSync('git', ['-C', info.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
  await removeWorktree(repo, info.worktreePath, info.branch, { keepBranch: true })
  return {
    destinationCwd: repo,
    repositoryIdentity: await getRepositoryIdentity(repo),
    baseSha: info.baseSha,
    branch: info.branch,
    resultSha,
  }
}

describe('Apply isolated result', () => {
  it('fast-forwards a clean destination from the exact base to the verified result', async () => {
    const authority = await readyResult('run-apply')

    const result = await applyResultFastForward(authority)

    expect(result).toEqual({ ok: true, appliedSha: authority.resultSha })
    expect(git('rev-parse', 'HEAD')).toBe(authority.resultSha)
    expect(git('log', '-1', '--format=%s')).toBe('result run-apply')
  })

  it('rejects staged, unstaged, and untracked destination changes without moving HEAD', async () => {
    const authority = await readyResult('run-dirty-destination')
    await fs.writeFile(path.join(repo, 'a.txt'), 'staged destination work\n')
    git('add', 'a.txt')
    await fs.writeFile(path.join(repo, 'a.txt'), 'unstaged destination work\n')
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'do not touch')
    const before = git('rev-parse', 'HEAD')

    const result = await applyResultFastForward(authority)

    expect(result).toMatchObject({ ok: false, code: 'destination_dirty' })
    expect(git('rev-parse', 'HEAD')).toBe(before)
    await expect(fs.readFile(path.join(repo, 'a.txt'), 'utf-8')).resolves.toBe('unstaged destination work\n')
    await expect(fs.readFile(path.join(repo, 'untracked.txt'), 'utf-8')).resolves.toBe('do not touch')
    expect(git('status', '--porcelain')).toContain('MM a.txt')
    expect(git('status', '--porcelain')).toContain('?? untracked.txt')
    expect(git('branch', '--list', authority.branch)).toContain(authority.branch)
  })

  it('rejects a destination whose HEAD moved after launch', async () => {
    const authority = await readyResult('run-moved-head')
    await fs.writeFile(path.join(repo, 'main.txt'), 'new main work')
    git('add', '-A')
    git('commit', '-m', 'main moved')
    const moved = git('rev-parse', 'HEAD')

    expect(await applyResultFastForward(authority)).toMatchObject({ ok: false, code: 'destination_moved' })
    expect(git('rev-parse', 'HEAD')).toBe(moved)
    expect(git('branch', '--list', authority.branch)).toContain(authority.branch)
  })

  it('rejects a destination that no longer matches the recorded repository identity', async () => {
    const authority = await readyResult('run-wrong-repository')
    const wrongIdentity = process.platform === 'win32' ? 'c:\\not-the-repository\\.git' : '/not-the-repository/.git'

    expect(await applyResultFastForward({ ...authority, repositoryIdentity: wrongIdentity })).toMatchObject({ ok: false, code: 'repository_changed' })
    expect(await discardResultBranch({ ...authority, repositoryIdentity: wrongIdentity })).toMatchObject({ ok: false, code: 'repository_changed' })
    expect(git('rev-parse', 'HEAD')).toBe(authority.baseSha)
    expect(git('branch', '--list', authority.branch)).toContain(authority.branch)
  })

  it('rejects a missing result object and a moved result branch', async () => {
    const authority = await readyResult('run-missing-result')
    const missing = { ...authority, resultSha: 'f'.repeat(40) }
    expect(await applyResultFastForward(missing)).toMatchObject({ ok: false, code: 'result_missing' })

    git('branch', '-f', authority.branch, authority.baseSha)
    expect(await applyResultFastForward(authority)).toMatchObject({ ok: false, code: 'branch_moved' })
    expect(git('rev-parse', 'HEAD')).toBe(authority.baseSha)
  })

  it('rejects a result that does not descend from the recorded base', async () => {
    const authority = await readyResult('run-non-descendant')
    const tree = git('rev-parse', `${authority.baseSha}^{tree}`)
    const orphan = git('commit-tree', tree, '-m', 'orphan result')
    git('update-ref', `refs/heads/${authority.branch}`, orphan)

    const result = await applyResultFastForward({ ...authority, resultSha: orphan })

    expect(result).toMatchObject({ ok: false, code: 'non_descendant' })
    expect(git('rev-parse', 'HEAD')).toBe(authority.baseSha)
  })
})

describe('Discard isolated result', () => {
  it('deletes only the exact verified result branch and leaves the destination untouched', async () => {
    const authority = await readyResult('run-discard')
    const before = git('rev-parse', 'HEAD')

    const result = await discardResultBranch(authority)

    expect(result).toEqual({ ok: true, discardedSha: authority.resultSha })
    expect(git('branch', '--list', authority.branch)).toBe('')
    expect(git('rev-parse', 'HEAD')).toBe(before)
    await expect(fs.readFile(path.join(repo, 'a.txt'), 'utf-8')).resolves.toBe('one\n')
  })

  it('preserves a branch that moved or is checked out', async () => {
    const moved = await readyResult('run-discard-moved')
    git('branch', '-f', moved.branch, moved.baseSha)
    expect(await discardResultBranch(moved)).toMatchObject({ ok: false, code: 'branch_moved' })
    expect(git('branch', '--list', moved.branch)).toContain(moved.branch)

    const checkedOut = await readyResult('run-discard-current')
    git('switch', checkedOut.branch)
    expect(await discardResultBranch(checkedOut)).toMatchObject({ ok: false, code: 'branch_checked_out' })
    expect(git('branch', '--show-current')).toBe(checkedOut.branch)
    git('switch', 'main')
  })
})

describe('verified worktree cleanup', () => {
  it('retains a worktree that gained uncommitted output after checkpointing', async () => {
    const info = await createWorktree(repo, 'flow', 'run-late-output', 'HEAD', wtRoot)
    await fs.writeFile(path.join(info.worktreePath, 'a.txt'), 'checkpointed\n')
    execFileSync('git', ['-C', info.worktreePath, 'commit', '-am', 'checkpointed result'])
    const resultSha = execFileSync('git', ['-C', info.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
    await fs.writeFile(path.join(info.worktreePath, 'late.txt'), 'do not delete\n')

    const removed = await removeVerifiedWorktree(
      repo,
      await getRepositoryIdentity(repo),
      info.worktreePath,
      info.branch,
      resultSha,
    )

    expect(removed).toMatchObject({ ok: false, code: 'worktree_dirty' })
    await expect(fs.readFile(path.join(info.worktreePath, 'late.txt'), 'utf-8')).resolves.toBe('do not delete\n')
    expect(git('branch', '--list', info.branch)).toContain(info.branch)
  })
})
