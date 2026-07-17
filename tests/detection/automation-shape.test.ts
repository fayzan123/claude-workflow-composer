import { describe, expect, it } from 'vitest'
import { deriveAutomationShape, deriveRuleSuggestion } from '../../src/detection/automation-shape.js'
import type { DetectedAutomation, TaskUnit } from '../../src/detection/types.js'
import { classifyAutomation } from '../../src/generation/classifier.js'

function unit(over: Partial<TaskUnit> = {}): TaskUnit {
  return {
    sessionId: 's1',
    cwd: '/repo',
    promptText: 'run the checks',
    startedAt: '2026-07-01T09:00:00.000Z',
    endedAt: '2026-07-01T09:05:00.000Z',
    tools: ['Bash'],
    commands: ['npm test'],
    ...over,
  }
}

function automation(over: Partial<DetectedAutomation> = {}): DetectedAutomation {
  return {
    id: 'a1',
    title: 'Check the project',
    description: 'Run the project checks.',
    steps: ['run tests', 'fix the failures'],
    stepTokens: ['run-tests', 'fix-failures'],
    evidence: { count: 3, repos: ['/repo'], sessionIds: ['s1'], firstSeen: '', lastSeen: '' },
    suggestedTrigger: { kind: 'manual', label: 'On demand' },
    confidence: 0.9,
    status: 'new',
    ...over,
  }
}

describe('deriveAutomationShape', () => {
  it('derives archetypes, tool activity, verification, and risk from grounded evidence', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['review the changes', 'npm publish the package'] }),
      [unit({ commands: ['npm test', 'npm publish'] })],
    )

    expect(shape.stepArchetypes).toEqual(['review', 'publish'])
    expect(shape.distinctArchetypes).toBe(2)
    expect(shape.hasToolActivity).toBe(true)
    expect(shape.hasVerifySignal).toBe(true)
    expect(shape.hasRiskyStep).toBe(true)
    expect(shape.observedVerifyCommand).toBe('npm test')
  })

  it('splits hard external risk from soft VCS collaboration', () => {
    const published = deriveAutomationShape(
      automation({ steps: ['bump the version', 'npm publish the package'] }),
      [unit({ commands: ['npm version patch', 'npm publish'] })],
    )
    expect(published.hasRiskyStep).toBe(true)
    expect(published.hasHardRiskyStep).toBe(true)
    expect(classifyAutomation(automation({
      steps: ['bump the version', 'npm publish the package'],
      shape: published,
    }))).toBe('workflow')

    const pushed = deriveAutomationShape(
      automation({ steps: ['stage the changes', 'commit and push the changes'] }),
      [unit({ commands: ['git add -A', 'git commit -m "msg"', 'git push origin main'] })],
    )
    expect(pushed.hasRiskyStep).toBe(true)
    expect(pushed.hasHardRiskyStep).toBe(false)
    expect(classifyAutomation(automation({
      steps: ['stage the changes', 'commit and push the changes'],
      shape: pushed,
    }))).toBe('skill')
  })

  it('keeps a verification-only procedure soft even when nearby units also pushed', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['run tests', 'run the typecheck and build'] }),
      [unit({ commands: ['npm test', 'npm run typecheck', 'npm run build', 'git push'] })],
    )
    expect(shape.hasHardRiskyStep).toBe(false)
  })

  it('requires cross-unit corroboration before unit evidence hardens the risk', () => {
    const softSteps = { steps: ['run tests', 'commit and push all changes'] }
    // One overlapping release session among many soft units must not harden the card.
    const bleed = deriveAutomationShape(automation(softSteps), [
      unit({ commands: ['npm test', 'git push'] }),
      unit({ commands: ['npm test', 'git push'] }),
      unit({ commands: ['npm test', 'npm publish', 'git push'] }),
    ])
    expect(bleed.hasRiskyStep).toBe(true)
    expect(bleed.hasHardRiskyStep).toBe(false)

    // The same hard evidence in a strict majority of units is a real pattern.
    const corroborated = deriveAutomationShape(automation(softSteps), [
      unit({ commands: ['npm test', 'npm publish'] }),
      unit({ commands: ['npm test', 'npm publish', 'git push'] }),
      unit({ commands: ['npm test', 'git push'] }),
    ])
    expect(corroborated.hasHardRiskyStep).toBe(true)

    // Two of five is recurring but not characteristic: still soft.
    const minority = deriveAutomationShape(automation(softSteps), [
      unit({ commands: ['npm test', 'npm publish'] }),
      unit({ commands: ['npm test', 'npm publish'] }),
      unit({ commands: ['npm test', 'git push'] }),
      unit({ commands: ['npm test', 'git push'] }),
      unit({ commands: ['npm test', 'git push'] }),
    ])
    expect(minority.hasHardRiskyStep).toBe(false)

    // A hard signal in the automation's own steps is absolute regardless of units.
    const stepHard = deriveAutomationShape(
      automation({ steps: ['run tests', 'publish the package'] }),
      [unit({ commands: ['npm test'] })],
    )
    expect(stepHard.hasHardRiskyStep).toBe(true)
  })

  it('detects a majority slash-command driver and classifies it as a rule', () => {
    const commandUnits = [
      unit({ promptText: '<command-name>/brutal-product-analysis</command-name> spec.md' }),
      unit({ promptText: '/brutal-product-analysis docs/idea.md' }),
      unit({ promptText: 'also tweak the summary afterwards' }),
    ]
    const shape = deriveAutomationShape(automation(), commandUnits)
    expect(shape.invokedSlashCommand).toBe('brutal-product-analysis')
    expect(classifyAutomation(automation({ shape }))).toBe('rule')

    const mixed = deriveAutomationShape(automation(), [
      unit({ promptText: '/one thing' }),
      unit({ promptText: '/two thing' }),
      unit({ promptText: 'plain prompt' }),
    ])
    expect(mixed.invokedSlashCommand).toBeUndefined()
  })

  it('detects skill-tool invocations behind natural-language prompts', () => {
    const shape = deriveAutomationShape(automation(), [
      unit({ promptText: 'run brutal product analysis on the spec', tools: ['Skill'], invokedCommands: ['brutal-product-analysis'] }),
      unit({ promptText: 'brutally analyze this new idea doc', tools: ['Skill'], invokedCommands: ['brutal-product-analysis'] }),
      unit({ promptText: 'tighten the summary section' }),
    ])
    expect(shape.invokedSlashCommand).toBe('brutal-product-analysis')
    expect(classifyAutomation(automation({ shape }))).toBe('rule')
  })

  it('marks retry only when the same observed verification command repeats in one unit', () => {
    const retried = deriveAutomationShape(automation(), [
      unit({ commands: ['npm test', 'edit src/a.ts', 'npm test'] }),
    ])
    expect(retried.hasRetryPattern).toBe(true)

    const differentChecks = deriveAutomationShape(automation(), [
      unit({ commands: ['npm test', 'npm run build'] }),
    ])
    expect(differentChecks.hasRetryPattern).toBe(false)
  })

  it('extracts a verifier from a compound command without retaining later side effects', () => {
    const shape = deriveAutomationShape(automation(), [
      unit({ commands: ['cd app && npm test && git push origin main'] }),
    ])

    expect(shape.observedVerifyCommand).toBe('cd app && npm test')
    expect(shape.observedVerifyCommand).not.toContain('git push')
    expect(shape.hasRiskyStep).toBe(true)
  })

  it('does not split quoted shell operators or normalize whitespace inside arguments', () => {
    const command = "npm test -- --grep 'a;b && c || d | e >  f'"
    const shape = deriveAutomationShape(automation(), [unit({ commands: [command] })])

    expect(shape.observedVerifyCommand).toBe(command)
  })

  it.each([
    'npm test | tee test.log',
    'npm test |& tee test.log',
    'npm test > test.log',
    'npm test 2>&1',
    'npm test &',
  ])('keeps %s as a verification signal without persisting it as a safe command', (command) => {
    const shape = deriveAutomationShape(
      automation({ steps: ['repair the reported failures'] }),
      [unit({ commands: [command] })],
    )

    expect(shape.hasVerifySignal).toBe(true)
    expect(shape.observedVerifyCommand).toBeUndefined()
  })

  it('allows quoted pipe and redirection characters in verifier arguments', () => {
    const command = 'npm test -- --grep "renders a | b > c"'
    expect(deriveAutomationShape(automation(), [unit({ commands: [command] })]).observedVerifyCommand).toBe(command)
  })

  it('preserves a quoted cwd prefix needed to rerun the verifier', () => {
    const command = "cd 'packages/web app' && npm test"
    expect(deriveAutomationShape(automation(), [unit({ commands: [command] })]).observedVerifyCommand).toBe(command)
  })

  it('does not persist a verifier when its cwd prefix uses dynamic shell execution', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['repair the reported failures'] }),
      [unit({ commands: ['cd "$(touch marker)" && npm test'] })],
    )

    expect(shape.hasVerifySignal).toBe(true)
    expect(shape.observedVerifyCommand).toBeUndefined()
  })

  it.each([
    '(cd app && npm test)',
    'cd app && npm install && npm test',
    'export NODE_ENV=test && npm test',
    'EMPTY= && npm test',
    "FIRST=1 SECOND='two words' && npm test",
    'pushd app && npm test',
  ])('does not detach a verifier from unsupported shell context in %s', (command) => {
    const shape = deriveAutomationShape(
      automation({ steps: ['repair the reported failures'] }),
      [unit({ commands: [command] })],
    )

    expect(shape.hasVerifySignal).toBe(true)
    expect(shape.observedVerifyCommand).toBeUndefined()
  })

  it('selects the verifier that actually established the retry pattern', () => {
    const shape = deriveAutomationShape(automation(), [
      unit({ sessionId: 'retry', commands: ['npm test', 'edit src/a.ts', 'npm test'] }),
      unit({ sessionId: 'lint-1', commands: ['npm lint'] }),
      unit({ sessionId: 'lint-2', commands: ['npm lint'] }),
      unit({ sessionId: 'lint-3', commands: ['npm lint'] }),
    ])

    expect(shape.hasRetryPattern).toBe(true)
    expect(shape.observedVerifyCommand).toBe('npm test')
  })

  it('does not infer retry from one verifier occurrence in separate units', () => {
    const shape = deriveAutomationShape(automation(), [
      unit({ sessionId: 'first', commands: ['npm test'] }),
      unit({ sessionId: 'second', commands: ['npm test'] }),
    ])

    expect(shape.hasRetryPattern).toBe(false)
  })

  it('recognizes external command forms whose generic verb would otherwise hide the risk', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['prepare the change', 'open the pull request'] }),
      [unit({ commands: ['gh pr create --fill'] })],
    )

    expect(shape.stepArchetypes).toEqual(['prepare', 'publish'])
    expect(shape.hasRiskyStep).toBe(true)
  })

  it.each([
    'gh issue create --title bug',
    'gh api repos/acme/project/issues -f title=bug',
    'curl https://example.test/issues --data title=bug',
    'aws s3api create-bucket --bucket release-assets',
    'gcloud run deploy service',
  ])('grounds external mutation risk in the observed command %s', (command) => {
    const shape = deriveAutomationShape(
      automation({ steps: ['create the tracking item'] }),
      [unit({ promptText: 'create the tracking item', commands: [command] })],
    )

    expect(shape.hasRiskyStep).toBe(true)
  })

  it.each([
    'aws s3 rm s3://assets/old.tgz',
    'aws s3 cp build.tgz s3://assets/build.tgz',
    'kubectl create secret generic api-key',
    'kubectl rollout restart deployment/api',
    'npm unpublish package@1.2.3',
    'npm dist-tag add package@1.2.3 latest',
  ])('keeps common external mutation command %s in a gate-capable workflow', (command) => {
    const detected = automation({ steps: ['clean up the old item'] })
    const shape = deriveAutomationShape(
      detected,
      [unit({ promptText: 'clean up the old item', commands: [command] })],
    )

    expect(shape.hasRiskyStep).toBe(true)
    expect(classifyAutomation({ ...detected, shape })).toBe('workflow')
  })

  it('uses the cited prompt as risk evidence when the analyzer step is bland', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['finish the routine'] }),
      [unit({ promptText: 'Deploy the service and notify the team', commands: [] })],
    )

    expect(shape.hasRiskyStep).toBe(true)
  })

  it.each([
    'mcp__slack__send_message',
    'mcp__notion__update_page',
    'connector:github/create_issue',
    'google_calendar_create_event',
  ])('keeps the observed connector mutation %s in a gate-capable workflow', (tool) => {
    const detected = automation({ steps: ['finish the routine'] })
    const shape = deriveAutomationShape(
      detected,
      [unit({ promptText: 'finish the routine', tools: [tool], commands: [] })],
    )

    expect(shape.hasRiskyStep).toBe(true)
    expect(shape.observedMutatingTools).toEqual([tool])
    expect(classifyAutomation({ ...detected, shape })).toBe('workflow')
  })

  it.each([
    { tools: ['Read', 'Write', 'Edit', 'Bash'] },
    { tools: ['WebSearch', 'WebFetch', 'TaskUpdate'] },
    { tools: ['mcp__notion__search_pages', 'mcp__slack__get_channel_history'] },
  ])('does not mistake read-only connectors or local builtins for external mutations: $tools', ({ tools }) => {
    const shape = deriveAutomationShape(
      automation({ steps: ['finish the routine'] }),
      [unit({ promptText: 'finish the routine', tools, commands: [] })],
    )

    expect(shape.hasRiskyStep).toBe(false)
    expect(shape.observedMutatingTools).toBeUndefined()
  })

  it('deduplicates observed connector tools without persisting unsafe frontmatter text', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['finish the routine'] }),
      [unit({
        tools: ['mcp__slack__send_message', 'mcp__slack__send_message', 'mcp__slack__send_message,\nBash'],
        commands: [],
      })],
    )

    expect(shape.hasRiskyStep).toBe(true)
    expect(shape.observedMutatingTools).toEqual(['mcp__slack__send_message'])
  })

  it('keeps read-only Slack history and deployment-log review as a skill', () => {
    const detected = automation({
      steps: ['Review the Slack message history', 'Inspect the deployment logs'],
    })
    const shape = deriveAutomationShape(detected, [unit({
      promptText: 'Review Slack history and inspect deployment logs',
      tools: ['mcp__slack__search_messages', 'Read'],
      commands: [],
    })])

    expect(shape.stepArchetypes).toEqual(['review', 'review'])
    expect(shape.hasRiskyStep).toBe(false)
    expect(classifyAutomation({ ...detected, shape })).toBe('skill')
  })

  it('does not mistake a quoted mutation command printed by echo for execution', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['record the example'] }),
      [unit({ promptText: 'record the example', commands: ['echo "gh issue create --title bug"'] })],
    )

    expect(shape.hasRiskyStep).toBe(false)
  })

  it('defaults dependency shape to linear and recognizes only explicit parallel evidence', () => {
    const linear = deriveAutomationShape(
      automation({ steps: ['research the API', 'implement the client'] }),
      [unit({ promptText: 'research the API and implement the client' })],
    )
    expect(linear.independentStepGroups).toBe(1)

    const parallel = deriveAutomationShape(
      automation({ steps: ['review the API', 'independently review the UI'] }),
      [unit({ promptText: 'review the API and UI in parallel' })],
    )
    expect(parallel.independentStepGroups).toBe(2)
    expect(parallel.independentStepIndexes).toEqual([0, 1])
  })

  it('does not parallelize a dependent role change merely described as independent review', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['implement the feature', 'independently review the changes'] }),
      [unit({ promptText: 'implement the feature, then independently review the changes' })],
    )

    expect(shape.independentStepGroups).toBe(1)
    expect(shape.independentStepIndexes).toBeUndefined()
  })

  it('grounds prompt-only N-way fan-out to exact sibling step indexes', () => {
    const shape = deriveAutomationShape(
      automation({ steps: ['prepare inputs', 'review API', 'review UI', 'review CLI', 'summarize findings'] }),
      [unit({ promptText: 'prepare inputs, then review API, UI, and CLI in parallel before summarizing findings' })],
    )

    expect(shape.independentStepGroups).toBe(3)
    expect(shape.independentStepIndexes).toEqual([1, 2, 3])
  })

  it('marks schedule and deterministic timing evidence as recurring', () => {
    expect(deriveAutomationShape(
      automation({ suggestedTrigger: { kind: 'schedule', cron: '0 9 * * *', label: 'daily' } }),
      [unit()],
    ).recurring).toBe(true)

    expect(deriveAutomationShape(
      automation({ evidence: { count: 3, repos: [], sessionIds: [], firstSeen: '', lastSeen: '', timing: 'weekday mornings' } }),
      [unit()],
    ).recurring).toBe(true)
  })
})

describe('deriveRuleSuggestion', () => {
  it('chooses a deterministic grounded prompt medoid', () => {
    const units = [
      unit({ promptText: 'Always use pnpm for package commands.', tools: [], commands: [] }),
      unit({ promptText: 'Please always use pnpm for package commands', tools: [], commands: [] }),
      unit({ promptText: 'Always use pnpm for package commands.', tools: [], commands: [] }),
    ]

    expect(deriveRuleSuggestion(units)).toBe('Always use pnpm for package commands.')
    expect(deriveRuleSuggestion([...units].reverse())).toBe('Always use pnpm for package commands.')
  })
})
