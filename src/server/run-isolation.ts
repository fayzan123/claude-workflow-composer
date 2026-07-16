// src/server/run-isolation.ts
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

function gitP(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message))
      else resolve(stdout.toString())
    })
  })
}

export interface WorktreeInfo { worktreePath: string; branch: string; baseSha: string }

export type RunGitConflictCode =
  | 'repository_changed'
  | 'destination_dirty'
  | 'destination_moved'
  | 'result_missing'
  | 'branch_missing'
  | 'branch_moved'
  | 'branch_checked_out'
  | 'non_descendant'
  | 'worktree_changed'
  | 'worktree_dirty'
  | 'fast_forward_failed'
  | 'git_error'

export interface RunGitConflict {
  ok: false
  code: RunGitConflictCode
  message: string
}

export interface ManagedResultAuthority {
  destinationCwd: string
  repositoryIdentity: string
  baseSha: string
  branch: string
  resultSha: string
}

export type ApplyPreflightResult = { ok: true; destinationHead: string } | RunGitConflict
export type ApplyResult = { ok: true; appliedSha: string } | RunGitConflict
export type ManagedResultVerification = { ok: true } | RunGitConflict
export type DiscardPreflightResult = { ok: true } | RunGitConflict
export type DiscardResult = { ok: true; discardedSha: string } | RunGitConflict
export type ManagedWorktreeInspection = { ok: true; resultSha: string } | RunGitConflict

export async function isGitRepo(cwd: string): Promise<boolean> {
  try { await gitP(cwd, ['rev-parse', '--git-dir']); return true } catch { return false }
}

/** Canonical Git common directory; identical for a repository and all of its worktrees. */
export async function getRepositoryIdentity(cwd: string): Promise<string> {
  const raw = (await gitP(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  const absolute = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  const canonical = await fs.realpath(absolute)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export async function resolveBaseSha(cwd: string, baseRef: string): Promise<string> {
  return (await gitP(cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim()
}

export async function resolveHeadSha(cwd: string): Promise<string> {
  return resolveBaseSha(cwd, 'HEAD')
}

export async function createWorktree(repoCwd: string, workflowSlug: string, runId: string, baseRef: string, worktreesRoot: string): Promise<WorktreeInfo> {
  const baseSha = await resolveBaseSha(repoCwd, baseRef)
  const branch = `cwc/${workflowSlug}/${runId}`
  const worktreePath = path.join(worktreesRoot, runId)
  await gitP(repoCwd, ['worktree', 'add', '-b', branch, worktreePath, baseSha])
  return { worktreePath, branch, baseSha }
}

/** Commit every non-ignored worktree change so forced cleanup cannot discard run output. */
export async function checkpointWorktree(worktreePath: string, runId: string): Promise<boolean> {
  const status = await gitP(worktreePath, ['status', '--porcelain', '--untracked-files=all'])
  if (!status.trim()) return false
  await gitP(worktreePath, ['add', '-A'])
  await gitP(worktreePath, [
    '-c', 'user.name=Claude Workflow Composer',
    '-c', 'user.email=cwc@localhost',
    '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '-m', `CWC run ${runId} result`,
  ])
  return true
}

export async function removeWorktree(repoCwd: string, worktreePath: string, branch: string, opts: { keepBranch: boolean }): Promise<void> {
  await gitP(repoCwd, ['worktree', 'remove', '--force', worktreePath]).catch(() => { /* already gone */ })
  if (!opts.keepBranch) await gitP(repoCwd, ['branch', '-D', branch]).catch(() => { /* already gone */ })
}

export async function getDiff(dir: string, baseSha: string, ref?: string): Promise<{ diff: string; status: string }> {
  if (ref) {
    // Non-live ref (e.g. a kept run branch). Working-tree status is meaningless here,
    // so report the committed change set as a stat summary instead.
    const diff = await gitP(dir, ['diff', `${baseSha}..${ref}`])
    const status = await gitP(dir, ['diff', '--stat', `${baseSha}..${ref}`])
    return { diff, status }
  }
  // A live worktree can have staged or unstaged gate output that has not been
  // checkpointed yet. Compare the full working tree to the base, not just HEAD.
  const diff = await gitP(dir, ['diff', baseSha])
  const status = await gitP(dir, ['status', '--short'])
  return { diff, status }
}

async function readBranchSha(cwd: string, branch: string): Promise<string | null> {
  try {
    return (await gitP(cwd, ['show-ref', '--verify', '--hash', `refs/heads/${branch}`])).trim()
  } catch {
    return null
  }
}

async function commitExists(cwd: string, sha: string): Promise<boolean> {
  try {
    await gitP(cwd, ['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await gitP(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch {
    return false
  }
}

function gitConflict(code: RunGitConflictCode, message: string): RunGitConflict {
  return { ok: false, code, message }
}

async function verifyRepository(cwd: string, expectedIdentity: string): Promise<RunGitConflict | null> {
  try {
    const actual = await getRepositoryIdentity(cwd)
    if (actual !== expectedIdentity) {
      return gitConflict('repository_changed', 'The destination no longer belongs to the Git repository recorded for this run. Reopen the original checkout or integrate the result branch manually.')
    }
    return null
  } catch {
    return gitConflict('repository_changed', 'The original destination is no longer a readable Git repository. Restore it before applying or discarding this result.')
  }
}

export async function verifyManagedResult(authority: ManagedResultAuthority): Promise<ManagedResultVerification> {
  const repositoryConflict = await verifyRepository(authority.destinationCwd, authority.repositoryIdentity)
  if (repositoryConflict) return repositoryConflict
  try {
    if (!await commitExists(authority.destinationCwd, authority.resultSha)) {
      return gitConflict('result_missing', `The preserved result commit ${authority.resultSha.slice(0, 12)} no longer exists.`)
    }
    const branchSha = await readBranchSha(authority.destinationCwd, authority.branch)
    if (!branchSha) return gitConflict('branch_missing', `The CWC result branch ${authority.branch} no longer exists.`)
    if (branchSha !== authority.resultSha) {
      return gitConflict('branch_moved', `The CWC result branch ${authority.branch} moved from ${authority.resultSha.slice(0, 12)} to ${branchSha.slice(0, 12)}.`)
    }
    if (!await isAncestor(authority.destinationCwd, authority.baseSha, authority.resultSha)) {
      return gitConflict('non_descendant', `The preserved result ${authority.resultSha.slice(0, 12)} does not descend from the recorded base.`)
    }
    return { ok: true }
  } catch (err) {
    return gitConflict('git_error', `Git result verification failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function preflightApplyResult(authority: ManagedResultAuthority): Promise<ApplyPreflightResult> {
  const repositoryConflict = await verifyRepository(authority.destinationCwd, authority.repositoryIdentity)
  if (repositoryConflict) return repositoryConflict

  try {
    const status = (await gitP(authority.destinationCwd, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()
    if (status) {
      const preview = status.split(/\r?\n/).slice(0, 5).join(', ')
      return gitConflict('destination_dirty', `The destination has staged, unstaged, or untracked changes (${preview}). Commit, stash, or remove them yourself before applying; CWC will not alter them.`)
    }

    const destinationHead = await resolveHeadSha(authority.destinationCwd)
    if (destinationHead !== authority.baseSha) {
      return gitConflict('destination_moved', `The destination moved from the recorded base ${authority.baseSha.slice(0, 12)} to ${destinationHead.slice(0, 12)}. Return it to the recorded base or integrate ${authority.branch} manually.`)
    }
    if (!await commitExists(authority.destinationCwd, authority.resultSha)) {
      return gitConflict('result_missing', `The preserved result commit ${authority.resultSha.slice(0, 12)} no longer exists. CWC did not change the destination.`)
    }
    const branchSha = await readBranchSha(authority.destinationCwd, authority.branch)
    if (!branchSha) {
      return gitConflict('branch_missing', `The CWC result branch ${authority.branch} no longer exists. CWC did not change the destination.`)
    }
    if (branchSha !== authority.resultSha) {
      return gitConflict('branch_moved', `The CWC result branch ${authority.branch} moved from ${authority.resultSha.slice(0, 12)} to ${branchSha.slice(0, 12)}. Review it manually; CWC will not apply the changed branch.`)
    }
    if (!await isAncestor(authority.destinationCwd, authority.baseSha, authority.resultSha)) {
      return gitConflict('non_descendant', `The preserved result ${authority.resultSha.slice(0, 12)} does not descend from the recorded base. CWC will not merge or rewrite history.`)
    }
    return { ok: true, destinationHead }
  } catch (err) {
    return gitConflict('git_error', `Git preflight failed without changing the destination: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function applyResultFastForward(authority: ManagedResultAuthority): Promise<ApplyResult> {
  const preflight = await preflightApplyResult(authority)
  if (!preflight.ok) return preflight
  try {
    await gitP(authority.destinationCwd, ['merge', '--ff-only', authority.resultSha])
    const appliedSha = await resolveHeadSha(authority.destinationCwd)
    if (appliedSha !== authority.resultSha) {
      return gitConflict('fast_forward_failed', `Git did not finish at the preserved result ${authority.resultSha.slice(0, 12)}. Inspect the destination before retrying.`)
    }
    return { ok: true, appliedSha }
  } catch (err) {
    return gitConflict('fast_forward_failed', `Git could not fast-forward the destination. CWC did not merge, rebase, reset, or resolve conflicts: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function branchIsCheckedOut(cwd: string, branch: string): Promise<boolean> {
  const porcelain = await gitP(cwd, ['worktree', 'list', '--porcelain'])
  return porcelain.split(/\r?\n/).some(line => line === `branch refs/heads/${branch}`)
}

export async function preflightDiscardResult(authority: ManagedResultAuthority): Promise<DiscardPreflightResult> {
  const repositoryConflict = await verifyRepository(authority.destinationCwd, authority.repositoryIdentity)
  if (repositoryConflict) return repositoryConflict
  try {
    const branchSha = await readBranchSha(authority.destinationCwd, authority.branch)
    if (!branchSha) {
      return gitConflict('branch_missing', `The CWC result branch ${authority.branch} no longer exists. No branch was deleted.`)
    }
    if (branchSha !== authority.resultSha) {
      return gitConflict('branch_moved', `The CWC result branch ${authority.branch} moved from ${authority.resultSha.slice(0, 12)} to ${branchSha.slice(0, 12)}. CWC will not delete a changed branch.`)
    }
    if (await branchIsCheckedOut(authority.destinationCwd, authority.branch)) {
      return gitConflict('branch_checked_out', `The CWC result branch ${authority.branch} is checked out. Switch every worktree away from it before discarding.`)
    }
    return { ok: true }
  } catch (err) {
    return gitConflict('git_error', `Git discard preflight failed without deleting a branch: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function discardResultBranch(authority: ManagedResultAuthority): Promise<DiscardResult> {
  const preflight = await preflightDiscardResult(authority)
  if (!preflight.ok) return preflight
  try {
    // Expected-old-value deletion is atomic: a branch that moves after preflight is preserved.
    await gitP(authority.destinationCwd, ['update-ref', '-d', `refs/heads/${authority.branch}`, authority.resultSha])
    const remaining = await readBranchSha(authority.destinationCwd, authority.branch)
    if (remaining !== null) {
      return gitConflict('branch_moved', `The CWC result branch ${authority.branch} changed while Discard was running, so it was preserved.`)
    }
    return { ok: true, discardedSha: authority.resultSha }
  } catch (err) {
    return gitConflict('git_error', `Git could not delete the verified CWC result branch. The destination and working files were not changed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function inspectManagedWorktree(
  repoCwd: string,
  repositoryIdentity: string,
  worktreePath: string,
  branch: string,
): Promise<ManagedWorktreeInspection> {
  const repositoryConflict = await verifyRepository(repoCwd, repositoryIdentity)
  if (repositoryConflict) return repositoryConflict
  try {
    const worktreeIdentity = await getRepositoryIdentity(worktreePath)
    if (worktreeIdentity !== repositoryIdentity) {
      return gitConflict('worktree_changed', 'The recorded run worktree no longer belongs to the managed repository. CWC preserved it for manual recovery.')
    }
    const currentBranch = (await gitP(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim()
    if (currentBranch !== branch) {
      return gitConflict('worktree_changed', `The recorded run worktree now has ${currentBranch || 'a detached HEAD'} checked out instead of ${branch}. CWC preserved it for manual recovery.`)
    }
    const resultSha = await resolveHeadSha(worktreePath)
    const branchSha = await readBranchSha(repoCwd, branch)
    if (branchSha !== resultSha) {
      return gitConflict('branch_moved', `The managed branch ${branch} no longer matches its run worktree. CWC preserved both for manual recovery.`)
    }
    return { ok: true, resultSha }
  } catch (err) {
    return gitConflict('git_error', `CWC could not verify the recorded run worktree and preserved it: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function removeVerifiedWorktree(
  repoCwd: string,
  repositoryIdentity: string,
  worktreePath: string,
  branch: string,
  resultSha: string,
): Promise<ManagedWorktreeInspection> {
  const inspection = await inspectManagedWorktree(repoCwd, repositoryIdentity, worktreePath, branch)
  if (!inspection.ok) return inspection
  if (inspection.resultSha !== resultSha) {
    return gitConflict('branch_moved', `The managed branch ${branch} moved after checkpointing. CWC preserved the worktree and branch for manual recovery.`)
  }
  try {
    const status = (await gitP(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).trim()
    if (status) {
      return gitConflict('worktree_dirty', 'The managed worktree changed after checkpointing. CWC retained it so no uncommitted run output is lost.')
    }
    await gitP(repoCwd, ['worktree', 'remove', '--force', worktreePath])
    return inspection
  } catch (err) {
    return gitConflict('git_error', `CWC preserved the result branch but could not remove its worktree: ${err instanceof Error ? err.message : String(err)}`)
  }
}
