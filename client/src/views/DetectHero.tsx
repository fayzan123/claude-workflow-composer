import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.ts'
import { deriveScanUiState, homeScanActionPath, homeScanContent } from '../lib/scan-state.ts'
import { artifactTierLabel, type ArtifactTier } from '../lib/artifact.ts'
import { ArtifactBadge } from '../components/common/ArtifactBadge.tsx'

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

/** Keep the active promotion visible, then preview the strongest current results. */
function topCandidates(autos: Auto[], activeGenerationId: string | undefined, includeLowerConfidence: boolean): Auto[] {
  const active = autos.find(a => a.id === activeGenerationId) ?? autos.find(a => a.status === 'promoting') ?? null
  const remaining = autos
    .filter(a => (includeLowerConfidence || a.confidence >= 0.6) && a.id !== active?.id)
    .slice(0, active ? 2 : 3)
  return active ? [active, ...remaining] : remaining
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

  function runAction(kind: 'view' | 'start') {
    go(homeScanActionPath(kind))
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
  const activeGeneration = generation && !(generation.artifactId ?? generation.workflowId) && !generation.error ? generation : null
  const scanState = deriveScanUiState(status, autos)
  const content = homeScanContent(scanState)
  const candidates = topCandidates(autos, activeGeneration?.id, scanState.kind === 'low-confidence')
  const generationInProgress = Boolean(activeGeneration)
  const count = scanState.kind === 'results' ? scanState.strongCandidateCount : scanState.candidateCount
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

  // State: detected candidates, including lower-confidence results that still need review.
  if (candidates.length > 0 && scanState.kind !== 'error') {
    return (
      <section className="hd-hero" aria-label="Detected automations">
        <span className="hd-hero__eyebrow">History scan</span>
        <h1 className="hd-hero__title">
          {scanState.kind === 'low-confidence' ? (
            <><span className="hd-hero__count">{shownCount}</span> potential {count === 1 ? 'pattern needs' : 'patterns need'} review</>
          ) : (
            <>We found <span className="hd-hero__count">{shownCount}</span>{' '}
              {count === 1 ? 'thing' : 'things'} you keep doing by hand</>
          )}
        </h1>
        {content.description && <p className="hd-hero__subtitle">{content.description}</p>}
        <ul className="hd-hero__candidates" role="list">
          {candidates.map((a, i) => {
            const busy = a.id === activeGeneration?.id || a.status === 'promoting'
            const tier = a.recommendedTier ?? 'workflow'
            const activeTier = a.selectedTier ?? activeGeneration?.tier ?? tier
            return (
              <li
                key={a.id}
                className={`hd-hero__candidate${busy ? ' hd-hero__candidate--busy' : ''}`}
                style={{ ['--i' as string]: i }}
              >
                <span className="hd-hero__candidate-heading">
                  <span className="hd-hero__candidate-title">{a.title}</span>
                  <ArtifactBadge tier={tier as ArtifactTier} />
                </span>
                <span className="hd-hero__candidate-meta">
                  {busy
                    ? `Generating ${artifactTierLabel(activeTier as ArtifactTier).toLowerCase()} · ${formatElapsed(elapsed)}`
                    : `seen ${a.evidence.count}× · ${a.suggestedTrigger.label || 'manual'} · ${Math.round(a.confidence * 100)}% confidence`}
                </span>
                {busy && (
                  <>
                    <div className="hd-hero__candidate-bar" role="progressbar" aria-label={`Generating ${artifactTierLabel(activeTier as ArtifactTier).toLowerCase()}`}>
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
          <button className="hd-hero__cta" type="button" onClick={() => runAction(content.primary.kind)}>
            {content.primary.label}
          </button>
          {content.secondary && (
            <button
              className="hd-hero__ghost"
              type="button"
              onClick={() => runAction(content.secondary!.kind)}
              disabled={generationInProgress || running}
              title={generationInProgress ? 'An artifact is already being generated.' : undefined}
            >
              {generationInProgress ? 'Generating...' : content.secondary.label}
            </button>
          )}
        </div>
      </section>
    )
  }

  // State: a completed or failed scan with no candidates. Reviewing the latest scan
  // and starting a replacement scan are deliberately separate actions.
  if (scanState.kind === 'empty' || scanState.kind === 'error') {
    return (
      <section className="hd-hero" aria-label="Detect automations">
        <span className="hd-hero__eyebrow">History scan</span>
        <h1 className="hd-hero__title hd-hero__title--quiet">{content.title}</h1>
        {content.description && <p className="hd-hero__subtitle">{content.description}</p>}
        <div className="hd-hero__actions">
          <button className="hd-hero__cta" type="button" onClick={() => runAction(content.primary.kind)}>
            {content.primary.label}
          </button>
          {content.secondary && (
            <button className="hd-hero__ghost" type="button" onClick={() => runAction(content.secondary!.kind)}>
              {content.secondary.label}
            </button>
          )}
        </div>
      </section>
    )
  }

  // State: no scan yet, or a scan currently in progress.
  return (
    <section
      ref={heroRef}
      className={`hd-hero${onScreen && !hidden ? ' hd-hero--live' : ''}`}
      aria-label="Detect automations"
    >
      <div className="hd-hero__scanlines" aria-hidden="true" />
      <span className="hd-hero__eyebrow">History scan</span>
      <h1 className="hd-hero__title">{content.title}</h1>
      {content.description && <p className="hd-hero__subtitle">{content.description}</p>}
      <div className="hd-hero__actions">
        <button
          className="hd-hero__cta"
          type="button"
          onClick={() => runAction(content.primary.kind)}
          disabled={generationInProgress}
          title={generationInProgress ? 'An artifact is already being generated.' : undefined}
        >
          {generationInProgress ? 'Generating artifact…' : content.primary.label}
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
