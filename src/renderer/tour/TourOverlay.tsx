/** Tutorial tour overlay: scrim with a cutout, gradient ring, callout / intro / outro cards (spec 07 §7.3, Mac `TourOverlay.swift`). */
import { useEffect, useLayoutEffect, useState } from 'react'
import { DOCS_URL } from '../../shared/brand'
import { openDialog } from '../state/dialogs'
import { useProject } from '../state/project'
import { Capsule } from '../ui/buttons'
import { Icon, type SFName } from '../ui/Icon'
import { CALLOUT_WIDTH, calloutPosition, isSpotlight, stepCounter, type Rect, type TourStep } from './logic'
import { endTour, nextStep, previousStep, startTour, useTour } from './store'
import './tour.css'
import { t } from '../i18n'

const PANEL_SELECTOR: Record<string, string> = {
  media: '[data-panel="mediaPanel"]',
  preview: '[data-panel="previewPanel"]',
  timeline: '[data-panel="timelinePanel"]',
  inspector: '[data-panel="inspectorPanel"]',
  agent: '[data-tour="agentPanel"], .pp-agent',
}

const ELEMENT_SELECTOR: Record<string, string> = {
  importButton: '[data-tour="importButton"]',
  generateButton: '[data-tour="generateButton"]',
  generation: '[data-tour="generation"]',
  smartSearch: '[data-tour="smartSearch"]',
  screenshotButton: '[data-tour="screenshotButton"]',
  aiEditPanel: '[data-tour="aiEditPanel"], [data-panel="inspectorPanel"] .pp-insp-scroll',
  skillsButton: '[data-tour="skillsButton"]',
}

const selectorFor = (s: TourStep): string | null => (s.kind === 'panel' ? PANEL_SELECTOR[s.panel] : s.kind === 'element' ? ELEMENT_SELECTOR[s.element] : null)

/** The first visible match, clipped below the title bar; null when missing or hidden (centred callout, no cutout). */
function targetFrame(step: TourStep): Rect | null {
  const sel = selectorFor(step)
  if (!sel) return null
  const top = document.querySelector('.pp-editor-body')?.getBoundingClientRect().top ?? 0
  for (const el of document.querySelectorAll<HTMLElement>(sel)) {
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    const y = Math.max(r.top, top)
    if (r.bottom <= y) continue
    return { x: r.left, y, width: r.width, height: r.bottom - y }
  }
  return null
}

const sameRect = (a: Rect | null, b: Rect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height)

/** Tracks the step's target every frame (anchors move when panels open, resize or scroll). */
function useTargetFrame(step: TourStep | null): Rect | null {
  const [frame, setFrame] = useState<Rect | null>(null)
  useLayoutEffect(() => {
    if (!step || !isSpotlight(step)) {
      setFrame(null)
      return
    }
    let raf = 0
    let last: Rect | null = null
    const tick = () => {
      const next = targetFrame(step)
      if (!sameRect(next, last)) {
        last = next
        setFrame(next)
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [step])
  return frame
}

function useWindowSize() {
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  useEffect(() => {
    const on = () => setSize({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return size
}

/** Scrim with an even-odd cutout: the cutout passes clicks through, the scrim ends the tour on spotlight steps. */
function Scrim({ frame, pad, onClick }: { frame: Rect | null; pad: number; onClick?: () => void }) {
  const { width, height } = useWindowSize()
  let d = `M0 0H${width}V${height}H0Z`
  if (frame) {
    const x = frame.x - pad
    const y = frame.y - pad
    const w = frame.width + pad * 2
    const h = frame.height + pad * 2
    const r = Math.min(6, w / 2, h / 2)
    d += `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  }
  return (
    <svg className="pp-tour-scrim" width={width} height={height}>
      <path d={d} fillRule="evenodd" onPointerDown={(e) => e.stopPropagation()} onClick={onClick} />
    </svg>
  )
}

function Ring({ frame, pad }: { frame: Rect; pad: number }) {
  return <div className="pp-tour-ring" style={{ left: frame.x - pad, top: frame.y - pad, width: frame.width + pad * 2, height: frame.height + pad * 2 }} />
}

function Callout({ step, steps, index, frame }: { step: TourStep; steps: TourStep[]; index: number; frame: Rect | null }) {
  const win = useWindowSize()
  // The Mac positions the card's centre (SwiftUI `.position`); the centre comes from the 220 estimate.
  const centre = calloutPosition(frame, win)
  return (
    <div className="pp-tour-callout" style={{ left: centre.x - CALLOUT_WIDTH / 2, top: centre.y }} role="dialog" aria-label={step.title}>
      <span className="pp-tour-step">{stepCounter(steps, index)}</span>
      <span className="pp-tour-callout-title">{step.title}</span>
      <span className="pp-tour-callout-text">{step.instruction}</span>
      <div className="pp-tour-buttons">
        <Capsule size="regular" onClick={endTour}>
          {t('Skip')}
        </Capsule>
        <span style={{ flex: 1 }} />
        <Capsule size="regular" onClick={previousStep}>
          {t('Back')}
        </Capsule>
        <Capsule size="regular" variant="prominent" onClick={nextStep}>
          {t('Next')}
        </Capsule>
      </div>
    </div>
  )
}

function IntroCard({ step }: { step: TourStep }) {
  return (
    <div className="pp-tour-center">
      <div className="pp-tour-intro" role="dialog" aria-label={step.title}>
        <span className="pp-tour-title-lg">{step.title}</span>
        <span className="pp-tour-callout-text">{step.instruction}</span>
        <div className="pp-tour-hero" aria-hidden>
          <Icon sf="film.stack" size={40} />
        </div>
        <div className="pp-tour-buttons">
          <Capsule size="regular" onClick={endTour}>
            {t('Skip')}
          </Capsule>
          <span style={{ flex: 1 }} />
          <Capsule size="regular" variant="prominent" onClick={nextStep}>
            {t('Next')}
          </Capsule>
        </div>
      </div>
    </div>
  )
}

function OutroLink({ icon, label, onClick }: { icon: SFName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="pp-tour-link hh"
      onClick={onClick}
    >
      <span className="pp-tour-link-icon">
        <Icon sf={icon} size={12} />
      </span>
      <span className="pp-tour-link-label">{label}</span>
      <Icon sf="arrow.up.right" size={9} className="tone-muted" />
    </button>
  )
}

function OutroCard({ step }: { step: TourStep }) {
  return (
    <div className="pp-tour-center">
      <div className="pp-tour-intro outro" role="dialog" aria-label={step.title}>
        <span className="pp-tour-title-md">{step.title}</span>
        <span className="pp-tour-callout-text">{step.instruction}</span>
        <div className="pp-tour-links">
          <OutroLink icon="book.closed" label={t('Skills')} onClick={() => openDialog({ kind: 'settings', pane: 'skills' })} />
          <OutroLink icon="network" label={t('MCP Setup')} onClick={() => openDialog({ kind: 'mcp' })} />
          <OutroLink icon="keyboard" label={t('Keyboard Shortcuts')} onClick={() => openDialog({ kind: 'shortcuts' })} />
          <OutroLink icon="doc" label={t('Documentation')} onClick={() => window.palmier.app.openExternal(DOCS_URL)} />
          <OutroLink icon="gearshape" label={t('Settings')} onClick={() => openDialog({ kind: 'settings' })} />
        </div>
        <div className="pp-tour-buttons">
          <span style={{ flex: 1 }} />
          <Capsule size="regular" variant="prominent" onClick={endTour}>
            {t('Start creating')}
          </Capsule>
        </div>
      </div>
    </div>
  )
}

/** Esc = Skip, Return = Next; swallowed so editor shortcuts don't fire underneath. Sheets opened on top keep their keys. */
function useTourKeys(active: boolean) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.pp-sheet-backdrop, .pp-menu-backdrop, .pp-popover')) return
      if (e.key === 'Escape') endTour()
      else if (e.key === 'Enter' && !e.isComposing) nextStep()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])
}

/** Mounted with the editor; also starts a tour requested by onboarding once the project is on screen. */
export function TourHost() {
  const { steps, index, pendingStart } = useTour()
  const hasProject = useProject((s) => !!s.snapshot)
  useEffect(() => {
    if (!pendingStart || !hasProject) return
    const id = window.setTimeout(startTour, 300)
    return () => window.clearTimeout(id)
  }, [pendingStart, hasProject])
  useEffect(() => {
    if (!hasProject) endTour()
  }, [hasProject])
  const step = index >= 0 ? steps[index] ?? null : null
  useTourKeys(!!step)
  const frame = useTargetFrame(step)
  if (!step) return null
  const spotlight = isSpotlight(step)
  const pad = 0
  return (
    <div className="pp-tour" data-testid="tour" data-step={step.id}>
      <Scrim frame={spotlight ? frame : null} pad={pad} onClick={spotlight ? endTour : undefined} />
      {spotlight && frame && <Ring frame={frame} pad={pad} />}
      {step.kind === 'intro' && <IntroCard step={step} />}
      {step.kind === 'outro' && <OutroCard step={step} />}
      {spotlight && <Callout step={step} steps={steps} index={index} frame={frame} />}
    </div>
  )
}
