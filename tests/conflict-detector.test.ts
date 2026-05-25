import { describe, it, expect } from 'vitest'
import { detectConflict, ConflictStatus } from '../src/conflict-detector.js'

const agentRegex = /^<!-- cwc:node:[^:\s]+:workflow:[^:\s>]+ -->$/
const workflowRegex = /^<!-- cwc:workflow:[^:\s>]+ -->$/

describe('detectConflict', () => {
  it('returns OWNED when last non-blank line matches current workflow UUID', () => {
    const content = 'some content\n\n<!-- cwc:node:node-1:workflow:abc-123 -->\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('owned')
  })

  it('returns FOREIGN when last non-blank line matches different UUID', () => {
    const content = 'some content\n<!-- cwc:node:node-1:workflow:other-uuid -->\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('foreign')
  })

  it('returns ABSENT when last non-blank line has no cwc comment', () => {
    const content = 'some content without comment\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('absent')
  })

  it('returns MALFORMED when last non-blank line starts with <!-- cwc: but does not match regex', () => {
    const content = 'some content\n<!-- cwc:node: -->\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('malformed')
  })

  it('ignores trailing blank lines when scanning', () => {
    const content = 'some content\n<!-- cwc:node:node-1:workflow:abc-123 -->\n\n\n'
    expect(detectConflict(content, agentRegex, 'abc-123')).toBe('owned')
  })

  it('works for workflow skill regex', () => {
    const content = 'body\n<!-- cwc:workflow:wf-uuid-456 -->\n'
    expect(detectConflict(content, workflowRegex, 'wf-uuid-456')).toBe('owned')
  })
})
