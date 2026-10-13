/**
 * Per-frame layer planning (spec 04 §2–§3): which clips composite at a timeline frame, in what order,
 * and which source second each media layer shows. Pure: shared by the preview, the render host and export.
 */
import { blurKeyframeTrack, clampFadesToDuration, clampKeyframesToDuration, endFrame, lerpCrop, staticBlurRadius } from '@core/clip'
import { lerpNumber, lerpPair, rebaseTrack, swiftRound } from '@core/keyframes'
import type { Clip, ClipType, Timeline, Track } from '@core/model'
import { setBlurKeyframeTrack, totalFrames } from '@core/timeline'
import { deepClone } from '@core/util'

export interface MediaInfo {
  /** Absolute path of the original file; null when the file is missing (offline). */
  path: string | null
  type: ClipType
  /** Seconds. */
  duration: number
  width?: number
  height?: number
  hasAudio?: boolean
}

export type MediaMap = Record<string, MediaInfo>

/** Stills and Lottie are normalised to 30-minute movies on macOS (§3.2). */
export const STILL_DURATION_SEC = 1800
export const NEST_MAX_DEPTH = 8

export interface SourceTiming {
  trimSec: number
  /** Seconds of source consumed by the clip (after the asset-length clamp). */
  srcDurSec: number
  clipDurSec: number
  /** Source seconds per timeline second. */
  rate: number
  speedOne: boolean
}

export function assetDurationSec(info: MediaInfo): number {
  return info.type === 'image' || info.type === 'lottie' ? STILL_DURATION_SEC : info.duration
}

/** §3.1: null when the clip is never inserted (negative trim, nothing left of the source). */
export function sourceTiming(clip: Clip, fps: number, assetDurSec: number): SourceTiming | null {
  const trimFrames = clip.mediaType === 'image' ? Math.max(0, clip.trimStartFrame) : clip.trimStartFrame
  if (trimFrames < 0 || !(fps > 0) || clip.durationFrames <= 0) return null
  const trimSec = trimFrames / fps
  const speedOne = clip.speed === 1
  const sourceFrames = speedOne ? clip.durationFrames : Math.max(1, Math.trunc(clip.durationFrames * clip.speed))
  const srcDurSec = Math.min(sourceFrames / fps, assetDurSec - trimSec)
  if (!(srcDurSec > 0)) return null
  const clipDurSec = clip.durationFrames / fps
  return { trimSec, srcDurSec, clipDurSec, rate: speedOne ? 1 : srcDurSec / clipDurSec, speedOne }
}

/** Source second shown at timeline frame `f`, or null past the end of a speed-1 source. */
export function sourceTimeSec(clip: Clip, f: number, fps: number, t: SourceTiming): number | null {
  const local = (f - clip.startFrame) / fps
  if (t.speedOne) return local < t.srcDurSec ? t.trimSec + local : null
  return t.trimSec + local * t.rate
}

export interface MediaLayer {
  kind: 'media'
  clip: Clip
  /** Display-oriented source size; 0 when unknown (the decoded frame size is used). */
  natW: number
  natH: number
  sourceId: string
  info: MediaInfo
  timing: SourceTiming
  offline: boolean
}

export interface TextLayer {
  kind: 'text'
  clip: Clip
  canvasW: number
  canvasH: number
}

export interface GroupLayer {
  kind: 'group'
  clip: Clip
  children: LayerPlan[]
  canvasW: number
  canvasH: number
}

export type LayerPlan = MediaLayer | TextLayer | GroupLayer

export interface PlanEnv {
  fps: number
  timelines: Timeline[]
  media(id: string): MediaInfo | undefined
  /** Preview: keep offline clips as placeholder layers instead of dropping them. */
  offlinePlaceholders?: boolean
}

type Admitted =
  | { kind: 'text'; clip: Clip }
  | { kind: 'group'; clip: Clip }
  | { kind: 'media'; clip: Clip; info: MediaInfo; timing: SourceTiming | null; offline: boolean }

const isVisualMedia = (t: ClipType): boolean => t === 'video' || t === 'image' || t === 'lottie'

/**
 * Remaps a child clip into parent frames for a nest carrier (NestFlattener.remap, §2.3.1).
 * Returns null when the clip lies outside the carrier's window.
 */
export function remapNested(clip: Clip, carrier: Clip): Clip | null {
  const lo = carrier.trimStartFrame
  const hi = carrier.trimStartFrame + carrier.durationFrames
  const shift = carrier.startFrame - carrier.trimStartFrame
  const start = Math.max(clip.startFrame, lo)
  const end = Math.min(endFrame(clip), hi)
  if (end <= start) return null
  const c = deepClone(clip)
  const headCut = start - clip.startFrame
  if (headCut > 0) {
    c.trimStartFrame += swiftRound(headCut * c.speed)
    c.fadeInFrames = 0
    c.opacityTrack = rebaseTrack(c.opacityTrack, headCut, c.opacity, lerpNumber)
    c.volumeTrack = rebaseTrack(c.volumeTrack, headCut, 0, lerpNumber)
    c.positionTrack = rebaseTrack(c.positionTrack, headCut, { a: 0, b: 0 }, lerpPair)
    c.scaleTrack = rebaseTrack(c.scaleTrack, headCut, { a: 1, b: 1 }, lerpPair)
    c.rotationTrack = rebaseTrack(c.rotationTrack, headCut, 0, lerpNumber)
    c.cropTrack = rebaseTrack(c.cropTrack, headCut, c.crop, lerpCrop)
    setBlurKeyframeTrack(c, rebaseTrack(blurKeyframeTrack(c), headCut, staticBlurRadius(c), lerpNumber))
  }
  if (end < endFrame(clip)) c.fadeOutFrames = 0
  c.startFrame = start + shift
  c.durationFrames = end - start
  clampFadesToDuration(c)
  clampKeyframesToDuration(c)
  c.id = `${carrier.id}/${clip.id}`
  return c
}

/** Child tracks of a carrier, remapped into parent frames (child track order preserved). */
export function flattenNest(carrier: Clip, child: Timeline, visual: boolean): Clip[][] {
  const out: Clip[][] = []
  for (const track of child.tracks) {
    if (visual ? track.type !== 'video' || track.hidden : track.type !== 'audio' || track.muted) continue
    const clips = sortedClips(track)
      .map((c) => remapNested(c, carrier))
      .filter((c): c is Clip => c !== null)
    if (clips.length) out.push(clips)
  }
  return out
}

const sortedCache = new WeakMap<Track, Clip[]>()
function sortedClips(track: Track): Clip[] {
  let s = sortedCache.get(track)
  if (!s) {
    s = [...track.clips].sort((a, b) => a.startFrame - b.startFrame)
    sortedCache.set(track, s)
  }
  return s
}

/**
 * Frame-independent part of planning, cached per track/carrier object (documents are immutable):
 * overlap gating (Q1) and insertability only depend on clip order and media.
 */
export class Planner {
  private readonly laneCache = new WeakMap<Clip[], Admitted[]>()
  /** Child lanes per carrier, bottom → top. */
  private readonly nestCache = new WeakMap<Clip, { child: Timeline; lanes: Clip[][] }>()

  constructor(readonly env: PlanEnv) {}

  timeline(id: string): Timeline | undefined {
    return this.env.timelines.find((t) => t.id === id)
  }

  /** Layers bottom → top at timeline frame `f` for a canvas of `W × H` (§2.2). */
  layersAt(tl: Timeline, f: number, W: number, H: number): LayerPlan[] {
    const lanes: Clip[][] = []
    for (let i = tl.tracks.length - 1; i >= 0; i--) {
      const track = tl.tracks[i]
      if (!track.hidden) lanes.push(sortedClips(track))
    }
    return this.lanesAt(lanes, f, W, H, 0)
  }

  private lanesAt(lanes: Clip[][], f: number, W: number, H: number, depth: number): LayerPlan[] {
    const out: LayerPlan[] = []
    for (const lane of lanes) {
      for (const a of this.admitted(lane)) {
        const c = a.clip
        if (f < c.startFrame || f >= c.startFrame + c.durationFrames) continue
        if (a.kind === 'text') out.push({ kind: 'text', clip: c, canvasW: W, canvasH: H })
        else if (a.kind === 'group') {
          const g = this.groupAt(c, f, depth)
          if (g) out.push(g)
        } else if (a.timing) {
          out.push({ kind: 'media', clip: c, natW: a.info.width ?? 0, natH: a.info.height ?? 0, sourceId: c.mediaRef, info: a.info, timing: a.timing, offline: a.offline })
        }
      }
    }
    return out
  }

  private groupAt(carrier: Clip, f: number, depth: number): GroupLayer | null {
    if (depth >= NEST_MAX_DEPTH) return null
    const nest = this.nest(carrier)
    if (!nest) return null
    const { child, lanes } = nest
    const children = this.lanesAt(lanes, f, child.width, child.height, depth + 1)
    return { kind: 'group', clip: carrier, children, canvasW: child.width, canvasH: child.height }
  }

  private nest(carrier: Clip): { child: Timeline; lanes: Clip[][] } | null {
    const child = this.timeline(carrier.mediaRef)
    if (!child) return null
    const hit = this.nestCache.get(carrier)
    if (hit && hit.child === child) return hit
    const entry = { child, lanes: flattenNest(carrier, child, true).reverse() }
    this.nestCache.set(carrier, entry)
    return entry
  }

  private admitted(lane: Clip[]): Admitted[] {
    const hit = this.laneCache.get(lane)
    if (hit) return hit
    const out: Admitted[] = []
    let prevEnd = -Infinity
    for (const clip of lane) {
      if (clip.durationFrames <= 0) continue
      if (clip.mediaType === 'text') {
        if (clip.textContent) out.push({ kind: 'text', clip })
        continue
      }
      if (clip.mediaType === 'sequence') {
        if (clip.startFrame < prevEnd) continue
        prevEnd = endFrame(clip)
        out.push({ kind: 'group', clip })
        continue
      }
      if (!isVisualMedia(clip.mediaType)) continue
      if (clip.startFrame < prevEnd) continue
      const info = this.env.media(clip.mediaRef)
      const usable = !!info && !!info.path && isVisualMedia(info.type)
      const timing = info ? sourceTiming(clip, this.env.fps, assetDurationSec(info)) : null
      if (usable && timing) {
        prevEnd = endFrame(clip)
        out.push({ kind: 'media', clip, info, timing, offline: false })
      } else if (this.env.offlinePlaceholders && (!info || !info.path)) {
        // Offline clips never advance prevEnd (§2.2); the preview still marks where they are.
        const placeholderInfo: MediaInfo = info ?? { path: null, type: clip.mediaType, duration: clip.durationFrames / this.env.fps }
        const t = sourceTiming(clip, this.env.fps, STILL_DURATION_SEC) ?? { trimSec: 0, srcDurSec: clip.durationFrames / this.env.fps, clipDurSec: clip.durationFrames / this.env.fps, rate: 1, speedOne: true }
        out.push({ kind: 'media', clip, info: placeholderInfo, timing: { ...t, speedOne: false }, offline: true })
      }
    }
    this.laneCache.set(lane, out)
    return out
  }
}

/** Output frame count `N` (§2.4). */
export function compositionFrames(tl: Timeline): number {
  return totalFrames(tl)
}

/** Every media layer in a plan, groups flattened (render order). */
export function mediaLayers(plan: LayerPlan[], out: MediaLayer[] = []): MediaLayer[] {
  for (const l of plan) {
    if (l.kind === 'media') out.push(l)
    else if (l.kind === 'group') mediaLayers(l.children, out)
  }
  return out
}

/**
 * Preview work scale (§12): source px are processed at the size they are displayed, rounded up to a quarter
 * octave so animated placements reuse render targets; 1 when shown at or above source resolution.
 */
export function workScale(t: { width: number; height: number }, natW: number, natH: number, W: number, H: number): number {
  const s = Math.max(Math.abs((W / natW) * t.width), Math.abs((H / natH) * t.height))
  if (!Number.isFinite(s) || !(s > 0) || s >= 1) return 1
  return Math.min(1, 2 ** (Math.ceil(Math.log2(s) * 4) / 4))
}

/** 3×3 column-major matrix mapping canvas px → source px for a placed media layer (§5.5). */
export function canvasToSource(t: { centerX: number; centerY: number; width: number; height: number; rotation: number; flipHorizontal: boolean; flipVertical: boolean }, natW: number, natH: number, W: number, H: number, out = new Float32Array(9)): Float32Array | null {
  const tlx = t.centerX - t.width / 2
  const tly = t.centerY - t.height / 2
  const sx = (W / natW) * t.width * (t.flipHorizontal ? -1 : 1)
  const sy = (H / natH) * t.height * (t.flipVertical ? -1 : 1)
  if (!(Math.abs(sx) > 0 && Math.abs(sy) > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return null
  const tx = (t.flipHorizontal ? tlx + t.width : tlx) * W
  const ty = (t.flipVertical ? tly + t.height : tly) * H
  const cx = t.centerX * W
  const cy = t.centerY * H
  const th = (t.rotation * Math.PI) / 180
  const cos = Math.cos(th)
  const sin = Math.sin(th)
  const a = cos / sx
  const b = sin / sx
  const e = (-cos * cx - sin * cy + cx - tx) / sx
  const c2 = -sin / sy
  const d = cos / sy
  const g = (sin * cx - cos * cy + cy - ty) / sy
  out[0] = a
  out[1] = c2
  out[2] = 0
  out[3] = b
  out[4] = d
  out[5] = 0
  out[6] = e
  out[7] = g
  out[8] = 1
  return out
}
