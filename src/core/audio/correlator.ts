/**
 * Audio sync correlator (spec 07 §3.7) — a verbatim port of the Mac's `Audio/AudioSyncCorrelator.swift`.
 * Inputs are 2.5 ms-hop loudness envelopes; `lag` means target[i] aligns with reference[i + lag]. Pure; the
 * `isCancelled` hook is polled inside every loop (a cancelled run returns null / []).
 */

export interface CorrelationResult {
  lagHops: number
  confidence: number
  driftRatio: number
  exactLagHops: number
}

export const MIN_OVERLAP = 16
const PYRAMID_STRIDE = 2
const MAX_EXACT_LAG_COUNT = 4096
const MAX_CANDIDATES = 16
const CONSENSUS_CHUNK_HOPS = 24_000
const CONSENSUS_CHUNK_COUNT = 5
const CONSENSUS_TOLERANCE_HOPS = 400
const REACQUIRE_RADIUS_HOPS = 800
const DRIFT_FIT_MIN_SPAN_HOPS = 60_000
const MAX_DRIFT_RATIO = 0.0005
const MIN_DRIFT_RATIO = 0.00002

type Samples = ArrayLike<number>
type LagRange = [number, number] // closed
type Cancel = () => boolean

const result = (lagHops: number, confidence: number, driftRatio = 0, exactLagHops?: number): CorrelationResult => ({
  lagHops,
  confidence,
  driftRatio,
  exactLagHops: exactLagHops ?? lagHops,
})

const never: Cancel = () => false

export interface SeededCorrelateArgs {
  reference: Samples
  target: Samples
  seedHops: number | null
  seedWindowHops: number
  maxLagHops: number
  minOverlapHops: number
  minConfidence: number
  isCancelled?: Cancel
}

export function seededCorrelate(a: SeededCorrelateArgs): CorrelationResult | null {
  const windows: { center: number; radius: number }[] = [{ center: 0, radius: a.maxLagHops }]
  if (a.seedHops !== null && a.seedHops !== undefined) windows.push({ center: a.seedHops, radius: a.seedWindowHops })
  return alignByConsensus(a.reference, a.target, windows, a.minOverlapHops, a.minConfidence, a.isCancelled ?? never)
}

function slice(x: Samples, start: number, end: number): Float32Array {
  const out = new Float32Array(end - start)
  for (let i = start; i < end; i++) out[i - start] = x[i]
  return out
}

function alignByConsensus(ref: Samples, tgt: Samples, windows: { center: number; radius: number }[], minOverlapHops: number, minConfidence: number, cancelled: Cancel): CorrelationResult | null {
  const bestAcrossWindows = (chunk: Samples, chunkStart: number, overlap: number): CorrelationResult | null => {
    let best: CorrelationResult | null = null
    for (const w of windows) {
      if (cancelled()) return null
      const c = correlate(ref, chunk, w.radius, w.center + chunkStart, overlap, cancelled)
      if (c && c.confidence > (best?.confidence ?? -Infinity)) best = c
    }
    return best
  }
  const chunkHops = Math.min(tgt.length, CONSENSUS_CHUNK_HOPS)
  let starts = [0]
  if (tgt.length > chunkHops) {
    const maxStart = tgt.length - chunkHops
    starts = [...new Set(Array.from({ length: CONSENSUS_CHUNK_COUNT }, (_, k) => Math.floor((maxStart * k) / (CONSENSUS_CHUNK_COUNT - 1))))].sort((x, y) => x - y)
  }
  const hits: { start: number; center: number; clipLag: number; confidence: number }[] = []
  for (const start of starts) {
    if (cancelled()) return null
    const chunk = slice(tgt, start, start + chunkHops)
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] < lo) lo = chunk[i]
      if (chunk[i] > hi) hi = chunk[i]
    }
    if (lo === hi) continue
    const overlap = Math.min(Math.max(minOverlapHops, Math.floor(chunk.length / 2)), chunk.length)
    let best: CorrelationResult | null = null
    const prev = hits[hits.length - 1]
    if (prev) {
      best = correlate(ref, chunk, REACQUIRE_RADIUS_HOPS, prev.clipLag + start, overlap, cancelled)
      if (best && best.confidence < minConfidence) best = null
    }
    if (!best) best = bestAcrossWindows(chunk, start, overlap)
    if (!best || best.confidence < minConfidence) continue
    hits.push({ start, center: start + chunk.length / 2, clipLag: best.lagHops - start, confidence: best.confidence })
  }
  if (!hits.length) {
    const best = bestAcrossWindows(tgt, 0, minOverlapHops)
    return best && best.confidence >= minConfidence ? best : null
  }
  const sorted = [...hits].sort((x, y) => x.clipLag - y.clipLag)
  let cluster = sorted
  let clusterScore = -Infinity
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].clipLag - sorted[i].clipLag <= CONSENSUS_TOLERANCE_HOPS) j++
    const candidate = sorted.slice(i, j + 1)
    const score = candidate.reduce((s, h) => s + h.confidence, 0)
    if (score > clusterScore) {
      clusterScore = score
      cluster = candidate
    }
  }
  const confidence = cluster.reduce((s, h) => s + h.confidence, 0) / cluster.length
  const centers = cluster.map((h) => h.center)
  const span = Math.max(...centers) - Math.min(...centers)
  if (cluster.length >= 3 && span >= DRIFT_FIT_MIN_SPAN_HOPS) {
    const n = cluster.length
    const meanX = cluster.reduce((s, h) => s + h.center, 0) / n
    const meanY = cluster.reduce((s, h) => s + h.clipLag, 0) / n
    const varX = cluster.reduce((s, h) => s + (h.center - meanX) ** 2, 0)
    const cov = cluster.reduce((s, h) => s + (h.center - meanX) * (h.clipLag - meanY), 0)
    const slope = varX > 0 ? cov / varX : 0
    if (Math.abs(slope) >= MIN_DRIFT_RATIO && Math.abs(slope) <= MAX_DRIFT_RATIO) {
      const maxResidual = Math.max(...cluster.map((h) => Math.abs(h.clipLag - (meanY + slope * (h.center - meanX)))))
      if (maxResidual <= CONSENSUS_TOLERANCE_HOPS) {
        const lagAtHead = meanY - slope * meanX
        return result(swiftRoundInt(lagAtHead), confidence, slope, lagAtHead)
      }
    }
  }
  const anchor = cluster.reduce((a, h) => (h.start < a.start ? h : a))
  return result(anchor.clipLag, confidence)
}

/** Swift `.rounded()` (half away from zero). */
const swiftRoundInt = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x))

export function correlate(ref: Samples, tgt: Samples, maxLagHops: number, centerLagHops = 0, minOverlapHops = MIN_OVERLAP, cancelled: Cancel = never): CorrelationResult | null {
  if (!ref.length || !tgt.length || maxLagHops < 0) return null
  const shorter = Math.min(ref.length, tgt.length)
  const adaptive = Math.max(MIN_OVERLAP, Math.floor(shorter / 2))
  const required = Math.min(Math.max(MIN_OVERLAP, minOverlapHops), adaptive)
  if (shorter < required) return null
  const lower = Math.max(required - tgt.length, centerLagHops - maxLagHops)
  const upper = Math.min(ref.length - required, centerLagHops + maxLagHops)
  if (lower > upper) return null
  return correlateCandidates(ref, tgt, [lower, upper], required, cancelled)[0] ?? null
}

function correlateCandidates(ref: Samples, tgt: Samples, range: LagRange, minOverlap: number, cancelled: Cancel): CorrelationResult[] {
  const count = range[1] - range[0] + 1
  if (!(count > MAX_EXACT_LAG_COUNT && ref.length >= PYRAMID_STRIDE * MIN_OVERLAP && tgt.length >= PYRAMID_STRIDE * MIN_OVERLAP)) {
    return exactCandidates(ref, tgt, [range], minOverlap, cancelled)
  }
  const coarseTgt = downsample(tgt, PYRAMID_STRIDE)
  const mapped: CorrelationResult[] = []
  for (let phase = 0; phase < PYRAMID_STRIDE; phase++) {
    const cLo = Math.ceil((range[0] - phase) / PYRAMID_STRIDE)
    const cHi = Math.floor((range[1] - phase) / PYRAMID_STRIDE)
    if (cLo > cHi) continue
    const cands = correlateCandidates(downsample(ref, PYRAMID_STRIDE, phase), coarseTgt, [cLo, cHi], Math.max(4, Math.floor((minOverlap + PYRAMID_STRIDE - 1) / PYRAMID_STRIDE)), cancelled)
    for (const c of cands) mapped.push(result(c.lagHops * PYRAMID_STRIDE + phase, c.confidence))
  }
  const coarse = ranked(mapped)
  if (!coarse.length) return []
  const radius = PYRAMID_STRIDE * 2
  const ranges = coarse.map((c): LagRange => [Math.max(range[0], c.lagHops - radius), Math.min(range[1], c.lagHops + radius)])
  return exactCandidates(ref, tgt, merged(ranges), minOverlap, cancelled)
}

/** Pearson correlation in float64 for every lag of `ranges`; local maxima, ranked. */
export function exactCandidates(ref: Samples, tgt: Samples, ranges: LagRange[], minOverlap: number, cancelled: Cancel = never): CorrelationResult[] {
  const r = ref instanceof Float64Array ? ref : Float64Array.from(ref as ArrayLike<number>)
  const t = tgt instanceof Float64Array ? tgt : Float64Array.from(tgt as ArrayLike<number>)
  const results: CorrelationResult[] = []
  for (const [lo, hi] of ranges) {
    for (let lag = lo; lag <= hi; lag++) {
      if ((lag & 1023) === 0 && cancelled()) return []
      const iStart = Math.max(0, -lag)
      const iEnd = Math.min(t.length, r.length - lag)
      const n = iEnd - iStart
      if (n < minOverlap) continue
      let sx = 0
      let sy = 0
      let sxx = 0
      let syy = 0
      let sxy = 0
      for (let i = iStart, j = iStart + lag; i < iEnd; i++, j++) {
        const x = t[i]
        const y = r[j]
        sx += x
        sy += y
        sxx += x * x
        syy += y * y
        sxy += x * y
      }
      const cov = sxy - (sx * sy) / n
      const vx = sxx - (sx * sx) / n
      const vy = syy - (sy * sy) / n
      const denom = Math.sqrt(vx * vy)
      if (!(denom > 0)) continue
      results.push(result(lag, Math.max(0, cov / denom)))
    }
  }
  if (cancelled()) return []
  const peaks = results.filter((c, i) => {
    const left = i === 0 || results[i - 1].lagHops !== c.lagHops - 1 || c.confidence >= results[i - 1].confidence
    const right = i === results.length - 1 || results[i + 1].lagHops !== c.lagHops + 1 || c.confidence >= results[i + 1].confidence
    return left && right
  })
  return ranked(peaks.length ? peaks : results)
}

function ranked(cands: CorrelationResult[]): CorrelationResult[] {
  const sorted = [...cands].sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence
    const da = Math.abs(a.lagHops)
    const db = Math.abs(b.lagHops)
    return da === db ? a.lagHops - b.lagHops : da - db
  })
  const selected: CorrelationResult[] = []
  for (const c of sorted) {
    if (selected.every((s) => Math.abs(s.lagHops - c.lagHops) > 2)) {
      selected.push(c)
      if (selected.length === MAX_CANDIDATES) break
    }
  }
  return selected
}

/** Means of `stride`-sized groups starting at `offset`; a short trailing group is kept. */
export function downsample(x: Samples, stride: number, offset = 0): Float64Array {
  if (offset >= x.length) return new Float64Array(0)
  const n = Math.ceil((x.length - offset) / stride)
  const out = new Float64Array(n)
  for (let k = 0; k < n; k++) {
    const s = offset + k * stride
    const e = Math.min(s + stride, x.length)
    let sum = 0
    for (let i = s; i < e; i++) sum += x[i]
    out[k] = sum / (e - s)
  }
  return out
}

function merged(ranges: LagRange[]): LagRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  if (!sorted.length) return []
  const out: LagRange[] = []
  let cur: LagRange = [...sorted[0]]
  for (const r of sorted.slice(1)) {
    if (r[0] <= cur[1] + 1) cur = [cur[0], Math.max(cur[1], r[1])]
    else {
      out.push(cur)
      cur = [...r]
    }
  }
  out.push(cur)
  return out
}

/** `MulticamEngine.maxLagHops`. */
export function maxLagHops(windowSeconds: number, hopSeconds: number, refCount: number, tgtCount: number): number {
  return Math.max(1, Math.min(swiftRoundInt(windowSeconds / hopSeconds), Math.floor(Math.min(refCount, tgtCount) / 2)))
}
