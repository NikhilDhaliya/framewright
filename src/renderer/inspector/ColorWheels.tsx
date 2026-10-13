import { useRef } from 'react'
import type { Clip } from '@core/model'
import { effectDescriptor } from '@core/ops/effects'
import type { EffectEdit } from '@core/ops/ui'
import { clearPreview, commitOp, previewOp } from '../state/ops'
import { Slider } from '../ui/Slider'
import { effectHandlers, paramOf } from './effectEdits'
import { authoritativeClip } from './model'
import { t, tk } from '../i18n'

const TYPE = 'color.wheels'
const PAD = 96
const DISC_RES = 160
const PUCK = 10

type Wheel = 'lift' | 'gamma' | 'gain'

const WHEELS: { key: Wheel; title: string }[] = [
  { key: 'lift', title: tk('Lift') },
  { key: 'gamma', title: tk('Gamma') },
  { key: 'gain', title: tk('Gain') },
]

let discUrl: string | null = null

/** Hue = atan2(y, x), v = 0.08 + 0.5·r^1.7, s = r^1.4, smoothstep rim over r 0.86→1. Rendered once. */
function disc(): string {
  if (discUrl) return discUrl
  const c = document.createElement('canvas')
  c.width = c.height = DISC_RES
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(DISC_RES, DISC_RES)
  const half = DISC_RES / 2
  for (let py = 0; py < DISC_RES; py++) {
    for (let px = 0; px < DISC_RES; px++) {
      const x = (px + 0.5 - half) / half
      const y = (half - py - 0.5) / half
      const r = Math.hypot(x, y)
      const i = (py * DISC_RES + px) * 4
      if (r > 1) continue
      const h = ((Math.atan2(y, x) / (2 * Math.PI)) % 1 + 1) % 1
      const s = Math.pow(r, 1.4)
      const v = 0.08 + 0.5 * Math.pow(r, 1.7)
      const [rr, gg, bb] = hsv(h, s, v)
      const t = Math.min(1, Math.max(0, (r - 0.86) / 0.14))
      const rim = 1 - t * t * (3 - 2 * t)
      img.data[i] = rr * 255
      img.data[i + 1] = gg * 255
      img.data[i + 2] = bb * 255
      img.data[i + 3] = 255 * (0.25 + 0.75 * rim)
    }
  }
  ctx.putImageData(img, 0, 0)
  discUrl = c.toDataURL()
  return discUrl
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (i % 6) {
    case 0: return [v, t, p]
    case 1: return [q, v, p]
    case 2: return [p, v, t]
    case 3: return [p, q, v]
    case 4: return [t, p, v]
    default: return [v, p, q]
  }
}

/** Removes the effect when every wheel param of the first clip is back at its default after applying `patch`. */
function wheelEdit(ids: string[], patch: Record<string, number>): EffectEdit {
  const first = authoritativeClip(ids[0])
  const desc = effectDescriptor(TYPE)!
  const allDefault = desc.params.every((p) => Math.abs((patch[p.key] ?? (first ? paramOf(first, TYPE, p.key) : p.default)) - p.default) < 1e-6)
  return allDefault ? { type: TYPE, remove: true } : { type: TYPE, params: patch }
}

function WheelControl({ clips, wheel, title }: { clips: Clip[]; wheel: Wheel; title: string }) {
  const ids = clips.map((c) => c.id)
  const padRef = useRef<HTMLDivElement>(null)
  const x = paramOf(clips[0], TYPE, `${wheel}_x`)
  const y = paramOf(clips[0], TYPE, `${wheel}_y`)
  const mKey = `${wheel}_m`
  const m = effectDescriptor(TYPE)!.params.find((p) => p.key === mKey)!
  const master = effectHandlers(ids, `Adjust ${title}`, (v) => [wheelEdit(ids, { [mKey]: v })])
  const label = `Adjust ${title}`

  const posAt = (clientX: number, clientY: number) => {
    const r = padRef.current!.getBoundingClientRect()
    const rad = r.width / 2
    let px = (clientX - r.left - rad) / rad
    let py = -(clientY - r.top - rad) / rad
    const len = Math.hypot(px, py)
    if (len > 1) {
      px /= len
      py /= len
    }
    return { [`${wheel}_x`]: px, [`${wheel}_y`]: py }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.detail > 1) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const sx = e.clientX
    const sy = e.clientY
    let dragging = false
    let last: Record<string, number> | null = null
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 2) return
      dragging = true
      last = posAt(ev.clientX, ev.clientY)
      if (!previewOp('editEffects', { ids, edits: [wheelEdit(ids, last)] })) clearPreview()
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (last) void commitOp('editEffects', { ids, edits: [wheelEdit(ids, last)], label }, { quiet: true })
      else clearPreview()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const reset = () => void commitOp('editEffects', { ids, edits: [wheelEdit(ids, { [`${wheel}_x`]: 0, [`${wheel}_y`]: 0 })], label }, { quiet: true })

  const c = PAD / 2
  return (
    <div className="pp-insp-wheel">
      <span className="pp-insp-wheel-title">{t(title)}</span>
      <div ref={padRef} className="pp-insp-wheel-pad" style={{ width: PAD, height: PAD }} onPointerDown={onPointerDown} onDoubleClick={reset}>
        <img src={disc()} width={PAD} height={PAD} alt="" draggable={false} />
        <span className="pp-insp-wheel-cross h" />
        <span className="pp-insp-wheel-cross v" />
        <span className="pp-insp-wheel-puck" style={{ left: c + x * c - PUCK / 2, top: c - y * c - PUCK / 2 }} />
      </div>
      <Slider value={paramOf(clips[0], TYPE, mKey)} min={m.min} max={m.max} defaultValue={m.default} gradient="var(--pp-slider-luma-gradient)" width={PAD} onChange={master.onChange} onCommit={master.onCommit} />
    </div>
  )
}

/** Lift / Gamma / Gain pads with master sliders (§7.7 ColorWheelControl). */
export function ColorWheels({ clips }: { clips: Clip[] }) {
  return (
    <div className="pp-insp-wheels">
      {WHEELS.map((w) => (
        <WheelControl key={w.key} clips={clips} wheel={w.key} title={w.title} />
      ))}
    </div>
  )
}
