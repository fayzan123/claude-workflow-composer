export type ExternalActionSignal =
  | 'cloud-write'
  | 'communication'
  | 'connector-write'
  | 'deploy'
  | 'destructive-delete'
  | 'git-push'
  | 'github-write'
  | 'http-write'
  | 'infrastructure-write'
  | 'merge'
  | 'package-publish'
  | 'release'

/** Signals whose observed action is irreversible or outward-facing enough that
 * generation must stay on the gate-capable workflow tier. Routine VCS collaboration
 * (git-push, merge, github-write) is deliberately excluded: mutating but recoverable
 * daily work that would otherwise force every commit-and-push repetition into a
 * workflow, defeating the smallest-artifact goal. */
export const HARD_EXTERNAL_SIGNALS: ReadonlySet<ExternalActionSignal> = new Set<ExternalActionSignal>([
  'cloud-write',
  'communication',
  'connector-write',
  'deploy',
  'destructive-delete',
  'http-write',
  'infrastructure-write',
  'package-publish',
  'release',
])

export function hasHardExternalSignal(signals: Iterable<ExternalActionSignal>): boolean {
  for (const signal of signals) if (HARD_EXTERNAL_SIGNALS.has(signal)) return true
  return false
}

const TEXT_PATTERNS: ReadonlyArray<readonly [ExternalActionSignal, RegExp]> = [
  ['git-push', /\bgit\s+push\b|\bpush(?:ing|ed)?\s+(?:(?:the|a|this)\s+)?(?:changes?|commits?|branch|tag|code)\b/i],
  ['github-write', /\bgh\s+(?:pr\s+(?:create|merge|comment|review|close|reopen|edit)|issue\s+(?:create|close|reopen|edit|comment|delete|transfer|pin|unpin)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|fork|rename|archive)|api\b[^\n]*(?:(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)|(?:\s|^)(?:-f|-F|--field|--raw-field)(?:\s|=)))/i],
  ['github-write', /\b(?:create|open|close|reopen|edit|delete|comment\s+on|merge)\s+(?:(?:a|the)\s+)?(?:(?:github|gitlab)\s+)?(?:issue|pull request|pr)\b/i],
  ['http-write', /\bcurl\b[^\n]*(?:(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:\s|^)(?:-d|--data(?:-[a-z-]+)?|-F|--form(?:-string)?|-T|--upload-file|--json)(?:\s|=))/i],
  ['package-publish', /\b(?:npm|pnpm|yarn|bun)\s+publish\b|\b(?:twine|gem)\s+(?:upload|push)\b|\bcargo\s+publish\b/i],
  ['deploy', /\bdeploy(?:ed|s|ing)?\b|\bship(?:ped|s|ping)?\s+(?:(?:the|a|this)\s+)?(?:service|app|application|site|build|release|code)\b|\b(?:docker\s+push|kubectl\s+(?:apply|create|delete|edit|replace|patch|scale|set)|helm\s+(?:install|upgrade|uninstall|rollback)|vercel\s+(?:deploy|--prod)|netlify\s+(?:deploy|sites:create)|fly\s+deploy|wrangler\s+(?:deploy|publish))\b/i],
  ['infrastructure-write', /\bterraform\s+(?:apply|destroy|import|taint|untaint)\b|\bpulumi\s+(?:up|destroy|import)\b/i],
  ['cloud-write', /\baws\s+\S+\s+(?:(?:create|delete|put|update|modify|start|stop|terminate|run|deploy|publish|send|invoke|attach|detach|associate|disassociate|authorize|revoke|tag|untag|set|register|deregister|enable|disable|restore|copy|move|upload|sync)(?:-[\w-]+)?)\b/i],
  ['cloud-write', /\b(?:gcloud|az)\b[^\n]*\b(?:create|delete|deploy|update|set|add|remove|start|stop|reset|restore|submit|publish|write|upload|copy|move|invoke)\b|\bgsutil\s+(?:cp|mv|rm|rsync|setmeta|acl|iam|web|cors|defacl)\b/i],
  ['communication', /\b(?:send|notify|announce)(?:ing|ed|s)?\b|\bemail(?:ed|ing|s)\b|\bemail\s+(?:the|a|an|our|their|team|user|customer|reviewer)\b|\bpost(?:ing|ed|s)?\s+(?:(?:(?:a|the|this)\s+)?(?:(?:release|deployment|status|project|team|customer)\s+)?(?:message|announcement|update)|(?:to|on)\b)|\bmessage(?:d|s|ing)?\s+(?:the|a|an|our|their|team|user|channel|customer|reviewer)\b|\btrigger(?:ed|s|ing)?\s+(?:(?:a|the)\s+)?webhook\b/i],
  ['merge', /\b(?:merge|force-merge)(?:d|s|ing)?\s+(?:(?:the|a|this)\s+)?(?:pull request|pr|branch|changes?|commits?|code)\b/i],
  ['release', /\b(?:publish|upload)(?:ed|es|s|ing)?\b|\brelease(?:d|s|ing)\b|\brelease\s+(?:(?:the|a|an|this|new)\s+)?(?:package|version|build|artifact|candidate|software|app|service)\b|\b(?:create|cut|ship|publish)\s+(?:(?:a|the|new)\s+)?release\b/i],
  ['destructive-delete', /\brm\s+-[^\n]*r[^\n]*f\b|\b(?:drop|delete)\s+(?:table|database|bucket|cluster|repository|repo|release|deployment)\b/i],
]

function stripCommandPrefix(value: string): string {
  let command = value.trim()
  let previous = ''
  while (command !== previous) {
    previous = command
    command = command.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'[^']*'|[^\s]*)\s+/, '')
  }
  command = command.replace(/^(?:command\s+|sudo(?:\s+-\S+)*\s+)/, '')
  if (command.startsWith('env ')) {
    command = command.slice(4).trimStart()
    previous = ''
    while (command !== previous) {
      previous = command
      command = command.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'[^']*'|[^\s]*)\s+/, '')
    }
  }
  return command
}

const COMMAND_PATTERNS: ReadonlyArray<readonly [ExternalActionSignal, RegExp]> = [
  ['git-push', /^git\s+push\b/i],
  ['merge', /^git\s+merge\b/i],
  ['github-write', /^gh\s+(?:pr\s+(?:create|merge|comment|review|close|reopen|edit)|issue\s+(?:create|close|reopen|edit|comment|delete|transfer|pin|unpin)|release\s+(?:create|delete|edit|upload)|repo\s+(?:create|delete|fork|rename|archive))\b/i],
  ['github-write', /^gh\s+api\b[^\n]*(?:(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:\s|^)(?:-f|-F|--field|--raw-field)(?:\s|=))/i],
  ['http-write', /^curl\b[^\n]*(?:(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b|(?:\s|^)(?:-d|--data(?:-[a-z-]+)?|-F|--form(?:-string)?|-T|--upload-file|--json)(?:\s|=))/i],
  ['package-publish', /^(?:(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|deprecate)|npm\s+dist-tag\s+(?:add|rm)|npm\s+owner\s+(?:add|rm)|npm\s+access\s+(?:grant|revoke)|twine\s+upload|gem\s+push|cargo\s+publish)\b/i],
  ['deploy', /^(?:docker\s+push|kubectl\b[^\n]*\b(?:apply|create|delete|edit|replace|patch|scale|set|label|annotate|taint|cordon|uncordon|drain|expose|autoscale|run)\b|kubectl\b[^\n]*\brollout\s+(?:restart|undo|pause|resume)\b|helm\s+(?:install|upgrade|uninstall|rollback)|vercel\s+(?:deploy|--prod)|netlify\s+(?:deploy|sites:create)|fly\s+deploy|wrangler\s+(?:deploy|publish))\b/i],
  ['infrastructure-write', /^(?:terraform\s+(?:apply|destroy|import|taint|untaint)|pulumi\s+(?:up|destroy|import))\b/i],
  ['cloud-write', /^aws\s+\S+\s+(?:(?:create|delete|put|update|modify|start|stop|terminate|run|deploy|publish|send|invoke|attach|detach|associate|disassociate|authorize|revoke|tag|untag|set|register|deregister|enable|disable|restore|copy|move|upload|sync)(?:-[\w-]+)?)\b/i],
  ['cloud-write', /^aws\s+s3\s+(?:cp|mv|rm|sync|website)\b/i],
  ['cloud-write', /^(?:gcloud|az)\b[^\n]*\b(?:create|delete|deploy|update|set|add|remove|start|stop|reset|restore|submit|publish|write|upload|copy|move|invoke)\b/i],
  ['cloud-write', /^gsutil\s+(?:cp|mv|rm|rsync|setmeta|acl|iam|web|cors|defacl)\b/i],
  ['communication', /^(?:slack|mail|mailx|sendmail)\b/i],
  ['destructive-delete', /^rm\s+-[^\n]*r[^\n]*f\b/i],
]

// Claude's local tools can have write-shaped names without representing an
// external action. Bash is evaluated from its recorded command text instead.
const LOCAL_TOOL_NAMES = new Set([
  'agent',
  'askuserquestion',
  'bash',
  'edit',
  'enterplanmode',
  'exitplanmode',
  'glob',
  'grep',
  'killshell',
  'listmcpresources',
  'ls',
  'multiedit',
  'notebookedit',
  'read',
  'readmcpresource',
  'skill',
  'slashcommand',
  'task',
  'taskcreate',
  'taskget',
  'tasklist',
  'taskoutput',
  'taskstop',
  'taskupdate',
  'todowrite',
  'toolsearch',
  'webfetch',
  'websearch',
  'write',
])

const CONNECTOR_MUTATION_TOKENS = new Set([
  'add',
  'append',
  'approve',
  'archive',
  'assign',
  'attach',
  'cancel',
  'close',
  'comment',
  'copy',
  'create',
  'delete',
  'deploy',
  'disable',
  'discard',
  'edit',
  'enable',
  'insert',
  'invite',
  'merge',
  'modify',
  'move',
  'patch',
  'post',
  'publish',
  'push',
  'put',
  'react',
  'release',
  'remove',
  'rename',
  'reply',
  'resolve',
  'restore',
  'revoke',
  'save',
  'schedule',
  'send',
  'set',
  'share',
  'start',
  'stop',
  'submit',
  'sync',
  'tag',
  'transfer',
  'trigger',
  'unarchive',
  'unassign',
  'unpublish',
  'update',
  'upload',
  'upsert',
  'write',
])

const EXTERNAL_CONNECTOR_TOKENS = new Set([
  'airtable',
  'asana',
  'calendar',
  'discord',
  'drive',
  'dropbox',
  'gmail',
  'github',
  'gitlab',
  'google',
  'hubspot',
  'jira',
  'linear',
  'notion',
  'outlook',
  'salesforce',
  'slack',
  'stripe',
  'teams',
  'trello',
])

function toolNameTokens(value: string): string[] {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean)
}

/** True only for a method-shaped external connector name. Ordinary prose such
 * as "update the Notion page" is intentionally not passed to this function. */
export function isExternalMutationToolName(tool: string): boolean {
  const compact = tool.replace(/[^a-z\d]/gi, '').toLowerCase()
  if (LOCAL_TOOL_NAMES.has(compact)) return false

  const tokens = toolNameTokens(tool)
  if (!tokens.some(token => CONNECTOR_MUTATION_TOKENS.has(token))) return false
  const namespaced = /^(?:mcp|connector|app)(?:__|[.:/\-])/i.test(tool) || tool.includes('__')
  return namespaced || tokens.some(token => EXTERNAL_CONNECTOR_TOKENS.has(token))
}

/** Preserve observation order while removing duplicate mutating connector names.
 * Shape derivation and later generation/runtime binding share this exact policy. */
export function externalMutationToolNames(tools: readonly string[]): string[] {
  return [...new Set(tools.filter(isExternalMutationToolName))]
}

/** Shell continuations are one executable instruction. Collapse only explicit
 * backslash-newline pairs so unrelated prose lines never become a command. */
function collapseShellContinuations(value: string): string {
  return value.replace(/\\\r?\n[\t ]*/g, '')
}

function hasExternalMutationToolReference(value: string): boolean {
  const candidates = value.match(/[A-Za-z][A-Za-z\d_:/.~-]*/g) ?? []
  return candidates.some(candidate => {
    if (/^https?:/i.test(candidate)) return false
    const methodShaped = /__|[._:-]|[a-z\d][A-Z]/.test(candidate)
    if (!methodShaped) return false
    // A slash in an unprefixed candidate is ordinarily a file path, not a tool
    // name. Namespaced connector forms may legitimately use connector:svc/method.
    if (candidate.includes('/') && !/^(?:mcp|connector|app)(?:__|[.:/\-])/i.test(candidate)) return false
    return isExternalMutationToolName(candidate)
  })
}

export function commandExternalActionSignals(value: string): Set<ExternalActionSignal> {
  const command = stripCommandPrefix(collapseShellContinuations(value))
  const signals = new Set<ExternalActionSignal>()
  for (const [signal, pattern] of COMMAND_PATTERNS) {
    if (pattern.test(command)) signals.add(signal)
  }
  return signals
}

export function externalActionSignals(value: string): Set<ExternalActionSignal> {
  const normalized = collapseShellContinuations(value)
  const signals = new Set<ExternalActionSignal>()
  for (const [signal, pattern] of TEXT_PATTERNS) {
    if (pattern.test(normalized)) signals.add(signal)
  }
  if (hasExternalMutationToolReference(normalized)) signals.add('connector-write')
  for (const rawLine of normalized.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/^(?:run|execute)\s+/, '')
      .replace(/^`|`$/g, '')
    for (const signal of commandExternalActionSignals(line)) signals.add(signal)
  }
  return signals
}

/** Logical, signal-bearing instruction lines for exact grounding checks. */
export function externalActionBearingLines(value: string): string[] {
  return collapseShellContinuations(value)
    .split(/\r?\n/)
    .filter(line => externalActionSignals(line).size > 0)
}

export function hasExternalAction(value: string): boolean {
  return externalActionSignals(value).size > 0
}

export function hasExternalMutationCommand(value: string): boolean {
  return commandExternalActionSignals(value).size > 0
}
