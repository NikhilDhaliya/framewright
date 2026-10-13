/**
 * AI generation tools (02 §3.44–3.48 with the Linux deltas of 06 §B13): list_models, generate_video/image/audio and
 * upscale_media over the local BYOK catalog and the generation service (same submission builders as the panel).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { hasKeyFrom } from '../../../core/generation/catalog'
import { modelSet, DRAFT_RESOLUTION, type AudioModel, type ImageModel, type ModelSet, type UpscaleModel, type UpscaleSettings, type VideoModel } from '../../../core/generation/models'
import { compact, type AudioGenerationParams } from '../../../core/generation/params'
import { finalizeGeneratingClips, placeGeneratingAudioClip } from '../../../core/generation/placement'
import { textToVideoReferences, validateAudioParams, validateAudioReferences, validateAudioSpan, validateImage, validateSourceDuration, validateVideo, validateVideoInputs, type RefAsset, type TrimmedSource } from '../../../core/generation/validation'
import type { GenerationInput, MediaManifestEntry } from '../../../core/model'
import { activeTimeline } from '../../../core/ops/context'
import { findClip, sourceFramesConsumed } from '../../../core/timeline'
import { generationService } from '../../generation/service'
import { renderTimelineSpan } from '../../generation/music'
import { canEnhanceDraft, enhanceToast, submitAudio, submitEnhance, submitImage, submitUpscale, submitVideo, withAudioSource } from '../../generation/submissions'
import type { ProjectSession } from '../../project/session'
import type { AppContext } from '../../services'
import { ToolError, isObj, lenient, type Obj } from './args'
import { mutate, ok, okJson, updateQuietly, type ToolEnv, type ToolResult } from './context'
import { resolveOrCreateFolder } from './folders'
import { jsonString } from './json'

export const KEY_REQUIRED = 'Generation requires an API key. Tell the user to add one in Settings ▸ Models & API Keys.'
export const UPSCALE_KEY_REQUIRED = 'Upscale requires an API key. Tell the user to add one in Settings ▸ Models & API Keys.'

const models = (app: AppContext): ModelSet => {
  const s = app.settings()
  return modelSet(hasKeyFrom(s.apiKeys), s.disabledModelIds ?? [])
}

/** `canGenerate` in get_timeline / manage_project: at least one catalog model has a key (§B13). */
export const canGenerate = (app: AppContext): boolean => models(app).canGenerate

const needsKey = (m: { id: string; keyProviderName: string }) => new ToolError(`Model '${m.id}' needs a ${m.keyProviderName} API key. Tell the user to add one in Settings ▸ Models & API Keys.`)

function defaultModel<M extends VideoModel | ImageModel | AudioModel>(set: ModelSet, kind: 'video' | 'image' | 'audio'): M {
  const first = set.available(kind)[0] as M | undefined
  if (!first) throw new ToolError(`No ${kind} model is available. Tell the user to add an API key for one in Settings ▸ Models & API Keys.`)
  return first
}

// ---------- list_models / resources ----------

function videoInfo(m: VideoModel, withType: boolean): Obj {
  const info: Obj = {
    id: m.id,
    displayName: m.displayName,
    durations: m.durations,
    aspectRatios: m.aspectRatios,
    supportsFirstFrame: m.supportsFirstFrame,
    supportsLastFrame: m.supportsLastFrame,
    supportsReferences: m.supportsReferences,
    supportsPrompt: m.supportsPrompt,
  }
  if (withType) info.type = 'video'
  if (m.resolutions) info.resolutions = m.resolutions
  if (m.supportsReferences) {
    if (m.maxReferenceImages > 0) info.maxReferenceImages = m.maxReferenceImages
    if (m.maxReferenceVideos > 0) info.maxReferenceVideos = m.maxReferenceVideos
    if (m.maxReferenceAudios > 0) info.maxReferenceAudios = m.maxReferenceAudios
    if (m.maxTotalReferences != null) info.maxTotalReferences = m.maxTotalReferences
    if (m.maxCombinedVideoRefSeconds != null) info.maxCombinedVideoRefSeconds = Math.trunc(m.maxCombinedVideoRefSeconds)
    if (m.maxCombinedAudioRefSeconds != null) info.maxCombinedAudioRefSeconds = Math.trunc(m.maxCombinedAudioRefSeconds)
    if (m.framesAndReferencesExclusive) info.framesAndReferencesExclusive = true
    info.referenceTagNoun = m.referenceTagNoun
  }
  if (m.requiresSourceVideo) info.requiresSourceVideo = true
  if (m.supportsSourceVideo) info.supportsSourceVideo = true
  if (m.maxSourceVideoSeconds != null) info.maxSourceVideoSeconds = m.maxSourceVideoSeconds
  if (m.requiresReferenceImage) info.requiresReferenceImage = true
  if (m.requiresReferenceAudio) info.requiresReferenceAudio = true
  if (m.usesOutputDuration) info.usesOutputDuration = true
  if (m.supportsDraft) {
    info.supportsDraft = true
    info.draftResolution = DRAFT_RESOLUTION
    info.draftCreditsPerSecond = m.caps.draftCreditsPerSecond
    if (m.caps.draftEnhanceCreditsPerSecond != null) info.draftEnhanceCreditsPerSecond = m.caps.draftEnhanceCreditsPerSecond
  }
  return info
}

function imageInfo(m: ImageModel, withType: boolean): Obj {
  const info: Obj = { id: m.id, displayName: m.displayName, aspectRatios: m.aspectRatios, supportsImageReference: m.supportsImageReference }
  if (withType) info.type = 'image'
  if (m.resolutions) info.resolutions = m.resolutions
  if (m.qualities) info.qualities = m.qualities
  return info
}

function audioInfo(m: AudioModel): Obj {
  const info: Obj = {
    id: m.id,
    displayName: m.displayName,
    type: 'audio',
    category: m.category,
    inputs: m.inputs,
    minPromptLength: m.minPromptLength,
    supportsMultilingual: m.supportsMultilingual,
    supportsLyrics: m.supportsLyrics,
    supportsInstrumental: m.supportsInstrumental,
    supportsStyleInstructions: m.supportsStyleInstructions,
  }
  const voices = m.voices
  if (voices) {
    info.voicesSample = voices.slice(0, 3)
    info.voiceCount = voices.length
  }
  if (m.defaultVoice) info.defaultVoice = m.defaultVoice
  if (m.durations) info.durations = m.durations
  if (m.maxReferenceImages > 0) info.maxReferenceImages = m.maxReferenceImages
  if (m.maxReferenceAudios > 0) info.maxReferenceAudios = m.maxReferenceAudios
  if (m.maxReferenceAudioSeconds != null) info.maxReferenceAudioSeconds = m.maxReferenceAudioSeconds
  if (m.referenceAudioExtensions) info.referenceAudioExtensions = [...new Set(m.referenceAudioExtensions)].sort()
  if (m.referenceImagesAndAudiosExclusive) info.referenceImagesAndAudiosExclusive = true
  if (m.acceptsSourceMedia) {
    info.minSeconds = m.minSeconds
    info.maxSeconds = m.maxSeconds
  }
  if (m.targetLanguages) info.targetLanguages = m.targetLanguages
  return info
}

function upscaleInfo(m: UpscaleModel): Obj {
  const info: Obj = { id: m.id, displayName: m.displayName, type: 'upscale', speed: m.speed, supportedTypes: [...m.supportedTypes].sort() }
  if (m.description) info.description = m.description
  if (m.caps.maximumUpscaleFactor != null) info.maximumUpscaleFactor = m.caps.maximumUpscaleFactor
  info.settings = [
    ...m.selectSettings.map((s) => ({
      id: s.id,
      label: s.label,
      type: 'select',
      default: s.defaultValue,
      options: s.options.map((o) => compact({ value: o.value, label: o.label, description: o.description, group: o.group, groupDescription: o.groupDescription })),
    })),
    ...m.numericSettings.map((s) => ({ id: s.id, label: s.label, type: 'number', minimum: s.minimum, maximum: s.maximum, step: s.step })),
    ...m.toggleSettings.map((s) => ({ id: s.id, label: s.label, type: 'boolean', default: s.defaultValue })),
  ]
  return info
}

export function listModels(env: ToolEnv, args: Obj): ToolResult {
  const filter = lenient.string(args, 'type')
  const set = models(env.app)
  const out: Obj[] = []
  if (!filter || filter === 'video') out.push(...set.available('video').map((m) => videoInfo(m, true)))
  if (!filter || filter === 'image') out.push(...set.available('image').map((m) => imageInfo(m, true)))
  if (!filter || filter === 'audio') out.push(...set.available('audio').map(audioInfo))
  if (!filter || filter === 'upscale') out.push(...set.available('upscale').map(upscaleInfo))
  return okJson({ models: out, loaded: true })
}

/** `resources/read` payloads: every catalog model (not filtered by keys), without `type`, unrounded. */
export function modelResource(uri: string): { uri: string; mimeType?: string; text: string } {
  const all = modelSet(() => false)
  if (uri === 'palmier://models/video') return { uri, mimeType: 'application/json', text: jsonString(all.video.map((m) => videoInfo(m, false))) }
  if (uri === 'palmier://models/image') return { uri, mimeType: 'application/json', text: jsonString(all.image.map((m) => imageInfo(m, false))) }
  return { uri, text: `Unknown resource: ${uri}` }
}

// ---------- Shared argument handling ----------

function asset(env: ToolEnv, id: string, label = 'Media asset'): MediaManifestEntry {
  const e = env.session.doc.manifest.entries.find((x) => x.id === id)
  if (!e) throw new ToolError(`${label} not found: ${id}`)
  return e
}

const refs = (env: ToolEnv, args: Obj, key: string, label: string): MediaManifestEntry[] => lenient.stringArray(args, key).map((id) => asset(env, id, label))

export function refAsset(session: ProjectSession, e: MediaManifestEntry): RefAsset {
  const file = session.resolveMedia(e)
  return { id: e.id, name: e.name, type: e.type, duration: e.duration, ext: file ? path.extname(file).slice(1).toLowerCase() : undefined, path: file }
}

function promptArg(args: Obj): string {
  if (args.prompt !== undefined && typeof args.prompt !== 'string') throw new ToolError('Missing required argument: prompt')
  return (args.prompt as string | undefined) ?? ''
}

function resolveFolder(env: ToolEnv, args: Obj, fallback: MediaManifestEntry[]): string | undefined {
  const folder = lenient.string(args, 'folder')
  if (folder !== undefined) return mutate(env, 'New Folder', (d) => resolveOrCreateFolder(d, folder).id)
  return fallback[fallback.length - 1]?.folderId
}

/** `sourceClipId`: the clip's visible range of the source (active timeline), or null when untrimmed. */
function trimmedSource(env: ToolEnv, args: Obj, source: MediaManifestEntry): TrimmedSource | null {
  const clipId = lenient.string(args, 'sourceClipId')
  if (!clipId) return null
  const t = activeTimeline(env.session.doc)
  const clip = findClip(t, clipId)?.clip
  if (!clip) throw new ToolError(`sourceClipId not found: ${clipId}`)
  if (clip.mediaRef !== source.id) throw new ToolError(`sourceClipId ${clipId} references a different asset than the source`)
  if (source.type !== 'video') throw new ToolError('sourceClipId only applies to video sources')
  if (clip.trimStartFrame <= 0 && clip.trimEndFrame <= 0) return null
  return {
    sourcePath: env.session.resolveMedia(source) ?? '',
    trimStartFrame: clip.trimStartFrame,
    trimEndFrame: clip.trimEndFrame,
    sourceFramesConsumed: sourceFramesConsumed(clip),
    fps: t.fps,
  }
}

function draftMode(args: Obj, m: VideoModel): boolean {
  const draft = lenient.bool(args, 'draft') ?? false
  if (draft && !m.supportsDraft) throw new ToolError(`Model '${m.id}' does not support draft generation.`)
  return draft
}

const fail = (err: string | null) => {
  if (err) throw new ToolError(err)
}

// ---------- generate_video ----------

export function generateVideo(env: ToolEnv, args: Obj): ToolResult {
  const prompt = promptArg(args)
  const set = models(env.app)
  if (!set.keyed('video').length) throw new ToolError(KEY_REQUIRED)
  const svc = generationService(env.app)
  const draftRef = lenient.string(args, 'enhanceDraftMediaRef')
  if (draftRef) {
    const draft = asset(env, draftRef, 'Draft')
    const model = set.findVideo(String(draft.generationInput?.model ?? ''))
    if (!model || !canEnhanceDraft(draft, model)) throw new ToolError(`Asset '${draftRef}' is not a completed enhanceable draft.`)
    const session = env.session
    const [id] = submitEnhance(svc, session, draft, model, { undoLabel: 'FLUX Enhance (Agent)', onComplete: () => env.app.ui(session, { type: 'toast', message: enhanceToast(model) }) })
    return ok(`Draft enhancement started. Placeholder asset ID: ${id}`)
  }
  const modelId = lenient.string(args, 'model') ?? defaultModel<VideoModel>(set, 'video').id
  const model = set.findVideo(modelId)
  if (!model) throw new ToolError(`Unknown model '${modelId}'. Available: ${set.video.map((m) => m.id).join(', ')}`)
  if (!model.hasKey) throw needsKey(model)
  const hasSource = lenient.string(args, 'sourceVideoMediaRef') !== undefined
  if (hasSource && !model.supportsSourceVideo) throw new ToolError(`Model '${model.id}' does not accept a source video.`)
  return model.requiresSourceVideo || hasSource ? generateVideoEdit(env, args, prompt, model) : generateVideoText(env, args, prompt, model)
}

function generateVideoEdit(env: ToolEnv, args: Obj, prompt: string, m: VideoModel): ToolResult {
  const sourceRef = lenient.string(args, 'sourceVideoMediaRef')
  if (!sourceRef) throw new ToolError(`Model '${m.id}' requires 'sourceVideoMediaRef' pointing to a video asset.`)
  const source = asset(env, sourceRef, 'Source video')
  const trim = trimmedSource(env, args, source)
  const imageRefs = refs(env, args, 'referenceImageMediaRefs', 'Reference image')
  const videoRefs = refs(env, args, 'referenceVideoMediaRefs', 'Reference video')
  const audioRefs = refs(env, args, 'referenceAudioMediaRefs', 'Reference audio')
  const s = env.session
  fail(validateVideoInputs(m, { sourceVideo: refAsset(s, source), frames: [], imageRefs: imageRefs.map((r) => refAsset(s, r)), videoRefs: videoRefs.map((r) => refAsset(s, r)), audioRefs: audioRefs.map((r) => refAsset(s, r)) }, trim))
  const sourceVideoDuration = trim ? trim.sourceFramesConsumed / trim.fps : source.duration
  const draft = draftMode(args, m)
  let duration: number
  if (m.usesOutputDuration) duration = lenient.int(args, 'duration') ?? m.durations[0] ?? 0
  else {
    const billing = m.billingDurationSeconds(sourceVideoDuration, audioRefs[0]?.duration)
    if (billing === null) throw new ToolError(m.isLipSync ? 'Replacement audio has an invalid duration.' : 'Source video has an invalid duration.')
    duration = billing
  }
  const aspectRatio = lenient.string(args, 'aspectRatio') ?? m.aspectRatios[0] ?? ''
  const resolution = draft ? DRAFT_RESOLUTION : lenient.string(args, 'resolution') ?? m.resolutions?.[0]
  fail(validateSourceDuration(m, sourceVideoDuration) ?? validateVideo(m, m.usesOutputDuration ? duration : 0, m.usesOutputDuration ? aspectRatio : '', m.usesOutputDuration ? resolution : null))
  const genInput: GenerationInput = compact({ prompt, model: m.id, duration, aspectRatio, resolution, draft: m.supportsDraft ? draft : undefined, usesSourceVideo: true })
  const [id] = submitVideo(generationService(env.app), {
    session: s,
    model: m,
    genInput,
    inputs: { sourceVideo: source, frames: [], imageRefs, videoRefs, audioRefs },
    placeholderDuration: m.usesOutputDuration ? Math.max(1, duration) : sourceVideoDuration,
    trim,
    name: lenient.string(args, 'name'),
    folderId: source.folderId,
    generateAudio: true,
    undoLabel: 'Generate Video (Agent)',
  })
  return ok(`Edit started. Placeholder asset ID: ${id}. Model: ${m.displayName}, source: ${source.name}${draft ? ', draft: true' : ''}`)
}

function generateVideoText(env: ToolEnv, args: Obj, prompt: string, m: VideoModel): ToolResult {
  if (!prompt) throw new ToolError('Empty prompt')
  const draft = draftMode(args, m)
  const duration = lenient.int(args, 'duration') ?? m.durations[0] ?? 0
  const aspectRatio = lenient.string(args, 'aspectRatio') ?? m.aspectRatios[0] ?? ''
  const resolution = draft ? DRAFT_RESOLUTION : lenient.string(args, 'resolution') ?? m.resolutions?.[0]
  fail(validateVideo(m, duration, aspectRatio, resolution))
  const frames: MediaManifestEntry[] = []
  const startRef = lenient.string(args, 'startFrameMediaRef')
  if (startRef) frames.push(asset(env, startRef, 'Start frame'))
  const endRef = lenient.string(args, 'endFrameMediaRef')
  if (endRef) frames.push(asset(env, endRef, 'End frame'))
  const imageRefs = refs(env, args, 'referenceImageMediaRefs', 'Image reference')
  const videoRefs = refs(env, args, 'referenceVideoMediaRefs', 'Video reference')
  const audioRefs = refs(env, args, 'referenceAudioMediaRefs', 'Audio reference')
  const s = env.session
  const ra = (x: MediaManifestEntry[]) => x.map((r) => refAsset(s, r))
  const inputs = { frames: ra(frames), imageRefs: ra(imageRefs), videoRefs: ra(videoRefs), audioRefs: ra(audioRefs) }
  fail(validateVideoInputs(m, inputs))
  const all = [...frames, ...imageRefs, ...videoRefs, ...audioRefs]
  const folderId = resolveFolder(env, args, textToVideoReferences(inputs).map((r) => all.find((x) => x.id === r.id)!))
  const genInput: GenerationInput = compact({ prompt, model: m.id, duration, aspectRatio, resolution, draft: m.supportsDraft ? draft : undefined })
  const [id] = submitVideo(generationService(env.app), {
    session: s,
    model: m,
    genInput,
    inputs: { frames, imageRefs, videoRefs, audioRefs },
    placeholderDuration: Math.max(1, duration),
    name: lenient.string(args, 'name'),
    folderId,
    generateAudio: true,
    undoLabel: 'Generate Video (Agent)',
  })
  const total = imageRefs.length + videoRefs.length + audioRefs.length
  const refSummary = total > 0 ? `, refs: ${imageRefs.length}img/${videoRefs.length}vid/${audioRefs.length}aud` : ''
  return ok(`Generation started. Placeholder asset ID: ${id}. Model: ${m.displayName}, duration: ${duration}s, aspect: ${aspectRatio}${refSummary}${draft ? ', draft: true' : ''}`)
}

// ---------- generate_image ----------

export function generateImage(env: ToolEnv, args: Obj): ToolResult {
  const prompt = promptArg(args)
  const set = models(env.app)
  if (!set.keyed('image').length) throw new ToolError(KEY_REQUIRED)
  if (!prompt) throw new ToolError('Empty prompt')
  const modelId = lenient.string(args, 'model') ?? defaultModel<ImageModel>(set, 'image').id
  const m = set.findImage(modelId)
  if (!m) throw new ToolError(`Unknown model '${modelId}'. Available: ${set.image.map((x) => x.id).join(', ')}`)
  if (!m.hasKey) throw needsKey(m)
  const aspectRatio = lenient.string(args, 'aspectRatio') ?? m.aspectRatios[0] ?? ''
  const resolution = lenient.string(args, 'resolution') ?? m.resolutions?.[0]
  const quality = lenient.string(args, 'quality') ?? m.qualities?.[m.qualities.length - 1]
  const refIds = lenient.stringArray(args, 'referenceMediaRefs')
  fail(validateImage(m, aspectRatio, resolution, quality, refIds.length, 1))
  const references = refIds.map((id) => {
    const a = asset(env, id, 'Reference image')
    if (a.type !== 'image') throw new ToolError(`referenceMediaRefs entry '${id}' must be an image asset (got ${a.type})`)
    return a
  })
  const folderId = resolveFolder(env, args, references)
  const [id] = submitImage(generationService(env.app), {
    session: env.session,
    model: m,
    genInput: compact({ prompt, model: m.id, duration: 0, aspectRatio, resolution, quality }),
    references,
    numImages: 1,
    name: lenient.string(args, 'name'),
    folderId,
    undoLabel: 'Generate Image (Agent)',
  })
  return ok(`Generation started. Placeholder asset ID: ${id}. Model: ${m.displayName}, aspect: ${aspectRatio}`)
}

// ---------- generate_audio ----------

/** Renders a silent, low-quality 240p MP4 of a span of the active timeline (§B8). */
async function renderSpan(env: ToolEnv, start: number, end: number): Promise<string> {
  try {
    return await renderTimelineSpan(env.app, env.session, activeTimeline(env.session.doc).id, start, end)
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : String(e))
  }
}

export async function generateAudio(env: ToolEnv, args: Obj): Promise<ToolResult> {
  const set = models(env.app)
  if (!set.keyed('audio').length) throw new ToolError(KEY_REQUIRED)
  const modelId = lenient.string(args, 'model') ?? defaultModel<AudioModel>(set, 'audio').id
  const m = set.findAudio(modelId)
  if (!m) throw new ToolError(`Unknown model '${modelId}'. Available: ${set.audio.map((x) => x.id).join(', ')}`)
  if (!m.hasKey) throw needsKey(m)
  const s = env.session
  const prompt = (lenient.string(args, 'prompt') ?? '').replace(/^[ \t]+|[ \t]+$/g, '')
  const imageRefs = lenient.stringArray(args, 'referenceImageMediaRefs').map((id) => asset(env, id, 'Image reference'))
  const audioRefs = lenient.stringArray(args, 'referenceAudioMediaRefs').map((id) => asset(env, id, 'Audio reference'))
  fail(validateAudioReferences(m, imageRefs.map((r) => refAsset(s, r)), audioRefs.map((r) => refAsset(s, r))))
  const sourceRef = lenient.string(args, 'sourceMediaRef') ?? lenient.string(args, 'videoSourceMediaRef')
  let source: MediaManifestEntry | undefined
  let videoURL: string | undefined
  let spanSeconds: number | undefined
  let placementStart: number | undefined
  if (sourceRef) {
    const candidate = asset(env, sourceRef, 'Source media')
    if (lenient.string(args, 'sourceMediaRef') === undefined && candidate.type !== 'video') throw new ToolError(`videoSourceMediaRef must be a video asset (got ${candidate.type}).`)
    if (!m.acceptsSource(candidate.type)) throw new ToolError(`Model '${m.id}' does not accept ${candidate.type} source media.`)
    if (m.usesSourceURL && candidate.type === 'video' && !candidate.hasAudio) throw new ToolError(`${m.displayName} requires source video with an audio track.`)
    fail(validateAudioSpan(m, candidate.duration))
    source = candidate
    spanSeconds = candidate.duration
  } else {
    const start = lenient.int(args, 'videoSourceStartFrame')
    const end = lenient.int(args, 'videoSourceEndFrame')
    if (start !== undefined && end !== undefined) {
      if (!m.inputs.includes('video')) throw new ToolError(`Model '${m.id}' does not accept a video input (see list_models 'inputs').`)
      if (m.usesSourceURL) throw new ToolError(`Use sourceMediaRef for ${m.displayName}.`)
      if (!(start >= 0 && end > start)) throw new ToolError('videoSourceEndFrame must be greater than videoSourceStartFrame (>= 0).')
      const fps = Math.max(1, activeTimeline(s.doc).fps)
      fail(validateAudioSpan(m, (end - start) / fps))
      const mp4 = await renderSpan(env, start, end)
      try {
        videoURL = await generationService(env.app).uploadFile(m.route!.provider, mp4, 'video')
      } finally {
        await fs.rm(mp4, { force: true })
      }
      spanSeconds = (end - start) / fps
      placementStart = start
    }
  }
  if (m.acceptsSourceMedia && !m.inputs.includes('text') && !source && !videoURL) throw new ToolError(`Model '${m.id}' needs source media. Provide sourceMediaRef.`)
  const instrumental = lenient.bool(args, 'instrumental') ?? false
  const requested = lenient.int(args, 'duration')
  const sourceSeconds = spanSeconds !== undefined ? Math.max(1, Math.round(spanSeconds)) : undefined
  const durationSeconds = m.usesSourceURL ? sourceSeconds : requested ?? sourceSeconds
  const params: AudioGenerationParams = compact({
    kind: 'audio' as const,
    prompt,
    voice: m.acceptsVoice ? lenient.string(args, 'voice') ?? m.defaultVoice ?? undefined : undefined,
    lyrics: m.supportsLyrics ? lenient.string(args, 'lyrics') : undefined,
    styleInstructions: m.supportsStyleInstructions ? lenient.string(args, 'styleInstructions') : undefined,
    instrumental: m.supportsInstrumental ? instrumental : false,
    durationSeconds,
    videoURL,
    targetLanguage: m.targetLanguages ? lenient.string(args, 'targetLanguage') : undefined,
    multilingual: m.supportsMultilingual ? lenient.bool(args, 'multilingual') ?? false : undefined,
  })
  fail(validateAudioParams(m, params))
  let genInput: GenerationInput = compact({
    prompt,
    model: m.id,
    duration: durationSeconds ?? 0,
    aspectRatio: '',
    voice: params.voice,
    lyrics: params.lyrics,
    styleInstructions: params.styleInstructions,
    instrumental: m.supportsInstrumental ? instrumental : undefined,
    targetLanguage: params.targetLanguage,
    multilingual: params.multilingual,
    audioInput: source ? source.type : videoURL ? 'video' : 'text',
  })
  if (source) genInput = withAudioSource(genInput, source)
  const references = m.supportsReferences ? [...imageRefs, ...audioRefs] : source ? [source] : []
  const folderId = resolveFolder(env, args, [...(source ? [source] : []), ...imageRefs, ...audioRefs])
  const svc = generationService(env.app)
  const base = { session: s, model: m, genInput, params, references, name: lenient.string(args, 'name'), folderId }
  if (placementStart !== undefined && spanSeconds !== undefined) {
    const outputSpan = requested ?? spanSeconds
    const timelineId = activeTimeline(s.doc).id
    const label = m.categoryLabel
    const [id] = submitAudio(svc, {
      ...base,
      undoLabel: `Add ${label} (Agent)`,
      place: (d, ids) => {
        placeGeneratingAudioClip(d, timelineId, ids[0], placementStart!, outputSpan)
      },
      onComplete: (a) => updateQuietly(s, (d) => finalizeGeneratingClips(d, a.id, a.duration)),
    })
    return ok(`Generation started and placed on the timeline at frame ${placementStart}. Placeholder asset ID: ${id}. Model: ${m.displayName}, ${label} (scored from video).`)
  }
  const [id] = submitAudio(svc, { ...base, undoLabel: 'Generate Audio (Agent)' })
  const note = source || videoURL ? ' (from source media)' : ''
  return ok(`Generation started. Placeholder asset ID: ${id}. Model: ${m.displayName}, ${m.categoryLabel}${note}. Place it with add_clips.`)
}

// ---------- upscale_media ----------

function resolvedUpscaleSettings(raw: unknown, m: UpscaleModel, source: MediaManifestEntry): UpscaleSettings {
  if (raw !== undefined && !isObj(raw)) throw new ToolError('settings must be an object')
  const supplied = (raw ?? {}) as Obj
  const resolved = m.normalizedSettings(m.defaultSettings, source)
  for (const [id, value] of Object.entries(supplied)) {
    const select = m.selectSettings.find((x) => x.id === id)
    if (select) {
      const options = m.availableOptions(select, source)
      if (typeof value !== 'string' || !options.some((o) => o.value === value)) throw new ToolError(`Unsupported ${id}. Available: ${options.map((o) => o.value).join(', ')}`)
      resolved.selections[id] = value
      continue
    }
    const numeric = m.numericSettings.find((x) => x.id === id)
    if (numeric) {
      const v = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      if (!Number.isFinite(v) || v < numeric.minimum || v > numeric.maximum) throw new ToolError(`${id} must be between ${numeric.minimum} and ${numeric.maximum}`)
      resolved.numbers[id] = v
      continue
    }
    if (m.toggleSettings.some((x) => x.id === id)) {
      if (typeof value !== 'boolean') throw new ToolError(`${id} must be true or false`)
      resolved.toggles[id] = value
      continue
    }
    const valid = [...m.selectSettings, ...m.numericSettings, ...m.toggleSettings].map((x) => x.id).join(', ')
    throw new ToolError(`Unknown upscale setting '${id}'. Available: ${valid}`)
  }
  return resolved
}

export function upscaleMedia(env: ToolEnv, args: Obj): ToolResult {
  const source = asset(env, lenient.requireString(args, 'mediaRef'))
  if (source.type !== 'video' && source.type !== 'image') throw new ToolError(`Upscale supports video and image assets only (got ${source.type})`)
  if (source.sourceWidth == null || source.sourceHeight == null) throw new ToolError('Source dimensions are not available yet. Poll get_media until the asset is ready.')
  if (source.type === 'video' && source.sourceFPS == null) throw new ToolError('Source FPS is not available yet. Poll get_media until the asset is ready.')
  const set = models(env.app)
  if (!set.keyed('upscale').length) throw new ToolError(UPSCALE_KEY_REQUIRED)
  const forType = set.upscale.filter((m) => m.supportedTypes.includes(source.type))
  const requested = lenient.string(args, 'model')
  let m: UpscaleModel
  if (requested) {
    const match = forType.find((x) => x.id === requested)
    if (!match) throw new ToolError(`Model '${requested}' does not support ${source.type}. Available: ${forType.map((x) => x.id).join(', ')}`)
    if (!match.hasKey) throw needsKey(match)
    if (!match.supports(source)) throw new ToolError(`Model '${requested}' is not compatible with this source's resolution or frame rate.`)
    m = match
  } else {
    const first = forType.find((x) => set.isAvailable(x) && x.supports(source))
    if (!first) throw new ToolError(`No compatible upscaler is available for this ${source.type} on the current plan.`)
    m = first
  }
  const settings = resolvedUpscaleSettings(args.settings, m, source)
  const trim = trimmedSource(env, args, source)
  let ids: string[]
  try {
    ids = submitUpscale(generationService(env.app), { session: env.session, model: m, source, settings, trim, undoLabel: 'Upscale (Agent)' })
  } catch {
    throw new ToolError('Failed to start upscale')
  }
  return ok(`Upscale started. Placeholder asset ID: ${ids[0]}. Model: ${m.displayName}, source: ${source.name}${trim ? ' (trimmed range)' : ''}`)
}
