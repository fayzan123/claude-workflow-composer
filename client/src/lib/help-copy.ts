// client/src/lib/help-copy.ts

// Short, plain-language definitions for jargon, shown inline via <Term>.
// (HelpModal keeps the longer-form versions; these are the one-line popovers.)
// Note: many TERMS are not yet referenced — they are scaffolding for Phase 2 (jargon decoding across more surfaces). Do not prune.
export const TERMS: Record<string, string> = {
  artifact: 'A saved CWC automation that Claude Code can run: a skill, loop, or multi-agent workflow.',
  rule: 'An owned instruction CWC adds to CLAUDE.md or AGENTS.md only after you choose the target.',
  agent: 'One Claude worker in a workflow, with a specific job, tools, and optional skills.',
  skill: 'Reusable Markdown instructions Claude can run directly or load into a workflow agent.',
  loop: 'A skill with a schedule or observed verification cycle that CWC can run and monitor.',
  workflow: 'A canvas of specialised agents and handoffs for work that needs multiple roles or approval gates.',
  gate: 'A checkpoint that pauses the run for your approval before it continues.',
  run: 'One execution of a skill, loop, or workflow. You can watch managed runs live in CWC.',
  export: 'Writes the owned Claude Code files for an artifact after showing you an exact preview.',
  trigger: 'Either a workflow handoff instruction or an automation schedule/webhook, depending on where it appears.',
  cron: 'A schedule written in a compact code (e.g. 0 9 * * 1-5 = weekdays at 9am). The schedule builder writes it for you.',
  webhook: 'A local URL that starts a runnable artifact when it receives an HTTP POST.',
  arm: 'Turning a trigger on. Because triggers run commands on your machine, we ask you to confirm you trust it first.',
  worktree: 'An isolated copy of your project where a run works, so your real files stay untouched until you approve.',
  slug: 'The filename-safe version of a name (Code Reviewer → code-reviewer), used for the exported files.',
  isolation: 'Where a run does its work — a safe isolated copy (worktree) or directly in your current folder.',
  router: 'A step that picks ONE of several next steps based on its result, instead of running them all.',
  terminal: 'Marks a step as an end of the workflow (complete, escalated, or aborted).',
  reference: 'A step that points to an existing agent file on disk instead of defining a new one.',
  observability: 'Logging that lets CWC show this artifact\'s runs live. Safe to leave on.',
  automation: 'A saved schedule or webhook that can start a runnable artifact for you.',
  detect: 'Scans local Claude Code history and recommends a Rule, Skill, Loop, or Workflow for repeated work.',
  candidate: 'A repeated-work pattern CWC found in your history and thinks may be worth automating.',
  precondition: 'A shell command that must succeed before an automation is allowed to start.',
  'setup command': 'A shell command CWC runs after the run starts, before Claude begins the skill or workflow.',
  'global pause': 'A dashboard switch that suspends scheduled automations without deleting or disarming them.',
  notification: 'A local banner or webhook message CWC sends when runs finish or need approval.',
  'test run': 'A one-off managed run for checking an exported skill, loop, or workflow.',
  'run history': 'Past artifact runs with status, duration, logs, costs, and any approval pauses.',
}

// One-line "what is this and why touch it" hints, shown under a control via <FieldHint>.
export const CONTROL_HINTS: Record<string, string> = {
  'node.name': 'Names the step and its exported filename. Keep it short and role-specific.',
  'node.description': 'What this step does — the orchestrator reads this to understand its job.',
  'node.model': 'Which Claude model runs this step. Leave default unless one step needs more (or less) power.',
  'node.completionCriteria': 'What must be true before the workflow moves past this step.',
  'node.startTrigger': 'What kicks the whole workflow off (only on the first step).',
  'node.dispatchMode': 'When this step has multiple next steps: run them all, or pick one.',
  'node.tools': 'Which Claude Code tools this step may use. Check only what it needs.',
  'node.skills': 'Instruction sets loaded into this step every time it runs.',
  'node.terminalType': 'Mark this step as an end of the workflow.',
  'node.systemPrompt': 'Extra always-on instructions for this step. Use sparingly.',
  'edge.trigger': 'The handoff instruction — what the orchestrator does when this arrow fires.',
  'edge.label': 'Optional short label shown on the arrow. Handy when the trigger is long.',
  'edge.context': 'Tells the next step what to expect — it doesn\'t move files.',
  'run.cwd': 'The folder this run works in.',
  'run.isolation': 'Run in a safe isolated copy (a worktree, so your current checkout is untouched) or directly in this folder.',
  'export.target': 'Where to write the files — just for you, or into a project folder.',
  'export.observability': 'Adds logging so CWC can show this artifact\'s runs live.',
  'export.modelInvocation': 'Lets Claude discover and invoke this exported skill on its own. Off keeps invocation explicit unless you start a CWC test run.',
  'trigger.schedule': 'When this runs automatically. Use the builder unless you need custom cron.',
  'trigger.cwd': 'The folder this scheduled or webhook run starts in.',
  'trigger.precondition': 'A shell command that must succeed before CWC starts a run.',
  'trigger.setupCommand': 'A shell command CWC runs after the run starts, before Claude begins.',
}

export function getTerm(name: string): string | null {
  return TERMS[name.trim().toLowerCase()] ?? null
}

export function getControlHint(id: string): string {
  return CONTROL_HINTS[id] ?? ''
}
