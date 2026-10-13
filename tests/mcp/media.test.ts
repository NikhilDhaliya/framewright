import { TEST_ROOT } from './env'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeTimeline } from '../../src/core/ops/context'
import { imageSize } from '../../src/main/mcp/tools/images'
import { call, connect, imageEntry, makePng, startHarness, videoEntry, type Harness } from './harness'

let h: Harness
let client: Client
const video = videoEntry()
const still = imageEntry()

beforeEach(async () => {
  h = await startHarness([video, still])
  client = await connect(h.url)
})

afterEach(async () => {
  await client.close()
  await h.close()
})

const entries = () => h.session.doc.manifest.entries

describe('library', () => {
  it('get_media lists assets, folders and timelines; filters by ids, folder and pending', async () => {
    await call(client, 'organize_media', { moves: [{ items: [still.id], into: 'B-roll/Sunset' }] })
    const all = (await call(client, 'get_media')).json
    expect(all.assets.map((a: { name: string }) => a.name)).toEqual(['Interview', 'Still'])
    expect(all.assets[1].folder).toBe('B-roll/Sunset')
    expect(all.folders).toEqual(['B-roll', 'B-roll/Sunset'])
    expect(all.timelines[0]).toMatchObject({ active: true, durationSeconds: 0, name: 'Timeline 1' })
    const byFolder = (await call(client, 'get_media', { folder: 'b-roll' })).json
    expect(byFolder).toEqual({ assets: [expect.objectContaining({ name: 'Still' })] })
    expect((await call(client, 'get_media', { ids: [video.id.slice(0, 8)] })).json.assets).toHaveLength(1)
    expect((await call(client, 'get_media', { folder: 'Nope' })).text).toBe("Folder not found: 'Nope'. Folders: B-roll, B-roll/Sunset")
  })

  it('organize_media renames, deletes assets with their clips and refuses deleting every timeline', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    const r = await call(client, 'organize_media', { renames: [{ item: still.id, name: 'Sky' }], deletes: [video.id] })
    expect(r.json).toMatchObject({ renamed: 1, deleted: { assets: 1 }, clipsRemoved: 2 })
    expect(entries().map((e) => e.name)).toEqual(['Sky'])
    expect(activeTimeline(h.session.doc).tracks).toEqual([])
    const tl = activeTimeline(h.session.doc).id
    expect((await call(client, 'organize_media', { deletes: [tl] })).text).toBe("Can't delete every timeline — the project needs at least one.")
    expect((await call(client, 'organize_media', {})).text).toBe('Nothing to do — pass at least one of createFolders, moves, renames, deletes.')
  })

  it('import_media imports a local file in place, inline bytes into the package, and a matte', async () => {
    const file = path.join(TEST_ROOT, 'clip.mp4')
    await fs.writeFile(file, 'not really video')
    const fromPath = await call(client, 'import_media', { source: { path: file }, name: 'B cam', folder: 'Cams' })
    expect(fromPath.json).toMatchObject({ name: 'B cam', type: 'video', status: 'ready' })
    const e = entries().find((x) => x.name === 'B cam')!
    expect(e.source).toEqual({ external: { absolutePath: file } })
    expect(e.folderId).toBe(h.session.doc.manifest.folders[0].id)
    const png = await makePng(8, 6)
    const fromBytes = await call(client, 'import_media', { source: { bytes: png.toString('base64'), mimeType: 'image/png' } })
    expect(fromBytes.json).toMatchObject({ name: 'Imported asset', type: 'image', status: 'ready' })
    const stored = h.session.resolveMedia(entries().find((x) => x.name === 'Imported asset')!)!
    expect(stored.startsWith(path.join(h.session.path, 'media'))).toBe(true)
    const matte = await call(client, 'import_media', { source: { matte: { hex: '#000', aspectRatio: '1:1' } } })
    expect(matte.json).toMatchObject({ name: 'Matte · 1:1', type: 'image' })
    const matteFile = h.session.resolveMedia(entries().find((x) => x.name === 'Matte · 1:1')!)!
    expect(imageSize(await fs.readFile(matteFile))).toEqual({ width: 1080, height: 1080 })
    expect((await call(client, 'import_media', { source: { path: file, url: 'https://x/y.mp4' } })).text).toBe(
      "source must set exactly one of 'url', 'path', 'bytes', or 'matte' (got 2)",
    )
    expect((await call(client, 'import_media', { source: { url: 'http://x/y.mp4' } })).text).toBe('source.url must use https')
    expect((await call(client, 'import_media', { source: { url: 'https://x/y' } })).text).toBe(
      "Cannot infer media type from URL extension (none). Set source.mimeType to disambiguate (e.g. 'video/mp4', 'image/png').",
    )
    expect((await call(client, 'import_media', { source: { bytes: 'AAAA', mimeType: 'image/bmp2' } })).text).toMatch(/^Unsupported mimeType 'image\/bmp2'/)
  })
})

describe('rendering tools', () => {
  it('inspect_timeline returns grid-overlaid JPEG frames with visible clip ids', async () => {
    expect((await call(client, 'inspect_timeline')).text).toBe('Timeline is empty — nothing to render.')
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    const r = await call(client, 'inspect_timeline', { startFrame: 0, endFrame: 300, maxFrames: 3 })
    expect(r.images).toHaveLength(3)
    expect(r.images[0].mimeType).toBe('image/jpeg')
    expect(imageSize(Buffer.from(r.images[0].data, 'base64'))).toEqual({ width: 512, height: 288 })
    const clip = activeTimeline(h.session.doc).tracks[0].clips[0]
    expect(r.json).toEqual({
      fps: 30,
      width: 512,
      height: 288,
      totalFrames: 300,
      coordinateGrid: '0-1, origin top-left',
      frames: [50, 150, 250].map((frame) => ({ frame, clips: [clip.id.slice(0, 8)] })),
    })
    expect((await call(client, 'inspect_timeline', { startFrame: 400 })).text).toBe('startFrame 400 out of range [0, 300).')
  })

  it('capture_frame stores a full-resolution PNG asset', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    const r = await call(client, 'capture_frame', { timelineFrame: 12 })
    expect(r.json).toMatchObject({ status: 'ready', name: 'Frame 12', type: 'image', mimeType: 'image/png', width: 1920, height: 1080 })
    const asset = entries().find((e) => e.name === 'Frame 12')!
    expect(r.json.mediaRef).toBe(asset.id.slice(0, 8))
    expect((await call(client, 'capture_frame', { timelineFrame: 1, mediaRef: video.id })).text).toBe(
      'Provide exactly one capture mode: timelineFrame, or mediaRef with sourceSeconds.',
    )
    expect((await call(client, 'capture_frame', { mediaRef: still.id, sourceSeconds: 1 })).text).toBe(`Media asset ${still.id.slice(0, 8)} is not a video.`)
  })

  it('inspect_color measures a clip and reports the gap to a reference', async () => {
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    const clip = activeTimeline(h.session.doc).tracks[0].clips[0]
    const stillFile = path.join(TEST_ROOT, 'still.png')
    await fs.writeFile(stillFile, await makePng(16, 16, 'blue'))
    h.session.transact('relink', (d) => {
      d.manifest.entries.find((e) => e.id === still.id)!.source = { external: { absolutePath: stillFile } }
      d.manifest.entries.find((e) => e.id === video.id)!.source = { external: { absolutePath: stillFile } }
    })
    const r = await call(client, 'inspect_color', { clipId: clip.id, reference: still.id })
    expect(r.images).toHaveLength(2)
    expect(r.json.clip.balance.warmCool).toBeGreaterThan(0.9)
    expect(r.json.gap.hints).toContain("warmer than ref → cooler 'temperature'")
    expect((await call(client, 'inspect_color', {})).text).toBe('Provide either clipId (measures the graded clip) or mediaRef (measures the raw asset).')
  })
})

describe('export', () => {
  it('export_project queues into Downloads with unique names; manage_exports lists and cancels', async () => {
    expect((await call(client, 'export_project')).text).toBe('export_project: timeline is empty')
    await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
    const first = await call(client, 'export_project', { codec: 'h-265', resolution: '720p' })
    const downloads = process.env.XDG_DOWNLOAD_DIR!
    expect(first.json).toMatchObject({ status: 'started', queuePosition: 0, mode: 'video', format: 'H.265', durationFrames: 300, durationSeconds: 10, fps: 30 })
    expect(first.json.path).toBe(path.join(downloads, `${h.session.name}.mp4`))
    expect(h.exports[0].options).toMatchObject({ format: 'mp4', codec: 'hevc', width: 1280, height: 720 })
    const second = await call(client, 'export_project', { mode: 'palmier' })
    expect(second.json).toMatchObject({ status: 'queued', queuePosition: 1, mode: 'palmier' })
    const third = await call(client, 'export_project')
    expect(third.json.path).toBe(path.join(downloads, `${h.session.name} 2.mp4`))
    const listed = (await call(client, 'manage_exports', { action: 'list' })).json.exports
    expect(listed.map((r: { status: string }) => r.status)).toEqual(['queued', 'queued', 'preparing'])
    const cancel = await call(client, 'manage_exports', { action: 'cancel', jobId: second.json.jobId })
    expect(cancel.json).toMatchObject({ status: 'removed', cancellationRequested: true })
    expect((await call(client, 'export_project', { mode: 'xml', codec: 'H.264' })).text).toBe('export_project: codec only applies to video mode')
    expect((await call(client, 'export_project', { outputPath: 'relative.mp4' })).text).toBe('export_project: outputPath must be absolute')
    expect((await call(client, 'export_project', { outputPath: '/tmp/out.mov' })).text).toBe('export_project: H.264 exports must use .mp4')
    expect((await call(client, 'manage_exports', { action: 'cancel', jobId: 'nope' })).text).toBe('manage_exports: cancel requires a valid jobId')
  })
})
