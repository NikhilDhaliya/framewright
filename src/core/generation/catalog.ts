/**
 * The local generation catalog (spec 06 §B1–B2, §B12.3): the Mac's `models:list` CatalogEntry shape plus the
 * Linux-only `byok` routes and `aliases`. Pure — shared by main (service, tools) and the renderer (panel, settings).
 */
import bundled from '../../../resources/generation-catalog.json'

export type ModelKind = 'video' | 'image' | 'audio' | 'upscale'

export type ByokProvider =
  | 'fal' | 'replicate' | 'openai' | 'google' | 'elevenlabs'
  | 'xai' | 'bfl' | 'minimax' | 'byteplus' | 'kling' | 'runway'
  | 'topaz' | 'ltx' | 'fishaudio' | 'mirelo' | 'sonilo'
  | 'ideogram' | 'recraft' | 'reve' | 'krea'

export type ByokProtocol =
  | 'fal-queue' | 'replicate' | 'openai-images' | 'openai-speech' | 'gemini-content' | 'gemini-interactions'
  | 'gemini-lro' | 'elevenlabs' | 'bfl' | 'xai' | 'minimax' | 'byteplus-task' | 'byteplus-images'
  | 'kling' | 'runway' | 'topaz' | 'generic-json'

export interface ByokRoute {
  provider: ByokProvider
  protocol: ByokProtocol
  /** Keyed by mode: video t2v/i2v/flf/ref/edit/enhance/draft_suffix, image t2i/edit, audio gen/tts/music/t2m/v2m/sfx/v2a/cleanup/dub, upscale video/image. */
  endpoints: Record<string, string>
}

export interface VideoCaps {
  supportsPrompt?: boolean
  durations: number[]
  resolutions?: string[] | null
  aspectRatios: string[]
  supportsFirstFrame: boolean
  supportsLastFrame: boolean
  maxReferenceImages: number
  maxReferenceVideos: number
  maxReferenceAudios: number
  maxTotalReferences?: number | null
  maxCombinedVideoRefSeconds?: number | null
  maxCombinedAudioRefSeconds?: number | null
  framesAndReferencesExclusive: boolean
  referenceTagNoun: string
  requiresSourceVideo: boolean
  maxSourceVideoSeconds?: number | null
  maxSourceVideoResolution?: '720p' | '1080p' | '4k' | null
  requiredSourceVideoEncoding?: 'h264-mp4' | null
  requiresReferenceImage: boolean
  requiresReferenceAudio?: boolean | null
  draftCreditsPerSecond?: number | null
  draftEnhanceCreditsPerSecond?: number | null
  sourceVideoCreditsPerSecond?: Record<string, number> | null
  sourceVideoDraftCreditsPerSecond?: number | null
}

export interface ImageCaps {
  resolutions?: string[] | null
  aspectRatios: string[]
  qualities?: string[] | null
  supportsImageReference: boolean
  maxImages: number
}

export type AudioCategory = 'general' | 'tts' | 'music' | 'sfx' | 'cleanup' | 'dubbing'
export type AudioInput = 'text' | 'audio' | 'video'

export interface AudioCaps {
  category: string
  voices?: string[] | null
  defaultVoice?: string | null
  supportsLyrics: boolean
  supportsInstrumental: boolean
  supportsStyleInstructions: boolean
  durations?: number[] | null
  durationRange?: { minimum: number; maximum: number; defaultValue: number } | null
  minPromptLength: number
  maxReferenceImages?: number | null
  maxReferenceAudios?: number | null
  maxReferenceAudioSeconds?: number | null
  referenceAudioExtensions?: string[] | null
  referenceImagesAndAudiosExclusive?: boolean | null
  supportsMultilingual?: boolean | null
  inputs?: string[] | null
  promptLabel?: string | null
  minSeconds?: number | null
  maxSeconds?: number | null
  targetLanguages?: string[] | null
  defaultTargetLanguage?: string | null
}

export interface UpscaleSelectOption {
  value: string
  label: string
  description?: string
  group?: string
  groupDescription?: string
}
export interface UpscaleSelectSetting {
  id: string
  label: string
  options: UpscaleSelectOption[]
  defaultValue: string
}
export interface UpscaleNumericSetting {
  id: string
  label: string
  minimum: number
  maximum: number
  step: number
}
export interface UpscaleToggleSetting {
  id: string
  label: string
  defaultValue: boolean
}
export interface UpscaleCaps {
  speed: string
  p75DurationSeconds: number
  maximumUpscaleFactor?: number | null
  supportedTypes: string[]
  selectSettings?: UpscaleSelectSetting[] | null
  numericSettings?: UpscaleNumericSetting[] | null
  toggleSettings?: UpscaleToggleSetting[] | null
}

export interface CatalogEntry {
  id: string
  kind: ModelKind
  displayName: string
  providerIconKey?: string
  providerName?: string
  description?: string
  allowedEndpoints: string[]
  responseShape: 'video' | 'images' | 'audio' | 'upscaledImage'
  uiCapabilities: VideoCaps | ImageCaps | AudioCaps | UpscaleCaps
  audioDiscountRate?: Record<string, number>
  paidOnly?: boolean
  byok?: { routes: ByokRoute[] }
  aliases?: string[]
  [k: string]: unknown
}

export interface CatalogFile {
  catalogVersion: number
  linuxRevision: number
  models: CatalogEntry[]
}

export class CatalogError extends Error {}

// ---------- Strict decode (§B1.1: a malformed entry rejects the whole catalog) ----------

type Check = (v: unknown) => boolean
const isNum: Check = (v) => typeof v === 'number' && Number.isFinite(v)
const isStr: Check = (v) => typeof v === 'string'
const isBool: Check = (v) => typeof v === 'boolean'
const isStrArr: Check = (v) => Array.isArray(v) && v.every(isStr)
const isNumArr: Check = (v) => Array.isArray(v) && v.every(isNum)
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const nullable = (c: Check): Check => (v) => v === null || v === undefined || c(v)
const isNumRecord: Check = (v) => isObj(v) && Object.values(v).every(isNum)

function need(o: Record<string, unknown>, key: string, check: Check, where: string, optional = false): void {
  if (!(key in o) || o[key] === undefined) {
    if (optional) return
    throw new CatalogError(`${where}: missing required key '${key}'`)
  }
  if (!check(o[key])) throw new CatalogError(`${where}: '${key}' has the wrong type`)
}

const VIDEO_KEYS: [string, Check, boolean][] = [
  ['supportsPrompt', isBool, true],
  ['durations', isNumArr, false],
  ['resolutions', nullable(isStrArr), true],
  ['aspectRatios', isStrArr, false],
  ['supportsFirstFrame', isBool, false],
  ['supportsLastFrame', isBool, false],
  ['maxReferenceImages', isNum, false],
  ['maxReferenceVideos', isNum, false],
  ['maxReferenceAudios', isNum, false],
  ['maxTotalReferences', nullable(isNum), true],
  ['maxCombinedVideoRefSeconds', nullable(isNum), true],
  ['maxCombinedAudioRefSeconds', nullable(isNum), true],
  ['framesAndReferencesExclusive', isBool, false],
  ['referenceTagNoun', isStr, false],
  ['requiresSourceVideo', isBool, false],
  ['maxSourceVideoSeconds', nullable(isNum), true],
  ['maxSourceVideoResolution', nullable((v) => v === '720p' || v === '1080p' || v === '4k'), true],
  ['requiredSourceVideoEncoding', nullable((v) => v === 'h264-mp4'), true],
  ['requiresReferenceImage', isBool, false],
  ['requiresReferenceAudio', nullable(isBool), true],
  ['draftCreditsPerSecond', nullable(isNum), true],
  ['draftEnhanceCreditsPerSecond', nullable(isNum), true],
  ['sourceVideoCreditsPerSecond', nullable(isNumRecord), true],
  ['sourceVideoDraftCreditsPerSecond', nullable(isNum), true],
]
const IMAGE_KEYS: [string, Check, boolean][] = [
  ['resolutions', nullable(isStrArr), true],
  ['aspectRatios', isStrArr, false],
  ['qualities', nullable(isStrArr), true],
  ['supportsImageReference', isBool, false],
  ['maxImages', isNum, false],
]
const AUDIO_KEYS: [string, Check, boolean][] = [
  ['category', isStr, false],
  ['voices', nullable(isStrArr), true],
  ['defaultVoice', nullable(isStr), true],
  ['supportsLyrics', isBool, false],
  ['supportsInstrumental', isBool, false],
  ['supportsStyleInstructions', isBool, false],
  ['durations', nullable(isNumArr), true],
  ['durationRange', nullable((v) => isObj(v) && isNum(v.minimum) && isNum(v.maximum) && isNum(v.defaultValue)), true],
  ['minPromptLength', isNum, false],
  ['maxReferenceImages', nullable(isNum), true],
  ['maxReferenceAudios', nullable(isNum), true],
  ['maxReferenceAudioSeconds', nullable(isNum), true],
  ['referenceAudioExtensions', nullable(isStrArr), true],
  ['referenceImagesAndAudiosExclusive', nullable(isBool), true],
  ['supportsMultilingual', nullable(isBool), true],
  ['inputs', nullable(isStrArr), true],
  ['promptLabel', nullable(isStr), true],
  ['minSeconds', nullable(isNum), true],
  ['maxSeconds', nullable(isNum), true],
  ['targetLanguages', nullable(isStrArr), true],
  ['defaultTargetLanguage', nullable(isStr), true],
]
const isSelect: Check = (v) =>
  isObj(v) && isStr(v.id) && isStr(v.label) && isStr(v.defaultValue) && Array.isArray(v.options) && v.options.every((o) => isObj(o) && isStr(o.value) && isStr(o.label))
const isNumeric: Check = (v) => isObj(v) && isStr(v.id) && isStr(v.label) && isNum(v.minimum) && isNum(v.maximum) && isNum(v.step)
const isToggle: Check = (v) => isObj(v) && isStr(v.id) && isStr(v.label) && isBool(v.defaultValue)
const UPSCALE_KEYS: [string, Check, boolean][] = [
  ['speed', isStr, false],
  ['p75DurationSeconds', isNum, false],
  ['maximumUpscaleFactor', nullable(isNum), true],
  ['supportedTypes', isStrArr, false],
  ['selectSettings', nullable((v) => Array.isArray(v) && v.every(isSelect)), true],
  ['numericSettings', nullable((v) => Array.isArray(v) && v.every(isNumeric)), true],
  ['toggleSettings', nullable((v) => Array.isArray(v) && v.every(isToggle)), true],
]
const CAPS_KEYS: Record<ModelKind, [string, Check, boolean][]> = { video: VIDEO_KEYS, image: IMAGE_KEYS, audio: AUDIO_KEYS, upscale: UPSCALE_KEYS }
const RESPONSE_SHAPES = ['video', 'images', 'audio', 'upscaledImage']

function checkEntry(raw: unknown, i: number): CatalogEntry {
  if (!isObj(raw)) throw new CatalogError(`models[${i}]: not an object`)
  const where = `models[${i}]${typeof raw.id === 'string' ? ` (${raw.id})` : ''}`
  need(raw, 'id', isStr, where)
  need(raw, 'kind', (v) => v === 'video' || v === 'image' || v === 'audio' || v === 'upscale', where)
  need(raw, 'displayName', isStr, where)
  need(raw, 'allowedEndpoints', isStrArr, where)
  need(raw, 'responseShape', (v) => RESPONSE_SHAPES.includes(v as string), where)
  need(raw, 'uiCapabilities', isObj, where)
  need(raw, 'providerIconKey', isStr, where, true)
  need(raw, 'providerName', isStr, where, true)
  need(raw, 'description', isStr, where, true)
  need(raw, 'paidOnly', isBool, where, true)
  need(raw, 'audioDiscountRate', isNumRecord, where, true)
  need(raw, 'aliases', isStrArr, where, true)
  const caps = raw.uiCapabilities as Record<string, unknown>
  for (const [key, check, optional] of CAPS_KEYS[raw.kind as ModelKind]) need(caps, key, check, `${where}.uiCapabilities`, optional)
  need(raw, 'byok', isObj, where)
  const byok = raw.byok as Record<string, unknown>
  need(byok, 'routes', Array.isArray, `${where}.byok`)
  ;(byok.routes as unknown[]).forEach((r, j) => {
    const rw = `${where}.byok.routes[${j}]`
    if (!isObj(r)) throw new CatalogError(`${rw}: not an object`)
    need(r, 'provider', isStr, rw)
    need(r, 'protocol', isStr, rw)
    need(r, 'endpoints', (v) => isObj(v) && Object.values(v).every(isStr), rw)
  })
  return raw as CatalogEntry
}

export function parseCatalog(raw: unknown): CatalogFile {
  if (!isObj(raw)) throw new CatalogError('catalog: not an object')
  need(raw, 'catalogVersion', isNum, 'catalog')
  need(raw, 'linuxRevision', isNum, 'catalog')
  need(raw, 'models', Array.isArray, 'catalog')
  const models = (raw.models as unknown[]).map(checkEntry)
  const seen = new Set<string>()
  for (const m of models) {
    for (const id of [m.id, ...(m.aliases ?? [])]) {
      if (seen.has(id)) throw new CatalogError(`catalog: duplicate model id '${id}'`)
      seen.add(id)
    }
  }
  return { catalogVersion: raw.catalogVersion as number, linuxRevision: raw.linuxRevision as number, models }
}

let bundledCatalog: CatalogFile | null = null
/** The catalog shipped with the app (`resources/generation-catalog.json`). */
export function bundledEntries(): CatalogEntry[] {
  bundledCatalog ??= parseCatalog(bundled)
  return bundledCatalog.models
}

// ---------- Providers and keys ----------

export const PROVIDER_NAMES: Record<ByokProvider, string> = {
  fal: 'fal.ai',
  replicate: 'Replicate',
  openai: 'OpenAI',
  google: 'Google',
  elevenlabs: 'ElevenLabs',
  xai: 'xAI',
  bfl: 'Black Forest Labs',
  minimax: 'MiniMax',
  byteplus: 'BytePlus',
  kling: 'Kling',
  runway: 'Runway',
  topaz: 'Topaz',
  ltx: 'LTX',
  fishaudio: 'Fish Audio',
  mirelo: 'Mirelo',
  sonilo: 'Sonilo',
  ideogram: 'Ideogram',
  recraft: 'Recraft',
  reve: 'Reve',
  krea: 'Krea',
}
export const providerName = (p: string): string => PROVIDER_NAMES[p as ByokProvider] ?? p

/** Protocols with a working adapter in this build; routes on other protocols are never selected. */
export const IMPLEMENTED_PROTOCOLS: ReadonlySet<ByokProtocol> = new Set<ByokProtocol>(['fal-queue', 'gemini-interactions', 'elevenlabs'])

/** App-settings key slots (AppSettings.apiKeys) per provider; providers without one can't be keyed yet. */
export const PROVIDER_KEY_SLOT: Partial<Record<ByokProvider, 'fal' | 'replicate' | 'openai' | 'elevenlabs' | 'google'>> = {
  fal: 'fal',
  google: 'google',
  replicate: 'replicate',
  openai: 'openai',
  elevenlabs: 'elevenlabs',
}

export type HasKey = (provider: ByokProvider) => boolean

/** Key predicate from `AppSettings.apiKeys` (raw or masked — only presence matters). */
export function hasKeyFrom(apiKeys: Record<string, string | undefined> | undefined): HasKey {
  return (p) => {
    const slot = PROVIDER_KEY_SLOT[p]
    return !!slot && !!apiKeys?.[slot]
  }
}

export const isUsableRoute = (r: ByokRoute): boolean => IMPLEMENTED_PROTOCOLS.has(r.protocol)

/** First route whose provider has a key and whose protocol is implemented (§B12.3). */
export function activeRoute(entry: CatalogEntry, hasKey: HasKey): ByokRoute | null {
  return entry.byok?.routes.find((r) => isUsableRoute(r) && hasKey(r.provider)) ?? null
}

/** The provider the user should add a key for: the first route this build can run, else the first route. */
export function keyProvider(entry: CatalogEntry): ByokProvider | null {
  const routes = entry.byok?.routes ?? []
  return (routes.find(isUsableRoute) ?? routes[0])?.provider ?? null
}
