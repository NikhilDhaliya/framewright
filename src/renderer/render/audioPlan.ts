/**
 * What is audible and how loud (spec 04 §10): audible clips with nests expanded, and the
 * piecewise-linear gain envelope macOS feeds to AVAudioMix. Pure: used by preview and export.
 */
import { denoiseOf } from '@core/audio/denoise'
import { endFrame, volumeAt } from '@core/clip'
import { isActive, swiftRound, type Keyframe } from '@core/keyframes'
import type { Clip, Timeline } from '@core/model'
import { assetDurationSec, flattenNest, NEST_MAX_DEPTH, sourceTiming, type MediaInfo, type SourceTiming } from './plan'

export interface AudioPiece {
  /** Unique per contribution (nested ids are `carrier/child`). */
  key: string
  /** Clip in parent-timeline frames; nested clips carry the folded intermediate carrier volume. */
  clip: Clip
  /** Top nest carrier whose full envelope multiplies in. */
  carrier?: Clip
  info: MediaInfo
  path: string
  timing: SourceTiming
  /**
   * Denoise blend (CompositionBuilder `insertDenoisedTwin`): the dry piece plays at `1 − strength`, its wet
   * twin (path = the baked wet WAV, key `<key>#wet`) at `strength`. Absent = dry at unity.
   */
  denoise?: { role: 'dry' | 'wet'; gain: number }
}

export interface AudioEnv {
  fps: number
  timelines: Timeline[]
  media(id: string): MediaInfo | undefined
}

/** Audible contributions of a timeline in track order (§10.1, §10.4). Muted tracks contribute nothing. */
export function audioPieces(tl: Timeline, env: AudioEnv): AudioPiece[] {
  const out: AudioPiece[] = []
  for (const track of tl.tracks) {
    if (track.type !== 'audio' || track.muted) continue
    lane(
      [...track.clips].sort((a, b) => a.startFrame - b.startFrame),
      undefined,
      0,
      env,
      out,
    )
  }
  return out
}

function lane(clips: Clip[], nest: { top: Clip; scale: number } | undefined, depth: number, env: AudioEnv, out: AudioPiece[]): void {
  let prevEnd = -Infinity
  for (const original of clips) {
    if (original.durationFrames <= 0 || original.startFrame < prevEnd) continue
    // The overlap gate advances before the source loads, so an offline clip still blocks overlaps.
    prevEnd = endFrame(original)
    if (original.sourceClipType === 'sequence') {
      expandNest(original, nest?.top ?? original, nest ? nest.scale * original.volume : 1, depth, env, out)
      continue
    }
    const clip = nest ? { ...original, volume: original.volume * nest.scale } : original
    const info = env.media(clip.mediaRef)
    if (!info?.path) continue
    if (!(info.type === 'audio' || (info.type === 'video' && info.hasAudio !== false))) continue
    const timing = sourceTiming(clip, env.fps, assetDurationSec(info))
    if (!timing) continue
    out.push({ key: clip.id, clip, carrier: nest?.top, info, path: info.path, timing })
  }
}

function expandNest(carrier: Clip, top: Clip, scale: number, depth: number, env: AudioEnv, out: AudioPiece[]): void {
  if (depth >= NEST_MAX_DEPTH) return
  const child = env.timelines.find((t) => t.id === carrier.mediaRef)
  if (!child) return
  for (const clips of flattenNest(carrier, child, false)) lane(clips, { top, scale }, depth + 1, env, out)
}

/** `hasDenoiseEnabled ? clamp(denoiseAmount, 0, 1) : 0` (Timeline.swift). */
export function denoiseStrength(c: Clip): number {
  const d = denoiseOf(c)
  if (!d?.enabled) return 0
  return Number.isFinite(d.amount) ? Math.min(1, Math.max(0, d.amount)) : 0
}

/** Media refs whose wet file the plan wants: top-level (non-nested) pieces with denoise strength > 0. */
export function denoiseRefs(pieces: AudioPiece[]): string[] {
  return [...new Set(pieces.filter((p) => !p.carrier && denoiseStrength(p.clip) > 0).map((p) => p.clip.mediaRef))]
}

/**
 * Adds the wet twin of every top-level piece with denoise strength > 0 whose wet file is baked
 * (`wetPath(mediaRef)` → path). Unbaked media and nested clips play dry at unity, as on macOS.
 */
export function withDenoise(pieces: AudioPiece[], wetPath: (mediaRef: string) => string | null | undefined): AudioPiece[] {
  const out: AudioPiece[] = []
  for (const p of pieces) {
    const s = p.carrier ? 0 : denoiseStrength(p.clip)
    const wet = s > 0 ? wetPath(p.clip.mediaRef) : null
    if (!wet) {
      out.push(p)
      continue
    }
    out.push({ ...p, denoise: { role: 'dry', gain: 1 - s } })
    out.push({ ...p, key: `${p.key}#wet`, path: wet, denoise: { role: 'wet', gain: s } })
  }
  return out
}

/** The piece's gain envelope including its denoise dry/wet split. */
export function pieceEnvelope(p: AudioPiece): GainEnvelope {
  return gainEnvelope(p.clip, p.carrier, p.denoise?.gain ?? 1)
}

export interface GainEnvelope {
  /** Clip-relative frame offsets, ascending, first 0 and last durationFrames. */
  offsets: number[]
  /** Linear gain at each offset; linear ramps in between (§10.3). */
  gains: number[]
}

const SMOOTH_SEGMENTS = 8

export function smoothSubdivisions(a: number, b: number): number[] {
  if (b <= a) return []
  const span = b - a
  const set = new Set<number>()
  for (let i = 1; i < SMOOTH_SEGMENTS; i++) set.add(a + swiftRound((span * i) / SMOOTH_SEGMENTS))
  return [...set].sort((x, y) => x - y)
}

function normalizedKeyframes<V>(kfs: Keyframe<V>[], duration: number): Keyframe<V>[] {
  const keyed = new Map<number, Keyframe<V>>()
  for (const k of kfs) if (k.frame >= 0 && k.frame <= duration) keyed.set(k.frame, k)
  return [...keyed.values()].sort((a, b) => a.frame - b.frame)
}

/** Port of `emitVolumeEnvelope` / `emitEnvelopeRamps`; `gain` is the denoise dry/wet split (1 = dry only). */
export function gainEnvelope(clip: Clip, carrier?: Clip, gain = 1): GainEnvelope {
  const D = clip.durationFrames
  const kfs = normalizedKeyframes(clip.volumeTrack?.keyframes ?? [], D)
  const hasFade = clip.fadeInFrames > 0 || clip.fadeOutFrames > 0
  const carrierVaries = !!carrier && (isActive(carrier.volumeTrack) || carrier.fadeInFrames > 0 || carrier.fadeOutFrames > 0)
  const sampleAt = (o: number) => {
    const f = clip.startFrame + o
    return volumeAt(clip, f) * (carrier ? volumeAt(carrier, f) : 1) * gain
  }
  if (!kfs.length && !hasFade && !carrierVaries) {
    const g = sampleAt(0)
    return { offsets: [0, D], gains: [g, g] }
  }
  const set = new Set<number>([0, D])
  if (carrier && carrierVaries) {
    const toClip = (o: number) => carrier.startFrame + o - clip.startFrame
    const extra: number[] = []
    if (carrier.fadeInFrames > 0) {
      extra.push(toClip(carrier.fadeInFrames))
      if (carrier.fadeInInterpolation === 'smooth') extra.push(...smoothSubdivisions(0, carrier.fadeInFrames).map(toClip))
    }
    if (carrier.fadeOutFrames > 0) {
      const fadeStart = carrier.durationFrames - carrier.fadeOutFrames
      extra.push(toClip(fadeStart))
      if (carrier.fadeOutInterpolation === 'smooth') extra.push(...smoothSubdivisions(fadeStart, carrier.durationFrames).map(toClip))
    }
    const ck = carrier.volumeTrack?.keyframes ?? []
    for (const k of ck) extra.push(toClip(k.frame))
    for (let i = 0; i + 1 < ck.length; i++) if (ck[i].interpolationOut === 'hold') extra.push(toClip(ck[i + 1].frame) - 1)
    for (const o of extra) if (o > 0 && o < D) set.add(o)
  }
  for (const k of kfs) set.add(k.frame)
  for (let i = 0; i + 1 < kfs.length; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (a.interpolationOut === 'smooth') for (const o of smoothSubdivisions(a.frame, b.frame)) set.add(o)
    else if (a.interpolationOut === 'hold' && b.frame - a.frame > 1) set.add(b.frame - 1)
  }
  if (clip.fadeInFrames > 0) {
    const end = Math.min(D, clip.fadeInFrames)
    set.add(end)
    if (clip.fadeInInterpolation === 'smooth') for (const o of smoothSubdivisions(0, end)) set.add(o)
  }
  if (clip.fadeOutFrames > 0) {
    const start = Math.max(0, D - clip.fadeOutFrames)
    set.add(start)
    if (clip.fadeOutInterpolation === 'smooth') for (const o of smoothSubdivisions(start, D)) set.add(o)
  }
  const offsets = [...set].sort((a, b) => a - b)
  return { offsets, gains: offsets.map(sampleAt) }
}

/** Linear gain of an envelope at a (fractional) clip offset. */
export function envelopeAt(env: GainEnvelope, offset: number): number {
  const { offsets: o, gains: g } = env
  if (offset <= o[0]) return g[0]
  for (let i = 1; i < o.length; i++) {
    if (offset <= o[i]) {
      const t = (offset - o[i - 1]) / (o[i] - o[i - 1])
      return g[i - 1] + (g[i] - g[i - 1]) * t
    }
  }
  return g[g.length - 1]
}
