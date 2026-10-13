import { cropAt, transformAt } from '@core/clip'
import type { Clip, Crop } from '@core/model'
import { sourcePixelSize } from '@core/ops/agent'
import { editor } from '../state/editor'
import { clearPreview, commitOp, previewOp } from '../state/ops'
import { getDoc } from '../state/project'
import { lockedAspectNormalized, pannedCrop, resizedCrop, type Corner } from './cropMath'
import { boxOf, toLocal, type Point, type Size } from './geometry'

const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const

const cornerOf = (sx: -1 | 1, sy: -1 | 1): Corner => (sy < 0 ? (sx < 0 ? 'topLeft' : 'topRight') : sx < 0 ? 'bottomLeft' : 'bottomRight')

/** On-canvas crop editor (§5.8): drag inside to pan the window, corners to resize. */
export function CropOverlay({ clip, frame, canvas, container }: { clip: Clip; frame: number; canvas: Size; container: () => DOMRect }) {
  const box = boxOf(transformAt(clip, frame), canvas)
  const crop = cropAt(clip, frame)
  const x0 = crop.left * box.w
  const x1 = box.w - crop.right * box.w
  const y0 = crop.top * box.h
  const y1 = box.h - crop.bottom * box.h

  const local = (e: { clientX: number; clientY: number }): Point => {
    const r = container()
    const l = toLocal(box, { x: e.clientX - r.left, y: e.clientY - r.top })
    return { x: (l.x + box.w / 2) / box.w, y: (l.y + box.h / 2) / box.h }
  }

  const drag = (e: React.PointerEvent, next: (start: Point, p: Point) => Crop) => {
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const start = local(e)
    let result: Crop | null = null
    const move = (ev: PointerEvent) => {
      result = next(start, local(ev))
      previewOp('setClipProperties', { ids: [clip.id], frame, patch: { crop: result } })
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      if (result) void commitOp('setClipProperties', { ids: [clip.id], frame, patch: { crop: result }, label: 'Change Crop' }, { quiet: true })
      else clearPreview()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const pan = (e: React.PointerEvent) => drag(e, (s, p) => pannedCrop(crop, { dx: p.x - s.x, dy: p.y - s.y }))

  // A fixed inspector aspect lock (Freeform / Original = free) keeps its pixel aspect while dragging a corner.
  const resize = (e: React.PointerEvent, sx: -1 | 1, sy: -1 | 1) => {
    const doc = getDoc()
    const src = doc ? sourcePixelSize(doc, clip) : null
    const aspectN = lockedAspectNormalized(editor().cropAspectLock, src && src.height > 0 ? src.width / src.height : null)
    drag(e, (s, p) => resizedCrop(crop, cornerOf(sx, sy), { dx: p.x - s.x, dy: p.y - s.y }, aspectN))
  }

  const w = x1 - x0
  const h = y1 - y0
  return (
    <div className="pp-crop" style={{ left: box.cx - box.w / 2, top: box.cy - box.h / 2, width: box.w, height: box.h, transform: `rotate(${box.rotation}deg)` }}>
      <div className="pp-crop-dim" style={{ left: 0, top: 0, right: 0, height: y0 }} />
      <div className="pp-crop-dim" style={{ left: 0, top: y1, right: 0, bottom: 0 }} />
      <div className="pp-crop-dim" style={{ left: 0, top: y0, width: x0, height: h }} />
      <div className="pp-crop-dim" style={{ left: x1, top: y0, right: 0, height: h }} />
      <div className="pp-crop-window" style={{ left: x0, top: y0, width: w, height: h }} onPointerDown={pan}>
        <span className="pp-crop-third v" style={{ left: '33.333%' }} />
        <span className="pp-crop-third v" style={{ left: '66.666%' }} />
        <span className="pp-crop-third h" style={{ top: '33.333%' }} />
        <span className="pp-crop-third h" style={{ top: '66.666%' }} />
        {CORNERS.map(([sx, sy]) => (
          <span
            key={`${sx}${sy}`}
            className="pp-crop-handle"
            style={{ left: sx < 0 ? -4 : undefined, right: sx > 0 ? -4 : undefined, top: sy < 0 ? -4 : undefined, bottom: sy > 0 ? -4 : undefined, cursor: sx === sy ? 'nwse-resize' : 'nesw-resize' }}
            onPointerDown={(e) => resize(e, sx, sy)}
          />
        ))}
      </div>
    </div>
  )
}
