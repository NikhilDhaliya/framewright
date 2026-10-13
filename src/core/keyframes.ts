export type Interpolation = 'linear' | 'hold' | 'smooth'

export interface Keyframe<V> {
  frame: number
  value: V
  interpolationOut: Interpolation
}

export interface KeyframeTrack<V> {
  keyframes: Keyframe<V>[]
}

export interface AnimPair {
  a: number
  b: number
}

export type Lerp<V> = (a: V, b: V, t: number) => V

export const smoothstep = (t: number): number => t * t * (3 - 2 * t)

export const lerpNumber: Lerp<number> = (a, b, t) => a + (b - a) * t
export const lerpPair: Lerp<AnimPair> = (x, y, t) => ({ a: lerpNumber(x.a, y.a, t), b: lerpNumber(x.b, y.b, t) })

export function isActive<V>(track: KeyframeTrack<V> | null | undefined): track is KeyframeTrack<V> {
  return !!track && track.keyframes.length > 0
}

export function sampleTrack<V>(track: KeyframeTrack<V> | null | undefined, frame: number, fallback: V, lerp: Lerp<V>): V {
  if (!track || track.keyframes.length === 0) return fallback
  const kfs = track.keyframes
  if (kfs.length === 1) return kfs[0].value
  if (frame <= kfs[0].frame) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (frame >= last.frame) return last.value
  let bIdx = 1
  while (bIdx < kfs.length && kfs[bIdx].frame <= frame) bIdx++
  if (bIdx >= kfs.length) return last.value
  const a = kfs[bIdx - 1]
  const b = kfs[bIdx]
  const raw = (frame - a.frame) / (b.frame - a.frame)
  switch (a.interpolationOut) {
    case 'hold':
      return a.value
    case 'linear':
      return lerp(a.value, b.value, raw)
    case 'smooth':
      return lerp(a.value, b.value, smoothstep(raw))
  }
}

export function upsertKeyframe<V>(track: KeyframeTrack<V> | null | undefined, kf: Keyframe<V>): KeyframeTrack<V> {
  const kfs = track ? [...track.keyframes] : []
  const i = kfs.findIndex((k) => k.frame === kf.frame)
  if (i >= 0) kfs[i] = kf
  else {
    const at = kfs.findIndex((k) => k.frame > kf.frame)
    kfs.splice(at < 0 ? kfs.length : at, 0, kf)
  }
  return { keyframes: kfs }
}

export function removeKeyframe<V>(track: KeyframeTrack<V> | null | undefined, frame: number): KeyframeTrack<V> | undefined {
  if (!track) return undefined
  const kfs = track.keyframes.filter((k) => k.frame !== frame)
  return kfs.length ? { keyframes: kfs } : undefined
}

export function moveKeyframe<V>(track: KeyframeTrack<V> | null | undefined, from: number, to: number): KeyframeTrack<V> | undefined {
  if (!track) return undefined
  const i = track.keyframes.findIndex((k) => k.frame === from)
  if (i < 0) return track
  if (to !== from && track.keyframes.some((k) => k.frame === to)) return track
  const kfs = [...track.keyframes]
  const [kf] = kfs.splice(i, 1)
  return upsertKeyframe({ keyframes: kfs }, { ...kf, frame: to })
}

/** Keyframes clipped to [0, duration] with the boundary snapped inside the clip. */
export function clampTrackToDuration<V>(track: KeyframeTrack<V> | null | undefined, duration: number): KeyframeTrack<V> | undefined {
  if (!track) return undefined
  let out: KeyframeTrack<V> = { keyframes: [] }
  for (const kf of track.keyframes) {
    if (kf.frame < 0 || kf.frame > duration) continue
    out = upsertKeyframe(out, { ...kf, frame: Math.min(kf.frame, Math.max(0, duration - 1)) })
  }
  return out.keyframes.length ? out : undefined
}

export function rescaleTrack<V>(track: KeyframeTrack<V> | null | undefined, scale: number, duration: number): KeyframeTrack<V> | undefined {
  if (!track) return undefined
  if (!Number.isFinite(scale) || scale <= 0) return track
  let out: KeyframeTrack<V> = { keyframes: [] }
  for (const kf of track.keyframes) {
    out = upsertKeyframe(out, { ...kf, frame: Math.min(Math.max(0, duration - 1), Math.round(kf.frame * scale)) })
  }
  return out.keyframes.length ? out : undefined
}

/** Shift a track so `offset` becomes frame 0, inserting a boundary keyframe sampled at the cut. */
export function rebaseTrack<V>(track: KeyframeTrack<V> | null | undefined, offset: number, fallback: V, lerp: Lerp<V>): KeyframeTrack<V> | undefined {
  if (!isActive(track)) return undefined
  const boundary = sampleTrack(track, offset, fallback, lerp)
  const kfs: Keyframe<V>[] = track.keyframes
    .filter((k) => k.frame >= offset)
    .map((k) => ({ frame: k.frame - offset, value: k.value, interpolationOut: k.interpolationOut }))
  if (kfs[0]?.frame !== 0) {
    let interp: Interpolation = 'smooth'
    for (const k of track.keyframes) if (k.frame < offset) interp = k.interpolationOut
    kfs.unshift({ frame: 0, value: boundary, interpolationOut: interp })
  }
  return kfs.length ? { keyframes: kfs } : undefined
}

/** Swift rounds .5 away from zero; JS Math.round rounds toward +∞. */
export function swiftRound(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x)
}
