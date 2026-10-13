import { cropAt, opacityAt, transformAt } from '@core/clip'
import type { Clip, Crop, Timeline, Transform } from '@core/model'
import { findClip } from '@core/timeline'

export interface Size {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

/** Largest rect with the timeline aspect that fits the area. */
export function fitRect(area: Size, aspect: number): Size {
  if (area.w <= 0 || area.h <= 0) return { w: 0, h: 0 }
  return area.w / area.h > aspect ? { w: Math.round(area.h * aspect), h: area.h } : { w: area.w, h: Math.round(area.w / aspect) }
}

export const rotate = (p: Point, deg: number): Point => {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/** Clip box in canvas pixels: center, size and clockwise rotation. */
export interface Box {
  cx: number
  cy: number
  w: number
  h: number
  rotation: number
}

export const boxOf = (t: Transform, canvas: Size): Box => ({ cx: t.centerX * canvas.w, cy: t.centerY * canvas.h, w: t.width * canvas.w, h: t.height * canvas.h, rotation: t.rotation })

/** Point in the box's unrotated local frame, origin at its center. */
export const toLocal = (b: Box, p: Point): Point => rotate({ x: p.x - b.cx, y: p.y - b.cy }, -b.rotation)

function visibleContains(b: Box, crop: Crop, p: Point): boolean {
  const l = toLocal(b, p)
  const x0 = -b.w / 2 + crop.left * b.w
  const x1 = b.w / 2 - crop.right * b.w
  const y0 = -b.h / 2 + crop.top * b.h
  const y1 = b.h / 2 - crop.bottom * b.h
  return l.x >= x0 && l.x <= x1 && l.y >= y0 && l.y <= y1
}

/** PreviewHitTester: text first (topmost track wins), then visual clips from track 0 down, testing the cropped rect. */
export function hitTestPreview(t: Timeline, frame: number, p: Point, canvas: Size): string | null {
  const candidates = (pred: (c: Clip) => boolean) =>
    t.tracks.flatMap((tr) => (tr.hidden ? [] : tr.clips.filter((c) => pred(c) && c.startFrame <= frame && frame < c.startFrame + c.durationFrames)))
  const hit = (c: Clip) => opacityAt(c, frame) > 0.01 && visibleContains(boxOf(transformAt(c, frame), canvas), c.mediaType === 'text' ? { left: 0, top: 0, right: 0, bottom: 0 } : cropAt(c, frame), p)
  const text = candidates((c) => c.mediaType === 'text').find(hit)
  if (text) return text.id
  return candidates((c) => c.mediaType !== 'text' && c.mediaType !== 'audio' && c.mediaType !== 'subtitle').find(hit)?.id ?? null
}

const isVisual = (c: Clip) => c.mediaType !== 'audio' && c.mediaType !== 'subtitle'

const visualClips = (t: Timeline, ids: string[]): Clip[] =>
  ids.flatMap((id) => {
    const c = findClip(t, id)?.clip
    return c && isVisual(c) ? [c] : []
  })

export const selectedVisualClip = (t: Timeline, ids: string[]): Clip | null => visualClips(t, ids)[0] ?? null

/** Crop editing needs exactly one selected visual clip (linked audio does not count). */
export function croppableClip(t: Timeline, ids: string[]): Clip | null {
  const v = visualClips(t, ids)
  return v.length === 1 && v[0].mediaType !== 'text' ? v[0] : null
}
