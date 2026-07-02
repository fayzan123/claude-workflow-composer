# Detect Diagnostics (Phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** Phase 0 of `docs/2026-07-02-agent-agnostic-platform-design.md`.

**Goal:** Any Detect failure on any machine becomes diagnosable from a single **redacted diagnostic bundle** the user produces with one command (`npx claude-cwc doctor --bundle`) — no live debugging session required. Every silent swallow in the detection path becomes a counted, reported statistic.

**Why now:** The open cross-machine bug (Detect errored on a friend's machine; logs too thin to diagnose) is currently un-debuggable: `runScan` records only `err.message` with no stage, `parseSession` silently returns `[]` on read errors and silently skips malformed lines, and `findTranscripts` silently returns `[]` on any directory problem. A machine where Detect "finds nothing" and a machine where the transcript format drifted look identical.

**Architecture:** A new core module `src/detection/scan-diagnostics.ts` defines the diagnostics data model (env snapshot, discovery stats, per-file parse stats, stage-tagged failure) and the redaction rules. `transcript-parser.ts` gains detailed variants (`parseSessionDetailed`, `discoverTranscripts`) that stream line-by-line and count everything; the existing exports become thin wrappers so current callers and tests are untouched. The scan route tags each pipeline stage and persists a `ScanDiagnostics` record onto the scan result (new `GET /api/automation-scan/diagnostics`). A new `cwc doctor` subcommand runs discovery + parsing + environment probes **without invoking Claude** (zero tokens) and writes the bundle.

**Tech Stack:** TypeScript (ESM, `node:` built-ins only — `readline`/`fs`/`os`/`child_process`), Vitest with real temp filesystems (`fs.mkdtemp`), injected fakes for the `claude --version` probe. No new production dependencies.

## Global Constraints

- **Privacy is the contract.** The bundle must be safe to paste in a public GitHub issue. It contains: counts, byte/line totals, JSON `type` values, versions, platform info, and error messages with the home directory replaced by `~`. It must **never** contain: `promptText`, Bash command strings, any transcript message content, or un-redacted absolute paths. Enforce by construction — the stats types have no fields that could carry content — and by test (Task 6 asserts fixture prompt text does not appear anywhere in the serialized bundle).
- Behavior of existing exports (`parseSession`, `findTranscripts`) is unchanged; existing tests in `tests/detection/transcript-parser.test.ts` must pass unmodified.
- No auth, CORS, or loopback-binding changes. The new GET route sits behind the existing token gate like its siblings.
- Real temp dirs, never mocks, for all filesystem behavior. CI is Ubuntu + Windows / Node 20 + 22: no `chmod`-based unreadable-dir tests (use a regular file where a directory is expected to provoke portable `readdir` failures); use `path.join` everywhere.
- ESM: relative imports of compiled output use the `.js` extension.
- Run focused tests with `npx vitest run tests/detection/scan-diagnostics.test.ts` etc.; typecheck with `npm run typecheck`.
- Subagents: Sonnet or above, never Haiku.

## File Structure

- **Create** `src/detection/scan-diagnostics.ts` — diagnostics types, `redact()`, `envSnapshot()`, `emptyTotals()`/`accumulate()` helpers.
- **Create** `src/detection/doctor.ts` — `runDoctor()`: discovery + parse + env probe, summary lines, bundle assembly. Pure logic, all effects injected.
- **Modify** `src/detection/transcript-parser.ts` — add `parseSessionDetailed`, `discoverTranscripts`; re-implement old exports as wrappers; switch to streaming reads.
- **Modify** `src/server/scan-store.ts` — `ScanResult.diagnostics?`, `ScanStore.setDiagnostics()`.
- **Modify** `src/server/api/automation-scan.ts` — stage tagging in the scan job, diagnostics persistence, `GET /diagnostics`.
- **Modify** `bin/cwc.ts` — `doctor` subcommand (thin caller, launcher pattern).
- **Modify** `README.md` — Troubleshooting: "Detect fails or finds nothing".
- **Create** `tests/detection/scan-diagnostics.test.ts`, `tests/detection/doctor.test.ts`; **extend** `tests/detection/transcript-parser.test.ts`, `tests/server/automation-scan.test.ts` (or the existing server scan test file — check `tests/server/` naming before creating).

---

## Task 1: Diagnostics model + redaction (`scan-diagnostics.ts`)

**Files:**
- Create: `src/detection/scan-diagnostics.ts`
- Test: `tests/detection/scan-diagnostics.test.ts`

**Interfaces produced:**

```ts
export interface FileParseStats {
  file: string                            // ALWAYS redacted (~-relative)
  bytes: number
  lines: number                           // non-blank lines
  units: number                           // task units produced
  jsonErrors: number                      // lines that failed JSON.parse
  typeCounts: Record<string, number>      // top-level `type` values seen (all of them)
  readError?: string                      // redacted message; file contributed nothing
}

export interface DiscoveryStats {
  root: string                            // redacted, e.g. "~/.claude/projects"
  rootExists: boolean
  projectDirs: number
  unreadableDirs: number
  transcriptFiles: number
}

export interface EnvSnapshot {
  platform: NodeJS.Platform
  arch: string
  nodeVersion: string
  cwcVersion: string
  claude: { found: boolean; version?: string; error?: string }
}

export type ScanStage = 'discovery' | 'parse' | 'digest' | 'analysis' | 'parse-response'

export interface ScanDiagnostics {
  generatedAt: string
  env: EnvSnapshot
  discovery: DiscoveryStats
  files: FileParseStats[]
  totals: { files: number; filesWithReadErrors: number; units: number; jsonErrors: number; typeCounts: Record<string, number> }
  failure?: { stage: ScanStage; message: string }   // redacted message
}

export function redact(text: string, homeDir: string): string          // homeDir → "~" (all occurrences, both separators on win32)
export function envSnapshot(cwcVersion: string, probe?: ClaudeProbe): Promise<EnvSnapshot>
export type ClaudeProbe = () => Promise<{ version: string }>           // default: execFile('claude', ['--version'])
export function totalsOf(files: FileParseStats[]): ScanDiagnostics['totals']
```

- [ ] **Step 1: Write the failing test.** Cover: `redact` replaces every occurrence of the home dir (test with a homeDir containing regex-special chars, and on the win32 branch assert both `\` and `/` spellings are replaced — construct both variants explicitly rather than relying on the host OS); `totalsOf` sums units/jsonErrors and merges `typeCounts`; `envSnapshot` with an injected probe that resolves → `found: true, version`; with a probe that rejects (`ENOENT`) → `found: false, error` containing no absolute home path.
- [ ] **Step 2: Implement.** `redact` via split/join (no regex escaping pitfalls). Default probe uses `node:child_process` `execFile('claude', ['--version'], { timeout: 5000 })`; treat any failure as `found: false` — never throw.
- [ ] **Step 3: Verify** `npx vitest run tests/detection/scan-diagnostics.test.ts` green; `npm run typecheck`.

## Task 2: Detailed, streaming session parsing

**Files:**
- Modify: `src/detection/transcript-parser.ts`
- Test: extend `tests/detection/transcript-parser.test.ts`

**Interfaces produced:**

```ts
export async function parseSessionDetailed(filePath: string, homeDir?: string): Promise<{ units: TaskUnit[]; stats: FileParseStats }>
// parseSession(filePath) becomes: (await parseSessionDetailed(filePath)).units  — identical output
```

- [ ] **Step 1: Write the failing tests** (temp-dir fixtures, house style):
  - Well-formed 2-prompt session → 2 units (existing behavior), stats: `units: 2`, `jsonErrors: 0`, `typeCounts` includes `{ user: …, assistant: … }`.
  - File containing malformed JSON lines interleaved with valid ones → valid units still produced; `jsonErrors` equals the malformed count (today they vanish silently).
  - Lines with unrecognized `type` values (e.g. `summary`, `file-history-snapshot`, a hypothetical `x-future-type`) → skipped as today, but each counted in `typeCounts`.
  - Nonexistent file → `units: []`, `stats.readError` set, no throw; `stats.file` is `~`-relative when `homeDir` is passed and the path is under it.
  - Large-file sanity: generate a temp `.jsonl` of ~50k lines and assert it parses without error (guards the streaming rewrite; loose assertion, no timing).
  - Existing `parseSession` tests: **unchanged and green** — the regression guard.
- [ ] **Step 2: Implement.** Rewrite the read loop over `node:readline` + `fs.createReadStream` (`crlfDelay: Infinity`) instead of whole-file `readFile` — removes the large-transcript OOM/latency vector. Count `bytes` from `fs.stat`. Keep the unit-building logic byte-for-byte equivalent; only the iteration source and counting change. `parseSession` and `findTranscripts` remain exported with identical signatures/behavior.
- [ ] **Step 3: Verify** the full detection suite: `npx vitest run tests/detection/`.

## Task 3: Discovery with statistics

**Files:**
- Modify: `src/detection/transcript-parser.ts`
- Test: extend `tests/detection/transcript-parser.test.ts`

**Interfaces produced:**

```ts
export async function discoverTranscripts(homeDir?: string): Promise<{ files: string[]; stats: DiscoveryStats }>
// findTranscripts(homeDir) becomes: (await discoverTranscripts(homeDir)).files
```

- [ ] **Step 1: Write the failing tests:**
  - Temp home with `.claude/projects/<a>/x.jsonl`, `<a>/y.txt`, `<b>/z.jsonl` → `files` has the two `.jsonl` paths; stats `{ rootExists: true, projectDirs: 2, unreadableDirs: 0, transcriptFiles: 2 }`.
  - Temp home with no `.claude/projects` → `files: []`, `rootExists: false` (today this is indistinguishable from "no history").
  - A **regular file** placed directly in `projects/` alongside real project dirs → its `readdir` fails; counted in `unreadableDirs`, real dirs still scanned (portable across OSes — no chmod).
- [ ] **Step 2: Implement** with the same silent-catch structure as today, except every catch increments a counter instead of discarding the information. `stats.root` is redacted with the provided `homeDir`.
- [ ] **Step 3: Verify** `npx vitest run tests/detection/transcript-parser.test.ts`.

## Task 4: Persist diagnostics in the scan store

**Files:**
- Modify: `src/server/scan-store.ts`
- Test: extend the existing scan-store/automation-scan test file under `tests/server/` (locate it first with `rg -l scan-store tests/server/`)

**Interfaces produced:** `ScanResult.diagnostics?: ScanDiagnostics`; `ScanStore.setDiagnostics(d: ScanDiagnostics): Promise<void>`.

- [ ] **Step 1: Write the failing test:** create a store on a temp file, run a scan whose job calls `setDiagnostics(...)` then returns `[]` → `getLatest()!.diagnostics` matches; re-create the store from the same file → diagnostics survived persistence. Also: job that calls `setDiagnostics` then **throws** → status `error` AND diagnostics still present on the persisted record (the failure case is the whole point).
- [ ] **Step 2: Implement.** `setDiagnostics` assigns onto `latest` (no-op if `latest` is null) and `await persist()`. One subtlety: `runScan`'s catch block rebuilds `latest` — carry `diagnostics: latest?.diagnostics` through both the success and error reconstruction literals (lines ~130–132), mirroring how `log` is carried.
- [ ] **Step 3: Verify** the store test file plus `npx vitest run tests/server/`.

## Task 5: Stage-tagged scan route + `GET /diagnostics`

**Files:**
- Modify: `src/server/api/automation-scan.ts`
- Test: extend the automation-scan router tests (via `createApp()` with temp paths and injected `streamingRunner`, per house convention)

- [ ] **Step 1: Write the failing tests:**
  - **Success path:** temp home seeded with one small valid transcript; injected `streamingRunner` returns a fixed automations payload. POST `/api/automation-scan`, await completion, GET `/api/automation-scan/diagnostics` → 200 with `env`, `discovery.transcriptFiles: 1`, `totals.units > 0`, no `failure`.
  - **Failure path:** injected `streamingRunner` that throws `new Error('boom /Users/tester/.claude secret')` with the temp home as homeDir → scan status `error`; diagnostics has `failure.stage: 'analysis'` and a `failure.message` containing `boom` but **not** the raw home path (redaction applied).
  - GET `/diagnostics` with no scan yet → 404.
- [ ] **Step 2: Implement.** Restructure the POST `/` job into explicit stages, building one `ScanDiagnostics` as it goes:

```ts
void opts.store.runScan(async () => {
  const diag: ScanDiagnostics = { generatedAt: new Date().toISOString(), env: await envSnapshot(version, opts.claudeProbe), discovery: emptyDiscovery, files: [], totals: totalsOf([]) }
  let stage: ScanStage = 'discovery'
  try {
    const { files, stats } = await discoverTranscripts(opts.homeDir)
    diag.discovery = stats
    opts.store.appendLog({ level: 'info', message: `Found ${files.length} transcript file(s) (${stats.projectDirs} project dir(s)${stats.unreadableDirs ? `, ${stats.unreadableDirs} unreadable` : ''})` })
    stage = 'parse'
    const units: TaskUnit[] = []
    for (const f of files) { const r = await parseSessionDetailed(f, opts.homeDir); units.push(...r.units); diag.files.push(r.stats) }
    diag.totals = totalsOf(diag.files)
    opts.store.appendLog({ level: 'info', message: `Parsed ${units.length} task unit(s); ${diag.totals.jsonErrors} unparseable line(s) skipped` })
    stage = 'digest'
    const ctx = buildAnalysisContext(units)
    if (!ctx) { await opts.store.setDiagnostics(diag); opts.store.appendLog({ level: 'info', message: 'No meaningful history to analyze yet.' }); return [] }
    stage = 'analysis'
    /* …existing streamingRunner call… */
    stage = 'parse-response'
    /* …existing parseAutomations call… */
    await opts.store.setDiagnostics(diag)
    return found
  } catch (err) {
    diag.failure = { stage, message: redact(err instanceof Error ? err.message : String(err), opts.homeDir) }
    await opts.store.setDiagnostics(diag)
    opts.store.appendLog({ level: 'error', message: `Scan failed during ${stage}: ${diag.failure.message}` })
    throw err
  }
})
```

  Add `router.get('/diagnostics', …)` returning `opts.store.getLatest()?.diagnostics` or 404, and optional `claudeProbe?: ClaudeProbe` + `version?: string` to `AutomationScanRouterOptions` (default version from package metadata the way `bin/cwc.ts` already resolves it — check and reuse that mechanism; pass through `createApp` `AppOptions`).
- [ ] **Step 3: Verify** `npx vitest run tests/server/` and `npm run typecheck`.

## Task 6: `cwc doctor`

**Files:**
- Create: `src/detection/doctor.ts`
- Modify: `bin/cwc.ts`
- Test: `tests/detection/doctor.test.ts`

**Interfaces produced:**

```ts
export interface DoctorOptions {
  homeDir: string
  cwcVersion: string
  out: (line: string) => void
  claudeProbe?: ClaudeProbe
  bundlePath?: string          // when set, write the ScanDiagnostics JSON here
}
export async function runDoctor(opts: DoctorOptions): Promise<{ ok: boolean; bundle: ScanDiagnostics }>
```

`runDoctor` = env probe + discovery + parse of every transcript (**no Claude analysis, no tokens**). `ok` is false when: root missing, zero transcripts, zero units, every file has a `readError`, or the claude binary is absent. Summary output is a handful of human lines (env, discovery counts, parse totals, per-file lines only for files with `readError`/`jsonErrors > 0`, verdict + "attach <bundle> to a bug report").

- [ ] **Step 1: Write the failing tests:**
  - Healthy temp home (one valid transcript, probe resolves) → `ok: true`; summary mentions transcript and unit counts; bundle written to `bundlePath` and parses as `ScanDiagnostics`.
  - Empty temp home (no `.claude`) → `ok: false`; summary says the projects root was not found; bundle still written.
  - Probe rejects → `ok: false`, `bundle.env.claude.found === false`.
  - **Privacy test (the load-bearing one):** fixture transcript contains a distinctive prompt string (`SECRET-PROMPT-TEXT-XYZ`) and a Bash command (`rm -rf /tmp/SECRET-CMD`); serialize the entire bundle with `JSON.stringify` and assert it contains **neither string, nor the raw temp homeDir path**.
- [ ] **Step 2: Implement** `runDoctor`, then wire `bin/cwc.ts`: `else if (command === 'doctor')` → thin caller resolving `--bundle [path]` (default `./cwc-doctor-bundle.json`), `out: console.log`, exit code `ok ? 0 : 1`. The bin caller stays untested, matching the launcher pattern — logic lives in the testable module.
- [ ] **Step 3: Verify** `npx vitest run tests/detection/doctor.test.ts`; run it for real once: `node dist/bin/cwc.js doctor --bundle /tmp/bundle.json` after `npm run build`, and read the bundle to confirm redaction on a real home directory.

## Task 7: README + full verification

- [ ] **Step 1:** Add a Troubleshooting subsection to `README.md`: if Detect errors or finds nothing, run `npx claude-cwc doctor --bundle`, state that the bundle is redacted (counts and versions only — no prompt or command content), and attach it to a GitHub issue.
- [ ] **Step 2:** Full gate per AGENTS.md: `npm test`, `npm run typecheck`, `npm run build` — all green on the branch.
- [ ] **Step 3:** Real-world smoke: run `doctor` against the developer's actual home dir; confirm the summary matches expectations (hundreds of transcripts, zero read errors) and skim the bundle one final time for anything that should not leave a machine.

## Out of Scope (Phase 0)

- No `cwc detect` UX (headless scan + inline skill export is Phase 1).
- No second transcript source; but note `discoverTranscripts`/`parseSessionDetailed` are deliberately shaped like the spec's `SessionSource.discover`/`parse` — they become the claude-code source implementation when the interface lands.
- No changes to analysis, generation, promotion, or export behavior.
- No client/UI changes beyond what already renders scan log lines (the richer `appendLog` lines show up in the existing Detect stream for free).

## Done means

The friend runs `npx claude-cwc doctor --bundle` (or one failing scan in the UI followed by `GET /api/automation-scan/diagnostics`), pastes one JSON file, and the bundle alone answers: did discovery find their transcripts, did the files parse and what was skipped, which stage failed, with what (redacted) error, on what platform/versions, with the claude binary present or not.
