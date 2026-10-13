/**
 * Voice activity (spec 07 §3.2; Mac `Audio/Analysis/VoiceActivity.swift` + speech-swift `VADPipeline`): Silero v5
 * per-chunk probabilities → speech segments → 32 ms cell masks. Pure.
 */

/** Silero v5 chunk: 512 samples at 16 kHz = 32 ms. */
export const VAD_SAMPLE_RATE = 16000
export const VAD_CHUNK_SAMPLES = 512
export const VAD_CONTEXT_SAMPLES = 64
export const CELL_SECONDS = 0.032

export interface SpeechSegment {
  start: number
  end: number
}

/** The cached VAD result (`<ref>_<size>_<mtime>_vad.json`). */
export interface SpeechActivity {
  chunkCount: number
  segments: SpeechSegment[]
}

export const VAD_CONFIG = { onset: 0.5, offset: 0.35, minSpeechDuration: 0.25, minSilenceDuration: 0.1 } as const

/** `VADConfig.sileroDefault` binarization over per-chunk probabilities (not silero's Python defaults). */
export function binarize(probs: ArrayLike<number>, frame = CELL_SECONDS): SpeechSegment[] {
  const raw: SpeechSegment[] = []
  let inSpeech = false
  let start = 0
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]
    const t = i * frame
    if (!inSpeech && p >= VAD_CONFIG.onset) {
      inSpeech = true
      start = t
    } else if (inSpeech && p < VAD_CONFIG.offset) {
      inSpeech = false
      raw.push({ start, end: t })
    }
  }
  if (inSpeech) raw.push({ start, end: probs.length * frame })
  const long = raw.filter((s) => s.end - s.start >= VAD_CONFIG.minSpeechDuration)
  const merged: SpeechSegment[] = []
  for (const s of long) {
    const last = merged[merged.length - 1]
    if (last && s.start - last.end < VAD_CONFIG.minSilenceDuration) last.end = s.end
    else merged.push({ ...s })
  }
  return merged
}

/** `VoiceActivity.mask`: true where a segment covers the 32 ms cell. */
export function speechMask(a: SpeechActivity): boolean[] {
  const mask = new Array<boolean>(Math.max(0, a.chunkCount)).fill(false)
  for (const s of a.segments) {
    const lo = Math.max(0, Math.floor(s.start / CELL_SECONDS))
    const hi = Math.min(a.chunkCount, Math.ceil(s.end / CELL_SECONDS))
    for (let c = lo; c < hi; c++) mask[c] = true
  }
  return mask
}

/** Run-length form `[start, end)` of the true cells (compact JSON for masks). */
export function maskRuns(mask: ArrayLike<boolean>): [number, number][] {
  const runs: [number, number][] = []
  let i = 0
  while (i < mask.length) {
    if (!mask[i]) {
      i++
      continue
    }
    let j = i + 1
    while (j < mask.length && mask[j]) j++
    runs.push([i, j])
    i = j
  }
  return runs
}

export function maskFromRuns(runs: readonly (readonly [number, number])[], count: number): boolean[] {
  const mask = new Array<boolean>(Math.max(0, count)).fill(false)
  for (const [a, b] of runs) for (let c = Math.max(0, a); c < Math.min(count, b); c++) mask[c] = true
  return mask
}
