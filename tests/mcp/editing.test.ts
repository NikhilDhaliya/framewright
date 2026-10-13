import './env'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeTimeline } from '../../src/core/ops/context'
import { audioEntry, call, connect, imageEntry, startHarness, videoEntry, type Harness } from './harness'

let h: Harness
let client: Client
const video = videoEntry()
const still = imageEntry()
const music = audioEntry()

beforeEach(async () => {
  h = await startHarness([video, still, music])
  client = await connect(h.url)
})

afterEach(async () => {
  await client.close()
  await h.close()
})

const timeline = () => activeTimeline(h.session.doc)
const clipsOn = (i: number) => timeline().tracks[i]?.clips ?? []
const allClips = () => timeline().tracks.flatMap((t) => t.clips)

async function placeVideo(startFrame = 0, extra: Record<string, unknown> = {}) {
  const r = await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame, ...extra }] })
  expect(r.isError).toBe(false)
  return r
}

describe('get_timeline', () => {
  it('reports settings, compacted tracks, the playhead and the editor selection', async () => {
    await placeVideo(0)
    const clip = clipsOn(0)[0]
    h.session.setUi({ playheadFrame: 42, selectedClipIds: [clip.id, 'GONE'], selectedMediaIds: [still.id], rangeIn: 90, rangeOut: 30 })
    const t = (await call(client, 'get_timeline')).json
    expect(t).toMatchObject({ fps: 30, width: 1920, height: 1080, totalFrames: 300, durationSeconds: 10, currentFrame: 42, canGenerate: false })
    expect(t.settingsConfigured).toBeUndefined()
    expect(t.tracks.map((tr: { label: string }) => tr.label)).toEqual(['V1', 'A1'])
    const v = t.tracks[0].clips[0]
    expect(v.frames).toEqual([0, 300])
    expect(v.audio).toMatchObject({ track: 1 })
    expect(v.speed).toBeUndefined()
    expect(t.tracks[1].linkedClips).toBe(1)
    expect(t.tracks[1].clips).toBeUndefined()
    expect(t.selectedClipIds).toEqual([clip.id.slice(0, 8)])
    expect(t.selectedMediaIds).toEqual([still.id.slice(0, 8)])
    expect(t.range).toEqual([30, 90])
  })

  it('omits selection keys when nothing is selected and validates windows', async () => {
    const t = (await call(client, 'get_timeline')).json
    expect(t.selectedClipIds).toBeUndefined()
    expect(t.range).toBeUndefined()
    const bad = await call(client, 'get_timeline', { startFrame: 50, endFrame: 10 })
    expect(bad).toMatchObject({ isError: true, text: 'Invalid window [50, 10): startFrame must be less than endFrame' })
    const unknown = await call(client, 'get_timeline', { foo: 1 })
    expect(unknown.text).toBe("get_timeline: unknown field(s) 'foo'. Allowed: captionDetail, endFrame, startFrame.")
  })
})

describe('placement', () => {
  it('add_clips auto-creates shared tracks, links audio, and returns a short-id delta', async () => {
    const r = await placeVideo(30, { source: [1, 4] })
    const [v] = clipsOn(0)
    const [a] = clipsOn(1)
    expect(v).toMatchObject({ startFrame: 30, durationFrames: 90, trimStartFrame: 30, mediaRef: video.id })
    expect(a.linkGroupId).toBe(v.linkGroupId)
    expect(r.json.createdTracks).toEqual([
      { index: 0, label: 'V1', type: 'video' },
      { index: 1, label: 'A1', type: 'audio' },
    ])
    expect(r.json.clips[0].id).toBe(v.id.slice(0, 8))
    expect(r.json.clips[0].audio.id).toBe(a.id.slice(0, 8))
    expect(r.text).not.toContain(v.id)
  })

  it('accepts short ids on input and refuses a bad batch without partial state', async () => {
    await placeVideo(0)
    const before = h.session.doc
    const mixed = await call(client, 'add_clips', {
      entries: [
        { mediaRef: still.id.slice(0, 8), startFrame: 0, trackIndex: 0 },
        { mediaRef: still.id, startFrame: 10 },
      ],
    })
    expect(mixed.text).toBe('Mixed trackIndex: 1 of 2 entries omitted trackIndex. Either set it on every entry or omit it on every entry (to auto-create shared tracks).')
    const incompatible = await call(client, 'add_clips', { entries: [{ mediaRef: music.id, startFrame: 0, trackIndex: 0 }] })
    expect(incompatible.text).toBe('entries[0]: asset type audio is not compatible with video track at index 0')
    const typed = await call(client, 'add_clips', { entries: [{ mediaRef: still.id, startFrame: 2.5 }] })
    expect(typed.text).toBe('add_clips.entries[0].startFrame: Parsed JSON number <2.5> does not fit in Int.')
    const extra = await call(client, 'add_clips', { entries: [{ mediaRef: still.id, startFrame: 0, bogus: true }] })
    expect(extra.text).toBe("entries[0]: unknown field(s) 'bogus'. Allowed: endFrame, mediaRef, source, startFrame, trackIndex.")
    expect(h.session.doc).toBe(before)
  })

  it('add_clips overwrites the landing region on an existing track', async () => {
    await placeVideo(0)
    const r = await call(client, 'add_clips', { entries: [{ mediaRef: still.id, startFrame: 100, endFrame: 160, trackIndex: 0 }] })
    expect(r.isError).toBe(false)
    expect(clipsOn(0).map((c) => [c.mediaRef === still.id ? 'still' : 'video', c.startFrame, c.durationFrames])).toEqual([
      ['video', 0, 100],
      ['still', 100, 60],
      ['video', 160, 140],
    ])
  })

  it('insert_clips ripples the target and linked audio tracks', async () => {
    await placeVideo(0, { endFrame: 60 })
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 60, endFrame: 120, trackIndex: 0 }] })
    const r = await call(client, 'insert_clips', { trackIndex: 0, atFrame: 60, entries: [{ mediaRef: still.id, durationFrames: 30 }] })
    expect(r.isError).toBe(false)
    expect(clipsOn(0).map((c) => c.startFrame)).toEqual([0, 60, 90])
    expect(clipsOn(1).map((c) => c.startFrame)).toEqual([0, 90])
  })
})

describe('moves, splits and removal', () => {
  it('move_clips carries the linked partner by the same delta', async () => {
    await placeVideo(0, { endFrame: 60 })
    const [v] = clipsOn(0)
    const r = await call(client, 'move_clips', { moves: [{ clipId: v.id.slice(0, 8), toFrame: 120 }] })
    expect(r.isError).toBe(false)
    expect(clipsOn(0)[0].startFrame).toBe(120)
    expect(clipsOn(1)[0].startFrame).toBe(120)
    const bad = await call(client, 'move_clips', { moves: [{ clipId: v.id }] })
    expect(bad.text).toBe("moves[0]: at least one of 'toTrack' or 'toFrame' is required")
  })

  it('split_clips cuts linked partners and remove_clips takes the whole link group', async () => {
    await placeVideo(0)
    const [v] = clipsOn(0)
    const split = await call(client, 'split_clips', { splits: [{ clipId: v.id, atFrame: 100 }] })
    expect(split.isError).toBe(false)
    expect(clipsOn(0).map((c) => [c.startFrame, c.durationFrames])).toEqual([
      [0, 100],
      [100, 200],
    ])
    expect(clipsOn(1)).toHaveLength(2)
    const outside = await call(client, 'split_clips', { trackIndex: 0, frames: [100] })
    expect(outside.text).toBe('Frame 100 is not strictly inside any clip on track 0')
    const right = clipsOn(0)[1]
    const removed = await call(client, 'remove_clips', { clipIds: [right.id] })
    expect(removed.json.removedClipIds).toHaveLength(2)
    expect(allClips()).toHaveLength(2)
    expect((await call(client, 'remove_clips', { clipIds: ['nope'] })).text).toBe('Clip not found: nope')
  })

  it('ripple_delete_ranges cuts across the track and closes the gap', async () => {
    await placeVideo(0)
    const r = await call(client, 'ripple_delete_ranges', { trackIndex: 0, ranges: [[30, 60], [90, 120]] })
    expect(r.json.removedFrames).toBe(60)
    expect(clipsOn(0).map((c) => [c.startFrame, c.durationFrames])).toEqual([
      [0, 30],
      [30, 30],
      [60, 180],
    ])
    expect(clipsOn(1).reduce((n, c) => n + c.durationFrames, 0)).toBe(240)
    const units = await call(client, 'ripple_delete_ranges', { trackIndex: 0, ranges: [[1, 2]], units: 'seconds' })
    expect(units.text).toBe("units 'seconds' requires a clipId for source-media mapping; with trackIndex, ranges are project frames.")
  })
})

describe('clip properties and keyframes', () => {
  it('set_clip_properties applies values, clears keyframes and propagates timing to partners', async () => {
    await placeVideo(0)
    const [v] = clipsOn(0)
    await call(client, 'set_keyframes', { clipId: v.id, property: 'opacity', keyframes: [[0, 0], [30, 1, 'linear']] })
    expect(clipsOn(0)[0].opacityTrack?.keyframes).toHaveLength(2)
    const r = await call(client, 'set_clip_properties', { clipIds: [v.id], opacity: 0.5, durationFrames: 150, transform: { rotation: 90 } })
    expect(r.json.changed).toBe(true)
    expect(r.json.notes[0]).toBe(`Setting a static value cleared existing keyframes on: ${v.id.slice(0, 8)}.`)
    const after = clipsOn(0)[0]
    expect(after).toMatchObject({ opacity: 0.5, durationFrames: 150 })
    expect(after.transform.rotation).toBe(90)
    expect(after.opacityTrack).toBeUndefined()
    expect(clipsOn(1)[0].durationFrames).toBe(150)
  })

  it('reports exact validation errors and no-op receipts', async () => {
    await placeVideo(0)
    const [v, a] = [clipsOn(0)[0], clipsOn(1)[0]]
    expect((await call(client, 'set_clip_properties', { clipIds: [v.id], volumeDb: -70 })).text).toBe('volumeDb must be between -60.0 and +15.0 dB (got -70.0)')
    expect((await call(client, 'set_clip_properties', { clipIds: [a.id], crop: { left: 0.2 } })).text).toBe(`crop only applies to non-text visual clips: ${a.id.slice(0, 8)}`)
    expect((await call(client, 'set_clip_properties', { clipIds: [v.id] })).text).toBe('set_clip_properties needs at least one property to apply')
    expect((await call(client, 'set_clip_properties', { clipIds: [v.id], crop: { left: 0.6, right: 0.38 } })).text).toBe(
      'set_clip_properties.crop must leave at least 0.05 of the source visible on each axis (got width 0.020000000000000018, height 1.0)',
    )
    const before = h.session.snapshot().undoLabel
    const noop = await call(client, 'set_clip_properties', { clipIds: [v.id], opacity: 1 })
    expect(noop.json).toEqual({ changed: false, clips: [expect.objectContaining({ id: v.id.slice(0, 8) })] })
    expect(h.session.snapshot().undoLabel).toBe(before)
  })

  it('set_keyframes validates rows and clears with an empty array', async () => {
    await placeVideo(0)
    const [v] = clipsOn(0)
    expect((await call(client, 'set_keyframes', { clipId: v.id, property: 'opacity', keyframes: [[0, 2]] })).text).toBe('keyframes[0][1] (value): must be between 0.0 and 1.0 (got 2.0)')
    expect((await call(client, 'set_keyframes', { clipId: v.id, property: 'size', keyframes: [] })).text).toBe(
      "Unknown property 'size'. Expected one of: blur, crop, opacity, position, rotation, scale, volumeDb",
    )
    await call(client, 'set_keyframes', { clipId: v.id, property: 'position', keyframes: [[10, 0.1, 0.2], [0, 0, 0], [10, 0.3, 0.4, 'hold']] })
    expect(clipsOn(0)[0].positionTrack!.keyframes).toEqual([
      { frame: 0, value: { a: 0, b: 0 }, interpolationOut: 'smooth' },
      { frame: 10, value: { a: 0.3, b: 0.4 }, interpolationOut: 'hold' },
    ])
    const t = (await call(client, 'get_timeline')).json
    expect(t.tracks[0].clips[0].keyframes.position).toEqual([
      [0, 0, 0],
      [10, 0.3, 0.4, 'hold'],
    ])
    const cleared = await call(client, 'set_keyframes', { clipId: v.id, property: 'position', keyframes: [] })
    expect(cleared.json.notes).toEqual(['Cleared position keyframes.'])
    expect(clipsOn(0)[0].positionTrack).toBeUndefined()
  })
})

describe('tracks and markers', () => {
  it('manage_tracks reorders, sets flags and names, and removes in one undo step', async () => {
    await placeVideo(0)
    await call(client, 'add_clips', { entries: [{ mediaRef: still.id, startFrame: 0 }] })
    const ids = timeline().tracks.map((t) => t.id)
    const r = await call(client, 'manage_tracks', {
      reorder: [{ trackId: ids[0], to: 1 }],
      set: [{ trackId: ids[2], muted: true, name: '  Dialogue ' }],
      remove: [{ trackId: ids[1] }],
    })
    expect(r.isError).toBe(false)
    expect(r.json.reordered).toEqual([{ trackId: ids[0].slice(0, 8), from: 0, to: 1, changed: true }])
    expect(r.json.renamed).toEqual([{ trackId: ids[2].slice(0, 8), name: 'Dialogue', changed: true }])
    expect(timeline().tracks.map((t) => t.id)).toEqual([ids[0], ids[2]])
    expect(timeline().tracks[1]).toMatchObject({ muted: true, name: 'Dialogue' })
    await call(client, 'undo')
    expect(timeline().tracks.map((t) => t.id)).toEqual(ids)
    expect((await call(client, 'manage_tracks', {})).text).toBe('Nothing to do — pass at least one of reorder, set, remove.')
    expect((await call(client, 'manage_tracks', { set: [{ index: 0, name: 'a\nb' }] })).text).toBe('set[0].name must be one line of at most 80 characters')
  })

  it('manage_markers creates, updates, no-ops and deletes', async () => {
    const created = await call(client, 'manage_markers', { action: 'create', name: 'Fix color', startFrame: 12, durationFrames: 6, color: '#F00' })
    const marker = timeline().markers[0]
    expect(marker).toMatchObject({ name: 'Fix color', startFrame: 12, durationFrames: 6, color: { r: 1, g: 0, b: 0, a: 1 }, status: 'open' })
    expect(created.json.created).toEqual({ markerId: marker.id.slice(0, 8), name: 'Fix color', startFrame: 12, endFrame: 18, durationFrames: 6, color: '#FF0000FF', comment: '', status: 'open' })
    const updated = await call(client, 'manage_markers', { action: 'update', markerId: marker.id.slice(0, 8), status: 'review' })
    expect(updated.json.updated.status).toBe('review')
    expect((await call(client, 'manage_markers', { action: 'update', markerId: marker.id, status: 'review' })).json).toEqual({ noOp: true })
    expect((await call(client, 'manage_markers', { action: 'create', name: 'x', startFrame: 0, status: 'done' })).text).toBe('status must be open, review, or resolved.')
    expect((await call(client, 'manage_markers', { action: 'create', name: ' ', startFrame: 0 })).text).toBe('Marker names must be non-empty single lines of at most 120 characters.')
    expect((await call(client, 'manage_markers', { action: 'create', name: 'x', startFrame: -1 })).text).toBe('Marker frames must be non-negative integer ranges and every ID must exist.')
    const deleted = await call(client, 'manage_markers', { action: 'delete', markerId: marker.id })
    expect(deleted.json).toEqual({ deletedMarkerId: marker.id.slice(0, 8) })
    expect(timeline().markers).toEqual([])
  })
})

describe('text', () => {
  it('add_texts places measured boxes on a new top track; update_text restyles and refits', async () => {
    await placeVideo(0)
    const r = await call(client, 'add_texts', {
      entries: [
        { startFrame: 0, endFrame: 60, content: 'Hello', style: { fontSize: 100, alignment: 'left', shadow: { color: '#00FF00', opacity: 0.5 } }, transform: { x: 0.1, y: 0.8 } },
        { startFrame: 60, endFrame: 90, content: 'World', animation: 'popIn', fillMode: 'footage' },
      ],
    })
    expect(r.isError).toBe(false)
    expect(r.json.createdTracks).toEqual([{ index: 0, label: 'V2', type: 'video' }])
    const [hello, world] = clipsOn(0)
    const w = (5 * 100 * 0.5) / 1920
    expect(hello.transform.width).toBeCloseTo(w)
    expect(hello.transform.centerX).toBeCloseTo(0.1 + w / 2)
    expect(hello.transform.centerY).toBe(0.8)
    expect(hello.textStyle!.shadow.color).toEqual({ r: 0, g: 1, b: 0, a: 0.5 })
    expect(world.textAnimation).toEqual({ preset: 'popIn', perWordFrames: 6 })
    expect(world.textFillMode).toBe('footage')
    expect(world.textStyle!.color).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    const u = await call(client, 'update_text', { clipIds: [hello.id], content: 'Hello there', style: { bold: true } })
    expect(u.json.changed).toBe(true)
    const after = clipsOn(0)[0]
    expect(after.textContent).toBe('Hello there')
    expect(after.textStyle!.isBold).toBe(true)
    expect(after.transform.width).toBeCloseTo((11 * 100 * 0.5) / 1920)
    expect(after.transform.centerX - after.transform.width / 2).toBeCloseTo(0.1)
    expect((await call(client, 'add_texts', { entries: [{ startFrame: 0, endFrame: 10, content: 'x', style: { fontSize: 5 } }] })).text).toBe(
      'entries[0].style.fontSize: must be between 12.0 and 300.0',
    )
    expect((await call(client, 'update_text', { clipIds: [hello.id] })).text).toBe('update_text needs at least one text property to apply')
  })
})

describe('color and effects', () => {
  it('apply_color merges knobs into canonical color effects and get_timeline echoes the grade', async () => {
    await placeVideo(0)
    const [v] = clipsOn(0)
    const r = await call(client, 'apply_color', { clipIds: [v.id], exposure: 0.5, shadowsHue: 180, shadowsAmount: 0.15 })
    expect(r.json.clips[0].color).toEqual({ exposure: 0.5, shadowsHue: 180, shadowsAmount: 0.15 })
    await call(client, 'apply_color', { clipIds: [v.id], saturation: 1.2 })
    expect(clipsOn(0)[0].effects!.map((e) => e.type)).toEqual(['color.exposure', 'color.saturation', 'color.wheels'])
    const grade = (await call(client, 'get_timeline')).json.tracks[0].clips[0].color
    expect(grade).toEqual({ exposure: 0.5, saturation: 1.2, shadowsHue: 180, shadowsAmount: 0.15 })
    expect((await call(client, 'apply_color', { clipIds: [v.id] })).text).toBe('No grade parameters provided.')
    expect((await call(client, 'apply_color', { clipIds: [v.id], color: grade, reset: true })).text).toBe(
      "'color' pastes a complete grade — don't combine it with individual knobs or reset.",
    )
    const audio = clipsOn(1)[0]
    expect((await call(client, 'apply_color', { clipIds: [audio.id], exposure: 1 })).text).toBe(`Clip ${audio.id.slice(0, 8)} is a audio clip; apply_color needs a video or image clip.`)
  })

  it('apply_effect clamps params, keeps canonical order and removes by type', async () => {
    await placeVideo(0)
    const [v] = clipsOn(0)
    const r = await call(client, 'apply_effect', {
      clipIds: [v.id],
      effects: [
        { type: 'stylize.glow', params: { intensity: 2 } },
        { type: 'blur.gaussian', params: { radius: 12.3456 } },
      ],
    })
    expect(r.json.clips[0].effects).toEqual([
      { type: 'blur.gaussian', params: { radius: 12.346 } },
      { type: 'stylize.glow', params: { intensity: 1, radius: 20, threshold: 0.6, warmth: 0 } },
    ])
    await call(client, 'apply_effect', { clipIds: [v.id], remove: ['blur.gaussian'], effects: [{ type: 'stylize.glow', enabled: false }] })
    expect(clipsOn(0)[0].effects!.map((e) => [e.type, e.enabled])).toEqual([['stylize.glow', false]])
    expect((await call(client, 'apply_effect', { clipIds: [v.id], effects: [{ type: 'color.exposure' }] })).text).toBe("'color.exposure' is a color grade — use apply_color, not apply_effect.")
    expect((await call(client, 'apply_effect', { clipIds: [v.id], effects: [{ type: 'blur.gaussian', params: { size: 1 } }] })).text).toBe(
      "blur.gaussian: unknown param(s) 'size'. Allowed: radius.",
    )
  })
})

describe('project settings, timelines and undo', () => {
  it('set_project_settings rescales frames on fps change and reports matches', async () => {
    await placeVideo(0, { endFrame: 60 })
    const r = await call(client, 'set_project_settings', { fps: 60 })
    expect(r.json).toEqual({ fps: 60, resolution: '1920x1080', aspectRatio: '16:9', changed: ['fps'], note: 'Clip frames rescaled to 60fps — re-read get_timeline before frame-based edits.' })
    expect(clipsOn(0)[0].durationFrames).toBe(120)
    const ar = await call(client, 'set_project_settings', { aspectRatio: '9:16' })
    expect(ar.json).toMatchObject({ resolution: '1080x1920', aspectRatio: '9:16', changed: ['resolution'] })
    expect((await call(client, 'set_project_settings', { fps: 60 })).json.note).toBe('Settings already matched.')
    expect((await call(client, 'set_project_settings', { width: 100 })).text).toBe('Provide both width and height')
    expect((await call(client, 'set_project_settings', { fps: 200 })).text).toBe('fps must be between 1 and 120 (got 200)')
    expect((await call(client, 'set_project_settings', { aspectRatio: 'wide' })).text).toBe('Use an aspect ratio with two positive numbers, such as 3:2.')
  })

  it('create_timeline duplicates with new ids and set_active_timeline switches', async () => {
    await placeVideo(0)
    const original = timeline()
    const dup = await call(client, 'create_timeline', { from: original.id, name: 'Vertical' })
    expect(dup.json).toMatchObject({ name: 'Vertical', active: true })
    const copy = timeline()
    expect(copy.id).not.toBe(original.id)
    expect(copy.tracks[0].clips[0].id).not.toBe(original.tracks[0].clips[0].id)
    expect(copy.tracks[0].clips[0].mediaRef).toBe(video.id)
    const back = await call(client, 'set_active_timeline', { timelineId: original.id.slice(0, 8) })
    expect(back.json.note).toBe('Re-read get_timeline — clip and track ids from the previous timeline no longer apply.')
    expect(timeline().id).toBe(original.id)
    expect((await call(client, 'set_active_timeline', { timelineId: original.id })).json.note).toBe('Already the active timeline.')
    const empty = await call(client, 'create_timeline')
    expect(empty.json).toMatchObject({ name: 'Timeline 3', note: 'Empty and now active; all edit tools target it.' })
    expect((await call(client, 'create_timeline', { from: 'XYZ' })).text).toBe("No timeline with id 'XYZ'. get_media lists the project's timelines.")
  })

  it('undo reverts the latest agent edit as one step', async () => {
    await placeVideo(0)
    await call(client, 'split_clips', { trackIndex: 0, frames: [50, 100, 150] })
    expect(clipsOn(0)).toHaveLength(4)
    const r = await call(client, 'undo')
    expect(r.text).toBe('Undid the latest action. The timeline is restored to its state before that edit; re-read with get_timeline or get_transcript before editing again.')
    expect(clipsOn(0)).toHaveLength(1)
    await call(client, 'undo')
    expect(allClips()).toHaveLength(0)
    expect((await call(client, 'undo')).text).toBe('Nothing to undo.')
  })
})
