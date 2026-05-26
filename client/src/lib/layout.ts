import type { CwcNode, CwcEdge } from '../../../src/schema.ts'

const H_SPACING = 300
const V_SPACING = 200

export function computeLayout(nodes: CwcNode[], edges: CwcEdge[]): Map<string, { x: number; y: number }> {
  const hasIncoming = new Set(edges.filter((e) => e.to).map((e) => e.to!))
  let roots = nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id)
  // If every node has incoming edges (pure cycle), seed BFS from all nodes
  if (roots.length === 0 && nodes.length > 0) {
    roots = nodes.map((n) => n.id)
  }

  const adj = new Map<string, string[]>()
  for (const node of nodes) adj.set(node.id, [])
  for (const edge of edges) {
    if (edge.to) adj.get(edge.from)?.push(edge.to)
  }

  const level = new Map<string, number>()
  const queue = roots.map((id) => ({ id, lvl: 0 }))
  const visited = new Set<string>()

  while (queue.length > 0) {
    const { id, lvl } = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    level.set(id, lvl)
    for (const child of adj.get(id) ?? []) {
      if (!visited.has(child)) queue.push({ id: child, lvl: lvl + 1 })
    }
  }

  const byLevel = new Map<number, string[]>()
  for (const [id, lvl] of level) {
    const group = byLevel.get(lvl) ?? []
    byLevel.set(lvl, [...group, id])
  }

  const positions = new Map<string, { x: number; y: number }>()
  for (const [lvl, ids] of byLevel) {
    const totalHeight = (ids.length - 1) * V_SPACING
    const startY = -totalHeight / 2
    ids.forEach((id, i) => {
      positions.set(id, { x: lvl * H_SPACING, y: startY + i * V_SPACING })
    })
  }

  return positions
}
