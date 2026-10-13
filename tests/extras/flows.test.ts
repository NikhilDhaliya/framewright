import { TEST_ROOT } from './env'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { emptyManifest, newClip, newProjectFile, newTrack, type MediaManifestEntry } from '../../src/core/model'
import { readPackage } from '../../src/main/project/packageIO'
import { ProjectSession } from '../../src/main/project/session'
import { ffmpeg } from '../../src/main/media/ffmpeg'
import { probeFile } from '../../src/main/media/probe'
import { captureFrameToMedia, pngSize } from '../../src/main/extras/captureFrame'
import { createMatte } from '../../src/main/extras/matte'
import { extractAudio, saveClipAsAudio, saveClipAsMedia, saveRangeAsMedia, type ExtrasDeps } from '../../src/main/extras/saveAsMedia'
import type { ExportJob, ExportOptions } from '../../src/shared/api'

let session: ProjectSession
let video: MediaManifestEntry
let audioOnly: MediaManifestEntry
const exports: ExportOptions[] = []

// Real probe; a fake exporter that renders the range with ffmpeg (the real one needs the Electron render host).
const deps: ExtrasDeps = {
  app: {
    media: { probe: probeFile } as unknown as ExtrasDeps['app']['media'],
    exporter: {
      start(_s: unknown, options: ExportOptions) {
        exports.push(options)
        const job: ExportJob = { id: 'job', options, status: 'running', progress: 0, framesRendered: 0, totalFrames: 0, startedAt: '', outputPath: options.outputPath }
        const frames = options.range!.end - options.range!.start
        pending = ffmpeg(['-y', '-f', 'lavfi', '-i', `testsrc=s=640x360:r=30:d=${frames / 30}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', options.outputPath]).then(() => ({ ...job, status: 'completed' as const }))
        return job
      },
      wait: () => pending,
    } as unknown as ExtrasDeps['app']['exporter'],
  },
}
let pending: Promise<ExportJob>

const entries = () => session.doc.manifest.entries
const byName = (n: string) => entries().find((e) => e.name === n)

beforeAll(async () => {
  const src = path.join(TEST_ROOT, 'src')
  await fs.mkdir(src, { recursive: true })
  const v = path.join(src, 'talk.mov')
  const a = path.join(src, 'music.wav')
  // 4 s, 30 fps, 320×240 + 44.1 kHz PCM stereo audio (so Extract Audio re-encodes).
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=4', '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-shortest', v])
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=3', a])
  const file = newProjectFile()
  const t = file.timelines[0]
  t.fps = 30
  t.width = 640
  t.height = 360
  video = { id: 'VID00000-0000-0000-0000-000000000001', name: 'Talk', type: 'video', source: { external: { absolutePath: v } }, duration: 4, hasAudio: true, sourceWidth: 320, sourceHeight: 240, sourceFPS: 30, folderId: 'F1' }
  audioOnly = { id: 'AUD00000-0000-0000-0000-000000000001', name: 'Music', type: 'audio', source: { external: { absolutePath: a } }, duration: 3, hasAudio: true }
  t.tracks = [newTrack('video'), newTrack('audio')]
  // 2 s from 0.5 s at 2× → 1 s on the timeline (frames 0..30).
  t.tracks[0].clips.push(newClip({ id: 'CLIPV', mediaRef: video.id, startFrame: 0, durationFrames: 30, trimStartFrame: 15, trimEndFrame: 45, speed: 2 }))
  t.tracks[1].clips.push(newClip({ id: 'CLIPA', mediaRef: audioOnly.id, mediaType: 'audio', sourceClipType: 'audio', startFrame: 0, durationFrames: 45, trimStartFrame: 15 }))
  const manifest = emptyManifest()
  manifest.folders.push({ id: 'F1', name: 'Footage' })
  manifest.entries.push(video, audioOnly)
  session = await ProjectSession.create(path.join(TEST_ROOT, 'Extras.palmier'), { file, manifest })
}, 60_000)

afterAll(async () => {
  await session.close()
})

async function stagedLeftovers(): Promise<string[]> {
  return (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith('framewright-stage-'))
}

describe('save as media / extract audio (07 §6.3)', () => {
  it('Save as Media bakes trim + speed into media/clip-XXXXXXXX.mp4 with no undo entry', async () => {
    const undoBefore = session.snapshot().undoLabel
    const job = saveClipAsMedia(deps, session, 'CLIPV')
    const placeholder = byName('Talk (clip)')!
    expect(placeholder).toMatchObject({ type: 'video', generationStatus: 'generating' })
    expect(placeholder.folderId).toBeUndefined()
    const id = await job
    expect(id).toBe(placeholder.id)
    const e = byName('Talk (clip)')!
    expect(e.generationStatus).toBeUndefined()
    expect('project' in e.source && e.source.project.relativePath).toMatch(/^media\/clip-[0-9A-F]{8}\.mp4$/)
    const file = session.resolveMedia(e)!
    const p = await probeFile(file)
    expect(p).toMatchObject({ type: 'video', hasAudio: true, videoCodec: 'h264', audioCodec: 'aac', width: 320, height: 240 })
    expect(p.duration).toBeGreaterThan(0.9)
    expect(p.duration).toBeLessThan(1.15)
    expect(e.duration).toBeCloseTo(p.duration, 3)
    expect(e).toMatchObject({ sourceWidth: 320, sourceHeight: 240, hasAudio: true })
    expect(session.snapshot().undoLabel).toBe(undoBefore)
    expect(await stagedLeftovers()).toEqual([])
  }, 60_000)

  it('Save as Audio on a video clip: m4a in the source folder; Save as Media on an audio clip', async () => {
    await saveClipAsAudio(deps, session, 'CLIPV')
    const e = byName('Talk (audio)')!
    expect(e).toMatchObject({ type: 'audio', folderId: 'F1', hasAudio: true })
    expect('project' in e.source && e.source.project.relativePath).toMatch(/^media\/clip-[0-9A-F]{8}\.m4a$/)
    const p = await probeFile(session.resolveMedia(e)!)
    expect(p).toMatchObject({ type: 'audio', audioCodec: 'aac', hasVideo: false })
    expect(p.duration).toBeGreaterThan(0.9)
    expect(p.duration).toBeLessThan(1.15)
    await saveClipAsMedia(deps, session, 'CLIPA')
    const m = byName('Music (clip)')!
    expect(m.type).toBe('audio')
    const pm = await probeFile(session.resolveMedia(m)!)
    expect(pm.duration).toBeGreaterThan(1.4)
    expect(pm.duration).toBeLessThan(1.6)
  }, 60_000)

  it('Extract Audio: whole file next to the asset; ineligible assets are skipped', async () => {
    const ids = await extractAudio(deps, session, [video.id, audioOnly.id])
    expect(ids).toHaveLength(1)
    const e = entries().find((x) => x.id === ids[0])!
    expect(e).toMatchObject({ name: 'Talk (audio)', type: 'audio', folderId: 'F1' })
    const p = await probeFile(session.resolveMedia(e)!)
    expect(p.audioCodec).toBe('aac')
    expect(p.duration).toBeGreaterThan(3.9)
  }, 60_000)

  it('Save Range as Media goes through the export pipeline at canvas size, H.264 CRF 18 ("high")', async () => {
    const job = saveRangeAsMedia(deps, session, { start: 30, end: 0 })
    expect(byName('Timeline range')?.generationStatus).toBe('rendering')
    await job
    expect(exports.at(-1)).toMatchObject({ format: 'mp4', codec: 'h264', quality: 'high', range: { start: 0, end: 30 } })
    expect(exports.at(-1)!.width).toBeUndefined()
    const e = byName('Timeline range')!
    expect(e.generationStatus).toBeUndefined()
    expect((await probeFile(session.resolveMedia(e)!)).width).toBe(640)
    expect(await saveRangeAsMedia(deps, session, { start: 10, end: 10 })).toBeNull()
  }, 60_000)

  it('a failing render marks the placeholder failed and is persisted', async () => {
    const broken = { ...video, id: 'BROKEN00-0000-0000-0000-000000000001', name: 'Broken', source: { external: { absolutePath: path.join(TEST_ROOT, 'src', 'talk.mov') } } }
    session.transact('add', (d) => {
      d.manifest.entries.push(broken)
      d.file.timelines[0].tracks[0].clips.push(newClip({ id: 'CLIPB', mediaRef: broken.id, startFrame: 100, durationFrames: 30, trimStartFrame: 0 }))
    })
    await fs.copyFile(path.join(TEST_ROOT, 'src', 'music.wav'), path.join(TEST_ROOT, 'src', 'noVideo.mov'))
    session.transact('relink', (d) => {
      d.manifest.entries.find((x) => x.id === broken.id)!.source = { external: { absolutePath: path.join(TEST_ROOT, 'src', 'noVideo.mov') } }
    })
    await saveClipAsMedia(deps, session, 'CLIPB')
    expect(byName('Broken (clip)')?.generationStatus).toBe('failed: no video track in source')
    await session.save()
    const pkg = await readPackage(session.path)
    expect(pkg.manifest.entries.find((x) => x.name === 'Broken (clip)')?.generationStatus).toBe('failed: no video track in source')
    expect(pkg.manifest.entries.filter((x) => x.name.endsWith('(clip)') || x.name.endsWith('(audio)') || x.name === 'Timeline range')).toHaveLength(6)
    expect(await stagedLeftovers()).toEqual([])
  }, 60_000)
})

describe('capture frame + mattes (07 §6.4–6.5)', () => {
  it('media capture: PNG at the requested time, last frame at the duration, undo "Capture Frame"', async () => {
    const app = { render: { captureFrame: async () => Buffer.alloc(0) } } as unknown as Parameters<typeof captureFrameToMedia>[0]
    const r = await captureFrameToMedia(app, session, { kind: 'media', mediaRef: video.id, sourceSeconds: 1 }, { folderId: 'F1' })
    expect(r.asset).toMatchObject({ name: 'Talk frame', type: 'image', duration: 5, sourceWidth: 320, sourceHeight: 240, folderId: 'F1' })
    expect(r.actualSourceSeconds).toBeCloseTo(1, 3)
    expect(session.snapshot().undoLabel).toBe('Capture Frame')
    expect('project' in r.asset.source && r.asset.source.project.relativePath).toMatch(/^media\/frame-[0-9A-F]{8}\.png$/)
    expect(pngSize(await fs.readFile(session.resolveMedia(r.asset)!))).toEqual({ width: 320, height: 240 })
    const last = await captureFrameToMedia(app, session, { kind: 'media', mediaRef: video.id, sourceSeconds: 4 }, { name: 'End' })
    expect(last.asset.name).toBe('End')
    expect(last.actualSourceSeconds).toBeCloseTo(4 - 1 / 30, 3)
    await expect(captureFrameToMedia(app, session, { kind: 'media', mediaRef: video.id, sourceSeconds: 4.5 })).rejects.toThrow('Source time 4.500s is outside 0…4.000s.')
    await expect(captureFrameToMedia(app, session, { kind: 'media', mediaRef: audioOnly.id, sourceSeconds: 1 })).rejects.toThrow(`Media asset ${audioOnly.id} is not a video.`)
    await expect(captureFrameToMedia(app, session, { kind: 'media', mediaRef: 'nope', sourceSeconds: 1 })).rejects.toThrow('Media asset not found: nope')
    await expect(captureFrameToMedia(app, session, { kind: 'timeline', frame: 9999 })).rejects.toThrow(/^Timeline frame 9999 is outside 0\.\.<\d+\.$/)
    await expect(captureFrameToMedia(app, session, { kind: 'timeline', frame: 0 }, { folderId: 'GONE' })).rejects.toThrow('The destination media folder no longer exists.')
    await expect(captureFrameToMedia(app, null, { kind: 'timeline', frame: 0 })).rejects.toThrow('No project is open.')
    expect(session.undo()).toBe('Capture Frame')
    expect(entries().some((e) => e.name === 'End')).toBe(false)
  }, 60_000)

  it('matte: PNG + name + folder, no undo entry', async () => {
    const undoBefore = session.snapshot().undoLabel
    const m = await createMatte(session, { hex: '#00FF00', aspect: '9:16', folderId: 'F1' })
    expect(m).toMatchObject({ name: 'Matte · 9:16', type: 'image', sourceWidth: 360, sourceHeight: 640, folderId: 'F1', duration: 5 })
    expect('project' in m.source && m.source.project.relativePath).toMatch(/^media\/matte-[0-9A-F]{8}\.png$/)
    const raw = await ffmpeg(['-i', session.resolveMedia(m)!, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'])
    expect([...raw.subarray(0, 4)]).toEqual([0, 255, 0, 255])
    expect(raw.length).toBe(360 * 640 * 4)
    const p = await createMatte(session, { hex: '#000000' })
    expect(p.name).toBe('Matte · 640×360')
    expect(session.snapshot().undoLabel).toBe(undoBefore)
    await expect(createMatte(null, { hex: '#000' })).rejects.toThrow('Open a project before creating a matte.')
    await expect(createMatte(session, { hex: 'nope' })).rejects.toThrow("Couldn't render matte image.")
  })
})
