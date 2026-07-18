// src/detection/analyzer.ts
import { createHash } from 'node:crypto'
import type { ClaudeRunner } from '../server/claude-runner.js'
import { extractJsonObject } from '../json-extract.js'
import type { TaskUnit, DetectedAutomation, AutomationEvidence } from './types.js'
import { buildDigests } from './digest-builder.js'
import { buildAnalysisPrompt } from './analysis-prompt.js'
import { deriveAutomationShape, deriveRuleSuggestion } from './automation-shape.js'
import { classifyAutomationWithReason } from '../generation/classifier.js'

interface RawAutomation {
  title?: string; description?: string; steps?: unknown; stepTokens?: unknown; refs?: unknown
  suggestedTrigger?: { kind?: string; cron?: string; label?: string }; confidence?: number
}

const MIN_EVIDENCE_OCCURRENCES = 3

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function deriveId(repos: string[], stepTokens: string[], fallback: string): string {
  const groundedTokens = stepTokens.length > 0 ? [...stepTokens].sort().join('+') : fallback.toLowerCase()
  const key = [...repos].sort().join('|') + '::' + groundedTokens
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

export function buildAnalysisContext(units: TaskUnit[]): { prompt: string; refIndex: Map<string, TaskUnit> } | null {
  const digests = buildDigests(units)
  if (digests.length === 0) return null
  const refIndex = new Map(digests.flatMap(d => d.lines).map(l => [l.ref, l.unit]))
  return { prompt: buildAnalysisPrompt(digests), refIndex }
}

export function parseAutomations(resultText: string, refIndex: Map<string, TaskUnit>): DetectedAutomation[] {
  const json = extractJsonObject(resultText)
  if (!json) return []
  let parsed: { automations?: RawAutomation[] }
  try { parsed = JSON.parse(json) } catch { return [] }

  const results: DetectedAutomation[] = []
  for (const a of parsed.automations ?? []) {
    const refs = [...new Set(strArray(a.refs))]
    const refUnits = refs.map(r => refIndex.get(r)).filter((u): u is TaskUnit => !!u)
    if (refUnits.length < MIN_EVIDENCE_OCCURRENCES) continue
    const steps = strArray(a.steps).map(step => step.replace(/\s+/g, ' ').trim()).filter(Boolean)
    if (steps.length < 1 || steps.length > 6) continue
    const stepTokens = strArray(a.stepTokens)
    const evidence = evidenceFrom(refUnits)
    const kind = a.suggestedTrigger?.kind === 'schedule' || a.suggestedTrigger?.kind === 'event' ? a.suggestedTrigger.kind : 'manual'
    const suggestedTrigger = { kind, cron: a.suggestedTrigger?.cron || undefined, label: a.suggestedTrigger?.label ?? '' } as const
    const title = String(a.title ?? '').trim() || 'Untitled automation'
    const description = String(a.description ?? '').trim()
    const groundedRule = deriveRuleSuggestion(refUnits)
    const shape = deriveAutomationShape({ steps, evidence, suggestedTrigger }, refUnits)
    const idFallback = shape.hasToolActivity
      ? [title, ...steps, groundedRule ?? ''].join('|')
      : groundedRule ?? [title, ...steps].join('|')
    const automation: DetectedAutomation = {
      id: deriveId(evidence.repos, stepTokens, idFallback),
      title: String(a.title ?? '').trim() || 'Untitled automation',
      description,
      steps,
      stepTokens,
      evidence,
      suggestedTrigger,
      confidence: typeof a.confidence === 'number' ? Math.max(0, Math.min(1, a.confidence)) : 0.5,
      status: 'new',
      shape,
    }
    const recommendation = classifyAutomationWithReason(automation)
    automation.recommendedTier = recommendation.tier
    automation.recommendedTierReason = recommendation.reason
    // Keep the evidence-grounded prompt for every tier. Users may deliberately
    // override a skill/loop/workflow recommendation to a standing rule later.
    if (groundedRule) automation.ruleSuggestion = groundedRule
    // A command-driven repetition is already automated: the useful rule names the
    // installed command instead of restating the raw slash-command prompt blob.
    if (shape.invokedSlashCommand) {
      automation.ruleSuggestion = `Use the installed /${shape.invokedSlashCommand} command for this: ${automation.title}`
    }
    results.push(automation)
  }
  return results.sort((x, y) => y.confidence - x.confidence)
}

/** Run the deep analysis over task units with an injected Claude runner. */
export async function analyzeUnits(units: TaskUnit[], runner: ClaudeRunner): Promise<DetectedAutomation[]> {
  const ctx = buildAnalysisContext(units)
  if (!ctx) return []
  const out = await runner(ctx.prompt, { timeoutMs: 5 * 60_000 })
  return parseAutomations(out.result, ctx.refIndex)
}
