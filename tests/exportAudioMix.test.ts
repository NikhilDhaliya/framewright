import { describe, expect, it } from 'vitest'
import { newClip, newTimeline, newTrack, type Clip } from '../src/core/model'
import { buildMixGraph, mixArgs, tempoChain, volumeExpression } from '../src/main/export/audioMix'
import { audioPieces, envelopeAt, gainEnvelope } from '../src/renderer/render/audioPlan'
import type { MediaMap } from '../src/renderer/render/plan'

const media: MediaMap = {
  A: { path: '/a.wav', type: 'audio', duration: 10, hasAudio: true },
  M: { path: '/mono.wav', type: 'audio', duration: 10, hasAudio: true },
}
const ac = (p: Partial<Clip> & Pick<Clip, 'startFrame' | 'durationFrames'>): Clip => newClip({ mediaRef: 'A', mediaType: 'audio', sourceClipType: 'audio', ...p, id: p.id ?? `a${p.startFrame}` })
const pieces = (clips: Clip[]) => audioPieces(newTimeline({ tracks: clips.map((c) => newTrack('audio', { clips: [c] })) }), { fps: 30, timelines: [], media: (id) => media[id] })
const channels = (p: string) => (p === '/mono.wav' ? 1 : 2)

/** Evaluates the FFmpeg expression subset volumeExpression emits. */
function evalExpr(expr: string, t: number): number {
  const js = expr.replace(/clip\(/g, 'clip(').replace(/gte\(/g, 'gte(')
  return new Function('t', 'clip', 'gte', `return ${js}`)(t, (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x)), (a: number, b: number) => (a >= b ? 1 : 0)) as number
}

describe('volume expression', () => {
  it('reproduces the piecewise-linear envelope at any time', () => {
    const c = ac({ startFrame: 0, durationFrames: 90, fadeInFrames: 15, fadeInInterpolation: 'smooth', fadeOutFrames: 30, volume: 0.8, volumeTrack: { keyframes: [{ frame: 20, value: -12, interpolationOut: 'hold' }, { frame: 40, value: 3, interpolationOut: 'linear' }] } })
    const env = gainEnvelope(c)
    const expr = volumeExpression(env, 30, 0)
    for (let t = 0; t <= 3; t += 0.037) expect(evalExpr(expr, t)).toBeCloseTo(envelopeAt(env, t * 30), 6)
    const skipped = volumeExpression(env, 30, 1)
    expect(evalExpr(skipped, 0.5)).toBeCloseTo(envelopeAt(env, 45), 6)
  })

  it('is a constant for flat envelopes', () => {
    expect(volumeExpression({ offsets: [0, 10], gains: [0.25, 0.25] }, 30, 0)).toBe('0.25')
  })
})

describe('tempo chain', () => {
  it('chains atempo stages below 0.5', () => {
    expect(tempoChain(1)).toEqual([])
    expect(tempoChain(2)).toEqual(['atempo=2'])
    expect(tempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5'])
    expect(tempoChain(0.3)).toEqual(['atempo=0.5', 'atempo=0.6'])
  })
})

describe('mix filtergraph', () => {
  it('seeks, retimes, delays and sums with normalize=0 to an exact length', () => {
    const g = buildMixGraph(pieces([ac({ startFrame: 30, durationFrames: 60, trimStartFrame: 15 }), ac({ id: 'fast', mediaRef: 'M', startFrame: 0, durationFrames: 30, speed: 2 })]), { start: 0, end: 90, fps: 30, durationSec: 3 }, channels)!
    expect(g.inputs).toEqual([
      { path: '/a.wav', seekSec: 0.5, durSec: 2 },
      { path: '/mono.wav', seekSec: 0, durSec: 2 },
    ])
    expect(g.totalSamples).toBe(144000)
    const [a0, a1, mix] = g.filter.split(';')
    expect(a0).toContain('adelay=delays=48000S:all=1')
    expect(a0).not.toContain('atempo')
    expect(a1).toContain('pan=stereo|c0=c0|c1=c0')
    expect(a1).toContain('atempo=2')
    expect(a1).not.toContain('adelay')
    expect(mix).toContain('amix=inputs=2:duration=longest:dropout_transition=0:normalize=0')
    expect(mix).toContain('apad=whole_len=144000,atrim=end_sample=144000')
  })

  it('cuts clips to the export range (head skip moves the seek and the envelope)', () => {
    const c = ac({ startFrame: 0, durationFrames: 90, fadeInFrames: 60 })
    const g = buildMixGraph(pieces([c]), { start: 30, end: 60, fps: 30, durationSec: 1 }, channels)!
    expect(g.inputs[0]).toEqual({ path: '/a.wav', seekSec: 1, durSec: 1 })
    const expr = /volume='([^']*)'/.exec(g.filter)![1]
    expect(evalExpr(expr, 0)).toBeCloseTo(0.5)
    expect(g.filter).not.toContain('adelay')
    expect(g.filter).not.toContain('amix')
    expect(buildMixGraph(pieces([c]), { start: 90, end: 120, fps: 30, durationSec: 1 }, channels)).toBeNull()
  })

  it('renders silence when nothing is audible', () => {
    const args = mixArgs(null, 1.5, ['-c:a', 'pcm_s16le'], '/out.wav')
    expect(args).toContain('anullsrc=r=48000:cl=stereo')
    expect(args.slice(-3)).toEqual(['-c:a', 'pcm_s16le', '/out.wav'])
  })
})
