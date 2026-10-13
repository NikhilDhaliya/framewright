// Project Activity rows (06 §B11 Linux plan) and the title bar export label (05 §2.2).
import { describe, expect, it } from 'vitest'
import type { MediaManifestEntry } from '../../src/core/model'
import { activityEntries, relativeTime } from '../../src/renderer/editor/projectActivityModel'
import { exportButtonLabel, exportCounts, upsertJob } from '../../src/renderer/dialogs/exportJobs'
import type { ExportJob } from '../../src/shared/api'

const REF = 978307200
const entry = (id: string, p: Partial<MediaManifestEntry>): MediaManifestEntry => ({ id, name: `${id}.mp4`, type: 'video', source: { project: { relativePath: `media/${id}.mp4` } }, duration: 5, ...p })
const gen = (model: string, unixSec: number, extra: Record<string, unknown> = {}) => ({ prompt: 'p', model, duration: 5, aspectRatio: '16:9', createdAt: unixSec - REF, ...extra })

describe('project activity', () => {
  it('lists generated assets newest first with kind icon, model name and status', () => {
    const rows = activityEntries([
      entry('imported', {}),
      entry('old', { generationInput: gen('unknown-model', 1000) }),
      entry('failed', { generationInput: gen('unknown-model', 3000), generationStatus: 'failed: Out of quota' }),
      entry('busy', { generationInput: gen('unknown-model', 2000), generationStatus: 'generating' }),
      entry('nodate', { generationInput: { prompt: 'p', model: '', duration: 1, aspectRatio: '' } }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['failed', 'busy', 'old', 'nodate'])
    expect(rows[0]).toMatchObject({ state: 'failed', status: 'Failed', error: 'Out of quota', icon: 'sparkles', createdAt: 3000_000 })
    expect(rows[1]).toMatchObject({ state: 'inFlight', status: 'Generating…' })
    expect(rows[2]).toMatchObject({ state: 'ready', status: '', model: 'unknown-model' })
    expect(rows[3]).toMatchObject({ createdAt: null, model: 'nodate.mp4' })
  })

  it('uses the catalog for display names and type icons', async () => {
    const { modelSet } = await import('../../src/core/generation/models')
    const set = modelSet(() => false)
    const kinds = { video: 'video.fill', image: 'photo.fill', audio: 'music.note', upscale: 'arrow.up.right.square.fill' } as const
    for (const kind of Object.keys(kinds) as (keyof typeof kinds)[]) {
      const m = set[kind][0]
      expect(m).toBeDefined()
      const [row] = activityEntries([entry('x', { generationInput: gen(m.id, 1) })], set)
      expect(row.icon).toBe(kinds[kind])
      expect(row.model).toBe(m.displayName)
    }
  })

  it('formats abbreviated relative times', () => {
    const now = Date.UTC(2026, 9, 14, 12)
    expect(relativeTime(now - 5 * 60_000, now, 'en-US')).toBe('5 min. ago')
    expect(relativeTime(now - 3 * 3600_000, now, 'en-US')).toBe('3 hr. ago')
    expect(relativeTime(now - 2_000, now, 'en-US')).toBe('2 sec. ago')
  })
})

describe('title bar export label', () => {
  const job = (id: string, status: ExportJob['status'], startedAt: string): ExportJob => ({ id, status, startedAt, options: { timelineId: 't', format: 'mp4', outputPath: '/x' }, progress: 0, framesRendered: 0, totalFrames: 0, outputPath: `/x/${id}` })
  it('counts running and waiting jobs', () => {
    const jobs = [job('a', 'running', '1'), job('b', 'queued', '2'), job('c', 'queued', '3'), job('d', 'completed', '0')]
    expect(exportCounts(jobs)).toEqual({ active: 1, waiting: 2 })
    expect(exportButtonLabel(exportCounts(jobs))).toBe('Export, 1 active, 2 waiting')
    expect(exportButtonLabel({ active: 0, waiting: 0 })).toBe('Export')
  })
  it('upserts in enqueue order', () => {
    let list: ExportJob[] = []
    list = upsertJob(list, job('b', 'queued', '2026-01-02'))
    list = upsertJob(list, job('a', 'running', '2026-01-01'))
    list = upsertJob(list, job('b', 'running', '2026-01-02'))
    expect(list.map((j) => `${j.id}:${j.status}`)).toEqual(['a:running', 'b:running'])
  })
})
