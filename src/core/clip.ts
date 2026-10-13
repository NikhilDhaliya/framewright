import {
  clampTrackToDuration,
  isActive,
  lerpNumber,
  lerpPair,
  rescaleTrack,
  sampleTrack,
  smoothstep,
  type AnimPair,
  type Interpolation,
  type KeyframeTrack,
  type Lerp,
} from './keyframes'
import { defaultTextStyle, newId, type Clip, type Crop, type Effect, type TextStyle, type Transform, type Track } from './model'

export const endFrame = (c: Pick<Clip, 'startFrame' | 'durationFrames'>): number => c.startFrame + c.durationFrames
export const containsFrame = (c: Clip, frame: number): boolean => frame >= c.startFrame && frame < endFrame(c)
export const sourceFramesConsumed = (c: Clip): number => Math.round(c.durationFrames * c.speed)
export const sourceDurationFrames = (c: Clip): number => sourceFramesConsumed(c) + c.trimStartFrame + c.trimEndFrame
export const supportsRetiming = (c: Clip): boolean => c.sourceClipType !== 'sequence'

export const lerpCrop: Lerp<Crop> = (a, b, t) => ({
  left: lerpNumber(a.left, b.left, t),
  top: lerpNumber(a.top, b.top, t),
  right: lerpNumber(a.right, b.right, t),
  bottom: lerpNumber(a.bottom, b.bottom, t),
})

export const VOLUME_DB = { min: -60, max: 15 } as const
export const dbToLinear = (db: number): number => (db <= VOLUME_DB.min ? 0 : Math.pow(10, Math.min(db, VOLUME_DB.max) / 20))
export const linearToDb = (l: number): number => (l <= 0 ? VOLUME_DB.min : Math.min(VOLUME_DB.max, Math.max(VOLUME_DB.min, 20 * Math.log10(l))))

export function fadeMultiplier(c: Clip, frame: number): number {
  const rel = frame - c.startFrame
  if (rel < 0 || rel > c.durationFrames) return 0
  const shape = (t: number, i: Interpolation) => (i === 'smooth' ? smoothstep(t) : t)
  const inMul = c.fadeInFrames > 0 ? shape(Math.min(1, rel / c.fadeInFrames), c.fadeInInterpolation) : 1
  const outMul = c.fadeOutFrames > 0 ? shape(Math.min(1, (c.durationFrames - rel) / c.fadeOutFrames), c.fadeOutInterpolation) : 1
  return Math.min(inMul, outMul)
}

export const rawOpacityAt = (c: Clip, frame: number): number => sampleTrack(c.opacityTrack, frame - c.startFrame, c.opacity, lerpNumber)

export function opacityAt(c: Clip, frame: number): number {
  const base = rawOpacityAt(c, frame)
  if (c.mediaType === 'audio' || (c.fadeInFrames <= 0 && c.fadeOutFrames <= 0)) return base
  return base * fadeMultiplier(c, frame)
}

export const rotationAt = (c: Clip, frame: number): number => sampleTrack(c.rotationTrack, frame - c.startFrame, c.transform.rotation, lerpNumber)

export function sizeAt(c: Clip, frame: number): AnimPair {
  const fallback = { a: c.transform.width, b: c.transform.height }
  return sampleTrack(c.scaleTrack, frame - c.startFrame, fallback, lerpPair)
}

export function topLeftAt(c: Clip, frame: number): AnimPair {
  if (isActive(c.positionTrack)) return sampleTrack(c.positionTrack, frame - c.startFrame, { a: 0, b: 0 }, lerpPair)
  const sz = sizeAt(c, frame)
  return { a: c.transform.centerX - sz.a / 2, b: c.transform.centerY - sz.b / 2 }
}

export function transformAt(c: Clip, frame: number): Transform {
  const tl = topLeftAt(c, frame)
  const sz = sizeAt(c, frame)
  return {
    ...c.transform,
    centerX: tl.a + sz.a / 2,
    centerY: tl.b + sz.b / 2,
    width: sz.a,
    height: sz.b,
    rotation: rotationAt(c, frame),
  }
}

export const cropAt = (c: Clip, frame: number): Crop => sampleTrack(c.cropTrack, frame - c.startFrame, c.crop, lerpCrop)

export function volumeAt(c: Clip, frame: number): number {
  const kfGain = isActive(c.volumeTrack) ? dbToLinear(sampleTrack(c.volumeTrack, frame - c.startFrame, 0, lerpNumber)) : 1
  return c.volume * kfGain * fadeMultiplier(c, frame)
}

export function rawVolumeAt(c: Clip, frame: number): number {
  const kfGain = isActive(c.volumeTrack) ? dbToLinear(sampleTrack(c.volumeTrack, frame - c.startFrame, 0, lerpNumber)) : 1
  return c.volume * kfGain
}

export function textScaleAt(c: Clip, frame: number): number {
  const base = c.textStyle?.fontScale ?? 1
  if (c.mediaType !== 'text') return base
  const { width, height } = c.transform
  if (!(base > 0 && width > 0 && height > 0)) return 1
  const sz = sizeAt(c, frame)
  const wr = sz.a / width
  const hr = sz.b / height
  if (!(wr > 0 && hr > 0 && Number.isFinite(wr) && Number.isFinite(hr))) return base
  return base * Math.min(wr, hr)
}

export function textStyleAt(c: Clip, frame: number): TextStyle {
  return { ...(c.textStyle ?? defaultTextStyle()), fontScale: textScaleAt(c, frame) }
}

export const hasTransformAnimation = (c: Clip): boolean => isActive(c.positionTrack) || isActive(c.scaleTrack) || isActive(c.rotationTrack)

// ---------- Effects-backed blur ----------

export const GAUSSIAN_BLUR = 'blur.gaussian'

export const blurKeyframeTrack = (c: Clip): KeyframeTrack<number> | undefined =>
  c.effects?.find((e) => e.type === GAUSSIAN_BLUR)?.params.radius?.track

export function staticBlurRadius(c: Clip): number {
  if (c.mediaType === 'text') return c.textStyle?.blur ?? 0
  return c.effects?.find((e) => e.type === GAUSSIAN_BLUR)?.params.radius?.value ?? 0
}

export function blurRadiusAt(c: Clip, frame: number): number {
  return sampleTrack(blurKeyframeTrack(c), frame - c.startFrame, staticBlurRadius(c), lerpNumber)
}

// ---------- Mutating helpers (operate on drafts) ----------

export function clampFadesToDuration(c: Clip): void {
  c.fadeInFrames = Math.max(0, Math.min(c.fadeInFrames, c.durationFrames))
  c.fadeOutFrames = Math.max(0, Math.min(c.fadeOutFrames, c.durationFrames - c.fadeInFrames))
}

function mapEffectTracks(c: Clip, fn: (t: KeyframeTrack<number>) => KeyframeTrack<number> | undefined): void {
  if (!c.effects) return
  c.effects = c.effects.map((e): Effect => {
    let changed = false
    const params = { ...e.params }
    for (const [k, p] of Object.entries(params)) {
      if (!p.track) continue
      const next = fn(p.track)
      changed = true
      params[k] = next ? { ...p, track: next } : (({ track: _t, ...rest }) => rest)(p)
    }
    return changed ? { ...e, params } : e
  })
}

export function clampKeyframesToDuration(c: Clip): void {
  const d = c.durationFrames
  c.opacityTrack = clampTrackToDuration(c.opacityTrack, d)
  c.positionTrack = clampTrackToDuration(c.positionTrack, d)
  c.scaleTrack = clampTrackToDuration(c.scaleTrack, d)
  c.rotationTrack = clampTrackToDuration(c.rotationTrack, d)
  c.cropTrack = clampTrackToDuration(c.cropTrack, d)
  c.volumeTrack = clampTrackToDuration(c.volumeTrack, d)
  mapEffectTracks(c, (t) => clampTrackToDuration(t, d))
  pruneUndefined(c)
}

export function rescaleKeyframes(c: Clip, scale: number): void {
  const d = c.durationFrames
  c.opacityTrack = rescaleTrack(c.opacityTrack, scale, d)
  c.positionTrack = rescaleTrack(c.positionTrack, scale, d)
  c.scaleTrack = rescaleTrack(c.scaleTrack, scale, d)
  c.rotationTrack = rescaleTrack(c.rotationTrack, scale, d)
  c.cropTrack = rescaleTrack(c.cropTrack, scale, d)
  c.volumeTrack = rescaleTrack(c.volumeTrack, scale, d)
  mapEffectTracks(c, (t) => rescaleTrack(t, scale, d))
  pruneUndefined(c)
}

export function rescaleWordTimings(c: Clip, oldDuration: number): void {
  if (c.mediaType !== 'text' || !c.wordTimings || oldDuration <= 0 || c.durationFrames <= 0) return
  const scale = c.durationFrames / oldDuration
  c.wordTimings = c.wordTimings.map((w) => {
    const start = Math.min(Math.max(0, Math.round(w.startFrame * scale)), Math.max(0, c.durationFrames - 1))
    const end = Math.min(Math.max(start + 1, Math.round(w.endFrame * scale)), c.durationFrames)
    return { text: w.text, startFrame: start, endFrame: end }
  })
}

export function setClipDuration(c: Clip, newDuration: number): void {
  const old = c.durationFrames
  c.durationFrames = newDuration
  rescaleWordTimings(c, old)
  clampKeyframesToDuration(c)
  clampFadesToDuration(c)
}

export function pruneUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k]
  return o
}

/** Fresh clip id; link/caption group ids remapped consistently through `groups`. */
export function freshenClipIds(c: Clip, groups: Map<string, string>): void {
  const remap = (old?: string) => {
    if (!old) return undefined
    let next = groups.get(old)
    if (!next) {
      next = newId()
      groups.set(old, next)
    }
    return next
  }
  c.id = newId()
  if (c.linkGroupId) c.linkGroupId = remap(c.linkGroupId)
  if (c.captionGroupId) c.captionGroupId = remap(c.captionGroupId)
}

export const trackEndFrame = (t: Track): number => t.clips.reduce((m, c) => Math.max(m, endFrame(c)), 0)
