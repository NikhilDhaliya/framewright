/**
 * Model configs with the Mac's derived properties (spec 06 §B1.2), resolved against the user's keys: each model
 * carries its active BYOK route (or null) and capabilities narrowed to what that route can run.
 */
import type { ClipType } from '../model'
import {
  activeRoute,
  bundledEntries,
  keyProvider,
  providerName,
  type AudioCaps,
  type AudioCategory,
  type AudioInput,
  type ByokRoute,
  type CatalogEntry,
  type HasKey,
  type ImageCaps,
  type ModelKind,
  type UpscaleCaps,
  type UpscaleNumericSetting,
  type UpscaleSelectOption,
  type UpscaleSelectSetting,
  type UpscaleToggleSetting,
  type VideoCaps,
} from './catalog'

export const DRAFT_RESOLUTION = '720p'
export const EDIT_MAX_DURATION_SECONDS = 10

abstract class BaseModel {
  constructor(
    readonly entry: CatalogEntry,
    /** Route used to run this model with the current keys; null = unavailable. */
    readonly route: ByokRoute | null,
  ) {}
  get id(): string {
    return this.entry.id
  }
  get displayName(): string {
    return this.entry.displayName
  }
  get providerName(): string | undefined {
    return this.entry.providerName
  }
  get providerIconKey(): string | undefined {
    return this.entry.providerIconKey
  }
  get description(): string | undefined {
    return this.entry.description
  }
  get kind(): ModelKind {
    return this.entry.kind
  }
  get hasKey(): boolean {
    return this.route !== null
  }
  /** Display name of the provider whose key would make this model available. */
  get keyProviderName(): string {
    const p = keyProvider(this.entry)
    return p ? providerName(p) : 'provider'
  }
}

// ---------- Video ----------

export function durationLimitLabel(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60
    return minutes === 1 ? '1 minute' : `${minutes} minutes`
  }
  return seconds === 1 ? '1 second' : `${seconds} seconds`
}

export function nearestSupportedDuration(seconds: number, durations: number[]): number {
  if (!durations.length) return Math.max(1, Math.round(seconds))
  let best = durations[0]
  for (const d of durations) if (Math.abs(d - seconds) < Math.abs(best - seconds)) best = d
  return best
}

export class VideoModel extends BaseModel {
  readonly caps: VideoCaps
  constructor(entry: CatalogEntry, route: ByokRoute | null) {
    super(entry, route)
    this.caps = narrowVideoCaps(entry.uiCapabilities as VideoCaps, route)
  }
  get supportsPrompt(): boolean {
    return this.caps.supportsPrompt ?? true
  }
  get durations(): number[] {
    return this.caps.durations
  }
  get resolutions(): string[] | null {
    return this.caps.resolutions ?? null
  }
  get aspectRatios(): string[] {
    return this.caps.aspectRatios
  }
  get supportsFirstFrame(): boolean {
    return this.caps.supportsFirstFrame
  }
  get supportsLastFrame(): boolean {
    return this.caps.supportsLastFrame
  }
  get maxReferenceImages(): number {
    return this.caps.maxReferenceImages
  }
  get maxReferenceVideos(): number {
    return this.caps.maxReferenceVideos
  }
  get maxReferenceAudios(): number {
    return this.caps.maxReferenceAudios
  }
  get maxTotalReferences(): number | null {
    return this.caps.maxTotalReferences ?? null
  }
  get maxCombinedVideoRefSeconds(): number | null {
    return this.caps.maxCombinedVideoRefSeconds ?? null
  }
  get maxCombinedAudioRefSeconds(): number | null {
    return this.caps.maxCombinedAudioRefSeconds ?? null
  }
  get framesAndReferencesExclusive(): boolean {
    return this.caps.framesAndReferencesExclusive
  }
  get referenceTagNoun(): string {
    return this.caps.referenceTagNoun
  }
  get requiresSourceVideo(): boolean {
    return this.caps.requiresSourceVideo
  }
  get maxSourceVideoSeconds(): number | null {
    return this.caps.maxSourceVideoSeconds ?? null
  }
  get requiresReferenceImage(): boolean {
    return this.caps.requiresReferenceImage
  }
  get requiresReferenceAudio(): boolean {
    return this.caps.requiresReferenceAudio ?? false
  }
  get supportsSourceVideo(): boolean {
    return this.requiresSourceVideo || this.caps.sourceVideoCreditsPerSecond != null
  }
  get supportsDraft(): boolean {
    return this.caps.draftCreditsPerSecond != null
  }
  get usesOutputDuration(): boolean {
    return this.supportsSourceVideo && this.durations.length > 0
  }
  get isEdit(): boolean {
    return this.supportsPrompt && this.requiresSourceVideo && !this.requiresReferenceImage && !this.requiresReferenceAudio
  }
  get isLipSync(): boolean {
    return !this.supportsPrompt && this.requiresSourceVideo && this.requiresReferenceAudio
  }
  get isReframe(): boolean {
    if (!this.supportsPrompt || this.requiresSourceVideo || this.maxReferenceVideos <= 0) return false
    const id = this.id.toLowerCase()
    return id.includes('minimax-h3') || id.includes('hailuo-03')
  }
  get supportsReferences(): boolean {
    return this.maxReferenceImages > 0 || this.maxReferenceVideos > 0 || this.maxReferenceAudios > 0
  }
  /** Presence of `audioDiscountRate` shows the "Generate audio" toggle (§B1.2). */
  get hasAudioToggle(): boolean {
    return this.entry.audioDiscountRate !== undefined
  }
  get preferredHighResolution(): string | null {
    const r = this.resolutions
    if (r?.includes('2K')) return '2K'
    if (r?.includes('1080p')) return '1080p'
    return r?.[0] ?? null
  }
  nearestSupportedDuration(seconds: number): number {
    return nearestSupportedDuration(seconds, this.durations)
  }
  supportedDuration(covering: number): number {
    const fits = this.durations.filter((d) => d >= covering)
    if (fits.length) return Math.min(...fits)
    if (this.durations.length) return Math.max(...this.durations)
    return Math.max(1, Math.ceil(covering))
  }
  billingDurationSeconds(sourceVideoDuration: number, sourceAudioDuration: number | null | undefined): number | null {
    const s = this.isLipSync ? sourceAudioDuration : sourceVideoDuration
    if (s == null || !Number.isFinite(s) || s <= 0) return null
    return Math.max(1, Math.round(s))
  }
  get sourceDurationLimitLabel(): string | null {
    const max = this.maxSourceVideoSeconds
    if (max == null || !Number.isFinite(max) || max <= 0) return null
    return durationLimitLabel(Math.round(max))
  }
}

/** Narrows the catalog capabilities to what the active route's endpoints can run. */
function narrowVideoCaps(caps: VideoCaps, route: ByokRoute | null): VideoCaps {
  if (!route) return caps
  const e = route.endpoints
  const out: VideoCaps = { ...caps }
  if (!caps.requiresSourceVideo) {
    if (!e.ref) {
      out.maxReferenceImages = 0
      out.maxReferenceVideos = 0
      out.maxReferenceAudios = 0
      out.maxTotalReferences = null
    }
    if (!e.i2v && !e.flf) out.supportsFirstFrame = false
    if (!e.flf) out.supportsLastFrame = false
    if (!e.edit) {
      out.sourceVideoCreditsPerSecond = null
      out.sourceVideoDraftCreditsPerSecond = null
    }
  }
  if (!e.enhance && !e.draft_suffix) {
    out.draftCreditsPerSecond = null
    out.draftEnhanceCreditsPerSecond = null
  }
  return out
}

// ---------- Image ----------

export class ImageModel extends BaseModel {
  get caps(): ImageCaps {
    const caps = this.entry.uiCapabilities as ImageCaps
    if (this.route && !this.route.endpoints.edit) return { ...caps, supportsImageReference: false }
    return caps
  }
  get resolutions(): string[] | null {
    return this.caps.resolutions ?? null
  }
  get aspectRatios(): string[] {
    return this.caps.aspectRatios
  }
  get qualities(): string[] | null {
    return this.caps.qualities ?? null
  }
  get supportsImageReference(): boolean {
    return this.caps.supportsImageReference
  }
  get maxImages(): number {
    return Math.max(1, Math.min(4, this.caps.maxImages))
  }
}

// ---------- Audio ----------

export const AUDIO_CATEGORY_LABELS: Record<AudioCategory, string> = {
  general: 'General',
  tts: 'Speech',
  music: 'Music',
  sfx: 'Sound Effects',
  cleanup: 'Voice Cleanup',
  dubbing: 'Dubbing',
}
const runtimeVoices = new Map<string, string[]>()
/** Records the provider's voice names for a runtime-voice model (fetched by main / the panel). */
export function setRuntimeVoices(modelId: string, names: string[]): void {
  if (names.length) runtimeVoices.set(modelId, [...names])
  else runtimeVoices.delete(modelId)
}

export const AUDIO_CATEGORY_ORDER: AudioCategory[] = ['general', 'tts', 'music', 'sfx', 'cleanup', 'dubbing']

export class AudioModel extends BaseModel {
  get caps(): AudioCaps {
    return this.entry.uiCapabilities as AudioCaps
  }
  get category(): AudioCategory {
    const c = this.caps.category as AudioCategory
    return c in AUDIO_CATEGORY_LABELS ? c : 'tts'
  }
  get categoryLabel(): string {
    return AUDIO_CATEGORY_LABELS[this.category]
  }
  /** Catalog voices; a `<…>` placeholder means the list comes from the provider at runtime (see `setRuntimeVoices`). */
  get voices(): string[] | null {
    if (this.runtimeVoices) {
      const fetched = runtimeVoices.get(this.id)
      return fetched?.length ? fetched : null
    }
    return this.caps.voices ?? null
  }
  /** True when the catalog defers the voice list to the provider (ElevenLabs `GET /v2/voices`). */
  get runtimeVoices(): boolean {
    return !!this.caps.voices?.some((v) => v.startsWith('<'))
  }
  /** Whether a `voice` parameter is sent (catalog or runtime voices). */
  get acceptsVoice(): boolean {
    return this.runtimeVoices || !!this.caps.voices?.length
  }
  get defaultVoice(): string | null {
    return this.caps.defaultVoice ?? null
  }
  get supportsLyrics(): boolean {
    return this.caps.supportsLyrics
  }
  get supportsInstrumental(): boolean {
    return this.caps.supportsInstrumental
  }
  get supportsStyleInstructions(): boolean {
    return this.caps.supportsStyleInstructions
  }
  get durations(): number[] | null {
    return this.caps.durations ?? null
  }
  get durationRange(): { minimum: number; maximum: number; defaultValue: number } | null {
    return this.caps.durationRange ?? null
  }
  get hasDurationControl(): boolean {
    return this.durations !== null || this.durationRange !== null
  }
  get minPromptLength(): number {
    return this.caps.minPromptLength
  }
  get maxReferenceImages(): number {
    return this.caps.maxReferenceImages ?? 0
  }
  get maxReferenceAudios(): number {
    return this.caps.maxReferenceAudios ?? 0
  }
  get maxReferenceAudioSeconds(): number | null {
    return this.caps.maxReferenceAudioSeconds ?? null
  }
  get referenceAudioExtensions(): string[] | null {
    return this.caps.referenceAudioExtensions ?? null
  }
  get referenceImagesAndAudiosExclusive(): boolean {
    return this.caps.referenceImagesAndAudiosExclusive ?? false
  }
  get supportsMultilingual(): boolean {
    return this.caps.supportsMultilingual ?? false
  }
  get supportsReferences(): boolean {
    return this.maxReferenceImages > 0 || this.maxReferenceAudios > 0
  }
  get inputs(): AudioInput[] {
    return (this.caps.inputs ?? ['text']).filter((x): x is AudioInput => x === 'text' || x === 'audio' || x === 'video')
  }
  get promptLabel(): string {
    return this.caps.promptLabel ?? 'Describe the sound'
  }
  get minSeconds(): number {
    return this.caps.minSeconds ?? 1
  }
  get maxSeconds(): number {
    return this.caps.maxSeconds ?? 600
  }
  get targetLanguages(): string[] | null {
    return this.caps.targetLanguages ?? null
  }
  get defaultTargetLanguage(): string | null {
    return this.caps.defaultTargetLanguage ?? null
  }
  get acceptsSourceMedia(): boolean {
    return this.inputs.includes('audio') || this.inputs.includes('video')
  }
  get usesSourceURL(): boolean {
    return this.category === 'cleanup' || this.category === 'dubbing'
  }
  acceptsSource(type: ClipType): boolean {
    if (type === 'audio') return this.inputs.includes('audio')
    if (type === 'video') return this.inputs.includes('video')
    return false
  }
}

// ---------- Upscale ----------

export interface UpscaleSettings {
  selections: Record<string, string>
  numbers: Record<string, number>
  toggles: Record<string, boolean>
}

/** What upscale option filtering needs to know about the source (§B1.2). */
export interface UpscaleSource {
  type: ClipType
  sourceWidth?: number
  sourceHeight?: number
  sourceFPS?: number
}

const targetLongEdge = (value: string) => (value === '1080p' ? 1920 : 3840)

export class UpscaleModel extends BaseModel {
  get caps(): UpscaleCaps {
    return this.entry.uiCapabilities as UpscaleCaps
  }
  get speed(): string {
    return this.caps.speed
  }
  get selectSettings(): UpscaleSelectSetting[] {
    return this.caps.selectSettings ?? []
  }
  get numericSettings(): UpscaleNumericSetting[] {
    return this.caps.numericSettings ?? []
  }
  get toggleSettings(): UpscaleToggleSetting[] {
    return this.caps.toggleSettings ?? []
  }
  get supportedTypes(): ClipType[] {
    return this.caps.supportedTypes.filter((t): t is ClipType => t === 'video' || t === 'image')
  }
  get defaultSettings(): UpscaleSettings {
    return {
      selections: Object.fromEntries(this.selectSettings.map((s) => [s.id, s.defaultValue])),
      numbers: {},
      toggles: Object.fromEntries(this.toggleSettings.map((s) => [s.id, s.defaultValue])),
    }
  }
  availableOptions(setting: UpscaleSelectSetting, source: UpscaleSource | null): UpscaleSelectOption[] {
    if (!source) return setting.options
    if (setting.id === 'targetResolution') {
      if (!source.sourceWidth || !source.sourceHeight) return setting.options
      const edge = Math.max(source.sourceWidth, source.sourceHeight)
      let maximum: UpscaleSelectOption | undefined
      for (const o of setting.options) if (!maximum || targetLongEdge(o.value) > targetLongEdge(maximum.value)) maximum = o
      const limit = this.caps.maximumUpscaleFactor
      return setting.options.filter((o) => {
        const factor = Math.max(1, targetLongEdge(o.value) / edge)
        const within = limit == null || factor <= limit
        return within && (targetLongEdge(o.value) >= edge || o === maximum)
      })
    }
    if (setting.id === 'targetFPS') {
      const fps = source.sourceFPS
      if (!fps || fps <= 0) return setting.options
      if (fps > 60) return setting.options.filter((o) => o.value === '60')
      const preserves = setting.options.some((o) => o.value === 'source')
      return setting.options.filter((o) => o.value === 'source' || (Number(o.value) || 0) >= fps + (preserves ? 0.001 : 0))
    }
    return setting.options
  }
  supports(source: UpscaleSource): boolean {
    if (!this.supportedTypes.includes(source.type)) return false
    if (source.type === 'video' && (source.sourceFPS ?? 0) > 60 && !this.selectSettings.some((s) => s.id === 'targetFPS')) return false
    return this.selectSettings.every((s) => s.id !== 'targetResolution' || this.availableOptions(s, source).length > 0)
  }
  normalizedSettings(settings: UpscaleSettings, source: UpscaleSource | null): UpscaleSettings {
    const out: UpscaleSettings = { selections: { ...settings.selections }, numbers: { ...settings.numbers }, toggles: { ...settings.toggles } }
    for (const s of this.selectSettings) {
      const options = this.availableOptions(s, source)
      if (!options.length) continue
      const selected = out.selections[s.id] ?? s.defaultValue
      if (!options.some((o) => o.value === selected)) out.selections[s.id] = options[options.length - 1].value
    }
    return out
  }
}

// ---------- Model set ----------

export type AnyModel = VideoModel | ImageModel | AudioModel | UpscaleModel

export function makeModel(entry: CatalogEntry, route: ByokRoute | null): AnyModel {
  switch (entry.kind) {
    case 'video':
      return new VideoModel(entry, route)
    case 'image':
      return new ImageModel(entry, route)
    case 'audio':
      return new AudioModel(entry, route)
    case 'upscale':
      return new UpscaleModel(entry, route)
  }
}

/** The catalog seen through one set of keys and preferences. */
export class ModelSet {
  readonly video: VideoModel[] = []
  readonly image: ImageModel[] = []
  readonly audio: AudioModel[] = []
  readonly upscale: UpscaleModel[] = []
  private readonly byId = new Map<string, AnyModel>()

  constructor(
    entries: CatalogEntry[],
    hasKey: HasKey,
    readonly disabledIds: ReadonlySet<string> = new Set(),
  ) {
    for (const e of entries) {
      const m = makeModel(e, activeRoute(e, hasKey))
      ;(this[e.kind] as AnyModel[]).push(m)
      this.byId.set(e.id, m)
      for (const alias of e.aliases ?? []) if (!this.byId.has(alias)) this.byId.set(alias, m)
    }
  }

  /** Resolves ids and Linux aliases (§B12.3). */
  find(id: string): AnyModel | undefined {
    return this.byId.get(id)
  }
  findVideo(id: string): VideoModel | undefined {
    const m = this.find(id)
    return m instanceof VideoModel ? m : undefined
  }
  findImage(id: string): ImageModel | undefined {
    const m = this.find(id)
    return m instanceof ImageModel ? m : undefined
  }
  findAudio(id: string): AudioModel | undefined {
    const m = this.find(id)
    return m instanceof AudioModel ? m : undefined
  }
  findUpscale(id: string): UpscaleModel | undefined {
    const m = this.find(id)
    return m instanceof UpscaleModel ? m : undefined
  }
  displayName(id: string): string {
    return this.find(id)?.displayName ?? id
  }
  /** Has a key and is not disabled in Settings ▸ Models. */
  isAvailable(m: AnyModel): boolean {
    return m.hasKey && !this.disabledIds.has(m.id)
  }
  available<K extends ModelKind>(kind: K): ModelSet[K] {
    return (this[kind] as AnyModel[]).filter((m) => this.isAvailable(m)) as ModelSet[K]
  }
  keyed(kind: ModelKind): AnyModel[] {
    return (this[kind] as AnyModel[]).filter((m) => m.hasKey)
  }
  get canGenerate(): boolean {
    return [...this.byId.values()].some((m) => m.hasKey)
  }

  get editModel(): VideoModel | undefined {
    return this.video.find((m) => m.isEdit)
  }
  get lipSyncModel(): VideoModel | undefined {
    return this.video.find((m) => m.isLipSync)
  }
  get reframeModel(): VideoModel | undefined {
    return this.video.find((m) => m.isReframe)
  }
  get firstAndLastFrameModel(): VideoModel | undefined {
    return this.video.find((m) => !m.requiresSourceVideo && m.supportsFirstFrame && m.supportsLastFrame)
  }
}

/** The bundled catalog for the given keys / disabled ids. */
export function modelSet(hasKey: HasKey, disabledIds: Iterable<string> = []): ModelSet {
  return new ModelSet(bundledEntries(), hasKey, new Set(disabledIds))
}
