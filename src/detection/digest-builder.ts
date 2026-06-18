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

/**
 * Turn task units into compact, ref-tagged per-repo digests for the LLM.
 * Refs (`r0`, `r1`, …) are assigned globally in order so the analyzer can map a
 * cited ref back to its unit to compute evidence. Trivial (no-tool) units are dropped.
 */
export function buildDigests(units: TaskUnit[]): RepoDigest[] {
  const byRepo = new Map<string, DigestLine[]>()
  let n = 0
  for (const u of units) {
    if (!isMeaningful(u)) continue
    const ref = `r${n++}`
    const repo = u.cwd || '(unknown)'
    const line: DigestLine = { ref, unit: u, text: formatLine(ref, u) }
    ;(byRepo.get(repo) ?? byRepo.set(repo, []).get(repo)!).push(line)
  }
  return [...byRepo.entries()].map(([repo, lines]) => ({ repo, lines }))
}
