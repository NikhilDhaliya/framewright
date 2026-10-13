/**
 * Generate panel behaviour (spec 06 §B7) as pure functions over the panel state: defaults, reset rules, model
 * normalization, settings summary, submit enablement, request building and seeding. The store applies them.
 */
import { aspectRatioDisplayLabel, capitalize, resolutionDisplayLabel } from '@core/generation/labels'
import { AUDIO_CATEGORY_ORDER, DRAFT_RESOLUTION, type AnyModel, type AudioModel, type ImageModel, type ModelSet, type UpscaleModel, type UpscaleSettings, type VideoModel } from '@core/generation/models'
import type { GenerateRequest, VideoInputMode } from '@core/generation/requests'
import { referenceTags } from '@core/generation/tags'
import type { ClipType, GenerationInput, MediaManifestEntry } from '@core/model'
import { stringList } from '@core/generation/status'
import { t, tk } from '../i18n'

export type GenType = 'video' | 'image' | 'audio' | 'upscale'

export interface PanelState {
  type: GenType
  modelIds: Record<GenType, string | null>
  prompt: string
  duration: number
  aspectRatio: string
  resolution: string
  quality: string
  numImages: number
  voice: string
  lyrics: string
  styleInstructions: string
  instrumental: boolean
  audioDuration: number
  targetLanguage: string
  multilingual: boolean
  generateAudio: boolean
  draft: boolean
  upscaleSettings: UpscaleSettings
  videoMode: VideoInputMode
  frames: [string | null, string | null]
  imageRefs: string[]
  videoRefs: string[]
  audioRefs: string[]
  sourceVideo: string | null
  audioSource: string | null
  upscaleSource: string | null
  editFolderId: string | null
}

export const EMPTY_UPSCALE: UpscaleSettings = { selections: {}, numbers: {}, toggles: {} }

/** §B7.1 defaults. */
export function initialPanelState(): PanelState {
  return {
    type: 'video',
    modelIds: { video: null, image: null, audio: null, upscale: null },
    prompt: '',
    duration: 5,
    aspectRatio: '16:9',
    resolution: '1080p',
    quality: 'high',
    numImages: 1,
    voice: '',
    lyrics: '',
    styleInstructions: '',
    instrumental: false,
    audioDuration: 30,
    targetLanguage: '',
    multilingual: false,
    generateAudio: true,
    draft: false,
    upscaleSettings: EMPTY_UPSCALE,
    videoMode: 'frames',
    frames: [null, null],
    imageRefs: [],
    videoRefs: [],
    audioRefs: [],
    sourceVideo: null,
    audioSource: null,
    upscaleSource: null,
    editFolderId: null,
  }
}

export const clearedReferences = (): Pick<PanelState, 'frames' | 'imageRefs' | 'videoRefs' | 'audioRefs' | 'sourceVideo' | 'audioSource' | 'upscaleSource'> => ({
  frames: [null, null],
  imageRefs: [],
  videoRefs: [],
  audioRefs: [],
  sourceVideo: null,
  audioSource: null,
  upscaleSource: null,
})

// ---------- Models ----------

export function availableModels(set: ModelSet, type: GenType): AnyModel[] {
  return set.available(type) as AnyModel[]
}

export function selectedModel(set: ModelSet, s: PanelState): AnyModel | null {
  const id = s.modelIds[s.type]
  const list = availableModels(set, s.type)
  return list.find((m) => m.id === id) ?? list[0] ?? null
}

/** `normalizeModelSelection`: keep the selection when available, else the first available. */
export function normalizeModel(set: ModelSet, s: PanelState, type: GenType = s.type): string | null {
  const list = availableModels(set, type)
  const id = s.modelIds[type]
  return list.some((m) => m.id === id) ? id : list[0]?.id ?? null
}

/** `catalogReady` (Linux): the panel shows models only when some kind has an available model (§B7.2). */
export function visibleTypes(set: ModelSet): GenType[] {
  return (['image', 'video', 'audio', 'upscale'] as GenType[]).filter((t) => availableModels(set, t).length > 0)
}

export interface MenuGroup {
  header: string | null
  iconKey?: string
  models: AnyModel[]
}

/** Picker grouping (§B7.3): video by provider, audio by category, upscale Image then Video, image flat. */
export function modelGroups(set: ModelSet, type: GenType): MenuGroup[] {
  const list = availableModels(set, type)
  if (type === 'video') {
    const groups: MenuGroup[] = []
    for (const m of list) {
      const header = m.providerName ?? t('Other')
      const g = groups.find((x) => x.header === header)
      if (g) g.models.push(m)
      else groups.push({ header, iconKey: m.providerIconKey, models: [m] })
    }
    return groups
  }
  if (type === 'audio') {
    return AUDIO_CATEGORY_ORDER.map((c) => {
      const models = (list as AudioModel[]).filter((m) => m.category === c)
      return { header: models[0]?.categoryLabel ?? c, models }
    }).filter((g) => g.models.length > 0)
  }
  if (type === 'upscale') {
    return (['image', 'video'] as const)
      .map((k) => ({ header: k === 'image' ? t('Image') : t('Video'), models: (list as UpscaleModel[]).filter((m) => m.supportedTypes.includes(k)) }))
      .filter((g) => g.models.length > 0)
  }
  return [{ header: null, models: list }]
}

// ---------- Reset rules (§B7.4) ----------

export function resetSettings(s: PanelState, m: AnyModel | null, seeding = false): Partial<PanelState> {
  if (!m) return {}
  const patch: Partial<PanelState> = {}
  if (m.kind === 'video' || m.kind === 'image') {
    const vm = m as VideoModel | ImageModel
    if (vm.aspectRatios.length && !vm.aspectRatios.includes(s.aspectRatio)) patch.aspectRatio = vm.aspectRatios[0] ?? '16:9'
    const res = vm.resolutions
    if (res?.length && !res.includes(s.resolution)) patch.resolution = res[0] ?? '1080p'
  }
  if (m.kind === 'image') {
    const im = m as ImageModel
    const q = im.qualities
    if (q?.length && !q.includes(s.quality)) patch.quality = q[q.length - 1] ?? 'high'
    patch.numImages = Math.max(1, Math.min(im.maxImages, s.numImages))
  }
  if (m.kind === 'video') {
    const vm = m as VideoModel
    if (vm.durations.length && !vm.durations.includes(s.duration)) patch.duration = vm.durations[0] ?? 5
    patch.generateAudio = true
    if (!seeding) patch.videoMode = vm.requiresSourceVideo ? 'source' : 'frames'
    patch.draft = seeding && vm.supportsDraft ? s.draft : false
  }
  if (m.kind === 'audio') patch.audioDuration = normalizedAudioDuration(m as AudioModel, s.audioDuration)
  return patch
}

export function normalizedAudioDuration(m: AudioModel, d: number): number {
  const range = m.durationRange
  if (range) return d >= range.minimum && d <= range.maximum ? d : range.defaultValue
  const list = m.durations
  if (list?.length) return list.includes(d) ? d : list[0]
  return d || 30
}

export function resetAudioState(s: PanelState, m: AudioModel | null): Partial<PanelState> {
  if (!m) return { multilingual: false }
  const langs = m.targetLanguages
  return {
    multilingual: false,
    voice: m.defaultVoice ?? '',
    targetLanguage: langs ? (m.defaultTargetLanguage && langs.includes(m.defaultTargetLanguage) ? m.defaultTargetLanguage : langs[0] ?? '') : '',
    lyrics: m.supportsLyrics ? s.lyrics : '',
    styleInstructions: m.supportsStyleInstructions ? s.styleInstructions : '',
    instrumental: m.supportsInstrumental ? s.instrumental : false,
    audioDuration: normalizedAudioDuration(m, s.audioDuration),
  }
}

// ---------- Derived inputs ----------

export function usesSourceVideoInput(m: VideoModel, s: PanelState): boolean {
  return m.requiresSourceVideo || (m.supportsSourceVideo && s.videoMode === 'source')
}

export function videoModes(m: VideoModel): VideoInputMode[] {
  const modes: VideoInputMode[] = []
  if (!m.requiresSourceVideo) modes.push('frames')
  if (m.framesAndReferencesExclusive && m.supportsReferences && !m.requiresSourceVideo) modes.push('references')
  if (m.supportsSourceVideo) modes.push('source')
  return modes
}

/** Media-type nouns inside reference errors. */
const TYPE_NOUN: Partial<Record<ClipType, string>> = { image: tk('image'), video: tk('video'), audio: tk('audio') }

export const VIDEO_MODE_LABELS: Record<VideoInputMode, string> = { frames: tk('First/Last'), references: tk('References'), source: tk('Extend') }

export function audioUsesSource(m: AudioModel, s: PanelState): boolean {
  return m.acceptsSourceMedia && (!m.inputs.includes('text') || s.audioSource !== null)
}

/** Prompt `@` tags for the current reference pools (§B7.5). */
export function promptTags(m: AnyModel | null, s: PanelState): string[] {
  if (!m) return []
  if (m.kind === 'audio') return referenceTags('Image', { images: 0, videos: 0, audios: s.audioRefs.length })
  if (m.kind !== 'video') return []
  return referenceTags((m as VideoModel).referenceTagNoun, { images: s.imageRefs.length, videos: s.videoRefs.length, audios: s.audioRefs.length })
}

export function referenceCounter(m: VideoModel, s: PanelState): string {
  const total = s.imageRefs.length + s.videoRefs.length + s.audioRefs.length
  if (m.maxTotalReferences != null) {
    const parts: string[] = []
    if (m.maxReferenceImages > 0) parts.push(t('{0} img', s.imageRefs.length))
    if (m.maxReferenceVideos > 0) parts.push(t('{0} vid', s.videoRefs.length))
    if (m.maxReferenceAudios > 0) parts.push(t('{0} aud', s.audioRefs.length))
    return [`${total}/${m.maxTotalReferences}`, ...parts].join(' · ')
  }
  return `${total}/${Math.max(m.maxReferenceImages, m.maxReferenceVideos, m.maxReferenceAudios)}`
}

export function promptPlaceholder(m: AnyModel | null, s: PanelState): string {
  if (!m) return t('Describe the video')
  let base: string
  if (m.kind === 'video') base = (m as VideoModel).supportsPrompt ? t('Describe the video') : t('No prompt needed')
  else if (m.kind === 'image') base = t('Describe the image')
  else if (m.kind === 'audio') {
    const a = m as AudioModel
    base = audioUsesSource(a, s) && !a.inputs.includes('text') ? t('No prompt needed') : t(a.promptLabel)
    if (a.inputs.includes('text') && a.minPromptLength > 1) base += ` ${t('(minimum {0} characters)', a.minPromptLength)}`
  } else base = t('No prompt needed')
  return base
}

// ---------- Settings summary (§B7.6) ----------

export function settingsSummary(m: AnyModel | null, s: PanelState, upscaleFps?: number): string {
  if (!m) return t('Settings')
  if (m.kind === 'upscale') {
    const um = m as UpscaleModel
    const parts: string[] = []
    for (const id of ['targetResolution', 'targetFPS']) {
      const setting = um.selectSettings.find((x) => x.id === id)
      if (!setting) continue
      const value = s.upscaleSettings.selections[id] ?? setting.defaultValue
      if (id === 'targetFPS' && value === 'source') parts.push(upscaleFps ? t('{0} FPS', Math.round(upscaleFps)) : t('Original FPS'))
      else parts.push(setting.options.find((o) => o.value === value)?.label ?? value)
    }
    return parts.join(' · ') || t('Settings')
  }
  if (m.kind === 'audio') {
    const am = m as AudioModel
    const parts: string[] = []
    if (am.hasDurationControl && !audioUsesSource(am, s)) parts.push(`${s.audioDuration}s`)
    if (am.supportsInstrumental && s.instrumental) parts.push(t('Instrumental'))
    if (am.supportsMultilingual && s.multilingual) parts.push(t('Multilingual'))
    return parts.join(' · ') || t('Settings')
  }
  const parts: string[] = []
  if (m.kind === 'video') {
    const vm = m as VideoModel
    const draft = vm.supportsDraft && s.draft
    if (vm.resolutions?.length && !draft) parts.push(s.resolution)
    if (draft) parts.push(DRAFT_RESOLUTION)
    if (vm.durations.length && !(usesSourceVideoInput(vm, s) && !vm.usesOutputDuration)) parts.push(`${s.duration}s`)
    if (vm.aspectRatios.length && !(usesSourceVideoInput(vm, s) && !vm.usesOutputDuration)) parts.push(s.aspectRatio)
  } else {
    const im = m as ImageModel
    if (im.resolutions?.length) parts.push(resolutionDisplayLabel(s.resolution))
    if (im.qualities?.length) parts.push(capitalize(s.quality))
    if (im.aspectRatios.length) parts.push(aspectRatioDisplayLabel(s.aspectRatio))
    if (s.numImages > 1) parts.push(`×${s.numImages}`)
  }
  return parts.join(' · ') || t('Settings')
}

export function hasAnySettings(m: AnyModel | null, s: PanelState): boolean {
  if (!m) return false
  if (m.kind === 'upscale') {
    const um = m as UpscaleModel
    return um.selectSettings.length + um.numericSettings.length + um.toggleSettings.length > 0
  }
  if (m.kind === 'audio') {
    const am = m as AudioModel
    return (am.hasDurationControl && !audioUsesSource(am, s)) || am.supportsInstrumental || am.supportsMultilingual
  }
  if (m.kind === 'video') {
    const vm = m as VideoModel
    const sourceOnly = usesSourceVideoInput(vm, s) && !vm.usesOutputDuration
    return (!sourceOnly && (vm.durations.length > 0 || vm.aspectRatios.length > 0)) || !!vm.resolutions?.length || vm.hasAudioToggle
  }
  const im = m as ImageModel
  return im.aspectRatios.length > 0 || !!im.resolutions?.length || !!im.qualities?.length || im.maxImages > 1
}

// ---------- Submit enablement (§B7.7) and request (§B7.8) ----------

type Lookup = (id: string) => MediaManifestEntry | undefined

export function canSubmit(m: AnyModel | null, s: PanelState, lookup: Lookup): boolean {
  if (!m) return false
  const prompt = s.prompt.trim()
  if (m.kind === 'upscale') {
    const src = s.upscaleSource ? lookup(s.upscaleSource) : undefined
    if (!src || src.sourceWidth == null || src.sourceHeight == null) return false
    if (src.type === 'video' && src.sourceFPS == null) return false
    const um = m as UpscaleModel
    if (!um.supports(src)) return false
    return um.selectSettings.every((st) => {
      const v = s.upscaleSettings.selections[st.id] ?? st.defaultValue
      return um.availableOptions(st, src).some((o) => o.value === v)
    })
  }
  if (m.kind === 'video') {
    const vm = m as VideoModel
    if (usesSourceVideoInput(vm, s)) {
      if (!s.sourceVideo) return false
      if (vm.requiresReferenceImage && !s.imageRefs.length) return false
      if (vm.requiresReferenceAudio && !s.audioRefs.length) return false
      if (vm.isLipSync) {
        const src = lookup(s.sourceVideo)
        const audio = s.audioRefs[0] ? lookup(s.audioRefs[0]) : undefined
        if (!src || vm.billingDurationSeconds(src.duration, audio?.duration) === null) return false
      }
      if (vm.supportsPrompt && !vm.supportsReferences && !prompt) return false
      return true
    }
    if (vm.framesAndReferencesExclusive && s.videoMode === 'references') return s.imageRefs.length + s.videoRefs.length + s.audioRefs.length > 0
    return prompt.length > 0
  }
  if (m.kind === 'audio') {
    const am = m as AudioModel
    if (audioUsesSource(am, s)) return !!s.audioSource && (!am.targetLanguages || (!!s.targetLanguage && am.targetLanguages.includes(s.targetLanguage)))
    return [...prompt].length >= Math.max(1, am.minPromptLength)
  }
  return prompt.length > 0
}

/** §B7.8 step 4: edit folder, else the references' folders, else the media panel's current folder. */
export function destinationFolder(m: AnyModel, s: PanelState, lookup: Lookup, currentFolder: string | null): string | null {
  if (s.editFolderId) return s.editFolderId
  const folderOf = (id: string | null | undefined) => (id ? lookup(id)?.folderId ?? null : null)
  const last = (ids: (string | null)[]) => {
    const real = ids.filter((x): x is string => !!x)
    return real.length ? folderOf(real[real.length - 1]) : null
  }
  let f: string | null = null
  if (m.kind === 'video') {
    const vm = m as VideoModel
    f = usesSourceVideoInput(vm, s) ? folderOf(s.sourceVideo) ?? last(s.imageRefs) : last([...s.frames, ...s.imageRefs, ...s.videoRefs, ...s.audioRefs])
  } else if (m.kind === 'image') f = last(s.imageRefs)
  else if (m.kind === 'audio') f = folderOf(s.audioSource) ?? last([...s.imageRefs, ...s.audioRefs])
  return f ?? currentFolder
}

export function buildRequest(m: AnyModel, s: PanelState, lookup: Lookup, currentFolder: string | null): GenerateRequest {
  const folderId = destinationFolder(m, s, lookup, currentFolder)
  if (m.kind === 'video') {
    const vm = m as VideoModel
    const source = usesSourceVideoInput(vm, s)
    return {
      kind: 'video',
      model: vm.id,
      folderId,
      prompt: s.prompt,
      duration: s.duration,
      aspectRatio: s.aspectRatio,
      resolution: vm.resolutions ? s.resolution : null,
      draft: vm.supportsDraft && s.draft,
      generateAudio: vm.hasAudioToggle ? s.generateAudio : null,
      mode: source ? 'source' : s.videoMode,
      frameIds: source ? [] : s.frames.filter((x): x is string => !!x),
      imageRefIds: s.imageRefs,
      videoRefIds: source ? [] : s.videoRefs,
      audioRefIds: s.audioRefs,
      sourceVideoId: source ? s.sourceVideo : null,
    }
  }
  if (m.kind === 'image') {
    const im = m as ImageModel
    return { kind: 'image', model: im.id, folderId, prompt: s.prompt, aspectRatio: s.aspectRatio, resolution: im.resolutions ? s.resolution : null, quality: im.qualities ? s.quality : null, numImages: s.numImages, refIds: im.supportsImageReference ? s.imageRefs : [] }
  }
  if (m.kind === 'audio') {
    const am = m as AudioModel
    const source = audioUsesSource(am, s)
    return {
      kind: 'audio',
      model: am.id,
      folderId,
      prompt: s.prompt,
      voice: s.voice || null,
      lyrics: s.lyrics,
      styleInstructions: s.styleInstructions,
      instrumental: s.instrumental,
      duration: am.hasDurationControl && !source ? s.audioDuration : null,
      targetLanguage: am.targetLanguages ? s.targetLanguage || null : null,
      multilingual: s.multilingual,
      sourceId: source ? s.audioSource : null,
      imageRefIds: am.supportsReferences && !source ? s.imageRefs : [],
      audioRefIds: am.supportsReferences && !source ? s.audioRefs : [],
    }
  }
  return { kind: 'upscale', model: m.id, folderId, sourceId: s.upscaleSource!, settings: s.upscaleSettings }
}

/** §B7.8 step 7: prompt, lyrics, style, edit folder and every reference clear; settings stay. */
export const afterSubmit = (): Partial<PanelState> => ({ prompt: '', lyrics: '', styleInstructions: '', editFolderId: null, ...clearedReferences() })

// ---------- Reference pools (§B7.5) ----------

export function acceptedRefTypes(m: AnyModel | null): ClipType[] {
  if (!m) return []
  if (m.kind === 'image') return (m as ImageModel).supportsImageReference ? ['image'] : []
  if (m.kind === 'audio') {
    const am = m as AudioModel
    return [...(am.maxReferenceImages > 0 ? (['image'] as ClipType[]) : []), ...(am.maxReferenceAudios > 0 ? (['audio'] as ClipType[]) : [])]
  }
  if (m.kind === 'video') {
    const vm = m as VideoModel
    return [...(vm.maxReferenceImages > 0 ? (['image'] as ClipType[]) : []), ...(vm.maxReferenceVideos > 0 ? (['video'] as ClipType[]) : []), ...(vm.maxReferenceAudios > 0 ? (['audio'] as ClipType[]) : [])]
  }
  return []
}

/** Adds an asset to the matching pool, or returns the error to flash (§B7.5). */
export function addReference(m: AnyModel, s: PanelState, asset: MediaManifestEntry): Partial<PanelState> | string {
  if ([...s.imageRefs, ...s.videoRefs, ...s.audioRefs].includes(asset.id)) return t('{0} is already a reference', asset.name)
  const accepted = acceptedRefTypes(m)
  if (!accepted.includes(asset.type)) {
    if (m.kind === 'audio') return t('{0} only accepts image or audio references.', m.displayName)
    if (m.kind === 'image') return t('Drop image here.')
    return accepted.length === 2 ? t('{0} only accepts {1} and {2} references.', m.displayName, t(TYPE_NOUN[accepted[0]] ?? accepted[0]), t(TYPE_NOUN[accepted[1]] ?? accepted[1])) : t('{0} only accepts {1} references.', m.displayName, accepted.map((x) => t(TYPE_NOUN[x] ?? x)).join(', '))
  }
  const key = asset.type === 'image' ? 'imageRefs' : asset.type === 'video' ? 'videoRefs' : 'audioRefs'
  return { [key]: [...s[key], asset.id] }
}

// ---------- Seeding (§B7.9) ----------

export interface Seed {
  asset: MediaManifestEntry
  stored: GenerationInput
}

const typeOfModel = (m: AnyModel): GenType => m.kind as GenType

/** `populatePanel`: the panel state a seed produces, or null when its model isn't in the catalog. */
export function seedState(set: ModelSet, s: PanelState, seed: Seed, exists: (id: string) => boolean): PanelState | null {
  const st = seed.stored
  const model = set.find(String(st.model ?? ''))
  if (!model) return null
  const type = typeOfModel(model)
  const next: PanelState = { ...s, ...clearedReferences(), type, modelIds: { ...s.modelIds, [type]: model.id } }
  next.prompt = typeof st.prompt === 'string' ? st.prompt : ''
  if (typeof st.aspectRatio === 'string' && st.aspectRatio) next.aspectRatio = st.aspectRatio
  if (typeof st.resolution === 'string' && st.resolution) next.resolution = st.resolution
  if (typeof st.quality === 'string' && st.quality) next.quality = st.quality
  if (typeof st.duration === 'number' && st.duration > 0) {
    next.duration = st.duration
    next.audioDuration = st.duration
  }
  if (typeof st.numImages === 'number') next.numImages = st.numImages
  if (typeof st.voice === 'string') next.voice = st.voice
  next.multilingual = st.multilingual === true
  next.lyrics = typeof st.lyrics === 'string' ? st.lyrics : ''
  next.styleInstructions = typeof st.styleInstructions === 'string' ? st.styleInstructions : ''
  next.instrumental = st.instrumental === true
  next.generateAudio = typeof st.generateAudio === 'boolean' ? st.generateAudio : true
  next.draft = st.draft === true
  const keep = (ids: unknown) => stringList(ids).filter(exists)
  const imageURLAssetIds = keep(st.imageURLAssetIds)
  if (model.kind === 'video') {
    const vm = model as VideoModel
    if (vm.requiresSourceVideo || st.usesSourceVideo === true) {
      next.sourceVideo = imageURLAssetIds[0] ?? null
      next.imageRefs = keep(st.referenceImageAssetIds)
      next.videoRefs = keep(st.referenceVideoAssetIds)
      next.audioRefs = keep(st.referenceAudioAssetIds)
      if (!next.imageRefs.length && vm.maxReferenceImages > 0 && imageURLAssetIds[1]) next.imageRefs = [imageURLAssetIds[1]]
      next.videoMode = 'source'
    } else {
      next.frames = [vm.supportsFirstFrame ? imageURLAssetIds[0] ?? null : null, vm.supportsLastFrame ? imageURLAssetIds[1] ?? null : null]
      next.imageRefs = keep(st.referenceImageAssetIds)
      next.videoRefs = keep(st.referenceVideoAssetIds)
      next.audioRefs = keep(st.referenceAudioAssetIds)
      next.videoMode = vm.framesAndReferencesExclusive && next.imageRefs.length + next.videoRefs.length + next.audioRefs.length > 0 ? 'references' : 'frames'
    }
  } else if (model.kind === 'image') next.imageRefs = imageURLAssetIds
  else if (model.kind === 'audio') {
    const am = model as AudioModel
    if (am.supportsReferences) {
      next.imageRefs = keep(st.referenceImageAssetIds)
      next.audioRefs = keep(st.referenceAudioAssetIds)
    } else next.audioSource = keep(st.referenceAudioAssetIds)[0] ?? keep(st.referenceVideoAssetIds)[0] ?? null
    const langs = am.targetLanguages
    next.targetLanguage = langs ? (typeof st.targetLanguage === 'string' && langs.includes(st.targetLanguage) ? st.targetLanguage : am.defaultTargetLanguage ?? langs[0] ?? '') : ''
  } else {
    const um = model as UpscaleModel
    next.upscaleSource = imageURLAssetIds[0] ?? seed.asset.id
    const stored = st.upscaleSettings as UpscaleSettings | undefined
    next.upscaleSettings = stored && typeof stored === 'object' ? { selections: { ...stored.selections }, numbers: { ...stored.numbers }, toggles: { ...stored.toggles } } : um.defaultSettings
  }
  next.editFolderId = seed.asset.folderId ?? null
  if (model.kind !== 'upscale') return { ...next, ...resetSettings(next, model, true) }
  return next
}
