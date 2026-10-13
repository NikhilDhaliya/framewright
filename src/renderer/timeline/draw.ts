import { fadeMultiplier, linearToDb, rawVolumeAt } from '@core/clip'
import type { Clip, ClipType, MediaManifestEntry, MulticamSource, Timeline, TimelineMarker } from '@core/model'
import type { Gap } from '@core/ops/clips'
import { propertyTrack, supportsKeyframes, type AnimatableProperty } from '@core/ops/properties'
import { firstAudioIndex } from '@core/timeline'
import { formatTimecode } from '@core/time'
import { smoothstep } from '@core/keyframes'
import { ComponentSize } from '../theme/sizes'
import type { FrameRangeSel } from '../state/editor'
import { readableForeground, type Palette } from './colors'
import { clipRect, firstVisibleClip, LABEL_BAR_H, LANE_H, RULER_H, type Rect, type TrackLayout } from './geometry'
import { filmstrip, stillImage, waveform } from './mediaCache'
import { displayStatus, STATUS_LABELS } from '@core/generation/status'
import { drawBeatTicks, drawDeadAirWash, drawSpeakerTint } from '../audio/draw'

export interface DragVisual {
  /** Clips drawn faded at their pre-drag position (from the authoritative timeline). */
  originals?: { clip: Clip; trackIndex: number }[]
  originalsAlpha?: number
  /** Clips in the displayed doc drawn as drag ghosts (selected styling). */
  ghostIds?: Set<string>
  ghostAlpha?: number
  /** Content-y of the yellow new-track insertion line. */
  insertionY?: number | null
  /** Frame of the red ripple-blocked wall. */
  wallFrame?: number | null
  marquee?: Rect | null
  snapFrame?: number | null
  razorFrame?: number | null
  slipClipId?: string | null
  rippleInsert?: { frame: number; push: number } | null
}

export interface Scene {
  t: Timeline
  layouts: TrackLayout[]
  ppf: number
  scrollX: number
  scrollY: number
  width: number
  height: number
  selected: Set<string>
  selectedMarkers: Set<string>
  gap: Gap | null
  range: FrameRangeSel | null
  hoverClipId: string | null
  visual: DragVisual
  palette: Palette
  assets: Map<string, MediaManifestEntry>
  timelines: Map<string, Timeline>
  /** Linked-clip out-of-sync offsets (frames). */
  offsets: Map<string, number>
  /** Clips waiting for an AI-generated replacement (Mac `pendingReplacements`). */
  pendingReplacements?: ReadonlyMap<string, unknown>
  /** Multicam groups by id, for the angle chip (05 §6.5 #16). */
  multicam?: ReadonlyMap<string, MulticamSource>
  /** Offline asset ids (missing or unreadable files) for the offline wash (05 §6.5 #14). */
  offline?: ReadonlySet<string>
}

const FONT_LABEL = '500 10px Inter, sans-serif'
const FONT_RULER = '400 10px Inter, sans-serif'
const KF_PROPS: AnimatableProperty[] = ['opacity', 'position', 'scale', 'rotation', 'crop', 'blur']

function alpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
  const m = /rgba?\(([^)]+)\)/.exec(color)
  if (!m) return color
  const [r, g, b, a0 = '1'] = m[1].split(',').map((s) => s.trim())
  return `rgba(${r},${g},${b},${Number(a0) * a})`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2))
}

export const clipColorKind = (c: Clip): ClipType => (c.sourceClipType === 'subtitle' ? 'text' : c.sourceClipType)

export function clipName(c: Clip, assets: Map<string, MediaManifestEntry>, timelines: Map<string, Timeline>): string {
  const raw = c.mediaType === 'text' ? (c.textContent ?? '') : c.sourceClipType === 'sequence' ? (timelines.get(c.mediaRef)?.name ?? '') : (assets.get(c.mediaRef)?.name ?? '')
  return raw.split('\n').find((l) => l.trim())?.trim() ?? ''
}

function shortTimecode(frames: number, fps: number): string {
  const tc = formatTimecode(frames, fps)
  return frames < fps * 3600 ? tc.slice(3) : tc
}

export function linkOffsets(t: Timeline): Map<string, number> {
  const groups = new Map<string, Clip[]>()
  for (const tr of t.tracks) for (const c of tr.clips) if (c.linkGroupId) (groups.get(c.linkGroupId) ?? groups.set(c.linkGroupId, []).get(c.linkGroupId)!).push(c)
  const out = new Map<string, number>()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const ref = Math.min(...members.map((c) => c.startFrame - c.trimStartFrame))
    for (const c of members) {
      const off = c.startFrame - c.trimStartFrame - ref
      if (off !== 0) out.set(c.id, off)
    }
  }
  return out
}

// ---------- Clip body layers ----------

function drawFilmstrip(ctx: CanvasRenderingContext2D, c: Clip, body: Rect, clipX: number, s: Scene, asset: MediaManifestEntry): void {
  const strip = filmstrip(asset)
  if (!strip || body.h <= 2) return
  const tileW = Math.max(8, body.h * strip.aspect)
  const fps = s.t.fps
  const start = Math.max(body.x, Math.floor((0 - clipX) / tileW) * tileW + clipX)
  let count = 0
  for (let x = start; x < Math.min(body.x + body.w, s.width) && count < 200; x += tileW, count++) {
    if (x + tileW < 0) continue
    const srcSeconds = (c.trimStartFrame + ((x - clipX) / s.ppf) * c.speed) / fps
    const idx = Math.min(strip.frames.length - 1, Math.max(0, Math.round((srcSeconds / Math.max(strip.duration, 0.001)) * strip.frames.length)))
    const img = strip.frames[idx] ?? strip.frames.find(Boolean)
    if (img) ctx.drawImage(img, x, body.y, tileW, body.h)
  }
}

function drawStill(ctx: CanvasRenderingContext2D, body: Rect, clipX: number, s: Scene, assetId: string): void {
  const img = stillImage(assetId)
  if (!img || body.h <= 2) return
  const tileW = Math.max(8, body.h * (img.naturalWidth / Math.max(1, img.naturalHeight)))
  const start = Math.max(body.x, Math.floor((0 - clipX) / tileW) * tileW + clipX)
  for (let x = start, n = 0; x < Math.min(body.x + body.w, s.width) && n < 200; x += tileW, n++) ctx.drawImage(img, x, body.y, tileW, body.h)
}

function drawWaveform(ctx: CanvasRenderingContext2D, c: Clip, body: Rect, clipX: number, s: Scene, fg: string): void {
  const w = waveform(c.mediaRef)
  if (!w || body.h <= 4) return
  const fps = s.t.fps
  ctx.fillStyle = alpha(fg, 0.7)
  const x0 = Math.max(Math.floor(body.x), 0)
  const x1 = Math.min(Math.ceil(body.x + body.w), s.width)
  const maxH = body.h - 2
  for (let x = x0; x < x1; x++) {
    const f0 = (x - clipX) / s.ppf
    const f1 = (x + 1 - clipX) / s.ppf
    const i0 = Math.floor(((c.trimStartFrame + f0 * c.speed) / fps) * w.samplesPerSecond)
    const i1 = Math.max(i0 + 1, Math.floor(((c.trimStartFrame + f1 * c.speed) / fps) * w.samplesPerSecond))
    let peak = 0
    for (let i = Math.max(0, i0); i < Math.min(w.amp.length, i1); i++) if (w.amp[i] > peak) peak = w.amp[i]
    const frame = c.startFrame + f0
    const gain = rawVolumeAt(c, frame) * fadeMultiplier(c, frame)
    const amp = Math.min(1, Math.max(0, peak + linearToDb(gain) / 50))
    const h = Math.max(1, amp * maxH)
    ctx.fillRect(x, body.y + body.h - 1 - h, 1, h)
  }
}

const dbY = (db: number, body: Rect) => body.y + ((6 - Math.min(6, Math.max(-60, db))) / 66) * body.h

function drawRubberBand(ctx: CanvasRenderingContext2D, c: Clip, body: Rect, clipX: number, s: Scene, fg: string, strong: boolean): void {
  const lineColor = alpha(fg, strong ? 0.95 : 0.75)
  const x0 = Math.max(body.x, 0)
  const x1 = Math.min(body.x + body.w, s.width)
  const fadeInX = clipX + c.fadeInFrames * s.ppf
  const fadeOutX = clipX + (c.durationFrames - c.fadeOutFrames) * s.ppf
  const yAt = (x: number) => dbY(linearToDb(rawVolumeAt(c, c.startFrame + (x - clipX) / s.ppf)), body)
  if (c.fadeInFrames > 0 || c.fadeOutFrames > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'
    const bottom = body.y + body.h
    const wedge = (from: number, to: number, rising: boolean, interp: Clip['fadeInInterpolation']) => {
      ctx.beginPath()
      ctx.moveTo(from, body.y)
      const steps = 12
      for (let i = 0; i <= steps; i++) {
        const t = i / steps
        const k = interp === 'smooth' ? smoothstep(rising ? t : 1 - t) : rising ? t : 1 - t
        const x = from + (to - from) * t
        const line = yAt(x)
        ctx.lineTo(x, bottom - (bottom - line) * k)
      }
      ctx.lineTo(to, body.y)
      ctx.closePath()
      ctx.fill()
    }
    if (c.fadeInFrames > 0) wedge(clipX, fadeInX, true, c.fadeInInterpolation)
    if (c.fadeOutFrames > 0) wedge(fadeOutX, clipX + c.durationFrames * s.ppf, false, c.fadeOutInterpolation)
  }
  ctx.strokeStyle = lineColor
  ctx.lineWidth = 1.5
  ctx.beginPath()
  const stepPx = c.volumeTrack?.keyframes.length ? 2 : Math.max(2, x1 - x0)
  for (let x = x0; x <= x1; x += stepPx) {
    const y = yAt(Math.min(x, x1))
    if (x === x0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.lineTo(x1, yAt(x1))
  ctx.stroke()
}

function drawVisualFades(ctx: CanvasRenderingContext2D, c: Clip, body: Rect, clipX: number, s: Scene, fg: string, strong: boolean): void {
  if (c.fadeInFrames <= 0 && c.fadeOutFrames <= 0) return
  const bottom = body.y + body.h
  const curve = (from: number, to: number, rising: boolean, interp: Clip['fadeInInterpolation']) => {
    const pts: [number, number][] = []
    for (let i = 0; i <= 12; i++) {
      const t = i / 12
      const k = interp === 'smooth' ? smoothstep(rising ? t : 1 - t) : rising ? t : 1 - t
      pts.push([from + (to - from) * t, bottom - (bottom - body.y) * k])
    }
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.beginPath()
    ctx.moveTo(from, body.y)
    for (const [x, y] of pts) ctx.lineTo(x, y)
    ctx.lineTo(to, body.y)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = alpha(fg, (strong ? 0.95 : 0.75) * 0.7)
    ctx.lineWidth = 1.5
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
    ctx.stroke()
  }
  if (c.fadeInFrames > 0) curve(clipX, clipX + c.fadeInFrames * s.ppf, true, c.fadeInInterpolation)
  if (c.fadeOutFrames > 0) curve(clipX + (c.durationFrames - c.fadeOutFrames) * s.ppf, clipX + c.durationFrames * s.ppf, false, c.fadeOutInterpolation)
}

export function kneeRects(c: Clip, r: Rect, ppf: number): { left: Rect; right: Rect } {
  const y = r.y + LABEL_BAR_H + 4
  const lx = Math.max(r.x + 13, r.x + c.fadeInFrames * ppf) - 3.5
  const rx = Math.min(r.x + r.w - 13, r.x + (c.durationFrames - c.fadeOutFrames) * ppf) - 3.5
  return { left: { x: lx, y, w: 7, h: 7 }, right: { x: rx, y, w: 7, h: 7 } }
}

function drawKnee(ctx: CanvasRenderingContext2D, k: Rect, fill: string, left: boolean): void {
  ctx.fillStyle = fill
  ctx.fillRect(k.x, k.y, k.w, k.h)
  ctx.strokeStyle = 'rgba(0,0,0,0.55)'
  ctx.lineWidth = 0.5
  ctx.strokeRect(k.x + 0.25, k.y + 0.25, k.w - 0.5, k.h - 0.5)
  const i = 1.5
  ctx.fillStyle = 'rgba(0,0,0,0.55)'
  ctx.beginPath()
  if (left) {
    ctx.moveTo(k.x + i, k.y + k.h - i)
    ctx.lineTo(k.x + k.w - i, k.y + i)
    ctx.lineTo(k.x + k.w - i, k.y + k.h - i)
  } else {
    ctx.moveTo(k.x + i, k.y + i)
    ctx.lineTo(k.x + k.w - i, k.y + k.h - i)
    ctx.lineTo(k.x + i, k.y + k.h - i)
  }
  ctx.closePath()
  ctx.fill()
}

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, fill: string, stroke = 'rgba(0,0,0,0.5)'): void {
  const h = size / 2
  ctx.beginPath()
  ctx.moveTo(cx, cy - h)
  ctx.lineTo(cx + h, cy)
  ctx.lineTo(cx, cy + h)
  ctx.lineTo(cx - h, cy)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = stroke
  ctx.lineWidth = 0.5
  ctx.stroke()
}

export const volumeKeyY = (db: number, r: Rect) => dbY(db, { x: r.x, y: r.y + LABEL_BAR_H, w: r.w, h: r.h - LABEL_BAR_H - 1 })

/** Multicam angle pill at (x + 4, y + 2), max width w − 8; returns the x where the clip label starts. */
function drawAngleChip(ctx: CanvasRenderingContext2D, label: string, r: Rect, fill: string): number {
  ctx.font = '600 9px Inter, sans-serif'
  const maxW = Math.max(0, r.w - 8)
  const textW = ctx.measureText(label).width
  const w = Math.min(maxW, textW + 8)
  if (w <= 0) return r.x + 6
  const x = r.x + 4
  const y = r.y + 2
  roundRect(ctx, x, y, w, LABEL_BAR_H - 4, 3)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.save()
  ctx.beginPath()
  ctx.rect(x + 4, y, Math.max(0, w - 8), LABEL_BAR_H - 4)
  ctx.clip()
  ctx.fillStyle = alpha(readableForeground(fill), 0.8)
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x + 4, y + (LABEL_BAR_H - 4) / 2 + 0.5)
  ctx.restore()
  return x + w + 4
}

export interface ClipDrawOptions {
  selected: boolean
  hovered: boolean
  lanesOpen: boolean
  alpha?: number
}

export function drawClip(ctx: CanvasRenderingContext2D, c: Clip, r: Rect, s: Scene, o: ClipDrawOptions): void {
  const p = s.palette
  const kind = clipColorKind(c)
  const color = p.clip[kind]
  const fg = p.fg[kind]
  const asset = s.assets.get(c.mediaRef)
  // `isClipMediaOffline`: a nested clip whose timeline is gone, or media whose entry/file is missing or unreadable.
  const missing = c.mediaType !== 'text' && (c.sourceClipType === 'sequence' ? !s.timelines.has(c.mediaRef) : !asset || !!s.offline?.has(c.mediaRef))
  // Spec 06 §B6.2: a clip whose media is still generating shows the generating state instead of media.
  const gen = asset ? displayStatus(asset) : null
  const generating =
    gen && gen.kind !== 'none' && gen.kind !== 'failed' ? STATUS_LABELS[gen.kind] : c.mediaType !== 'text' && s.pendingReplacements?.has(c.id) ? STATUS_LABELS.generating : null
  ctx.save()
  ctx.globalAlpha = o.alpha ?? 1
  if (r.w < ComponentSize.timelineClipBorderMinWidth) {
    ctx.fillStyle = missing ? p.error : o.selected ? '#FFFFFF' : color
    ctx.fillRect(r.x, r.y, Math.max(1, r.w), r.h)
    ctx.restore()
    return
  }
  roundRect(ctx, r.x, r.y, r.w, r.h, 4)
  ctx.fillStyle = color
  ctx.fill()
  ctx.save()
  ctx.clip()
  const isText = c.mediaType === 'text'
  const body: Rect = isText ? { ...r } : { x: r.x, y: r.y + LABEL_BAR_H, w: r.w, h: r.h - LABEL_BAR_H - 1 }
  const showDetail = r.w >= ComponentSize.timelineClipDetailMinWidth
  const controls = (o.selected || o.hovered) && r.w >= ComponentSize.timelineClipControlsMinWidth
  if (generating) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.fillRect(body.x, body.y, body.w, body.h)
    if (body.w >= 70) {
      ctx.font = FONT_LABEL
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'
      ctx.fillText(generating, body.x + body.w / 2, body.y + body.h / 2)
      ctx.textAlign = 'left'
    }
  } else if (c.mediaType === 'audio') {
    drawDeadAirWash(ctx, c, body, r.x, s, p.error)
    drawWaveform(ctx, c, body, r.x, s, fg)
    drawSpeakerTint(ctx, c, body, r.x, s)
    drawRubberBand(ctx, c, body, r.x, s, fg, controls)
    drawBeatTicks(ctx, c, body, r.x, s)
  } else if (asset && c.sourceClipType === 'video') drawFilmstrip(ctx, c, body, r.x, s, asset)
  else if (asset && c.sourceClipType === 'image') drawStill(ctx, body, r.x, s, asset.id)
  if (isText) {
    ctx.fillStyle = fg
    ctx.font = FONT_LABEL
    ctx.textBaseline = 'top'
    const lines = (c.textContent ?? '').split('\n')
    lines.forEach((line, i) => {
      const y = r.y + 2 + i * 12
      if (y < r.y + r.h) ctx.fillText(line, r.x + 6, y)
    })
  } else if (c.mediaType !== 'audio') drawVisualFades(ctx, c, body, r.x, s, fg, controls)
  if (missing) {
    ctx.fillStyle = alpha(p.error, 0.25)
    ctx.fillRect(r.x, r.y, r.w, r.h)
  }
  const labelVisible = r.w >= ComponentSize.timelineClipLabelMinWidth || (o.selected && showDetail)
  const angle = c.multicamGroupId ? s.multicam?.get(c.multicamGroupId)?.members.find((mb) => mb.mediaRef === c.mediaRef)?.angleLabel : undefined
  let labelX = r.x + 6
  if (angle !== undefined) {
    if (labelVisible) labelX = drawAngleChip(ctx, angle, r, p.multicam)
    else {
      ctx.beginPath()
      ctx.arc(r.x + 2 + 2.5, r.y + 2 + 2.5, 2.5, 0, Math.PI * 2)
      ctx.fillStyle = p.multicam
      ctx.fill()
    }
  }
  if (labelVisible && !isText) {
    ctx.font = FONT_LABEL
    ctx.textBaseline = 'middle'
    ctx.fillStyle = fg
    ctx.fillText(`${clipName(c, s.assets, s.timelines)}  ${shortTimecode(c.durationFrames, s.t.fps)}`, labelX, r.y + LABEL_BAR_H / 2 + 0.5)
  }
  const offset = s.offsets.get(c.id)
  if (offset && showDetail) {
    const text = offset > 0 ? `+${offset}` : `−${-offset}`
    ctx.font = '600 10px Inter, sans-serif'
    const bw = Math.max(ComponentSize.timelineBadgeMinWidth, ctx.measureText(text).width + 8)
    const bx = r.x + r.w - 4 - bw - 2
    if (bx - r.x >= 6) {
      roundRect(ctx, bx, r.y + 2, bw, 12, 3)
      ctx.fillStyle = '#E54F4F'
      ctx.fill()
      ctx.fillStyle = '#FFFFFF'
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'center'
      ctx.fillText(text, bx + bw / 2, r.y + 8.5)
      ctx.textAlign = 'left'
    }
  }
  if (showDetail && !o.lanesOpen && c.mediaType !== 'audio') {
    const frames = new Set<number>()
    for (const prop of KF_PROPS) {
      if (!supportsKeyframes(c, prop)) continue
      for (const k of propertyTrack(c, prop)?.keyframes ?? []) frames.add(k.frame)
    }
    for (const f of frames) diamond(ctx, r.x + f * s.ppf, r.y + r.h - 5, 6, alpha(p.yellow, 0.95))
  }
  if (c.mediaType === 'audio' && o.selected && r.w >= ComponentSize.timelineClipControlsMinWidth && !o.lanesOpen) {
    for (const k of c.volumeTrack?.keyframes ?? []) diamond(ctx, r.x + k.frame * s.ppf, volumeKeyY(k.value, r), 7, p.timecode)
  }
  if (controls) {
    const knees = kneeRects(c, r, s.ppf)
    const kneeFill = alpha(fg, 0.95)
    drawKnee(ctx, knees.left, kneeFill, true)
    drawKnee(ctx, knees.right, kneeFill, false)
  }
  ctx.restore()
  roundRect(ctx, r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 4)
  ctx.lineWidth = 1
  ctx.strokeStyle = p.clipBorder
  ctx.stroke()
  if (missing) {
    roundRect(ctx, r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5, 4)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = alpha(p.error, 0.8)
    ctx.stroke()
  }
  if (o.selected) {
    roundRect(ctx, r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5, 4)
    ctx.lineWidth = 1.5
    ctx.strokeStyle = p.clipBorderSelected
    ctx.stroke()
  }
  ctx.restore()
}

// ---------- Lanes ----------

function drawLane(ctx: CanvasRenderingContext2D, s: Scene, track: Timeline['tracks'][number], prop: AnimatableProperty, y: number): void {
  const p = s.palette
  ctx.fillStyle = p.base
  ctx.fillRect(0, y, s.width, LANE_H)
  ctx.fillStyle = p.borderSubtle
  ctx.fillRect(0, y + LANE_H - 1, s.width, 1)
  const startFrame = s.scrollX / s.ppf
  for (let i = firstVisibleClip(track.clips, startFrame); i < track.clips.length; i++) {
    const c = track.clips[i]
    const x = c.startFrame * s.ppf - s.scrollX
    if (x > s.width) break
    const w = c.durationFrames * s.ppf
    const supported = supportsKeyframes(c, prop)
    const selected = s.selected.has(c.id)
    ctx.fillStyle = supported ? alpha(s.palette.clip[clipColorKind(c)], selected ? 0.25 : 0.1) : alpha(p.textMuted, 0.04)
    ctx.fillRect(x, y + 2, w, 20)
    ctx.fillStyle = selected ? p.clipBorderSelected : p.borderSubtle
    const sw = selected ? 1.5 : 0.5
    ctx.fillRect(x, y + 2, sw, 20)
    ctx.fillRect(x + w - sw, y + 2, sw, 20)
    if (!supported) continue
    for (const k of propertyTrack(c, prop)?.keyframes ?? []) diamond(ctx, x + k.frame * s.ppf, y + LANE_H / 2, 8, p.timecode)
  }
}

// ---------- Ruler & markers ----------

const MAJOR_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600]

function drawRuler(ctx: CanvasRenderingContext2D, s: Scene): void {
  const p = s.palette
  const fps = s.t.fps
  ctx.fillStyle = p.surface
  ctx.fillRect(0, 0, s.width, RULER_H)
  const framesPerMajor = (MAJOR_STEPS.find((n) => n * fps >= 80 / s.ppf) ?? MAJOR_STEPS[MAJOR_STEPS.length - 1]) * fps
  const majorPx = framesPerMajor * s.ppf
  const n = [20, 10, 5, 4, 2].find((d) => majorPx / d >= 6) ?? 0
  const minor = n ? Math.floor(framesPerMajor / n) : 0
  const firstFrame = Math.floor(s.scrollX / s.ppf / framesPerMajor) * framesPerMajor
  const lastFrame = (s.scrollX + s.width) / s.ppf
  ctx.font = FONT_RULER
  ctx.textBaseline = 'alphabetic'
  for (let f = firstFrame; f <= lastFrame; f += framesPerMajor) {
    const x = Math.round(f * s.ppf - s.scrollX)
    ctx.fillStyle = p.textMuted
    ctx.fillRect(x, 0, 1, 8)
    ctx.fillStyle = p.textTertiary
    ctx.fillText(formatTimecode(f, fps), x + 4, RULER_H - 2)
    if (!minor) continue
    ctx.fillStyle = alpha(p.textMuted, 0.4)
    for (let k = 1; k * minor < framesPerMajor; k++) {
      const mx = Math.round((f + k * minor) * s.ppf - s.scrollX) + 0.25
      const mid = n % 2 === 0 && k === n / 2
      ctx.fillRect(mx, 0, 0.5, mid ? 6 : 4)
    }
  }
}

const FLAG = { w: 10, h: 12 }

function flagPath(ctx: CanvasRenderingContext2D, x: number, y: number, half?: 'left' | 'right'): void {
  ctx.beginPath()
  if (half === 'left') {
    ctx.moveTo(x - 5, y)
    ctx.lineTo(x, y)
    ctx.lineTo(x, y + FLAG.h)
    ctx.lineTo(x - 5, y + 7)
  } else if (half === 'right') {
    ctx.moveTo(x, y)
    ctx.lineTo(x + 5, y)
    ctx.lineTo(x + 5, y + 7)
    ctx.lineTo(x, y + FLAG.h)
  } else {
    ctx.moveTo(x - 5, y)
    ctx.lineTo(x + 5, y)
    ctx.lineTo(x + 5, y + 7)
    ctx.lineTo(x, y + FLAG.h)
    ctx.lineTo(x - 5, y + 7)
  }
  ctx.closePath()
}

const rgbaOf = (m: TimelineMarker, a = 1) => `rgba(${Math.round(m.color.r * 255)},${Math.round(m.color.g * 255)},${Math.round(m.color.b * 255)},${m.color.a * a})`

function drawMarkers(ctx: CanvasRenderingContext2D, s: Scene): void {
  const p = s.palette
  for (const m of s.t.markers) {
    const x = m.startFrame * s.ppf - s.scrollX
    const selected = s.selectedMarkers.has(m.id)
    ctx.lineWidth = selected ? 1.5 : 1
    ctx.strokeStyle = selected ? p.markerBorderSelected : p.markerBorder
    ctx.fillStyle = rgbaOf(m)
    if (m.durationFrames > 0) {
      const x2 = (m.startFrame + m.durationFrames) * s.ppf - s.scrollX
      if (x2 < -10 || x > s.width + 10) continue
      ctx.fillStyle = rgbaOf(m, 0.55)
      ctx.fillRect(x, 0, x2 - x, 4)
      ctx.fillStyle = rgbaOf(m)
      for (const [fx, half] of [[x, 'left'], [x2, 'right']] as const) {
        flagPath(ctx, fx, 0, half)
        ctx.fill()
        ctx.stroke()
      }
    } else {
      if (x < -10 || x > s.width + 10) continue
      flagPath(ctx, x, 0)
      ctx.fill()
      ctx.stroke()
    }
  }
}

// ---------- Scene ----------

export function drawContent(ctx: CanvasRenderingContext2D, s: Scene): void {
  const p = s.palette
  const { t, layouts, ppf, scrollX, scrollY, width, height, visual } = s
  ctx.fillStyle = p.surface
  ctx.fillRect(0, 0, width, height)
  const fa = firstAudioIndex(t)
  const startFrame = scrollX / ppf
  const endVisible = (scrollX + width) / ppf
  if (layouts.length) {
    ctx.fillStyle = p.borderPrimary
    ctx.fillRect(0, layouts[0].top - scrollY, width, 1)
  }
  for (const l of layouts) {
    const top = l.top - scrollY
    if (top > height || l.bottom - scrollY < RULER_H) continue
    ctx.fillStyle = p.borderPrimary
    ctx.fillRect(0, top + l.height - 1, width, 1)
    l.lanes.forEach((prop, li) => drawLane(ctx, s, t.tracks[l.index], prop, top + l.height + li * LANE_H))
    if (l.lanes.length) {
      ctx.fillStyle = p.borderPrimary
      ctx.fillRect(0, l.bottom - scrollY - 1, width, 1)
    }
  }
  if (fa > 0 && fa < layouts.length) {
    ctx.fillStyle = alpha(p.borderDivider, 0.35)
    ctx.fillRect(0, layouts[fa].top - scrollY - 1, width, 2)
  }
  const range = s.range && s.range.start !== s.range.end ? { start: Math.min(s.range.start, s.range.end), end: Math.max(s.range.start, s.range.end) } : null
  if (range) {
    ctx.fillStyle = alpha(p.textPrimary, 0.06)
    ctx.fillRect(range.start * ppf - scrollX, RULER_H, (range.end - range.start) * ppf, height - RULER_H)
  }
  if (visual.rippleInsert) {
    ctx.fillStyle = alpha(p.timecode, 0.08)
    ctx.strokeStyle = alpha(p.timecode, 0.35)
    const bx = visual.rippleInsert.frame * ppf - scrollX
    for (const l of layouts) {
      ctx.fillRect(bx, l.top - scrollY + 2, visual.rippleInsert.push * ppf, l.height - 4)
      ctx.strokeRect(bx + 0.5, l.top - scrollY + 2.5, visual.rippleInsert.push * ppf - 1, l.height - 5)
    }
  }
  if (visual.originals) {
    for (const o of visual.originals) {
      const l = layouts[o.trackIndex]
      if (!l) continue
      const r = clipRect(o.clip, l, ppf)
      drawClip(ctx, o.clip, { ...r, x: r.x - scrollX, y: r.y - scrollY }, s, { selected: false, hovered: false, lanesOpen: l.lanes.length > 0, alpha: visual.originalsAlpha ?? 0.3 })
    }
  }
  const deferred: { c: Clip; r: Rect; l: TrackLayout }[] = []
  for (const l of layouts) {
    const top = l.top - scrollY
    if (top > height || top + l.height < RULER_H) continue
    const track = t.tracks[l.index]
    for (let i = firstVisibleClip(track.clips, startFrame); i < track.clips.length; i++) {
      const c = track.clips[i]
      if (c.startFrame > endVisible) break
      const r = clipRect(c, l, ppf)
      const vr = { ...r, x: r.x - scrollX, y: r.y - scrollY }
      if (visual.ghostIds?.has(c.id) || visual.slipClipId === c.id) {
        deferred.push({ c, r: vr, l })
        continue
      }
      drawClip(ctx, c, vr, s, { selected: s.selected.has(c.id), hovered: s.hoverClipId === c.id, lanesOpen: l.lanes.length > 0 })
    }
  }
  for (const d of deferred) {
    if (visual.slipClipId === d.c.id) drawSlipExtent(ctx, d.c, d.r, s)
    drawClip(ctx, d.c, d.r, s, { selected: true, hovered: false, lanesOpen: d.l.lanes.length > 0, alpha: visual.slipClipId === d.c.id ? 1 : (visual.ghostAlpha ?? 0.7) })
  }
  if (visual.wallFrame !== null && visual.wallFrame !== undefined) {
    ctx.fillStyle = p.error
    ctx.fillRect(visual.wallFrame * ppf - scrollX - 1, RULER_H, 2, height - RULER_H)
  }
  if (s.gap) {
    const l = layouts[s.gap.trackIndex]
    if (l) {
      const x = s.gap.start * ppf - scrollX
      const w = (s.gap.end - s.gap.start) * ppf
      ctx.fillStyle = alpha(p.textPrimary, 0.12)
      ctx.fillRect(x, l.top - scrollY + 2, w, l.height - 4)
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = alpha(p.textPrimary, 0.9)
      ctx.lineWidth = 1
      ctx.strokeRect(x + 0.5, l.top - scrollY + 2.5, w - 1, l.height - 5)
      ctx.setLineDash([])
    }
  }
  if (visual.insertionY !== null && visual.insertionY !== undefined) {
    ctx.fillStyle = p.yellow
    ctx.fillRect(0, visual.insertionY - scrollY - 1, width, 2)
  }
  drawRuler(ctx, s)
  if (range) {
    ctx.fillStyle = p.fillSoft
    const x = range.start * ppf - scrollX
    const w = (range.end - range.start) * ppf
    ctx.fillRect(x, 0, w, RULER_H)
    ctx.fillStyle = alpha(p.timecode, 0.8)
    ctx.fillRect(x - 0.75, 0, 1.5, RULER_H)
    ctx.fillRect(x + w - 0.75, 0, 1.5, RULER_H)
  }
  drawMarkers(ctx, s)
  if (visual.marquee) {
    const m = visual.marquee
    ctx.fillStyle = alpha(p.textPrimary, 0.1)
    ctx.fillRect(m.x - scrollX, m.y - scrollY, m.w, m.h)
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = alpha(p.textPrimary, 0.6)
    ctx.lineWidth = 1
    ctx.strokeRect(m.x - scrollX + 0.5, m.y - scrollY + 0.5, m.w - 1, m.h - 1)
    ctx.setLineDash([])
  }
}

function drawSlipExtent(ctx: CanvasRenderingContext2D, c: Clip, r: Rect, s: Scene): void {
  const p = s.palette
  const before = (c.trimStartFrame / Math.max(c.speed, 0.001)) * s.ppf
  const after = (c.trimEndFrame / Math.max(c.speed, 0.001)) * s.ppf
  const full: Rect = { x: r.x - before, y: r.y, w: r.w + before + after, h: r.h }
  ctx.save()
  ctx.fillStyle = alpha(p.base, 0.35)
  ctx.beginPath()
  ctx.rect(0, RULER_H, s.width, s.height - RULER_H)
  ctx.rect(r.x, r.y, r.w, r.h)
  ctx.fill('evenodd')
  ctx.globalAlpha = 0.35
  roundRect(ctx, full.x, full.y, full.w, full.h, 4)
  ctx.fillStyle = p.clip[clipColorKind(c)]
  ctx.fill()
  ctx.globalAlpha = 1
  roundRect(ctx, full.x + 0.75, full.y + 0.75, full.w - 1.5, full.h - 1.5, 4)
  ctx.strokeStyle = alpha(p.textPrimary, 0.8)
  ctx.lineWidth = 1.5
  ctx.stroke()
  ctx.restore()
}

export function drawOverlay(ctx: CanvasRenderingContext2D, s: { width: number; height: number; ppf: number; scrollX: number; playhead: number; visual: DragVisual; palette: Palette }): void {
  const { width, height, ppf, scrollX, visual, palette: p } = s
  ctx.clearRect(0, 0, width, height)
  const vline = (frame: number, color: string, dash: number[]) => {
    const x = Math.round(frame * ppf - scrollX) + 0.5
    if (x < 0 || x > width) return
    ctx.setLineDash(dash)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, RULER_H)
    ctx.lineTo(x, height)
    ctx.stroke()
    ctx.setLineDash([])
  }
  if (visual.snapFrame !== null && visual.snapFrame !== undefined) vline(visual.snapFrame, p.yellow, [4, 4])
  if (visual.razorFrame !== null && visual.razorFrame !== undefined) vline(visual.razorFrame, alpha(p.orange, 0.8), [4, 4])
  const x = Math.round(s.playhead * ppf - scrollX)
  if (x < -6 || x > width + 6) return
  ctx.fillStyle = p.playhead
  ctx.fillRect(x, 0, 1, height)
  ctx.beginPath()
  ctx.moveTo(x - 3.5, 0)
  ctx.lineTo(x + 4.5, 0)
  ctx.lineTo(x + 0.5, 8)
  ctx.closePath()
  ctx.fill()
}

