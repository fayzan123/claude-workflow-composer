import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import matter from 'gray-matter'
import {
  ownedExportedAgentId,
  ownedExportedSkillId,
  type ExportedAgentBinding,
} from './exported-skill.js'
import type { RunBindingAuthority } from './run-manifest.js'
import {
  parseBespokeAgentDeclaration,
  unsupportedAgentDispatchTypes,
  unqualifiedAgentDispatchSlugs,
} from '../export/deployment-metadata.js'
import { CANONICAL_SLUG_RE as SKILL_SLUG_RE } from '../slugify.js'

const BINDING_VERSION = 2 as const
const BINDING_ID_RE = /^[0-9a-f]{16}$/
const HASH_RE = /^[0-9a-f]{64}$/
const MAX_BOUND_FILE_BYTES = 2 * 1024 * 1024
const MAX_BOUND_AGENTS = 64

interface BoundAgentRecord {
  slug: string
  scope: 'project' | 'user'
  kind: 'bespoke' | 'reference'
  sourceHash: string
  boundHash: string
}

interface BindingRecord {
  version: typeof BINDING_VERSION
  runId: string
  workflowId: string
  skillSlug: string
  pluginName: string
  invocationSlug: string
  sourceSkillHash: string
  boundSkillHash: string
  pluginManifestHash: string
  agents: BoundAgentRecord[]
}

export interface RunSkillBinding {
  pluginDir: string
  invocationSlug: string
  authority: RunBindingAuthority
  cleanup: () => Promise<void>
}

function hash(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function bindingId(workflowId: string, runId: string, skillSlug: string): string {
  return createHash('sha256')
    .update(`${workflowId}\0${runId}\0${skillSlug}`)
    .digest('hex')
    .slice(0, 16)
}

function bindingPaths(root: string, id: string): { bindingsRoot: string; pluginDir: string } {
  if (!BINDING_ID_RE.test(id)) throw new Error('Run binding id is invalid.')
  const bindingsRoot = path.join(path.resolve(root), '.skill-bindings')
  return { bindingsRoot, pluginDir: path.join(bindingsRoot, id) }
}

function pluginManifest(pluginName: string): string {
  return `${JSON.stringify({
    name: pluginName,
    description: 'CWC process-private managed run artifact binding',
    version: '1.0.0',
  }, null, 2)}\n`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function assertAgentBinding(agent: ExportedAgentBinding, workflowId: string): void {
  if (!SKILL_SLUG_RE.test(agent.slug)) throw new Error(`Cannot bind unsafe agent slug ${agent.slug}.`)
  if (!HASH_RE.test(agent.contentHash) || hash(agent.content) !== agent.contentHash) {
    throw new Error(`Agent ${agent.slug} changed before it could be bound.`)
  }
  const owner = ownedExportedAgentId(agent.content)
  if (agent.kind === 'bespoke' ? owner !== workflowId : owner === workflowId) {
    throw new Error(`Agent ${agent.slug} does not match its ${agent.kind} deployment metadata.`)
  }
  let name: unknown
  try { name = matter(agent.content).data.name } catch { throw new Error(`Agent ${agent.slug} has invalid frontmatter.`) }
  if (name !== agent.slug) throw new Error(`Agent ${agent.slug} has a mismatched frontmatter name.`)
}

function bindSkillContent(
  content: string,
  workflowId: string,
  pluginName: string,
  agents: ExportedAgentBinding[],
): string {
  if (ownedExportedSkillId(content) !== workflowId) throw new Error('The skill binding lost artifact ownership.')
  const unsupportedDispatches = unsupportedAgentDispatchTypes(content)
  if (unsupportedDispatches.length > 0) {
    throw new Error(`The skill contains agent dispatches that cannot be bound immutably: ${unsupportedDispatches.join(', ')}.`)
  }
  const declared = parseBespokeAgentDeclaration(content)
  const dispatches = unqualifiedAgentDispatchSlugs(content)
  const agentSlugs = agents.filter(agent => agent.kind === 'bespoke').map(agent => agent.slug).sort()
  if (declared === null) {
    if (dispatches.length > 0 || agentSlugs.length > 0) {
      throw new Error('The skill has agent dispatches but no bespoke-agent deployment metadata.')
    }
  } else if (declared.length !== agentSlugs.length
    || declared.some((slug, index) => slug !== agentSlugs[index])) {
    throw new Error('The verified agents do not match the skill deployment metadata.')
  }
  let bound = content
  for (const agent of agents) {
    const dispatch = new RegExp(`(subagent_type:\\s*")${escapeRegExp(agent.slug)}(")`, 'g')
    let replacements = 0
    bound = bound.replace(dispatch, (_match, prefix: string, suffix: string) => {
      replacements += 1
      return `${prefix}${pluginName}:${agent.slug}${suffix}`
    })
    if (replacements === 0) throw new Error(`Bound agent ${agent.slug} is not dispatched by the bound skill.`)
  }
  return bound
}

async function writeSynced(filePath: string, content: string): Promise<void> {
  const handle = await fs.open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(content, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function readRegularBoundFile(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BOUND_FILE_BYTES) {
    throw new Error(`Run binding file is not a bounded regular file: ${filePath}`)
  }
  return fs.readFile(filePath, 'utf-8')
}

async function assertBoundDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Run binding directory is invalid: ${directory}`)
}

function parseBindingRecord(raw: string): BindingRecord {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new Error('Run binding metadata is malformed.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Run binding metadata is invalid.')
  const record = value as Record<string, unknown>
  if (record.version !== BINDING_VERSION
    || typeof record.runId !== 'string'
    || typeof record.workflowId !== 'string'
    || typeof record.skillSlug !== 'string'
    || typeof record.pluginName !== 'string'
    || typeof record.invocationSlug !== 'string'
    || typeof record.sourceSkillHash !== 'string' || !HASH_RE.test(record.sourceSkillHash)
    || typeof record.boundSkillHash !== 'string' || !HASH_RE.test(record.boundSkillHash)
    || typeof record.pluginManifestHash !== 'string' || !HASH_RE.test(record.pluginManifestHash)
    || !Array.isArray(record.agents) || record.agents.length > MAX_BOUND_AGENTS) {
    throw new Error('Run binding metadata is invalid.')
  }
  const agents = record.agents.map((entry, index): BoundAgentRecord => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Run binding agent ${index} is invalid.`)
    const agent = entry as Record<string, unknown>
    if (typeof agent.slug !== 'string' || !SKILL_SLUG_RE.test(agent.slug)
      || (agent.scope !== 'project' && agent.scope !== 'user')
      || (agent.kind !== 'bespoke' && agent.kind !== 'reference')
      || typeof agent.sourceHash !== 'string' || !HASH_RE.test(agent.sourceHash)
      || typeof agent.boundHash !== 'string' || !HASH_RE.test(agent.boundHash)) {
      throw new Error(`Run binding agent ${index} is invalid.`)
    }
    return {
      slug: agent.slug,
      scope: agent.scope,
      kind: agent.kind,
      sourceHash: agent.sourceHash,
      boundHash: agent.boundHash,
    }
  })
  if (new Set(agents.map(agent => agent.slug)).size !== agents.length) {
    throw new Error('Run binding contains duplicate agents.')
  }
  return {
    version: BINDING_VERSION,
    runId: record.runId,
    workflowId: record.workflowId,
    skillSlug: record.skillSlug,
    pluginName: record.pluginName,
    invocationSlug: record.invocationSlug,
    sourceSkillHash: record.sourceSkillHash,
    boundSkillHash: record.boundSkillHash,
    pluginManifestHash: record.pluginManifestHash,
    agents,
  }
}

function cleanupFor(root: string, id: string): () => Promise<void> {
  const { bindingsRoot, pluginDir } = bindingPaths(root, id)
  return async () => {
    const rootStat = await fs.lstat(bindingsRoot).catch(() => null)
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return
    const pluginStat = await fs.lstat(pluginDir).catch(() => null)
    if (pluginStat && (!pluginStat.isDirectory() || pluginStat.isSymbolicLink())) return
    await fs.rm(pluginDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)
    await fs.rmdir(bindingsRoot).catch(() => undefined)
  }
}

async function ensureBindingsRoot(root: string, bindingsRoot: string): Promise<void> {
  const resolvedRoot = path.resolve(root)
  await fs.mkdir(resolvedRoot, { recursive: true, mode: 0o700 })
  await assertBoundDirectory(resolvedRoot)
  try {
    await fs.mkdir(bindingsRoot, { mode: 0o700 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  await assertBoundDirectory(bindingsRoot)
}

/** Snapshot one verified deployment as a session-only Claude plugin. Plugin
 * namespaces prevent mutable user/project skills or resolved agents from shadowing
 * the bytes authorized for this managed run. */
export async function createRunSkillBinding(options: {
  root: string
  runId: string
  workflowId: string
  skillSlug: string
  skillContent: string
  skillContentHash: string
  agents: ExportedAgentBinding[]
}): Promise<RunSkillBinding> {
  if (!SKILL_SLUG_RE.test(options.skillSlug)) throw new Error('Cannot bind an unsafe skill slug.')
  if (!HASH_RE.test(options.skillContentHash) || hash(options.skillContent) !== options.skillContentHash) {
    throw new Error('The skill changed before it could be bound.')
  }
  if (options.agents.length > MAX_BOUND_AGENTS) throw new Error('The workflow dispatches too many agents to bind safely.')
  for (const agent of options.agents) assertAgentBinding(agent, options.workflowId)

  const id = bindingId(options.workflowId, options.runId, options.skillSlug)
  const pluginName = `cwc-run-${id}`
  const invocationSlug = `${pluginName}:${options.skillSlug}`
  const { bindingsRoot, pluginDir } = bindingPaths(options.root, id)
  const tempDir = path.join(bindingsRoot, `.${id}.${process.pid}.${randomUUID()}.tmp`)
  const manifest = pluginManifest(pluginName)
  const boundSkill = bindSkillContent(options.skillContent, options.workflowId, pluginName, options.agents)
  if (Buffer.byteLength(boundSkill, 'utf-8') > MAX_BOUND_FILE_BYTES) {
    throw new Error('The bound skill exceeds the managed run size limit.')
  }
  const record: BindingRecord = {
    version: BINDING_VERSION,
    runId: options.runId,
    workflowId: options.workflowId,
    skillSlug: options.skillSlug,
    pluginName,
    invocationSlug,
    sourceSkillHash: options.skillContentHash,
    boundSkillHash: hash(boundSkill),
    pluginManifestHash: hash(manifest),
    agents: options.agents.map(agent => ({
      slug: agent.slug,
      scope: agent.scope,
      kind: agent.kind,
      sourceHash: agent.contentHash,
      boundHash: hash(agent.content),
    })),
  }
  const recordContent = `${JSON.stringify(record, null, 2)}\n`
  const authority = { id, hash: hash(recordContent) }
  const cleanup = cleanupFor(options.root, id)

  await ensureBindingsRoot(options.root, bindingsRoot)
  try {
    await fs.mkdir(tempDir, { mode: 0o700 })
    await fs.mkdir(path.join(tempDir, '.claude-plugin'), { mode: 0o700 })
    await fs.mkdir(path.join(tempDir, 'skills', options.skillSlug), { recursive: true, mode: 0o700 })
    if (options.agents.length > 0) await fs.mkdir(path.join(tempDir, 'agents'), { mode: 0o700 })
    await writeSynced(path.join(tempDir, '.claude-plugin', 'plugin.json'), manifest)
    await writeSynced(path.join(tempDir, 'skills', options.skillSlug, 'SKILL.md'), boundSkill)
    for (const agent of options.agents) {
      await writeSynced(path.join(tempDir, 'agents', `${agent.slug}.md`), agent.content)
    }
    await writeSynced(path.join(tempDir, 'binding.json'), recordContent)
    await fs.rename(tempDir, pluginDir)
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }

  return { pluginDir, invocationSlug, authority, cleanup }
}

/** Re-open a paused run's durable plugin only after every authoritative byte is
 * revalidated. Resume never falls back to a newly exported artifact. */
export async function openRunSkillBinding(options: {
  root: string
  runId: string
  workflowId: string
  skillSlug: string
  authority: RunBindingAuthority
}): Promise<RunSkillBinding> {
  const expectedId = bindingId(options.workflowId, options.runId, options.skillSlug)
  if (options.authority.id !== expectedId || !HASH_RE.test(options.authority.hash)) {
    throw new Error('Run binding authority does not match this run.')
  }
  const { pluginDir } = bindingPaths(options.root, expectedId)
  await assertBoundDirectory(pluginDir)
  const recordContent = await readRegularBoundFile(path.join(pluginDir, 'binding.json'))
  if (hash(recordContent) !== options.authority.hash) throw new Error('Run binding authority hash does not match.')
  const record = parseBindingRecord(recordContent)
  const pluginName = `cwc-run-${expectedId}`
  if (record.runId !== options.runId
    || record.workflowId !== options.workflowId
    || record.skillSlug !== options.skillSlug
    || record.pluginName !== pluginName
    || record.invocationSlug !== `${pluginName}:${options.skillSlug}`) {
    throw new Error('Run binding identity does not match this run.')
  }
  await assertBoundDirectory(path.join(pluginDir, '.claude-plugin'))
  await assertBoundDirectory(path.join(pluginDir, 'skills'))
  await assertBoundDirectory(path.join(pluginDir, 'skills', options.skillSlug))
  if (record.agents.length > 0) await assertBoundDirectory(path.join(pluginDir, 'agents'))
  const manifest = await readRegularBoundFile(path.join(pluginDir, '.claude-plugin', 'plugin.json'))
  if (hash(manifest) !== record.pluginManifestHash || manifest !== pluginManifest(pluginName)) {
    throw new Error('Run binding plugin manifest changed.')
  }
  const skill = await readRegularBoundFile(path.join(pluginDir, 'skills', options.skillSlug, 'SKILL.md'))
  if (hash(skill) !== record.boundSkillHash || ownedExportedSkillId(skill) !== options.workflowId) {
    throw new Error('Run binding skill changed.')
  }
  for (const agent of record.agents) {
    const content = await readRegularBoundFile(path.join(pluginDir, 'agents', `${agent.slug}.md`))
    const owner = ownedExportedAgentId(content)
    if (hash(content) !== agent.boundHash
      || (agent.kind === 'bespoke' ? owner !== options.workflowId : owner === options.workflowId)) {
      throw new Error(`Run binding agent ${agent.slug} changed.`)
    }
    let name: unknown
    try { name = matter(content).data.name } catch { throw new Error(`Run binding agent ${agent.slug} has invalid frontmatter.`) }
    if (name !== agent.slug) throw new Error(`Run binding agent ${agent.slug} has a mismatched name.`)
  }
  return {
    pluginDir,
    invocationSlug: record.invocationSlug,
    authority: options.authority,
    cleanup: cleanupFor(options.root, expectedId),
  }
}

export async function cleanupRunSkillBinding(options: {
  root: string
  workflowId: string
  runId: string
  skillSlug: string
  authority: RunBindingAuthority
}): Promise<void> {
  const expectedId = bindingId(options.workflowId, options.runId, options.skillSlug)
  if (options.authority.id !== expectedId) return
  await cleanupFor(options.root, expectedId)()
}
