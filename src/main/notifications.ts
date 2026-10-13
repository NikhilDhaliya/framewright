/**
 * Desktop notifications (Mac `App/AppNotifications.swift`; spec 05 §11.3, 06 §B4.5, 07 §8.1): generation complete,
 * export complete/failed. Gated by Settings ▸ General ▸ Show notifications (`notificationsEnabled`, default on).
 * As on the Mac (`willPresent` → banner), notifications also show while the app is in front. Export notifications are
 * posted only for agent exports (MCP / in-app agent `export_project`, `ExportQueue.swift:283`); UI exports show
 * their own progress. Linux: Electron `Notification` (libnotify).
 */
import path from 'node:path'
import { Notification, shell } from 'electron'
import type { MediaManifestEntry } from '../core/model'
import type { ExportJob } from '../shared/api'
import type { ProjectSession } from './project/session'
import { tm, tmx } from './i18n'

export interface NotificationRequest {
  title: string
  body: string
  /** Window to focus on click; absent = no focus change. */
  session?: ProjectSession
  onClick?: () => void
}

export interface NotifierDeps {
  enabled(): boolean
  /** Brings `session`'s window to the front. */
  focus(session: ProjectSession): void
  /** Asks the renderer to reveal an asset (media panel). */
  revealAsset(session: ProjectSession, assetId: string): void
  /** Test hook: replaces the Electron Notification. */
  post?(req: NotificationRequest): void
}

export interface NotificationRecord {
  title: string
  body: string
  shown: boolean
  reason?: 'disabled' | 'unsupported'
}

let deps: NotifierDeps | null = null
/** Recent requests (newest last), for diagnostics and headless checks (`globalThis.__palmierNotifications`). */
export const recentNotifications: NotificationRecord[] = []
;(globalThis as { __palmierNotifications?: NotificationRecord[] }).__palmierNotifications = recentNotifications

interface WatchedExport {
  session: ProjectSession
  /** Output size of video exports, shown as ` (W×H)`. */
  size?: { width: number; height: number }
  /** Warnings known at enqueue time (nested-timeline skips), added to the job's own. */
  warnings: number
}

const exportWatch = new Map<string, WatchedExport>()

export function configureNotifications(d: NotifierDeps | null): void {
  deps = d
  exportWatch.clear()
  recentNotifications.length = 0
}

function record(r: NotificationRecord): void {
  recentNotifications.push(r)
  if (recentNotifications.length > 20) recentNotifications.shift()
}

/** Posts a notification unless Show notifications is off. Returns whether it was posted. */
export function notify(req: NotificationRequest): boolean {
  if (!deps) return false
  const base = { title: req.title, body: req.body }
  if (!deps.enabled()) return record({ ...base, shown: false, reason: 'disabled' }), false
  const d = deps
  const click = () => {
    if (req.session && !req.session.closed) d.focus(req.session)
    req.onClick?.()
  }
  if (d.post) {
    d.post({ ...req, onClick: click })
    record({ ...base, shown: true })
    return true
  }
  if (!Notification.isSupported()) return record({ ...base, shown: false, reason: 'unsupported' }), false
  const n = new Notification({ title: req.title, body: req.body })
  n.on('click', click)
  n.show()
  record({ ...base, shown: true })
  return true
}

// ---------- Generation ----------

/** "Generation complete" with the `readyMessage` body; click focuses the project and reveals the (first) asset. */
export function notifyGenerationComplete(session: ProjectSession, assets: MediaManifestEntry[], body: string): void {
  if (!assets.length) return
  const first = assets[0].id
  notify({ title: tm('Generation complete'), body: tmx(body), session, onClick: () => deps?.revealAsset(session, first) })
}

// ---------- Export ----------

/** Marks an agent export (`export_project`) so its completion/failure is announced (Mac: `source == .agent`). */
export function watchExport(jobId: string, session: ProjectSession, extra: { size?: { width: number; height: number }; warnings?: number } = {}): void {
  exportWatch.set(jobId, { session, size: extra.size, warnings: extra.warnings ?? 0 })
}

/** Texts of `AppNotifications.exportComplete` / `exportFailed`. */
export function exportNotification(job: ExportJob, extra: { size?: { width: number; height: number }; warnings?: number } = {}): { title: string; body: string } | null {
  const filename = path.basename(job.outputPath || job.options.outputPath).trim()
  if (job.status === 'completed') {
    let detail = filename || tm('Export')
    if (extra.size) detail += ` (${Math.trunc(extra.size.width)}×${Math.trunc(extra.size.height)})`
    const warnings = (job.warnings?.length ?? 0) + (extra.warnings ?? 0)
    const body = warnings === 1 ? tm('{0} exported with 1 warning.', detail) : warnings > 1 ? tm('{0} exported with {1} warnings.', detail, warnings) : tm('{0} is ready.', detail)
    return { title: tm('Export complete'), body }
  }
  if (job.status === 'failed') {
    const reason = tmx((job.error ?? tm('Export failed')).trim())
    return { title: tm('Export failed'), body: reason || tm('{0} could not be exported.', filename || tm('The export')) }
  }
  return null
}

/** Exporter `progress` listener: announces terminal states of watched jobs once; click on a finished export reveals the file. */
export function onExportProgress(job: ExportJob): void {
  if (job.status !== 'completed' && job.status !== 'failed' && job.status !== 'cancelled') return
  const watched = exportWatch.get(job.id)
  if (!watched) return
  exportWatch.delete(job.id)
  const text = exportNotification(job, watched)
  if (!text) return
  const out = job.outputPath
  notify({ ...text, onClick: job.status === 'completed' && out ? () => shell.showItemInFolder(out) : undefined })
}
