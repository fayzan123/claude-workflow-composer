export interface ClaudeModel {
  id: string
  label: string
  chipLabel: string
}

export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: 'claude-opus-4-7',           label: 'Opus 4.7',   chipLabel: 'Opus'   },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', chipLabel: 'Sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  chipLabel: 'Haiku'  },
]

export function modelChipLabel(modelId: string): string {
  const known = CLAUDE_MODELS.find(m => m.id === modelId)
  if (known) return known.chipLabel
  // Defensive fallback for hand-edited .cwc files with unknown model IDs
  const parts = modelId.split('-')
  return parts.length > 1 ? parts[1] : modelId
}
