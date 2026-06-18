// src/detection/digest-builder.ts
import type { TaskUnit } from './types.js'
import { deriveSignature } from './signature.js'

export interface DigestLine { ref: string; unit: TaskUnit; text: string }
export interface RepoDigest { repo: string; lines: DigestLine[] }

/** A unit is worth analyzing only if it did real work (used at least one tool). */
function isMeaningful(u: TaskUnit): boolean { return u.tools.length > 0 }

function formatLine(ref: string, u: TaskUnit): string {
  const when = u.startedAt ? u.startedAt.slice(0, 16).replace('T', ' ') : '????-??-?? ??:??'
  const tools = [...new Set(u.tools)].slice(0, 6).join(',')
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
 * cited ref back to its unit to compute evidence. Trivial (no-tool) units are dropped.
 *
 * Capping (recency-first): all meaningful units are sorted descending by startedAt,
 * the overall list is capped at `maxTotal`, then each repo bucket is capped at
 * `maxPerRepo`. Refs are assigned AFTER capping, so they are always sequential.
 */
export function buildDigests(units: TaskUnit[], opts?: BuildDigestOpts): RepoDigest[] {
  const maxPerRepo = opts?.maxPerRepo ?? 120
  const maxTotal = opts?.maxTotal ?? 500

  // 1. Filter to meaningful units
  const meaningful = units.filter(isMeaningful)

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
  return [...byRepo.entries()].map(([repo, repoUnits]) => {
    const lines: DigestLine[] = repoUnits.map(u => {
      const ref = `r${n++}`
      return { ref, unit: u, text: formatLine(ref, u) }
    })
    return { repo, lines }
  })
}
