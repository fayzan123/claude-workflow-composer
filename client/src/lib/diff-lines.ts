export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'ctx'

/** Classify a single unified-diff line for syntax coloring. Order matters:
 *  `+++`/`---` file headers must be caught as meta before the `+`/`-` line checks. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'meta'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}
