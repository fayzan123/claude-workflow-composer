# Automation-Native Generation — Rearchitecture TODO

> Captured 2026-06-22. This is the to-do/concern list to brainstorm and build against.
> A prior attempt at these changes was **reverted** because it broke things, so this
> round must be incremental, test-backed, and dogfooded against real flows.

## North Star

Scan Claude history → find **durable, repeated** automation opportunities → generate
**useful** workflows **quickly** → let the user **inspect / edit / run** them safely.

Everything below serves that loop. When a decision is ambiguous, optimize for: fast,
trustworthy generation of high-quality workflows grounded in what the user actually did.

---

## 1. Generation architecture — Claude infers, CWC compiles (P0, core)

The root problem: asking Claude to emit full workflow JSON is **too slow, too expensive,
and times out**, sometimes leaving the user with *no* usable workflow.

- [ ] Split generation: Claude identifies **intent + structure** (the repeated task,
      observed steps, real user context, candidate phases); **CWC deterministically
      compiles** that into the `.cwc` workflow. (Open to a better split — brainstorm.)
- [ ] Generated workflows must stay **high quality**, not merely faster to produce.
- [ ] Generated workflows must reflect the **real repeated task found in history** —
      observed steps and the user's actual context, not a generic template.
- [ ] **Deterministic fallback**: if Claude fails, times out, returns invalid JSON, or
      picks invalid reuse references, still produce a **valid** workflow.
- [ ] Decouple generation from the canvas: the manual canvas **stays available**, but
      generated automations must **not depend on the canvas** as the core generation
      mechanism.

## 2. Reuse validation — skills & agents as first-class, but verified (P0)

- [ ] Existing user **skills and agents remain first-class reuse candidates**.
- [ ] Reuse must be **validated** — never attach a skill/agent just because names overlap.
- [ ] A broad/unrelated skill must **not collapse a complex automation into a useless
      one-node workflow**.

## 3. Risk gates & triggers (P0)

- [ ] High-risk actions get **approval gates before**: deploy, publish, push, delete,
      production mutation, external messaging, billing, or similar side effects.
- [ ] **Precise gate placement**: gate the risky publish/deploy step, but do **not** treat
      harmless verification (e.g. a "production build") as a production mutation.
- [ ] Triggers inferred from history are **preserved but disabled** until the user
      explicitly enables them.

## 4. Compiler quality & archetypes (P0)

The law-firm demo exposed this; fixes must **generalize beyond** that one automation.

- [ ] Better **archetype structure** in the compiler.
- [ ] Stricter reuse validation (ties to §2) and proper risky-action gates (ties to §3).
- [ ] Release/publish workflows (e.g. npm) need proper phases:
      **verification → preparation → approval → publish**.
- [ ] Ensure other automation shapes (not just law-firm) get good deterministic structures.

## 5. Server-side persisted generation state (P0)

- [ ] Workflow generation state lives **server-side**, not only in React component state.
- [ ] State includes: **current step, elapsed time, progress indication, cancel,
      terminal status**.
- [ ] Elapsed timer **survives navigation** — computed from a persisted `startedAt`.
- [ ] **Promotion endpoint returns quickly** instead of holding a long request open.
- [ ] Detect page relies on **persisted scan/promotion state** rather than awaiting
      long-running requests.

## 6. Scan/generation lifecycle & concurrency (P0)

- [ ] Scan execution is **independent of UI route lifecycle**.
- [ ] Starting a scan from Home and navigating to Detect must **not cancel, interrupt,
      or destabilize** the scan.
- [ ] Cannot **rescan history while generation is active**.
- [ ] Cannot start **conflicting scan/generation actions** simultaneously.
- [ ] Scan logs must **not depend on a fragile live stream** that can affect the job.
- [ ] A **disconnected log viewer can never fail or cancel** the server scan.

## 7. Detect — single source of truth (P1)

- [ ] One **persisted** source of truth for: scan status, logs, candidates, promotion state.
- [ ] Leaner Detect state model built on that source of truth.

## 8. Home / generation visibility UX (P1)

- [ ] Home **shows active workflow generation** instead of hiding it on Detect.
- [ ] Home shows **which automation is currently being generated**.
- [ ] Home has a **reliable way back to Detect/log page** while a scan runs.
- [ ] Home hero **avoids ambiguous generated-workflow shortcuts** when multiple workflows
      may exist.
- [ ] Home hero **prioritizes reviewing detected automations** over jumping into one
      generated workflow.

## 9. Testing & dogfooding (P1)

- [ ] Stronger tests around: compiler quality, server lifecycle, persisted state,
      cancellation, navigation.
- [ ] Dogfood **real user flows**, not just unit-level correctness.

---

## Open questions for brainstorm

- What exactly does Claude emit in the new split (intent schema? phase list + step
  evidence?) and what does the deterministic compiler own end-to-end?
- How is reuse "validated" — semantic match, capability check, confirmation step?
- Where does the persisted generation/scan state live (reuse `~/.cwc/` JSON like
  automation-state, a runs-style JSONL, or something new)?
- Sequencing so we don't repeat the reverted big-bang: which slice ships first behind
  what safety net?
