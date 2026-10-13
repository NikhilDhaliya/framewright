import './env'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newId, type MulticamSource } from '../../src/core/model'
import { activeTimeline } from '../../src/core/ops/context'
import { audioEntry, call, connect, imageEntry, startHarness, videoEntry, type Harness } from './harness'

let h: Harness
let client: Client
const video = videoEntry()
const cam2 = videoEntry({ name: 'Wide' })
const still = imageEntry()
const music = audioEntry()

beforeEach(async () => {
  h = await startHarness([video, cam2, still, music])
  client = await connect(h.url)
})

afterEach(async () => {
  await client.close()
  await h.close()
})

const timeline = () => activeTimeline(h.session.doc)

describe('project binding', () => {
  it('guards edits when another project is frontmost but still allows reads', async () => {
    const other = await h.sessions.create('Other')
    expect(h.sessions.focused()).toBe(other)
    const blocked = await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    expect(blocked.text).toBe(`This session is on '${h.session.name}', but 'Other' is active in Framewright. Activate '${h.session.name}' or call manage_project with action='open' before making changes.`)
    expect((await call(client, 'get_timeline')).isError).toBe(false)
    const opened = await call(client, 'manage_project', { action: 'open', name: 'Other' })
    expect(opened.json).toMatchObject({ status: 'active', name: 'Other', fps: 30, resolution: '1920x1080', mediaCount: 0, openCount: 2 })
    expect((await call(client, 'get_media')).json.assets).toEqual([])
    expect(h.ui).toContainEqual({ type: 'toast', message: 'Now editing: Other' })
  })

  it('manage_project lists, creates with settings, and closes', async () => {
    const listed = (await call(client, 'manage_project', { action: 'list' })).json
    expect(listed.openCount).toBe(1)
    expect(listed.projects[0]).toMatchObject({ name: h.session.name, isOpen: true, isActive: true, isVisible: true, isAccessible: true })
    const created = await call(client, 'manage_project', { action: 'create', name: 'Shorts', aspectRatio: '9:16', fps: 24 })
    expect(created.json).toMatchObject({ status: 'created', name: 'Shorts', fps: 24, resolution: '1080x1920' })
    const second = await call(client, 'manage_project', { action: 'create', name: 'Shorts' })
    expect(second.json.name).toBe('Shorts 2')
    const closed = await call(client, 'manage_project', { action: 'close' })
    expect(closed.json).toMatchObject({ status: 'closed', name: 'Shorts 2', openCount: 2 })
    expect((await call(client, 'get_timeline')).text).toBe('Editor not available')
    expect((await call(client, 'manage_project', { action: 'list', name: 'x' })).text).toBe("manage_project action='list': unknown field(s) 'name'. Allowed: none.")
    expect((await call(client, 'manage_project', { action: 'open', name: 'Nope' })).text).toMatch(/^No project named 'Nope'\. Known projects: /)
    expect((await call(client, 'manage_project', { action: 'fly' })).text).toBe("Unknown project action 'fly'. Use one of: list, open, create, close.")
  })

  it('reports agent activity and highlights changed clips in the editor', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: still.id, startFrame: 0 }] })
    const clip = timeline().tracks[0].clips[0]
    expect(h.ui).toContainEqual({ type: 'agentActivity', tool: 'add_clips', status: 'start' })
    expect(h.ui).toContainEqual({ type: 'agentChanges', changes: { addedClipIds: [clip.id], mutatedClipIds: [], mutatedTrackIds: [] } })
    // Mac parity: agent edits glow; they do not change the user's selection.
    expect(h.ui.some((c) => c.type === 'select')).toBe(false)
  })
})

describe('clip tools', () => {
  it('manage_clip_links unlinks and relinks a pair', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    const [v, a] = [timeline().tracks[0].clips[0], timeline().tracks[1].clips[0]]
    await call(client, 'manage_clip_links', { action: 'unlink', clipIds: [v.id] })
    expect(timeline().tracks.flatMap((t) => t.clips).every((c) => !c.linkGroupId)).toBe(true)
    expect((await call(client, 'manage_clip_links', { action: 'unlink', clipIds: [v.id] })).text).toBe('None of the provided clips is linked')
    await call(client, 'manage_clip_links', { action: 'link', clipIds: [v.id, a.id] })
    const [v2, a2] = [timeline().tracks[0].clips[0], timeline().tracks[1].clips[0]]
    expect(v2.linkGroupId).toBeDefined()
    expect(v2.linkGroupId).toBe(a2.linkGroupId)
    expect((await call(client, 'manage_clip_links', { action: 'merge', clipIds: [v.id] })).text).toBe('manage_clip_links.action: Cannot initialize Action from invalid String value merge')
  })

  it('swap_clip_media keeps the edit and updates linked partners', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0, source: [2, 5] }] })
    const v = timeline().tracks[0].clips[0]
    const r = await call(client, 'swap_clip_media', { clipId: v.id, mediaRef: cam2.id })
    expect(r.json).toMatchObject({ changed: true, oldMediaRef: video.id.slice(0, 8), mediaRef: cam2.id.slice(0, 8) })
    expect(timeline().tracks.flatMap((t) => t.clips).map((c) => c.mediaRef)).toEqual([cam2.id, cam2.id])
    expect(timeline().tracks[0].clips[0]).toMatchObject({ trimStartFrame: 60, durationFrames: 90 })
    expect((await call(client, 'swap_clip_media', { clipId: v.id, mediaRef: still.id })).text).toBe("Replacement must match the clip's source type.")
  })

  it('copy_clip_settings copies static visual settings to a track range', async () => {
    await call(client, 'add_clips', {
      entries: [
        { mediaRef: still.id, startFrame: 0 },
        { mediaRef: still.id, startFrame: 150 },
      ],
    })
    const [a, b] = timeline().tracks[0].clips
    await call(client, 'set_clip_properties', { clipIds: [a.id], opacity: 0.4, edgeRounding: 0.2 })
    const r = await call(client, 'copy_clip_settings', { sourceClipId: a.id, targetTrack: { trackId: timeline().tracks[0].id } })
    expect(r.json).toMatchObject({ changed: true, mediaType: 'image', matchedClipCount: 1, changedClipCount: 1, unchangedClipCount: 0, incompatibleClipCount: 0, sourceExcluded: true })
    expect(timeline().tracks[0].clips.find((c) => c.id === b.id)).toMatchObject({ opacity: 0.4, edgeRounding: 0.2 })
    expect((await call(client, 'copy_clip_settings', { sourceClipId: a.id })).text).toBe("Provide exactly one of 'targetClipIds' or 'targetTrack'")
  })

  it('apply_layout places a picture-in-picture with the inset on top', async () => {
    const r = await call(client, 'apply_layout', {
      layout: 'pip_bottom_right',
      slots: [
        { slot: 'main', mediaRef: video.id },
        { slot: 'inset', mediaRef: still.id },
      ],
      endFrame: 90,
    })
    expect(r.isError).toBe(false)
    const [top, bottom] = timeline().tracks
    expect(top.clips[0].mediaRef).toBe(still.id)
    expect(bottom.clips[0].mediaRef).toBe(video.id)
    const inset = top.clips[0].transform
    expect(inset.width).toBeCloseTo(0.28)
    expect(inset.centerX - inset.width / 2).toBeCloseTo(0.685)
    // Square still in a 16:9-pixel slot is taller than the slot, so fill crops top/bottom (Mac cropFittingAspect).
    expect(top.clips[0].crop.left + top.clips[0].crop.right).toBeCloseTo(0)
    expect(top.clips[0].crop.top + top.clips[0].crop.bottom).toBeCloseTo(1 - 9 / 16)
    expect(inset.height).toBeCloseTo(0.28 / (9 / 16))
    expect((await call(client, 'apply_layout', { layout: 'side_by_side', slots: [{ slot: 'left', mediaRef: video.id }], endFrame: 10 })).text).toBe(
      "layout 'side_by_side' needs every slot filled. Missing: right",
    )
  })
})

describe('multicam', () => {
  it('get_multicam reads the program and change_cam switches angles in one step', async () => {
    const group: MulticamSource = {
      id: newId(),
      name: 'Podcast',
      masterMemberId: '',
      members: [
        { id: newId(), mediaRef: video.id, kind: 'both', angleLabel: 'close', sync: { offsetSeconds: 0, confidence: 1, locked: false } },
        { id: newId(), mediaRef: cam2.id, kind: 'angle', angleLabel: 'wide', sync: { offsetSeconds: 0, confidence: 1, locked: false } },
      ],
    }
    group.masterMemberId = group.members[0].id
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    h.session.transact('stamp', (d) => {
      d.file.multicamGroups = [group]
      for (const tr of activeTimeline(d).tracks) for (const c of tr.clips) c.multicamGroupId = group.id
    })
    const read = await call(client, 'get_multicam', { groupId: group.id })
    expect(read.json).toMatchObject({ name: 'Podcast', program: [['close', 0, 300]], trackIndexes: [0, 1] })
    expect(read.json.members[0]).toMatchObject({ angleLabel: 'close', kind: 'both', master: true })
    const r = await call(client, 'change_cam', { groupId: group.id, entries: [{ range: [100, 200], angle: 'wide' }] })
    expect(r.json).toMatchObject({ switched: 1, program: [['wide', 100, 200]] })
    expect(timeline().tracks[0].clips.map((c) => [c.mediaRef === cam2.id ? 'wide' : 'close', c.startFrame, c.durationFrames])).toEqual([
      ['close', 0, 100],
      ['wide', 100, 100],
      ['close', 200, 100],
    ])
    await call(client, 'change_cam', { clipId: timeline().tracks[0].clips[1].id, entries: [{ range: [100, 200], angle: 'close' }] })
    expect(timeline().tracks[0].clips).toHaveLength(1)
    expect((await call(client, 'change_cam', { groupId: group.id, entries: [{ range: [0, 10], angle: 'drone' }] })).text).toBe('Unknown angle \'drone\'. Angles: close, wide.')
    expect((await call(client, 'manage_multicam', { ungroup: { groupId: group.id } })).json.ungrouped).toBe(group.id.slice(0, 8))
    expect(h.session.doc.file.multicamGroups).toEqual([])
  })
})

describe('generation, ML and feedback', () => {
  it('lists nothing and refuses generation without a provider key', async () => {
    const models = (await call(client, 'list_models', { type: 'upscale' })).json
    expect(models).toEqual({ models: [], loaded: true })
    const gen = await call(client, 'generate_video', { prompt: 'a harbor at dusk' })
    expect(gen.text).toBe('Generation requires an API key. Tell the user to add one in Settings ▸ Models & API Keys.')
    expect((await call(client, 'generate_image', { prompt: 5 })).text).toBe('Missing required argument: prompt')
  })

  it('validates against the catalog model when a key is set', async () => {
    h.ctx.settings().apiKeys.fal = 'test-key'
    try {
      expect((await call(client, 'generate_video', { prompt: 'x', duration: 3 })).text).toBe("MiniMax H3 does not support duration '3s'. Valid: 5s, 6s, 7s, 8s, 9s, 10s, 11s, 12s, 13s, 14s, 15s.")
      expect((await call(client, 'generate_image', { prompt: 'x', model: 'dall-e' })).text).toMatch(/^Unknown model 'dall-e'\. Available: gpt-image-2, /)
      expect((await call(client, 'list_models', { type: 'upscale' })).json.models.map((m: { id: string }) => m.id)).toEqual([
        'topaz-video-upscaler',
        'topaz-image-upscaler',
        'bytedance-upscaler',
        'seedvr-image-upscaler',
        'seedvr-video-upscaler',
      ])
      expect((await call(client, 'get_timeline')).json.canGenerate).toBe(true)
    } finally {
      delete h.ctx.settings().apiKeys.fal
    }
  })

  it('NEEDS-ML tools keep their argument checks and explain what is missing', async () => {
    expect((await call(client, 'get_transcript', { foo: 1 })).text).toBe(
      "get_transcript: unknown field(s) 'foo'. Allowed: clipId, endFrame, granularity, language, startFrame, trackIndex, wordTimestamps.",
    )
    expect((await call(client, 'detect_beats', { mediaRef: music.id, foo: 1 })).text).toBe("detect_beats: unknown field(s) 'foo'. Allowed: endSeconds, mediaRef, startSeconds.")
    expect((await call(client, 'detect_beats', { mediaRef: music.id })).text).toMatch(/^Media file not on disk: /)
    const inspect = await call(client, 'inspect_media', { mediaRef: music.id })
    expect(inspect.text).toMatch(/^Media file not on disk: /)
  })

  it('send_feedback validates, de-duplicates and stays local', async () => {
    const first = await call(client, 'send_feedback', { category: 'suggestion', summary: 'More layouts' })
    expect(first.isError).toBe(false)
    expect((await call(client, 'send_feedback', { category: 'suggestion', summary: 'More layouts' })).text).toBe('Already flagged this to the team this session — not sending a duplicate.')
    expect((await call(client, 'send_feedback', { category: 'idea', summary: 'x' })).text).toBe(
      "Invalid category 'idea'. Expected one of: confusing_ux, failure, missing_capability, suggestion, wrong_result.",
    )
  })

})
