import './env'
import { afterEach, describe, expect, it } from 'vitest'
import type { MediaManifestEntry } from '../../src/core/model'
import { readyMessage } from '../../src/main/generation/service'
import { configureNotifications, exportNotification, notifyGenerationComplete, onExportProgress, recentNotifications, watchExport, type NotificationRequest } from '../../src/main/notifications'
import type { ProjectSession } from '../../src/main/project/session'
import type { ExportJob } from '../../src/shared/api'

const session = { closed: false } as ProjectSession

function setup(opts: { enabled?: boolean } = {}) {
  const posted: NotificationRequest[] = []
  const focused: ProjectSession[] = []
  const revealed: string[] = []
  configureNotifications({
    enabled: () => opts.enabled ?? true,
    focus: (s) => void focused.push(s),
    revealAsset: (_s, id) => void revealed.push(id),
    post: (r) => void posted.push(r),
  })
  return { posted, focused, revealed }
}

const job = (patch: Partial<ExportJob>): ExportJob => ({
  id: 'j1',
  options: { timelineId: 't', format: 'mp4', outputPath: '/out/My Cut.mp4' },
  status: 'running',
  progress: 0,
  framesRendered: 0,
  totalFrames: 10,
  startedAt: '',
  outputPath: '/out/My Cut.mp4',
  ...patch,
})

const asset = (id: string, name: string, type = 'video') => ({ id, name, type }) as unknown as MediaManifestEntry

afterEach(() => configureNotifications(null))

describe('notifications', () => {
  it('generation complete: title, readyMessage body, click focuses and reveals the asset', () => {
    const t = setup()
    const assets = [asset('a1', 'Sunset'), asset('a2', 'Beach')]
    notifyGenerationComplete(session, assets, readyMessage(assets))
    expect(t.posted).toHaveLength(1)
    expect(t.posted[0]).toMatchObject({ title: 'Generation complete', body: '2 videos are ready in Framewright.' })
    t.posted[0].onClick?.()
    expect(t.focused).toEqual([session])
    expect(t.revealed).toEqual(['a1'])
  })

  it('respects the Show notifications toggle (and shows while the app is in front, like the Mac)', () => {
    let t = setup({ enabled: false })
    notifyGenerationComplete(session, [asset('a', 'X')], 'X is ready.')
    expect(t.posted).toEqual([])
    expect(recentNotifications.at(-1)).toMatchObject({ shown: false, reason: 'disabled' })
    t = setup()
    notifyGenerationComplete(session, [asset('a', 'X')], 'X is ready.')
    expect(t.posted).toHaveLength(1)
  })

  it('announces watched (agent) exports once on completion or failure, never cancellations or other jobs', () => {
    const t = setup()
    onExportProgress(job({ id: 'ui', status: 'completed' }))
    watchExport('j1', session, { size: { width: 1920, height: 1080 } })
    onExportProgress(job({ status: 'running', progress: 0.5 }))
    expect(t.posted).toEqual([])
    onExportProgress(job({ status: 'completed' }))
    onExportProgress(job({ status: 'completed' }))
    expect(t.posted.map((p) => [p.title, p.body])).toEqual([['Export complete', 'My Cut.mp4 (1920×1080) is ready.']])
    watchExport('j2', session)
    onExportProgress(job({ id: 'j2', status: 'failed', error: ' ffmpeg exited with code 1 ' }))
    expect(t.posted[1]).toMatchObject({ title: 'Export failed', body: 'ffmpeg exited with code 1' })
    watchExport('j3', session)
    onExportProgress(job({ id: 'j3', status: 'cancelled' }))
    expect(t.posted).toHaveLength(2)
  })

  it('formats export texts (AppNotifications.exportComplete / exportFailed)', () => {
    expect(exportNotification(job({ status: 'completed', warnings: ['a'] }))).toEqual({ title: 'Export complete', body: 'My Cut.mp4 exported with 1 warning.' })
    expect(exportNotification(job({ status: 'completed', warnings: ['a'] }), { warnings: 2 })?.body).toBe('My Cut.mp4 exported with 3 warnings.')
    expect(exportNotification(job({ status: 'failed' }))).toEqual({ title: 'Export failed', body: 'Export failed' })
    expect(exportNotification(job({ status: 'failed', error: '  ' }))?.body).toBe('My Cut.mp4 could not be exported.')
    expect(exportNotification(job({ status: 'queued' }))).toBeNull()
  })
})
