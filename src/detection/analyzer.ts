// src/detection/analyzer.ts
import { createHash } from 'node:crypto'
import type { ClaudeRunner } from '../server/claude-runner.js'
import { extractJsonObject } from '../json-extract.js'
import type { TaskUnit, DetectedAutomation, AutomationEvidence } from './types.js'
import { buildDigests } from './digest-builder.js'
import { buildAnalysisPrompt } from './analysis-prompt.js'

interface RawAutomation {
  title?: string; description?: string; steps?: unknown; stepTokens?: unknown; refs?: unknown
  suggestedTrigger?: { kind?: string; cron?: string; label?: string }; confidence?: number
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function deriveId(repos: string[], stepTokens: string[]): string {
  const key = [...repos].sort().join('|') + '::' + [...stepTokens].sort().join('+')
  return createHash('sha256').update(key).digest('hex').slice(0, 12)
}

function evidenceFrom(units: TaskUnit[]): AutomationEvidence {
  const times = units.map(u => u.startedAt).filter(Boolean).sort()
  return {
    count: units.length,
    repos: [...new Set(units.map(u => u.cwd).filter(Boolean))],
    sessionIds: [...new Set(units.map(u => u.sessionId).filter(Boolean))],
    firstSeen: times[0] ?? '',
    lastSeen: times.at(-1) ?? '',
  }
}

/** Run the deep analysis over task units with an injected Claude runner. */
export async function analyzeUnits(units: TaskUnit[], runner: ClaudeRunner): Promise<DetectedAutomation[]> {
  const digests = buildDigests(units)
  if (digests.length === 0) return []
  const refIndex = new Map(digests.flatMap(d => d.lines).map(l => [l.ref, l.unit]))

  const out = await runner(buildAnalysisPrompt(digests), { timeoutMs: 5 * 60_000 })
  const json = extractJsonObject(out.result)
  if (!json) return []
  let parsed: { automations?: RawAutomation[] }
  try { parsed = JSON.parse(json) } catch { return [] }

  const results: DetectedAutomation[] = []
  for (const a of parsed.automations ?? []) {
    const refs = strArray(a.refs)
    const refUnits = refs.map(r => refIndex.get(r)).filter((u): u is TaskUnit => !!u)
    if (refUnits.length === 0) continue
    const stepTokens = strArray(a.stepTokens)
    const evidence = evidenceFrom(refUnits)
    const kind = a.suggestedTrigger?.kind === 'schedule' || a.suggestedTrigger?.kind === 'event' ? a.suggestedTrigger.kind : 'manual'
    results.push({
      id: deriveId(evidence.repos, stepTokens),
      title: String(a.title ?? '').trim() || 'Untitled automation',
      description: String(a.description ?? '').trim(),
      steps: strArray(a.steps),
      stepTokens,
      evidence,
      suggestedTrigger: { kind, cron: a.suggestedTrigger?.cron || undefined, label: a.suggestedTrigger?.label ?? '' },
      confidence: typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.5,
      status: 'new',
    })
  }
  return results.sort((x, y) => y.confidence - x.confidence)
}
