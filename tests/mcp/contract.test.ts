import './env'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BRANDED_SPEC as spec } from '../../src/main/mcp/brandedSpec'
import { activeTimeline } from '../../src/core/ops/context'
import { call, connect, imageEntry, startHarness, videoEntry, type Harness } from './harness'

let h: Harness
let client: Client
const video = videoEntry()
// Two assets whose ids share a 35-character prefix, so an 8-character prefix is ambiguous.
const twinA = imageEntry({ id: 'ABCDEF01-2345-4678-9ABC-DEF012345671', name: 'Twin A' })
const twinB = imageEntry({ id: 'ABCDEF01-2345-4678-9ABC-DEF012345672', name: 'Twin B' })

beforeEach(async () => {
  h = await startHarness([video, twinA, twinB])
  client = await connect(h.url)
})

afterEach(async () => {
  await client.close()
  await h.close()
})

const timeline = () => activeTimeline(h.session.doc)
async function rpc(body: unknown) {
  const res = await fetch(h.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  // A header-less initialize opens a stateful session, whose answer arrives as one SSE event.
  const data = res.headers.get('content-type')?.startsWith('text/event-stream') ? text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).at(-1)! : text
  return JSON.parse(data)
}

/** Spec §1.6 step 4, typed out independently of the server's own list. */
const READ_ONLY = ['get_timeline', 'inspect_timeline', 'get_media', 'inspect_media', 'search_media', 'get_multicam', 'get_transcript', 'detect_beats', 'inspect_color', 'list_models', 'send_feedback']

describe('verbatim contract', () => {
  it('the sessionless tools/list and initialize carry tools.json verbatim', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'curl', version: '0' } } })
    expect(init.result.protocolVersion).toBe('2025-11-25')
    expect(init.result.instructions).toBe(spec.instructions)
    expect(init.result.instructions).toBe(spec.serverInstructions + spec.projectNavigation)
    expect(init.result.serverInfo).toEqual(spec.serverInfo)
    const { result } = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(result.tools).toEqual(spec.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })))
    expect(result.nextCursor).toBeUndefined()
  })

  it('never exposes the in-app-only skill tools', async () => {
    for (const t of spec.inAppOnlyTools) expect((await call(client, t.name, {})).text).toBe(`Unknown tool: ${t.name}`)
  })
})

describe('frontmost-project guard', () => {
  it('lets exactly the read-only allowlist run on a background project', async () => {
    await h.sessions.create('Other')
    const guard = `This session is on '${h.session.name}', but 'Other' is active in Framewright. Activate '${h.session.name}' or call manage_project with action='open' before making changes.`
    const before = h.session.doc
    for (const t of spec.tools) {
      if (t.name === 'manage_project') continue
      const r = await call(client, t.name, {})
      if (READ_ONLY.includes(t.name)) expect(r.text, t.name).not.toBe(guard)
      else expect(r.text, t.name).toBe(guard)
    }
    expect(h.session.doc).toBe(before)
    expect(h.sessions.all().find((s) => s.name === 'Other')!.doc.file.timelines[0].tracks).toEqual([])
  })

  it('edits again once manage_project re-opens the session project', async () => {
    await h.sessions.create('Other')
    expect((await call(client, 'manage_project', { action: 'open', name: h.session.name })).json.status).toBe('active')
    expect((await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })).isError).toBe(false)
    expect(timeline().tracks[0].clips[0].mediaRef).toBe(video.id)
  })
})

describe('short ids', () => {
  it('shortens colliding ids past 8 characters and refuses an ambiguous prefix', async () => {
    const media = await call(client, 'get_media')
    expect(media.text).toContain('"ABCDEF01-2345-4678-9ABC-DEF012345671"')
    expect(media.text).not.toContain(video.id)
    expect(media.text).toContain(`"${video.id.slice(0, 8)}"`)
    const ambiguous = await call(client, 'add_clips', { entries: [{ mediaRef: 'ABCDEF01', startFrame: 0 }] })
    expect(ambiguous.text).toBe("Ambiguous id 'ABCDEF01' matches 2 items; re-read with get_timeline or get_media for current ids.")
    expect(timeline().tracks).toEqual([])
    const placed = await call(client, 'add_clips', { entries: [{ mediaRef: 'ABCDEF01-2345-4678-9ABC-DEF01234567', startFrame: 0 }] })
    expect(placed.text).toBe("Ambiguous id 'ABCDEF01-2345-4678-9ABC-DEF01234567' matches 2 items; re-read with get_timeline or get_media for current ids.")
    expect((await call(client, 'add_clips', { entries: [{ mediaRef: twinB.id, startFrame: 0 }] })).isError).toBe(false)
    expect(timeline().tracks[0].clips[0].mediaRef).toBe(twinB.id)
    const clip = timeline().tracks[0].clips[0]
    // Prefixes under 8 characters pass through untouched and hit the tool's own not-found error.
    expect((await call(client, 'remove_clips', { clipIds: [clip.id.slice(0, 7)] })).text).toBe(`Clip not found: ${clip.id.slice(0, 7)}`)
    expect((await call(client, 'remove_clips', { clipIds: [clip.id.slice(0, 8)] })).json.removedClipIds).toEqual([clip.id.slice(0, 8)])
    expect(timeline().tracks.flatMap((t) => t.clips)).toEqual([])
  })
})

describe('sessionless (curl-style) edits', () => {
  it('bind to the frontmost project, mutate it, and undo as one step', async () => {
    const add = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_clips', arguments: { entries: [{ mediaRef: video.id.slice(0, 8), startFrame: 15 }] } } })
    expect(add.result.isError).toBeUndefined()
    const delta = JSON.parse(add.result.content[0].text)
    expect(delta.createdTracks).toHaveLength(2)
    expect(timeline().tracks.map((t) => t.clips[0].startFrame)).toEqual([15, 15])
    const undo = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'undo' } })
    expect(undo.result.content[0].text).toMatch(/^Undid the latest action\./)
    expect(timeline().tracks).toEqual([])
    const bad = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'move_clips', arguments: { moves: 'x' } } })
    expect(bad.result.isError).toBe(true)
    expect(bad.error).toBeUndefined()
  })
})

describe('receipts and undo steps', () => {
  it('validation failures change nothing and record no undo step', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    const doc = h.session.doc
    const label = h.session.snapshot().undoLabel
    const clip = timeline().tracks[0].clips[0]
    const failures: [string, Record<string, unknown>, string][] = [
      ['add_clips', { entries: [{ mediaRef: video.id }] }, "add_clips.entries[0]: missing required field 'startFrame'"],
      ['add_clips', { entries: [{ mediaRef: video.id, startFrame: '3' }] }, 'add_clips.entries[0].startFrame: expected Int, got something else'],
      ['add_clips', { entries: [], extra: 1 }, "add_clips: unknown field(s) 'extra'. Allowed: entries."],
      ['set_clip_properties', { clipIds: [clip.id], opacity: 3 }, 'opacity must be between 0 and 1 (got 3.0)'],
      ['move_clips', { moves: [{ clipId: 'FFFFFFFF', toFrame: 3 }] }, 'moves[0]: clip not found: FFFFFFFF'],
      ['split_clips', { splits: [{ clipId: clip.id, atFrame: 0 }] }, expect.any(String) as unknown as string],
    ]
    for (const [tool, args, message] of failures) {
      const r = await call(client, tool, args)
      expect(r.isError, tool).toBe(true)
      expect(r.text, tool).toEqual(message)
    }
    expect(h.session.doc).toBe(doc)
    expect(h.session.snapshot().undoLabel).toBe(label)
  })

  it('no-op edits return their receipts and record no undo step', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    const doc = h.session.doc
    const label = h.session.snapshot().undoLabel
    const [v] = timeline().tracks[0].clips
    const trackId = timeline().tracks[0].id
    // move_clips reports its touched clips even when they stay put (Mac passes every move as touched).
    expect((await call(client, 'move_clips', { moves: [{ clipId: v.id, toFrame: 0 }] })).json).toEqual({ clips: [expect.objectContaining({ id: v.id.slice(0, 8), frames: [0, 300] })] })
    expect((await call(client, 'manage_tracks', { set: [{ trackId, muted: false }] })).isError).toBe(false)
    expect((await call(client, 'set_clip_properties', { clipIds: [v.id], speed: 1 })).json.changed).toBe(false)
    expect((await call(client, 'swap_clip_media', { clipId: v.id, mediaRef: video.id })).json).toMatchObject({ changed: false })
    expect((await call(client, 'set_project_settings', { fps: 30 })).json.note).toBe('Settings already matched.')
    expect(h.session.doc).toBe(doc)
    expect(h.session.snapshot().undoLabel).toBe(label)
  })

  it('a multi-part agent edit is one undo step shared with the editor', async () => {
    await call(client, 'add_clips', {
      entries: [
        { mediaRef: video.id, startFrame: 0 },
        { mediaRef: twinA.id, startFrame: 300 },
      ],
    })
    const first = h.session.doc
    const r = await call(client, 'manage_tracks', { set: [{ index: 0, name: 'Main', hidden: true }, { index: 1, muted: true }] })
    expect(r.isError).toBe(false)
    expect(timeline().tracks.map((t) => [t.name, t.hidden, t.muted])).toEqual([
      ['Main', true, false],
      [undefined, false, true],
    ])
    h.session.undo()
    expect(h.session.doc).toEqual(first)
    expect((await call(client, 'undo')).isError).toBe(false)
    expect(timeline().tracks).toEqual([])
  })
})
