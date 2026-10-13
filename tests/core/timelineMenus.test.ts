/** Brief A core ops: decompose nest, paste clip settings, multicam menu ops (03 §4.15, §8, §12.3). */
import { describe, expect, it } from 'vitest'
import { createMulticamGroup } from '../../src/core/audio/multicam'
import { endFrame } from '../../src/core/clip'
import { emptyManifest, newProjectFile, type Clip } from '../../src/core/model'
import { OPS, opLabel } from '../../src/core/ops'
import type { Doc } from '../../src/core/ops/context'
import { angleMembers, groupsInRange, isProgramFragment, micMembers, programRows, switchClipMember, ungroupMulticam } from '../../src/core/ops/multicam'
import { decomposeTargets, decomposeNest } from '../../src/core/ops/nest'
import { EditRefusal } from '../../src/core/timeline'
import { asset, audioTrack, clip, timeline, videoTrack } from '../captions/fixtures'

function docWith(tracks: ReturnType<typeof videoTrack>[], fps = 30): Doc {
  const file = newProjectFile()
  file.timelines = [timeline(tracks, { fps })]
  file.activeTimelineId = file.timelines[0].id
  const manifest = emptyManifest()
  return { file, manifest }
}

const active = (d: Doc) => d.file.timelines.find((t) => t.id === d.file.activeTimelineId)!
const shape = (d: Doc) => active(d).tracks.map((tr) => [tr.type, tr.clips.map((c) => [c.mediaRef, c.startFrame, c.durationFrames, c.trimStartFrame])])

describe('Decompose Nested Timeline (03 §8)', () => {
  it('round-trips a nest: carriers replaced by the child clips at their original places', () => {
    const v1 = clip({ mediaRef: 'A', start: 10, duration: 50 })
    const v2 = clip({ mediaRef: 'B', start: 60, duration: 40 })
    const a1 = clip({ mediaRef: 'A', mediaType: 'audio', start: 10, duration: 50 })
    const d = docWith([videoTrack({ clips: [v1, v2] }), audioTrack({ clips: [a1] })])
    const before = shape(d)
    const nest = OPS.nestClips.run(d, { ids: [v1.id, v2.id, a1.id] })
    expect(active(d).tracks.flatMap((tr) => tr.clips).every((c) => c.sourceClipType === 'sequence')).toBe(true)
    expect(decomposeTargets(active(d), d, nest.carrierIds[0])).toMatchObject({ video: { id: nest.carrierIds[0] }, audio: { id: nest.carrierIds[1] } })
    const out = OPS.decomposeNest.run(d, { clipId: nest.carrierIds[0] })
    expect(shape(d)).toEqual(before)
    expect(out.clipIds).toHaveLength(3)
    expect(out.settingsDiscarded).toBe(false)
    expect(opLabel('decomposeNest', { clipId: 'x' })).toBe('Decompose Nested Timeline')
    // fresh ids, child timeline kept
    expect(out.clipIds).not.toContain(v1.id)
    expect(d.file.timelines).toHaveLength(2)
  })

  it('applies the carrier window: head cut moves trim, drops cut fades; audio volume scales; settings flagged', () => {
    const v = clip({ mediaRef: 'A', start: 0, duration: 100 })
    v.fadeInFrames = 10
    v.fadeOutFrames = 10
    const a = clip({ mediaRef: 'A', mediaType: 'audio', start: 0, duration: 100 })
    a.volume = 0.5
    const d = docWith([videoTrack({ clips: [v] }), audioTrack({ clips: [a] })])
    const { carrierIds } = OPS.nestClips.run(d, { ids: [v.id, a.id] })
    const t = active(d)
    for (const tr of t.tracks)
      for (const c of tr.clips) {
        // carrier shows child frames [20, 70) at parent frame 200
        c.trimStartFrame = 20
        c.trimEndFrame = 30
        c.durationFrames = 50
        c.startFrame = 200
        if (c.mediaType === 'audio') c.volume = 0.5
        else c.opacity = 0.5
      }
    const out = decomposeNest(d, carrierIds[1])
    expect(out.settingsDiscarded).toBe(true)
    const [vc] = t.tracks[0].clips
    const [ac] = t.tracks[1].clips
    expect([vc.startFrame, vc.durationFrames, vc.trimStartFrame, vc.fadeInFrames, vc.fadeOutFrames]).toEqual([200, 50, 20, 0, 0])
    expect(ac.volume).toBeCloseTo(0.25)
  })

  it('places a lane on a new track when the carrier track is busy, and refuses non-carriers', () => {
    const v1 = clip({ mediaRef: 'A', start: 0, duration: 30 })
    const v2 = clip({ mediaRef: 'B', start: 0, duration: 30 })
    const d = docWith([videoTrack({ clips: [v1] }), videoTrack({ clips: [v2] })])
    const { carrierIds } = OPS.nestClips.run(d, { ids: [v1.id, v2.id] })
    decomposeNest(d, carrierIds[0])
    expect(shape(d)).toEqual([
      ['video', [['A', 0, 30, 0]]],
      ['video', [['B', 0, 30, 0]]],
    ])
    expect(() => decomposeNest(d, active(d).tracks[0].clips[0].id)).toThrow(EditRefusal)
  })
})

describe('Paste Settings (03 §4.15)', () => {
  it('copies visual settings from a clipboard clip onto same-type targets; source untouched', () => {
    const src = clip({ mediaRef: 'A', start: 0, duration: 10 })
    src.opacity = 0.4
    src.transform = { ...src.transform, centerX: 0.25 }
    src.edgeRounding = 0.3
    const t1 = clip({ mediaRef: 'B', start: 20, duration: 10 })
    const au = clip({ mediaRef: 'C', mediaType: 'audio', start: 0, duration: 10 })
    const d = docWith([videoTrack({ clips: [src, t1] }), audioTrack({ clips: [au] })])
    const source: Clip = JSON.parse(JSON.stringify(src))
    const r = OPS.pasteClipSettings.run(d, { source, targetIds: [src.id, t1.id] })
    expect(r).toEqual({ changed: [t1.id], unchanged: [src.id] })
    const after = active(d).tracks[0].clips[1]
    expect([after.opacity, after.transform.centerX, after.edgeRounding, after.mediaRef, after.startFrame]).toEqual([0.4, 0.25, 0.3, 'B', 20])
    expect(() => OPS.pasteClipSettings.run(d, { source, targetIds: [au.id] })).toThrow(/require video/)
    expect(() => OPS.pasteClipSettings.run(d, { source, targetIds: [] })).toThrow(EditRefusal)
    expect(opLabel('pasteClipSettings', { source, targetIds: [] })).toBe('Paste Clip Settings')
  })
})

describe('Multicam menu ops (03 §12.3 UI)', () => {
  function multicamDoc() {
    const d = docWith([], 10)
    const e = (id: string, type: 'video' | 'audio', duration: number, hasAudio = true) => asset(id, { type, duration, hasAudio, sourceWidth: type === 'video' ? 1920 : undefined, sourceHeight: type === 'video' ? 1080 : undefined })
    d.manifest.entries.push(e('A', 'video', 10, false), e('B', 'video', 10), e('M', 'audio', 10), e('U', 'video', 10))
    createMulticamGroup(
      d,
      [
        { mediaRef: 'A', kind: 'angle' },
        { mediaRef: 'B', kind: 'both' },
        { mediaRef: 'M', kind: 'mic' },
        { mediaRef: 'U', kind: 'angle' },
      ],
      {
        A: { offsetSeconds: 0, confidence: 1, locked: false },
        B: { offsetSeconds: 0, confidence: 0.9, locked: false },
        M: { offsetSeconds: 0, confidence: 1, locked: false },
        U: { offsetSeconds: 0, confidence: 0, locked: false },
      },
      'M',
      undefined,
      0,
    )
    const g = d.file.multicamGroups![0]
    return { d, g }
  }

  it('lists usable angles and audio bearers', () => {
    const { d, g } = multicamDoc()
    expect(angleMembers(g).map((m) => m.mediaRef)).toEqual(['A', 'B'])
    expect(micMembers(d, g).map((m) => m.mediaRef)).toEqual(['B', 'M'])
  })

  it('switches a program fragment over its span, then a layout adds an overlay; range checks find the group', () => {
    const { d, g } = multicamDoc()
    const t = active(d)
    const program = t.tracks[0].clips[0]
    expect(isProgramFragment(d, program.id)).toBe(true)
    expect(groupsInRange(d, 0, 50)).toEqual([g.id])
    OPS.switchAngle.run(d, { groupId: g.id, start: 20, end: 40, angles: ['b'] })
    expect(programRows(d, g.id)).toEqual([
      ['a', 0, 20],
      ['b', 20, 40],
      ['a', 40, 100],
    ])
    const out = OPS.switchAngle.run(d, { groupId: g.id, start: 0, end: 20, angles: ['a', 'b'], layout: 'side_by_side' })
    expect(out.overlayClipIds).toHaveLength(1)
    const overlay = t.tracks.flatMap((tr) => tr.clips).find((c) => c.id === out.overlayClipIds[0])!
    expect(isProgramFragment(d, overlay.id)).toBe(false)
    expect([overlay.mediaRef, overlay.startFrame, endFrame(overlay)]).toEqual(['B', 0, 20])
    switchClipMember(d, overlay.id, 'A')
    expect(overlay.mediaRef).toBe('A')
    expect(() => OPS.switchAngle.run(d, { groupId: g.id, start: 0, end: 10, angles: ['u'] })).toThrow(/isn't synced/)
  })

  it('switches mic on an audio clip and ungroups', () => {
    const { d, g } = multicamDoc()
    const t = active(d)
    const mic = t.tracks.flatMap((tr) => tr.clips).find((c) => c.mediaType === 'audio' && c.mediaRef === 'M')!
    OPS.switchClipMember.run(d, { clipId: mic.id, angle: 'b', mic: true })
    expect(mic.mediaRef).toBe('B')
    expect(opLabel('switchClipMember', { clipId: '', angle: '', mic: true })).toBe('Switch Mic')
    expect(() => switchClipMember(d, mic.id, 'a')).toThrow(/Unknown mic/)
    ungroupMulticam(d, g.id)
    expect(t.tracks.flatMap((tr) => tr.clips).some((c) => c.multicamGroupId)).toBe(false)
    expect(d.file.multicamGroups).toEqual([])
    expect(opLabel('ungroupMulticam', { groupId: '' })).toBe('Ungroup Multicam')
  })
})
