// tests/helpers/gate-bin.ts
// Shared helper for creating gate-fixture fake claude binaries.
// The gate bin reads CWC_TEST_CFG (JSON: { jsonl, runId, workflowId }) and
// appends an awaiting_approval event to the run JSONL before exiting.
//
// Options:
//   withSession: if true (default), emits session_id:'s-gate' in the result.
//   commitChange: if true, writes+commits a file in cwd before pausing (for diff tests).
import { makeBin } from './make-bin.js'

export interface MakeGateBinOptions {
  withSession?: boolean    // default true
  commitChange?: boolean   // default false — writes+commits a file in cwd before pausing
}

export async function makeGateBin(dir: string, name: string, options: MakeGateBinOptions = {}): Promise<string> {
  const { withSession = true, commitChange = false } = options

  const commitBlock = commitChange ? `
const { execFileSync } = require('child_process')
const fs2 = require('fs')
const path = require('path')
const changeFile = path.join(process.cwd(), 'gate-change.txt')
fs2.writeFileSync(changeFile, 'changed by gate\\n')
execFileSync('git', ['-C', process.cwd(), 'add', '-A'])
execFileSync('git', ['-C', process.cwd(), 'commit', '-m', 'gate change'])
` : ''

  const resultObj = withSession
    ? `{ type:'result', result:'paused at gate', session_id:'s-gate' }`
    : `{ type:'result', result:'paused' }`

  const source = `const fs=require('fs')
fs.readFileSync(0,'utf-8')
const cfg = JSON.parse(fs.readFileSync(process.env.CWC_TEST_CFG, 'utf-8'))
${commitBlock}
fs.appendFileSync(cfg.jsonl, JSON.stringify({ runId: cfg.runId, workflowId: cfg.workflowId, workflowSlug: 'cwc-x', type: 'awaiting_approval', ts: new Date().toISOString(), message: 'plan ready' }) + '\\n')
process.stdout.write(JSON.stringify(${resultObj}))
`
  return makeBin(dir, name, source)
}
