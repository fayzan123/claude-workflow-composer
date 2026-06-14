# Design System — Claude Workflow Composer (CWC)

> Read this before any visual or UI decision. All fonts, colors, spacing, motion, and the
> canvas/node visual language are defined here. Do not deviate without explicit approval.

## Product Context
- **What this is:** A visual builder for multi-agent Claude Code workflows — drag agent/skill/gate nodes on a canvas, connect them, export to runnable skills, run + monitor them.
- **Who it's for:** Developers and technically-curious builders, including non-experts. Must feel credible to power users without intimidating newcomers.
- **Space/peers:** Workflow/automation builders — n8n, Zapier, Make, plus dev-tool craft benchmarks (Linear, Vercel).
- **Project type:** Canvas-centric web app (React + React Flow) with dashboard, build, runs, and automate surfaces.

## Aesthetic Direction
- **Direction:** "Precise, warm, and alive" — modern dev-tool craft (Linear/Vercel-grade restraint) softened by a warm-neutral palette and a friendly signature accent. The middle path between n8n (dark/technical) and Zapier (bubbly/consumer).
- **Decoration level:** intentional — dotted canvas grid, depth via shadow (never gradients), a single confident accent. No purple gradients, no icon-in-colored-circle grids, no centered-everything.
- **Mood:** confident, calm, legible at a glance. The product should feel like a precise instrument that's still inviting. **The canvas and node language are the brand** — that's where CWC stops looking generic.
- **Theme:** light and dark are both first-class; **light is the default** first impression.

## Typography
Drop the current Spline Sans / Barlow (forgettable). New stack:
- **Display/Hero:** **General Sans** (Fontshare) — characterful geometric grotesk; gives identity without novelty. Used for big headings, empty-state headlines, brand moments.
- **UI / Body:** **Geist Sans** (Vercel) — crisp at small sizes, dev-tool credible, supports `tabular-nums`. Replaces Spline Sans everywhere in app chrome and panels.
- **Data / Tables / metrics:** Geist Sans with `font-variant-numeric: tabular-nums` (run costs, durations, counts).
- **Mono (technical signal):** **JetBrains Mono** (keep) — used deliberately for the *real* technical bits: slugs, cron expressions, webhook URLs, file paths, code, event identifiers. Mono = "this is real code."
- **Loading:** General Sans via Fontshare CDN; Geist via Google Fonts (or self-host `geist` npm). Subset to latin; `font-display: swap`.
- **Scale (rem):** xs .6875 · sm .75 · base .875 · md 1 · lg 1.125 · xl 1.25 · 2xl 1.5 · 3xl 1.75 · 4xl 2.25 (add 4xl for hero). Body default .875rem (dense dev-tool). Line-height 1.5 body, 1.15 display.

## Color
OKLCH (matches existing pipeline). **Warm-neutral surfaces + cool teal accent** — the warm/cool tension makes the accent pop and removes the cold-gray "AI slop" feel.

**Signature accent — teal (hue ~195):**
- `--color-primary` (actions, brand): `oklch(0.56 0.12 195)` — deep enough for white button text.
- `--color-primary-hover`: `oklch(0.49 0.12 195)`
- `--color-accent-bright` (links, edge-flow, glow on dark): `oklch(0.72 0.13 195)`
- `--color-primary-light`: `oklch(0.93 0.04 195)` · `--color-primary-lighter`: `oklch(0.97 0.02 195)`
- `--color-primary-ring`: `oklch(0.56 0.12 195 / 0.30)` (focus/selection)

**Warm neutrals (light, hue ~90, very low chroma):**
- `--color-surface`: `oklch(0.99 0.004 90)` (warm off-white, not pure #fff)
- `--color-surface-secondary`: `oklch(0.975 0.005 90)` · `--color-surface-hover`: `oklch(0.965 0.006 90)`
- `--color-border`: `oklch(0.90 0.006 90)` · `--color-border-hover`: `oklch(0.84 0.008 90)`
- `--color-text`: `oklch(0.20 0.01 90)` (warm near-black) · `--color-text-secondary`: `oklch(0.45 0.012 90)` · `--color-text-tertiary`: `oklch(0.60 0.012 90)`
- `--color-text-inverse`: `oklch(0.99 0.004 90)`

**Semantic (keep current hues, they're good):** success `oklch(0.62 0.15 160)` · warning `oklch(0.72 0.16 85)` · error `oklch(0.55 0.20 30)` (+ light/dark variants per existing pattern).

**Dark theme (warm-tinted, not pure black; reduce neutral chroma, brighten teal):**
- `--color-surface`: `oklch(0.20 0.006 90)` · secondary `oklch(0.24 0.007 90)` · border `oklch(0.32 0.008 90)`
- `--color-text`: `oklch(0.95 0.004 90)` · secondary `oklch(0.72 0.01 90)` · tertiary `oklch(0.58 0.01 90)`
- `--color-primary`: `oklch(0.70 0.13 195)` (brighter so it reads on dark); button text dark.
- Reduce semantic saturation ~10-15% for dark.

## Spacing
- **Base unit:** 8px (keep). **Density:** comfortable but data-capable.
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64).

## Layout
- **Approach:** hybrid — app chrome (header, panels, dashboard) is grid-disciplined; the **canvas is the hero** and gets creative latitude.
- **Max content width:** dashboard ~1200px centered; canvas full-bleed.
- **Border radius:** sm 4 (inputs, chips) · md 8 (cards, buttons, nodes) · lg 12 (modals, drawers) · full 9999 (pills, avatars). Slightly tighter than bubbly = "precise."
- **Elevation:** shadows only (no gradients). sm `0 1px 2px /.05` · md `0 4px 12px /.08` · lg `0 8px 30px /.12` · xl `0 20px 60px /.16`.

## Motion
- **Approach:** intentional — every animation explains *what happened* or *what's next*. Absorbs the deferred onboarding motion (Phase 5 of the IA redesign).
- **Easing:** enter `cubic-bezier(0.16,1,0.3,1)` (ease-out) · exit ease-in · move ease-in-out · expressive `cubic-bezier(0.19,1,0.22,1)`.
- **Duration:** micro 80ms · short 180ms · medium 300ms · long 500ms.
- **Signature motions:** flowing dashed edge on the *active* run path (teal); one-time pulse on the suggested next action / first-run beats; panel/drawer slide from origin; node status transitions (idle→active glow→done check).
- **Accessibility:** every motion gated behind `@media (prefers-reduced-motion: reduce)` → opacity-only or none.

## Canvas & Node Visual Language (the signature surface)
This is where CWC earns its identity — treat with the most care.
- **Canvas:** dotted grid background on warm-neutral surface; subtle dot color (`--color-border` at low alpha). Generous breathing room.
- **Node card:** radius md(8), 1px border, surface bg, shadow-sm at rest. A **colored accent edge** (top or left bar) keyed to node type:
  - **Agent** → teal (brand) · **Gate** → amber (warning hue) · **Reference** → muted neutral · **Terminal** → keyed to terminalType (complete=success, escalated=warning, aborted=error).
- **Node states:** idle (neutral border) · selected (teal ring `--color-primary-ring`) · running (teal glow + soft pulse) · done (success check badge) · error (error border). Run states reuse the existing `nodeRunStates` pulse, restyled.
- **Edges:** smooth bezier, ~1.5px, neutral at rest; **router** edges dashed (existing); the **active run path** animates a flowing teal dash (the "alive" signature). Labels in a small chip.
- **Mode chrome (Build/Runs/Automate):** active tab marked by a teal underline/indicator; calm, high-contrast.
- **Empty canvas:** General Sans headline + one clear next action, not a wall of text.

## Implementation Notes
- Evolve the existing `client/src/index.css` token block in place (it already uses OKLCH + these token names) — change values, add `--color-accent-bright`, `--text-4xl`, dark-theme block, and swap font stacks. Most components already consume tokens, so the rebrand propagates.
- Node visual language lives in `WorkflowNode.tsx` + canvas CSS; edges in the React Flow edge config.
- Do the rebrand token-first (instant broad effect), then the canvas/node language, then motion + first-run polish.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-14 | Direction: "precise & warm" dev-tool | Middle path between n8n (intimidating) and Zapier (toy); credible + inviting |
| 2026-06-14 | Signature accent: teal (~195) | Category-unowned (Zapier orange, n8n coral, Make purple) = most branded; warm/cool tension with neutrals |
| 2026-06-14 | Warm-neutral surfaces (hue ~90) | Removes cold-gray "AI slop" feel; makes teal pop |
| 2026-06-14 | Type: General Sans (display) + Geist (UI) + JetBrains Mono (technical) | Drop generic Spline Sans/Barlow; mono signals "real code" |
| 2026-06-14 | Light default, both themes first-class | Friendlier first impression; dark for long sessions |
| 2026-06-14 | Canvas/node language is the brand surface | Like n8n, the node aesthetic IS the identity |
