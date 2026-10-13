/**
 * Generate panel submissions (spec 06 §B7.8): re-validates the panel's request with the shared rules and runs the
 * shared submission builders. Throws an Error whose message the panel flashes.
 */
import path from 'node:path'
import { hasKeyFrom } from '../../core/generation/catalog'
import { DRAFT_RESOLUTION, modelSet, type ModelSet } from '../../core/generation/models'
import { compact, type AudioGenerationParams } from '../../core/generation/params'
import type { PendingContext } from '../../core/generation/edit'
import { finalizeGeneratingClips, finalizeTransitionClips, placeGeneratingAudioClip, placeTransitionClip, replaceClipSource, transitionPlacementIsCurrent } from '../../core/generation/placement'
import type { GenerateRequest } from '../../core/generation/requests'
import {
  hasTrim,
  type TrimmedSource,
  validateAudioParams,
  validateAudioReferences,
  validateAudioSpan,
  validateImage,
  validateSourceDuration,
  validateVideo,
  validateVideoInputs,
  type RefAsset,
} from '../../core/generation/validation'
import type { GenerationInput, MediaManifestEntry } from '../../core/model'
import { timelineById } from '../../core/ops/context'
import { findClip, sourceFramesConsumed } from '../../core/timeline'
import type { ProjectSession } from '../project/session'
import type { AppContext } from '../services'
import { tm } from '../i18n'
import { quietly } from './music'
import { generationService } from './service'
import { canEnhanceDraft, enhanceToast, submitAudio, submitEnhance, submitImage, submitUpscale, submitVideo, withAudioSource, type Callbacks } from './submissions'
import { parseStatus } from '../../core/generation/status'

const check = (err: string | null) => {
  if (err) throw new Error(err)
}

function setFor(app: AppContext): ModelSet {
  const s = app.settings()
  return modelSet(hasKeyFrom(s.apiKeys), s.disabledModelIds ?? [])
}

function entries(session: ProjectSession, ids: string[]): MediaManifestEntry[] {
  return ids.map((id) => {
    const e = session.doc.manifest.entries.find((x) => x.id === id)
    if (!e) throw new Error(tm('A reference is no longer in the library.'))
    return e
  })
}

const refAsset = (session: ProjectSession, e: MediaManifestEntry): RefAsset => {
  const file = session.resolveMedia(e)
  return { id: e.id, name: e.name, type: e.type, duration: e.duration, ext: file ? path.extname(file).slice(1).toLowerCase() : undefined, path: file }
}

function notAvailable(set: ModelSet, id: string): Error {
  const m = set.find(id)
  if (!m) return new Error(tm('Model no longer available'))
  return new Error(tm('Add a {0} API key in Settings ▸ Models & API Keys to use {1}.', m.keyProviderName, m.displayName))
}

// ---------- Pending AI Edit context (§B7.8 step 3, §B6.2, §B10) ----------

/** The pending clip trim when it trims one of `candidates` (Mac `pendingTrimmedSource` / `audioSourceTrimmedSource`). */
export function pendingTrim(session: ProjectSession, pending: PendingContext | null | undefined, candidates: MediaManifestEntry[]): TrimmedSource | null {
  const ref = pending?.trim
  if (!ref) return null
  const t = timelineById(session.doc, ref.timelineId)
  const clip = t ? findClip(t, ref.clipId)?.clip : undefined
  if (!t || !clip) return null
  const asset = candidates.find((c) => c.id === clip.mediaRef)
  if (!asset || (asset.type !== 'video' && asset.type !== 'audio')) return null
  const file = session.resolveMedia(asset)
  if (!file) return null
  const trim: TrimmedSource = { sourcePath: file, trimStartFrame: clip.trimStartFrame, trimEndFrame: clip.trimEndFrame, sourceFramesConsumed: sourceFramesConsumed(clip), fps: t.fps }
  return hasTrim(trim) ? trim : null
}

/** Replacement swap, audio placement and transition placement callbacks for one submission. */
export function pendingCallbacks(app: AppContext, session: ProjectSession, pending: PendingContext | null | undefined, kind: GenerateRequest['kind'], resetTrim: boolean, defaultLabel: string): Callbacks {
  const cb: Callbacks = { undoLabel: defaultLabel }
  const done: ((a: MediaManifestEntry) => void)[] = []
  const clipId = pending?.replacementClipId
  if (clipId) {
    const timelineId = pending?.replacementTimelineId ?? session.doc.file.activeTimelineId ?? ''
    let fired = false
    done.push((a) => {
      if (fired || session.closed) return
      fired = true
      session.transact('Replace Clip Source', (d) => {
        replaceClipSource(d, timelineId, clipId, a.id, resetTrim)
      })
    })
  }
  const audio = kind === 'audio' ? pending?.audioPlacement : null
  if (audio) {
    cb.undoLabel = audio.actionName
    cb.place = (d, ids) => {
      placeGeneratingAudioClip(d, audio.timelineId, ids[0], audio.startFrame, audio.spanSeconds)
    }
    done.unshift((a) => quietly(session, (d) => finalizeGeneratingClips(d, a.id, a.duration)))
  }
  const transition = kind === 'video' ? pending?.transitionPlacement : null
  if (transition) {
    if (transitionPlacementIsCurrent(session.doc, transition)) {
      cb.undoLabel = 'AI Transition'
      cb.place = (d, ids) => {
        placeTransitionClip(d, transition, ids[0])
      }
      done.unshift((a) => quietly(session, (d) => finalizeTransitionClips(d, a.id, a.duration)))
    } else app.ui(session, { type: 'toast', message: tm('The gap is no longer available, so the transition will land in Media instead.') })
  }
  if (done.length) cb.onComplete = (a) => done.forEach((f) => f(a))
  return cb
}

export function submitPanelRequest(app: AppContext, session: ProjectSession, req: GenerateRequest): string[] {
  const set = setFor(app)
  const svc = generationService(app)
  const folderId = req.folderId ?? undefined
  const ra = (x: MediaManifestEntry[]) => x.map((e) => refAsset(session, e))
  switch (req.kind) {
    case 'video': {
      const m = set.findVideo(req.model)
      if (!m || !m.hasKey) throw notAvailable(set, req.model)
      const usesSource = m.requiresSourceVideo || (m.supportsSourceVideo && req.mode === 'source')
      const source = usesSource && req.sourceVideoId ? entries(session, [req.sourceVideoId])[0] : null
      if (usesSource && !source) throw new Error(tm('Add source media.'))
      const frames = usesSource ? [] : entries(session, req.frameIds)
      const imageRefs = entries(session, req.imageRefIds)
      const videoRefs = entries(session, req.videoRefIds)
      const audioRefs = entries(session, req.audioRefIds)
      const trim = source ? pendingTrim(session, req.pending, [source]) : pendingTrim(session, req.pending, [...frames, ...imageRefs, ...videoRefs, ...audioRefs].filter((r) => r.type === 'video'))
      check(validateVideoInputs(m, { sourceVideo: source ? refAsset(session, source) : null, frames: ra(frames), imageRefs: ra(imageRefs), videoRefs: ra(videoRefs), audioRefs: ra(audioRefs) }, trim))
      const resolution = m.resolutions ? (req.draft && m.supportsDraft ? DRAFT_RESOLUTION : req.resolution) : null
      let duration = req.duration
      let placeholderDuration = Math.max(1, duration)
      if (source) {
        const sourceSeconds = trim ? trim.sourceFramesConsumed / trim.fps : source.duration
        check(validateSourceDuration(m, sourceSeconds))
        if (!m.usesOutputDuration) {
          const billing = m.billingDurationSeconds(sourceSeconds, audioRefs[0]?.duration)
          if (billing === null) throw new Error(m.isLipSync ? tm('Replacement audio has an invalid duration.') : tm('Source video has an invalid duration.'))
          duration = billing
          placeholderDuration = sourceSeconds
        }
        check(validateVideo(m, m.usesOutputDuration ? duration : 0, m.usesOutputDuration ? req.aspectRatio : '', m.usesOutputDuration ? resolution : null))
      } else {
        if (m.supportsPrompt && !req.prompt.trim() && !(m.framesAndReferencesExclusive && req.mode === 'references')) throw new Error(tm('Enter a prompt.'))
        check(validateVideo(m, duration, req.aspectRatio, resolution))
        if (trim) placeholderDuration = trim.sourceFramesConsumed / trim.fps
      }
      const genInput: GenerationInput = compact({
        prompt: req.prompt,
        model: m.id,
        duration,
        aspectRatio: req.aspectRatio,
        resolution: resolution ?? undefined,
        generateAudio: m.hasAudioToggle ? req.generateAudio ?? true : undefined,
        draft: m.supportsDraft ? req.draft : undefined,
        usesSourceVideo: !!source,
      })
      return submitVideo(svc, {
        session,
        model: m,
        genInput,
        inputs: { sourceVideo: source, frames, imageRefs, videoRefs, audioRefs },
        placeholderDuration,
        trim,
        folderId,
        generateAudio: m.hasAudioToggle ? req.generateAudio ?? true : true,
        ...pendingCallbacks(app, session, req.pending, 'video', !!trim, 'Generate Video'),
      })
    }
    case 'image': {
      const m = set.findImage(req.model)
      if (!m || !m.hasKey) throw notAvailable(set, req.model)
      const refs = entries(session, req.refIds)
      if (refs.some((r) => r.type !== 'image')) throw new Error(tm('Drop image here.'))
      if (!req.prompt.trim()) throw new Error(tm('Enter a prompt.'))
      check(validateImage(m, req.aspectRatio, req.resolution, req.quality, refs.length, req.numImages))
      const genInput: GenerationInput = compact({
        prompt: req.prompt,
        model: m.id,
        duration: 0,
        aspectRatio: req.aspectRatio,
        resolution: m.resolutions ? req.resolution ?? undefined : undefined,
        quality: m.qualities ? req.quality ?? undefined : undefined,
        numImages: req.numImages > 1 ? req.numImages : undefined,
      })
      return submitImage(svc, { session, model: m, genInput, references: refs, numImages: req.numImages, folderId, ...pendingCallbacks(app, session, req.pending, 'image', false, 'Generate Image') })
    }
    case 'audio': {
      const m = set.findAudio(req.model)
      if (!m || !m.hasKey) throw notAvailable(set, req.model)
      const imageRefs = entries(session, req.imageRefIds)
      const audioRefs = entries(session, req.audioRefIds)
      check(validateAudioReferences(m, ra(imageRefs), ra(audioRefs)))
      const source = m.acceptsSourceMedia && req.sourceId ? entries(session, [req.sourceId])[0] : null
      const trim = source ? pendingTrim(session, req.pending, [source]) : null
      const spanSeconds = source ? (trim ? trim.sourceFramesConsumed / trim.fps : source.duration) : 0
      if (source) {
        if (!m.acceptsSource(source.type)) throw new Error(tm('{0} does not support this media type.', m.displayName))
        if (m.usesSourceURL && source.type === 'video' && !source.hasAudio) throw new Error(tm('Video has no audio track'))
        check(validateAudioSpan(m, spanSeconds))
      } else if (m.acceptsSourceMedia && !m.inputs.includes('text')) throw new Error(tm('Add source media.'))
      const sourceSeconds = source ? Math.max(1, Math.round(spanSeconds)) : undefined
      const durationSeconds = source ? sourceSeconds : m.hasDurationControl ? req.duration ?? undefined : undefined
      const params: AudioGenerationParams = compact({
        kind: 'audio' as const,
        prompt: req.prompt.trim(),
        voice: m.acceptsVoice ? req.voice || m.defaultVoice || undefined : undefined,
        lyrics: m.supportsLyrics && req.lyrics ? req.lyrics : undefined,
        styleInstructions: m.supportsStyleInstructions && req.styleInstructions ? req.styleInstructions : undefined,
        instrumental: m.supportsInstrumental ? req.instrumental : false,
        durationSeconds,
        targetLanguage: m.targetLanguages ? req.targetLanguage ?? undefined : undefined,
        multilingual: m.supportsMultilingual ? req.multilingual : undefined,
      })
      check(validateAudioParams(m, params))
      let genInput: GenerationInput = compact({
        prompt: req.prompt,
        model: m.id,
        duration: durationSeconds ?? 0,
        aspectRatio: '',
        voice: params.voice,
        lyrics: params.lyrics,
        styleInstructions: params.styleInstructions,
        instrumental: m.supportsInstrumental ? req.instrumental : undefined,
        targetLanguage: params.targetLanguage,
        multilingual: params.multilingual,
        audioInput: source ? source.type : 'text',
      })
      if (source) genInput = withAudioSource(genInput, source)
      const references = m.supportsReferences ? [...imageRefs, ...audioRefs] : source ? [source] : []
      return submitAudio(svc, { session, model: m, genInput, params, references, trim, folderId, ...pendingCallbacks(app, session, req.pending, 'audio', false, 'Generate Audio') })
    }
    case 'upscale': {
      const m = set.findUpscale(req.model)
      if (!m || !m.hasKey) throw notAvailable(set, req.model)
      const source = entries(session, [req.sourceId])[0]
      if (!m.supportedTypes.includes(source.type)) throw new Error(tm('{0} does not support this media type.', m.displayName))
      if (source.sourceWidth == null || source.sourceHeight == null) throw new Error(tm('Loading source dimensions…'))
      if (source.type === 'video' && source.sourceFPS == null) throw new Error(tm('Loading source frame rate…'))
      if (!m.supports(source)) throw new Error(tm('This model cannot cap the output at 60 FPS.'))
      const settings = m.normalizedSettings(req.settings, source)
      const trim = pendingTrim(session, req.pending, [source])
      return submitUpscale(svc, { session, model: m, source, settings, trim, ...pendingCallbacks(app, session, req.pending, 'upscale', !!trim, 'Upscale') })
    }
  }
}

/** FLUX Enhance (§B9.6, Mac `GenerationService.enhanceDraft`): `<name> 1080p` placeholder, toast on success/failure. */
export function enhanceDraftAsset(app: AppContext, session: ProjectSession, assetId: string): string {
  const draft = session.doc.manifest.entries.find((e) => e.id === assetId)
  if (!draft) throw new Error(`Draft not found: ${assetId}`)
  const set = setFor(app)
  const model = set.findVideo(String(draft.generationInput?.model ?? ''))
  if (!model || !canEnhanceDraft(draft, model)) throw new Error(tm('Draft already enhanced or cache unavailable'))
  let id = ''
  ;[id] = submitEnhance(generationService(app), session, draft, model, {
    undoLabel: 'FLUX Enhance',
    onComplete: () => app.ui(session, { type: 'toast', message: enhanceToast(model) }),
    onFailure: () => {
      const status = parseStatus(session.doc.manifest.entries.find((e) => e.id === id)?.generationStatus)
      app.ui(session, { type: 'toast', message: status.kind === 'failed' && status.message ? status.message : tm('Generation failed') })
    },
  })
  return id
}
