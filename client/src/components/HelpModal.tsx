import React, { useEffect, useRef, useState } from 'react'
import './HelpModal.css'

type Tab = 'overview' | 'tiers' | 'nodes' | 'edges' | 'automations' | 'running'

interface Props {
  onClose: () => void
  initialTab?: Tab
}

export function HelpModal({ onClose, initialTab }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState<Tab>(initialTab ?? 'overview')

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose()
  }

  return (
    <div className="help-overlay" ref={overlayRef} onClick={handleOverlayClick} role="dialog" aria-modal aria-label="Help">
      <div className="help-modal">
        <div className="help-modal__header">
          <h2 className="help-modal__title">How it works</h2>
          <button className="help-modal__close" onClick={onClose} type="button" aria-label="Close help">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="help-modal__tabs" role="tablist">
          {(['overview', 'tiers', 'nodes', 'edges', 'automations', 'running'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`help-modal__tab ${tab === t ? 'help-modal__tab--active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'overview' ? 'Overview' : t === 'tiers' ? 'Tiers' : t === 'nodes' ? 'Node Fields' : t === 'edges' ? 'Edge Fields' : t === 'automations' ? 'Automations' : 'Running'}
            </button>
          ))}
        </div>

        <div className="help-modal__body">
          {tab === 'overview' && <OverviewTab />}
          {tab === 'tiers' && <TiersTab />}
          {tab === 'nodes' && <NodesTab />}
          {tab === 'edges' && <EdgesTab />}
          {tab === 'automations' && <AutomationsTab />}
          {tab === 'running' && <RunningTab />}
        </div>
      </div>
    </div>
  )
}

function OverviewTab() {
  return (
    <>
      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">What are agents?</h3>
          <p className="help-section__body">
            Agents are Claude Code sub-agents — specialised AI roles used by workflow artifacts. Each agent has a name, a job, and optional skills and tools. When you run a workflow, its orchestrator gives each agent the step assigned to it.
          </p>
          <p className="help-section__body">
            Think of them like roles on a team: a <em>Backend Architect</em> handles API design, a <em>Frontend Developer</em> handles UI. You wire them together to form a pipeline.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">What are skills?</h3>
          <p className="help-section__body">
            Skills are reusable Markdown instructions. A plain skill runs directly as one Claude Code command; a workflow agent can also load supporting skills such as "write tests first" or "follow this design system."
          </p>
          <p className="help-section__body">
            Skills live in <code>~/.claude/skills/</code>. You can write your own or grab community-made ones from the <strong>Discover</strong> tab.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M17.5 14v3m0 3h.01M17.5 14a3.5 3.5 0 1 1 0 7" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Building a workflow</h3>
          <p className="help-section__body">
            Drag an agent from the sidebar onto the canvas to add it as a step. Connect agents by dragging from one node's right handle to another node's left handle — this creates a handoff (an edge) between them.
          </p>
          <ul className="help-section__list">
            <li><strong>Add a node:</strong> drag an agent from the sidebar onto the canvas.</li>
            <li><strong>Connect nodes:</strong> drag from right handle → left handle.</li>
            <li><strong>Move nodes:</strong> click and drag any node.</li>
            <li><strong>Edit a node:</strong> click a node to open the Node Panel on the right.</li>
            <li><strong>Edit an edge:</strong> click an arrow to open the Edge Panel on the right.</li>
            <li><strong>Delete:</strong> select a node or edge, then use the panel's Delete button.</li>
          </ul>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h5l2-7 4 14 2-7h5" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">The Home dashboard</h3>
          <p className="help-section__body">
            Home is your control room. It shows saved and deployed artifacts, run activity, paused approval gates, detected automation candidates, and the global pause switch for scheduled runs. Start here to scan history, open existing work, or check what CWC has been doing.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v4" />
            <path d="M12 18v4" />
            <path d="m4.93 4.93 2.83 2.83" />
            <path d="m16.24 16.24 2.83 2.83" />
            <path d="M2 12h4" />
            <path d="M18 12h4" />
            <path d="m4.93 19.07 2.83-2.83" />
            <path d="m16.24 7.76 2.83-2.83" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Generating standalone agents and skills</h3>
          <p className="help-section__body">
            The workflow sidebar can write a reusable agent or supporting skill from a plain-English description. CWC first drafts a spec you can refine, then saves the file to <code>~/.claude/agents/</code> or <code>~/.claude/skills/</code>. This is separate from generating a right-sized artifact from history, and every generated file remains yours to review.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">The Discover tab</h3>
          <p className="help-section__body">
            Open the <strong>Discover</strong> tab in the left sidebar to find community-made agent definitions and skill packs. Browse or clone GitHub repositories, place them in the right folder, and they'll appear in your sidebar automatically.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Exporting an artifact</h3>
          <p className="help-section__body">
            When a skill, loop, or workflow is ready, click <strong>Export</strong> in the top bar. A skill or loop writes one plain <code>SKILL.md</code>; a workflow writes an orchestrator skill plus its bespoke agent files. Preview every write or removal before confirming. See <strong>Running</strong> for invocation details.
          </p>
        </div>
      </section>
    </>
  )
}

function TiersTab() {
  return (
    <>
      <p className="help-tab__intro">
        CWC always recommends the <strong>smallest artifact</strong> that captures a repetition, and each
        Detect card says why its tier was chosen. Bigger is not better: a plain skill you actually run
        beats a workflow you avoid. You can override the tier before generating, and move between tiers later.
      </p>

      <Field term="Rule">
        A standing instruction, not a runnable artifact. Recommended when a repetition is something you keep
        <em> telling</em> Claude rather than something Claude <em>does</em> with tools — or when your history shows
        you already run an installed skill or slash command for it (then the rule just points at that command).
        <ul className="help-field__list">
          <li><strong>What it writes:</strong> one instruction inside paired <code>&lt;!-- cwc:rule --&gt;</code> markers in your user <code>CLAUDE.md</code> or an evidence project's <code>AGENTS.md</code> — only after you pick the target and confirm.</li>
          <li><strong>How it works:</strong> Claude Code reads the guidance file at session start; there is nothing to invoke.</li>
          <li><strong>Undo:</strong> remove it from the Detect card any time — CWC deletes exactly its own block, byte-for-byte.</li>
        </ul>
      </Field>

      <Field term="Skill">
        One plain Claude Code skill: a <code>SKILL.md</code> holding a focused procedure. Recommended for the
        most common case — a linear, single-role procedure you repeat (start the dev servers, write the handoff
        packet, commit and push).
        <ul className="help-field__list">
          <li><strong>What it writes:</strong> <code>.claude/skills/&lt;slug&gt;/SKILL.md</code> — frontmatter (name, description) plus a checklist body grounded in your observed steps. No agent files, no orchestrator.</li>
          <li><strong>How it runs:</strong> type <code>/&lt;slug&gt;</code> in any Claude Code session, or use Test Run in CWC for a managed, optionally isolated run.</li>
          <li><strong>Safety default:</strong> exported skills carry <code>disable-model-invocation: true</code> — Claude won't invoke them on its own unless you opt in.</li>
          <li><strong>Growing up:</strong> "Open as workflow" graduates a skill into a multi-agent canvas when it outgrows one role; the reverse demotion exists for single-node workflows.</li>
        </ul>
      </Field>

      <Field term="Loop">
        A skill plus recurrence and a verifiable stop condition — the same <em>trigger / action / stop</em> shape
        as Claude Code's own <code>/loop</code> command. Recommended when your history shows the work recurring on a
        schedule, or a verify-fix-retry cycle (run the check, fix, run it again).
        <ul className="help-field__list">
          <li><strong>Trigger:</strong> a cron schedule generated <em>disarmed</em> — nothing fires until you arm it in Automate.</li>
          <li><strong>Action:</strong> the same plain <code>SKILL.md</code> a skill exports.</li>
          <li><strong>Stop condition:</strong> the body ends with the verification command actually observed in your history — "stop when it passes, or stop and report after two rounds with no progress." The stop is objective (a command's exit), never the agent's own judgment.</li>
          <li><strong>Two ways to run it:</strong> natively via <code>/loop 30m /&lt;slug&gt;</code> in Claude Code, or armed in CWC for worktree isolation, run history, daily caps, and approval gates.</li>
        </ul>
      </Field>

      <Field term="Workflow">
        The multi-agent canvas: an orchestrator skill plus one agent file per bespoke node. Recommended only when
        the evidence demands it — genuinely parallel independent work, or an <strong>irreversible external action</strong>
        (publish to npm, deploy, outward communication) that needs a read-only preflight and a human approval gate
        before it happens.
        <ul className="help-field__list">
          <li><strong>What it writes:</strong> <code>.claude/skills/cwc-&lt;slug&gt;/SKILL.md</code> (orchestrator prose from the canvas) plus <code>.claude/agents/*.md</code> for each bespoke node.</li>
          <li><strong>How it runs:</strong> <code>/cwc-&lt;slug&gt;</code>; the orchestrator delegates each canvas step to sub-agents and checks completion criteria between handoffs.</li>
          <li><strong>Gates:</strong> gate nodes pause a managed run, commit work-in-progress, and show you the diff for approve/reject before anything irreversible proceeds.</li>
          <li><strong>Note:</strong> ordinary commit/push work does <em>not</em> force this tier — only hard external actions do.</li>
        </ul>
      </Field>
    </>
  )
}

function Field({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="help-field">
      <div className="help-field__term">{term}</div>
      <div className="help-field__def">{children}</div>
    </div>
  )
}

function NodesTab() {
  return (
    <>
      <p className="help-tab__intro">
        Click any node on the canvas to open the Node Panel. Here's what each field does.
      </p>

      <Field term="Name">
        The agent's display name. It also determines the exported filename — a node named <em>Code Reviewer</em> exports as <code>code-reviewer.md</code>. Keep names short and role-specific.
      </Field>

      <Field term="Description">
        A short summary of what this agent does. It appears on the canvas card and becomes the agent file's description frontmatter. Be specific — this is what the orchestrator reads to understand the agent's purpose.
      </Field>

      <Field term="Model">
        Which Claude model runs this agent. Leave as <em>Default</em> to inherit the project default. Override here when one step genuinely needs a more capable (or faster/cheaper) model than the rest of the workflow.
      </Field>

      <Field term="Completion Criteria">
        The condition the agent must meet before the workflow moves on. The orchestrator checks this after the agent returns. Example: <em>"The PR description is written and the branch is pushed."</em> Be specific — vague criteria produce vague handoffs.
      </Field>

      <Field term="Start Trigger">
        Only shown on entry nodes (nodes with no incoming edges). This is the prompt or condition that kicks off the entire workflow. Example: <em>"A new GitHub issue has been filed and triaged."</em>
      </Field>

      <Field term="Dispatch Mode">
        Controls what happens when a node has more than one outgoing edge.
        <ul className="help-field__list">
          <li><strong>Parallel fan-out (default)</strong> — all outgoing edges fire at the same time. Use when the downstream work is independent and can run concurrently.</li>
          <li><strong>Conditional branch (Router)</strong> — exactly one outgoing edge fires, chosen based on the node's result. The orchestrator reads each edge's Trigger text as a condition. Use for if/else logic: <em>"if tests pass → deploy"</em> vs <em>"if tests fail → fix"</em>.</li>
        </ul>
        Router nodes show an amber <strong>⬦ Router</strong> chip on the canvas card and their edges render as dashed lines.
      </Field>

      <Field term="Tools">
        The Claude Code tools this agent is allowed to use. Only check what the agent actually needs — <code>Read</code> and <code>Write</code> for file work, <code>Bash</code> for shell commands, <code>Agent</code> to spawn further sub-agents, etc. Narrower tool sets produce more focused agents.
      </Field>

      <Field term="Skills">
        Instruction sets loaded into this agent every time it runs. Drag a skill from the Skills tab in the sidebar onto the node, or type a skill name in the "Add skill" field. Each skill appears as a badge on the canvas card.
      </Field>

      <Field term="Gate node">
        A gate is a human checkpoint. When a run reaches it, CWC commits the work-in-progress branch, shows you the diff in the Run panel, and waits for you to approve or reject before continuing.
      </Field>

      <Field term="Terminal Type">
        Marks this node as a workflow endpoint. Set this on any node that should end the run:
        <ul className="help-field__list">
          <li><strong>Complete</strong> — workflow finished successfully.</li>
          <li><strong>Escalated</strong> — workflow needs human review before continuing.</li>
          <li><strong>Aborted</strong> — workflow failed and cannot continue.</li>
        </ul>
        A node can be both a terminal endpoint and have outgoing edges (for escalation paths, for example).
      </Field>

      <Field term="System Prompt">
        Extra instructions prepended to this agent's context on every invocation — in addition to its description and skills. Use sparingly for constraints that don't belong in a reusable skill: project-specific rules, tone requirements, things the agent must never do.
      </Field>

      <Field term="Ref badge">
        A node marked <strong>Ref</strong> references an existing agent file on disk rather than defining a new one inline. Its name and description come from that file and are read-only here. You can still attach skills and override the model for this workflow.
      </Field>
    </>
  )
}

function EdgesTab() {
  return (
    <>
      <p className="help-tab__intro">
        Click any arrow on the canvas to open the Edge Panel. Edges define the handoffs between agents.
      </p>

      <Field term="Source / Target">
        The two nodes this edge connects. Source is where control comes from; Target is where it goes next. Set Target to <em>— Terminal —</em> to mark this edge as a workflow endpoint (rather than handing off to another agent).
      </Field>

      <Field term="Trigger">
        The most important field. This text becomes a step in the exported orchestrator — it's the literal instruction the orchestrator follows when this edge fires.
        <ul className="help-field__list">
          <li>For a <strong>regular edge</strong>: describe the handoff. Example: <em>"Pass the diff to the Reviewer and ask for a line-by-line review."</em></li>
          <li>For a <strong>conditional branch</strong> (when the source node is a Router): write the condition. Example: <em>"tests pass"</em> or <em>"tests fail with more than 3 errors"</em>. The orchestrator picks the branch whose trigger matches the result.</li>
        </ul>
        A blank trigger is valid but produces generic prose — always fill this in for clarity.
      </Field>

      <Field term="Label">
        An optional short display label shown on the arrow in the canvas. Useful when triggers are long — you can put a short summary here (<em>"pass"</em>, <em>"fail"</em>) for the visual and keep the full instruction in Trigger.
      </Field>

      <Field term="Terminal Type">
        Only visible when Target is set to <em>— Terminal —</em>. Classifies how this endpoint ends the workflow: <strong>Complete</strong>, <strong>Escalated</strong>, or <strong>Aborted</strong>.
      </Field>

      <Field term="Context / Artifacts">
        Data the orchestrator should pass forward to the next agent when this edge fires. Add one artifact per piece of data. Each artifact has:
        <ul className="help-field__list">
          <li><strong>Name</strong> — a label for the data, e.g. <em>test report</em>.</li>
          <li><strong>Type</strong> — <code>text</code> (a string), <code>json</code> (structured data), or <code>file</code> (a path on disk).</li>
          <li><strong>Path</strong> — (file type only) the file path to pass, e.g. <code>output/results.json</code>.</li>
        </ul>
        This is instructional — it tells the orchestrator what to mention in the next subagent's prompt. It does not automatically copy or move files; the agents themselves must read or write those paths.
      </Field>
    </>
  )
}

function AutomationsTab() {
  return (
    <>
      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
            <path d="M8 11h6" />
            <path d="M11 8v6" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Detecting automation ideas</h3>
          <p className="help-section__body">
            <strong>Detect automations</strong> reads local Claude Code transcripts, groups repeated work, and recommends the smallest useful result: Rule, Skill, Loop, or Workflow.
          </p>
          <ul className="help-section__list">
            <li><strong>Model choice:</strong> Haiku is fastest, Sonnet is the default balance, and Opus is best for messy histories.</li>
            <li><strong>Evidence:</strong> each candidate shows sightings, confidence, observed steps, a suggested trigger, and its recommended tier.</li>
            <li><strong>Safety:</strong> risky external actions are recommended as workflows so you can add approval gates.</li>
            <li><strong>Scan log:</strong> the right panel shows what the scan is doing so a long analysis does not feel stuck.</li>
          </ul>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Choosing the right-sized result</h3>
          <p className="help-section__body">
            Open a candidate to review CWC's recommendation or choose another tier. A <strong>Rule</strong> adds an owned, removable instruction to your user <code>CLAUDE.md</code> or an evidence project's <code>AGENTS.md</code> only after you confirm the target. A <strong>Skill</strong> is one direct procedure; a <strong>Loop</strong> adds recurrence or observed verification; a <strong>Workflow</strong> uses the multi-agent canvas.
          </p>
          <p className="help-section__body">
            Skills, loops, and workflows are saved as <code>.cwc</code> artifacts in <code>~/.cwc/workflows/</code> and opened for review. The recommendation is never a silent escalation: the tier shown in the confirmation is the tier CWC generates.
          </p>
          <p className="help-section__body">
            Generation can take a little while. You can cancel it, leave the page, or retry a failed or cancelled candidate. CWC runs one scan or generation job at a time so jobs cannot overwrite each other's state.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Cron schedules</h3>
          <p className="help-section__body">
            A cron schedule is a compact way to say when an artifact should run, like <code>0 9 * * 1-5</code> for weekdays at 9:00. The schedule builder writes common schedules for you; use custom cron only when you need a pattern the builder does not cover.
          </p>
          <ul className="help-section__list">
            <li><strong>Next run</strong> shows when the schedule will fire next.</li>
            <li><strong>Catch up</strong> can run missed cron jobs after your computer was asleep.</li>
            <li><strong>Max runs per day</strong> prevents a schedule from firing too often.</li>
          </ul>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
            <path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Webhooks</h3>
          <p className="help-section__body">
            A webhook gives a runnable artifact a local URL. Anything that can send an HTTP <code>POST</code> to that URL can start it while CWC is running on this computer. Use webhooks for events from scripts, local tools, or services that can reach your machine.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Arming, safety, and where runs happen</h3>
          <p className="help-section__body">
            Scheduled and webhook automations can run commands on your machine, so CWC separates saving a trigger from <strong>arming</strong> it. Draft and generated loop triggers do nothing until you confirm that you trust the artifact and turn them on.
          </p>
          <ul className="help-section__list">
            <li><strong>Working directory</strong> is the project folder where the run starts.</li>
            <li><strong>Additional target repos</strong> let one trigger start separate runs in several repositories.</li>
            <li><strong>Worktree isolation</strong> creates an isolated branch for the run; <strong>in-place</strong> works directly in the selected folder.</li>
            <li><strong>Precondition</strong> is a shell command that must succeed before the run starts.</li>
            <li><strong>Setup command</strong> runs before Claude starts and fails the run if it exits non-zero.</li>
          </ul>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">Run history, gates, and global pause</h3>
          <p className="help-section__body">
            The Runs view shows live and recent runs for skills, loops, and workflows, including runs started by schedules, webhooks, Test Run, or Claude Code. Workflow gate nodes pause a managed run for approval and put its diff in your inbox. The Home dashboard's global pause suspends scheduled automations without deleting or disarming them.
          </p>
          <p className="help-section__body">
            Notifications can alert you when a run finishes or reaches a gate. On macOS, CWC can show local banners; you can also send events to a webhook URL.
          </p>
        </div>
      </section>
    </>
  )
}

function RunningTab() {
  return (
    <>
      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">What Export produces</h3>
          <p className="help-section__body">
            Clicking <strong>Export</strong> writes Claude Code files to your chosen output directory:
          </p>
          <ul className="help-section__list">
            <li><strong>Skill or loop</strong> — one direct skill at <code>.claude/skills/&lt;skill-slug&gt;/SKILL.md</code>, with no agent files or <code>cwc-</code> prefix.</li>
            <li><strong>Workflow</strong> — an orchestrator at <code>.claude/skills/cwc-&lt;workflow-slug&gt;/SKILL.md</code> plus one agent file per bespoke node.</li>
            <li><strong>Reference workflow nodes</strong> — no agent file is written. They continue to point to an existing agent on disk.</li>
          </ul>
          <p className="help-section__body">
            The Export preview shows the exact files CWC will write or remove before anything changes. CWC only replaces or removes files carrying this artifact's ownership marker.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">How to run an artifact</h3>
          <p className="help-section__body">
            After exporting, invoke the artifact from Claude Code with its slash command:
          </p>
          <pre className="help-section__code">/&lt;skill-slug&gt;{`\n`}/cwc-&lt;workflow-slug&gt;</pre>
          <p className="help-section__body">
            A skill or loop follows its instructions directly. A workflow loads its orchestrator and delegates canvas steps to sub-agents with the <code>Agent</code> tool.
          </p>
          <p className="help-section__body">
            From CWC, use <strong>Test Run</strong> to run any exported skill, loop, or workflow headlessly. Choose the working directory and whether to use worktree isolation or run in-place.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">How a workflow orchestrator runs</h3>
          <p className="help-section__body">
            This section applies only to workflow artifacts. The orchestrator is a Claude instance that uses the <code>Agent</code> tool rather than reading, writing, or editing files itself. It delegates the real work to the sub-agents it starts.
          </p>
          <p className="help-section__body">
            After each subagent returns, the orchestrator checks its response against that node's Completion Criteria. If a subagent signals <code>blocked</code> or <code>escalation_needed</code>, the orchestrator stops immediately and surfaces the issue to you rather than trying to work around it.
          </p>
          <p className="help-section__body">
            When all steps finish, the orchestrator presents a summary: which agents ran, what each produced, and any escalations or skipped branches.
          </p>
        </div>
      </section>

      <section className="help-section">
        <div className="help-section__icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </div>
        <div>
          <h3 className="help-section__heading">The .cwc file</h3>
          <p className="help-section__body">
            Every runnable CWC artifact is saved as a versioned <code>.cwc</code> file in <code>~/.cwc/workflows/</code>. Skills and loops use the focused instruction editor; workflows store the canvas graph, node positions, and handoffs. Triggers and run settings live in the same source file, and you can re-export after any change. Rule suggestions are different: they live in the guidance file you explicitly chose, not in a <code>.cwc</code> file.
          </p>
        </div>
      </section>
    </>
  )
}
