import {
  blurKeyframeTrack,
  blurRadiusAt,
  clampFadesToDuration,
  containsFrame,
  cropAt,
  dbToLinear,
  rawOpacityAt,
  rotationAt,
  sizeAt,
  topLeftAt,
} from '../clip'
import { isActive, lerpNumber, moveKeyframe, removeKeyframe, sampleTrack, upsertKeyframe, type AnimPair, type Interpolation, type KeyframeTrack } from '../keyframes'
import { BLEND_MODES, CROP_MIN_VISIBLE, defaultTextStyle as defaultTextStyleLazy, newId, type BlendMode, type Clip, type Crop, type Effect, type Transform } from '../model'
import { EditRefusal, effectInsertIndex, findClip, setBlurKeyframeTrack } from '../timeline'
import { activeTimeline, type Doc } from './context'

export type AnimatableProperty = 'opacity' | 'position' | 'scale' | 'rotation' | 'crop' | 'blur' | 'volume'
export const VISUAL_LANE_ORDER: AnimatableProperty[] = ['position', 'scale', 'rotation', 'opacity', 'blur', 'crop']

export function supportsKeyframes(c: Clip, p: AnimatableProperty): boolean {
  const t = c.mediaType
  switch (p) {
    case 'volume':
      return t === 'audio'
    case 'position':
    case 'rotation':
    case 'opacity':
    case 'blur':
      return t !== 'audio' && t !== 'subtitle'
    case 'scale':
      return t === 'video' || t === 'image' || t === 'lottie' || t === 'sequence' || t === 'text'
    case 'crop':
      return t === 'video' || t === 'image' || t === 'lottie' || t === 'sequence'
  }
}

type AnyTrack = KeyframeTrack<number> | KeyframeTrack<AnimPair> | KeyframeTrack<Crop>

export function propertyTrack(c: Clip, p: AnimatableProperty): AnyTrack | undefined {
  switch (p) {
    case 'opacity':
      return c.opacityTrack
    case 'position':
      return c.positionTrack
    case 'scale':
      return c.scaleTrack
    case 'rotation':
      return c.rotationTrack
    case 'crop':
      return c.cropTrack
    case 'volume':
      return c.volumeTrack
    case 'blur':
      return blurKeyframeTrack(c)
  }
}

function setPropertyTrack(c: Clip, p: AnimatableProperty, track: AnyTrack | undefined): void {
  const t = track && track.keyframes.length ? track : undefined
  const assign = <K extends keyof Clip>(k: K) => {
    if (t) (c as unknown as Record<string, unknown>)[k] = t
    else delete c[k]
  }
  switch (p) {
    case 'opacity':
      return assign('opacityTrack')
    case 'position':
      return assign('positionTrack')
    case 'scale':
      return assign('scaleTrack')
    case 'rotation':
      return assign('rotationTrack')
    case 'crop':
      return assign('cropTrack')
    case 'volume':
      return assign('volumeTrack')
    case 'blur':
      return setBlurKeyframeTrack(c, t as KeyframeTrack<number> | undefined)
  }
}

export function keyframeFrames(c: Clip, p: AnimatableProperty): number[] {
  return (propertyTrack(c, p)?.keyframes ?? []).map((k) => k.frame + c.startFrame)
}

/** Current resolved value of a property, as stamped into a new keyframe. */
export function resolvedValue(c: Clip, p: AnimatableProperty, frame: number): number | AnimPair | Crop {
  switch (p) {
    case 'opacity':
      return rawOpacityAt(c, frame)
    case 'position':
      return topLeftAt(c, frame)
    case 'scale':
      return sizeAt(c, frame)
    case 'rotation':
      return rotationAt(c, frame)
    case 'crop':
      return cropAt(c, frame)
    case 'blur':
      return blurRadiusAt(c, frame)
    case 'volume':
      return sampleTrack(c.volumeTrack, frame - c.startFrame, 0, lerpNumber)
  }
}

function getClip(doc: Doc, id: string): Clip {
  const loc = findClip(activeTimeline(doc), id)
  if (!loc) throw new EditRefusal(`Clip ${id} not found.`)
  return loc.clip
}

function upsertValue(c: Clip, p: AnimatableProperty, frame: number, value: unknown, interpolation: Interpolation = 'smooth'): void {
  const kf = { frame: frame - c.startFrame, value, interpolationOut: interpolation }
  setPropertyTrack(c, p, upsertKeyframe(propertyTrack(c, p) as KeyframeTrack<unknown>, kf) as AnyTrack)
}

export function stampKeyframe(doc: Doc, clipId: string, p: AnimatableProperty, frame: number): void {
  const c = getClip(doc, clipId)
  if (!supportsKeyframes(c, p)) throw new EditRefusal(`This clip can't animate ${p}.`)
  if (!containsFrame(c, frame)) throw new EditRefusal('The playhead is outside the clip.')
  upsertValue(c, p, frame, resolvedValue(c, p, frame))
}

export function toggleKeyframe(doc: Doc, clipId: string, p: AnimatableProperty, frame: number): void {
  const c = getClip(doc, clipId)
  if (keyframeFrames(c, p).includes(frame)) setPropertyTrack(c, p, removeKeyframe(propertyTrack(c, p) as KeyframeTrack<unknown>, frame - c.startFrame) as AnyTrack | undefined)
  else stampKeyframe(doc, clipId, p, frame)
}

export function deleteKeyframe(doc: Doc, clipId: string, p: AnimatableProperty, frame: number): void {
  const c = getClip(doc, clipId)
  if (!keyframeFrames(c, p).includes(frame)) throw new EditRefusal('No keyframe there.')
  setPropertyTrack(c, p, removeKeyframe(propertyTrack(c, p) as KeyframeTrack<unknown>, frame - c.startFrame) as AnyTrack | undefined)
}

export function setKeyframeInterpolation(doc: Doc, clipId: string, p: AnimatableProperty, frame: number, interpolation: Interpolation): void {
  const c = getClip(doc, clipId)
  const track = propertyTrack(c, p)
  const k = track?.keyframes.find((x) => x.frame === frame - c.startFrame)
  if (!track || !k) throw new EditRefusal('No keyframe there.')
  if (k.interpolationOut === interpolation) throw new EditRefusal('Unchanged.')
  setPropertyTrack(c, p, { keyframes: track.keyframes.map((x) => (x === k ? { ...x, interpolationOut: interpolation } : x)) } as AnyTrack)
}

export function moveKeyframeTo(doc: Doc, clipId: string, p: AnimatableProperty, from: number, to: number): void {
  const c = getClip(doc, clipId)
  const lo = c.startFrame
  const hi = Math.max(c.startFrame, c.startFrame + c.durationFrames - 1)
  if (to < lo || to > hi) throw new EditRefusal('Keyframes must stay inside the clip.')
  const track = propertyTrack(c, p) as KeyframeTrack<unknown> | undefined
  if (!track?.keyframes.some((k) => k.frame === from - c.startFrame)) throw new EditRefusal('No keyframe there.')
  setPropertyTrack(c, p, moveKeyframe(track, from - c.startFrame, to - c.startFrame) as AnyTrack | undefined)
}

export function clearKeyframes(doc: Doc, clipId: string, p: AnimatableProperty): void {
  const c = getClip(doc, clipId)
  if (!isActive(propertyTrack(c, p) as KeyframeTrack<unknown>)) throw new EditRefusal('No keyframes to clear.')
  setPropertyTrack(c, p, undefined)
}

// ---------- Animation-aware property writes ----------

/** If the property is animated, writes a keyframe at `frame` (ignored outside the clip); else the static value. */
function writeAnimated(c: Clip, p: AnimatableProperty, frame: number, value: unknown, writeStatic: () => void): void {
  if (isActive(propertyTrack(c, p) as KeyframeTrack<unknown>)) {
    if (containsFrame(c, frame)) upsertValue(c, p, frame, value)
  } else writeStatic()
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

export function writeOpacity(c: Clip, frame: number, v: number): void {
  const o = clamp01(v)
  writeAnimated(c, 'opacity', frame, o, () => (c.opacity = o))
}

export function writeRotation(c: Clip, frame: number, deg: number): void {
  if (!Number.isFinite(deg)) return
  writeAnimated(c, 'rotation', frame, deg, () => (c.transform.rotation = deg))
}

export function normalizedCrop(crop: Crop): Crop {
  const out = { ...crop }
  for (const k of ['left', 'top', 'right', 'bottom'] as const) out[k] = Math.max(0, Number.isFinite(out[k]) ? out[k] : 0)
  out.left = Math.min(out.left, 1 - CROP_MIN_VISIBLE - out.right)
  out.right = Math.min(out.right, 1 - CROP_MIN_VISIBLE - out.left)
  out.top = Math.min(out.top, 1 - CROP_MIN_VISIBLE - out.bottom)
  out.bottom = Math.min(out.bottom, 1 - CROP_MIN_VISIBLE - out.top)
  for (const k of ['left', 'top', 'right', 'bottom'] as const) out[k] = Math.max(0, out[k])
  return out
}

export function writeCrop(c: Clip, frame: number, crop: Crop): void {
  const v = normalizedCrop(crop)
  writeAnimated(c, 'crop', frame, v, () => (c.crop = v))
}

export function setStaticBlurRadius(c: Clip, radius: number): void {
  if (!Number.isFinite(radius)) return
  const r = Math.min(100, Math.max(0, radius))
  if (c.mediaType === 'text') {
    c.textStyle = { ...(c.textStyle ?? defaultTextStyleLazy()), blur: r }
    return
  }
  const stack: Effect[] = [...(c.effects ?? [])]
  const existing = stack.find((e) => e.type === 'blur.gaussian')
  const enabled = existing?.enabled ?? true
  const track = existing?.params.radius?.track
  const without = stack.filter((e) => e.type !== 'blur.gaussian')
  if (r > 0 || track) {
    const effect: Effect = { id: existing?.id ?? newId(), type: 'blur.gaussian', enabled, params: { radius: track ? { value: r, track } : { value: r } } }
    without.splice(effectInsertIndex(without, 'blur.gaussian'), 0, effect)
  }
  if (without.length) c.effects = without
  else delete c.effects
}


export function writeBlur(c: Clip, frame: number, radius: number): void {
  const r = Math.min(100, Math.max(0, radius))
  writeAnimated(c, 'blur', frame, r, () => setStaticBlurRadius(c, r))
}

export function writeVolumeDb(c: Clip, frame: number, db: number): void {
  if (!Number.isFinite(db)) return
  const v = Math.min(15, Math.max(-60, db))
  writeAnimated(c, 'volume', frame, v, () => (c.volume = dbToLinear(v)))
}

export function writeTopLeft(c: Clip, frame: number, x?: number, y?: number): void {
  const tl = topLeftAt(c, frame)
  const next = { a: x ?? tl.a, b: y ?? tl.b }
  writeAnimated(c, 'position', frame, next, () => {
    const sz = sizeAt(c, frame)
    c.transform.centerX = next.a + sz.a / 2
    c.transform.centerY = next.b + sz.b / 2
  })
}

export function writeSize(c: Clip, frame: number, w: number, h: number): void {
  if (!(w > 0 && h > 0)) return
  writeAnimated(c, 'scale', frame, { a: w, b: h }, () => {
    c.transform.width = w
    c.transform.height = h
  })
}

/** Gizmo/whole-transform write: position, size and rotation are each keyframed or static independently. */
export function writeTransform(c: Clip, frame: number, t: Transform): void {
  writeSize(c, frame, t.width, t.height)
  writeTopLeft(c, frame, t.centerX - t.width / 2, t.centerY - t.height / 2)
  writeRotation(c, frame, t.rotation)
  c.transform.flipHorizontal = t.flipHorizontal
  c.transform.flipVertical = t.flipVertical
  c.transform.rotationX = Math.min(89, Math.max(-89, t.rotationX))
  c.transform.rotationY = Math.min(89, Math.max(-89, t.rotationY))
}

export function setFade(c: Clip, edge: 'in' | 'out', frames: number, interpolation?: Interpolation): void {
  const v = Math.max(0, Math.round(frames))
  if (edge === 'in') c.fadeInFrames = v
  else c.fadeOutFrames = v
  if (interpolation) {
    if (edge === 'in') c.fadeInInterpolation = interpolation
    else c.fadeOutInterpolation = interpolation
  }
  clampFadesToDuration(c)
}

export function setBlendMode(c: Clip, mode: BlendMode): void {
  if (!BLEND_MODES.includes(mode)) throw new EditRefusal(`Unknown blend mode ${mode}.`)
  if (mode === 'normal') delete c.blendMode
  else c.blendMode = mode
}

/** Applies `modify` to each clip; refuses if no clip matched or nothing changed. */
export function mutateClips(doc: Doc, ids: Iterable<string>, modify: (c: Clip) => void): string[] {
  const t = activeTimeline(doc)
  const set = new Set(ids)
  const touched: string[] = []
  for (const tr of t.tracks)
    for (const c of tr.clips) {
      if (!set.has(c.id)) continue
      const before = JSON.stringify(c)
      modify(c)
      if (JSON.stringify(c) !== before) touched.push(c.id)
    }
  if (!touched.length) throw new EditRefusal('Nothing changed.')
  return touched
}

// ---------- Effects ----------

export function addEffect(c: Clip, type: string, params: Record<string, number> = {}): Effect {
  const stack = [...(c.effects ?? [])]
  if (stack.some((e) => e.type === type)) throw new EditRefusal(`The clip already has ${type}.`)
  const effect: Effect = { id: newId(), type, enabled: true, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { value: v }])) }
  stack.splice(type === 'audio.denoise' ? stack.length : effectInsertIndex(stack, type), 0, effect)
  c.effects = stack
  return effect
}

export function removeEffect(c: Clip, idOrType: string): void {
  const stack = (c.effects ?? []).filter((e) => e.id !== idOrType && e.type !== idOrType)
  if (stack.length === (c.effects ?? []).length) throw new EditRefusal('Effect not found.')
  if (stack.length) c.effects = stack
  else delete c.effects
}

export function setEffectParam(c: Clip, idOrType: string, key: string, value: number | string): void {
  const e = c.effects?.find((x) => x.id === idOrType || x.type === idOrType)
  if (!e) throw new EditRefusal('Effect not found.')
  const p = { ...(e.params[key] ?? {}) }
  if (typeof value === 'number') p.value = value
  else p.string = value
  e.params = { ...e.params, [key]: p }
}

export function setEffectEnabled(c: Clip, idOrType: string, enabled: boolean): void {
  const e = c.effects?.find((x) => x.id === idOrType || x.type === idOrType)
  if (!e) throw new EditRefusal('Effect not found.')
  e.enabled = enabled
}

export function setEffectParamKeyframe(c: Clip, idOrType: string, key: string, frame: number, value: number): void {
  const e = c.effects?.find((x) => x.id === idOrType || x.type === idOrType)
  if (!e) throw new EditRefusal('Effect not found.')
  const p = { ...(e.params[key] ?? {}) }
  p.track = upsertKeyframe(p.track, { frame: frame - c.startFrame, value, interpolationOut: 'smooth' })
  e.params = { ...e.params, [key]: p }
}
