/**
 * AI Edit (spec 06 §B9, §B10): actions and their availability rules with the Mac's verbatim reasons, the seeds that
 * pre-fill the Generate panel, the pending context a seed carries (replacement / trim / placements), and the
 * Create AI Transition availability. Pure — shared by the media/timeline menus, the inspector and tests.
 */
import type { ClipType, GenerationInput, MediaManifestEntry } from '../model'
import { durationLimitLabel, EDIT_MAX_DURATION_SECONDS, type AnyModel, type AudioModel, type ModelSet, type UpscaleModel, type VideoModel } from './models'
import { isInFlight, resultURLsOf, byokJobOf } from './status'
import { validateAudioSpan, validateSourceDuration } from './validation'

export type EditAction = 'upscale' | 'edit' | 'rerun' | 'lipSync' | 'reframe' | 'generateMusic' | 'generateSFX' | 'createVideo' | 'enhanceDraft'
export type AudioTransformKind = 'cleanup' | 'dubbing'
export type VideoToAudioKind = 'music' | 'sfx'

export type Availability = { ok: true } | { ok: false; reason: string }
const OK: Availability = { ok: true }
const no = (reason: string): Availability => ({ ok: false, reason })

export const REFRAME_PROMPT =
  'The exact same video as @Video1 but fill in to match the output aspect ratio. Keep movement, details, and audio the same as the original audio'
export const TRANSITION_PROMPT =
  'Create a seamless transition between the first frame and the last frame, one continuous take. No weird movements, effects, or artifacts. Natural and consistent motion that makes sense. No music, just appropriate SFX.'
export const MAX_TRANSITION_SECONDS = 15
export const IMAGE_EDIT_MODEL_ID = 'nano-banana-pro'

// ---------- Asset predicates ----------

export const isGenerating = (e: MediaManifestEntry): boolean => isInFlight(e.generationStatus)
export const isGenerated = (e: MediaManifestEntry): boolean => !!e.generationInput

/** A finished draft whose job stored `[video, draft cache]` (§B9.6, Q-B4). Data only — the model/key is checked separately. */
export const isEnhanceableDraft = (e: MediaManifestEntry): boolean =>
  !e.generationStatus && e.generationInput?.draft === true && !!byokJobOf(e.generationInput) && resultURLsOf(e.generationInput).length >= 2

// ---------- Model selection ----------

/** Linux: among the Mac's candidates (catalog order) prefer one the user can run; else the first (its key is missing). */
function pick<M extends AnyModel>(set: ModelSet, candidates: M[]): M | undefined {
  return candidates.find((m) => set.isAvailable(m)) ?? candidates.find((m) => m.hasKey) ?? candidates[0]
}

export const editVideoModel = (set: ModelSet): VideoModel | undefined => pick(set, set.video.filter((m) => m.isEdit))
export const lipSyncModel = (set: ModelSet): VideoModel | undefined => pick(set, set.video.filter((m) => m.isLipSync))
export const reframeModel = (set: ModelSet): VideoModel | undefined => pick(set, set.video.filter((m) => m.isReframe))
export const firstAndLastFrameModel = (set: ModelSet): VideoModel | undefined =>
  pick(set, set.video.filter((m) => !m.requiresSourceVideo && m.supportsFirstFrame && m.supportsLastFrame))
export const imageEditModel = (set: ModelSet): AnyModel | undefined => set.findImage(IMAGE_EDIT_MODEL_ID)

export function createVideoModel(set: ModelSet, asReference: boolean): VideoModel | undefined {
  return pick(set, set.video.filter((m) => !m.requiresSourceVideo && (asReference ? m.supportsReferences : m.supportsFirstFrame)))
}

/** Upscalers for the asset type; clip flows take the first that supports the source (`beginAIUpscale`). */
export function upscaleModelFor(set: ModelSet, asset: MediaManifestEntry, requireSupport = false): UpscaleModel | undefined {
  const forType = set.upscale.filter((m) => m.supportedTypes.includes(asset.type))
  return pick(set, requireSupport ? forType.filter((m) => m.supports(asset)) : forType)
}

export const VIDEO_TO_AUDIO = {
  music: {
    title: 'Generate Music',
    menuTitle: 'Generate Music…',
    icon: 'music.note',
    description: 'Generate music that fits the video',
    timelineAction: 'Add Music',
    preferredId: 'sonilo-v1.1-video-to-music',
    providerName: 'Sonilo',
    category: 'music',
    action: 'generateMusic',
  },
  sfx: {
    title: 'Generate SFX',
    menuTitle: 'Generate SFX…',
    icon: 'waveform',
    description: 'Create matching sound for the video',
    timelineAction: 'Add Sound Effects',
    preferredId: 'mirelo-sfx-v1.5-video-to-audio',
    providerName: 'Mirelo',
    category: 'sfx',
    action: 'generateSFX',
  },
} as const

export const AUDIO_TRANSFORMS = {
  cleanup: { title: 'Voice Cleanup', description: 'Remove background sound and keep speech', menuTitle: 'Clean Up Voice…', icon: 'waveform', timelineAction: 'Add Cleaned Voice' },
  dubbing: { title: 'Dubbing', description: 'Translate speech into another language', menuTitle: 'Dub…', icon: 'globe', timelineAction: 'Add Dubbed Voice' },
} as const

/** `VideoToAudioEditKind.model`: the preferred id if it is a video-input model of the category, else a provider-named one. */
export function videoToAudioModel(set: ModelSet, kind: VideoToAudioKind): AudioModel | undefined {
  const k = VIDEO_TO_AUDIO[kind]
  const fits = (m: AudioModel) => m.category === k.category && m.inputs.includes('video')
  const preferred = set.audio.find((m) => m.id === k.preferredId && fits(m))
  if (preferred) return preferred
  const name = k.providerName.toLowerCase()
  return set.audio.find((m) => fits(m) && (m.id.toLowerCase().includes(name) || m.displayName.toLowerCase().includes(name)))
}

export const audioTransformModel = (set: ModelSet, kind: AudioTransformKind): AudioModel | undefined => pick(set, set.audio.filter((m) => m.category === kind))

// ---------- Availability (§B9.1) ----------

/** Candidate actions per asset type (`EditAction.available`). */
export function candidateActions(type: ClipType): EditAction[] {
  switch (type) {
    case 'image':
      return ['upscale', 'edit', 'rerun', 'createVideo']
    case 'video':
      return ['upscale', 'edit', 'rerun', 'lipSync', 'reframe', 'enhanceDraft', 'generateMusic', 'generateSFX']
    case 'audio':
    case 'text':
      return ['upscale', 'edit', 'rerun']
    default:
      return []
  }
}

export const actionGroup = (action: EditAction, type: ClipType): 'enhance' | 'audio' =>
  action === 'generateMusic' || action === 'generateSFX' || (action === 'rerun' && type === 'audio') ? 'audio' : 'enhance'

const EDIT_UNSUPPORTED: Partial<Record<ClipType, string>> = {
  audio: "Edit doesn't support audio",
  text: "Edit doesn't support text",
  lottie: "Edit doesn't support Lottie",
  sequence: "Edit doesn't support sequences",
  subtitle: "Edit doesn't support subtitles",
}

export function validateReframeDuration(m: VideoModel, duration: number): string | null {
  if (!Number.isFinite(duration) || duration <= 0) return 'Loading video metadata…'
  const max = m.maxCombinedVideoRefSeconds ?? (m.durations.length ? Math.max(...m.durations) : null)
  if (max == null || duration <= max) return null
  const combined = m.maxCombinedVideoRefSeconds
  const label =
    combined != null && Number.isFinite(combined) && combined > 0 && Number.isInteger(Math.round(combined))
      ? durationLimitLabel(Math.round(combined))
      : m.durations.length
        ? durationLimitLabel(Math.max(...m.durations))
        : null
  return label ? `${m.displayName} supports source videos up to ${label}. Trim the clip to continue.` : null
}

/** `EditAction.availability` (key-independent). `durationOverride` = trimmed seconds of a clip flow. */
export function actionAvailability(set: ModelSet, action: EditAction, asset: MediaManifestEntry, durationOverride?: number | null): Availability {
  const duration = durationOverride ?? asset.duration
  const generating = isGenerating(asset)
  switch (action) {
    case 'enhanceDraft': {
      const m = set.findVideo(String(asset.generationInput?.model ?? ''))
      const hasFlow = !!m?.entry.byok?.routes.some((r) => !!r.endpoints.enhance)
      return isEnhanceableDraft(asset) && hasFlow ? OK : no('Draft already enhanced or cache unavailable')
    }
    case 'upscale':
      if (asset.type !== 'video' && asset.type !== 'image') return no('Upscale only works on video or images')
      if (generating) return no('Generation in progress')
      return OK
    case 'reframe': {
      if (asset.type !== 'video') return no('Reframe only works on video')
      if (generating) return no('Generation in progress')
      const m = reframeModel(set)
      if (!m) return no('Reframe model not available')
      const err = validateReframeDuration(m, duration)
      return err ? no(err) : OK
    }
    case 'lipSync': {
      if (asset.type !== 'video') return no('Lip Sync only works on video')
      if (generating) return no('Generation in progress')
      const m = lipSyncModel(set)
      if (!m) return no('Lip Sync model not available')
      const err = validateSourceDuration(m, duration)
      return err ? no(err) : OK
    }
    case 'edit':
      if (asset.type === 'video') {
        if (!editVideoModel(set)) return no('Edit model not available')
        if (!(duration > 0)) return no('Loading video metadata…')
        if (duration > EDIT_MAX_DURATION_SECONDS) return no(`Edit supports up to ${EDIT_MAX_DURATION_SECONDS}s (this is ${Math.round(duration)}s)`)
      } else if (asset.type !== 'image') return no(EDIT_UNSUPPORTED[asset.type] ?? "Edit doesn't support this media")
      if (generating) return no('Generation in progress')
      return OK
    case 'generateMusic':
    case 'generateSFX': {
      const kind: VideoToAudioKind = action === 'generateMusic' ? 'music' : 'sfx'
      if (asset.type !== 'video') return no(`${VIDEO_TO_AUDIO[kind].title} only works on video`)
      if (generating) return no('Generation in progress')
      if (!(duration > 0)) return no('Loading video metadata…')
      const m = videoToAudioModel(set, kind)
      if (!m) return no(`${VIDEO_TO_AUDIO[kind].providerName} model not available`)
      const err = validateAudioSpan(m, duration)
      return err ? no(err) : OK
    }
    case 'createVideo':
      if (asset.type !== 'image') return no('Create Video only works on images')
      if (generating) return no('Generation in progress')
      return OK
    case 'rerun':
      if (!isGenerated(asset)) return no('Only available for AI-generated media')
      if (generating) return no('Generation in progress')
      if (!set.find(String(asset.generationInput?.model ?? ''))) return no('Model no longer available')
      return OK
  }
}

/** `AudioTransformEditKind.availability`. */
export function audioTransformAvailability(set: ModelSet, kind: AudioTransformKind, asset: MediaManifestEntry, durationOverride?: number | null): Availability {
  if (asset.type !== 'audio' && asset.type !== 'video') return no(kind === 'cleanup' ? 'Voice Cleanup requires audio or video' : 'Dubbing requires audio or video')
  if (asset.type === 'video' && !asset.hasAudio) return no('Video has no audio track')
  if (isGenerating(asset)) return no('Generation in progress')
  const m = audioTransformModel(set, kind)
  if (!m) return no(kind === 'cleanup' ? 'Voice Cleanup model not available' : 'Dubbing model not available')
  if (!m.acceptsSource(asset.type)) return no(`${m.displayName} does not accept this media`)
  const duration = durationOverride ?? asset.duration
  if (!(duration > 0)) return no('Loading media metadata…')
  const err = validateAudioSpan(m, duration)
  return err ? no(err) : OK
}

/** The model an action would run (for the Linux key gate). */
export function actionModel(set: ModelSet, action: EditAction, asset: MediaManifestEntry, clipFlow = false): AnyModel | undefined {
  switch (action) {
    case 'upscale':
      return upscaleModelFor(set, asset, clipFlow)
    case 'edit':
      return asset.type === 'video' ? editVideoModel(set) : asset.type === 'image' ? imageEditModel(set) : undefined
    case 'rerun':
    case 'enhanceDraft':
      return set.find(String(asset.generationInput?.model ?? ''))
    case 'lipSync':
      return lipSyncModel(set)
    case 'reframe':
      return reframeModel(set)
    case 'generateMusic':
      return videoToAudioModel(set, 'music')
    case 'generateSFX':
      return videoToAudioModel(set, 'sfx')
    case 'createVideo':
      return createVideoModel(set, false) ?? createVideoModel(set, true)
  }
}

/** Linux replacement for the Mac's sign-in / paid gates: the action's model must have a key (§B9.3). */
export function keyReason(m: AnyModel | undefined): string | null {
  if (!m || m.hasKey) return null
  return `Add a ${m.keyProviderName} API key to use this`
}

/** Inspector tile state: disabled reason precedence = key gate → availability (§B9.3). */
export function tileState(set: ModelSet, action: EditAction, asset: MediaManifestEntry, durationOverride?: number | null, clipFlow = false): { enabled: boolean; reason: string | null } {
  const a = actionAvailability(set, action, asset, durationOverride)
  const key = a.ok ? keyReason(actionModel(set, action, asset, clipFlow)) : null
  const reason = key ?? (a.ok ? null : a.reason)
  return { enabled: !reason, reason }
}

export function audioTileState(set: ModelSet, kind: AudioTransformKind, asset: MediaManifestEntry, durationOverride?: number | null): { enabled: boolean; reason: string | null } {
  const a = audioTransformAvailability(set, kind, asset, durationOverride)
  const key = a.ok ? keyReason(audioTransformModel(set, kind)) : null
  const reason = key ?? (a.ok ? null : a.reason)
  return { enabled: !reason, reason }
}

/** Actions a menu shows: available and runnable with the user's keys (Linux: no "(Paid)" items). */
export function menuActions(set: ModelSet, asset: MediaManifestEntry, durationOverride?: number | null, clipFlow = false): EditAction[] {
  return candidateActions(asset.type).filter((a) => tileState(set, a, asset, durationOverride, clipFlow).enabled)
}

export function menuAudioTransforms(set: ModelSet, asset: MediaManifestEntry, durationOverride?: number | null): AudioTransformKind[] {
  return (['cleanup', 'dubbing'] as const).filter((k) => audioTileState(set, k, asset, durationOverride).enabled)
}

// ---------- Seeds (§B9.2) ----------

const base = (model: string, extra: Partial<GenerationInput> = {}): GenerationInput => ({ prompt: '', model, duration: 0, aspectRatio: '', ...extra })

/** `setAudioSourceAsset`: audio → referenceAudioAssetIds, video → referenceVideoAssetIds. */
function withAudioSourceAsset(input: GenerationInput, asset: MediaManifestEntry): GenerationInput | null {
  if (asset.type === 'audio') return { ...input, referenceAudioAssetIds: [asset.id] }
  if (asset.type === 'video') return { ...input, referenceVideoAssetIds: [asset.id] }
  return null
}

export function upscaleSeed(asset: MediaManifestEntry, model: UpscaleModel, trimmedSeconds?: number | null): GenerationInput {
  const seconds = Math.max(1, Math.round(trimmedSeconds ?? asset.duration))
  const input = base(model.id, { duration: seconds, upscaleSettings: model.defaultSettings, imageURLAssetIds: [asset.id] })
  if (asset.sourceWidth != null) input.upscaleSourceWidth = asset.sourceWidth
  if (asset.sourceHeight != null) input.upscaleSourceHeight = asset.sourceHeight
  if (asset.sourceFPS != null) input.upscaleSourceFPS = asset.sourceFPS
  return input
}

export function editSeed(set: ModelSet, asset: MediaManifestEntry): GenerationInput | null {
  const m = asset.type === 'video' ? editVideoModel(set) : asset.type === 'image' ? imageEditModel(set) : undefined
  return m ? base(m.id, { imageURLAssetIds: [asset.id] }) : null
}

export function reframeSeed(set: ModelSet, asset: MediaManifestEntry, trimmedSeconds?: number | null): GenerationInput | null {
  const m = reframeModel(set)
  if (!m || asset.type !== 'video') return null
  const portrait = asset.sourceWidth != null && asset.sourceHeight != null ? asset.sourceHeight > asset.sourceWidth : false
  const input = base(m.id, {
    prompt: REFRAME_PROMPT,
    duration: m.supportedDuration(trimmedSeconds ?? asset.duration),
    aspectRatio: portrait ? '16:9' : '9:16',
    referenceVideoAssetIds: [asset.id],
  })
  const res = m.preferredHighResolution
  if (res) input.resolution = res
  return input
}

export function lipSyncSeed(set: ModelSet, asset: MediaManifestEntry): GenerationInput | null {
  const m = lipSyncModel(set)
  return m && asset.type === 'video' ? base(m.id, { imageURLAssetIds: [asset.id] }) : null
}

export function createVideoSeed(set: ModelSet, asset: MediaManifestEntry, asReference: boolean): GenerationInput | null {
  const m = createVideoModel(set, asReference)
  if (!m) return null
  return base(m.id, asReference ? { referenceImageAssetIds: [asset.id] } : { imageURLAssetIds: [asset.id] })
}

export function videoAudioSeed(set: ModelSet, asset: MediaManifestEntry, kind: VideoToAudioKind): GenerationInput | null {
  const m = videoToAudioModel(set, kind)
  if (!m || asset.type !== 'video') return null
  return withAudioSourceAsset(base(m.id, { duration: Math.max(0, Math.round(asset.duration)) }), asset)
}

export function audioTransformSeed(set: ModelSet, asset: MediaManifestEntry, kind: AudioTransformKind, durationOverride?: number | null): GenerationInput | null {
  const m = audioTransformModel(set, kind)
  if (!m) return null
  return withAudioSourceAsset(base(m.id, { duration: Math.max(1, Math.round(durationOverride ?? asset.duration)) }), asset)
}

export function transitionSeed(model: VideoModel, firstId: string, lastId: string, gapSeconds: number): GenerationInput {
  return base(model.id, { prompt: TRANSITION_PROMPT, duration: model.nearestSupportedDuration(gapSeconds), imageURLAssetIds: [firstId, lastId] })
}

// ---------- Pending context (§B9.4, §B6.2, §B10) ----------

export interface AudioPlacement {
  timelineId: string
  startFrame: number
  spanSeconds: number
  /** Undo name: `Add Music`, `Add Sound Effects`, `Add Cleaned Voice`, `Add Dubbed Voice`. */
  actionName: string
}

export interface TransitionPlacement {
  timelineId: string
  trackIndex: number
  gapStartFrame: number
  gapLengthFrames: number
}

/** A clip whose visible range is the source (main resolves the file and frames). */
export interface TrimRef {
  timelineId: string
  clipId: string
}

/** Editor-side context captured with a seed and sent with the panel's request. */
export interface PendingContext {
  replacementClipId?: string | null
  /** Timeline of `replacementClipId`. */
  replacementTimelineId?: string | null
  trim?: TrimRef | null
  audioPlacement?: AudioPlacement | null
  transitionPlacement?: TransitionPlacement | null
}

// ---------- Create AI Transition (§B10) ----------

export interface TransitionGap {
  trackIndex: number
  start: number
  end: number
}

/** `aiTransitionAvailability`: null = no menu item; else the model (enabled) or the tooltip (disabled). */
export function transitionAvailability(
  set: ModelSet,
  trackType: string | undefined,
  gap: TransitionGap,
  fps: number,
): { model: VideoModel | null; refusal: string | null } | null {
  const length = gap.end - gap.start
  if (trackType !== 'video' || !(gap.start > 0) || !(length > 0)) return null
  const seconds = length / Math.max(1, fps)
  if (seconds > MAX_TRANSITION_SECONDS) return { model: null, refusal: `Transitions are limited to ${MAX_TRANSITION_SECONDS} seconds. This gap is ${seconds.toFixed(1)} seconds.` }
  const m = firstAndLastFrameModel(set)
  if (!m) return { model: null, refusal: 'No video model supports first and last frames.' }
  if (!m.hasKey) return { model: null, refusal: 'Add an API key for a video model that supports first and last frames.' }
  return { model: m, refusal: null }
}
