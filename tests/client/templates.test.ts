import { describe, it, expect } from 'vitest'
import { TEMPLATES, instantiateTemplate } from '../../client/src/lib/templates.ts'

describe('instantiateTemplate', () => {
  it('assigns a fresh uuid to meta.id for each call', () => {
    const a = instantiateTemplate(TEMPLATES[0])
    const b = instantiateTemplate(TEMPLATES[0])
    expect(a.meta.id).toBeTruthy()
    expect(a.meta.id).not.toBe(b.meta.id)
  })

  it('assigns positions to all nodes', () => {
    for (const template of TEMPLATES) {
      const cwc = instantiateTemplate(template)
      for (const node of cwc.nodes) {
        expect(typeof node.position.x).toBe('number')
        expect(typeof node.position.y).toBe('number')
      }
    }
  })

  it('preserves all edges from the template', () => {
    const cwc = instantiateTemplate(TEMPLATES[0])
    expect(cwc.edges.length).toBe(TEMPLATES[0].edges.length)
  })

  it('has 4 templates', () => {
    expect(TEMPLATES.length).toBe(4)
  })

  it('each template has slug, name, description, nodes, edges', () => {
    for (const t of TEMPLATES) {
      expect(t.slug).toBeTruthy()
      expect(t.name).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(t.nodes.length).toBeGreaterThan(0)
      expect(t.edges.length).toBeGreaterThan(0)
    }
  })
})
