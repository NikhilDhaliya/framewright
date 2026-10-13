/**
 * Provider-neutral job parameters (spec 06 §B3) — the adapters' input — plus mode selection (§B12.0) and the
 * persisted job handle (§B5.2).
 */
import type { ByokProvider } from './catalog'
import type { UpscaleSettings } from './models'

/** Keys present only when set; arrays omitted when empty (Mac `encode`). */
export interface VideoGenerationParams {
  kind: 'video'
  prompt: string
  duration: number
  sourceVideoDuration?: number
  aspectRatio: string
  resolution?: string
  sourceVideoURL?: string
  startFrameURL?: string
  endFrameURL?: string
  referenceImageURLs?: string[]
  referenceVideoURLs?: string[]
  referenceAudioURLs?: string[]
  generateAudio: boolean
  draft?: boolean
}

export interface ImageGenerationParams {
  kind: 'image'
  prompt: string
  aspectRatio: string
  resolution?: string
  quality?: string
  imageURLs?: string[]
  numImages: number
}

export interface AudioGenerationParams {
  kind: 'audio'
  prompt: string
  voice?: string
  lyrics?: string
  styleInstructions?: string
  instrumental: boolean
  durationSeconds?: number
  videoURL?: string
  sourceURL?: string
  targetLanguage?: string
  referenceImageURL?: string
  referenceAudioURLs?: string[]
  multilingual?: boolean
}

export interface UpscaleGenerationParams {
  kind: 'upscale'
  sourceURL: string
  durationSeconds: number
  sourceWidth?: number
  sourceHeight?: number
  sourceFPS?: number
  settings: UpscaleSettings
}

/** Re-render of a finished draft (§B9.6). */
export interface EnhanceGenerationParams {
  kind: 'enhance'
  /** The draft's stored `resultURLs`. */
  resultURLs: string[]
}

export type GenerationParams = VideoGenerationParams | ImageGenerationParams | AudioGenerationParams | UpscaleGenerationParams | EnhanceGenerationParams

/** Drops undefined keys and empty arrays, like the Mac encoders. */
export function compact<T extends object>(o: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out as T
}

export type VideoMode = 't2v' | 'i2v' | 'flf' | 'ref' | 'edit'

/** §B12.0: edit when a source video, ref when any references, flf with both frames, i2v with a start frame, else t2v. */
export function videoMode(p: VideoGenerationParams): VideoMode {
  if (p.sourceVideoURL) return 'edit'
  if (p.referenceImageURLs?.length || p.referenceVideoURLs?.length || p.referenceAudioURLs?.length) return 'ref'
  if (p.startFrameURL && p.endFrameURL) return 'flf'
  if (p.startFrameURL) return 'i2v'
  return 't2v'
}

export const imageMode = (p: ImageGenerationParams): 't2i' | 'edit' => (p.imageURLs?.length ? 'edit' : 't2i')

/** Persisted Linux job handle inside `generationInput.byokJob` (§B5.2). */
export interface ByokJobHandle {
  provider: ByokProvider
  endpoint: string
  requestId: string
  statusUrl?: string
  responseUrl?: string
  cancelUrl?: string
  /** ISO-8601. */
  submittedAt: string
}

export function isByokJobHandle(v: unknown): v is ByokJobHandle {
  if (!v || typeof v !== 'object') return false
  const h = v as Record<string, unknown>
  return typeof h.provider === 'string' && typeof h.endpoint === 'string' && typeof h.requestId === 'string' && typeof h.submittedAt === 'string'
}
