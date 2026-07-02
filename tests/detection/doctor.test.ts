import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { runDoctor } from '../../src/detection/doctor.js'
import type { ScanDiagnostics } from '../../src/detection/scan-diagnostics.js'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-doctor-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const okProbe = async () => ({ version: 'test-claude 9.9.9' })
const line = (o: unknown) => JSON.stringify(o) + '\n'

async function seedTranscript(home: string): Promise<void> {
  const proj = path.join(home, '.claude', 'projects', 'proj-a')
  await fs.mkdir(proj, { recursive: true })
  await fs.writeFile(path.join(proj, 's.jsonl'),
    line({ type: 'user', sessionId: 'S1', cwd: '/repo', timestamp: '2026-06-14T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'SECRET-PROMPT-TEXT-XYZ please' }] } })
    + line({ type: 'assistant', sessionId: 'S1', cwd: '/repo', timestamp: '2026-06-14T10:01:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /tmp/SECRET-CMD' } }] } })
    + '{broken json\n')
}

describe('runDoctor', () => {
  it('reports ok on a healthy home and writes a parseable bundle', async () => {
    await seedTranscript(dir)
    const lines: string[] = []
    const bundlePath = path.join(dir, 'bundle.json')
    const { ok, bundle } = await runDoctor({ homeDir: dir, cwcVersion: '0.0.0-test', out: l => lines.push(l), claudeProbe: okProbe, bundlePath })
    expect(ok).toBe(true)
    expect(bundle.discovery.transcriptFiles).toBe(1)
    expect(bundle.totals.units).toBe(1)
    expect(bundle.totals.jsonErrors).toBe(1)
    const joined = lines.join('\n')
    expect(joined).toMatch(/1 transcript file/)
    expect(joined).toMatch(/1 task unit/)
    expect(joined).toMatch(/OK/i)
    const written = JSON.parse(await fs.readFile(bundlePath, 'utf-8')) as ScanDiagnostics
    expect(written.totals.units).toBe(1)
    expect(written.env.claude.version).toBe('test-claude 9.9.9')
  })

  it('reports not-ok with a missing projects root and still writes the bundle', async () => {
    const lines: string[] = []
    const bundlePath = path.join(dir, 'bundle.json')
    const { ok, bundle } = await runDoctor({ homeDir: dir, cwcVersion: '0.0.0-test', out: l => lines.push(l), claudeProbe: okProbe, bundlePath })
    expect(ok).toBe(false)
    expect(bundle.discovery.rootExists).toBe(false)
    expect(lines.join('\n')).toMatch(/projects root/i)
    expect(JSON.parse(await fs.readFile(bundlePath, 'utf-8'))).toBeTruthy()
  })

  it('reports not-ok when the claude binary probe fails', async () => {
    await seedTranscript(dir)
    const { ok, bundle } = await runDoctor({ homeDir: dir, cwcVersion: '0.0.0-test', out: () => {}, claudeProbe: async () => { throw new Error('spawn claude ENOENT') } })
    expect(ok).toBe(false)
    expect(bundle.env.claude.found).toBe(false)
  })

  it('never leaks prompt text, commands, or raw paths into the bundle or summary', async () => {
    await seedTranscript(dir)
    const lines: string[] = []
    const bundlePath = path.join(dir, 'bundle.json')
    const { bundle } = await runDoctor({ homeDir: dir, cwcVersion: '0.0.0-test', out: l => lines.push(l), claudeProbe: okProbe, bundlePath })
    const everything = JSON.stringify(bundle) + '\n' + (await fs.readFile(bundlePath, 'utf-8')) + '\n' + lines.join('\n')
    expect(everything).not.toContain('SECRET-PROMPT-TEXT-XYZ')
    expect(everything).not.toContain('SECRET-CMD')
    expect(JSON.stringify(bundle)).not.toContain(dir)
  })
})
