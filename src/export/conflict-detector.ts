export type ConflictStatus = 'owned' | 'foreign' | 'absent' | 'malformed'

export function detectConflict(
  fileContent: string,
  ownershipRegex: RegExp,
  currentWorkflowId: string,
): ConflictStatus {
  const lines = fileContent.split('\n')
  // Scan upward for first non-blank line
  let lastNonBlank: string | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.length > 0) {
      lastNonBlank = trimmed
      break
    }
  }

  if (lastNonBlank === null) return 'absent'

  if (!lastNonBlank.startsWith('<!-- cwc:')) return 'absent'

  if (!ownershipRegex.test(lastNonBlank)) return 'malformed'

  // Extract UUID — last token before ' -->'
  const uuidMatch = lastNonBlank.match(/([^\s:>]+) -->$/)
  if (!uuidMatch) return 'malformed'
  const foundId = uuidMatch[1]

  return foundId === currentWorkflowId ? 'owned' : 'foreign'
}
