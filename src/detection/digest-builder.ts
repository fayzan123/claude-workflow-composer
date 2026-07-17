// src/detection/digest-builder.ts
import type { TaskUnit } from './types.js'
import { deriveSignature } from './signature.js'

interface DigestLine { ref: string; unit: TaskUnit; text: string }
export interface RepoDigest { repo: string; originalRepo: string; lines: DigestLine[] }

function normalizedPromptKey(value: string): string {
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ')
}

/** Tool work is always eligible. Prompt-only work is eligible only after the
 * same normalized instruction appears three times, keeping social/one-off turns
 * out of the bounded analysis digest while making the rule tier reachable. */
function isMeaningful(u: TaskUnit, promptCounts: Map<string, number>): boolean {
  if (u.tools.length > 0 || u.commands.length > 0) return true
  const key = normalizedPromptKey(u.promptText)
  return key.length > 0 && (promptCounts.get(key) ?? 0) >= 3
}

function formatLine(ref: string, u: TaskUnit): string {
  const when = u.startedAt ? u.startedAt.slice(0, 16).replace('T', ' ') : '????-??-?? ??:??'
  const tools = [...new Set(u.tools)].slice(0, 6).join(',') || '(none)'
  const sig = deriveSignature(u)
  const labels = sig ? ` · ${sig.labels.join(',')}` : ''
  const prompt = u.promptText || '(no prompt text)'
  return `[${ref}] ${when} · "${prompt}" · ${tools}${labels}`
}

export interface BuildDigestOpts {
  /** Max lines kept per repo (most-recent first). Default: 120 */
  maxPerRepo?: number
  /** Max lines kept in total across all repos (most-recent first). Default: 500 */
  maxTotal?: number
}

/**
 * Turn task units into compact, ref-tagged per-repo digests for the LLM.
 * Refs (`r0`, `r1`, …) are assigned globally in order so the analyzer can map a
 * cited ref back to its unit to compute evidence. One-off no-tool units are dropped; repeated
 * prompt-only instructions remain eligible for the rule tier.
 *
 * Capping (recency-first): all meaningful units are sorted descending by startedAt,
 * the overall list is capped at `maxTotal`, then each repo bucket is capped at
 * `maxPerRepo`. Refs are assigned AFTER capping, so they are always sequential.
 */
export function buildDigests(units: TaskUnit[], opts?: BuildDigestOpts): RepoDigest[] {
  const maxPerRepo = opts?.maxPerRepo ?? 120
  const maxTotal = opts?.maxTotal ?? 500

  // 1. Filter to meaningful units. Counts are computed before capping so all
  // three grounded occurrences of a repeated instruction remain eligible.
  const promptCounts = new Map<string, number>()
  for (const unit of units) {
    if (unit.tools.length > 0 || unit.commands.length > 0) continue
    const key = normalizedPromptKey(unit.promptText)
    if (key) promptCounts.set(key, (promptCounts.get(key) ?? 0) + 1)
  }
  const meaningful = units.filter(unit => isMeaningful(unit, promptCounts))

  // 2. Sort descending by startedAt; empty startedAt sorts last
  meaningful.sort((a, b) => {
    if (!a.startedAt && !b.startedAt) return 0
    if (!a.startedAt) return 1
    if (!b.startedAt) return -1
    return b.startedAt.localeCompare(a.startedAt)
  })

  // 3. Cap globally (most-recent first)
  const capped = meaningful.slice(0, maxTotal)

  // 4. Bucket by repo, cap per-repo (units already sorted recency-first)
  const byRepo = new Map<string, TaskUnit[]>()
  for (const u of capped) {
    const repo = u.cwd || '(unknown)'
    const bucket = byRepo.get(repo) ?? []
    if (bucket.length < maxPerRepo) {
      bucket.push(u)
      byRepo.set(repo, bucket)
    }
  }

  // 5. Assign refs globally in final emitted order
  let n = 0
  return [...byRepo.entries()].map(([originalRepo, repoUnits], index) => {
    const repo = originalRepo === '(unknown)' ? '(unknown)' : `repo-${index + 1}`
    const lines: DigestLine[] = repoUnits.map(u => {
      const ref = `r${n++}`
      return { ref, unit: u, text: formatLine(ref, u) }
    })
    return { repo, originalRepo, lines }
  })
}
