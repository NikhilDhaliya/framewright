/** `audio:*` IPC (spec 07 §3, §5): the renderer names assets/clips; main resolves files, runs analysis and edits. */
import { existsSync } from 'node:fs'
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { applyClipSync, planClipSync, syncSelection, type SyncMode } from '../../../core/audio/clipSync'
import { removeAllDeadAir, removeDeadAirAt, validSilenceSettings, type QuietMasks } from '../../../core/audio/deadAir'
import { activeTimeline, type Doc } from '../../../core/ops/context'
import { EditRefusal } from '../../../core/timeline'
import type { BeatsOutcome, DenoiseStateView, EditOutcome, SpeechOutcome } from '../../../shared/audio'
import type { ProjectSession } from '../../project/session'
import { appDirs } from '../../paths'
import { correlateOffThread } from './correlate'
import { DenoiseService } from './denoise'
import { AudioAnalysisService } from './service'
import { SpeakerService } from './speakers'
import { SessionSpeakers } from './sessionSpeakers'
import type { ModelManager } from '../models'
import { newRegistryEntry } from '../../../core/audio/speakers'
import type { SpeakersOutcome } from '../../../shared/audio'

export interface AudioServices {
  audio: AudioAnalysisService
  denoise: DenoiseService
  speakers: SpeakerService
  /** Last identify masks per session (get_transcript speaker labels). */
  sessionSpeakers: SessionSpeakers
}

export function createAudio(models: ModelManager, cacheRoot = appDirs.cache): AudioServices {
  const audio = new AudioAnalysisService({ cacheRoot })
  const speakers = new SpeakerService(cacheRoot, models, audio)
  return { audio, denoise: new DenoiseService(cacheRoot, audio.analysisLane), speakers, sessionSpeakers: new SessionSpeakers(speakers) }
}

/** Speaker sources: audio clips on the active timeline (multicam: the master's audio only, as captions do). */
function speakerRefs(doc: Doc): string[] {
  const refs = new Set<string>()
  const groups = doc.file.multicamGroups ?? []
  for (const tr of activeTimeline(doc).tracks)
    for (const c of tr.clips) {
      if (c.mediaType !== 'audio') continue
      const g = c.multicamGroupId ? groups.find((x) => x.id === c.multicamGroupId) : undefined
      if (g && g.members.find((m) => m.id === g.masterMemberId)?.mediaRef !== c.mediaRef) continue
      refs.add(c.mediaRef)
    }
  return [...refs]
}

export interface AudioIpcDeps extends AudioServices {
  sessionFor(sender: WebContents): ProjectSession | null
  sessions(): ProjectSession[]
  broadcast(channel: string, payload: unknown): void
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

function maskRefs(doc: Doc): string[] {
  const refs = new Set<string>()
  for (const tr of activeTimeline(doc).tracks) for (const c of tr.clips) if (c.mediaType === 'audio') refs.add(c.mediaRef)
  for (const g of doc.file.multicamGroups ?? []) for (const m of g.members) if (m.kind !== 'angle') refs.add(m.mediaRef)
  return [...refs]
}

export function registerAudioIpc(d: AudioIpcDeps): void {
  const { audio, denoise } = d
  const sessionOf = (e: IpcMainInvokeEvent | IpcMainEvent) => d.sessionFor(e.sender)
  const resolver = (s: ProjectSession) => (ref: string) => {
    const f = s.resolveMedia(ref)
    return f && existsSync(f) ? f : null
  }
  const fileFor = (e: IpcMainInvokeEvent, assetId: unknown): string | null => {
    const s = sessionOf(e)
    return s && typeof assetId === 'string' ? resolver(s)(assetId) : null
  }

  audio.onChange(({ kind, mediaRef }) => d.broadcast('audio:analysis', { kind, assetId: mediaRef }))
  denoise.onState((ref, state) => d.broadcast('audio:denoiseState', { assetId: ref, state }))

  ipcMain.handle('audio:speech', async (e, assetId: unknown): Promise<SpeechOutcome> => {
    const file = fileFor(e, assetId)
    if (!file) return { ok: false, error: 'The media file is unavailable.', offline: true }
    try {
      const a = await audio.speech(String(assetId), file)
      return { ok: true, quiet: a.quiet, chunkCount: a.chunkCount }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.on('audio:setSilenceSettings', (e, raw: unknown) => {
    const s = sessionOf(e)
    const v = raw && typeof raw === 'object' ? validSilenceSettings(Number((raw as { minimumPause?: unknown }).minimumPause), Number((raw as { speechPadding?: unknown }).speechPadding)) : null
    if (s && v) audio.setSilenceSettings(s.path, v)
  })

  ipcMain.handle('audio:removeDeadAir', async (e, raw: unknown): Promise<EditOutcome<{ sections: number }>> => {
    const s = sessionOf(e)
    if (!s) return { ok: false, error: 'No project.' }
    const req = (raw && typeof raw === 'object' ? raw : {}) as { clipId?: unknown; frame?: unknown }
    const masks: QuietMasks = await audio.quietMasks(maskRefs(s.doc), resolver(s))
    const settings = audio.silenceSettings(s.path)
    let sections = 0
    const single = typeof req.clipId === 'string' && typeof req.frame === 'number'
    const out = s.transact('Remove Dead Air', (doc) => {
      const r = single ? removeDeadAirAt(doc, req.clipId as string, req.frame as number, masks, settings) : removeAllDeadAir(doc, masks, settings)
      sections = r.sections
    })
    if (!out.ok) return { ok: false, error: out.error, beep: true }
    return { ok: true, sections }
  })

  ipcMain.handle('audio:beats', async (e, assetId: unknown, force: unknown): Promise<BeatsOutcome> => {
    const file = fileFor(e, assetId)
    if (!file) return { ok: false, error: 'Beat detection failed. Check that the media file is reachable, then retry.' }
    try {
      return { ok: true, analysis: await audio.beats(String(assetId), file, force === true) }
    } catch (err) {
      console.warn(`[audio] beats: ${errorMessage(err)}`)
      return { ok: false, error: 'Beat detection failed. Check that the media file is reachable, then retry.' }
    }
  })

  ipcMain.handle('audio:cachedBeats', async (e, assetId: unknown) => {
    const file = fileFor(e, assetId)
    return file ? audio.cachedBeats(String(assetId), file) : null
  })

  ipcMain.handle('audio:synchronize', async (e, raw: unknown) => {
    const s = sessionOf(e)
    if (!s) return { ok: false, error: 'No project.' }
    const req = (raw && typeof raw === 'object' ? raw : {}) as { clipIds?: unknown; mode?: unknown }
    const ids = Array.isArray(req.clipIds) ? req.clipIds.filter((x): x is string => typeof x === 'string') : []
    const mode: SyncMode = req.mode === 'audio' || req.mode === 'timecode' ? req.mode : 'auto'
    const sel = syncSelection(s.doc, ids)
    if (!sel) return { ok: false, error: 'Select at least two clips to synchronize.' }
    const resolve = resolver(s)
    try {
      const plan = await planClipSync(s.doc, { ...sel, mode }, {
        timing: (refs) => audio.timing(Object.fromEntries(refs.map((r) => [r, resolve(r)]))),
        envelope: async (ref, start, end) => {
          const f = resolve(ref)
          return f ? audio.envelope(f, start, end) : null
        },
        correlate: (a) => correlateOffThread(a),
      })
      if (plan.moves.length || plan.retimes.length) {
        const out = s.transact('Synchronize', (doc) => applyClipSync(doc, plan))
        if (!out.ok) return { ok: false, error: out.error, beep: true }
      }
      return { ok: true, report: plan.report }
    } catch (err) {
      return { ok: false, error: err instanceof EditRefusal ? err.message : errorMessage(err) }
    }
  })

  ipcMain.handle('audio:identifySpeakers', async (e, raw: unknown): Promise<SpeakersOutcome> => {
    const s = sessionOf(e)
    if (!s) return { ok: false, error: 'No project.' }
    const cacheOnly = !!(raw && typeof raw === 'object' && (raw as { cacheOnly?: unknown }).cacheOnly)
    const resolve = resolver(s)
    const files = speakerRefs(s.doc).flatMap((ref) => {
      const file = resolve(ref)
      return file ? [{ mediaRef: ref, file }] : []
    })
    try {
      const r = await d.speakers.identify(files, s.doc.file.speakers ?? [], { cacheOnly, onPhase: (phase) => e.sender.send('audio:speakerPhase', phase) })
      if (r.newEntries.length) {
        const out = s.transact('Identify Speakers', (doc) => {
          doc.file.speakers = [...(doc.file.speakers ?? []), ...r.newEntries.map((n) => newRegistryEntry(n.id, n.centroid))]
        }, false)
        if (out.ok) void s.save().catch(() => undefined)
      }
      d.sessionSpeakers.set(s, r.masks)
      return { ok: true, masks: r.masks, assignments: r.byFileLocal, error: !cacheOnly && r.errors.length ? r.errors[0] : undefined }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  })

  ipcMain.handle('audio:updateSpeaker', (e, raw: unknown) => {
    const s = sessionOf(e)
    const req = (raw && typeof raw === 'object' ? raw : {}) as { id?: unknown; name?: unknown; color?: unknown; remove?: unknown }
    if (!s || typeof req.id !== 'number') return { ok: false, error: 'No speaker.' }
    const out = s.transact('Update Speaker', (doc) => {
      const list = doc.file.speakers ?? []
      if (req.remove === true) doc.file.speakers = list.filter((x) => x.id !== req.id)
      else
        for (const sp of list) {
          if (sp.id !== req.id) continue
          if (typeof req.name === 'string') sp.name = req.name
          if (Array.isArray(req.color) && req.color.length === 4 && req.color.every((x) => typeof x === 'number')) sp.color = req.color as number[]
        }
    }, false)
    if (out.ok && req.remove === true) d.sessionSpeakers.removeSpeaker(s, req.id)
    if (out.ok) void s.save().catch(() => undefined)
    return out.ok ? { ok: true } : { ok: false, error: out.error }
  })

  ipcMain.handle('audio:denoiseState', async (e, assetId: unknown): Promise<DenoiseStateView> => {
    const file = fileFor(e, assetId)
    if (file) await denoise.enhancedAudioPath(String(assetId), file)
    return denoise.state(String(assetId))
  })

  ipcMain.handle('audio:enhancedAudioPath', async (e, assetId: unknown) => {
    const file = fileFor(e, assetId)
    return file ? denoise.enhancedAudioPath(String(assetId), file) : null
  })

  ipcMain.on('audio:scheduleDenoise', (e, assetId: unknown) => {
    const s = sessionOf(e)
    if (!s) return
    if (typeof assetId === 'string') denoise.clearFailure(assetId)
    denoise.schedule(s.doc, resolver(s))
  })
}

/** Project open / cache clear: bake pending denoises for a session (`enhancePendingDenoises`). */
export function schedulePendingDenoises(d: AudioServices, s: ProjectSession): void {
  d.denoise.schedule(s.doc, (ref) => {
    const f = s.resolveMedia(ref)
    return f && existsSync(f) ? f : null
  })
}
