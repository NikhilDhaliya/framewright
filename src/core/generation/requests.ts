/** Generate panel → main requests (spec 06 §B7.8) and the renderer API (`window.palmier.generation`). */
import type { PendingContext, TransitionPlacement } from './edit'
import type { UpscaleSettings } from './models'

interface Common {
  model: string
  /** Destination folder chosen by the panel (§B7.8 step 4); upscale always uses the source's folder. */
  folderId?: string | null
  /** Context captured with an AI Edit / AI Transition seed (§B7.8 step 3, §B9.4). */
  pending?: PendingContext | null
}

export type VideoInputMode = 'frames' | 'references' | 'source'

export interface VideoRequest extends Common {
  kind: 'video'
  prompt: string
  duration: number
  aspectRatio: string
  resolution: string | null
  draft: boolean
  /** null when the model has no audio toggle. */
  generateAudio: boolean | null
  mode: VideoInputMode
  frameIds: string[]
  imageRefIds: string[]
  videoRefIds: string[]
  audioRefIds: string[]
  sourceVideoId: string | null
}

export interface ImageRequest extends Common {
  kind: 'image'
  prompt: string
  aspectRatio: string
  resolution: string | null
  quality: string | null
  numImages: number
  refIds: string[]
}

export interface AudioRequest extends Common {
  kind: 'audio'
  prompt: string
  voice: string | null
  lyrics: string
  styleInstructions: string
  instrumental: boolean
  duration: number | null
  targetLanguage: string | null
  multilingual: boolean
  sourceId: string | null
  imageRefIds: string[]
  audioRefIds: string[]
}

export interface UpscaleRequest extends Common {
  kind: 'upscale'
  sourceId: string
  settings: UpscaleSettings
}

export type GenerateRequest = VideoRequest | ImageRequest | AudioRequest | UpscaleRequest

export type GenerateOutcome = { ok: true; placeholderIds: string[] } | { ok: false; error: string }

/** Audio ▸ Music (§B8): a span of the active timeline (video mode) or a duration placed at `startFrame` (text mode). */
export interface MusicRequest {
  mode: 'video' | 'text'
  model: string
  prompt: string
  timelineId: string
  startFrame: number
  frameCount: number
  spanSeconds: number
}

export type MusicPhase = 'exporting' | 'uploading' | 'generating'
export const MUSIC_PHASE_LABELS: Record<MusicPhase, string> = { exporting: 'Exporting…', uploading: 'Uploading…', generating: 'Generating…' }

/** Two captured frames for Create AI Transition (§B10 step 2), or null when the placement went stale. */
export type TransitionFramesOutcome = { ok: true; firstId: string; lastId: string } | { ok: true; stale: true } | { ok: false; error: string }

export interface GenerationApi {
  submit(req: GenerateRequest): Promise<GenerateOutcome>
  /** Cancels the job behind a generating asset. */
  cancel(assetId: string): Promise<boolean>
  /** Re-downloads a failed asset's stored result URL. */
  retryDownload(assetId: string): Promise<boolean>
  /** Audio ▸ Music generate (§B8); resolves once the job is submitted (the overlay then follows the placeholder). */
  music(req: MusicRequest): Promise<GenerateOutcome>
  /** Music phase updates while `music` runs. */
  onMusicPhase(cb: (phase: MusicPhase) => void): () => void
  /** FLUX Enhance (§B9.6): submits directly, no panel. */
  enhance(assetId: string): Promise<GenerateOutcome>
  /** Captures the frames around a gap as media (§B10 step 2). */
  captureTransitionFrames(placement: TransitionPlacement): Promise<TransitionFramesOutcome>
  /** Voice names fetched from the provider for models whose catalog voices are resolved at runtime (ElevenLabs). */
  voices(modelId: string): Promise<string[]>
}
