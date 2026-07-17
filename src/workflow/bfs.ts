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

/** Prefer a stable topological traversal for acyclic workflows. A shortest-path
 * BFS can visit an uneven branch's join before the longer sibling has reached it,
 * which makes generated numbered prose describe the join too early. */
function topologicalTraversal(nodes: CwcNode[], edges: CwcEdge[]): BfsStep[] | null {
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const graphEdges = edges.filter(edge => edge.to !== null
    && nodeMap.has(edge.from) && nodeMap.has(edge.to))
  const outgoing = new Map<string, CwcEdge[]>()
  const indegree = new Map(nodes.map(node => [node.id, 0]))
  for (const edge of graphEdges) {
    const list = outgoing.get(edge.from) ?? []
    list.push(edge)
    outgoing.set(edge.from, list)
    indegree.set(edge.to!, (indegree.get(edge.to!) ?? 0) + 1)
  }

  const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id)
  const level = new Map(queue.map(id => [id, 0]))
  const result: BfsStep[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    const node = nodeMap.get(id)
    if (!node) continue
    const rawEdges = edges.filter(edge => edge.from === id)
    result.push({
      node,
      level: level.get(id) ?? 0,
      outgoingEdges: rawEdges.map(edge => ({ edge, isBackEdge: false })),
    })
    for (const edge of outgoing.get(id) ?? []) {
      level.set(edge.to!, Math.max(level.get(edge.to!) ?? 0, (level.get(id) ?? 0) + 1))
      const remaining = (indegree.get(edge.to!) ?? 0) - 1
      indegree.set(edge.to!, remaining)
      if (remaining === 0) queue.push(edge.to!)
    }
  }

  return result.length === nodes.length ? result : null
}

export function bfsTraversal(nodes: CwcNode[], edges: CwcEdge[]): BfsStep[] {
  const topological = topologicalTraversal(nodes, edges)
  if (topological) return topological

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
