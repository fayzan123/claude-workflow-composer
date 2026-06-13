import React, { useEffect, useRef, useState } from 'react'
import './HelpModal.css'

type Tab = 'overview' | 'nodes' | 'edges' | 'running'

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
          {(['overview', 'nodes', 'edges', 'running'] as Tab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`help-modal__tab ${tab === t ? 'help-modal__tab--active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'overview' ? 'Overview' : t === 'nodes' ? 'Node Fields' : t === 'edges' ? 'Edge Fields' : 'Running'}
            </button>
          ))}
        </div>

        <div className="help-modal__body">
          {tab === 'overview' && <OverviewTab />}
          {tab === 'nodes' && <NodesTab />}
          {tab === 'edges' && <EdgesTab />}
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
            Agents are Claude Code sub-agents — specialised AI roles you assign to Claude. Each agent has a name, a description of what it does, and optionally a list of skills and tools. When you run a workflow, each agent handles its assigned step using Claude Code under the hood.
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
            Skills are reusable instruction sets — markdown files that tell an agent <em>how</em> to approach a task. A skill might say "always write tests first" or "follow this design system." Attaching a skill to an agent loads those instructions every time that agent runs.
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
          <h3 className="help-section__heading">Exporting a workflow</h3>
          <p className="help-section__body">
            When your workflow is ready, click <strong>Export</strong> in the top bar. This writes a set of <code>.md</code> files — one orchestrator skill and one per agent — that Claude Code can read and execute. See the <strong>Running</strong> tab for how to invoke them.
          </p>
        </div>
      </section>
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
            Clicking <strong>Export</strong> writes a folder of <code>.md</code> files to your chosen output directory:
          </p>
          <ul className="help-section__list">
            <li><strong>orchestrator.md</strong> (or your workflow name) — the skill file the orchestrator reads. It contains the full pipeline as step-by-step prose.</li>
            <li><strong>One <code>.md</code> per agent node</strong> — each agent's skill file: its name, description, tools, skills, and system prompt in frontmatter + body format.</li>
          </ul>
          <p className="help-section__body">
            You can preview the orchestrator file before writing anything — the Export modal's file list shows the exact content that will be written.
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
          <h3 className="help-section__heading">How to run a workflow</h3>
          <p className="help-section__body">
            After exporting, invoke the orchestrator skill from Claude Code:
          </p>
          <pre className="help-section__code">claude --skill path/to/orchestrator.md "your prompt"</pre>
          <p className="help-section__body">
            Claude Code loads the orchestrator skill, reads the pipeline, and begins invoking subagents step by step using the <code>Agent</code> tool.
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
          <h3 className="help-section__heading">What the orchestrator does at runtime</h3>
          <p className="help-section__body">
            The orchestrator itself is a Claude instance that only uses the <code>Agent</code> tool — it never reads, writes, or edits files directly. All real work is delegated to the subagents it spawns.
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
            Your workflow is saved as a <code>.cwc</code> file in <code>~/.cwc/workflows/</code>. This is the source file for the visual editor — it stores all nodes, edges, positions, and settings. The exported <code>.md</code> files are generated from it; you can re-export at any time after making changes.
          </p>
        </div>
      </section>
    </>
  )
}
