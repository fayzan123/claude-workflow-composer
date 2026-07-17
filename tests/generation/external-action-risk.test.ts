import { describe, expect, it } from 'vitest'
import {
  commandExternalActionSignals,
  externalActionBearingLines,
  externalActionSignals,
  externalMutationToolNames,
  hasExternalAction,
  isExternalMutationToolName,
} from '../../src/generation/external-action-risk.js'

describe('external mutation tool names', () => {
  it('returns only recognized connector writes in stable observation order', () => {
    expect(externalMutationToolNames([
      'Read',
      'mcp__slack__search_messages',
      'mcp__notion__update_page',
      'connector:github/create_issue',
      'mcp__notion__update_page',
      'google_calendar_create_event',
      'mcp__slack__get_channel_history',
    ])).toEqual([
      'mcp__notion__update_page',
      'connector:github/create_issue',
      'google_calendar_create_event',
    ])
  })

  it('requires an external service or namespace in addition to a write-shaped verb', () => {
    expect(isExternalMutationToolName('Update')).toBe(false)
    expect(isExternalMutationToolName('TaskUpdate')).toBe(false)
    expect(isExternalMutationToolName('mcp__notion__search_pages')).toBe(false)
    expect(isExternalMutationToolName('mcp__notion__update_page')).toBe(true)
  })
})

describe('external action text and commands', () => {
  it.each([
    ['aws s3 rm s3://assets/old.tgz', 'cloud-write'],
    ['aws s3 cp build.tgz s3://assets/build.tgz', 'cloud-write'],
    ['kubectl create secret generic api-key', 'deploy'],
    ['kubectl rollout restart deployment/api', 'deploy'],
    ['npm unpublish package@1.2.3', 'package-publish'],
    ['npm dist-tag add package@1.2.3 latest', 'package-publish'],
  ] as const)('recognizes %s as %s', (command, signal) => {
    expect(commandExternalActionSignals(command)).toContain(signal)
    expect(hasExternalAction(command)).toBe(true)
  })

  it('collapses explicit shell continuations before scanning commands and connector names', () => {
    const splitPush = ['git \\', '  push --force origin main'].join('\n')
    const splitCurl = ['curl -X \\', '  POST https://example.test/items -d value=1'].join('\n')
    const splitConnector = ['mcp__notion__update_\\', 'page'].join('\n')

    expect(externalActionSignals(splitPush)).toContain('git-push')
    expect(externalActionSignals(splitCurl)).toContain('http-write')
    expect(externalActionSignals(splitConnector)).toContain('connector-write')
    expect(externalActionBearingLines(splitPush)).toEqual(['git push --force origin main'])
  })

  it('recognizes action-shaped communication while allowing the same nouns in read-only prose', () => {
    expect(externalActionSignals('post the release announcement')).toContain('communication')
    expect(externalActionSignals('read the release announcement').size).toBe(0)
  })

  it.each([
    'Review the Slack message history.',
    'Inspect the deployment logs before reporting.',
    'Describe the Notion page update without calling a connector.',
    'Read the release notes and pull request discussion.',
  ])('does not flag read-only prose: %s', (text) => {
    expect(externalActionSignals(text).size).toBe(0)
  })
})
