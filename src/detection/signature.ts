// src/detection/signature.ts
import type { TaskUnit } from './types.js'

/** Salient, automation-worthy command signals. Order = display order. */
const SALIENT: { label: string; re: RegExp }[] = [
  { label: 'tests',     re: /\b(npm (run )?test|vitest|jest|pytest|go test|cargo test)\b/ },
  { label: 'build',     re: /\b(npm run build|tsc\b|vite build|make\b|cargo build)\b/ },
  { label: 'git-commit',re: /\bgit commit\b/ },
  { label: 'git-push',  re: /\bgit push\b/ },
  { label: 'pr-create', re: /\bgh pr create\b/ },
  { label: 'publish',   re: /\b(npm publish|gh release|cargo publish)\b/ },
  { label: 'deploy',    re: /\b(deploy|vercel|netlify|fly deploy|gcloud (app|run) deploy)\b/ },
  { label: 'lint',      re: /\b(eslint|npm run lint|ruff|golangci-lint)\b/ },
]

export interface SignatureResult { signature: string; labels: string[]; summary: string }

/** Derive a stable signature from a unit's salient commands. null = no salient signal (skip). */
export function deriveSignature(unit: TaskUnit): SignatureResult | null {
  const hits = new Set<string>()
  for (const cmd of unit.commands) for (const s of SALIENT) if (s.re.test(cmd)) hits.add(s.label)
  if (hits.size === 0) return null
  const labels = SALIENT.map(s => s.label).filter(l => hits.has(l))   // stable order
  return {
    signature: labels.join('+'),
    labels,
    summary: labels.join(' → '),
  }
}
