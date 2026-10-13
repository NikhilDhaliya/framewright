/**
 * Beat This! post-processing (spec 07 §3.4; Mac `Audio/Beats/BeatDetector.swift`): 1500-frame chunking with
 * keep-first stitching, peak picking, BPM, and timeline beat snap frames (03 §13). Pure.
 */
import type { Clip } from '../model'
import { round } from '../timeline'

export const BEAT_SAMPLE_RATE = 22050
export const BEAT_HOP = 441
export const BEAT_CHUNK_FRAMES = 1500
export const BEAT_CHUNK_SAMPLES = (BEAT_CHUNK_FRAMES - 1) * BEAT_HOP // 661059
export const BEAT_BORDER = 6
const STRIDE_FRAMES = BEAT_CHUNK_FRAMES - 2 * BEAT_BORDER // 1488

/** Cached analysis `{bpm, beats, downbeats}` in source seconds. */
export interface BeatAnalysis {
  bpm: number
  beats: number[]
  downbeats: number[]
}

export type LogitsModel = (chunk: Float32Array) => Promise<{ beat: ArrayLike<number>; downbeat: ArrayLike<number> }>

/** `predictLogits`: runs the model over overlapping chunks; frames keep the first chunk's value. */
export async function predictLogits(samples: Float32Array, model: LogitsModel, isCancelled?: () => boolean): Promise<{ beat: Float32Array; downbeat: Float32Array }> {
  const totalFrames = Math.max(1, Math.floor(samples.length / BEAT_HOP) + 1)
  const beat = new Float32Array(totalFrames).fill(-Infinity)
  const downbeat = new Float32Array(totalFrames).fill(-Infinity)
  for (let chunkStart = -BEAT_BORDER; chunkStart + BEAT_BORDER < totalFrames; chunkStart += STRIDE_FRAMES) {
    if (isCancelled?.()) throw new DOMException('Aborted', 'AbortError')
    const chunk = new Float32Array(BEAT_CHUNK_SAMPLES)
    const s0 = chunkStart * BEAT_HOP
    const lo = Math.max(0, s0)
    const hi = Math.min(samples.length, s0 + BEAT_CHUNK_SAMPLES)
    if (hi > lo) chunk.set(samples.subarray(lo, hi), lo - s0)
    const out = await model(chunk)
    for (let i = BEAT_BORDER; i < BEAT_CHUNK_FRAMES - BEAT_BORDER; i++) {
      const g = chunkStart + i
      if (g >= 0 && g < totalFrames && beat[g] === -Infinity) {
        beat[g] = out.beat[i]
        downbeat[g] = out.downbeat[i]
      }
    }
  }
  return { beat, downbeat }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

/** Local maxima with sigmoid ≥ 0.5 (left ≥, right >), as seconds. */
export function pickPeaks(logits: ArrayLike<number>): number[] {
  const out: number[] = []
  for (let i = 1; i < logits.length - 1; i++) {
    if (sigmoid(logits[i]) >= 0.5 && logits[i] >= logits[i - 1] && logits[i] > logits[i + 1]) out.push((i * BEAT_HOP) / BEAT_SAMPLE_RATE)
  }
  return out
}

/** `60 / median(diffs)` (upper median), 0 when ≤ 2 beats. */
export function estimateBPM(beats: readonly number[]): number {
  if (beats.length <= 2) return 0
  const diffs = beats
    .slice(1)
    .map((b, i) => b - beats[i])
    .sort((a, b) => a - b)
  const m = diffs[Math.floor(diffs.length / 2)]
  return m > 0 ? 60 / m : 0
}

export function beatAnalysis(logits: { beat: ArrayLike<number>; downbeat: ArrayLike<number> }): BeatAnalysis {
  const beats = pickPeaks(logits.beat)
  return { bpm: estimateBPM(beats), beats, downbeats: pickPeaks(logits.downbeat) }
}

/** `beatSnapFrames(clip)`: timeline frames of every beat and downbeat inside the clip (deduplicated, sorted). */
export function beatSnapFrames(c: Clip, a: BeatAnalysis, fps: number): number[] {
  const out = new Set<number>()
  const end = c.startFrame + c.durationFrames
  for (const t of [...a.beats, ...a.downbeats]) {
    const src = t * fps - c.trimStartFrame
    if (src < 0) continue
    const f = round(c.startFrame + src / Math.max(c.speed, 1e-4))
    if (f >= c.startFrame && f < end) out.add(f)
  }
  return [...out].sort((x, y) => x - y)
}

/** Ticks for drawing: beats within 30 ms of a downbeat render as the downbeat. Seconds in source. */
export function beatTicks(a: BeatAnalysis): { t: number; down: boolean }[] {
  const ticks = a.downbeats.map((t) => ({ t, down: true }))
  for (const b of a.beats) if (!a.downbeats.some((d) => Math.abs(d - b) < 0.03)) ticks.push({ t: b, down: false })
  return ticks.sort((x, y) => x.t - y.t)
}

/** Toast text after detection (§3.4 Triggers). */
export function beatResultMessage(a: BeatAnalysis): { text: string; kind: 'success' | 'warning' } {
  const n = Math.max(a.beats.length, a.downbeats.length)
  if (!n) return { text: 'No beats detected.', kind: 'warning' }
  return { text: a.bpm > 0 ? `Detected ${n} beats at ${Math.round(a.bpm)} BPM.` : `Detected ${n} beats.`, kind: 'success' }
}
