import { describe, expect, it } from 'vitest'
import { newClip, newTimeline, newTrack, type Clip, type Timeline } from '../src/core/model'
import { canvasToSource, flattenNest, mediaLayers, Planner, remapNested, sourceTimeSec, sourceTiming, workScale, type MediaMap } from '../src/renderer/render/plan'

const media: MediaMap = {
  V: { path: '/v.mp4', type: 'video', duration: 10, width: 1920, height: 1080 },
  I: { path: '/i.png', type: 'image', duration: 5, width: 800, height: 600 },
  OFF: { path: null, type: 'video', duration: 10, width: 1920, height: 1080 },
  SHORT: { path: '/s.mp4', type: 'video', duration: 1, width: 640, height: 360 },
}

const clip = (p: Partial<Clip> & Pick<Clip, 'startFrame' | 'durationFrames'>): Clip => newClip({ mediaRef: 'V', ...p, id: p.id ?? `c${p.startFrame}-${p.mediaRef ?? 'V'}` })

function timeline(tracks: Clip[][], extra: Partial<Timeline> = {}): Timeline {
  return newTimeline({ id: 'TL', fps: 30, tracks: tracks.map((clips) => newTrack('video', { clips })), ...extra })
}

const planner = (timelines: Timeline[], placeholders = false) => new Planner({ fps: 30, timelines, media: (id) => media[id], offlinePlaceholders: placeholders })

describe('layer planning (§2.2)', () => {
  it('walks tracks bottom → top and skips hidden tracks', () => {
    const top = clip({ id: 'top', startFrame: 0, durationFrames: 30 })
    const mid = clip({ id: 'mid', startFrame: 0, durationFrames: 30 })
    const bottom = clip({ id: 'bottom', startFrame: 0, durationFrames: 30 })
    const tl = timeline([[top], [mid], [bottom]])
    expect(planner([tl]).layersAt(tl, 10, 1920, 1080).map((l) => l.clip.id)).toEqual(['bottom', 'mid', 'top'])
    tl.tracks[1].hidden = true
    expect(planner([tl]).layersAt(tl, 10, 1920, 1080).map((l) => l.clip.id)).toEqual(['bottom', 'top'])
  })

  it('drops an overlapping clip for its whole duration (Q1) but never gates text', () => {
    const a = clip({ id: 'a', startFrame: 0, durationFrames: 30 })
    const b = clip({ id: 'b', startFrame: 20, durationFrames: 30 })
    const t = clip({ id: 't', mediaType: 'text', mediaRef: '', textContent: 'hi', startFrame: 10, durationFrames: 30 })
    const tl = timeline([[a, b, t]])
    const p = planner([tl])
    expect(p.layersAt(tl, 25, 100, 100).map((l) => l.clip.id)).toEqual(['a', 't'])
    expect(p.layersAt(tl, 35, 100, 100).map((l) => l.clip.id)).toEqual(['t'])
  })

  it('offline media does not advance the overlap gate and only renders as a placeholder in preview', () => {
    const off = clip({ id: 'off', mediaRef: 'OFF', startFrame: 0, durationFrames: 30 })
    const next = clip({ id: 'next', startFrame: 10, durationFrames: 30 })
    const tl = timeline([[off, next]])
    expect(planner([tl]).layersAt(tl, 5, 100, 100)).toEqual([])
    expect(planner([tl]).layersAt(tl, 15, 100, 100).map((l) => l.clip.id)).toEqual(['next'])
    const preview = planner([tl], true).layersAt(tl, 15, 100, 100)
    expect(preview.map((l) => [l.clip.id, l.kind === 'media' && l.offline])).toEqual([
      ['off', true],
      ['next', false],
    ])
  })

  it('skips audio and empty text, and sorts unsorted clips', () => {
    const late = clip({ id: 'late', startFrame: 50, durationFrames: 10 })
    const early = clip({ id: 'early', startFrame: 0, durationFrames: 60 })
    const audio = clip({ id: 'aud', mediaType: 'audio', startFrame: 0, durationFrames: 60 })
    const empty = clip({ id: 'empty', mediaType: 'text', textContent: '', startFrame: 0, durationFrames: 60 })
    const tl = timeline([[late, early, audio, empty]])
    expect(planner([tl]).layersAt(tl, 55, 100, 100).map((l) => l.clip.id)).toEqual(['early'])
  })

  it('renders nested timelines as groups at the child canvas, child track 0 on top', () => {
    const child = newTimeline({ id: 'CHILD', fps: 30, width: 640, height: 480, tracks: [newTrack('video', { clips: [clip({ id: 'ctop', startFrame: 0, durationFrames: 100 })] }), newTrack('video', { clips: [clip({ id: 'cbottom', startFrame: 0, durationFrames: 100, mediaRef: 'I', mediaType: 'image' })] })] })
    const carrier = clip({ id: 'nest', mediaRef: 'CHILD', mediaType: 'sequence', sourceClipType: 'sequence', startFrame: 10, durationFrames: 40, trimStartFrame: 5 })
    const tl = timeline([[carrier]])
    const plan = planner([tl, child]).layersAt(tl, 20, 1920, 1080)
    expect(plan).toHaveLength(1)
    const g = plan[0]
    expect(g.kind).toBe('group')
    if (g.kind !== 'group') return
    expect([g.canvasW, g.canvasH]).toEqual([640, 480])
    expect(g.children.map((c) => c.clip.id)).toEqual(['nest/cbottom', 'nest/ctop'])
    // Child frame 15 (= 20 − 10 + 5) maps back onto parent frames through the shift.
    expect(g.children[1].clip.startFrame).toBe(10)
    expect(mediaLayers(plan).map((l) => l.clip.id)).toEqual(['nest/cbottom', 'nest/ctop'])
  })

  it('renders an empty nest window as an (opaque) group with no children', () => {
    const child = newTimeline({ id: 'CHILD', fps: 30, tracks: [newTrack('video', { clips: [clip({ id: 'x', startFrame: 0, durationFrames: 10 })] })] })
    const carrier = clip({ id: 'nest', mediaRef: 'CHILD', mediaType: 'sequence', sourceClipType: 'sequence', startFrame: 0, durationFrames: 40, trimStartFrame: 20 })
    const tl = timeline([[carrier]])
    const plan = planner([tl, child]).layersAt(tl, 5, 100, 100)
    expect(plan.map((l) => l.kind)).toEqual(['group'])
    expect(plan[0].kind === 'group' && plan[0].children).toEqual([])
  })

  it('stops nesting at depth 8', () => {
    const timelines: Timeline[] = []
    for (let i = 0; i < 10; i++) {
      const inner = i < 9 ? [clip({ id: `n${i}`, mediaRef: `T${i + 1}`, mediaType: 'sequence', sourceClipType: 'sequence', startFrame: 0, durationFrames: 10 })] : [clip({ id: 'leaf', startFrame: 0, durationFrames: 10 })]
      timelines.push(newTimeline({ id: `T${i}`, fps: 30, tracks: [newTrack('video', { clips: inner })] }))
    }
    let depth = 0
    let layers = planner(timelines).layersAt(timelines[0], 0, 100, 100)
    while (layers.length && layers[0].kind === 'group') {
      depth++
      layers = layers[0].children
    }
    expect(depth).toBe(8)
  })
})

describe('nest remapping (§2.3.1)', () => {
  it('cuts heads (trim, fade, keyframes) and tails, and namespaces ids', () => {
    const c = clip({ id: 'k', startFrame: 0, durationFrames: 30, fadeInFrames: 5, fadeOutFrames: 5, speed: 2, opacityTrack: { keyframes: [{ frame: 0, value: 0, interpolationOut: 'linear' }, { frame: 20, value: 1, interpolationOut: 'linear' }] } })
    const carrier = clip({ id: 'car', startFrame: 100, durationFrames: 10, trimStartFrame: 10, mediaType: 'sequence', sourceClipType: 'sequence' })
    const r = remapNested(c, carrier)!
    expect(r.id).toBe('car/k')
    expect(r.startFrame).toBe(100)
    expect(r.durationFrames).toBe(10)
    expect(r.trimStartFrame).toBe(20)
    expect(r.fadeInFrames).toBe(0)
    expect(r.fadeOutFrames).toBe(0)
    expect(r.opacityTrack!.keyframes[0]).toEqual({ frame: 0, value: 0.5, interpolationOut: 'linear' })
    expect(remapNested(clip({ startFrame: 50, durationFrames: 5 }), carrier)).toBeNull()
  })

  it('keeps only unmuted audio tracks for audio flattening', () => {
    const child = newTimeline({ id: 'C', tracks: [newTrack('audio', { muted: true, clips: [clip({ startFrame: 0, durationFrames: 5 })] }), newTrack('audio', { clips: [clip({ startFrame: 0, durationFrames: 5 })] })] })
    const carrier = clip({ id: 'car', startFrame: 0, durationFrames: 5 })
    expect(flattenNest(carrier, child, false)).toHaveLength(1)
    expect(flattenNest(carrier, child, true)).toHaveLength(0)
  })
})

describe('source time mapping (§3.1)', () => {
  it('speed 1: trim offset, nothing past the end of the source (Q3)', () => {
    const c = clip({ startFrame: 10, durationFrames: 60, trimStartFrame: 15, mediaRef: 'SHORT' })
    const t = sourceTiming(c, 30, 1)!
    expect(t.srcDurSec).toBeCloseTo(0.5)
    expect(sourceTimeSec(c, 10, 30, t)).toBeCloseTo(0.5)
    expect(sourceTimeSec(c, 24, 30, t)).toBeCloseTo(0.5 + 14 / 30)
    expect(sourceTimeSec(c, 25, 30, t)).toBeNull()
  })

  it('retimed clips truncate source frames and stretch a clamped source (Q2)', () => {
    const c = clip({ startFrame: 0, durationFrames: 7, speed: 1.5 })
    const t = sourceTiming(c, 30, 100)!
    expect(t.srcDurSec).toBeCloseTo(10 / 30)
    expect(sourceTimeSec(c, 7, 30, t)).toBeCloseTo(10 / 30)
    const clamped = clip({ startFrame: 0, durationFrames: 60, speed: 2 })
    const tc = sourceTiming(clamped, 30, 3)!
    expect(tc.srcDurSec).toBeCloseTo(3)
    expect(tc.rate).toBeCloseTo(1.5)
  })

  it('never inserts negative trims (video) or empty sources, clamps image trims', () => {
    expect(sourceTiming(clip({ startFrame: 0, durationFrames: 10, trimStartFrame: -1 }), 30, 10)).toBeNull()
    expect(sourceTiming(clip({ startFrame: 0, durationFrames: 10, trimStartFrame: 300 }), 30, 10)).toBeNull()
    expect(sourceTiming(clip({ startFrame: 0, durationFrames: 10, trimStartFrame: -5, mediaType: 'image' }), 30, 1800)!.trimSec).toBe(0)
  })
})

describe('placement transform (§5.5)', () => {
  const apply = (m: Float32Array, x: number, y: number) => [m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]]
  const forward = (t: { centerX: number; centerY: number; width: number; height: number; rotation: number; flipHorizontal: boolean; flipVertical: boolean }, natW: number, natH: number, W: number, H: number, u: number, v: number) => {
    const tlx = t.centerX - t.width / 2
    const tly = t.centerY - t.height / 2
    const sx = (W / natW) * t.width * (t.flipHorizontal ? -1 : 1)
    const sy = (H / natH) * t.height * (t.flipVertical ? -1 : 1)
    const tx = (t.flipHorizontal ? tlx + t.width : tlx) * W
    const ty = (t.flipVertical ? tly + t.height : tly) * H
    const cx = t.centerX * W
    const cy = t.centerY * H
    const th = (t.rotation * Math.PI) / 180
    const qx = sx * u + tx - cx
    const qy = sy * v + ty - cy
    return [cx + Math.cos(th) * qx - Math.sin(th) * qy, cy + Math.sin(th) * qx + Math.cos(th) * qy]
  }

  it('inverts the forward map including rotation and flips', () => {
    const t = { centerX: 0.4, centerY: 0.6, width: 0.5, height: 0.3, rotation: 30, flipHorizontal: true, flipVertical: false }
    const m = canvasToSource(t, 800, 600, 1920, 1080)!
    for (const [u, v] of [[0, 0], [800, 0], [400, 300], [123, 456]]) {
      const [px, py] = forward(t, 800, 600, 1920, 1080, u, v)
      const [ru, rv] = apply(m, px, py)
      expect(ru).toBeCloseTo(u, 3)
      expect(rv).toBeCloseTo(v, 3)
    }
  })

  it('identity transform maps the full canvas onto the source', () => {
    const m = canvasToSource({ centerX: 0.5, centerY: 0.5, width: 1, height: 1, rotation: 0, flipHorizontal: false, flipVertical: false }, 960, 540, 1920, 1080)!
    expect(apply(m, 1920, 1080)).toEqual([960, 540])
    expect(canvasToSource({ centerX: 0.5, centerY: 0.5, width: 0, height: 1, rotation: 0, flipHorizontal: false, flipVertical: false }, 960, 540, 1920, 1080)).toBeNull()
  })
})

describe('preview work scale (§12)', () => {
  it('is 1 at or above source resolution', () => {
    expect(workScale({ width: 1, height: 1 }, 1920, 1080, 1920, 1080)).toBe(1)
    expect(workScale({ width: 1, height: 1 }, 640, 360, 1920, 1080)).toBe(1)
  })

  it('follows the displayed size, rounded up to a quarter octave', () => {
    const k = workScale({ width: 1, height: 1 }, 1920, 1080, 757, 426)
    expect(k).toBeGreaterThanOrEqual(757 / 1920)
    expect(k).toBeLessThan((757 / 1920) * 2 ** 0.25)
    expect(Math.log2(k) * 4).toBeCloseTo(Math.round(Math.log2(k) * 4))
    expect(workScale({ width: 0.35, height: 0.35 }, 1280, 720, 757, 426)).toBeCloseTo(2 ** (Math.ceil(Math.log2((757 / 1280) * 0.35) * 4) / 4))
  })

  it('uses the larger axis of a stretched placement and ignores degenerate ones', () => {
    expect(workScale({ width: 0.25, height: 1 }, 1000, 1000, 1000, 500)).toBeCloseTo(0.5)
    expect(workScale({ width: 0, height: 0 }, 1000, 1000, 1000, 1000)).toBe(1)
  })
})
