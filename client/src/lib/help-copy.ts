// client/src/lib/help-copy.ts

// Short, plain-language definitions for jargon, shown inline via <Term>.
// (HelpModal keeps the longer-form versions; these are the one-line popovers.)
export const TERMS: Record<string, string> = {
  agent: 'A single step in your workflow — one Claude worker with a job, its own tools, and skills.',
  skill: 'A reusable instruction set you attach to a step so it knows how to do a specific task.',
  gate: 'A checkpoint that pauses the run for your approval before it continues.',
  run: 'One execution of your workflow. You can watch it live and see what each step did.',
  export: 'Turns your canvas into real files Claude Code can run — a skill plus an agent file per step.',
  trigger: 'The instruction that tells the orchestrator when to hand off to the next step.',
  cron: 'A schedule written in a compact code (e.g. 0 9 * * 1-5 = weekdays at 9am). The schedule builder writes it for you.',
  webhook: 'A URL that starts your workflow when something sends it a request.',
  arm: 'Turning a trigger on. Because triggers run commands on your machine, we ask you to confirm you trust it first.',
  worktree: 'An isolated copy of your project where a run works, so your real files stay untouched until you approve.',
  slug: 'The filename-safe version of a name (Code Reviewer → code-reviewer), used for the exported files.',
  isolation: 'Where a run does its work — a safe isolated copy (worktree) or directly in your current folder.',
  router: 'A step that picks ONE of several next steps based on its result, instead of running them all.',
  terminal: 'Marks a step as an end of the workflow (complete, escalated, or aborted).',
  reference: 'A step that points to an existing agent file on disk instead of defining a new one.',
  observability: 'Logging that lets CWC show this workflow\'s runs live. Safe to leave on.',
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
  'run.isolation': 'Run in a safe isolated copy (worktree) or directly in this folder.',
  'export.target': 'Where to write the files — just for you, or into a project folder.',
  'export.observability': 'Adds logging so CWC can show this workflow\'s runs live.',
  'trigger.schedule': 'When this runs automatically.',
  'trigger.cwd': 'The folder scheduled runs work in.',
  'trigger.precondition': 'A shell command that must succeed for the run to fire (optional).',
  'trigger.setupCommand': 'A shell command run before the workflow starts (optional).',
}

export function getTerm(name: string): string | null {
  return TERMS[name.trim().toLowerCase()] ?? null
}

export function getControlHint(id: string): string {
  return CONTROL_HINTS[id] ?? ''
}
