// src/server/run-isolation.ts
import { execFile } from 'node:child_process'
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

export async function isGitRepo(cwd: string): Promise<boolean> {
  try { await gitP(cwd, ['rev-parse', '--git-dir']); return true } catch { return false }
}

export async function resolveBaseSha(cwd: string, baseRef: string): Promise<string> {
  return (await gitP(cwd, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim()
}

export async function createWorktree(repoCwd: string, workflowSlug: string, runId: string, baseRef: string, worktreesRoot: string): Promise<WorktreeInfo> {
  const baseSha = await resolveBaseSha(repoCwd, baseRef)
  const branch = `cwc/${workflowSlug}/${runId}`
  const worktreePath = path.join(worktreesRoot, runId)
  await gitP(repoCwd, ['worktree', 'add', '-b', branch, worktreePath, baseSha])
  return { worktreePath, branch, baseSha }
}

export async function removeWorktree(repoCwd: string, worktreePath: string, branch: string, opts: { keepBranch: boolean }): Promise<void> {
  await gitP(repoCwd, ['worktree', 'remove', '--force', worktreePath]).catch(() => { /* already gone */ })
  if (!opts.keepBranch) await gitP(repoCwd, ['branch', '-D', branch]).catch(() => { /* already gone */ })
}

export async function getDiff(dir: string, baseSha: string): Promise<{ diff: string; status: string }> {
  const diff = await gitP(dir, ['diff', `${baseSha}..HEAD`])
  const status = await gitP(dir, ['status', '--short'])
  return { diff, status }
}
