import type { CwcFile, CwcNode, CwcEdge } from '../types.ts'
import { computeLayout } from './layout.ts'
import { v4 as uuidv4 } from 'uuid'

export interface TemplateDefinition {
  slug: string
  name: string
  description: string
  pattern: string
  nodes: Omit<CwcNode, 'position'>[]
  edges: CwcEdge[]
}

export const TEMPLATES: TemplateDefinition[] = []

export function instantiateTemplate(template: TemplateDefinition): CwcFile {
  const positions = computeLayout(
    template.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })),
    template.edges
  )
  const nodes: CwcNode[] = template.nodes.map((n) => ({
    ...n,
    position: positions.get(n.id) ?? { x: 0, y: 0 },
  }))
  return {
    meta: {
      id: uuidv4(),
      name: template.name,
      description: template.description,
      version: 1,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    },
    nodes,
    edges: template.edges,
  }
}
