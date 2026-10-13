/**
 * Shared decoders' maths (spec 07 §3.1): the 2.5 ms loudness envelope used by the sync correlator
 * (Mac `AudioEnvelope.swift`) and the peak envelope used for waveforms / dead air (`WaveformExtractor.swift`).
 * Both are streaming accumulators so long files never sit in memory as PCM. Pure.
 */

export const ENVELOPE_RATE = 16000
export const ENVELOPE_HOP_SAMPLES = 40
export const ENVELOPE_HOP_SECONDS = 0.0025

/** Per hop `log1p(sqrt(mean(x²)) · 100)`; a trailing partial hop is emitted. */
export class EnvelopeAccumulator {
  private readonly out: number[] = []
  private sum = 0
  private n = 0

  push(x: ArrayLike<number>): void {
    for (let i = 0; i < x.length; i++) {
      const v = x[i]
      this.sum += v * v
      if (++this.n === ENVELOPE_HOP_SAMPLES) this.flush()
    }
  }

  private flush(): void {
    this.out.push(Math.log1p(Math.sqrt(this.sum / this.n) * 100))
    this.sum = 0
    this.n = 0
  }

  finish(): Float32Array {
    if (this.n > 0) this.flush()
    return Float32Array.from(this.out)
  }
}

export function loudnessEnvelope(samples: ArrayLike<number>): Float32Array {
  const acc = new EnvelopeAccumulator()
  acc.push(samples)
  return acc.finish()
}

/** `WaveformExtractor` peaks per second for a span: `min(200, 240000 / span)`. */
export const peakRate = (spanSeconds: number): number => Math.min(200, 240000 / Math.max(spanSeconds, 1e-9))

/** Peak envelope: per hop `max|x|` → dB clamped to [−50, 0] → `db / −50` (0 = loud, 1 = silent); empty hop → 1. */
export class PeakAccumulator {
  private readonly out: number[] = []
  private peak = 0
  private n = 0
  private index = 0
  private readonly hop: number

  /** `hop` = samples per output value (fractional hops are honoured by cumulative boundaries). */
  constructor(sampleRate: number, peaksPerSecond: number) {
    this.hop = sampleRate / peaksPerSecond
  }

  push(x: ArrayLike<number>): void {
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i])
      if (a > this.peak) this.peak = a
      this.n++
      this.index++
      if (this.index >= Math.round((this.out.length + 1) * this.hop)) this.flush()
    }
  }

  private flush(): void {
    this.out.push(peakToLevel(this.n ? this.peak : 0, this.n === 0))
    this.peak = 0
    this.n = 0
  }

  finish(): Float32Array {
    if (this.n > 0) this.flush()
    return Float32Array.from(this.out)
  }
}

export function peakToLevel(peak: number, empty = false): number {
  if (empty) return 1
  const db = peak > 0 ? 20 * Math.log10(peak) : -50
  return Math.min(0, Math.max(-50, db)) / -50 + 0 // + 0 normalises −0
}
