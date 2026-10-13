/**
 * Frame sampler logic (spec 07 §2.3, Mac `Search/Indexing/FrameSampler.swift`), `samplerVersion = 1`. Pure: the
 * candidate times, the 8×8 luma fingerprint and the keep/new-shot decision. Decoding lives in main
 * (`src/main/ml/search/frames.ts`).
 */

export const SAMPLER_VERSION = 1

export interface SamplerOptions {
  candidateInterval: number
  coverageFloor: number
  promoteDiff: number
  maxSize: number
  highResEdge: number
}

export const DEFAULT_SAMPLER_OPTIONS: SamplerOptions = { candidateInterval: 2.0, coverageFloor: 8.0, promoteDiff: 12, maxSize: 512, highResEdge: 3000 }

/** Candidate spacing: doubled for ≥ 3000 px sources. */
export function samplerInterval(naturalWidth: number, naturalHeight: number, o: SamplerOptions = DEFAULT_SAMPLER_OPTIONS): number {
  return o.candidateInterval * (Math.max(Math.abs(naturalWidth), Math.abs(naturalHeight)) >= o.highResEdge ? 2 : 1)
}

/** `stride(from: interval/2, to: duration, by: interval)`, or `[duration/2]` when empty; no frames for duration ≤ 0. */
export function candidateTimes(duration: number, interval: number): number[] {
  if (!(duration > 0)) return []
  const out: number[] = []
  // Swift's stride computes start + i·step (no accumulated error).
  for (let i = 0; ; i++) {
    const t = interval / 2 + i * interval
    if (!(t < duration)) break
    out.push(t)
  }
  return out.length ? out : [duration / 2]
}

/** Decode tolerance around each candidate: ±max(interval/2, 1 s). */
export const samplerTolerance = (interval: number): number => Math.max(interval / 2, 1.0)

export const LUMA_CELLS = 8

/**
 * Mean luma per cell of an 8×8 area-average downsample of an RGBA image (premultiplied over black, like the Mac's
 * premultipliedLast context). Luma = .299R + .587G + .114B in 0…255.
 */
export function lumaGrid(rgba: Uint8Array, width: number, height: number): Float32Array {
  const n = LUMA_CELLS
  const out = new Float32Array(n * n)
  if (width <= 0 || height <= 0) return out
  for (let cy = 0; cy < n; cy++) {
    const y0 = (cy * height) / n
    const y1 = ((cy + 1) * height) / n
    for (let cx = 0; cx < n; cx++) {
      const x0 = (cx * width) / n
      const x1 = ((cx + 1) * width) / n
      let r = 0
      let g = 0
      let b = 0
      let area = 0
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0)
        if (wy <= 0) continue
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0)
          if (wx <= 0) continue
          const w = wx * wy
          const i = (y * width + x) * 4
          const a = rgba[i + 3] / 255
          r += rgba[i] * a * w
          g += rgba[i + 1] * a * w
          b += rgba[i + 2] * a * w
          area += w
        }
      }
      // The Mac context stores 8-bit pixels: round each channel before computing luma.
      const R = Math.round(r / area)
      const G = Math.round(g / area)
      const B = Math.round(b / area)
      out[cy * n + cx] = Math.fround(Math.fround(Math.fround(R * 0.299) + Math.fround(G * 0.587)) + Math.fround(B * 0.114))
    }
  }
  return out
}

export function lumaMeanDiff(a: Float32Array, b: Float32Array): number {
  let diff = 0
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
  return diff / a.length
}

export interface SampledFrameDecision {
  keep: boolean
  isNewShot: boolean
}

/** The per-frame state machine: monotonic times, new shot on a luma jump, coverage floor for static shots. */
export class ShotDetector {
  private lastGrid: Float32Array | null = null
  private lastKeptTime = -Infinity
  private lastTime = -Infinity

  constructor(private readonly o: SamplerOptions = DEFAULT_SAMPLER_OPTIONS) {}

  /** Null = skip (not after the previous decoded frame). */
  accept(time: number, grid: Float32Array): SampledFrameDecision | null {
    if (!(time > this.lastTime)) return null
    this.lastTime = time
    const isNewShot = this.lastGrid ? lumaMeanDiff(grid, this.lastGrid) > this.o.promoteDiff : true
    this.lastGrid = grid
    if (!(isNewShot || time - this.lastKeptTime >= this.o.coverageFloor)) return { keep: false, isNewShot }
    this.lastKeptTime = time
    return { keep: true, isNewShot }
  }
}

export interface IndexedFrame {
  time: number
  isNewShot: boolean
}

/** Rows for the store from the kept frames (spec 07 §2.4 "Video"). */
export function shotRows(frames: IndexedFrame[], duration: number): { time: number; shotStart: number; shotEnd: number }[] {
  const shotStarts: number[] = []
  const shotIndex: number[] = []
  for (const f of frames) {
    if (f.isNewShot) shotStarts.push(shotStarts.length === 0 ? 0 : f.time)
    shotIndex.push(shotStarts.length - 1)
  }
  return frames.map((f, i) => {
    const s = shotIndex[i]
    return { time: f.time, shotStart: shotStarts[s], shotEnd: s + 1 < shotStarts.length ? shotStarts[s + 1] : duration }
  })
}
