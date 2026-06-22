import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api.ts'

type Latest = Awaited<ReturnType<typeof api.automationScan.latest>>
type Auto = Latest['automations'][number]

/** Animate 0 → target over ~600ms with exponential ease-out. Respects reduced motion. */
function useCountUp(target: number): number {
  const [value, setValue] = useState(target)
  const prev = useRef(target)
  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || target === prev.current) { setValue(target); prev.current = target; return }
    const from = 0
    const start = performance.now()
    const dur = 600
    let raf = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur)
      const eased = 1 - Math.pow(1 - t, 3) // ease-out cubic, no overshoot
      setValue(Math.round(from + (target - from) * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
      else prev.current = target
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target])
  return value
}

/** Top candidates worth teasing on the hero (mirror DetectedAutomations' confidence bar). */
function topCandidates(autos: Auto[]): Auto[] {
  const active = autos.find(a => a.status === 'promoting') ?? null
  const high = autos.filter(a => a.confidence >= 0.6 && a.id !== active?.id).slice(0, active ? 2 : 3)
  return active ? [active, ...high] : high
}

export function DetectHero() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<Latest['status']>('idle')
  const [autos, setAutos] = useState<Auto[]>([])

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const r = await api.automationScan.latest()
        if (!alive) return
        setStatus(r.status)
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

  const running = status === 'running'
  const candidates = topCandidates(autos)
  const count = autos.filter(a => a.confidence >= 0.6).length
  const noneFound = status === 'done' && candidates.length === 0
  const shownCount = useCountUp(count)

  // ── State: has candidates ──
  if (candidates.length > 0) {
    return (
      <section className="hd-hero hd-hero--results" aria-label="Detected automations">
        <span className="hd-hero__eyebrow">History scan</span>
        <h1 className="hd-hero__title">
          We found <span className="hd-hero__count" aria-live="polite">{shownCount}</span>{' '}
          {count === 1 ? 'thing' : 'things'} you keep doing by hand
        </h1>
        <ul className="hd-hero__candidates" role="list">
          {candidates.map((a, i) => (
            <li key={a.id} className="hd-hero__candidate" style={{ ['--i' as string]: i }}>
              <span className="hd-hero__candidate-title">{a.title}</span>
              <span className="hd-hero__candidate-meta">
                {a.status === 'promoting'
                  ? 'Generating workflow…'
                  : `seen ${a.evidence.count}× · ${a.suggestedTrigger.label || 'manual'}`}
              </span>
            </li>
          ))}
        </ul>
        <div className="hd-hero__actions">
          <button className="hd-hero__cta" type="button" onClick={() => go('/detect')}>
            Review automations
          </button>
          <button className="hd-hero__ghost" type="button" onClick={() => go('/detect?autostart=1')}>
            Scan again
          </button>
        </div>
      </section>
    )
  }

  // ── State: scanned, none found ──
  if (noneFound) {
    return (
      <section className="hd-hero hd-hero--quiet" aria-label="Detect automations">
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
    <section className="hd-hero" aria-label="Detect automations">
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
          disabled={running}
        >
          {running ? 'Scanning your history…' : 'Scan my history'}
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
