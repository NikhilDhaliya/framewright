import { describe, expect, it } from 'vitest'
import { correlate, downsample, exactCandidates, maxLagHops, seededCorrelate } from '../../src/core/audio/correlator'
import {
  DEFAULT_SILENCE_SETTINGS,
  DeadAirResolver,
  deadAirSelection,
  multicamRemovableMask,
  quietNonSpeechMask,
  removableMask,
  removeAllDeadAir,
  removeDeadAirInClips,
  sourceToTimelineRange,
  validSilenceSettings,
  visibleRemovableRanges,
  type QuietMasks,
} from '../../src/core/audio/deadAir'
import { EnvelopeAccumulator, loudnessEnvelope, PeakAccumulator, peakRate, peakToLevel } from '../../src/core/audio/envelope'
import { binarize, maskFromRuns, maskRuns, speechMask } from '../../src/core/audio/vad'
import { emptyManifest, newProjectFile, type MulticamSource } from '../../src/core/model'
import type { Doc } from '../../src/core/ops/context'
import { audioTrack, clip, timeline, videoTrack } from '../captions/fixtures'

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A speech-like envelope: smoothed random bursts with pauses. */
function envelopeSignal(n: number, seed = 1): Float64Array {
  const r = rng(seed)
  const out = new Float64Array(n)
  let level = 0
  let target = 0
  for (let i = 0; i < n; i++) {
    if (i % 40 === 0) target = r() < 0.3 ? 0 : r() * 3
    level += (target - level) * 0.2
    out[i] = level + r() * 0.05
  }
  return out
}

describe('envelopes (§3.1)', () => {
  it('loudness envelope: log1p(rms·100) per 40-sample hop, trailing partial hop emitted', () => {
    const x = new Float32Array(100).fill(0.5)
    const env = loudnessEnvelope(x)
    expect(env.length).toBe(3)
    for (const v of env) expect(v).toBeCloseTo(Math.log1p(50), 5)
    const acc = new EnvelopeAccumulator()
    acc.push(x.subarray(0, 33))
    acc.push(x.subarray(33))
    expect(Array.from(acc.finish())).toEqual(Array.from(env))
  })

  it('peak envelope: max|x| → dB/−50 clamped (0 loud, 1 silent)', () => {
    expect(peakToLevel(1)).toBe(0)
    expect(peakToLevel(0)).toBe(1)
    expect(peakToLevel(0.1)).toBeCloseTo(0.4, 6)
    expect(peakToLevel(1e-6)).toBe(1)
    expect(peakRate(10)).toBe(200)
    expect(peakRate(2400)).toBe(100)
    const acc = new PeakAccumulator(1000, 10)
    const x = new Float32Array(250)
    x[5] = 1
    x[150] = 0.1
    acc.push(x)
    const out = acc.finish()
    expect(out.length).toBe(3)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(0.4, 6)
    expect(out[2]).toBe(1)
  })
})

describe('VAD binarization (§3.2)', () => {
  it('onset 0.5 / offset 0.35 hysteresis, min speech 0.25 s, merges gaps < 0.1 s', () => {
    const p = new Array(100).fill(0)
    for (let i = 10; i < 30; i++) p[i] = 0.9 // 0.32 .. 0.96 s
    p[30] = 0.4 // stays in speech (≥ offset)
    for (let i = 33; i < 50; i++) p[i] = 0.8 // gap of 2 cells (0.064 s) → merged
    for (let i = 70; i < 75; i++) p[i] = 0.9 // 0.16 s → dropped
    const segs = binarize(p)
    expect(segs).toHaveLength(1)
    expect(segs[0].start).toBeCloseTo(0.32, 6)
    expect(segs[0].end).toBeCloseTo(1.6, 6)
    const open = binarize([0, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6])
    expect(open[0].end).toBeCloseTo(0.32, 6)
  })

  it('mask cells floor(start/0.032)..ceil(end/0.032) clamped; run round-trip', () => {
    const mask = speechMask({ chunkCount: 10, segments: [{ start: 0.05, end: 0.1 }, { start: 0.3, end: 1 }] })
    expect(mask).toEqual([false, true, true, true, false, false, false, false, false, true])
    expect(maskRuns(mask)).toEqual([[1, 4], [9, 10]])
    expect(maskFromRuns(maskRuns(mask), 10)).toEqual(mask)
  })
})

const S = DEFAULT_SILENCE_SETTINGS

describe('dead air (§3.3)', () => {
  it('quiet mask: non-speech runs at/below the floor (speech median + 12 dB) are dead; loud beds survive', () => {
    // 20 cells, waveform 4 samples per cell. Speech cells 0-5 loud (0.1), 6-11 quiet (0.9), 12-15 speech, 16-19 music bed (0.2).
    const speech = Array.from({ length: 20 }, (_, c) => c < 6 || (c >= 12 && c < 16))
    const wave = new Float32Array(80)
    for (let c = 0; c < 20; c++) for (let k = 0; k < 4; k++) wave[c * 4 + k] = speech[c] ? 0.1 : c < 12 ? 0.9 : 0.2
    const quiet = quietNonSpeechMask(speech, wave)
    expect(quiet.slice(6, 12).every(Boolean)).toBe(true)
    expect(quiet.slice(16).some(Boolean)).toBe(false)
    expect(quiet.slice(0, 6).some(Boolean)).toBe(false)
    // No speech at all → fixed floor 0.56.
    expect(quietNonSpeechMask([false, false], [0.6, 0.6])).toEqual([true, true])
    expect(quietNonSpeechMask([false, false], [0.5, 0.5])).toEqual([false, false])
  })

  it('removable mask: min pause, padding away from file edges only', () => {
    const quiet = Array.from({ length: 60 }, (_, c) => c < 20 || (c >= 30 && c < 40) || c >= 55)
    const m = removableMask(quiet, S) // min 16 cells, pad 5 cells
    expect(maskRuns(m)).toEqual([[0, 15]])
    const m2 = removableMask(quiet, { minimumPause: 0.25, speechPadding: 0 }) // min 8 cells
    expect(maskRuns(m2)).toEqual([[0, 20], [30, 40]])
    expect(validSilenceSettings(0.2, 0)).toBeNull()
    expect(validSilenceSettings(0.5, 0.6)).toBeNull()
    expect(validSilenceSettings(3, 0.5)).toEqual({ minimumPause: 3, speechPadding: 0.5 })
  })

  it('visible ranges: exposed clip edges are removable unpadded; timeline mapping honours speed', () => {
    const fps = 25 // cell = 0.8 frames
    const mask = Array.from({ length: 100 }, (_, c) => c >= 40 && c < 60)
    // Clip shows source frames [40, 80) = cells [50, 100): the run is cut at the edge.
    const r = visibleRemovableRanges(mask, [40, 80], fps, S)
    expect(r).toHaveLength(1)
    expect(r[0][0]).toBeCloseTo(40, 6)
    expect(r[0][1]).toBeCloseTo(48, 6)
    // Edge within the padding of the run end → expanded to the edge.
    const r2 = visibleRemovableRanges(mask, [0, 50], fps, S)
    expect(r2[0][0]).toBeCloseTo(32, 6)
    expect(r2[0][1]).toBeCloseTo(50, 6)
    const c = clip({ mediaType: 'audio', start: 100, duration: 50, trimStart: 40, speed: 2 })
    expect(sourceToTimelineRange(c, [40, 48])).toEqual({ start: 100, end: 104 })
    expect(sourceToTimelineRange(c, [0, 10])).toBeNull()
  })

  it('multicam: group mask is the AND of usable mics, shifted per member', () => {
    const group: MulticamSource = {
      id: 'g',
      name: 'G',
      masterMemberId: 'a',
      members: [
        { id: 'a', mediaRef: 'A', kind: 'both', angleLabel: 'A', sync: { offsetSeconds: 0, confidence: 1, locked: false } },
        { id: 'b', mediaRef: 'B', kind: 'mic', angleLabel: 'B', sync: { offsetSeconds: 0.32, confidence: 0.9, locked: false } },
        { id: 'c', mediaRef: 'C', kind: 'mic', angleLabel: 'C', sync: { offsetSeconds: 0, confidence: 0, locked: false } },
      ],
    }
    const quiet: Record<string, boolean[]> = {
      A: Array.from({ length: 60 }, (_, c) => c < 40),
      B: Array.from({ length: 60 }, (_, c) => c >= 20), // group cells 30.. quiet for B
      C: new Array(60).fill(false), // unusable: ignored
    }
    const zero = { minimumPause: 0.25, speechPadding: 0 }
    const a = multicamRemovableMask(clip({ mediaType: 'audio', mediaRef: 'A' }), group, zero, (r) => quiet[r])!
    // Beyond A's coverage (cells 60–69, from B's offset) counts as quiet for A.
    expect(maskRuns(a)).toEqual([[0, 10], [30, 40], [60, 70]].filter(([s, e]) => e - s >= 8))
    const b = multicamRemovableMask(clip({ mediaType: 'audio', mediaRef: 'B' }), group, zero, (r) => quiet[r])!
    expect(maskRuns(b)).toEqual([[20, 30], [50, 60]]) // group [30,40) and [60,70) seen from B (offset 10 cells)
  })

  function doc(): { doc: Doc; masks: QuietMasks } {
    const fps = 25
    const a1 = clip({ id: 'a1', mediaType: 'audio', mediaRef: 'm1', start: 0, duration: 250 })
    const a2 = clip({ id: 'a2', mediaType: 'audio', mediaRef: 'm1', start: 250, duration: 250, trimStart: 250 })
    const v1 = clip({ id: 'v1', mediaType: 'video', mediaRef: 'm1', start: 0, duration: 250 })
    v1.linkGroupId = 'L'
    a1.linkGroupId = 'L'
    const file = newProjectFile()
    file.timelines = [timeline([videoTrack({ clips: [v1] }), audioTrack({ clips: [a1, a2] })], { fps })]
    file.activeTimelineId = file.timelines[0].id
    // 20 s of cells (625): dead air 2.0–4.0 s and 12.0–13.0 s.
    const count = 625
    const masks: QuietMasks = { m1: { count, runs: [[62, 125], [375, 406]] } }
    return { doc: { file, manifest: emptyManifest() }, masks }
  }

  it('resolver ranges, whole-timeline removal ripples and cuts linked video', () => {
    const { doc: d, masks } = doc()
    const res = new DeadAirResolver(masks, S)
    const t = d.file.timelines[0]
    const all = res.all(t)
    expect(all).toHaveLength(1)
    expect(all[0].ranges.length).toBe(2)
    const out = removeAllDeadAir(d, masks, S)
    expect(out.sections).toBe(2)
    expect(out.removedFrames).toBeGreaterThan(55) // (53 + 21) padded cells × 0.8 frames
    const audio = t.tracks[1].clips
    const total = audio.reduce((n, c) => n + c.durationFrames, 0)
    expect(total).toBe(500 - out.removedFrames)
    expect(t.tracks[0].clips.reduce((n, c) => n + c.durationFrames, 0)).toBeLessThan(250)
    expect(() => removeAllDeadAir(d, masks, S)).toThrow('No dead air on the timeline.')
  })

  it('selection validation messages', () => {
    const { doc: d, masks } = doc()
    const t = d.file.timelines[0]
    expect(() => deadAirSelection(t, ['nope'])).toThrow('Selected clips could not be resolved.')
    expect(() => deadAirSelection(t, ['v1'])).toThrow('Selected clips must include at least one audio clip.')
    expect(() => deadAirSelection(t, ['v1', 'a2'])).toThrow('Selected clips must share one track or belong to one linked A/V unit.')
    expect(deadAirSelection(t, ['v1', 'a1']).anchorTrack).toBe(1)
    const r = removeDeadAirInClips(d, ['a2'], masks, S)
    expect(r.sections).toBe(1)
  })
})

describe('sync correlator (§3.7)', () => {
  it('downsample keeps a trailing single; exact candidates find a known lag', () => {
    expect(Array.from(downsample([1, 3, 5, 7, 9], 2))).toEqual([2, 6, 9])
    expect(Array.from(downsample([1, 3, 5, 7, 9], 2, 1))).toEqual([4, 8])
    const ref = envelopeSignal(2000, 3)
    const tgt = ref.slice(300, 1300)
    const c = exactCandidates(ref, tgt, [[0, 600]], 16)
    expect(c[0].lagHops).toBe(300)
    expect(c[0].confidence).toBeGreaterThan(0.999)
  })

  it('correlate finds offsets in both directions, through the pyramid', () => {
    const ref = envelopeSignal(30000, 5)
    const tgt = ref.slice(12345, 22345)
    const r = correlate(ref, tgt, 15000)!
    expect(r.lagHops).toBe(12345)
    expect(r.confidence).toBeGreaterThan(0.99)
    // Target starts before the reference: negative lag.
    const pre = new Float64Array(5000 + 20000)
    pre.set(envelopeSignal(5000, 9), 0)
    pre.set(ref.slice(0, 20000), 5000)
    const neg = correlate(ref, pre, 8000)!
    expect(neg.lagHops).toBe(-5000)
    expect(correlate([], tgt, 10)).toBeNull()
    expect(correlate(ref, tgt, -1)).toBeNull()
  })

  it('seededCorrelate: consensus over 5 chunks, rejects low confidence', () => {
    const ref = envelopeSignal(60000, 11)
    const tgt = new Float64Array(40000)
    const r = rng(2)
    for (let i = 0; i < tgt.length; i++) tgt[i] = ref[i + 8000] + (r() - 0.5) * 0.2
    const res = seededCorrelate({ reference: ref, target: tgt, seedHops: null, seedWindowHops: 1200, maxLagHops: maxLagHops(240, 0.0025, ref.length, tgt.length), minOverlapHops: 1200, minConfidence: 0.5 })!
    expect(res.lagHops).toBe(8000)
    expect(res.driftRatio).toBe(0)
    const noise = envelopeSignal(40000, 99)
    expect(seededCorrelate({ reference: ref, target: noise, seedHops: null, seedWindowHops: 1200, maxLagHops: 20000, minOverlapHops: 1200, minConfidence: 0.5 })).toBeNull()
  })

  it('seededCorrelate fits clock drift over long spans', () => {
    const n = 100_000 // 250 s
    const ref = envelopeSignal(n + 10_000, 21)
    const lag = 3000
    const drift = 2e-4
    const tgt = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      const x = i + lag + drift * i
      const k = Math.floor(x)
      tgt[i] = ref[k] + (ref[k + 1] - ref[k]) * (x - k)
    }
    const res = seededCorrelate({ reference: ref, target: tgt, seedHops: null, seedWindowHops: 1200, maxLagHops: 5000, minOverlapHops: 1200, minConfidence: 0.5 })!
    expect(res.driftRatio).toBeGreaterThan(1.5e-4)
    expect(res.driftRatio).toBeLessThan(2.5e-4)
    expect(Math.abs(res.exactLagHops - lag)).toBeLessThan(3)
    expect(res.lagHops).toBe(Math.round(res.exactLagHops))
  }, 30_000)

  it('maxLagHops caps at half the shorter envelope', () => {
    expect(maxLagHops(240, 0.0025, 1_000_000, 1_000_000)).toBe(96000)
    expect(maxLagHops(240, 0.0025, 1000, 50_000)).toBe(500)
    expect(maxLagHops(240, 0.0025, 1, 1)).toBe(1)
  })
})

describe('master meter (§3.8)', () => {
  it('level decays 24 dB/s, peak holds 1.5 s then decays 18 dB/s, clip latches', async () => {
    const { MeterChannel, ampToDb } = await import('../../src/core/audio/meter')
    expect(ampToDb(0)).toBe(-60)
    expect(ampToDb(1)).toBe(0)
    const m = new MeterChannel()
    m.ingest(0.5, 0)
    const db = 20 * Math.log10(0.5)
    expect(m.display(0).level).toBeCloseTo(db, 6)
    expect(m.display(0.5).level).toBeCloseTo(db - 12, 6)
    expect(m.display(1.5).peak).toBeCloseTo(db, 6)
    expect(m.display(2.5).peak).toBeCloseTo(db - 18, 6)
    m.ingest(0.1, 1.0) // quieter: level keeps the decayed value, peak still held
    expect(m.display(1.0).level).toBeCloseTo(Math.max(db - 24, -20), 6)
    expect(m.peakDb).toBeCloseTo(db, 6)
    m.ingest(0.01, 3.0) // after the hold: peak re-anchors at its decayed value
    expect(m.peakDb).toBeCloseTo(db - 1.5 * 18, 6)
    expect(m.clipped).toBe(false)
    m.ingest(1.2, 3.1)
    expect(m.clipped).toBe(true)
    expect(m.display(3.1).peak).toBe(20 * Math.log10(1.2))
  })
})

describe('beat post-processing (§3.4)', () => {
  it('peak picking, upper-median BPM, keep-first chunk stitching, snap frames, ticks, toasts', async () => {
    const b = await import('../../src/core/audio/beats')
    const logits = [-5, 2, 1, -5, 3, 3, -1, 0.1, 0.2, -4]
    expect(b.pickPeaks(logits).map((t) => Math.round(t * 50))).toEqual([1, 5, 8])
    expect(b.estimateBPM([0, 0.5, 1, 1.5])).toBe(120)
    expect(b.estimateBPM([0, 0.5])).toBe(0)
    // Stitching: 2.5 chunks of audio; each frame is written by the first chunk that covers it.
    const samples = new Float32Array(b.BEAT_CHUNK_SAMPLES * 2 + 1000)
    const calls: number[] = []
    const out = await b.predictLogits(samples, async () => {
      calls.push(calls.length)
      const k = calls.length
      return { beat: new Float32Array(1500).fill(k), downbeat: new Float32Array(1500).fill(-k) }
    })
    const total = Math.floor(samples.length / 441) + 1
    expect(out.beat.length).toBe(total)
    expect(calls.length).toBe(3)
    expect(out.beat[0]).toBe(1)
    expect(out.beat[1487]).toBe(1)
    expect(out.beat[1488]).toBe(2)
    expect(out.beat[total - 1]).toBe(3)
    expect(out.beat.every((x) => Number.isFinite(x))).toBe(true)
    const clip = { ...(await import('../captions/fixtures')).clip({ mediaType: 'audio', start: 100, duration: 60, trimStart: 30, speed: 2 }) }
    const a = { bpm: 120, beats: [0.5, 1, 1.5, 2, 3, 9], downbeats: [1.01] }
    // fps 30: src = t*30 − 30; f = 100 + src/2 → 0.5 s skipped (<0), 1 → 100, 1.5 → 107.5→108, 2 → 115, 3 → 130, 9 → out.
    expect(b.beatSnapFrames(clip, a, 30)).toEqual([100, 108, 115, 130])
    expect(b.beatTicks(a).filter((t) => t.down).length).toBe(1)
    expect(b.beatTicks(a).some((t) => !t.down && t.t === 1)).toBe(false)
    expect(b.beatResultMessage(a)).toEqual({ text: 'Detected 6 beats at 120 BPM.', kind: 'success' })
    expect(b.beatResultMessage({ bpm: 0, beats: [], downbeats: [] }).text).toBe('No beats detected.')
  })
})

describe('multicam creation (03 §12.2) and timecode sync (03 §12.4)', () => {
  it('program track fills holes from later angles; one audio track per mic; labels slugged', async () => {
    const { createMulticamGroup, uniqueAngleLabel } = await import('../../src/core/audio/multicam')
    const { timecodeAlignedStart } = await import('../../src/core/audio/clipSync')
    const taken = new Set<string>()
    expect([uniqueAngleLabel('Cam A!', taken), uniqueAngleLabel('cam a', taken), uniqueAngleLabel('***', taken)]).toEqual(['cam-a', 'cam-a-2', 'angle'])
    const file = newProjectFile()
    file.timelines = [timeline([], { fps: 10 })]
    file.activeTimelineId = file.timelines[0].id
    const manifest = emptyManifest()
    const e = (id: string, type: 'video' | 'audio', duration: number) => ({ id, name: id, type, duration, hasAudio: true, source: { external: { absolutePath: `/x/${id}` } }, sourceWidth: type === 'video' ? 1920 : undefined, sourceHeight: type === 'video' ? 1080 : undefined })
    manifest.entries.push(e('A', 'video', 10), e('B', 'video', 10), e('M', 'audio', 20))
    const d: Doc = { file, manifest }
    const r = createMulticamGroup(
      d,
      [
        { mediaRef: 'A', kind: 'angle' },
        { mediaRef: 'B', kind: 'both' },
        { mediaRef: 'M', kind: 'mic' },
      ],
      { A: { offsetSeconds: 0, confidence: 1, locked: false }, B: { offsetSeconds: 5, confidence: 0.9, locked: false }, M: { offsetSeconds: 0, confidence: 1, locked: false } },
      'M',
      undefined,
      0,
    )
    const t = d.file.timelines[0]
    expect(d.file.multicamGroups![0].name).toBe('Multicam 1')
    expect(t.tracks[0].clips.map((c) => [c.mediaRef, c.startFrame, c.durationFrames, c.trimStartFrame])).toEqual([
      ['A', 0, 100, 0],
      ['B', 100, 50, 50],
    ])
    expect(t.tracks.filter((tr) => tr.type === 'audio').map((tr) => tr.clips.map((c) => [c.mediaRef, c.startFrame, c.durationFrames]))).toEqual([[['B', 50, 100]], [['M', 0, 200]]])
    expect(r.clipIds).toHaveLength(4)
    expect(timecodeAlignedStart({ startFrame: 100, trimStartFrame: 30, speed: 1, tc: { frame: 3600 * 30, quanta: 30, dropFrame: false } }, { trimStartFrame: 0, tc: { frame: 3600 * 30 + 90, quanta: 30, dropFrame: false } }, 30)).toBe(160)
  })
})
