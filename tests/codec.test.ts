import { describe, expect, it } from 'vitest'
import { decodeManifest, decodeProjectFile, encodeManifest, encodeProjectFile } from '../src/core/codec'

const macProject = {
  timelines: [
    {
      id: 'T1',
      name: 'Timeline 1',
      fps: 30,
      width: 1920,
      height: 1080,
      settingsConfigured: true,
      futureTimelineKey: { keep: true },
      tracks: [
        {
          id: 'V',
          type: 'video',
          muted: false,
          hidden: false,
          syncLocked: true,
          displayHeight: 400,
          clips: [
            {
              id: 'C2',
              mediaRef: 'M',
              startFrame: 60,
              durationFrames: 30,
              transform: { x: 0, y: 0, width: 1, height: 1 },
              opacityTrack: { keyframes: [{ frame: 10, value: 1, interpolationOut: 'linear' }, { frame: 0, value: 0, interpolationOut: 'smooth' }] },
              effects: [{ id: 'E', type: 'color.saturation', enabled: true, params: { amount: { value: 1.2 } } }],
            },
            { id: 'C1', mediaRef: 'M', startFrame: 0, durationFrames: 60, edgeRounding: 3 },
            { id: 'bad', startFrame: 0 },
          ],
        },
      ],
      markers: [{ id: 'K', name: 'Hi', startFrame: 5, durationFrames: 0, color: { r: 0, g: 0.478, b: 1, a: 1 }, comment: '' }],
    },
  ],
  activeTimelineId: 'missing',
}

describe('project codec', () => {
  it('decodes Mac files with lenient defaults and legacy transforms', () => {
    const file = decodeProjectFile(JSON.stringify(macProject))
    const t = file.timelines[0]
    expect(file.activeTimelineId).toBe('T1')
    expect(file.openTimelineIds).toEqual(['T1'])
    expect(t.tracks[0].displayHeight).toBe(200)
    expect(t.tracks[0].clips.map((c) => c.id)).toEqual(['C1', 'C2'])
    expect(t.tracks[0].clips[0].edgeRounding).toBe(0)
    expect(t.tracks[0].clips[1].transform.centerX).toBe(0.5)
    expect(t.tracks[0].clips[1].opacityTrack!.keyframes.map((k) => k.frame)).toEqual([0, 10])
    expect(t.markers[0].status).toBe('open')
  })

  it('round-trips canonical output and preserves unknown keys', () => {
    const once = encodeProjectFile(decodeProjectFile(JSON.stringify(macProject)))
    const twice = encodeProjectFile(decodeProjectFile(once))
    expect(twice).toBe(once)
    const parsed = JSON.parse(once)
    expect(parsed.timelines[0].futureTimelineKey).toEqual({ keep: true })
    expect(parsed.timelines[0].tracks[0].clips[0].effects).toBeUndefined()
    expect(once).not.toContain('null')
  })

  it('wraps a legacy bare timeline', () => {
    const file = decodeProjectFile(JSON.stringify({ id: 'L', fps: 24, width: 1280, height: 720, tracks: [] }))
    expect(file.timelines[0].fps).toBe(24)
    expect(file.activeTimelineId).toBe('L')
  })

  it('rejects non-finite numbers on save', () => {
    const file = decodeProjectFile(JSON.stringify(macProject))
    file.timelines[0].tracks[0].clips[0].opacity = NaN
    expect(() => encodeProjectFile(file)).toThrow()
  })
})

describe('manifest codec', () => {
  it('round-trips entries and throws on malformed entries', () => {
    const m = { version: 2, entries: [{ id: 'M', name: 'a', type: 'video', source: { external: { absolutePath: '/x.mp4' } }, duration: 10 }], folders: [] }
    const decoded = decodeManifest(JSON.stringify(m))
    expect(JSON.parse(encodeManifest(decoded)).entries[0].hasAudio).toBe(false)
    expect(() => decodeManifest(JSON.stringify({ entries: [{ id: 'x' }] }))).toThrow()
  })
})
