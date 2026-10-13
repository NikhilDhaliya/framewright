import { useEffect, useRef, useState } from 'react'
import type { RGBA } from '@core/model'
import { Popover, rectOf, type AnchorRect } from './Popover'

const COMMIT_DEBOUNCE_MS = 400

export const rgbaCss = (c: RGBA, alpha = true) =>
  `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${alpha ? c.a : 1})`

export const toHex = (c: RGBA) =>
  '#' + [c.r, c.g, c.b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()

export function fromHex(hex: string, a = 1): RGBA | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a }
}

interface HSV {
  h: number
  s: number
  v: number
}

function rgbToHsv({ r, g, b }: RGBA): HSV {
  const max = Math.max(r, g, b)
  const d = max - Math.min(r, g, b)
  let h = 0
  if (d > 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: ((h * 60 + 360) % 360) / 360, s: max > 0 ? d / max : 0, v: max }
}

function hsvToRgb({ h, s, v }: HSV, a: number): RGBA {
  const f = (n: number) => {
    const k = (n + h * 6) % 6
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1))
  }
  return { r: f(5), g: f(3), b: f(1), a }
}

function pointerDrag(onPoint: (x: number, y: number) => void) {
  return (e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      onPoint(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)))
    }
    at(e)
    const move = (ev: PointerEvent) => at(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
}

function ColorPicker({ color, alpha, onChange }: { color: RGBA; alpha: boolean; onChange: (c: RGBA) => void }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(color))
  const [hex, setHex] = useState(toHex(color))
  const apply = (next: HSV, a = color.a) => {
    setHsv(next)
    const c = hsvToRgb(next, a)
    setHex(toHex(c))
    onChange(c)
  }
  const sv = pointerDrag((x, y) => apply({ ...hsv, s: x, v: 1 - y }))
  const hue = pointerDrag((x) => apply({ ...hsv, h: Math.min(0.9999, x) }))
  const alphaDrag = pointerDrag((x) => onChange({ ...hsvToRgb(hsv, x) }))
  const pure = hsvToRgb({ h: hsv.h, s: 1, v: 1 }, 1)
  return (
    <div className="pp-colorpicker">
      <div className="pp-cp-sv" style={{ background: rgbaCss(pure, false) }} onPointerDown={sv}>
        <div className="pp-cp-knob" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div className="pp-cp-hue" onPointerDown={hue}>
        <div className="pp-cp-bar-knob" style={{ left: `${hsv.h * 100}%` }} />
      </div>
      {alpha && (
        <div className="pp-cp-alpha" style={{ ['--cp-color' as string]: rgbaCss(color, false) }} onPointerDown={alphaDrag}>
          <div className="pp-cp-bar-knob" style={{ left: `${color.a * 100}%` }} />
        </div>
      )}
      <div className="pp-cp-row">
        <span className="pp-cp-swatch" style={{ background: rgbaCss(color) }} />
        <input
          className="pp-cp-hex mono"
          value={hex}
          spellCheck={false}
          onChange={(e) => {
            setHex(e.target.value)
            const c = fromHex(e.target.value, color.a)
            if (c) {
              setHsv(rgbToHsv(c))
              onChange(c)
            }
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {alpha && <span className="pp-cp-alpha-label tnum">{Math.round(color.a * 100)}%</span>}
      </div>
    </div>
  )
}

interface ColorFieldProps {
  value: RGBA | null
  onChange: (c: RGBA) => void
  onCommit: (c: RGBA) => void
  alpha?: boolean
  disabled?: boolean
  width?: number
  height?: number
}

/** Swatch that opens a live color picker; changes commit on a 400 ms debounce and on close. */
export function ColorField({ value, onChange, onCommit, alpha = true, disabled, width = 24, height = 14 }: ColorFieldProps) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const pending = useRef<RGBA | null>(null)
  const timer = useRef(0)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const flush = () => {
    window.clearTimeout(timer.current)
    if (pending.current) commitRef.current(pending.current)
    pending.current = null
  }
  useEffect(() => flush, [])
  const color = value ?? { r: 0.5, g: 0.5, b: 0.5, a: 1 }
  return (
    <>
      <button
        type="button"
        className="pp-color-swatch"
        disabled={disabled}
        style={{ width, height, background: value ? rgbaCss(value, alpha) : 'repeating-linear-gradient(45deg, var(--pp-fill-muted) 0 3px, transparent 3px 6px)' }}
        onClick={(e) => setAnchor(rectOf(e.currentTarget))}
      />
      {anchor && (
        <Popover
          anchor={anchor}
          onClose={() => {
            flush()
            setAnchor(null)
          }}
        >
          <ColorPicker
            color={color}
            alpha={alpha}
            onChange={(c) => {
              const next = alpha ? c : { ...c, a: color.a }
              onChange(next)
              pending.current = next
              window.clearTimeout(timer.current)
              timer.current = window.setTimeout(flush, COMMIT_DEBOUNCE_MS)
            }}
          />
        </Popover>
      )}
    </>
  )
}
