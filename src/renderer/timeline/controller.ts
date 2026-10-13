import { endFrame, sourceFramesConsumed } from '@core/clip'
import { removeKeyframe, upsertKeyframe } from '@core/keyframes'
import { isCompatibleType, type Clip, type Timeline, type TimelineMarker } from '@core/model'
import { effectiveTrimEnd, gapAt, type ClipMove, type DropTarget, type Edge } from '@core/ops/clips'
import type { Doc } from '@core/ops/context'
import { keyframeFrames, supportsKeyframes, VISUAL_LANE_ORDER, type AnimatableProperty } from '@core/ops/properties'
import { expandToLinkGroup, findClip, linkedPartnerIds } from '@core/timeline'
import { AutoScroll, ComponentSize, Layout, TimelineMarker as MarkerSize, Trim } from '../theme/sizes'
import { editor, selectClips, setEditor } from '../state/editor'
import { clearPreview, commitOp, previewOp, runOp } from '../state/ops'
import { beginScrub, endScrub, pause, playheadFrame, scrub, seek } from '../state/playback'
import { activatePreviewTab, usePreviewTabs } from '../state/previewTabs'
import { rippleMarkersEnabled } from '../state/settings'
import { toast } from '../ui/toast'
import { revealAsset, splitClipAt } from './actions'
import { CURSOR_SLIP, CURSOR_TRIM_LEFT, CURSOR_TRIM_RIGHT } from './cursors'
import { kneeRects, volumeKeyY, type DragVisual } from './draw'
import { clipAtFrame, clipRect, dropTargetAt, frameAtX, insertionLineY, LABEL_BAR_H, RULER_H, rowAt, type Rect, type TrackLayout } from './geometry'
import { Snapper, snapTargets } from './snap'
import { activateTimeline } from './tabs'
import { setScroll, useTimelineView } from './view'
import { t } from '../i18n'

export interface TimelineModel {
  doc: Doc
  baseDoc: Doc
  /** Displayed timeline (live preview if any). */
  t: Timeline
  /** Authoritative timeline from main. */
  base: Timeline
  layouts: TrackLayout[]
  ppf: number
  scrollX: number
  scrollY: number
  width: number
  height: number
}

export interface ControllerHost {
  model(): TimelineModel | null
  rect(): DOMRect
  redraw(): void
  setCursor(cursor: string): void
}

export interface Pointer {
  cx: number
  cy: number
  vx: number
  vy: number
  shift: boolean
  alt: boolean
  ctrl: boolean
}

interface Drag {
  move(p: Pointer): void
  end(p: Pointer): void | Promise<void>
  /** Escape support (slip, keyframe and marker drags only). */
  cancel?(): void
  autoScroll?: boolean
}

export type HitTarget =
  | { kind: 'marker'; marker: TimelineMarker }
  | { kind: 'ruler' }
  | { kind: 'lane'; trackIndex: number; property: AnimatableProperty; clip: Clip | null; keyframe: number | null }
  | { kind: 'knee'; clip: Clip; edge: 'in' | 'out' }
  | { kind: 'volumeKey'; clip: Clip; frame: number }
  | { kind: 'clip'; clip: Clip; trackIndex: number; rect: Rect; local: number }
  | { kind: 'empty'; trackIndex: number | null }

const DOUBLE_CLICK_MS = 400
const inflate = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d })
const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
const centered = (r: Rect, size: number): Rect => ({ x: r.x + r.w / 2 - size / 2, y: r.y + r.h / 2 - size / 2, w: size, h: size })
/**
 * 05 §13.1: window managers may grab Alt+drag, so Ctrl+Shift stands in for Alt on clip and marker
 * drags (duplicate, act on one clip ignoring links, no trim edges; marker duration).
 */
const altLike = (p: Pointer): Pointer => (p.ctrl && p.shift ? { ...p, alt: true, shift: false, ctrl: false } : p)
const rangeOf = () => {
  const r = editor().range
  return r && r.start !== r.end ? { start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) } : null
}

/** Timeline canvas input: the §15.2 mouse-down decision tree, live previews and one commit per gesture. */
export class TimelineController {
  readonly visual: DragVisual = {}
  hoverClipId: string | null = null
  private drag: Drag | null = null
  private last: Pointer | null = null
  private lastDown = { time: 0, x: 0, y: 0 }
  private autoTimer = 0
  private razorSnap: Snapper | null = null

  constructor(private readonly host: ControllerHost) {}

  get dragging(): boolean {
    return this.drag !== null
  }

  pointer(e: { clientX: number; clientY: number; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey?: boolean }, m: TimelineModel): Pointer {
    const r = this.host.rect()
    const vx = e.clientX - r.left
    const vy = e.clientY - r.top
    return { vx, vy, cx: vx + m.scrollX, cy: vy + m.scrollY, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || !!e.metaKey }
  }

  // ---------- Hit testing ----------

  markerAt(m: TimelineModel, p: Pointer): TimelineMarker | null {
    if (p.vy > MarkerSize.flagHeight + MarkerSize.hitSlop) return null
    for (let i = m.t.markers.length - 1; i >= 0; i--) {
      const mk = m.t.markers[i]
      const x = mk.startFrame * m.ppf
      const rects: Rect[] =
        mk.durationFrames > 0
          ? [{ x: x - 5, y: 0, w: 5, h: 12 }, { x: (mk.startFrame + mk.durationFrames) * m.ppf, y: 0, w: 5, h: 12 }]
          : [{ x: x - 5, y: 0, w: 10, h: 12 }]
      if (rects.some((r) => inside(inflate(r, MarkerSize.hitSlop), p.cx, p.vy))) return mk
    }
    return null
  }

  hitTest(m: TimelineModel, p: Pointer): HitTarget {
    if (p.vy < RULER_H) {
      const mk = this.markerAt(m, p)
      return mk ? { kind: 'marker', marker: mk } : { kind: 'ruler' }
    }
    const row = rowAt(m.layouts, p.cy)
    if (!row) return { kind: 'empty', trackIndex: null }
    const track = m.t.tracks[row.index]
    const frame = p.cx / m.ppf
    if (row.kind === 'lane') {
      if (!row.property) return { kind: 'empty', trackIndex: row.index }
      let best: { clip: Clip; frame: number; d: number } | null = null
      for (const c of track.clips) {
        if (!supportsKeyframes(c, row.property)) continue
        for (const f of keyframeFrames(c, row.property)) {
          const d = Math.abs(f * m.ppf - p.cx)
          if (d <= 7 && (!best || d < best.d || (d === best.d && editor().selectedClipIds.includes(c.id)))) best = { clip: c, frame: f, d }
        }
      }
      if (best) return { kind: 'lane', trackIndex: row.index, property: row.property, clip: best.clip, keyframe: best.frame }
      const c = clipAtFrame(track.clips, frame)
      return { kind: 'lane', trackIndex: row.index, property: row.property, clip: c && supportsKeyframes(c, row.property) ? c : null, keyframe: null }
    }
    const c = clipAtFrame(track.clips, frame)
    if (!c) return { kind: 'empty', trackIndex: row.index }
    const l = m.layouts[row.index]
    const r = clipRect(c, l, m.ppf)
    const selected = editor().selectedClipIds.includes(c.id)
    if (r.w >= ComponentSize.timelineClipControlsMinWidth && (selected || this.hoverClipId === c.id)) {
      const knees = kneeRects(c, r, m.ppf)
      if (inside(centered(knees.left, 14), p.cx, p.cy)) return { kind: 'knee', clip: c, edge: 'in' }
      if (inside(centered(knees.right, 14), p.cx, p.cy)) return { kind: 'knee', clip: c, edge: 'out' }
    }
    if (c.mediaType === 'audio' && selected && r.w >= ComponentSize.timelineClipControlsMinWidth && !l.lanes.length) {
      for (const k of c.volumeTrack?.keyframes ?? []) {
        const kx = r.x + k.frame * m.ppf
        if (inside({ x: kx - 7, y: volumeKeyY(k.value, r) - 7, w: 14, h: 14 }, p.cx, p.cy)) return { kind: 'volumeKey', clip: c, frame: k.frame }
      }
    }
    return { kind: 'clip', clip: c, trackIndex: row.index, rect: r, local: p.cx - r.x }
  }

  private onTrimHandle(hit: Extract<HitTarget, { kind: 'clip' }>, alt: boolean): Edge | null {
    if (alt || hit.rect.w < ComponentSize.timelineClipControlsMinWidth) return null
    if (hit.local <= Trim.handleWidth) return 'left'
    if (hit.local >= hit.rect.w - Trim.handleWidth) return 'right'
    return null
  }

  // ---------- Hover ----------

  hover(e: PointerEvent): void {
    const m = this.host.model()
    if (!m || this.drag) return
    const p = this.pointer(e, m)
    const hit = this.hitTest(m, p)
    const hoverId = hit.kind === 'clip' || hit.kind === 'knee' || hit.kind === 'volumeKey' ? hit.clip.id : null
    let redraw = hoverId !== this.hoverClipId
    this.hoverClipId = hoverId
    const tool = editor().tool
    if (tool === 'razor') {
      this.razorSnap ??= new Snapper(snapTargets(m.t, { playhead: playheadFrame() }))
      const f = p.vy >= RULER_H ? frameAtX(p.cx, m.ppf) : null
      const snap = f === null ? null : this.razorSnap.find(f, [0], m.ppf)
      const rf = f === null ? null : (snap?.frame ?? f)
      if (rf !== this.visual.razorFrame) {
        this.visual.razorFrame = rf
        redraw = true
      }
    } else if (this.visual.razorFrame !== undefined && this.visual.razorFrame !== null) {
      this.visual.razorFrame = null
      this.razorSnap = null
      redraw = true
    }
    this.host.setCursor(this.cursorFor(m, p, hit, tool))
    if (redraw) this.host.redraw()
  }

  leave(): void {
    if (this.drag) return
    this.hoverClipId = null
    this.visual.razorFrame = null
    this.razorSnap = null
    this.host.redraw()
  }

  private cursorFor(m: TimelineModel, p: Pointer, hit: HitTarget, tool: string): string {
    switch (hit.kind) {
      case 'marker':
        return altLike(p).alt ? 'col-resize' : 'grab'
      case 'ruler': {
        const r = rangeOf()
        if (r && (Math.abs(r.start * m.ppf - p.cx) <= 8 || Math.abs(r.end * m.ppf - p.cx) <= 8)) return 'col-resize'
        return p.shift ? 'crosshair' : 'pointer'
      }
      case 'lane':
        return hit.keyframe !== null ? 'grab' : 'pointer'
      case 'knee':
        return 'col-resize'
      case 'volumeKey':
        return 'grab'
      case 'clip': {
        if (tool === 'razor') return 'crosshair'
        const edge = this.onTrimHandle(hit, altLike(p).alt)
        if (edge) return edge === 'left' ? CURSOR_TRIM_LEFT : CURSOR_TRIM_RIGHT
        if (tool === 'trim') return hit.clip.mediaType === 'image' || hit.clip.mediaType === 'text' || hit.clip.multicamGroupId ? 'not-allowed' : CURSOR_SLIP
        return 'default'
      }
      case 'empty':
        return tool === 'razor' ? 'crosshair' : 'default'
    }
  }

  // ---------- Pointer down ----------

  down(e: PointerEvent): void {
    const m = this.host.model()
    if (!m || e.button !== 0) return
    let p = this.pointer(e, m)
    const now = performance.now()
    const isDouble = now - this.lastDown.time < DOUBLE_CLICK_MS && Math.abs(this.lastDown.x - p.vx) < 5 && Math.abs(this.lastDown.y - p.vy) < 5
    this.lastDown = { time: isDouble ? 0 : now, x: p.vx, y: p.vy }
    if (usePreviewTabs.getState().active !== 'timeline') activatePreviewTab('timeline')
    const hit = this.hitTest(m, p)
    const tool = editor().tool

    if (hit.kind === 'marker') {
      if (isDouble) {
        setEditor({ selectedMarkerIds: [hit.marker.id], markerEditorId: hit.marker.id })
        return
      }
      return this.start(this.markerDrag(m, altLike(p), hit.marker))
    }
    if (isDouble && hit.kind === 'clip') {
      if (hit.clip.sourceClipType === 'sequence') activateTimeline(hit.clip.mediaRef)
      else if (hit.clip.mediaRef) revealAsset(hit.clip.mediaRef)
      return
    }
    if (hit.kind === 'ruler') {
      const r = rangeOf()
      if (r) {
        const ds = Math.abs(r.start * m.ppf - p.cx)
        const de = Math.abs(r.end * m.ppf - p.cx)
        if (Math.min(ds, de) <= 8) return this.start(this.rangeDrag(m, ds <= de ? r.end : r.start))
      }
      if (p.shift) {
        const f = frameAtX(p.cx, m.ppf)
        setEditor({ selectedClipIds: [], selectedGap: null, range: { start: f, end: f } })
        return this.start(this.rangeDrag(m, f))
      }
      setEditor({ selectedMarkerIds: [] })
      return this.start(this.scrubDrag(m, p))
    }
    if (hit.kind === 'lane') return this.laneDown(m, p, hit)
    setEditor({ selectedGap: null })
    if (tool === 'razor') {
      if (hit.kind === 'clip' || hit.kind === 'knee' || hit.kind === 'volumeKey') void splitClipAt(hit.clip.id, this.visual.razorFrame ?? frameAtX(p.cx, m.ppf))
      return
    }
    if (hit.kind === 'empty') return this.start(this.marqueeDrag(m, p, hit.trackIndex))

    setEditor({ selectedMarkerIds: [] })
    const clip = hit.clip
    p = altLike(p)
    const onHandle = hit.kind === 'clip' && this.onTrimHandle(hit, p.alt) !== null
    this.applyClickSelection(m.t, clip, p, onHandle)
    if (hit.kind === 'knee') return this.start(this.fadeDrag(m, p, clip, hit.edge))
    if (hit.kind === 'volumeKey') return this.start(this.volumeKeyDrag(m, clip, hit.frame))
    if (p.ctrl && !p.shift && clip.mediaType === 'audio') return this.addVolumeKey(m, p, hit)
    const edge = this.onTrimHandle(hit, p.alt)
    if (edge) return this.start(this.trimDrag(m, clip, edge, p.shift, !p.alt))
    if (tool === 'trim') {
      if (clip.multicamGroupId) return void toast(t("Can't slip a multicam clip — it would go out of sync with the group."))
      if (clip.mediaType === 'image' || clip.mediaType === 'text') return
      return this.start(this.slipDrag(m, p, clip, !p.alt))
    }
    this.start(this.moveDrag(m, p, clip, hit.trackIndex, p.alt))
  }

  /** §4.17 click selection rules. */
  private applyClickSelection(t: Timeline, c: Clip, p: Pointer, onHandle: boolean): void {
    const linkedOn = !p.alt
    const sel = new Set(editor().selectedClipIds)
    const group = linkedOn ? expandToLinkGroup(t, [c.id]) : new Set([c.id])
    const selected = sel.has(c.id)
    if (p.shift && onHandle) {
      if (!selected) selectClips([...group])
    } else if (p.shift) {
      if (selected) for (const id of group) sel.delete(id)
      else for (const id of group) sel.add(id)
      selectClips([...sel])
    } else if (!selected) selectClips([...group])
  }

  private start(d: Drag | undefined): void {
    if (!d) return
    this.drag = d
  }

  move(e: PointerEvent): void {
    const m = this.host.model()
    if (!m || !this.drag) return
    const p = this.pointer(e, m)
    this.last = p
    this.drag.move(p)
    if (this.drag.autoScroll) this.updateAutoScroll(p, m)
  }

  async up(e: PointerEvent): Promise<void> {
    const m = this.host.model()
    const d = this.drag
    this.stopAutoScroll()
    if (!d || !m) return
    this.drag = null
    await d.end(this.pointer(e, m))
    this.resetVisual()
  }

  /** Escape: cancels slip, keyframe and marker drags. Returns true if a drag consumed the key. */
  cancel(): boolean {
    if (!this.drag?.cancel) return false
    this.drag.cancel()
    this.drag = null
    this.stopAutoScroll()
    this.resetVisual()
    return true
  }

  private resetVisual(): void {
    const razor = this.visual.razorFrame
    for (const k of Object.keys(this.visual)) delete (this.visual as Record<string, unknown>)[k]
    this.visual.razorFrame = razor
    setEditor({ marqueeCount: null })
    this.host.redraw()
  }

  private updateAutoScroll(p: Pointer, m: TimelineModel): void {
    const zone = Math.min(AutoScroll.edgeZoneWidth, m.width * AutoScroll.maxZoneFraction)
    const depth = p.vx < zone ? (zone - p.vx) / zone : p.vx > m.width - zone ? -(p.vx - (m.width - zone)) / zone : 0
    if (!depth) return this.stopAutoScroll()
    if (this.autoTimer) return
    this.autoTimer = window.setInterval(() => {
      const mm = this.host.model()
      const lp = this.last
      if (!mm || !lp || !this.drag) return this.stopAutoScroll()
      const z = Math.min(AutoScroll.edgeZoneWidth, mm.width * AutoScroll.maxZoneFraction)
      const d = lp.vx < z ? -(z - lp.vx) / z : lp.vx > mm.width - z ? (lp.vx - (mm.width - z)) / z : 0
      if (!d) return this.stopAutoScroll()
      const stepPx = Math.sign(d) * (AutoScroll.minStep + (AutoScroll.maxStep - AutoScroll.minStep) * Math.min(1, Math.abs(d)))
      setScroll(mm.scrollX + stepPx)
      const sx = useTimelineView.getState().scrollX
      const np = { ...lp, cx: lp.vx + sx }
      this.last = np
      this.drag.move(np)
    }, 1000 / 60)
  }

  private stopAutoScroll(): void {
    window.clearInterval(this.autoTimer)
    this.autoTimer = 0
  }

  // ---------- Drags ----------

  private scrubDrag(m: TimelineModel, p: Pointer): Drag {
    beginScrub()
    scrub(frameAtX(p.cx, m.ppf))
    return {
      autoScroll: true,
      move: (q) => scrub(frameAtX(q.cx, this.host.model()?.ppf ?? m.ppf)),
      end: () => endScrub(),
    }
  }

  private rangeDrag(m: TimelineModel, anchor: number): Drag {
    const snapper = new Snapper(snapTargets(m.t, { playhead: playheadFrame() }))
    return {
      autoScroll: true,
      move: (q) => {
        const mm = this.host.model() ?? m
        const f = frameAtX(q.cx, mm.ppf)
        const s = snapper.find(f, [0], mm.ppf)
        this.visual.snapFrame = s?.frame ?? null
        setEditor({ range: { start: anchor, end: s?.frame ?? f }, selectedMarkerIds: [] })
        this.host.redraw()
      },
      end: () => {
        const r = editor().range
        setEditor({ range: r && r.start !== r.end ? { start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) } : null })
      },
    }
  }

  private markerDrag(m: TimelineModel, p: Pointer, marker: TimelineMarker): Drag {
    setEditor({ selectedMarkerIds: [marker.id], selectedClipIds: [], selectedGap: null, range: null })
    const duration = p.alt
    const grab = frameAtX(p.cx, m.ppf)
    const snapper = new Snapper(snapTargets(m.t, { playhead: playheadFrame(), excludeMarker: marker.id }))
    let current: TimelineMarker = marker
    return {
      move: (q) => {
        const mm = this.host.model() ?? m
        const f = frameAtX(q.cx, mm.ppf)
        if (duration) {
          const s = snapper.find(f, [0], mm.ppf)
          const end = Math.max(marker.startFrame, s?.frame ?? f)
          current = { ...marker, durationFrames: end - marker.startFrame }
          this.visual.snapFrame = s?.frame ?? null
        } else {
          const raw = marker.startFrame + f - grab
          const s = snapper.find(raw, [0, marker.durationFrames], mm.ppf)
          current = { ...marker, startFrame: Math.max(0, s ? s.frame - s.probeOffset : raw) }
          this.visual.snapFrame = s?.frame ?? null
        }
        if (current.startFrame === marker.startFrame && current.durationFrames === marker.durationFrames) clearPreview()
        else previewOp('changeMarkers', { updates: [current] })
        this.host.redraw()
      },
      end: async () => {
        if (current.startFrame === marker.startFrame && current.durationFrames === marker.durationFrames) return clearPreview()
        const ok = await commitOp('changeMarkers', { updates: [current], label: duration ? 'Change Marker Duration' : 'Move Marker' }, { quiet: true })
        if (ok === undefined) toast(t("Couldn't change marker."))
      },
      cancel: () => clearPreview(),
    }
  }

  private marqueeDrag(m: TimelineModel, p: Pointer, trackIndex: number | null): Drag {
    const base = p.shift ? new Set(editor().selectedClipIds) : new Set<string>()
    const baseMarkers = p.shift ? editor().selectedMarkerIds : []
    if (!p.shift) setEditor({ selectedClipIds: [], selectedMarkerIds: [] })
    const gap = trackIndex !== null ? gapAt(m.t, trackIndex, frameAtX(p.cx, m.ppf)) : null
    setEditor({ selectedGap: gap })
    const ox = p.cx
    const oy = p.cy
    return {
      autoScroll: true,
      move: (q) => {
        const mm = this.host.model() ?? m
        const rect: Rect = { x: Math.min(ox, q.cx), y: Math.min(oy, q.cy), w: Math.abs(q.cx - ox), h: Math.abs(q.cy - oy) }
        if (rect.w <= Layout.dragThreshold && rect.h <= Layout.dragThreshold) return
        this.visual.marquee = rect
        const hits: string[] = []
        for (const l of mm.layouts) {
          if (l.top + l.height < rect.y || l.top > rect.y + rect.h) continue
          for (const c of mm.t.tracks[l.index].clips) {
            const r = clipRect(c, l, mm.ppf)
            if (r.x < rect.x + rect.w && r.x + r.w > rect.x && r.y < rect.y + rect.h && r.y + r.h > rect.y) hits.push(c.id)
          }
        }
        const expanded = q.alt ? hits : [...expandToLinkGroup(mm.t, hits)]
        const sel = [...new Set([...base, ...expanded])]
        const vTop = rect.y - mm.scrollY
        const markerHits = vTop < MarkerSize.flagHeight ? mm.t.markers.filter((mk) => {
          const x = mk.startFrame * mm.ppf
          const x2 = (mk.startFrame + mk.durationFrames) * mm.ppf
          return x2 + 5 >= rect.x && x - 5 <= rect.x + rect.w
        }).map((mk) => mk.id) : []
        setEditor({ selectedClipIds: sel, selectedGap: null, selectedMarkerIds: [...new Set([...baseMarkers, ...markerHits])], marqueeCount: sel.length })
        this.host.redraw()
      },
      end: () => setEditor({ marqueeCount: null }),
    }
  }

  private moveDrag(m: TimelineModel, p: Pointer, lead: Clip, leadTrack: number, duplicate: boolean): Drag {
    const sel = new Set(editor().selectedClipIds)
    sel.add(lead.id)
    const participants = m.t.tracks.flatMap((tr, ti) => tr.clips.filter((c) => sel.has(c.id)).map((c) => ({ clip: c, track: ti })))
    const leadType = m.t.tracks[leadTrack].type
    const pinned = new Set(participants.filter((q) => q.clip.id !== lead.id && ((lead.linkGroupId && q.clip.linkGroupId === lead.linkGroupId) || !isCompatibleType(q.clip.mediaType, leadType))).map((q) => q.clip.id))
    const grabOffset = frameAtX(p.cx, m.ppf) - lead.startFrame
    const minStart = Math.min(...participants.map((q) => q.clip.startFrame))
    const probes = participants.flatMap((q) => [q.clip.startFrame - lead.startFrame, q.clip.startFrame - lead.startFrame + q.clip.durationFrames])
    const snapper = new Snapper(snapTargets(m.t, { playhead: playheadFrame(), exclude: sel }))
    const origin = { x: p.vx, y: p.vy }
    let moved = false
    let pending: { preview: () => boolean; commit: () => Promise<string[] | void | undefined> } | null = null
    const clampedTrackDelta = (proposed: number): number => {
      for (let d = proposed; d !== 0; d -= Math.sign(d)) {
        const ok = participants.every((q) => pinned.has(q.clip.id) || (m.t.tracks[q.track + d] && isCompatibleType(m.t.tracks[q.track + d].type, q.clip.mediaType)))
        if (ok) return d
      }
      return 0
    }
    const baseIds = new Set(m.t.tracks.flatMap((tr) => tr.clips.map((c) => c.id)))
    return {
      autoScroll: true,
      move: (q) => {
        const mm = this.host.model() ?? m
        if (!moved && Math.hypot(q.vx - origin.x, q.vy - origin.y) <= Layout.dragThreshold) return
        moved = true
        const candidate = frameAtX(q.cx, mm.ppf) - grabOffset
        const s = snapper.find(candidate, probes, mm.ppf)
        let delta = s ? s.frame - s.probeOffset - lead.startFrame : candidate - lead.startFrame
        delta = Math.max(-minStart, delta)
        this.visual.snapFrame = s?.frame ?? null
        const cursor: DropTarget = dropTargetAt(mm.layouts, q.cy)
        const target: DropTarget = 'existing' in cursor ? { existing: leadTrack + clampedTrackDelta(cursor.existing - leadTrack) } : cursor
        this.visual.insertionY = 'newAt' in target ? insertionLineY(mm.layouts, target.newAt) : null
        if ('existing' in target) {
          const d = target.existing - leadTrack
          if (d === 0 && delta === 0) {
            pending = null
            clearPreview()
            this.visual.originals = undefined
            this.visual.ghostIds = undefined
            this.host.redraw()
            return
          }
          const moves: ClipMove[] = participants.map((x) => ({ clipId: x.clip.id, toTrack: pinned.has(x.clip.id) ? x.track : x.track + d, toFrame: x.clip.startFrame + delta }))
          pending = duplicate
            ? { preview: () => previewOp('duplicateClips', { moves }), commit: () => commitOp('duplicateClips', { moves }) }
            : { preview: () => previewOp('moveClips', { moves }), commit: () => commitOp('moveClips', { moves }) }
        } else {
          const args = { moves: participants.map((x) => ({ clipId: x.clip.id, toTrack: x.track, toFrame: x.clip.startFrame + delta })), newTrackAt: target.newAt, type: leadType, leadTrack, pinned: [...pinned], duplicate }
          pending = { preview: () => previewOp('moveClipsToNewTrack', args), commit: () => commitOp('moveClipsToNewTrack', args) }
        }
        if (!pending.preview()) clearPreview()
        if (duplicate) {
          const preview = this.host.model()?.t
          this.visual.ghostIds = new Set(preview ? preview.tracks.flatMap((tr) => tr.clips.filter((c) => !baseIds.has(c.id)).map((c) => c.id)) : [])
          this.visual.originals = undefined
        } else {
          this.visual.ghostIds = new Set(participants.map((x) => x.clip.id))
          this.visual.originals = participants.map((x) => ({ clip: x.clip, trackIndex: x.track }))
          this.visual.originalsAlpha = 0.3
        }
        this.visual.ghostAlpha = 0.7
        this.host.redraw()
      },
      end: async () => {
        if (!moved || !pending) return clearPreview()
        const result = await pending.commit()
        if (duplicate && Array.isArray(result)) selectClips(result)
      },
    }
  }

  private trimDrag(m: TimelineModel, clip: Clip, edge: Edge, ripple: boolean, linked: boolean): Drag {
    const partners = linked ? linkedPartnerIds(m.t, clip.id).map((id) => findClip(m.t, id)?.clip).filter((c): c is Clip => !!c) : []
    const group = [clip, ...partners]
    const headLeft = Math.min(...group.map((c) => c.trimStartFrame))
    const headRight = Math.min(...group.map((c) => effectiveTrimEnd(m.baseDoc, c)))
    const noSource = clip.mediaType === 'image' || clip.mediaType === 'text'
    const exclude = new Set([clip.id])
    const snapper = new Snapper(snapTargets(m.t, { playhead: playheadFrame(), exclude }))
    const origStart = clip.startFrame
    const origEnd = endFrame(clip)
    const dur = clip.durationFrames
    let delta = 0
    return {
      autoScroll: true,
      move: (q) => {
        const mm = this.host.model() ?? m
        const f = frameAtX(q.cx, mm.ppf)
        if (edge === 'left') {
          const s = snapper.find(f, [0], mm.ppf)
          delta = (s?.frame ?? f) - origStart
          delta = Math.min(dur - 1, Math.max(noSource ? -origStart : -headLeft, delta))
          this.visual.snapFrame = s?.frame ?? null
        } else {
          const cand = Math.max(origStart + 1, f)
          const s = snapper.find(cand, [0], mm.ppf)
          delta = Math.max(-(dur - 1), (s?.frame ?? cand) - origEnd)
          if (!noSource) delta = Math.min(delta, headRight)
          this.visual.snapFrame = s?.frame ?? null
        }
        if (delta === 0) clearPreview()
        else if (ripple) previewOp('rippleTrim', { id: clip.id, edge, delta, linked, rippleMarkers: rippleMarkersEnabled() })
        else previewOp('trimEdge', { id: clip.id, edge, delta, linked })
        this.host.redraw()
      },
      end: async () => {
        if (delta === 0) return clearPreview()
        if (ripple) await commitOp('rippleTrim', { id: clip.id, edge, delta, linked, rippleMarkers: rippleMarkersEnabled() })
        else await commitOp('trimEdge', { id: clip.id, edge, delta, linked })
      },
    }
  }

  private slipDrag(m: TimelineModel, p: Pointer, clip: Clip, linked: boolean): Drag {
    const eligible = (c: Clip) => c.mediaType !== 'image' && c.mediaType !== 'text' && !c.multicamGroupId
    const targets = [clip, ...(linked ? linkedPartnerIds(m.t, clip.id).map((id) => findClip(m.t, id)?.clip).filter((c): c is Clip => !!c) : [])].filter(eligible)
    const maxRight = Math.min(...targets.map((c) => Math.floor(c.trimStartFrame / Math.max(c.speed, 0.001))))
    const maxLeft = Math.min(...targets.map((c) => Math.floor(effectiveTrimEnd(m.baseDoc, c) / Math.max(c.speed, 0.001))))
    const grab = frameAtX(p.cx, m.ppf)
    let delta = 0
    this.visual.slipClipId = clip.id
    // Two-up source: the grabbed clip when visual, else its linked video partner (03 §4.11).
    const shown = clip.mediaType !== 'audio' ? clip : targets.find((c) => c.mediaType !== 'audio')
    const publish = () => {
      if (!shown) return
      const applied = Math.min(shown.trimStartFrame, Math.max(-effectiveTrimEnd(m.baseDoc, shown), Math.round(delta * shown.speed)))
      const startFrame = shown.trimStartFrame - applied
      setEditor({ slipPreview: { clipId: shown.id, startFrame, endFrame: startFrame + Math.max(0, sourceFramesConsumed(shown) - 1) } })
    }
    const clearSlip = () => setEditor({ slipPreview: null })
    publish()
    return {
      move: (q) => {
        const mm = this.host.model() ?? m
        delta = Math.min(maxRight, Math.max(-maxLeft, frameAtX(q.cx, mm.ppf) - grab))
        publish()
        if (delta === 0) clearPreview()
        else previewOp('slipClip', { id: clip.id, delta, linked })
        this.host.redraw()
      },
      end: async () => {
        clearSlip()
        if (delta === 0) return clearPreview()
        await commitOp('slipClip', { id: clip.id, delta, linked })
      },
      cancel: () => {
        clearSlip()
        clearPreview()
      },
    }
  }

  private fadeDrag(m: TimelineModel, p: Pointer, clip: Clip, which: 'in' | 'out'): Drag {
    const grab = frameAtX(p.cx, m.ppf)
    const orig = which === 'in' ? clip.fadeInFrames : clip.fadeOutFrames
    const cap = Math.max(0, clip.durationFrames - (which === 'in' ? clip.fadeOutFrames : clip.fadeInFrames))
    let value = orig
    const patchFor = (v: number) => (which === 'in' ? { fadeIn: v } : { fadeOut: v })
    return {
      move: (q) => {
        const mm = this.host.model() ?? m
        const d = frameAtX(q.cx, mm.ppf) - grab
        value = Math.min(cap, Math.max(0, orig + (which === 'in' ? d : -d)))
        if (value === orig) clearPreview()
        else previewOp('setClipProperties', { ids: [clip.id], frame: playheadFrame(), patch: patchFor(value) })
        this.host.redraw()
      },
      end: async () => {
        if (value === orig) return clearPreview()
        await commitOp('setClipProperties', { ids: [clip.id], frame: playheadFrame(), patch: patchFor(value), label: which === 'in' ? 'Change Fade In' : 'Change Fade Out' })
      },
    }
  }

  private volumeAtY(r: Rect, y: number): number {
    const top = r.y + LABEL_BAR_H
    const h = r.h - LABEL_BAR_H - 1
    const db = 6 - Math.min(1, Math.max(0, (y - top) / h)) * 66
    return Math.min(15, Math.max(-60, db))
  }

  private volumeKeyDrag(m: TimelineModel, clip: Clip, frame: number): Drag {
    const keys = clip.volumeTrack?.keyframes ?? []
    const idx = keys.findIndex((k) => k.frame === frame)
    const key = keys[idx]
    const lo = idx > 0 ? keys[idx - 1].frame + 1 : 0
    const hi = idx < keys.length - 1 ? keys[idx + 1].frame - 1 : clip.durationFrames - 1
    const l = m.layouts[findClip(m.t, clip.id)!.trackIndex]
    let next = clip
    const build = (f: number, db: number): Clip => ({ ...clip, volumeTrack: upsertKeyframe(removeKeyframe(clip.volumeTrack, frame), { ...key, frame: f, value: db }) })
    return {
      move: (q) => {
        const mm = this.host.model() ?? m
        const r = clipRect(clip, l, mm.ppf)
        const f = Math.min(hi, Math.max(lo, Math.round((q.cx - r.x) / mm.ppf)))
        next = build(f, Math.round(this.volumeAtY(r, q.cy) * 10) / 10)
        previewOp('replaceClip', { clip: next })
        this.host.redraw()
      },
      end: async () => {
        if (next === clip) return clearPreview()
        await commitOp('replaceClip', { clip: next, label: 'Move Keyframe' }, { quiet: true })
      },
    }
  }

  private addVolumeKey(m: TimelineModel, p: Pointer, hit: Extract<HitTarget, { kind: 'clip' }>): void {
    const c = hit.clip
    const offset = Math.min(c.durationFrames - 1, Math.max(0, Math.round(hit.local / m.ppf)))
    const db = Math.round(this.volumeAtY(hit.rect, p.cy) * 10) / 10
    void runOp('replaceClip', { clip: { ...c, volumeTrack: upsertKeyframe(c.volumeTrack, { frame: offset, value: db, interpolationOut: 'smooth' }) }, label: 'Add Keyframe' })
  }

  private laneDown(m: TimelineModel, p: Pointer, hit: Extract<HitTarget, { kind: 'lane' }>): void {
    if (!hit.clip) {
      seek(frameAtX(p.cx, m.ppf))
      return
    }
    const clip = hit.clip
    if (hit.keyframe === null) {
      seek(frameAtX(p.cx, m.ppf))
      selectClips([clip.id])
      return
    }
    pause()
    const from = hit.keyframe
    seek(from)
    selectClips([clip.id])
    const keys = keyframeFrames(clip, hit.property)
    const i = keys.indexOf(from)
    const lo = Math.max(clip.startFrame, i > 0 ? keys[i - 1] + 1 : clip.startFrame)
    const hi = Math.min(Math.max(clip.startFrame, endFrame(clip) - 1), i < keys.length - 1 ? keys[i + 1] - 1 : Infinity)
    const others = VISUAL_LANE_ORDER.filter((pp) => pp !== hit.property).flatMap((pp) => keyframeFrames(clip, pp))
    const snapper = new Snapper([clip.startFrame, Math.max(clip.startFrame, endFrame(clip) - 1), ...others].map((frame) => ({ frame, kind: 'clipEdge' as const })))
    const grab = frameAtX(p.cx, m.ppf)
    let current = from
    this.host.setCursor('grabbing')
    this.start({
      move: (q) => {
        const mm = this.host.model() ?? m
        const proposed = from + frameAtX(q.cx, mm.ppf) - grab
        const s = snapper.find(proposed, [0], mm.ppf)
        const next = Math.min(hi, Math.max(lo, s?.frame ?? proposed))
        this.visual.snapFrame = s && s.frame === next ? s.frame : null
        if (next === current) return
        current = next
        scrub(next)
        if (next === from) clearPreview()
        else previewOp('moveKeyframe', { id: clip.id, property: hit.property, from, to: next })
        this.host.redraw()
      },
      end: async () => {
        if (current === from) return clearPreview()
        seek(current)
        await commitOp('moveKeyframe', { id: clip.id, property: hit.property, from, to: current })
      },
      cancel: () => {
        clearPreview()
        seek(from)
      },
    })
  }
}
