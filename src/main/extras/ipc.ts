/** `extras:*` IPC (spec 07 §6.3–6.5): save as media/audio, extract audio, save range, capture frame, mattes. */
import { ipcMain, type WebContents } from 'electron'
import { MATTE_ASPECTS, type ExtrasResult, type FrameCaptureSource, type MatteAspect } from '../../shared/extras'
import type { ProjectSession } from '../project/session'
import type { AppContext } from '../services'
import { captureFrameToMedia } from './captureFrame'
import { createMatte } from './matte'
import { extractAudio, saveClipAsAudio, saveClipAsMedia, saveRangeAsMedia } from './saveAsMedia'

export interface ExtrasIpcDeps {
  app: AppContext
  sessionFor(sender: WebContents): ProjectSession | null
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isStr = (v: unknown): v is string => typeof v === 'string'
const log = (what: string) => (e: unknown) => console.error(`${what} failed:`, e)

/** One capture at a time per editor (`frameCaptureTask`). */
const capturing = new WeakSet<ProjectSession>()

export function registerExtrasIpc(d: ExtrasIpcDeps): void {
  const deps = { app: d.app }
  // The placeholder appears immediately; rendering continues in the background (the Mac returns at once too).
  const background = (e: Electron.IpcMainInvokeEvent, run: (s: ProjectSession) => Promise<unknown>): ExtrasResult => {
    const session = d.sessionFor(e.sender)
    if (!session) return { ok: false, error: 'No project is open.' }
    void run(session).catch(log('extras'))
    return { ok: true }
  }
  ipcMain.handle('extras:saveClipAsMedia', (e, clipId: unknown) => (isStr(clipId) ? background(e, (s) => saveClipAsMedia(deps, s, clipId)) : { ok: false, error: 'Invalid clip.' }))
  ipcMain.handle('extras:saveClipAsAudio', (e, clipId: unknown) => (isStr(clipId) ? background(e, (s) => saveClipAsAudio(deps, s, clipId)) : { ok: false, error: 'Invalid clip.' }))
  ipcMain.handle('extras:extractAudio', (e, ids: unknown) =>
    Array.isArray(ids) && ids.every(isStr) ? background(e, (s) => extractAudio(deps, s, ids)) : { ok: false, error: 'Invalid media.' },
  )
  ipcMain.handle('extras:saveRangeAsMedia', (e, range: unknown) => {
    const r = range as { start?: unknown; end?: unknown } | null
    if (!r || typeof r.start !== 'number' || typeof r.end !== 'number') return { ok: false, error: 'Invalid range.' }
    return background(e, (s) => saveRangeAsMedia(deps, s, { start: r.start as number, end: r.end as number }))
  })
  ipcMain.handle('extras:captureFrame', async (e, source: FrameCaptureSource, folderId: unknown): Promise<ExtrasResult<{ name: string; folderRemoved: boolean }>> => {
    const session = d.sessionFor(e.sender)
    if (!session) return { ok: false, error: 'No project is open.' }
    if (capturing.has(session)) return { ok: false, error: '' }
    const valid =
      source && typeof source === 'object' && ((source.kind === 'timeline' && typeof source.frame === 'number') || (source.kind === 'media' && isStr(source.mediaRef) && typeof source.sourceSeconds === 'number'))
    if (!valid) return { ok: false, error: 'Invalid capture source.' }
    capturing.add(session)
    try {
      const r = await captureFrameToMedia(d.app, session, source, { folderId: isStr(folderId) ? folderId : null })
      return { ok: true, name: r.asset.name, folderRemoved: r.destinationFolderWasRemoved }
    } catch (err) {
      return { ok: false, error: message(err) }
    } finally {
      capturing.delete(session)
    }
  })
  // Index ▸ Markers row thumbnails (Mac `timelineThumbnail`): one composited frame of a timeline, JPEG, null on failure.
  ipcMain.handle('extras:timelineThumbnail', async (e, timelineId: unknown, frame: unknown, width: unknown): Promise<Uint8Array | null> => {
    const session = d.sessionFor(e.sender)
    if (!session || !isStr(timelineId) || typeof frame !== 'number' || !Number.isFinite(frame) || frame < 0) return null
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.min(1024, Math.max(16, Math.round(width))) : 160
    try {
      const bytes = await d.app.render.captureFrame(session, { timelineId, frame: Math.trunc(frame), width: w, format: 'jpeg', quality: 0.8 })
      return new Uint8Array(bytes)
    } catch {
      return null
    }
  })
  ipcMain.handle('extras:createMatte', async (e, req: { hex?: unknown; aspect?: unknown; folderId?: unknown }): Promise<ExtrasResult<{ id: string }>> => {
    const session = d.sessionFor(e.sender)
    try {
      if (!req || !isStr(req.hex)) throw new Error("Couldn't render matte image.")
      const aspect = (MATTE_ASPECTS as readonly unknown[]).includes(req.aspect) ? (req.aspect as MatteAspect) : 'Project'
      const entry = await createMatte(session, { hex: req.hex, aspect, folderId: isStr(req.folderId) ? req.folderId : null })
      return { ok: true, id: entry.id }
    } catch (err) {
      return { ok: false, error: message(err) }
    }
  })
}
