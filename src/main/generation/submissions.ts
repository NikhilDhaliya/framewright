/**
 * Submission builders shared by the Generate panel and the agent tools (Mac `VideoGenerationSubmission`,
 * `ImageGenerationSubmission`, `AudioGenerationSubmission`, `EditSubmitter.submitUpscale`; spec 06 §B4.3).
 * Callers validate first; these assemble the persisted `GenerationInput`, slot order and job params.
 */
import path from 'node:path'
import type { AudioModel, ImageModel, UpscaleModel, UpscaleSettings, VideoModel } from '../../core/generation/models'
import { compact, type AudioGenerationParams } from '../../core/generation/params'
import { resultURLsOf } from '../../core/generation/status'
import { hasTrim, trimSeconds, type TrimmedSource } from '../../core/generation/validation'
import { DEFAULTS, type GenerationInput, type MediaManifestEntry } from '../../core/model'
import type { Doc } from '../../core/ops/context'
import type { ProjectSession } from '../project/session'
import { downscaleReferenceVideo, extractAudioTrack, transcodeSourceIfNeeded } from './preprocess'
import { refDateNow, type GenerationService } from './service'

/** Placeholder lengths for audio without a duration (`Utilities/Constants.swift:43-45`). */
export const AUDIO_MUSIC_DURATION_SECONDS = 60
export const AUDIO_TTS_DURATION_SECONDS = 10

const ids = (a: MediaManifestEntry[]): string[] | undefined => (a.length ? a.map((x) => x.id) : undefined)

export interface Callbacks {
  undoLabel: string
  place?: (draft: Doc, placeholderIds: string[]) => void
  onComplete?: (asset: MediaManifestEntry) => void
  onFailure?: () => void
}

function requireRoute<M extends { route: unknown; displayName: string; keyProviderName: string; id: string }>(m: M): NonNullable<M['route']> {
  if (!m.route) throw new Error(`Model '${m.id}' needs a ${m.keyProviderName} API key. Tell the user to add one in Settings ▸ Models & API Keys.`)
  return m.route as NonNullable<M['route']>
}

// ---------- Video ----------

export interface VideoInputs {
  sourceVideo?: MediaManifestEntry | null
  frames: MediaManifestEntry[]
  imageRefs: MediaManifestEntry[]
  videoRefs: MediaManifestEntry[]
  audioRefs: MediaManifestEntry[]
}

export interface VideoSubmission extends Callbacks {
  session: ProjectSession
  model: VideoModel
  genInput: GenerationInput
  inputs: VideoInputs
  placeholderDuration: number
  trim?: TrimmedSource | null
  name?: string
  folderId?: string | null
  generateAudio: boolean
}

function sliceUploaded(uploaded: string[], frames: number, images: number, videos: number, audios: number) {
  const rest = uploaded.slice(frames)
  return {
    frames: uploaded.slice(0, frames),
    imageRefs: rest.slice(0, images),
    videoRefs: rest.slice(images, images + videos),
    audioRefs: rest.slice(images + videos, images + videos + audios),
  }
}

export function submitVideo(svc: GenerationService, s: VideoSubmission): string[] {
  const route = requireRoute(s.model)
  const m = s.model
  const { inputs } = s
  const name = s.name ?? (m.supportsPrompt ? undefined : m.displayName)
  const counts = [inputs.imageRefs.length, inputs.videoRefs.length, inputs.audioRefs.length] as const
  const base: GenerationInput = compact({
    ...s.genInput,
    referenceImageAssetIds: ids(inputs.imageRefs),
    referenceVideoAssetIds: ids(inputs.videoRefs),
    referenceAudioAssetIds: ids(inputs.audioRefs),
  })
  const snapshot = (frameCount: number) => (input: GenerationInput, uploaded: string[]): GenerationInput => {
    const u = sliceUploaded(uploaded, frameCount, ...counts)
    return compact({ ...input, imageURLs: u.frames, referenceImageURLs: u.imageRefs, referenceVideoURLs: u.videoRefs, referenceAudioURLs: u.audioRefs })
  }
  if (m.requiresSourceVideo || inputs.sourceVideo) {
    const source = inputs.sourceVideo!
    const sourceVideoDuration = hasTrim(s.trim) ? trimSeconds(s.trim) : source.duration
    const caps = m.caps
    const needsTranscode = !!caps.maxSourceVideoResolution || !!caps.requiredSourceVideoEncoding
    return svc.generate({
      ...s,
      entry: m.entry,
      route,
      name,
      genInput: { ...base, imageURLAssetIds: [source.id] },
      assetType: 'video',
      fileExtension: 'mp4',
      references: [source, ...inputs.imageRefs, ...inputs.videoRefs, ...inputs.audioRefs],
      preprocessSourceVideo: needsTranscode ? (file, signal) => transcodeSourceIfNeeded(file, caps.maxSourceVideoResolution, caps.requiredSourceVideoEncoding, signal) : undefined,
      snapshotRefs: snapshot(1),
      buildParams: (uploaded) => {
        const u = sliceUploaded(uploaded, 1, ...counts)
        return compact({
          kind: 'video' as const,
          prompt: s.genInput.prompt,
          duration: s.genInput.duration,
          sourceVideoDuration,
          aspectRatio: s.genInput.aspectRatio,
          resolution: s.genInput.resolution as string | undefined,
          sourceVideoURL: u.frames[0],
          referenceImageURLs: u.imageRefs,
          referenceVideoURLs: u.videoRefs,
          referenceAudioURLs: u.audioRefs,
          generateAudio: s.generateAudio,
          draft: s.genInput.draft as boolean | undefined,
        })
      },
    })
  }
  const frameCount = inputs.frames.length
  return svc.generate({
    ...s,
    entry: m.entry,
    route,
    name,
    genInput: compact({ ...base, imageURLAssetIds: ids(inputs.frames) }),
    assetType: 'video',
    fileExtension: 'mp4',
    references: [...inputs.frames, ...inputs.imageRefs, ...inputs.videoRefs, ...inputs.audioRefs],
    // A trimmed extract may already sit in the slot; the downscale chains onto it.
    preprocessRef: inputs.videoRefs.length ? (_i, ref, file, signal) => (ref.type === 'video' ? downscaleReferenceVideo(file, signal) : Promise.resolve(null)) : undefined,
    snapshotRefs: snapshot(frameCount),
    buildParams: (uploaded) => {
      const u = sliceUploaded(uploaded, frameCount, ...counts)
      return compact({
        kind: 'video' as const,
        prompt: s.genInput.prompt,
        duration: s.genInput.duration,
        aspectRatio: s.genInput.aspectRatio,
        resolution: s.genInput.resolution as string | undefined,
        startFrameURL: u.frames[0],
        endFrameURL: u.frames[1],
        referenceImageURLs: u.imageRefs,
        referenceVideoURLs: u.videoRefs,
        referenceAudioURLs: u.audioRefs,
        generateAudio: s.generateAudio,
        draft: s.genInput.draft as boolean | undefined,
      })
    },
  })
}

// ---------- Image ----------

export interface ImageSubmission extends Callbacks {
  session: ProjectSession
  model: ImageModel
  genInput: GenerationInput
  references: MediaManifestEntry[]
  numImages: number
  name?: string
  folderId?: string | null
}

export function submitImage(svc: GenerationService, s: ImageSubmission): string[] {
  const route = requireRoute(s.model)
  return svc.generate({
    ...s,
    entry: s.model.entry,
    route,
    genInput: compact({ ...s.genInput, imageURLAssetIds: ids(s.references) }),
    assetType: 'image',
    fileExtension: 'jpg',
    placeholderDuration: DEFAULTS.imageDurationSeconds,
    references: s.references,
    buildParams: (uploaded) =>
      compact({
        kind: 'image' as const,
        prompt: s.genInput.prompt,
        aspectRatio: s.genInput.aspectRatio,
        resolution: s.genInput.resolution as string | undefined,
        quality: s.genInput.quality as string | undefined,
        imageURLs: uploaded,
        numImages: s.numImages,
      }),
  })
}

// ---------- Audio ----------

export interface AudioSubmission extends Callbacks {
  session: ProjectSession
  model: AudioModel
  genInput: GenerationInput
  params: AudioGenerationParams
  /** Reference models: image refs then audio refs; source models: the source asset. */
  references: MediaManifestEntry[]
  trim?: TrimmedSource | null
  name?: string
  folderId?: string | null
}

export function audioPlaceholderDuration(m: AudioModel, p: AudioGenerationParams): number {
  if (p.durationSeconds != null) return p.durationSeconds
  return m.category === 'music' ? AUDIO_MUSIC_DURATION_SECONDS : AUDIO_TTS_DURATION_SECONDS
}

/** `setAudioSourceAsset`: audio → referenceAudioAssetIds, video → referenceVideoAssetIds. */
export function withAudioSource(input: GenerationInput, source: MediaManifestEntry): GenerationInput {
  const next = { ...input }
  if (source.type === 'audio') {
    next.referenceAudioAssetIds = [source.id]
    delete next.referenceVideoAssetIds
  } else if (source.type === 'video') {
    next.referenceVideoAssetIds = [source.id]
    delete next.referenceAudioAssetIds
  }
  return next
}

export function submitAudio(svc: GenerationService, s: AudioSubmission): string[] {
  const route = requireRoute(s.model)
  const m = s.model
  const usesRefs = m.supportsReferences
  let genInput = s.genInput
  if (usesRefs) {
    genInput = compact({
      ...genInput,
      referenceImageAssetIds: ids(s.references.filter((r) => r.type === 'image')),
      referenceAudioAssetIds: ids(s.references.filter((r) => r.type === 'audio')),
    })
  }
  const imageCount = usesRefs ? s.references.filter((r) => r.type === 'image').length : 0
  const extract = !usesRefs && s.references.length > 0 && m.usesSourceURL && (s.references[0].type === 'video' || hasTrim(s.trim))
  const extractionTrim = extract ? s.trim : null
  const split = (uploaded: string[]) => ({ image: imageCount > 0 ? uploaded[0] : undefined, audio: uploaded.slice(imageCount) })
  return svc.generate({
    ...s,
    entry: m.entry,
    route,
    genInput,
    assetType: 'audio',
    fileExtension: 'mp3',
    placeholderDuration: audioPlaceholderDuration(m, s.params),
    references: s.references,
    trim: extract ? null : s.trim,
    preprocessRef: extract ? (i, _ref, file, signal) => (i === 0 ? extractAudioTrack(file, extractionTrim, signal) : Promise.resolve(null)) : undefined,
    snapshotRefs: usesRefs
      ? (input, uploaded) => {
          const r = split(uploaded)
          return compact({ ...input, referenceImageURLs: r.image ? [r.image] : undefined, referenceAudioURLs: r.audio })
        }
      : undefined,
    buildParams: (uploaded) => {
      const p: AudioGenerationParams = { ...s.params }
      if (usesRefs) {
        const r = split(uploaded)
        p.referenceImageURL = r.image
        p.referenceAudioURLs = r.audio.length ? r.audio : undefined
      } else if (uploaded.length) {
        if (m.usesSourceURL && !p.sourceURL) p.sourceURL = uploaded[0]
        else if (!p.videoURL) p.videoURL = uploaded[0]
      }
      return compact(p)
    },
  })
}

// ---------- Upscale ----------

export const effectiveSeconds = (asset: MediaManifestEntry, trim: TrimmedSource | null | undefined): number =>
  Math.max(1, Math.round(hasTrim(trim) ? trimSeconds(trim) : asset.duration))

/** `prefixedName` (`EditSubmitter.swift:15-21`). */
export function prefixedName(prefix: string, name: string): string {
  const strip = ['Upscaled ', 'Edited ', 'Rerun '].find((p) => name.startsWith(p))
  return `${prefix} ${strip ? name.slice(strip.length) : name}`
}

export interface UpscaleSubmission extends Callbacks {
  session: ProjectSession
  model: UpscaleModel
  source: MediaManifestEntry
  settings: UpscaleSettings
  trim?: TrimmedSource | null
}

export function submitUpscale(svc: GenerationService, s: UpscaleSubmission): string[] {
  const route = requireRoute(s.model)
  const a = s.source
  const isImage = a.type === 'image'
  const seconds = effectiveSeconds(a, s.trim)
  const genInput: GenerationInput = compact({
    prompt: '',
    model: s.model.id,
    duration: seconds,
    aspectRatio: '',
    upscaleSettings: s.settings,
    imageURLAssetIds: [a.id],
    upscaleSourceWidth: a.sourceWidth,
    upscaleSourceHeight: a.sourceHeight,
    upscaleSourceFPS: a.sourceFPS,
  })
  const placeholderDuration = isImage ? DEFAULTS.imageDurationSeconds : hasTrim(s.trim) ? trimSeconds(s.trim) : a.duration > 0 ? a.duration : seconds
  return svc.generate({
    ...s,
    entry: s.model.entry,
    route,
    genInput,
    assetType: a.type,
    fileExtension: isImage ? 'jpg' : 'mp4',
    placeholderDuration,
    references: [a],
    name: prefixedName('Upscaled', a.name),
    folderId: a.folderId,
    snapshotRefs: (input, uploaded) => compact({ ...input, imageURLs: uploaded, imageURLAssetIds: [a.id] }),
    buildParams: (uploaded) =>
      compact({
        kind: 'upscale' as const,
        sourceURL: uploaded[0] ?? '',
        durationSeconds: isImage ? 1 : seconds,
        sourceWidth: a.sourceWidth,
        sourceHeight: a.sourceHeight,
        sourceFPS: a.sourceFPS,
        settings: s.settings,
      }),
  })
}

// ---------- FLUX Enhance (§B9.6) ----------

export const canEnhanceDraft = (e: MediaManifestEntry, model: VideoModel | undefined): boolean =>
  !e.generationStatus && e.generationInput?.draft === true && !!e.generationInput.byokJob && resultURLsOf(e.generationInput).length >= 2 && !!model?.route?.endpoints.enhance

export function submitEnhance(svc: GenerationService, session: ProjectSession, draft: MediaManifestEntry, model: VideoModel, cb: Callbacks): string[] {
  const route = requireRoute(model)
  const input: GenerationInput = { ...draft.generationInput!, draft: false, resolution: '1080p', createdAt: refDateNow() }
  for (const k of ['backendJobId', 'byokJob', 'resultURLs', 'costCredits', 'refundedCredits', 'outputIndex']) delete input[k]
  const urls = resultURLsOf(draft.generationInput)
  return svc.generate({
    ...cb,
    session,
    entry: model.entry,
    route,
    genInput: input,
    assetType: 'video',
    fileExtension: 'mp4',
    placeholderDuration: draft.duration,
    references: [],
    name: `${draft.name} 1080p`,
    folderId: draft.folderId,
    snapshotRefs: (i) => i,
    buildParams: () => ({ kind: 'enhance', resultURLs: urls }),
  })
}

export const enhanceToast = (model: VideoModel): string => (model.id.startsWith('seedance') ? 'Enhanced with Seedance 2.5 at 1080p.' : 'Enhanced with FLUX.3 at 1080p.')

export const extOf = (file: string): string => path.extname(file).slice(1).toLowerCase()
