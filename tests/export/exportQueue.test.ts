// Export queue Remove / Clear Finished (Mac ExportQueue.remove / clearFinished) and HEVC 10-bit HDR option checks.
import { TEST_ROOT } from '../interchange/env'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultTextStyle, newClip, newTimeline, newTrack, type Timeline } from '../../src/core/model'
import { createExportService } from '../../src/main/export/exportService'
import { HLG_VF, isHdrCodec, videoCodecFor, videoEncoderArgs } from '../../src/main/export/encoders'
import { ProjectSession } from '../../src/main/project/session'
import type { HostRenderService } from '../../src/main/render/renderService'

const root = path.join(TEST_ROOT, 'queue')
let a: ProjectSession
let b: ProjectSession
let timeline: Timeline

beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true })
  timeline = newTimeline({
    tracks: [newTrack('video', { clips: [newClip({ mediaRef: '', mediaType: 'text', sourceClipType: 'text', startFrame: 0, durationFrames: 30, textContent: 'Hi', textStyle: defaultTextStyle() })] })],
  })
  const doc = { file: { timelines: [timeline], activeTimelineId: timeline.id, openTimelineIds: [timeline.id] }, manifest: { version: 2, entries: [], folders: [] } }
  a = await ProjectSession.create(path.join(root, 'A.palmier'), doc)
  b = await ProjectSession.create(path.join(root, 'B.palmier'), structuredClone(doc))
})

afterAll(() => {
  a?.removeAllListeners()
  b?.removeAllListeners()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('export queue remove / clear finished', () => {
  it('tags jobs with their project and removes only finished jobs', async () => {
    const service = createExportService({} as HostRenderService)
    const j1 = service.start(a, { timelineId: timeline.id, format: 'xml', outputPath: path.join(root, 'out', 'a1.xml') })
    const j2 = service.start(a, { timelineId: timeline.id, format: 'xml', outputPath: path.join(root, 'out', 'a2.xml') })
    expect(j1.projectPath).toBe(a.path)
    // Waiting jobs cannot be removed (the Mac's Remove from Queue cancels instead).
    expect(service.remove(j2.id)).toEqual([])
    expect(service.get(j2.id)).toBeDefined()
    await service.wait(j1.id)
    await service.wait(j2.id)
    expect(service.remove(j1.id)).toEqual([j1.id])
    expect(service.get(j1.id)).toBeUndefined()
    expect(service.remove(j1.id)).toEqual([])
    service.dispose()
  })

  it('clears finished jobs of one project only', async () => {
    const service = createExportService({} as HostRenderService)
    const ja = service.start(a, { timelineId: timeline.id, format: 'xml', outputPath: path.join(root, 'out', 'ca.xml') })
    const jb = service.start(b, { timelineId: timeline.id, format: 'xml', outputPath: path.join(root, 'out', 'cb.xml') })
    await service.wait(ja.id)
    await service.wait(jb.id)
    const queued = service.start(a, { timelineId: timeline.id, format: 'xml', outputPath: path.join(root, 'out', 'cq.xml') })
    expect(service.clearFinished(a.path)).toEqual([ja.id])
    expect(service.list().map((j) => j.id).sort()).toEqual([jb.id, queued.id].sort())
    await service.wait(queued.id)
    expect(service.clearFinished().sort()).toEqual([jb.id, queued.id].sort())
    expect(service.list()).toEqual([])
    service.dispose()
  })

  it('refuses HEVC 10-bit HDR outside QuickTime', () => {
    const service = createExportService({} as HostRenderService)
    expect(() => service.start(a, { timelineId: timeline.id, format: 'mp4', codec: 'hevc-hdr', outputPath: path.join(root, 'out', 'h.mp4') })).toThrow(/QuickTime/)
    service.dispose()
  })
})

describe('HEVC 10-bit HDR (HLG) encoder args (04 §11.4)', () => {
  it('recognises the codec id only for .mov', () => {
    expect(isHdrCodec('hevc-hdr')).toBe(true)
    expect(isHdrCodec('HEVC 10-bit HDR')).toBe(true)
    expect(isHdrCodec('hevc')).toBe(false)
    expect(videoCodecFor('mov', 'hevc-hdr')).toBe('hevc_hdr')
    expect(videoCodecFor('mp4', 'hevc-hdr')).toBeNull()
  })

  it('builds the Main10 HLG recipe with BT.2020 tags, AAC 48 kHz and no faststart', () => {
    const args = videoEncoderArgs({ format: 'mov', codec: 'hevc-hdr', width: 1920, height: 1080, fps: 30, quality: 'high', audioPath: '/tmp/mix.wav', output: '/tmp/o.mov' })
    const s = args.join(' ')
    expect(args[args.indexOf('-vf') + 1]).toBe(HLG_VF)
    expect(HLG_VF).toContain('t=arib-std-b67:p=bt2020:m=bt2020nc:r=limited:npl=203,format=yuv420p10le')
    expect(s).toContain('-c:v libx265')
    expect(s).toContain('-profile:v main10')
    expect(s).toContain('-tag:v hvc1')
    expect(args[args.indexOf('-x265-params') + 1]).toMatch(/^vbv-maxrate=11197:vbv-bufsize=14930:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited/)
    expect(s).toContain('-color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc -color_range tv')
    expect(args.filter((x, i) => args[i - 1] !== '-vf').join(' ')).not.toContain('bt709')
    expect(s).toContain('-c:a aac -b:a 192k -ar 48000 -ac 2')
    expect(s).not.toContain('faststart')
    expect(args.slice(-3)).toEqual(['-f', 'mov', '/tmp/o.mov'])
  })
})
