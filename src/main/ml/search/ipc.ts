/** `search:*` IPC (spec 07 §2; 05 §4.10–4.11, §11.8). The renderer names assets; main resolves files. */
import { ipcMain, type BrowserWindow, type WebContents } from 'electron'
import { searchTranscripts } from '../../../core/captions/transcriptSearch'
import type { MomentHit, SpokenHit } from '../../../shared/search'
import { ffmpegPath, run } from '../../media/ffmpeg'
import type { ProjectSession } from '../../project/session'
import type { TranscriptionService } from '../transcribe/service'
import type { SearchService } from './service'

export interface SearchIpcDeps {
  search: SearchService
  transcription?: TranscriptionService
  sessionFor(sender: WebContents): ProjectSession | null
  windowFor(session: ProjectSession): BrowserWindow | null
  sessions(): ProjectSession[]
}

const MOMENT_THUMB_MAX = 240
const thumbCache = new Map<string, string | null>()

/** Source frame near `time` (keyframe seek, ±1 s like the Mac), fit within 240 px, as a JPEG data URL. */
async function momentFrame(file: string, time: number): Promise<string | null> {
  const key = `${file}|${time}`
  if (thumbCache.has(key)) return thumbCache.get(key)!
  let url: string | null = null
  try {
    const fit = `scale=w='min(${MOMENT_THUMB_MAX},iw)':h='min(${MOMENT_THUMB_MAX},ih)':force_original_aspect_ratio=decrease`
    const jpeg = await run(ffmpegPath, ['-nostdin', '-v', 'error', '-noaccurate_seek', '-ss', String(Math.max(0, time)), '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', fit, '-q:v', '4', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'])
    url = jpeg.length ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null
  } catch {
    url = null
  }
  if (thumbCache.size > 400) thumbCache.delete(thumbCache.keys().next().value!)
  thumbCache.set(key, url)
  return url
}

export function registerSearchIpc(d: SearchIpcDeps): void {
  const { search } = d
  const sessionOf = (wc: WebContents) => {
    const s = d.sessionFor(wc)
    if (s) search.coordinator(s)
    return s
  }

  // Status pushes, coalesced per window.
  const pending = new Map<ProjectSession | null, ReturnType<typeof setTimeout>>()
  const push = (session: ProjectSession) => {
    const win = d.windowFor(session)
    if (win && !win.isDestroyed()) win.webContents.send('search:status', search.status(session))
  }
  search.on('status', (session: ProjectSession | null) => {
    if (pending.has(session)) return
    pending.set(
      session,
      setTimeout(() => {
        pending.delete(session)
        if (session) push(session)
        else for (const s of d.sessions()) push(s)
      }, 100),
    )
  })

  ipcMain.handle('search:status', (e) => search.status(sessionOf(e.sender)))
  ipcMain.on('search:download', () => void search.download())
  ipcMain.handle('search:moments', async (e, query: unknown): Promise<MomentHit[]> => {
    const s = sessionOf(e.sender)
    if (!s || typeof query !== 'string') return []
    return search.search(s, query)
  })
  ipcMain.handle('search:spoken', async (e, query: unknown): Promise<SpokenHit[]> => {
    const s = d.sessionFor(e.sender)
    const stt = d.transcription
    if (!s || !stt || typeof query !== 'string' || !query.trim()) return []
    const candidates = s.doc.manifest.entries.filter((x) => x.type === 'video' || x.type === 'audio')
    const assets = await Promise.all(
      candidates.map(async (x) => {
        const file = s.resolveMedia(x)
        return { id: x.id, transcript: file ? await stt.cachedTranscript(file).catch(() => null) : null }
      }),
    )
    return searchTranscripts(query.trim(), assets).map((h) => ({ assetId: h.assetId, start: h.start, end: h.end, text: h.text }))
  })
  ipcMain.handle('search:frame', async (e, assetId: unknown, time: unknown) => {
    const s = d.sessionFor(e.sender)
    const file = s && typeof assetId === 'string' ? s.resolveMedia(assetId) : null
    if (!file) return null
    return momentFrame(file, typeof time === 'number' && Number.isFinite(time) ? time : 0)
  })
  ipcMain.handle('search:storage', () => search.storage())
  ipcMain.handle('search:clearCache', () => search.clearCache())
  ipcMain.handle('search:clearIndex', () => search.clearIndex())
  ipcMain.handle('search:removeSearchModel', () => search.removeSearchModel())
  ipcMain.handle('search:removeModel', (_e, id: unknown) => search.removeModel(String(id)))
  ipcMain.handle('search:setEnabled', (_e, enabled: unknown) => search.setEnabled(enabled !== false))
}
