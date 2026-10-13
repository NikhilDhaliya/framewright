import { useRef, useState, type ReactNode } from 'react'
import { formatTimecode } from '@core/time'
import { Icon, type SFName } from '../ui/Icon'
import { openMenuBelow, type MenuItem } from '../ui/Menu'
import { setPlaybackRate, usePlaybackRate } from '../state/playback'
import { guidesMenu, guidesOn, useGuides } from './Guides'
import { t } from '../i18n'

/** 12 px scrub bar: 3 px track (4 px active), accent progress, 6/10 px thumb (§5.4). */
export function ScrubBar({ frame, total, onBegin, onScrub, onEnd }: { frame: number; total: number; onBegin: () => void; onScrub: (f: number) => void; onEnd: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const frac = total > 0 ? Math.min(1, Math.max(0, frame / total)) : 0
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    return Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * total)
  }
  return (
    <div
      ref={ref}
      className={`pp-scrubbar${active ? ' active' : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        setActive(true)
        onBegin()
        onScrub(at(e.clientX))
        const move = (ev: PointerEvent) => onScrub(at(ev.clientX))
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          setActive(false)
          onEnd()
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
      }}
    >
      <div className="pp-scrubbar-track">
        <div className="pp-scrubbar-fill" style={{ width: `${frac * 100}%` }} />
      </div>
      <div className="pp-scrubbar-thumb" style={{ left: `${frac * 100}%` }} />
    </div>
  )
}

export function Timecode({ frame, total, fps }: { frame: number; total: number; fps: number }) {
  return (
    <span className="pp-timecode mono tnum">
      <span className="cur">{formatTimecode(frame, fps)}</span>
      <span className="sep"> / </span>
      <span className="tot">{formatTimecode(total, fps)}</span>
    </span>
  )
}

function TransportButton({ sf, onClick }: { sf: SFName; onClick: () => void }) {
  return (
    <button type="button" className="pp-iconbtn hh tone-secondary" style={{ width: 28, height: 28 }} onClick={onClick}>
      <Icon sf={sf} size={11} />
    </button>
  )
}

export interface TransportActions {
  toStart: () => void
  stepBack: (shift: boolean) => void
  toggle: () => void
  stepForward: (shift: boolean) => void
  toEnd: () => void
}

export function TransportButtons({ playing, actions }: { playing: boolean; actions: TransportActions }) {
  return (
    <div className="pp-transport-buttons">
      <TransportButton sf="backward.end.fill" onClick={actions.toStart} />
      <button type="button" className="pp-iconbtn hh tone-secondary" style={{ width: 28, height: 28 }} onClick={(e) => actions.stepBack(e.shiftKey)}>
        <Icon sf="backward.frame.fill" size={11} />
      </button>
      <TransportButton sf={playing ? 'pause.fill' : 'play.fill'} onClick={actions.toggle} />
      <button type="button" className="pp-iconbtn hh tone-secondary" style={{ width: 28, height: 28 }} onClick={(e) => actions.stepForward(e.shiftKey)}>
        <Icon sf="forward.frame.fill" size={11} />
      </button>
      <TransportButton sf="forward.end.fill" onClick={actions.toEnd} />
    </div>
  )
}

export function Badge({ sf, label, tip, items }: { sf: SFName; label: string; tip: string; items: () => MenuItem[] }) {
  return (
    <button type="button" className="pp-badge hh" data-tip={tip} onClick={(e) => openMenuBelow(e.currentTarget, items(), { alignRight: true })}>
      <Icon sf={sf} size={10} strokeWidth={2.25} />
      {label}
    </button>
  )
}

export function GuidesButton() {
  const on = useGuides(guidesOn)
  return (
    <button type="button" className={`pp-iconbtn hh ${on ? 'tone-accent' : 'tone-secondary'}`} style={{ width: 24, height: 24 }} data-tip={t('Canvas Guides')} onClick={(e) => openMenuBelow(e.currentTarget, guidesMenu(), { alignRight: true })}>
      <Icon sf={on ? 'viewfinder.circle.fill' : 'viewfinder'} size={11} strokeWidth={2.25} />
    </button>
  )
}

const RATES = [0.5, 0.75, 1, 1.5, 2, 4, 10]

export function SpeedBadge() {
  const rate = usePlaybackRate((s) => s.rate)
  return <Badge sf="speedometer" label={`${rate}×`} tip={t('Playback Speed')} items={() => RATES.map((r) => ({ label: `${r}×`, checked: r === rate, onSelect: () => setPlaybackRate(r) }))} />
}

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]

export function ZoomBadge({ zoom, setZoom }: { zoom: number; setZoom: (z: number) => void }) {
  return (
    <Badge
      sf="magnifyingglass"
      label={Math.abs(zoom - 1) < 0.005 ? t('Fit') : `${Math.round(zoom * 100)}%`}
      tip={t('Canvas Zoom')}
      items={() => ZOOMS.map((z) => ({ label: z === 1 ? t('Fit') : `${Math.round(z * 100)}%`, checked: Math.abs(zoom - z) <= 0.01, onSelect: () => setZoom(z) }))}
    />
  )
}

export function TransportBar({ left, center, right }: { left: ReactNode; center?: ReactNode; right: ReactNode }) {
  return (
    <div className="pp-transport">
      {left}
      <span style={{ flex: 1 }} />
      {center}
      <span style={{ flex: 1 }} />
      <div className="pp-transport-accessories">{right}</div>
    </div>
  )
}
