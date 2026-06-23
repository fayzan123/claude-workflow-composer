import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.ts'

type Latest = Awaited<ReturnType<typeof api.automationScan.latest>>
type Auto = Latest['automations'][number]
type Generation = NonNullable<Latest['generation']>

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/** Animate current displayed value → target over ~600ms with exponential ease-out. Respects reduced motion. */
function useCountUp(target: number): number {
  const [value, setValue] = useState(target)
  const displayed = useRef(target)
  const lastTarget = useRef(target)
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || target === lastTarget.current) {
      displayed.current = target
      lastTarget.current = target
      setValue(target)
      return
    }
    const from = displayed.current
    const start = performance.now()
    const dur = 600
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur)
      const eased = 1 - Math.pow(1 - t, 3) // ease-out cubic, no overshoot
      const next = Math.round(from + (target - from) * eased)
      displayed.current = next
      setValue(next)
      if (t < 1) raf = requestAnimationFrame(tick)
      else lastTarget.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return value
}

/** Top candidates worth teasing on the hero (mirror DetectedAutomations' confidence bar). */
function topCandidates(autos: Auto[], activeGenerationId?: string): Auto[] {
  const active = autos.find(a => a.id === activeGenerationId) ?? autos.find(a => a.status === 'promoting') ?? null
  const high = autos.filter(a => a.confidence >= 0.6 && a.id !== active?.id).slice(0, active ? 2 : 3)
  return active ? [active, ...high] : high
}

export function DetectHero() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<Latest['status']>('idle')
  const [autos, setAutos] = useState<Auto[]>([])
  const [generation, setGeneration] = useState<Generation | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const r = await api.automationScan.latest()
        if (!alive) return
        setStatus(r.status)
        setGeneration(r.generation ?? null)
        setAutos(r.automations.filter(a => a.status !== 'dismissed'))
      } catch { /* dashboard stays usable if the scan API hiccups */ }
    }
    load()
    const id = setInterval(load, 1500)
    return () => { alive = false; clearInterval(id) }
  }, [])

  function go(to: string) {
    // viewTransition wired in Task 5; harmless no-op flag in unsupported browsers.
    navigate(to, { viewTransition: true })
  }

  // Cancel a background generation straight from the hero, so the home screen isn't a
  // dead end during a multi-minute job. The 1.5s poll reconciles; we also refresh now.
  async function cancelGeneration(id: string) {
    setCancelling(true)
    try {
      await api.automationScan.cancelPromote(id)
      const r = await api.automationScan.latest()
      setStatus(r.status)
      setGeneration(r.generation ?? null)
      setAutos(r.automations.filter(a => a.status !== 'dismissed'))
    } catch { /* the poll will reconcile */ }
    setCancelling(false)
  }

  const running = status === 'running'
  const activeGeneration = generation && !generation.workflowId && !generation.error ? generation : null
  const candidates = topCandidates(autos, activeGeneration?.id)
  const generationInProgress = Boolean(activeGeneration)
  const count = Math.max(autos.filter(a => a.confidence >= 0.6).length, candidates.length)
  const noneFound = status === 'done' && candidates.length === 0
  const shownCount = useCountUp(count)

  useEffect(() => {
    if (!activeGeneration) { setElapsed(0); return }
    const started = Date.parse(activeGeneration.startedAt)
    if (!Number.isFinite(started)) return
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000)))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [activeGeneration?.startedAt])

  // Scan-line observers — hoisted above early returns to satisfy Rules of Hooks.
  const heroRef = useRef<HTMLElement>(null)
  const [onScreen, setOnScreen] = useState(true)
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const handler = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [])
  useEffect(() => {
    const el = heroRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { threshold: 0.05 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // Measure hero height so the scan-line sweeps its full height via transform only
  // (avoids `container-type: size`, which collapses a content-sized box to zero).
  useEffect(() => {
    const el = heroRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      el.style.setProperty('--hero-sweep', `${Math.max(0, el.offsetHeight - 2)}px`)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── State: has candidates ──
  if (candidates.length > 0) {
    return (
      <section className="hd-hero" aria-label="Detected automations">
        <span className="hd-hero__eyebrow">History scan</span>
        <h1 className="hd-hero__title">
          We found <span className="hd-hero__count">{shownCount}</span>{' '}
          {count === 1 ? 'thing' : 'things'} you keep doing by hand
        </h1>
        <ul className="hd-hero__candidates" role="list">
          {candidates.map((a, i) => {
            const busy = a.id === activeGeneration?.id || a.status === 'promoting'
            return (
              <li
                key={a.id}
                className={`hd-hero__candidate${busy ? ' hd-hero__candidate--busy' : ''}`}
                style={{ ['--i' as string]: i }}
              >
                <span className="hd-hero__candidate-title">{a.title}</span>
                <span className="hd-hero__candidate-meta">
                  {busy
                    ? `Generating workflow · ${formatElapsed(elapsed)}`
                    : `seen ${a.evidence.count}× · ${a.suggestedTrigger.label || 'manual'}`}
                </span>
                {busy && (
                  <>
                    <div className="hd-hero__candidate-bar" role="progressbar" aria-label="Generating workflow">
                      <div className="hd-hero__candidate-bar-fill" />
                    </div>
                    <div className="hd-hero__candidate-actions">
                      <button type="button" className="hd-hero__candidate-action" onClick={() => go('/detect')}>
                        View
                      </button>
                      <button
                        type="button"
                        className="hd-hero__candidate-action hd-hero__candidate-action--cancel"
                        onClick={() => cancelGeneration(a.id)}
                        disabled={cancelling}
                      >
                        {cancelling ? 'Cancelling…' : 'Cancel'}
                      </button>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
        <div className="hd-hero__actions">
          <button className="hd-hero__cta" type="button" onClick={() => go('/detect')}>
            Review automations
          </button>
          <button
            className="hd-hero__ghost"
            type="button"
            onClick={() => go('/detect?autostart=1')}
            disabled={generationInProgress || running}
            title={generationInProgress ? 'A workflow is already being generated.' : undefined}
          >
            {generationInProgress ? 'Generating...' : 'Scan again'}
          </button>
        </div>
      </section>
    )
  }

  // ── State: scanned, none found ──
  if (noneFound) {
    return (
      <section className="hd-hero" aria-label="Detect automations">
        <span className="hd-hero__eyebrow">History scan</span>
        <h1 className="hd-hero__title hd-hero__title--quiet">No strong patterns yet</h1>
        <p className="hd-hero__subtitle">
          Try again after a few more Claude Code sessions, or build one from scratch below.
        </p>
        <div className="hd-hero__actions">
          <button className="hd-hero__cta" type="button" onClick={() => go('/detect?autostart=1')}>
            Scan again
          </button>
        </div>
      </section>
    )
  }

  // ── State: idle / scanning ──
  return (
    <section
      ref={heroRef}
      className={`hd-hero${onScreen && !hidden ? ' hd-hero--live' : ''}`}
      aria-label="Detect automations"
    >
      <div className="hd-hero__scanlines" aria-hidden="true" />
      <span className="hd-hero__eyebrow">History scan</span>
      <h1 className="hd-hero__title">Find the work you keep repeating in Claude Code</h1>
      <p className="hd-hero__subtitle">
        CWC scans your Claude Code history, spots the tasks you do by hand again and again,
        and turns them into one-click workflows.
      </p>
      <div className="hd-hero__actions">
        <button
          className="hd-hero__cta"
          type="button"
          onClick={() => go('/detect?autostart=1')}
          disabled={running || generationInProgress}
          title={generationInProgress ? 'A workflow is already being generated.' : undefined}
        >
          {generationInProgress ? 'Generating workflow...' : running ? 'Scanning your history...' : 'Scan my history'}
        </button>
      </div>
      {running && (
        <div className="hd-hero__bar" role="progressbar" aria-label="Scanning history">
          <div className="hd-hero__bar-fill" />
        </div>
      )}
    </section>
  )
}
