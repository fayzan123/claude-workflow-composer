// tests/server/run-launcher.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRunStore, type RunStore } from '../../src/server/run-store.js'
import { fireWorkflow, classifyAndFinish, sweepOrphanWorktrees, runShellCommand } from '../../src/server/run-launcher.js'
import { createWorktree, getRepositoryIdentity, removeWorktree } from '../../src/server/run-isolation.js'
import { makeBin } from '../helpers/make-bin.js'
import { withExportTargetLease } from '../../src/export/target-lease.js'

let binDir: string, okBin: string, bindingReaderBin: string, dirtyBin: string, checkpointFailBin: string, gateBin: string, gateNoSessionBin: string
let runsDir: string, wtRoot: string, repo: string, store: RunStore

beforeAll(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-bin-'))
  okBin = await makeBin(binDir, 'claude', `const fs=require('fs');fs.readFileSync(0,'utf-8')
process.stdout.write(JSON.stringify({ type:'result', result:'done', session_id:'s-ok', total_cost_usd:0.01 }))
`)
  bindingReaderBin = await makeBin(binDir, 'claude-binding-reader', `const fs=require('fs');const path=require('path');fs.readFileSync(0,'utf-8')
const args=process.argv.slice(2);const pluginDir=args[args.indexOf('--plugin-dir')+1]
const skill=fs.readFileSync(path.join(pluginDir,'skills','cwc-x','SKILL.md'),'utf-8')
const referencePath=path.join(pluginDir,'agents','shared-reviewer.md')
const reference=fs.existsSync(referencePath)?fs.readFileSync(referencePath,'utf-8'):''
process.stdout.write(JSON.stringify({type:'result',result:skill+'\\n'+reference,session_id:'s-binding-reader'}))
`)
  dirtyBin = await makeBin(binDir, 'claude-dirty', `const fs=require('fs');fs.readFileSync(0,'utf-8')
fs.writeFileSync('f.txt', 'changed by run')
fs.writeFileSync('generated.txt', 'untracked run output')
process.stdout.write(JSON.stringify({ type:'result', result:'done', session_id:'s-dirty' }))
`)
  checkpointFailBin = await makeBin(binDir, 'claude-checkpoint-fail', `const fs=require('fs');const cp=require('child_process');fs.readFileSync(0,'utf-8')
fs.writeFileSync('f.txt', 'cannot checkpoint this yet')
const lock = cp.execFileSync('git', ['rev-parse', '--git-path', 'index.lock'], { encoding: 'utf-8' }).trim()
fs.writeFileSync(lock, 'held by test')
process.stdout.write(JSON.stringify({ type:'result', result:'done', session_id:'s-lock' }))
`)
  // Gate fixtures read CWC_TEST_CFG (a JSON file the test writes: { jsonl, runId, workflowId })
  // and append an awaiting_approval line to the run JSONL — standing in for the orchestrator's curl.
  gateBin = await makeBin(binDir, 'claude-gate', `const fs=require('fs')
fs.readFileSync(0,'utf-8')
const cfg = JSON.parse(fs.readFileSync(process.env.CWC_TEST_CFG, 'utf-8'))
fs.appendFileSync(cfg.jsonl, JSON.stringify({ runId: cfg.runId, workflowId: cfg.workflowId, workflowSlug: 'cwc-x', type: 'awaiting_approval', ts: new Date().toISOString(), message: 'plan ready' }) + '\\n')
process.stdout.write(JSON.stringify({ type:'result', result:'paused at gate', session_id:'s-gate' }))
`)
  gateNoSessionBin = await makeBin(binDir, 'claude-gate-nosess', `const fs=require('fs')
fs.readFileSync(0,'utf-8')
const cfg = JSON.parse(fs.readFileSync(process.env.CWC_TEST_CFG, 'utf-8'))
fs.appendFileSync(cfg.jsonl, JSON.stringify({ runId: cfg.runId, workflowId: cfg.workflowId, workflowSlug: 'cwc-x', type: 'awaiting_approval', ts: new Date().toISOString(), message: 'plan ready' }) + '\\n')
process.stdout.write(JSON.stringify({ type:'result', result:'paused' }))
`)
})
afterAll(async () => { await fs.rm(binDir, { recursive: true }) })

beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-runs-'))
  wtRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-wt-'))
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'cwc-launch-repo-'))
  execFileSync('git', ['-C', repo, 'init', '-b', 'main'])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'])
  await fs.writeFile(path.join(repo, 'f.txt'), 'x')
  execFileSync('git', ['-C', repo, 'add', '-A'])
  execFileSync('git', ['-C', repo, 'commit', '-m', 'init'])
  store = createRunStore(runsDir)
})
afterEach(async () => {
  for (const d of [runsDir, wtRoot, repo]) await fs.rm(d, { recursive: true, maxRetries: 5, retryDelay: 100 })
})

function baseOpts(over: Record<string, unknown> = {}) {
  return {
    workflowId: 'wf-1', workflowSlug: 'cwc-x', cwd: repo,
    isolation: 'worktree' as const, trigger: 'manual', store,
    binPath: okBin, worktreesRoot: wtRoot, ...over,
  }
}

async function lastEvents(runId: string) {
  return (await store.getEvents('wf-1', runId))!
}

async function waitForManifestState(runId: string, lifecycleState: string): Promise<void> {
  // Reaching a state can involve git worktree creation plus a cold node process
  // spawn for setup commands; Windows CI runners regularly need well over 5s.
  // Polling returns immediately on match, so a large budget costs nothing green.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if ((await store.manifests.read('wf-1', runId))?.lifecycleState === lifecycleState) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for ${runId} to enter ${lifecycleState}`)
}

describe('fireWorkflow', () => {
  it('does not launch a same-slug skill owned by a different artifact', async () => {
    const skillsDir = path.join(runsDir, 'skills')
    const skillDir = path.join(skillsDir, 'cwc-x')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# collision\n<!-- cwc:workflow:wf-foreign -->\n')

    const result = await fireWorkflow(baseOpts({ skillsDir, isolation: 'in-place' }))

    expect(result).toEqual({ fired: false, reason: 'skill not exported' })
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('accepts the exact CWC owner marker when validating an exported skill', async () => {
    const skillsDir = path.join(runsDir, 'skills')
    const skillDir = path.join(skillsDir, 'cwc-x')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# managed\n<!-- cwc:workflow:wf-1 -->\n')

    const result = await fireWorkflow(baseOpts({ skillsDir, isolation: 'in-place' }))

    if (result.fired !== true) return expect.fail(`expected launch, received ${result.reason}`)
    await result.settled
    expect((await lastEvents(result.runId)).at(-1)).toMatchObject({ type: 'run_completed', status: 'complete' })
  })

  it('fails closed when a foreign project agent shadows a workflow-owned user agent', async () => {
    const skillsDir = path.join(runsDir, '.claude', 'skills')
    const userAgentDir = path.join(runsDir, '.claude', 'agents')
    const projectAgentDir = path.join(repo, '.claude', 'agents')
    await fs.mkdir(path.join(skillsDir, 'cwc-x'), { recursive: true })
    await fs.mkdir(userAgentDir, { recursive: true })
    await fs.mkdir(projectAgentDir, { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, 'cwc-x', 'SKILL.md'),
      'Use `subagent_type: "writer"`.\n<!-- cwc:bespoke-agents:writer -->\n<!-- cwc:workflow:wf-1 -->\n',
    )
    await fs.writeFile(
      path.join(userAgentDir, 'writer.md'),
      '# Managed writer\n<!-- cwc:node:n1:workflow:wf-1 -->\n',
    )
    await fs.writeFile(path.join(projectAgentDir, 'writer.md'), '# Project-local hand-authored writer\n')

    const result = await fireWorkflow(baseOpts({ skillsDir, isolation: 'in-place' }))

    expect(result).toEqual({ fired: false, reason: 'agent deployment collision' })
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('snapshots an untracked project agent reference into an isolated run', async () => {
    const skillsDir = path.join(runsDir, '.claude', 'skills')
    const projectAgentDir = path.join(repo, '.claude', 'agents')
    await fs.mkdir(path.join(skillsDir, 'cwc-x'), { recursive: true })
    await fs.mkdir(projectAgentDir, { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, 'cwc-x', 'SKILL.md'),
      'Use `subagent_type: "shared-reviewer"`.\n<!-- cwc:bespoke-agents:- -->\n<!-- cwc:workflow:wf-1 -->\n',
    )
    await fs.writeFile(
      path.join(projectAgentDir, 'shared-reviewer.md'),
      '---\nname: shared-reviewer\ndescription: Shared project reviewer\n---\n\nORIGINAL_PROJECT_REFERENCE\n',
    )

    const result = await fireWorkflow(baseOpts({
      skillsDir,
      binPath: bindingReaderBin,
      runId: 'run-project-reference-binding',
    }))

    if (result.fired !== true) return expect.fail(`expected launch, received ${result.reason}`)
    await result.settled
    const completion = (await lastEvents(result.runId)).at(-1)
    expect(completion).toMatchObject({ type: 'run_completed', status: 'complete' })
    expect(completion?.message).toMatch(/subagent_type: "cwc-run-[a-f0-9]+:shared-reviewer"/)
    expect(completion?.message).toContain('ORIGINAL_PROJECT_REFERENCE')
  })

  it('fails closed when a referenced agent is no longer installed', async () => {
    const skillsDir = path.join(runsDir, '.claude', 'skills')
    await fs.mkdir(path.join(skillsDir, 'cwc-x'), { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, 'cwc-x', 'SKILL.md'),
      'Use `subagent_type: "shared-reviewer"`.\n<!-- cwc:bespoke-agents:- -->\n<!-- cwc:workflow:wf-1 -->\n',
    )

    const result = await fireWorkflow(baseOpts({ skillsDir, isolation: 'in-place' }))

    expect(result).toEqual({ fired: false, reason: 'agent reference unavailable' })
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('fails closed when a namespaced agent dispatch cannot be snapshotted', async () => {
    const skillsDir = path.join(runsDir, '.claude', 'skills')
    await fs.mkdir(path.join(skillsDir, 'cwc-x'), { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, 'cwc-x', 'SKILL.md'),
      'Use `subagent_type: "third-party:reviewer"`.\n<!-- cwc:bespoke-agents:- -->\n<!-- cwc:workflow:wf-1 -->\n',
    )

    const result = await fireWorkflow(baseOpts({ skillsDir, isolation: 'in-place' }))

    expect(result).toEqual({ fired: false, reason: 'agent reference unavailable' })
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it.each([
    { state: 'deleted', replacement: null },
    { state: 'replaced', replacement: '# Hand-authored replacement\n' },
  ])('refuses a declared bespoke user agent that was $state', async ({ replacement }) => {
    const skillsDir = path.join(runsDir, '.claude', 'skills')
    const userAgentDir = path.join(runsDir, '.claude', 'agents')
    await fs.mkdir(path.join(skillsDir, 'cwc-x'), { recursive: true })
    await fs.mkdir(userAgentDir, { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, 'cwc-x', 'SKILL.md'),
      'Use `subagent_type: "writer"`.\n<!-- cwc:bespoke-agents:writer -->\n<!-- cwc:workflow:wf-1 -->\n',
    )
    if (replacement !== null) await fs.writeFile(path.join(userAgentDir, 'writer.md'), replacement)

    const result = await fireWorkflow(baseOpts({ skillsDir, isolation: 'in-place' }))

    expect(result).toEqual({ fired: false, reason: 'agent not exported' })
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('requires a re-export for legacy workflow skills with agent dispatches', async () => {
    const skillsDir = path.join(runsDir, 'skills')
    await fs.mkdir(path.join(skillsDir, 'cwc-x'), { recursive: true })
    await fs.writeFile(
      path.join(skillsDir, 'cwc-x', 'SKILL.md'),
      'Use `subagent_type: "writer"`.\n<!-- cwc:workflow:wf-1 -->\n',
    )

    const result = await fireWorkflow(baseOpts({ skillsDir, isolation: 'in-place' }))

    expect(result).toEqual({ fired: false, reason: 'workflow must be re-exported' })
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('binds an untracked project export into an isolated worktree', async () => {
    const projectSkillDir = path.join(repo, '.claude', 'skills', 'cwc-x')
    await fs.mkdir(projectSkillDir, { recursive: true })
    // Deliberately untracked: the fresh worktree does not contain this file, so
    // the private plugin must carry the verified project deployment into the run.
    await fs.writeFile(path.join(projectSkillDir, 'SKILL.md'), '# managed\n<!-- cwc:workflow:wf-1 -->\n')
    const skillsDir = path.join(runsDir, 'user-skills')
    const userSkillDir = path.join(skillsDir, 'cwc-x')
    await fs.mkdir(userSkillDir, { recursive: true })
    await fs.writeFile(path.join(userSkillDir, 'SKILL.md'), '# collision\n<!-- cwc:workflow:wf-foreign -->\n')

    const result = await fireWorkflow(baseOpts({ skillsDir, binPath: bindingReaderBin, runId: 'run-runtime-owner-check' }))

    if (result.fired !== true) return expect.fail(`expected launch, received ${result.reason}`)
    await result.settled
    expect((await lastEvents(result.runId)).at(-1)?.message).toContain('# managed')
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('does not fall back from the selected project export to a stale owned user export', async () => {
    const projectSkillDir = path.join(repo, '.claude', 'skills', 'cwc-x')
    await fs.mkdir(projectSkillDir, { recursive: true })
    await fs.writeFile(path.join(projectSkillDir, 'SKILL.md'), '# current project deployment\n<!-- cwc:workflow:wf-1 -->\n')
    const skillsDir = path.join(runsDir, 'user-skills')
    const userSkillDir = path.join(skillsDir, 'cwc-x')
    await fs.mkdir(userSkillDir, { recursive: true })
    await fs.writeFile(path.join(userSkillDir, 'SKILL.md'), '# stale user deployment\n<!-- cwc:workflow:wf-1 -->\n')

    const result = await fireWorkflow(baseOpts({ skillsDir, binPath: bindingReaderBin, runId: 'run-no-scope-fallback' }))

    if (result.fired !== true) return expect.fail(`expected launch, received ${result.reason}`)
    await result.settled
    const completion = (await lastEvents(result.runId)).at(-1)
    expect(completion?.message).toContain('current project deployment')
    expect(completion?.message).not.toContain('stale user deployment')
  })

  it('binds the selected checkout revision instead of the worktree committed revision', async () => {
    const projectSkillDir = path.join(repo, '.claude', 'skills', 'cwc-x')
    const projectSkill = path.join(projectSkillDir, 'SKILL.md')
    await fs.mkdir(projectSkillDir, { recursive: true })
    await fs.writeFile(projectSkill, '# committed old deployment\n<!-- cwc:workflow:wf-1 -->\n')
    execFileSync('git', ['-C', repo, 'add', '.claude'])
    execFileSync('git', ['-C', repo, 'commit', '-m', 'add exported skill'])
    await fs.writeFile(projectSkill, '# current checkout deployment\n<!-- cwc:workflow:wf-1 -->\n')

    const result = await fireWorkflow(baseOpts({
      skillsDir: path.join(runsDir, 'user-skills'),
      binPath: bindingReaderBin,
      runId: 'run-content-mismatch',
    }))

    if (result.fired !== true) return expect.fail(`expected launch, received ${result.reason}`)
    await result.settled
    const completion = (await lastEvents(result.runId)).at(-1)
    expect(completion?.message).toContain('current checkout deployment')
    expect(completion?.message).not.toContain('committed old deployment')
  })

  it('rechecks exact skill content after a successful setup command', async () => {
    const skillsDir = path.join(runsDir, 'skills')
    const skillDir = path.join(skillsDir, 'cwc-x')
    const skillFile = path.join(skillDir, 'SKILL.md')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(skillFile, '# managed before setup\n<!-- cwc:workflow:wf-1 -->\n')
    const setupScript = path.join(runsDir, 'replace-skill.cjs')
    await fs.writeFile(
      setupScript,
      `require('fs').writeFileSync(${JSON.stringify(skillFile)}, '# changed by setup\\n<!-- cwc:workflow:wf-1 -->\\n')\n`,
    )

    const result = await fireWorkflow(baseOpts({
      skillsDir,
      isolation: 'in-place',
      setupCommand: `"${process.execPath}" "${setupScript}"`,
      runId: 'run-post-setup-skill-check',
    }))

    expect(result).toEqual({ fired: false, reason: 'skill not exported' })
    expect(await store.listRuns('wf-1')).toEqual([])
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('checkpoints isolated setup output when post-setup deployment verification rejects launch', async () => {
    const skillsDir = path.join(runsDir, 'skills')
    const skillFile = path.join(skillsDir, 'cwc-x', 'SKILL.md')
    await fs.mkdir(path.dirname(skillFile), { recursive: true })
    await fs.writeFile(skillFile, '# managed before setup\n<!-- cwc:workflow:wf-1 -->\n')
    const setupScript = path.join(runsDir, 'replace-skill-and-write-output.cjs')
    await fs.writeFile(
      setupScript,
      `const fs = require('fs')
fs.writeFileSync('setup-output.txt', 'recoverable post-setup output')
fs.writeFileSync(${JSON.stringify(skillFile)}, '# changed by setup\\n<!-- cwc:workflow:wf-1 -->\\n')
`,
    )

    const result = await fireWorkflow(baseOpts({
      skillsDir,
      setupCommand: `"${process.execPath}" "${setupScript}"`,
      runId: 'run-preserve-post-setup-rejection',
    }))

    expect(result).toEqual({ fired: false, reason: 'skill not exported' })
    const branch = 'cwc/cwc-x/run-preserve-post-setup-rejection'
    expect(execFileSync('git', ['-C', repo, 'show', `${branch}:setup-output.txt`], { encoding: 'utf-8' })).toBe('recoverable post-setup output')
    await expect(fs.access(path.join(wtRoot, 'run-preserve-post-setup-rejection'))).rejects.toThrow()
    expect(await store.manifests.read('wf-1', 'run-preserve-post-setup-rejection')).toMatchObject({
      lifecycleState: 'failed',
      completionStatus: 'error',
      disposition: 'ready',
    })
    expect((await store.listRuns('wf-1'))[0]).toMatchObject({
      status: 'error',
      actions: { apply: false, discard: true },
    })
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('checkpoints isolated setup output when final leased deployment verification rejects launch', async () => {
    const skillsDir = path.join(runsDir, 'skills')
    const skillFile = path.join(skillsDir, 'cwc-x', 'SKILL.md')
    await fs.mkdir(path.dirname(skillFile), { recursive: true })
    await fs.writeFile(skillFile, '# managed before final check\n<!-- cwc:workflow:wf-1 -->\n')
    const setupScript = path.join(runsDir, 'write-setup-output.cjs')
    await fs.writeFile(setupScript, "require('fs').writeFileSync('setup-output.txt', 'recoverable final-boundary output')\n")

    let releaseLease!: () => void
    let leaseEntered!: () => void
    const entered = new Promise<void>(resolve => { leaseEntered = resolve })
    const held = new Promise<void>(resolve => { releaseLease = resolve })
    const lease = withExportTargetLease([path.dirname(skillsDir), skillsDir], async () => {
      leaseEntered()
      await held
    })
    await entered

    const runId = 'run-preserve-final-rejection'
    const launch = fireWorkflow(baseOpts({
      skillsDir,
      setupCommand: `"${process.execPath}" "${setupScript}"`,
      runId,
    }))
    await waitForManifestState(runId, 'spawning')
    await fs.writeFile(skillFile, '# changed at final boundary\n<!-- cwc:workflow:wf-1 -->\n')
    releaseLease()
    await lease
    const result = await launch

    expect(result).toEqual({ fired: false, reason: 'skill not exported' })
    const branch = `cwc/cwc-x/${runId}`
    expect(execFileSync('git', ['-C', repo, 'show', `${branch}:setup-output.txt`], { encoding: 'utf-8' })).toBe('recoverable final-boundary output')
    await expect(fs.access(path.join(wtRoot, runId))).rejects.toThrow()
    expect(await store.manifests.read('wf-1', runId)).toMatchObject({
      lifecycleState: 'failed',
      completionStatus: 'error',
      disposition: 'ready',
    })
    expect((await store.listRuns('wf-1'))[0]).toMatchObject({
      status: 'error',
      actions: { apply: false, discard: true },
    })
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('holds the export target lease from final binding through process spawn', async () => {
    const skillsDir = path.join(runsDir, 'skills')
    const skillDir = path.join(skillsDir, 'cwc-x')
    const skillFile = path.join(skillDir, 'SKILL.md')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(skillFile, '# managed\n<!-- cwc:workflow:wf-1 -->\n')
    let releaseSpawn!: () => void
    let spawnBoundaryReached!: () => void
    const atSpawnBoundary = new Promise<void>(resolve => { spawnBoundaryReached = resolve })
    const allowSpawn = new Promise<void>(resolve => { releaseSpawn = resolve })

    const fire = fireWorkflow(baseOpts({
      skillsDir,
      isolation: 'in-place',
      runId: 'run-export-lease-binding',
      beforeSpawn: async () => {
        spawnBoundaryReached()
        await allowSpawn
      },
    }))
    await atSpawnBoundary

    let mutationEntered = false
    const mutation = withExportTargetLease([path.dirname(skillsDir), skillsDir], async () => {
      mutationEntered = true
      await fs.writeFile(skillFile, '# replacement\n<!-- cwc:workflow:wf-1 -->\n')
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(mutationEntered).toBe(false)

    releaseSpawn()
    const result = await fire
    if (result.fired !== true) return expect.fail(`expected launch, received ${result.reason}`)
    await mutation
    await result.settled
    expect(mutationEntered).toBe(true)
  })

  it('runs the private bound bytes after a post-spawn export changes the live skill and agent', async () => {
    const skillsDir = path.join(runsDir, '.claude', 'skills')
    const agentsDir = path.join(runsDir, '.claude', 'agents')
    const skillFile = path.join(skillsDir, 'cwc-x', 'SKILL.md')
    const agentFile = path.join(agentsDir, 'writer.md')
    const mutationDone = path.join(runsDir, 'mutation-done')
    await fs.mkdir(path.dirname(skillFile), { recursive: true })
    await fs.mkdir(agentsDir, { recursive: true })
    await fs.writeFile(skillFile, `---\nname: cwc-x\ndescription: Bound flow\n---\n\nORIGINAL_SKILL\nUse \`subagent_type: "writer"\`.\n<!-- cwc:bespoke-agents:writer -->\n<!-- cwc:workflow:wf-1 -->`)
    await fs.writeFile(agentFile, `---\nname: writer\ndescription: Writer\n---\n\nORIGINAL_AGENT\n<!-- cwc:node:n1:workflow:wf-1 -->`)
    const delayedReader = await makeBin(binDir, `claude-bound-${Date.now()}`, `const fs=require('fs');const path=require('path')
const args=process.argv.slice(2)
const pluginDir=args[args.indexOf('--plugin-dir') + 1]
fs.readFileSync(0,'utf-8')
const marker=${JSON.stringify(mutationDone)}
const finish=()=>{
  if(!fs.existsSync(marker)) return setTimeout(finish, 10)
  const skill=fs.readFileSync(path.join(pluginDir,'skills','cwc-x','SKILL.md'),'utf-8')
  const agent=fs.readFileSync(path.join(pluginDir,'agents','writer.md'),'utf-8')
  process.stdout.write(JSON.stringify({type:'result',result:skill+'\\n'+agent,session_id:'s-bound'}))
}
finish()
`)

    const result = await fireWorkflow(baseOpts({
      skillsDir,
      isolation: 'in-place',
      binPath: delayedReader,
      runId: 'run-private-byte-binding',
    }))
    if (result.fired !== true) return expect.fail(`expected launch, received ${result.reason}`)

    await withExportTargetLease([path.dirname(skillsDir), skillsDir], async () => {
      await fs.writeFile(skillFile, '# REPLACEMENT_SKILL\n<!-- cwc:workflow:wf-1 -->')
      await fs.writeFile(agentFile, '# REPLACEMENT_AGENT\n<!-- cwc:node:n1:workflow:wf-1 -->')
    })
    await fs.writeFile(mutationDone, 'done')
    await result.settled

    const completion = (await lastEvents(result.runId)).at(-1)
    expect(completion?.message).toContain('ORIGINAL_SKILL')
    expect(completion?.message).toContain('ORIGINAL_AGENT')
    expect(completion?.message).not.toContain('REPLACEMENT_SKILL')
    expect(completion?.message).not.toContain('REPLACEMENT_AGENT')
  })

  it('precondition non-zero → not fired, nothing recorded as a run', async () => {
    const r = await fireWorkflow(baseOpts({ precondition: 'exit 1' }))
    expect(r).toEqual({ fired: false, reason: 'precondition' })
    expect(await store.listRuns('wf-1')).toEqual([])
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('claims the workflow before asynchronous launch preparation begins', async () => {
    const precondition = path.join(runsDir, 'precondition.cjs')
    await fs.writeFile(precondition, 'setTimeout(() => process.exit(0), 100)\n')
    const firstPromise = fireWorkflow(baseOpts({
      runId: 'run-preparing',
      precondition: `"${process.execPath}" "${precondition}"`,
    }))

    const second = await fireWorkflow(baseOpts({ runId: 'run-overlap' }))
    expect(second).toEqual({ fired: false, reason: 'workflow already active' })
    expect(store.hasActiveTestRun('wf-1')).toBe(true)

    const first = await firstPromise
    if (first.fired !== true) return expect.fail('first run should fire')
    await first.settled
    expect(store.hasActiveTestRun('wf-1')).toBe(false)
  })

  it('tree-kills a timed-out shell command and its descendants', async () => {
    // Script FILES, not nested `node -e` strings: inline scripts would need double-nested
    // quote escaping that cmd.exe + msvcrt argv parsing mangle on the Windows CI leg.
    const heartbeat = path.join(runsDir, 'shell-heartbeat.txt')
    const childPath = path.join(runsDir, 'shell-child.cjs')
    const parentPath = path.join(runsDir, 'shell-parent.cjs')
    await fs.writeFile(childPath, `const fs = require('fs')
const write = () => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now()))
write()
setInterval(write, 50)
`)
    await fs.writeFile(parentPath, `const { spawn } = require('child_process')
spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(childPath)}], { stdio: 'ignore' })
setInterval(() => {}, 1000)
`)
    // Generous timeout: slow CI runners can take >500ms just to spawn the node chain.
    const result = await runShellCommand(`"${process.execPath}" "${parentPath}"`, repo, 3000)

    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/timed out/)
    // Let the kill finish (250ms SIGKILL escalation / async taskkill), then assert the
    // grandchild's heartbeat has gone quiet.
    await new Promise(res => setTimeout(res, 600))
    const before = await fs.readFile(heartbeat, 'utf-8')
    await new Promise(res => setTimeout(res, 300))
    const after = await fs.readFile(heartbeat, 'utf-8')
    expect(after).toBe(before)
  })

  it('isolated happy path: worktree, baseSha on run_started, completion keeps branch, removes worktree', async () => {
    const r = await fireWorkflow(baseOpts())
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled
    const events = await lastEvents(r.runId)
    expect(events[0]).toMatchObject({ type: 'run_started', trigger: 'manual' })
    expect(events[0].branch).toBe(`cwc/cwc-x/${r.runId}`)
    expect(events[0].baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(events[events.length - 1]).toMatchObject({ type: 'run_completed', status: 'complete', sessionId: 's-ok' })
    // worktree gone, branch kept
    await expect(fs.access(path.join(wtRoot, r.runId))).rejects.toThrow()
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `cwc/cwc-x/${r.runId}`], { encoding: 'utf-8' })
    expect(branches).toContain(r.runId)
    const manifest = await store.manifests.read('wf-1', r.runId)
    expect(manifest).toMatchObject({
      lifecycleState: 'completed',
      completionStatus: 'complete',
      disposition: 'ready',
      branch: `cwc/cwc-x/${r.runId}`,
    })
    expect(manifest?.resultSha).toBe(execFileSync('git', ['-C', repo, 'rev-parse', `cwc/cwc-x/${r.runId}`], { encoding: 'utf-8' }).trim())
  })

  it('snapshots uncommitted work onto the kept branch before removing an isolated worktree', async () => {
    const r = await fireWorkflow(baseOpts({ binPath: dirtyBin }))
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled

    const branch = `cwc/cwc-x/${r.runId}`
    await expect(fs.access(path.join(wtRoot, r.runId))).rejects.toThrow()
    expect(execFileSync('git', ['-C', repo, 'show', `${branch}:f.txt`], { encoding: 'utf-8' })).toBe('changed by run')
    expect(execFileSync('git', ['-C', repo, 'show', `${branch}:generated.txt`], { encoding: 'utf-8' })).toBe('untracked run output')
    expect(execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s', branch], { encoding: 'utf-8' }).trim()).toContain(r.runId)
    expect((await store.manifests.read('wf-1', r.runId))?.disposition).toBe('ready')
  })

  it('retains a checkpoint-failed worktree and exposes no Apply or Discard authority', async () => {
    const r = await fireWorkflow(baseOpts({ binPath: checkpointFailBin }))
    if (r.fired !== true) return expect.fail('should fire')
    await r.settled

    const manifest = await store.manifests.read('wf-1', r.runId)
    expect(manifest).toMatchObject({ lifecycleState: 'failed', completionStatus: 'error', disposition: 'unavailable' })
    expect(manifest?.resultSha).toBeUndefined()
    await expect(fs.readFile(path.join(wtRoot, r.runId, 'f.txt'), 'utf-8')).resolves.toBe('cannot checkpoint this yet')
    const [summary] = await store.listRuns('wf-1')
    expect(summary).toMatchObject({ status: 'error', actions: { apply: false, discard: false } })
  })

  it('setupCommand failure → run exists with status error; worktree and branch removed', async () => {
    const r = await fireWorkflow(baseOpts({ setupCommand: 'exit 7' }))
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled
    const [run] = await store.listRuns('wf-1')
    expect(run.status).toBe('error')
    const branches = execFileSync('git', ['-C', repo, 'branch', '--list', `cwc/cwc-x/${r.runId}`], { encoding: 'utf-8' }).trim()
    expect(branches).toBe('')
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'failed', disposition: 'unavailable' })
  })

  it('checkpoints setup changes before cleaning up a failed isolated run', async () => {
    const setupScript = path.join(runsDir, 'setup-fail.cjs')
    await fs.writeFile(setupScript, "require('fs').writeFileSync('setup-output.txt', 'recoverable setup work')\nprocess.exit(7)\n")
    const r = await fireWorkflow(baseOpts({ setupCommand: `"${process.execPath}" "${setupScript}"` }))
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled

    const branch = `cwc/cwc-x/${r.runId}`
    expect(execFileSync('git', ['-C', repo, 'show', `${branch}:setup-output.txt`], { encoding: 'utf-8' })).toBe('recoverable setup work')
    await expect(fs.access(path.join(wtRoot, r.runId))).rejects.toThrow()
    expect((await store.listRuns('wf-1'))[0].status).toBe('error')
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'failed', disposition: 'ready' })
    expect((await store.listRuns('wf-1'))[0]).toMatchObject({ actions: { apply: false, discard: true } })
  })

  it('gate exit with session → run_paused with sessionId + worktree KEPT', async () => {
    const runId = 'run-fixed-1'
    const cfgPath = path.join(runsDir, 'cwc-test-cfg.json')
    await fs.mkdir(path.join(runsDir, 'wf-1'), { recursive: true })
    await fs.writeFile(cfgPath, JSON.stringify({ jsonl: path.join(runsDir, 'wf-1', `${runId}.jsonl`), runId, workflowId: 'wf-1' }))
    const r = await fireWorkflow(baseOpts({ binPath: gateBin, runId, env: { CWC_TEST_CFG: cfgPath } }))
    expect(r.fired).toBe(true)
    if (r.fired !== true) return
    await r.settled
    const events = await lastEvents(r.runId)
    const last = events[events.length - 1]
    expect(last).toMatchObject({ type: 'run_paused', sessionId: 's-gate' })
    expect(last.worktreePath).toBe(path.join(wtRoot, r.runId))
    await expect(fs.access(path.join(wtRoot, r.runId))).resolves.toBeUndefined()
    const [run] = await store.listRuns('wf-1')
    expect(run.status).toBe('paused')
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'paused', sessionId: 's-gate', disposition: 'unavailable' })
  })

  it('gate exit WITHOUT session → no run_paused emitted, summary still paused', async () => {
    const runId = 'run-fixed-2'
    const cfgPath = path.join(runsDir, 'cwc-test-cfg2.json')
    await fs.mkdir(path.join(runsDir, 'wf-1'), { recursive: true })
    await fs.writeFile(cfgPath, JSON.stringify({ jsonl: path.join(runsDir, 'wf-1', `${runId}.jsonl`), runId, workflowId: 'wf-1' }))
    const r = await fireWorkflow(baseOpts({ binPath: gateNoSessionBin, runId, env: { CWC_TEST_CFG: cfgPath } }))
    if (r.fired !== true) return expect.fail('should fire')
    await r.settled
    const events = await lastEvents(r.runId)
    expect(events[events.length - 1].type).toBe('awaiting_approval')
    const [run] = await store.listRuns('wf-1')
    expect(run.status).toBe('paused')
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'paused', disposition: 'unavailable' })
  })

  it('in-place run in a git repo records baseSha but no worktreePath', async () => {
    const r = await fireWorkflow(baseOpts({ isolation: 'in-place' }))
    if (r.fired !== true) return expect.fail('should fire')
    await r.settled
    const events = await lastEvents(r.runId)
    expect(events[0].baseSha).toMatch(/^[0-9a-f]{40}$/)
    expect(events[0].worktreePath).toBeUndefined()
    expect(await store.manifests.read('wf-1', r.runId)).toMatchObject({ lifecycleState: 'completed', requestedIsolation: 'in-place', disposition: 'unavailable' })
  })
})

describe('sweepOrphanWorktrees', () => {
  it('uses manifests to clean verified terminal worktrees and retains paused, legacy, or unverifiable directories', async () => {
    const repositoryIdentity = await getRepositoryIdentity(repo)
    const baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()

    // A paused manifest keeps its worktree without consulting observational events.
    const pausedRunId = 'run-paused-sweep'
    const pausedWtPath = path.join(wtRoot, pausedRunId)
    await fs.mkdir(pausedWtPath, { recursive: true })
    await store.manifests.create({
      runId: pausedRunId, workflowId: 'wf-1', workflowSkillSlug: 'cwc-x', triggerId: 'manual',
      requestedIsolation: 'worktree', originalCwd: repo, requestedBaseRef: 'HEAD',
    })
    await store.manifests.transition('wf-1', pausedRunId, manifest => ({
      ...manifest, lifecycleState: 'paused', repositoryIdentity, baseSha,
      worktreePath: pausedWtPath, branch: `cwc/cwc-x/${pausedRunId}`,
    }))

    // A checkpointing manifest is restart-recoverable and becomes ready.
    const doneRunId = 'run-done-sweep'
    const doneWorktree = await createWorktree(repo, 'cwc-x', doneRunId, 'HEAD', wtRoot)
    const doneWtPath = doneWorktree.worktreePath
    await fs.writeFile(path.join(doneWtPath, 'recovered.txt'), 'restart-safe')
    await store.manifests.create({
      runId: doneRunId, workflowId: 'wf-1', workflowSkillSlug: 'cwc-x', triggerId: 'manual',
      requestedIsolation: 'worktree', originalCwd: repo, requestedBaseRef: 'HEAD',
    })
    await store.manifests.transition('wf-1', doneRunId, manifest => ({
      ...manifest, lifecycleState: 'checkpointing', completionStatus: 'complete', repositoryIdentity,
      baseSha: doneWorktree.baseSha, worktreePath: doneWtPath, branch: doneWorktree.branch,
    }))

    // A valid but event-only legacy worktree receives no cleanup authority.
    const legacyRunId = 'run-legacy-sweep'
    const legacyWorktree = await createWorktree(repo, 'legacy', legacyRunId, 'HEAD', wtRoot)
    await fs.mkdir(path.join(runsDir, 'wf-1'), { recursive: true })
    await fs.writeFile(path.join(runsDir, 'wf-1', `${legacyRunId}.jsonl`), JSON.stringify({
      runId: legacyRunId, workflowId: 'wf-1', workflowSlug: 'legacy', type: 'run_completed',
      status: 'complete', source: 'test', ts: new Date().toISOString(),
    }) + '\n')

    // Unknown/damaged Git linkage is retained for manual recovery, even when no run
    // claims it as live.
    const damagedWtPath = path.join(wtRoot, 'run-damaged-sweep')
    await fs.mkdir(damagedWtPath, { recursive: true })
    await fs.writeFile(path.join(damagedWtPath, 'recover-me.txt'), 'work')

    await sweepOrphanWorktrees(store, runsDir, wtRoot)

    // paused run's worktree must survive
    await expect(fs.access(pausedWtPath)).resolves.toBeUndefined()
    // completed run's worktree must be removed
    await expect(fs.access(doneWtPath)).rejects.toThrow()
    const doneManifest = await store.manifests.read('wf-1', doneRunId)
    expect(doneManifest).toMatchObject({ lifecycleState: 'completed', disposition: 'ready' })
    expect(execFileSync('git', ['-C', repo, 'show', `${doneManifest?.branch}:recovered.txt`], { encoding: 'utf-8' })).toBe('restart-safe')
    // legacy event metadata cannot authorize cleanup
    await expect(fs.access(legacyWorktree.worktreePath)).resolves.toBeUndefined()
    await expect(fs.readFile(path.join(damagedWtPath, 'recover-me.txt'), 'utf-8')).resolves.toBe('work')
  })

  it('finishes cleaning or rejection after a restart removed the worktree but not the result branch', async () => {
    const repositoryIdentity = await getRepositoryIdentity(repo)

    const cleaningRunId = 'run-cleaning-restart'
    const cleaning = await createWorktree(repo, 'cwc-x', cleaningRunId, 'HEAD', wtRoot)
    await fs.writeFile(path.join(cleaning.worktreePath, 'cleaning.txt'), 'preserved')
    execFileSync('git', ['-C', cleaning.worktreePath, 'add', '-A'])
    execFileSync('git', ['-C', cleaning.worktreePath, 'commit', '-m', 'cleaning result'])
    const cleaningSha = execFileSync('git', ['-C', cleaning.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
    await store.manifests.create({
      runId: cleaningRunId, workflowId: 'wf-1', workflowSkillSlug: 'cwc-x', triggerId: 'manual',
      requestedIsolation: 'worktree', originalCwd: repo, requestedBaseRef: 'HEAD',
    })
    await store.manifests.transition('wf-1', cleaningRunId, manifest => ({
      ...manifest, lifecycleState: 'cleaning', completionStatus: 'complete', repositoryIdentity,
      baseSha: cleaning.baseSha, worktreePath: cleaning.worktreePath, branch: cleaning.branch, resultSha: cleaningSha,
    }))
    await removeWorktree(repo, cleaning.worktreePath, cleaning.branch, { keepBranch: true })

    const rejectingRunId = 'run-rejecting-restart'
    const rejecting = await createWorktree(repo, 'cwc-x', rejectingRunId, 'HEAD', wtRoot)
    await fs.writeFile(path.join(rejecting.worktreePath, 'rejected.txt'), 'discard me')
    execFileSync('git', ['-C', rejecting.worktreePath, 'add', '-A'])
    execFileSync('git', ['-C', rejecting.worktreePath, 'commit', '-m', 'rejected result'])
    const rejectingSha = execFileSync('git', ['-C', rejecting.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()
    await store.manifests.create({
      runId: rejectingRunId, workflowId: 'wf-1', workflowSkillSlug: 'cwc-x', triggerId: 'manual',
      requestedIsolation: 'worktree', originalCwd: repo, requestedBaseRef: 'HEAD',
    })
    await store.manifests.transition('wf-1', rejectingRunId, manifest => ({
      ...manifest, lifecycleState: 'rejecting', repositoryIdentity,
      baseSha: rejecting.baseSha, worktreePath: rejecting.worktreePath, branch: rejecting.branch, resultSha: rejectingSha,
    }))
    await removeWorktree(repo, rejecting.worktreePath, rejecting.branch, { keepBranch: true })

    const restartedStore = createRunStore(runsDir)
    await sweepOrphanWorktrees(restartedStore, runsDir, wtRoot)

    expect(await restartedStore.manifests.read('wf-1', cleaningRunId)).toMatchObject({ lifecycleState: 'completed', disposition: 'ready', resultSha: cleaningSha })
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', cleaning.branch], { encoding: 'utf-8' })).toContain(cleaning.branch)
    expect(await restartedStore.manifests.read('wf-1', rejectingRunId)).toMatchObject({ lifecycleState: 'rejected', disposition: 'discarded', resultSha: rejectingSha })
    expect(execFileSync('git', ['-C', repo, 'branch', '--list', rejecting.branch], { encoding: 'utf-8' }).trim()).toBe('')
  })
})
