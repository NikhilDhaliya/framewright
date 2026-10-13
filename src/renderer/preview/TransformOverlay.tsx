import { useState } from 'react'
import { isActive } from '@core/keyframes'
import { textStyleAt, transformAt } from '@core/clip'
import type { Clip, Transform } from '@core/model'
import type { ClipPropertyPatch } from '@core/ops'
import { textMeasurer } from '../render/text'
import { clearPreview, commitOp, previewOp } from '../state/ops'
import { boxOf, rotate, type Box, type Point, type Size } from './geometry'

const SNAP_PX = 8
const MIN_FRACTION = 0.05
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const

interface Props {
  clip: Clip
  frame: number
  canvas: Size
  /** Media pixel aspect (w/h) when known; locks corner drags. */
  mediaAspect: number | null
  container: () => DOMRect
}

/** Move/scale gizmo for the selected visual clip (§5.7). One undo step per drag. */
export function TransformOverlay({ clip, frame, canvas, mediaAspect, container }: Props) {
  const [centerGuides, setCenterGuides] = useState({ x: false, y: false })
  const t = transformAt(clip, frame)
  const box = boxOf(t, canvas)

  const pointAt = (e: { clientX: number; clientY: number }): Point => {
    const r = container()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const patchFor = (b: Box, startT: Transform): ClipPropertyPatch => ({
    transform: { ...startT, centerX: b.cx / canvas.w, centerY: b.cy / canvas.h, width: b.w / canvas.w, height: b.h / canvas.h },
  })

  const track = (e: React.PointerEvent, onMove: (p: Point) => ClipPropertyPatch | null, label: string) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    let patch: ClipPropertyPatch | null = null
    const move = (ev: PointerEvent) => {
      patch = onMove(pointAt(ev))
      if (patch) previewOp('setClipProperties', { ids: [clip.id], frame, patch })
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setCenterGuides({ x: false, y: false })
      if (patch) void commitOp('setClipProperties', { ids: [clip.id], frame, patch, label }, { quiet: true })
      else clearPreview()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const startMove = (e: React.PointerEvent) => {
    const start = pointAt(e)
    const b0 = box
    const t0 = t
    const unrotated = Math.abs(b0.rotation % 360) < 1e-6
    track(
      e,
      (p) => {
        let cx = b0.cx + p.x - start.x
        let cy = b0.cy + p.y - start.y
        const snapX = Math.abs(cx - canvas.w / 2) <= SNAP_PX
        const snapY = Math.abs(cy - canvas.h / 2) <= SNAP_PX
        if (snapX) cx = canvas.w / 2
        else if (unrotated) {
          if (Math.abs(cx - b0.w / 2) <= SNAP_PX) cx = b0.w / 2
          else if (Math.abs(cx + b0.w / 2 - canvas.w) <= SNAP_PX) cx = canvas.w - b0.w / 2
        }
        if (snapY) cy = canvas.h / 2
        else if (unrotated) {
          if (Math.abs(cy - b0.h / 2) <= SNAP_PX) cy = b0.h / 2
          else if (Math.abs(cy + b0.h / 2 - canvas.h) <= SNAP_PX) cy = canvas.h - b0.h / 2
        }
        setCenterGuides({ x: snapX, y: snapY })
        if (cx === b0.cx && cy === b0.cy) return null
        return patchFor({ ...b0, cx, cy }, t0)
      },
      'Change Position',
    )
  }

  const startResize = (e: React.PointerEvent, sx: -1 | 1, sy: -1 | 1) => {
    const b0 = box
    const t0 = t
    const isText = clip.mediaType === 'text'
    const aspect = isText || mediaAspect ? b0.w / Math.max(1, b0.h) : null
    const anchor = rotate({ x: (-sx * b0.w) / 2, y: (-sy * b0.h) / 2 }, b0.rotation)
    const O = { x: b0.cx + anchor.x, y: b0.cy + anchor.y }
    const unrotated = Math.abs(b0.rotation % 360) < 1e-6
    const minW = MIN_FRACTION * canvas.w
    const minH = MIN_FRACTION * canvas.h
    track(
      e,
      (p) => {
        const d = rotate({ x: p.x - O.x, y: p.y - O.y }, -b0.rotation)
        if (isText && !isActive(clip.scaleTrack)) {
          const style = textStyleAt(clip, frame)
          const ratio = Math.sqrt(Math.max(0.01, (sx * d.x) / b0.w) * Math.max(0.01, (sy * d.y) / b0.h))
          const fontScale = Math.max(0.05, style.fontScale * ratio)
          return { textStyle: { fontScale }, textBox: textMeasurer.measure(clip.textContent ?? '', { ...style, fontScale }, canvas.w, canvas.h) }
        }
        let w = Math.max(minW, sx * d.x)
        let h = Math.max(minH, sy * d.y)
        if (unrotated) {
          const edgeX = O.x + sx * w
          if (Math.abs(edgeX) <= SNAP_PX) w = sx * (0 - O.x)
          else if (Math.abs(edgeX - canvas.w) <= SNAP_PX) w = sx * (canvas.w - O.x)
          const edgeY = O.y + sy * h
          if (Math.abs(edgeY) <= SNAP_PX) h = sy * (0 - O.y)
          else if (Math.abs(edgeY - canvas.h) <= SNAP_PX) h = sy * (canvas.h - O.y)
        }
        if (aspect) {
          const s = Math.max(w / b0.w, h / b0.h)
          w = Math.max(minW, b0.w * s)
          h = w / aspect
        }
        const c = rotate({ x: (sx * w) / 2, y: (sy * h) / 2 }, b0.rotation)
        return patchFor({ ...b0, cx: O.x + c.x, cy: O.y + c.y, w, h }, t0)
      },
      'Change Scale',
    )
  }

  return (
    <>
      <div className="pp-xf" style={{ left: box.cx - box.w / 2, top: box.cy - box.h / 2, width: box.w, height: box.h, transform: `rotate(${box.rotation}deg)` }}>
        <div className="pp-xf-hit" onPointerDown={startMove} />
        {CORNERS.map(([sx, sy]) => (
          <div
            key={`${sx}${sy}`}
            className="pp-xf-handle"
            style={{ left: sx < 0 ? -4 : undefined, right: sx > 0 ? -4 : undefined, top: sy < 0 ? -4 : undefined, bottom: sy > 0 ? -4 : undefined, cursor: sx === sy ? 'nwse-resize' : 'nesw-resize' }}
            onPointerDown={(e) => startResize(e, sx, sy)}
          />
        ))}
      </div>
      {centerGuides.x && <div className="pp-center-guide v" style={{ left: canvas.w / 2 }} />}
      {centerGuides.y && <div className="pp-center-guide h" style={{ top: canvas.h / 2 }} />}
    </>
  )
}

