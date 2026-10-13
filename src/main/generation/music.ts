/**
 * Audio ▸ Music submissions (spec 06 §B8, Mac `MusicGenerationSubmission`) and the timeline-span render shared with
 * `generate_audio`; frame captures for Create AI Transition (§B10 step 2, Mac `captureFrameToMedia`).
 */
import fs from 'node:fs/promises'
import { hasKeyFrom } from '../../core/generation/catalog'
import type { TransitionPlacement } from '../../core/generation/edit'
import { modelSet } from '../../core/generation/models'
import { compact, type AudioGenerationParams } from '../../core/generation/params'
import { finalizeGeneratingClips, placeGeneratingAudioClip, transitionPlacementIsCurrent } from '../../core/generation/placement'
import type { MusicPhase, MusicRequest } from '../../core/generation/requests'
import { validateAudioParams, validateAudioSpan } from '../../core/generation/validation'
import type { GenerationInput, MediaManifestEntry } from '../../core/model'
import { timelineById } from '../../core/ops/context'
import { totalFrames } from '../../core/timeline'
import type { ProjectSession } from '../project/session'
import type { AppContext } from '../services'
import { tempPath } from './preprocess'
import { captureFrameToMedia } from '../extras/captureFrame'
import { generationService, refDateNow } from './service'
import { submitAudio } from './submissions'

/** Renders a silent, low-quality MP4 (short side 240 px) of `[start, end)` of a timeline (`TimelineRenderer.render`, §B8). */
export async function renderTimelineSpan(app: AppContext, session: ProjectSession, timelineId: string, start: number, end: number): Promise<string> {
  const t = timelineById(session.doc, timelineId)
  if (!t) throw new Error('Timeline not found.')
  const short = 240
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2)
  const [width, height] = t.width <= t.height ? [short, even((short * t.height) / t.width)] : [even((short * t.width) / t.height), short]
  const out = tempPath('span', 'mp4')
  const job = app.exporter.start(session, { timelineId: t.id, format: 'mp4', outputPath: out, width, height, quality: 'low', range: { start, end }, includeAudio: false })
  const done = await app.exporter.wait(job.id)
  if (done.status !== 'completed') {
    await fs.rm(out, { force: true })
    throw new Error(done.error ?? 'Rendering the timeline span failed.')
  }
  return out
}

/** Music models: audio models with category music that accept video (catalog order, §B8). */
export const musicModels = (app: AppContext) => {
  const s = app.settings()
  return modelSet(hasKeyFrom(s.apiKeys), s.disabledModelIds ?? []).audio.filter((m) => m.category === 'music' && m.inputs.includes('video'))
}

/** `MusicGenerationSubmission.run`: export + upload (video mode), submit, place a generating clip (`Add Music`). */
export async function submitMusic(app: AppContext, session: ProjectSession, req: MusicRequest, onPhase: (p: MusicPhase) => void = () => undefined): Promise<string> {
  const m = musicModels(app).find((x) => x.id === req.model)
  if (!m) throw new Error('No music models available.')
  if (!m.route) throw new Error(`Add a ${m.keyProviderName} API key in Settings ▸ Models & API Keys to use ${m.displayName}.`)
  const mode = m.inputs.includes('text') ? req.mode : 'video'
  const prompt = req.prompt.trim()
  const durationSeconds = Math.max(1, Math.round(req.spanSeconds))
  const t = timelineById(session.doc, req.timelineId)
  if (!t) throw new Error('Timeline not found.')
  let videoURL: string | undefined
  if (mode === 'text') {
    if (!prompt) throw new Error('Describe the music to generate.')
    const err = validateAudioParams(m, { kind: 'audio', prompt, instrumental: false, durationSeconds })
    if (err) throw new Error(err)
  } else {
    if (!(req.frameCount > 0) || totalFrames(t) <= 0) throw new Error('Add video to the timeline, then mark a range to score only part of it.')
    const err = validateAudioSpan(m, req.spanSeconds)
    if (err) throw new Error(err)
    onPhase('exporting')
    const mp4 = await renderTimelineSpan(app, session, t.id, req.startFrame, req.startFrame + req.frameCount)
    try {
      onPhase('uploading')
      videoURL = await generationService(app).uploadFile(m.route.provider, mp4, 'video')
    } finally {
      await fs.rm(mp4, { force: true })
    }
  }
  const params: AudioGenerationParams = compact({ kind: 'audio' as const, prompt, instrumental: false, durationSeconds, videoURL })
  const genInput: GenerationInput = { prompt, model: m.id, duration: durationSeconds, aspectRatio: '', audioInput: mode, createdAt: refDateNow() }
  onPhase('generating')
  const [id] = submitAudio(generationService(app), {
    session,
    model: m,
    genInput,
    params,
    references: [],
    name: m.displayName,
    undoLabel: 'Add Music',
    place: (d, ids) => {
      placeGeneratingAudioClip(d, t.id, ids[0], req.startFrame, req.spanSeconds)
    },
    onComplete: (a) => quietly(session, (d) => finalizeGeneratingClips(d, a.id, a.duration)),
  })
  return id
}

/** Non-undoable completion write (§B6.2 "not an undo step"), persisted. */
export function quietly(session: ProjectSession, fn: Parameters<ProjectSession['transact']>[1]): void {
  if (session.closed) return
  const out = session.transact('Update Media', fn, false)
  if (out.ok && out.changed) void session.save().catch(() => undefined)
}

// ---------- Frame capture (§B10 step 2) ----------

/** Renders a composited timeline frame into `media/frame-<8hex>.png` and adds it as an image asset (`Capture Frame`; shared with extras). */
export async function captureTimelineFrameToMedia(app: AppContext, session: ProjectSession, timelineId: string, frame: number, name: string): Promise<MediaManifestEntry> {
  return (await captureFrameToMedia(app, session, { kind: 'timeline', frame }, { timelineId, name })).asset
}

/** Captures the frame before the gap and the frame after it; `null` when the placement went stale in between. */
export async function captureTransitionFrames(app: AppContext, session: ProjectSession, p: TransitionPlacement): Promise<{ first: MediaManifestEntry; last: MediaManifestEntry } | null> {
  const startFrame = p.gapStartFrame - 1
  const endFrame = p.gapStartFrame + p.gapLengthFrames
  if (!transitionPlacementIsCurrent(session.doc, p)) return null
  const first = await captureTimelineFrameToMedia(app, session, p.timelineId, startFrame, `Transition start (frame ${startFrame})`)
  if (!transitionPlacementIsCurrent(session.doc, p)) return null
  const last = await captureTimelineFrameToMedia(app, session, p.timelineId, endFrame, `Transition end (frame ${endFrame})`)
  if (!transitionPlacementIsCurrent(session.doc, p)) return null
  return { first, last }
}
