import { create } from 'zustand'
import { displayFrames } from '@core/timeline'
import type { Timeline } from '@core/model'
import { Layout, Zoom } from '../theme/sizes'
import { loadJSON, saveJSON } from '../state/persist'
import { playheadFrame } from '../state/playback'
import { getTimeline } from '../state/project'
import { runOp } from '../state/ops'

interface TimelineView {
  timelineId: string | null
  /** Pixels per frame. */
  zoom: number
  scrollX: number
  scrollY: number
  /** Visible width of the clip canvas (excludes header column and meter). */
  viewportWidth: number
  viewportHeight: number
  headerWidth: number
  /** Track ids with keyframe lanes open (view-local, reset per timeline). */
  lanes: string[]
  tabBarExpanded: boolean | null
  /** Fit-to-content once the viewport has been measured (first show without saved zoom). */
  pendingFit: boolean
}

const HEADER_KEY = 'timeline.headerWidth'

export const useTimelineView = create<TimelineView>(() => ({
  timelineId: null,
  zoom: Zoom.defaultPpf,
  scrollX: 0,
  scrollY: 0,
  viewportWidth: 0,
  viewportHeight: 0,
  headerWidth: loadJSON(HEADER_KEY, Layout.trackHeaderDefaultWidth),
  lanes: [],
  tabBarExpanded: null,
  pendingFit: false,
}))

const view = useTimelineView.getState
const setView = useTimelineView.setState

export function minZoom(t: Timeline | null, width = view().viewportWidth): number {
  const frames = t ? displayFrames(t) : 0
  if (frames === 0 || width <= 0) return Zoom.min
  return Math.min(Zoom.max, Math.max(Zoom.floor, width / (frames * 3)))
}

const clampZoom = (z: number, t: Timeline | null) => Math.min(Zoom.max, Math.max(minZoom(t), z))

/** Zoom keeping `anchorX` (viewport px) fixed; defaults to the playhead if visible, else centers it. */
export function setZoom(next: number, anchorX?: number): void {
  const t = getTimeline()
  const { zoom, scrollX, viewportWidth } = view()
  const z = clampZoom(next, t)
  if (z === zoom) return
  let ax = anchorX
  let frameAt: number
  if (ax === undefined) {
    const px = playheadFrame() * zoom - scrollX
    ax = px >= 0 && px <= viewportWidth ? px : viewportWidth / 2
    frameAt = playheadFrame()
  } else frameAt = (scrollX + ax) / zoom
  setView({ zoom: z, scrollX: Math.max(0, frameAt * z - ax) })
  scheduleViewStateSave()
}

export const zoomIn = () => setZoom(view().zoom * Zoom.toolbarStepFactor)
export const zoomOut = () => setZoom(view().zoom / Zoom.toolbarStepFactor)
/** End padding of View ▸ Zoom Timeline to Fit: the content fills ~95 % of the viewport. */
const FIT_PADDING = 1.05

/**
 * View ▸ Zoom Timeline to Fit — a Linux addition (the Mac has no fit command, 05 §6.10). The Mac's only fit rule is
 * `minZoomScale` (content fills one third of the viewport, `Zoom.fitAllBuffer` 3), which is the zoom floor and the first-show
 * zoom here too; using it for this command showed ~2:24 for a 48 s project. Fit = the whole content across the viewport.
 */
export function fitZoom(t: Timeline | null, width = view().viewportWidth): number {
  const frames = t ? displayFrames(t) : 0
  if (frames === 0 || width <= 0) return minZoom(t, width)
  return clampZoom(width / (frames * FIT_PADDING), t)
}

export function zoomToFit(): void {
  setView({ zoom: fitZoom(getTimeline()), scrollX: 0 })
  scheduleViewStateSave()
}

export function setScroll(x: number, y?: number): void {
  const s = view()
  const nx = Math.max(0, x)
  const ny = y === undefined ? s.scrollY : Math.max(0, y)
  if (nx !== s.scrollX || ny !== s.scrollY) setView({ scrollX: nx, scrollY: ny })
  scheduleViewStateSave()
}

export function setHeaderWidth(w: number): void {
  const min = view().lanes.length ? 220 : Layout.trackHeaderMinimumWidth
  const width = Math.round(Math.min(Layout.trackHeaderMaximumWidth, Math.max(min, w)))
  setView({ headerWidth: width })
  saveJSON(HEADER_KEY, width)
}

export function toggleLanes(trackId: string): void {
  const lanes = view().lanes
  setView({ lanes: lanes.includes(trackId) ? lanes.filter((x) => x !== trackId) : [...lanes, trackId] })
  if (view().lanes.length && view().headerWidth < 220) setView({ headerWidth: 220 })
}

let saveTimer = 0
function scheduleViewStateSave(): void {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const { timelineId, zoom, scrollX } = view()
    if (!timelineId) return
    void runOp('setViewState', { timelineId, state: { playheadFrame: playheadFrame(), zoomScale: zoom, scrollOffsetX: scrollX } }, { quiet: true })
  }, 600)
}

/** Called when the active timeline changes: restores its saved zoom/scroll or fits it on first show. */
export function enterTimeline(t: Timeline, saved: { zoomScale: number; scrollOffsetX: number } | undefined): void {
  const hasSaved = !!saved && saved.zoomScale > 0
  const empty = displayFrames(t) === 0
  const zoom = hasSaved ? saved.zoomScale : empty ? Zoom.defaultPpf : minZoom(t)
  setView({ timelineId: t.id, zoom, scrollX: saved?.scrollOffsetX ?? 0, scrollY: 0, lanes: [], pendingFit: !hasSaved && !empty && view().viewportWidth <= 0 })
}

/** Raises the zoom to the minimum after the content or viewport changes. */
export function enforceMinZoom(): void {
  const t = getTimeline()
  const z = view().zoom
  const m = minZoom(t)
  if (z < m) setView({ zoom: m })
}

export function setViewport(width: number, height: number): void {
  const s = view()
  if (s.viewportWidth === width && s.viewportHeight === height) return
  setView({ viewportWidth: width, viewportHeight: height })
  if (s.pendingFit && width > 0) setView({ zoom: minZoom(getTimeline(), width), scrollX: 0, pendingFit: false })
  else enforceMinZoom()
}
