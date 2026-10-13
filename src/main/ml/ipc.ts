/** `ml:*` IPC (spec 07 §0.3): the renderer names assets; main resolves files, runs jobs and streams progress. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { parseSubtitleBytes } from '../../core/captions/subtitleFileParser'
import { isCancellation } from '../../core/captions/transcript'
import type { ModelStateView, SpeechStatus, SubtitleCuesOutcome, TranscribeIpcRequest, TranscribeOutcome } from '../../shared/api'
import type { ProjectSession } from '../project/session'
import { manifestBytes, type ModelId } from './manifests'
import type { Ml } from './index'
import { resolveCloudProvider } from './transcribe/cloud'
import type { ModelState } from './models'

export interface MlIpcDeps {
  ml: Ml
  sessionFor(sender: WebContents): ProjectSession | null
  broadcast(channel: string, payload: unknown): void
  settings: () => Parameters<typeof resolveCloudProvider>[0]
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))
const isRange = (r: unknown): r is [number, number] => Array.isArray(r) && r.length === 2 && r.every((x) => typeof x === 'number' && Number.isFinite(x))

export function registerMlIpc(d: MlIpcDeps): void {
  const { ml } = d
  const fileFor = (e: IpcMainInvokeEvent, mediaRef: unknown): string | null => {
    const session = d.sessionFor(e.sender)
    return session && typeof mediaRef === 'string' ? session.resolveMedia(mediaRef) : null
  }

  ipcMain.handle('ml:transcribe', async (e, raw: TranscribeIpcRequest): Promise<TranscribeOutcome> => {
    const req = raw && typeof raw === 'object' ? raw : ({} as TranscribeIpcRequest)
    const jobId = typeof req.jobId === 'string' && req.jobId ? req.jobId : `job-${Date.now()}`
    const file = fileFor(e, req.mediaRef)
    if (!file) return { ok: false, error: 'The media file is unavailable.' }
    const sender = e.sender
    try {
      const result = await ml.jobs.run(jobId, (signal) =>
        ml.transcription.transcribe({
          file,
          isVideo: !!req.isVideo,
          range: isRange(req.range) ? req.range : null,
          provider: req.provider === 'cloud' ? 'cloud' : 'local',
          locale: typeof req.locale === 'string' && req.locale ? req.locale : undefined,
          censorProfanity: req.censorProfanity === true,
          signal,
          onProgress: (p) => {
            if (!sender.isDestroyed()) sender.send('ml:progress', { jobId, ...p })
          },
        }),
      )
      return { ok: true, result }
    } catch (err) {
      return isCancellation(err) ? { ok: false, error: 'Cancelled', cancelled: true } : { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.on('ml:cancel', (_e, jobId: unknown) => {
    if (typeof jobId === 'string') ml.jobs.cancel(jobId)
  })
  ipcMain.handle('ml:cachedTranscript', (e, mediaRef: unknown, range: unknown) => {
    const file = fileFor(e, mediaRef)
    return file ? ml.transcription.cachedTranscript(file, isRange(range) ? range : null) : null
  })
  ipcMain.handle('ml:cachedCloudTranscript', (e, mediaRef: unknown, range: unknown, language: unknown) => {
    const file = fileFor(e, mediaRef)
    return file ? ml.transcription.cachedCloudTranscript(file, isRange(range) ? range : null, typeof language === 'string' ? language : null) : null
  })
  ipcMain.handle('ml:speechStatus', (): SpeechStatus => {
    const cloud = resolveCloudProvider(d.settings())
    const id = ml.transcription.whisperModelId()
    return {
      cloudAvailable: !!cloud,
      cloudProvider: cloud?.provider.id ?? null,
      localModelId: id,
      localModelBytes: manifestBytes(ml.models.manifest(id)) + (ml.models.isInstalled('whisper-cli') ? 0 : manifestBytes(ml.models.manifest('whisper-cli'))),
      localModelInstalled: ml.models.isInstalled(id) && ml.models.isInstalled('whisper-cli'),
    }
  })
  ipcMain.handle('ml:subtitleCues', async (e, mediaRef: unknown): Promise<SubtitleCuesOutcome> => {
    const file = fileFor(e, mediaRef)
    if (!file || !(await fs.access(file).then(() => true, () => false))) return { ok: false, error: 'Subtitle file is unavailable.', offline: true }
    try {
      return { ok: true, cues: parseSubtitleBytes(await fs.readFile(file), path.extname(file).slice(1)) }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('ml:models:state', (_e, id: unknown): ModelStateView => {
    try {
      return ml.models.state(String(id))
    } catch (err) {
      return { kind: 'failed', message: errorMessage(err) }
    }
  })
  ipcMain.handle('ml:models:ensure', async (_e, id: unknown) => {
    try {
      await ml.models.ensure(String(id) as ModelId, { userInitiated: true })
      return { ok: true }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })
  ipcMain.handle('ml:models:remove', (_e, id: unknown) => ml.models.remove(String(id)))
  ml.models.on('state', (id: string, state: ModelState) => d.broadcast('ml:models:state', { id, state }))
}
