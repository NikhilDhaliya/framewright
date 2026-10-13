import { describe, expect, it } from 'vitest'
import { dbToLinear } from '../src/core/clip'
import { newClip, newTimeline, newTrack, type Clip } from '../src/core/model'
import { audioPieces, envelopeAt, gainEnvelope, smoothSubdivisions } from '../src/renderer/render/audioPlan'
import type { MediaMap } from '../src/renderer/render/plan'

const media: MediaMap = {
  A: { path: '/a.wav', type: 'audio', duration: 10, hasAudio: true },
  V: { path: '/v.mp4', type: 'video', duration: 10, hasAudio: true },
  MUTE: { path: '/m.mp4', type: 'video', duration: 10, hasAudio: false },
  OFF: { path: null, type: 'audio', duration: 10, hasAudio: true },
}
const ac = (p: Partial<Clip> & Pick<Clip, 'startFrame' | 'durationFrames'>): Clip => newClip({ mediaRef: 'A', mediaType: 'audio', sourceClipType: 'audio', ...p, id: p.id ?? `a${p.startFrame}` })
const env = (timelines = [] as ReturnType<typeof newTimeline>[]) => ({ fps: 30, timelines, media: (id: string) => media[id] })

describe('audible clips (§10.1, §10.4)', () => {
  it('uses only unmuted audio tracks; offline clips still block overlaps', () => {
    const tl = newTimeline({
      tracks: [
        newTrack('video', { clips: [newClip({ mediaRef: 'V', startFrame: 0, durationFrames: 30 })] }),
        newTrack('audio', { clips: [ac({ id: 'off', mediaRef: 'OFF', startFrame: 0, durationFrames: 30 }), ac({ id: 'blocked', startFrame: 20, durationFrames: 30 }), ac({ id: 'ok', startFrame: 30, durationFrames: 10 })] }),
        newTrack('audio', { muted: true, clips: [ac({ id: 'muted', startFrame: 0, durationFrames: 30 })] }),
        newTrack('audio', { clips: [ac({ id: 'silent-video', mediaRef: 'MUTE', startFrame: 0, durationFrames: 30 })] }),
      ],
    })
    expect(audioPieces(tl, env()).map((p) => p.key)).toEqual(['ok'])
  })

  it('expands nests: static carrier volumes fold, the top carrier envelope stays', () => {
    const inner = newTimeline({ id: 'INNER', tracks: [newTrack('audio', { clips: [ac({ id: 'leaf', startFrame: 0, durationFrames: 100, volume: 0.5 })] })] })
    const mid = newTimeline({ id: 'MID', tracks: [newTrack('audio', { clips: [ac({ id: 'midcar', mediaRef: 'INNER', sourceClipType: 'sequence', startFrame: 0, durationFrames: 100, volume: 0.4 })] })] })
    const top = ac({ id: 'top', mediaRef: 'MID', sourceClipType: 'sequence', startFrame: 10, durationFrames: 50, trimStartFrame: 20, volume: 2, fadeInFrames: 10 })
    const tl = newTimeline({ id: 'ROOT', tracks: [newTrack('audio', { clips: [top] })] })
    const pieces = audioPieces(tl, env([tl, mid, inner]))
    expect(pieces).toHaveLength(1)
    const p = pieces[0]
    expect(p.key).toBe('top/midcar/leaf')
    expect(p.clip.volume).toBeCloseTo(0.5 * 0.4)
    expect(p.carrier?.id).toBe('top')
    expect(p.clip.startFrame).toBe(10)
    expect(p.clip.trimStartFrame).toBe(20)
  })
})

describe('gain envelope (§10.3)', () => {
  it('is constant without keys, fades or a varying carrier', () => {
    expect(gainEnvelope(ac({ startFrame: 5, durationFrames: 40, volume: 0.7 }))).toEqual({ offsets: [0, 40], gains: [0.7, 0.7] })
  })

  it('adds fade ends and 7 smooth subdivisions', () => {
    const e = gainEnvelope(ac({ startFrame: 0, durationFrames: 100, fadeInFrames: 16, fadeInInterpolation: 'smooth', fadeOutFrames: 10 }))
    expect(e.offsets).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 90, 100])
    expect(e.gains[0]).toBe(0)
    expect(e.gains[8]).toBe(1)
    expect(e.gains[10]).toBe(0)
    expect(e.gains[4]).toBeCloseTo(0.5)
  })

  it('samples dB keyframes in dB; hold keys get a one-frame ramp at the end', () => {
    const c = ac({ startFrame: 0, durationFrames: 60, volumeTrack: { keyframes: [{ frame: 0, value: -6, interpolationOut: 'hold' }, { frame: 30, value: 0, interpolationOut: 'linear' }, { frame: 50, value: -60, interpolationOut: 'linear' }] } })
    const e = gainEnvelope(c)
    expect(e.offsets).toEqual([0, 29, 30, 50, 60])
    expect(e.gains[0]).toBeCloseTo(dbToLinear(-6))
    expect(e.gains[1]).toBeCloseTo(dbToLinear(-6))
    expect(e.gains[2]).toBeCloseTo(1)
    expect(e.gains[3]).toBe(0)
    expect(envelopeAt(e, 40)).toBeCloseTo(0.5)
  })

  it('multiplies the carrier envelope and adds its breakpoints inside the clip', () => {
    const carrier = ac({ id: 'car', startFrame: 100, durationFrames: 50, fadeInFrames: 20, volume: 0.5 })
    const c = ac({ startFrame: 110, durationFrames: 30 })
    const e = gainEnvelope(c, carrier)
    expect(e.offsets).toEqual([0, 10, 30])
    expect(e.gains[0]).toBeCloseTo(0.5 * 0.5)
    expect(e.gains[1]).toBeCloseTo(0.5)
  })

  it('subdivides smooth ramps with Swift rounding and dedupes', () => {
    expect(smoothSubdivisions(0, 4)).toEqual([1, 2, 3, 4])
    expect(smoothSubdivisions(10, 10)).toEqual([])
  })
})
