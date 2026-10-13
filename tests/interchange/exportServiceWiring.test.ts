// ExportService routes xml/fcpxml jobs to the interchange exporter (no render host involved).
import { TEST_ROOT } from './env'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultTextStyle, newClip, newTimeline, newTrack, type Timeline } from '../../src/core/model'
import { createExportService } from '../../src/main/export/exportService'
import { ProjectSession } from '../../src/main/project/session'
import type { HostRenderService } from '../../src/main/render/renderService'
import { assertWellFormed } from './wellFormed'

const root = path.join(TEST_ROOT, 'wiring')
let session: ProjectSession
let timeline: Timeline

beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true })
  timeline = newTimeline({
    name: 'Wired',
    tracks: [
      newTrack('video', {
        clips: [newClip({ mediaRef: '', mediaType: 'text', sourceClipType: 'text', startFrame: 0, durationFrames: 30, textContent: 'Hello', textStyle: defaultTextStyle() })],
      }),
    ],
  })
  session = await ProjectSession.create(path.join(root, 'Wired.palmier'), {
    file: { timelines: [timeline], activeTimelineId: timeline.id, openTimelineIds: [timeline.id] },
    manifest: { version: 2, entries: [], folders: [] },
  })
})

afterAll(() => {
  session?.removeAllListeners()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('ExportService interchange formats', () => {
  const service = createExportService({} as HostRenderService)

  it('exports XMEML through a regular export job', async () => {
    const out = path.join(root, 'out', 'Wired.xml')
    const job = service.start(session, { timelineId: timeline.id, format: 'xml', outputPath: out })
    const done = await service.wait(job.id)
    expect(done.status).toBe('completed')
    const xml = fs.readFileSync(out, 'utf8')
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>')).toBe(true)
    assertWellFormed(xml)
  })

  it('passes the FCPXML version and target through', async () => {
    const out = path.join(root, 'out', 'Wired.fcpxml')
    const job = service.start(session, { timelineId: timeline.id, format: 'fcpxml', outputPath: out, fcpxmlVersion: '1.12', fcpxmlTarget: 'fcp' })
    const done = await service.wait(job.id)
    expect(done.status).toBe('completed')
    const xml = fs.readFileSync(out, 'utf8')
    expect(xml).toContain('<fcpxml version="1.12">')
    expect(xml).toContain('<title ref="titleBasic" name="Hello"')
    assertWellFormed(xml)
  })
})
