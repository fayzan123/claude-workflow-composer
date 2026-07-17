import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { addRuleToFile, buildRuleBlock, normalizeRuleSuggestion, removeRuleFromFile } from '../../src/server/rule-files.js'

describe('managed rule files', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-rules-'))
    file = path.join(dir, 'nested', 'AGENTS.md')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('creates an ownership-marked rule and is idempotent', async () => {
    expect(await addRuleToFile(file, 'abc123', 'Always use npm')).toBe('added')
    expect(await addRuleToFile(file, 'abc123', 'A changed suggestion')).toBe('already-present')
    expect(await fs.readFile(file, 'utf-8')).toBe(`${buildRuleBlock('abc123', 'Always use npm')}\n`)
  })

  it('appends and removes without changing surrounding user content', async () => {
    const original = '# Guidance\n\nKeep changes scoped.\n'
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, original)
    await addRuleToFile(file, 'rule-1', 'Run focused tests first')
    expect(await removeRuleFromFile(file, 'rule-1')).toBe('removed')
    expect(await fs.readFile(file, 'utf-8')).toBe(original)
    expect(await removeRuleFromFile(file, 'rule-1')).toBe('not-found')
  })

  it('round-trips a file that already ends with a blank line without eating user newlines', async () => {
    const original = '# Guidance\n\nAlready has a blank line.\n\n'
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, original)
    await addRuleToFile(file, 'rule-2', 'Keep the blank line intact')
    expect(await removeRuleFromFile(file, 'rule-2')).toBe('removed')
    expect(await fs.readFile(file, 'utf-8')).toBe(original)
  })

  it('serializes concurrent rules targeting the same guidance file', async () => {
    await Promise.all([
      addRuleToFile(file, 'rule-a', 'Use npm'),
      addRuleToFile(file, 'rule-b', 'Run tests'),
    ])
    const content = await fs.readFile(file, 'utf-8')
    expect(content).toContain('<!-- cwc:rule:rule-a -->')
    expect(content).toContain('<!-- cwc:rule:rule-b -->')
  })

  it('preserves an external editor save that races an add before rename', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '# Original guidance\n')
    const editorContent = '# Original guidance\n\nEditor added this concurrently.\n'

    await expect(addRuleToFile(file, 'rule-race', 'Use npm', {
      beforeAtomicRename: async target => { await fs.writeFile(target, editorContent) },
    })).rejects.toThrow(/changed while/i)

    expect(await fs.readFile(file, 'utf-8')).toBe(editorContent)
    expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('preserves an external editor save that races a removal before rename', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const managed = `# Guidance\n\n${buildRuleBlock('rule-race', 'Use npm')}\n`
    await fs.writeFile(file, managed)
    const editorContent = `${managed}\nEditor added this concurrently.\n`

    await expect(removeRuleFromFile(file, 'rule-race', {
      beforeAtomicRename: async target => { await fs.writeFile(target, editorContent) },
    })).rejects.toThrow(/changed while/i)

    expect(await fs.readFile(file, 'utf-8')).toBe(editorContent)
    expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses malformed or duplicated ownership markers', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, '<!-- cwc:rule:x -->\nmissing close\n')
    await expect(addRuleToFile(file, 'x', 'rule')).rejects.toThrow(/malformed/)
  })

  it.each([
    ['orphaned close', '<!-- /cwc:rule:other -->\n'],
    ['unclosed other block', '<!-- cwc:rule:other -->\ncontent\n'],
    ['mismatched ids', '<!-- cwc:rule:other -->\ncontent\n<!-- /cwc:rule:different -->\n'],
    ['nested blocks', '<!-- cwc:rule:other -->\n<!-- cwc:rule:nested -->\n<!-- /cwc:rule:nested -->\n<!-- /cwc:rule:other -->\n'],
    ['duplicate blocks', '<!-- cwc:rule:other -->\na\n<!-- /cwc:rule:other -->\n<!-- cwc:rule:other -->\nb\n<!-- /cwc:rule:other -->\n'],
  ])('refuses to rewrite a file containing %s for another rule', async (_label, content) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)

    await expect(addRuleToFile(file, 'target', 'new rule')).rejects.toThrow(/marker|nested/i)
    await expect(removeRuleFromFile(file, 'target')).rejects.toThrow(/marker|nested/i)
    expect(await fs.readFile(file, 'utf-8')).toBe(content)
  })

  it.skipIf(process.platform === 'win32')('does not follow a symbolic-link target', async () => {
    const real = path.join(dir, 'real.md')
    await fs.writeFile(real, 'user content\n')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.symlink(real, file)
    await expect(addRuleToFile(file, 'x', 'rule')).rejects.toThrow(/symbolic-link/)
    expect(await fs.readFile(real, 'utf-8')).toBe('user content\n')
  })

  it('normalizes transcript text and neutralizes marker injection', () => {
    expect(normalizeRuleSuggestion('  Please   keep this scoped  ')).toBe('Please keep this scoped.')
    expect(normalizeRuleSuggestion('Do x <!-- cwc:rule:evil -->')).not.toContain('<!-- cwc:')
  })
})
