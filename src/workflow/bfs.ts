import type { CwcNode, CwcEdge } from '../schema.js'

interface AnnotatedEdge {
  edge: CwcEdge
  isBackEdge: boolean
}

export interface BfsStep {
  node: CwcNode
  level: number
  outgoingEdges: AnnotatedEdge[]
}

export function bfsTraversal(nodes: CwcNode[], edges: CwcEdge[]): BfsStep[] {
  const nodeMap = new Map(nodes.map(n => [n.id, n]))

  // Build adjacency: from → edges
  const adj = new Map<string, CwcEdge[]>()
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e)
  }

  // Entry nodes: nodes with no incoming edges (ignoring terminal edges where to === null)
  const hasIncoming = new Set(edges.filter(e => e.to !== null).map(e => e.to!))
  let entryIds = nodes.filter(n => !hasIncoming.has(n.id)).map(n => n.id)

  // If every node has incoming edges (pure cycle), seed with the first node
  if (entryIds.length === 0 && nodes.length > 0) {
    entryIds = [nodes[0].id]
  }

  const visited = new Set<string>()
  const steps: BfsStep[] = []

  // Queue of [nodeId, level]
  const queue: Array<[string, number]> = entryIds.map(id => [id, 0])

  while (queue.length > 0) {
    const [id, level] = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)

    const n = nodeMap.get(id)
    if (!n) continue

    const rawEdges = adj.get(id) ?? []
    const annotated: AnnotatedEdge[] = rawEdges.map(e => ({
      edge: e,
      isBackEdge: e.to !== null && visited.has(e.to),
    }))

    steps.push({ node: n, level, outgoingEdges: annotated })

    for (const ae of annotated) {
      if (!ae.isBackEdge && ae.edge.to !== null) {
        queue.push([ae.edge.to, level + 1])
      }
    }
  }

  return steps
}
