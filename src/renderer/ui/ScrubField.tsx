import { useEffect, useRef, useState } from 'react'

export interface ScrubFieldProps {
  /** Raw value; null renders the mixed-selection dash. */
  value: number | null
  onChange: (raw: number) => void
  onCommit: (raw: number) => void
  /** Ends a live interaction that produced no change. */
  onCancel?: () => void
  min?: number
  max?: number
  /** Display = raw × mult. */
  mult?: number
  decimals?: number
  suffix?: string
  /** Display units per pixel of drag. */
  sens?: number
  width?: number
  label?: string
  disabled?: boolean
  /** Per-property adjustment after clamping (e.g. rotation snap). */
  adjust?: (raw: number) => number
  /** Formats the displayed value; defaults to fixed decimals + suffix. */
  format?: (raw: number) => string
  /** Parses typed text into a raw value (e.g. a timecode); null rejects. The field then edits the formatted text. */
  parse?: (text: string) => number | null
  variant?: 'inspector' | 'timeline'
  tip?: string
  onInteraction?: (active: boolean) => void
}

const DRAG_THRESHOLD = 3

/** ScrubbableNumberField: drag horizontally to scrub (Shift ×10, Ctrl ×0.1), click to type. */
export function ScrubField(p: ScrubFieldProps) {
  const { value, mult = 1, decimals = 0, suffix = '', sens = 1, width, label, disabled, variant = 'inspector' } = p
  const [editing, setEditing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const props = useRef(p)
  props.current = p
  const live = useRef<{ start: number; current: number; moved: boolean; accum: number } | null>(null)

  const clamp = (raw: number) => Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, raw))
  const display = (raw: number) => (p.format ? p.format(raw) : `${(raw * mult).toFixed(decimals)}${suffix}`)

  useEffect(
    () => () => {
      const l = live.current
      if (l?.moved) props.current.onCommit(l.current)
    },
    [],
  )

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled || editing || e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = ref.current!
    el.setPointerCapture(e.pointerId)
    live.current = { start: value ?? 0, current: value ?? 0, moved: false, accum: 0 }
    const onMove = (ev: PointerEvent) => {
      const l = live.current
      if (!l || value === null) return
      l.accum += ev.movementX
      if (!l.moved && Math.abs(l.accum) <= DRAG_THRESHOLD) return
      if (!l.moved) {
        l.moved = true
        setDragging(true)
        props.current.onInteraction?.(true)
        try {
          void Promise.resolve(el.requestPointerLock()).catch(() => undefined)
        } catch {
          // Pointer lock is optional; dragging still works without it.
        }
      }
      const factor = ev.shiftKey ? 10 : ev.ctrlKey ? 0.1 : 1
      const { sens: s = 1, mult: m = 1 } = props.current
      let raw = clamp(l.start + (l.accum * s * factor) / m)
      if (props.current.adjust) raw = props.current.adjust(raw)
      if (raw !== l.current) {
        l.current = raw
        props.current.onChange(raw)
      }
    }
    const onUp = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      if (document.pointerLockElement === el) document.exitPointerLock()
      const l = live.current
      live.current = null
      setDragging(false)
      if (!l) return
      if (!l.moved) {
        setEditing(true)
        return
      }
      props.current.onInteraction?.(false)
      if (l.current !== l.start) props.current.onCommit(l.current)
      else props.current.onCancel?.()
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  const commitText = (text: string) => {
    setEditing(false)
    if (p.parse) {
      const parsed = p.parse(text.trim())
      if (parsed === null || !Number.isFinite(parsed)) return
      let raw = clamp(parsed)
      if (p.adjust) raw = p.adjust(raw)
      if (raw === value) return
      p.onChange(raw)
      p.onCommit(raw)
      return
    }
    let t = text.trim()
    if (suffix.trim() && t.endsWith(suffix.trim())) t = t.slice(0, -suffix.trim().length)
    const n = Number(t.trim().replace(',', '.'))
    if (t.trim() === '' || !Number.isFinite(n)) return
    let raw = clamp(n / mult)
    if (p.adjust) raw = p.adjust(raw)
    if (raw === value) return
    p.onChange(raw)
    p.onCommit(raw)
  }

  const w = width ?? (variant === 'timeline' ? 36 : 56)
  return (
    <div
      ref={ref}
      className={`pp-value-field pp-scrub ${variant}${disabled ? ' disabled' : ''}`}
      data-active={editing || dragging || undefined}
      style={{ width: w }}
      data-tip={p.tip}
      onPointerDown={onPointerDown}
    >
      {label && <span className="pp-scrub-label">{label}</span>}
      {editing ? (
        <input
          autoFocus
          className="pp-scrub-input"
          defaultValue={value === null ? '' : p.parse ? display(value) : String(Number((value * mult).toFixed(Math.max(decimals, 2))))}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commitText(e.currentTarget.value)
            else if (e.key === 'Escape') setEditing(false)
          }}
          onBlur={(e) => commitText(e.currentTarget.value)}
        />
      ) : (
        <span className={`pp-scrub-value${value === null ? ' mixed' : ''}`}>{value === null ? '—' : display(value)}</span>
      )}
    </div>
  )
}
