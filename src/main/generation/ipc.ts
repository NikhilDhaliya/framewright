/** `generation:*` IPC for the Generate panel (spec 06 §B7) and session hookup for resume (§B5). */
import { ipcMain, type WebContents } from 'electron'
import type { TransitionPlacement } from '../../core/generation/edit'
import type { GenerateOutcome, GenerateRequest, MusicRequest, TransitionFramesOutcome } from '../../core/generation/requests'
import type { ProjectSession } from '../project/session'
import type { AppContext } from '../services'
import { captureTransitionFrames, submitMusic } from './music'
import { enhanceDraftAsset, submitPanelRequest } from './panel'
import { generationService } from './service'
import { runtimeVoices } from './voices'

export interface GenerationIpcDeps {
  app: AppContext
  sessionFor(sender: WebContents): ProjectSession | null
}

export function registerGenerationIpc(d: GenerationIpcDeps): void {
  ipcMain.handle('generation:submit', (e, req: GenerateRequest): GenerateOutcome => {
    const session = d.sessionFor(e.sender)
    if (!session) return { ok: false, error: 'No project is open.' }
    if (!req || typeof req !== 'object' || typeof (req as { kind?: unknown }).kind !== 'string') return { ok: false, error: 'Invalid request.' }
    try {
      return { ok: true, placeholderIds: submitPanelRequest(d.app, session, req) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('generation:music', async (e, req: MusicRequest): Promise<GenerateOutcome> => {
    const session = d.sessionFor(e.sender)
    if (!session) return { ok: false, error: 'No project is open.' }
    if (!req || typeof req !== 'object' || typeof req.model !== 'string') return { ok: false, error: 'Invalid request.' }
    try {
      const id = await submitMusic(d.app, session, req, (phase) => {
        if (!e.sender.isDestroyed()) e.sender.send('generation:musicPhase', phase)
      })
      return { ok: true, placeholderIds: [id] }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('generation:enhance', (e, assetId: unknown): GenerateOutcome => {
    const session = d.sessionFor(e.sender)
    if (!session || typeof assetId !== 'string') return { ok: false, error: 'No project is open.' }
    try {
      return { ok: true, placeholderIds: [enhanceDraftAsset(d.app, session, assetId)] }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('generation:transitionFrames', async (e, p: TransitionPlacement): Promise<TransitionFramesOutcome> => {
    const session = d.sessionFor(e.sender)
    if (!session) return { ok: false, error: 'No project is open.' }
    try {
      const out = await captureTransitionFrames(d.app, session, p)
      return out ? { ok: true, firstId: out.first.id, lastId: out.last.id } : { ok: true, stale: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('generation:cancel', (e, assetId: unknown) => {
    const session = d.sessionFor(e.sender)
    return session && typeof assetId === 'string' ? generationService(d.app).cancel(session, assetId) : false
  })
  ipcMain.handle('generation:voices', (_e, modelId: unknown) => (typeof modelId === 'string' ? runtimeVoices(d.app, modelId) : []))
  ipcMain.handle('generation:retryDownload', (e, assetId: unknown) => {
    const session = d.sessionFor(e.sender)
    return session && typeof assetId === 'string' ? generationService(d.app).retryDownload(session, assetId) : false
  })
}

/** Attaches every open project (resume + undo reconciliation) and forgets closed ones. */
export function syncGenerationSessions(app: AppContext): void {
  const svc = generationService(app)
  svc.sweepClosed()
  for (const s of app.sessions.all()) svc.attach(s)
}
