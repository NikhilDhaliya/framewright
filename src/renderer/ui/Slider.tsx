import { useRef } from 'react'

interface SliderProps {
  value: number
  min: number
  max: number
  defaultValue: number
  onChange: (v: number) => void
  onCommit: (v: number) => void
  /** CSS gradient for the track; otherwise a plain track filled from the left edge. */
  gradient?: string
  disabled?: boolean
  width?: number
}

/** AdjustSlider: click jumps, drag is live, release commits, double-click resets. */
export function Slider({ value, min, max, defaultValue, onChange, onCommit, gradient, disabled, width }: SliderProps) {
  const ref = useRef<HTMLDivElement>(null)
  const frac = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
  const valueAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - r.left - 5) / Math.max(1, r.width - 10)))
    return min + t * (max - min)
  }
  return (
    <div
      ref={ref}
      className={`pp-slider${disabled ? ' disabled' : ''}`}
      style={{ width }}
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return
        e.stopPropagation()
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        let last = valueAt(e.clientX)
        onChange(last)
        const move = (ev: PointerEvent) => {
          last = valueAt(ev.clientX)
          onChange(last)
        }
        const up = () => {
          el.removeEventListener('pointermove', move)
          el.removeEventListener('pointerup', up)
          el.removeEventListener('pointercancel', up)
          onCommit(last)
        }
        el.addEventListener('pointermove', move)
        el.addEventListener('pointerup', up)
        el.addEventListener('pointercancel', up)
      }}
      onDoubleClick={() => {
        if (disabled) return
        onChange(defaultValue)
        onCommit(defaultValue)
      }}
    >
      <div className="pp-slider-track" style={gradient ? { background: gradient } : undefined}>
        {!gradient && <div className="pp-slider-fill" style={{ width: `${frac * 100}%` }} />}
      </div>
      <div className="pp-slider-thumb" style={{ left: `calc(${frac} * (100% - 10px))` }} />
    </div>
  )
}
