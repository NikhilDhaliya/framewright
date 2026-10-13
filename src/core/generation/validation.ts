/**
 * Validation with the Mac's verbatim messages (spec 06 §B1.3), shared by the Generate panel and the agent tools.
 * Every function returns the error text, or null when valid.
 */
import type { ClipType } from '../model'
import type { AudioModel, ImageModel, VideoModel } from './models'
import type { AudioGenerationParams } from './params'

export function unsupportedValue(displayName: string, field: string, value: string, allowed: string[]): string {
  return `${displayName} does not support ${field} '${value}'. Valid: ${allowed.join(', ')}.`
}

/** What reference validation needs about a library asset. */
export interface RefAsset {
  id: string
  name: string
  type: ClipType
  /** Seconds; 0 when unknown. */
  duration: number
  /** Lower-case file extension of the source file. */
  ext?: string
  /** Absolute source path (matches a pending trim's source). */
  path?: string | null
}

/** `TrimmedSource` (§B4.6): a clip's visible range of its source. */
export interface TrimmedSource {
  sourcePath: string
  trimStartFrame: number
  trimEndFrame: number
  sourceFramesConsumed: number
  fps: number
}
export const hasTrim = (t: TrimmedSource | null | undefined): t is TrimmedSource => !!t && (t.trimStartFrame > 0 || t.trimEndFrame > 0)
export const trimSeconds = (t: TrimmedSource): number => t.sourceFramesConsumed / t.fps

// ---------- Video ----------

export function validateVideo(m: VideoModel, duration: number, aspectRatio: string, resolution: string | null | undefined): string | null {
  if (m.durations.length && !m.durations.includes(duration)) {
    return unsupportedValue(m.displayName, 'duration', `${duration}s`, m.durations.map((d) => `${d}s`))
  }
  if (m.aspectRatios.length && aspectRatio && !m.aspectRatios.includes(aspectRatio)) {
    return unsupportedValue(m.displayName, 'aspect ratio', aspectRatio, m.aspectRatios)
  }
  const allowed = m.resolutions
  if (allowed && resolution && !allowed.includes(resolution)) return unsupportedValue(m.displayName, 'resolution', resolution, allowed)
  return null
}

export function validateSourceDuration(m: VideoModel, duration: number): string | null {
  if (!Number.isFinite(duration) || duration <= 0) return 'Loading video metadata…'
  const max = m.maxSourceVideoSeconds
  const label = m.sourceDurationLimitLabel
  if (max == null || duration <= max || !label) return null
  return `${m.displayName} supports source videos up to ${label}. Trim the clip to continue.`
}

/** `VideoGenerationSubmission.InputAssets` (Mac): what a video request references, in slot order. */
export interface VideoInputAssets {
  sourceVideo?: RefAsset | null
  frames: RefAsset[]
  imageRefs: RefAsset[]
  videoRefs: RefAsset[]
  audioRefs: RefAsset[]
}

export const allVideoRefs = (a: VideoInputAssets): RefAsset[] => [...a.imageRefs, ...a.videoRefs, ...a.audioRefs]
/** Upload order for text/image/reference-to-video (§B4.3). */
export const textToVideoReferences = (a: VideoInputAssets): RefAsset[] => [...a.frames, ...allVideoRefs(a)]
/** Upload order for edit / extend / lip sync (§B4.3). */
export const editReferences = (a: VideoInputAssets): RefAsset[] => [...(a.sourceVideo ? [a.sourceVideo] : []), ...allVideoRefs(a)]

export function validateVideoInputs(m: VideoModel, a: VideoInputAssets, trim?: TrimmedSource | null): string | null {
  if (m.requiresSourceVideo || a.sourceVideo) {
    const src = a.sourceVideo
    if (!src) return `Model '${m.id}' requires a source video.`
    if (src.type !== 'video') return 'sourceVideoMediaRef must reference a video asset'
    if (a.frames.length) return `${m.displayName} does not accept frame references`
    if (m.requiresReferenceImage && !a.imageRefs.length) return `${m.displayName} requires an image reference`
    if (m.requiresReferenceAudio && !a.audioRefs.length) return `${m.displayName} requires an audio reference`
    return validateReferences(m, a, false, trim)
  }
  if (a.frames.length > 2) return `${m.displayName} accepts at most 2 frame references`
  if (a.frames.length && !m.supportsFirstFrame) return `${m.displayName} does not accept frame references`
  if (a.frames.length > 1 && !m.supportsLastFrame) return `${m.displayName} does not accept a last frame`
  if (m.framesAndReferencesExclusive && a.frames.length && allVideoRefs(a).length) return `${m.displayName} uses frames OR references, not both. Clear one side.`
  return validateReferences(m, a, true, trim)
}

function validateReferences(m: VideoModel, a: VideoInputAssets, includingFrames: boolean, trim?: TrimmedSource | null): string | null {
  const label = a.sourceVideo ? 'reference(s)' : 'references'
  if (a.imageRefs.length > m.maxReferenceImages) return `${m.displayName} accepts at most ${m.maxReferenceImages} image ${label}`
  if (a.videoRefs.length > m.maxReferenceVideos) return `${m.displayName} accepts at most ${m.maxReferenceVideos} video ${label}`
  if (a.audioRefs.length > m.maxReferenceAudios) return `${m.displayName} accepts at most ${m.maxReferenceAudios} audio ${label}`
  const total = allVideoRefs(a).length
  if (m.maxTotalReferences != null && total > m.maxTotalReferences) return `${m.displayName} accepts at most ${m.maxTotalReferences} references total`
  const order = includingFrames ? textToVideoReferences(a) : editReferences(a)
  const refSeconds = (r: RefAsset) => {
    if (!hasTrim(trim) || r.path !== trim.sourcePath) return r.duration
    return order.find((x) => x.path === trim.sourcePath)?.id === r.id ? trimSeconds(trim) : r.duration
  }
  const vcap = m.maxCombinedVideoRefSeconds
  if (vcap != null && a.videoRefs.reduce((s, r) => s + refSeconds(r), 0) > vcap) return `Combined video reference duration exceeds ${Math.trunc(vcap)}s`
  const acap = m.maxCombinedAudioRefSeconds
  if (acap != null && a.audioRefs.reduce((s, r) => s + refSeconds(r), 0) > acap) return `Combined audio reference duration exceeds ${Math.trunc(acap)}s`
  const groups: [RefAsset[], ClipType, string][] = [
    [a.imageRefs, 'image', 'referenceImageMediaRefs'],
    [a.videoRefs, 'video', 'referenceVideoMediaRefs'],
    [a.audioRefs, 'audio', 'referenceAudioMediaRefs'],
  ]
  if (includingFrames) groups.unshift([a.frames, 'image', 'frame references'])
  for (const [assets, expected, glabel] of groups) {
    for (const r of assets) if (r.type !== expected) return `${glabel} entry '${r.id}' must be a ${expected} asset`
  }
  return null
}

// ---------- Image ----------

export function validateImage(m: ImageModel, aspectRatio: string, resolution: string | null | undefined, quality: string | null | undefined, imageRefCount: number, numImages: number): string | null {
  if (m.aspectRatios.length && aspectRatio && !m.aspectRatios.includes(aspectRatio)) return unsupportedValue(m.displayName, 'aspect ratio', aspectRatio, m.aspectRatios)
  if (m.resolutions && resolution && !m.resolutions.includes(resolution)) return unsupportedValue(m.displayName, 'resolution', resolution, m.resolutions)
  if (m.qualities && quality && !m.qualities.includes(quality)) return unsupportedValue(m.displayName, 'quality', quality, m.qualities)
  if (imageRefCount > 0 && !m.supportsImageReference) return `${m.displayName} does not accept reference images.`
  if (numImages < 1 || numImages > m.maxImages) return `${m.displayName} supports 1…${m.maxImages} image${m.maxImages === 1 ? '' : 's'} per request (got ${numImages}).`
  return null
}

// ---------- Audio ----------

export function validateAudioParams(m: AudioModel, p: AudioGenerationParams): string | null {
  const promptLen = [...p.prompt.trim()].length
  if (m.inputs.includes('text') && promptLen < m.minPromptLength) return `${m.displayName} requires prompt ≥ ${m.minPromptLength} characters (got ${promptLen}).`
  const voices = m.runtimeVoices ? null : m.voices // runtime voices (names or ids) are resolved by the adapter
  if (voices && p.voice && !voices.includes(p.voice)) {
    return unsupportedValue(m.displayName, 'voice', p.voice, [...voices.slice(0, 6), ...(voices.length > 6 ? ['…'] : [])])
  }
  const durations = m.durations
  if (durations && p.durationSeconds != null && !durations.includes(p.durationSeconds)) {
    return unsupportedValue(m.displayName, 'duration', `${p.durationSeconds}s`, durations.map((d) => `${d}s`))
  }
  const range = m.durationRange
  if (range && p.durationSeconds != null && (p.durationSeconds < range.minimum || p.durationSeconds > range.maximum)) {
    return `${m.displayName} duration must be ${range.minimum}-${range.maximum} seconds.`
  }
  const langs = m.targetLanguages
  if (langs) {
    if (!p.targetLanguage) return 'Choose a target language.'
    if (!langs.includes(p.targetLanguage)) return unsupportedValue(m.displayName, 'target language', p.targetLanguage, langs)
  }
  return null
}

export function validateAudioSpan(m: AudioModel, spanSeconds: number): string | null {
  const s = Math.round(spanSeconds)
  if (s < m.minSeconds) return `${m.displayName} needs at least ${m.minSeconds}s of source media (selection is ${s}s).`
  if (s > m.maxSeconds) return `${m.displayName} accepts at most ${m.maxSeconds}s of source media (selection is ${s}s).`
  return null
}

export function validateAudioReferences(m: AudioModel, imageRefs: RefAsset[], audioRefs: RefAsset[]): string | null {
  if (imageRefs.length > m.maxReferenceImages) return `${m.displayName} accepts at most ${m.maxReferenceImages} image reference(s).`
  if (audioRefs.length > m.maxReferenceAudios) return `${m.displayName} accepts at most ${m.maxReferenceAudios} audio references.`
  if (m.referenceImagesAndAudiosExclusive && imageRefs.length && audioRefs.length) return `${m.displayName} uses either image or audio references, not both.`
  if (imageRefs.some((r) => r.type !== 'image')) return 'Image references must be image assets.'
  for (const r of audioRefs) {
    if (r.type !== 'audio') return 'Audio references must be audio assets.'
    const max = m.maxReferenceAudioSeconds
    if (max != null && (!Number.isFinite(r.duration) || r.duration <= 0 || r.duration > max)) return `${r.name} must be valid audio no longer than ${Math.trunc(max)} seconds.`
    const exts = m.referenceAudioExtensions
    if (exts && !exts.includes((r.ext ?? '').toLowerCase())) return `${r.name} must be a WAV or MP3 file.`
  }
  return null
}
