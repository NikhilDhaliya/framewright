import { endFrame } from '@core/clip'
import type { Clip, Timeline } from '@core/model'
import type { DropTarget } from '@core/ops/clips'
import { supportsKeyframes, VISUAL_LANE_ORDER, type AnimatableProperty } from '@core/ops/properties'
import { firstAudioIndex } from '@core/timeline'
import { Layout } from '../theme/sizes'

export const RULER_H = Layout.rulerHeight
export const TRACKS_TOP = Layout.rulerHeight + Layout.dropZoneHeight
export const LANE_H = 24
export const LABEL_BAR_H = 16

export interface TrackLayout {
  index: number
  id: string
  top: number
  height: number
  lanes: AnimatableProperty[]
  /** Bottom of the row plus its keyframe lanes. */
  bottom: number
}

export function laneProperties(t: Timeline, trackIndex: number): AnimatableProperty[] {
  const tr = t.tracks[trackIndex]
  if (!tr || tr.type === 'audio') return []
  return VISUAL_LANE_ORDER.filter((p) => tr.clips.some((c) => supportsKeyframes(c, p)))
}

export function layoutTracks(t: Timeline, openLanes: string[]): TrackLayout[] {
  let y = TRACKS_TOP
  return t.tracks.map((tr, index) => {
    const lanes = openLanes.includes(tr.id) ? laneProperties(t, index) : []
    const top = y
    const bottom = top + tr.displayHeight + lanes.length * LANE_H
    y = bottom
    return { index, id: tr.id, top, height: tr.displayHeight, lanes, bottom }
  })
}

let layoutCache: { t: Timeline; lanes: string[]; layouts: TrackLayout[] } | null = null

/** Memoized layout for the displayed timeline (shared by the canvas and the header column). */
export function layoutsFor(t: Timeline, lanes: string[]): TrackLayout[] {
  if (layoutCache && layoutCache.t === t && layoutCache.lanes === lanes) return layoutCache.layouts
  const layouts = layoutTracks(t, lanes)
  layoutCache = { t, lanes, layouts }
  return layouts
}

export const contentBottom = (layouts: TrackLayout[]) => layouts[layouts.length - 1]?.bottom ?? TRACKS_TOP

export function trackAt(layouts: TrackLayout[], y: number): number {
  const i = layouts.findIndex((l) => y < l.bottom)
  return i >= 0 ? i : Math.max(0, layouts.length - 1)
}

export type RowHit = { kind: 'track'; index: number } | { kind: 'lane'; index: number; property: AnimatableProperty; laneTop: number } | null

export function rowAt(layouts: TrackLayout[], y: number): RowHit {
  for (const l of layouts) {
    if (y < l.top || y >= l.bottom) continue
    if (y < l.top + l.height) return { kind: 'track', index: l.index }
    const li = Math.floor((y - l.top - l.height) / LANE_H)
    return { kind: 'lane', index: l.index, property: l.lanes[li], laneTop: l.top + l.height + li * LANE_H }
  }
  return null
}

/** §14.2 dropTargetAt: insertion lines within ±10 px of a boundary, else an existing track. */
export function dropTargetAt(layouts: TrackLayout[], y: number): DropTarget {
  const n = layouts.length
  if (n === 0 || y < layouts[0].top) return { newAt: 0 }
  for (let i = 0; i < n - 1; i++) {
    if (layouts[i].bottom - Layout.insertThreshold <= y && y <= layouts[i + 1].top + Layout.insertThreshold) return { newAt: i + 1 }
  }
  if (y >= layouts[n - 1].bottom) return { newAt: n }
  return { existing: trackAt(layouts, y) }
}

export function insertionLineY(layouts: TrackLayout[], k: number): number {
  return k < layouts.length ? layouts[k].top : contentBottom(layouts)
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const clipRect = (c: Clip, l: TrackLayout, ppf: number): Rect => ({ x: c.startFrame * ppf, y: l.top + 2, w: c.durationFrames * ppf, h: l.height - 4 })

/** First clip index whose end lies after `frame` (clips are sorted by start and don't overlap). */
export function firstVisibleClip(clips: Clip[], frame: number): number {
  let lo = 0
  let hi = clips.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (endFrame(clips[mid]) <= frame) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function clipAtFrame(clips: Clip[], frame: number): Clip | null {
  const i = firstVisibleClip(clips, frame)
  const c = clips[i]
  return c && c.startFrame <= frame && frame < endFrame(c) ? c : null
}

export const isAudioZone = (t: Timeline, i: number) => i >= firstAudioIndex(t)

export const frameAtX = (x: number, ppf: number) => Math.max(0, Math.trunc(x / ppf))
