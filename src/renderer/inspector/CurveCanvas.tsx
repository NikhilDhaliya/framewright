import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CurvePoint } from '@core/ops/grade'

export const CURVE_HEIGHT = 180
const GRAB_RADIUS = 15
const DRAG_THRESHOLD = 3
const POINT_RADIUS = 4.5

export type CssVar = (name: string) => string

interface CurveCanvasProps {
  /** Displayed points, sorted by x (never empty). */
  points: CurvePoint[]
  /** CSS custom property for the curve and its points. */
  color: string
  evaluate: (pts: CurvePoint[], x: number) => number
  /** Sampling step along x. */
  step: number
  background: (ctx: CanvasRenderingContext2D, w: number, h: number, v: CssVar) => void
  onChange: (pts: CurvePoint[]) => void
  onCommit: (pts: CurvePoint[]) => void
  onCancel: () => void
}

/**
 * Shared curve surface (§7.7): a press within 15 px grabs a point, otherwise adds one; endpoints move
 * vertically only, interior points stay between their neighbours; double-click removes the nearest interior point.
 */
export function CurveCanvas({ points, color, evaluate, step, background, onChange, onCommit, onCancel }: CurveCanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || width <= 0) return
    const dpr = window.devicePixelRatio || 1
    el.width = Math.round(width * dpr)
    el.height = Math.round(CURVE_HEIGHT * dpr)
    const ctx = el.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const cs = getComputedStyle(el)
    const v: CssVar = (n) => cs.getPropertyValue(n).trim()
    ctx.clearRect(0, 0, width, CURVE_HEIGHT)
    background(ctx, width, CURVE_HEIGHT, v)
    ctx.strokeStyle = v('--pp-border-subtle')
    ctx.lineWidth = 0.5
    ctx.strokeRect(0.25, 0.25, width - 0.5, CURVE_HEIGHT - 0.5)
    const stroke = v(color)
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (let i = 0; i * step <= 1 + 1e-9; i++) {
      const x = Math.min(1, i * step)
      const py = (1 - evaluate(points, x)) * CURVE_HEIGHT
      if (i === 0) ctx.moveTo(0, py)
      else ctx.lineTo(x * width, py)
    }
    ctx.stroke()
    ctx.fillStyle = stroke
    for (const p of points) {
      ctx.beginPath()
      ctx.arc(p.x * width, (1 - p.y) * CURVE_HEIGHT, POINT_RADIUS, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [points, color, evaluate, step, background, width])

  const local = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    return { x: Math.min(1, Math.max(0, px / r.width)), y: Math.min(1, Math.max(0, 1 - py / r.height)), px, py }
  }
  const nearest = (pts: CurvePoint[], px: number, py: number, within: number, interiorOnly: boolean) => {
    let best = -1
    let bestD = within
    pts.forEach((q, i) => {
      if (interiorOnly && (i === 0 || i === pts.length - 1)) return
      const d = Math.hypot(q.x * width - px, (1 - q.y) * CURVE_HEIGHT - py)
      if (d <= bestD) {
        bestD = d
        best = i
      }
    })
    return best
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || e.detail > 1) return
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const start = local(e)
    let pts = points.map((p) => ({ ...p }))
    let idx = nearest(pts, start.px, start.py, GRAB_RADIUS, false)
    let moved = false
    const move = (ev: PointerEvent) => {
      const p = local(ev)
      if (!moved) {
        if (Math.hypot(p.px - start.px, p.py - start.py) < DRAG_THRESHOLD) return
        moved = true
        if (idx < 0) {
          idx = pts.findIndex((q) => q.x > start.x)
          if (idx < 0) idx = pts.length
          pts.splice(idx, 0, { x: start.x, y: start.y })
        }
      }
      const last = pts.length - 1
      const x = idx === 0 || idx === last ? pts[idx].x : Math.min(pts[idx + 1].x - 0.001, Math.max(pts[idx - 1].x + 0.001, p.x))
      pts = pts.map((q, i) => (i === idx ? { x, y: p.y } : q))
      onChange(pts)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      if (moved) onCommit(pts)
      else onCancel()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (points.length <= 2) return
    const p = local(e)
    const i = nearest(points, p.px, p.py, Infinity, true)
    if (i > 0) onCommit(points.filter((_, j) => j !== i))
  }

  return <canvas ref={ref} className="pp-insp-curve-canvas" style={{ height: CURVE_HEIGHT }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick} />
}
