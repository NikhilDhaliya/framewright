/**
 * Palmier job params → fal request bodies and fal outputs → result URLs (spec 06 §B12.4, research byok-video-apis.md).
 * Field names follow the fal OpenAPI schemas the research cites; those it marks [U] are noted inline.
 */
import type { ByokRoute, CatalogEntry } from '../../../core/generation/catalog'
import { compact, imageMode, videoMode, type AudioGenerationParams, type EnhanceGenerationParams, type GenerationParams, type ImageGenerationParams, type UpscaleGenerationParams, type VideoGenerationParams } from '../../../core/generation/params'
import { parseWxH } from '../../../core/generation/labels'
import { rewritePromptTags, tagStyleFor } from '../../../core/generation/tags'
import { ProviderError } from './types'

export interface FalRequest {
  endpoint: string
  body: Record<string, unknown>
}

type Body = Record<string, unknown>

const SEEDANCE_DRAFT_PREFIX = 'seedance-draft:'

function endpointFor(entry: CatalogEntry, route: ByokRoute, mode: string, fallbacks: string[] = []): string {
  for (const m of [mode, ...fallbacks]) {
    const e = route.endpoints[m]
    if (e) return e
  }
  throw new ProviderError(`${entry.displayName} can't run this request on fal.ai.`)
}

/** `{tier}` in fal Kling endpoints: 720p → standard, 1080p → pro, 4k → 4k. */
export function klingTier(resolution: string | undefined): string {
  if (resolution === '720p') return 'standard'
  if (resolution === '4k') return '4k'
  return 'pro'
}

const first = (a: string[] | undefined) => a?.[0]

// ---------- Video ----------

function videoRequest(entry: CatalogEntry, route: ByokRoute, p: VideoGenerationParams): FalRequest {
  const mode = videoMode(p)
  let endpoint = endpointFor(entry, route, mode, mode === 'flf' ? ['i2v'] : [])
  endpoint = endpoint.replace('{tier}', klingTier(p.resolution))
  const draftSuffix = route.endpoints.draft_suffix
  if (p.draft && draftSuffix) endpoint += draftSuffix
  const prompt = rewritePromptTags(p.prompt, tagStyleFor(route, endpoint))
  const d = p.duration
  const refs = { images: p.referenceImageURLs ?? [], videos: p.referenceVideoURLs ?? [], audios: p.referenceAudioURLs ?? [] }
  let body: Body

  if (endpoint.startsWith('fal-ai/veo3.1')) {
    body = { prompt, aspect_ratio: p.aspectRatio, duration: mode === 'ref' ? '8s' : `${d}s`, resolution: p.resolution, generate_audio: p.generateAudio }
    if (mode === 'i2v') body.image_url = p.startFrameURL
    if (mode === 'flf') Object.assign(body, { first_frame_url: p.startFrameURL, last_frame_url: p.endFrameURL })
    if (mode === 'ref') body.image_urls = refs.images
  } else if (endpoint.startsWith('bytedance/seedance-')) {
    body = { prompt, duration: String(d), aspect_ratio: p.aspectRatio, resolution: p.resolution, generate_audio: p.generateAudio }
    if (mode === 'i2v' || mode === 'flf') Object.assign(body, { image_url: p.startFrameURL, end_image_url: p.endFrameURL })
    if (mode === 'ref') Object.assign(body, { image_urls: refs.images, video_urls: refs.videos, audio_urls: refs.audios })
    if (p.draft && route.endpoints.enhance) body.draft = true
  } else if (endpoint.startsWith('minimax/')) {
    body = { prompt, duration: d, resolution: p.resolution, aspect_ratio: p.aspectRatio }
    if (mode === 'i2v' || mode === 'flf') Object.assign(body, { image_url: p.startFrameURL, end_image_url: p.endFrameURL })
    if (mode === 'ref') Object.assign(body, { reference_image_urls: refs.images, reference_video_urls: refs.videos, reference_audio_urls: refs.audios })
  } else if (endpoint.startsWith('xai/grok-imagine-video')) {
    body = { prompt, duration: d, aspect_ratio: p.aspectRatio, resolution: p.resolution }
    if (mode === 'i2v') body.image_url = p.startFrameURL
    if (mode === 'ref') body.image_urls = refs.images
  } else if (endpoint.startsWith('blackforestlabs/flux-3')) {
    body = { prompt, duration: d, aspect_ratio: p.aspectRatio, generate_audio: p.generateAudio }
    if (!p.draft) body.resolution = p.resolution
    if (mode === 'i2v') body.image_url = p.startFrameURL
    if (mode === 'flf') Object.assign(body, { start_image_url: p.startFrameURL, end_image_url: p.endFrameURL })
    if (mode === 'edit') body.video_url = p.sourceVideoURL
  } else if (endpoint.includes('/motion-control')) {
    body = { prompt: prompt || undefined, video_url: p.sourceVideoURL, image_url: first(refs.images), character_orientation: 'video', keep_original_sound: true }
  } else if (endpoint.includes('/video-to-video/edit')) {
    body = { prompt, video_url: p.sourceVideoURL, image_urls: refs.images, keep_audio: true }
  } else if (endpoint.startsWith('fal-ai/kling-video/')) {
    // V3 packs image references as elements (`@Element1`); O3 takes `image_urls` (`@Image1`).
    body = { prompt, duration: String(d), aspect_ratio: p.aspectRatio, generate_audio: p.generateAudio }
    if (mode === 'i2v' || mode === 'flf') Object.assign(body, { start_image_url: p.startFrameURL, end_image_url: p.endFrameURL })
    if (refs.images.length) {
      if (endpoint.includes('/v3/')) body.elements = refs.images.map((u) => ({ frontal_image_url: u, reference_image_urls: [u] }))
      else body.image_urls = refs.images
    }
  } else if (endpoint.startsWith('veed/lipsync') || endpoint.startsWith('fal-ai/sync-lipsync')) {
    body = { video_url: p.sourceVideoURL, audio_url: first(refs.audios) }
  } else if (endpoint.startsWith('lightricks/ltx-')) {
    // [U] last-frame field name on fal LTX 2.5.
    body = { prompt, duration: d, resolution: p.resolution, aspect_ratio: p.aspectRatio, generate_audio: p.generateAudio }
    if (mode === 'i2v' || mode === 'flf') Object.assign(body, { image_url: p.startFrameURL, end_image_url: p.endFrameURL })
  } else {
    // Generic fal video shape (Wan 3.0 and anything new): [U] field names.
    body = { prompt, duration: d, resolution: p.resolution, aspect_ratio: p.aspectRatio }
    if (mode === 'i2v' || mode === 'flf') Object.assign(body, { image_url: p.startFrameURL, end_image_url: p.endFrameURL })
    if (mode === 'ref') Object.assign(body, { image_urls: refs.images, video_urls: refs.videos, audio_urls: refs.audios })
    if (mode === 'edit') body.video_url = p.sourceVideoURL
  }
  return { endpoint, body: compact(body) }
}

function enhanceRequest(entry: CatalogEntry, route: ByokRoute, p: EnhanceGenerationParams): FalRequest {
  const endpoint = endpointFor(entry, route, 'enhance')
  const cache = p.resultURLs[1]
  if (!cache) throw new ProviderError('Draft already enhanced or cache unavailable')
  if (cache.startsWith(SEEDANCE_DRAFT_PREFIX)) return { endpoint, body: { draft_id: cache.slice(SEEDANCE_DRAFT_PREFIX.length) } }
  return { endpoint, body: { draft_cache_url: cache } }
}

// ---------- Image ----------

const FAL_SIZE_ENUM: Record<string, string> = {
  '16:9': 'landscape_16_9',
  '9:16': 'portrait_16_9',
  '1:1': 'square_hd',
  '4:3': 'landscape_4_3',
  '3:4': 'portrait_4_3',
}

/** fal `image_size`: a preset enum when one matches the ratio, else explicit dimensions on a 1536 px long edge. */
export function falImageSize(aspect: string): string | { width: number; height: number } {
  if (FAL_SIZE_ENUM[aspect]) return FAL_SIZE_ENUM[aspect]
  const [w, h] = aspect.split(':').map(Number)
  if (!(w > 0) || !(h > 0)) return 'square_hd'
  const scale = 1536 / Math.max(w, h)
  const even16 = (v: number) => Math.max(16, Math.round((v * scale) / 16) * 16)
  return { width: even16(w), height: even16(h) }
}

function imageRequest(entry: CatalogEntry, route: ByokRoute, p: ImageGenerationParams): FalRequest {
  const mode = imageMode(p)
  const endpoint = endpointFor(entry, route, mode)
  const prompt = p.prompt
  const images = p.imageURLs ?? []
  let body: Body
  if (endpoint.startsWith('openai/gpt-image')) {
    const wh = p.resolution ? parseWxH(p.resolution) : null
    body = { prompt, image_size: wh ? { width: wh[0], height: wh[1] } : undefined, quality: p.quality, num_images: p.numImages, output_format: 'png' }
  } else if (endpoint.startsWith('fal-ai/nano-banana')) {
    body = { prompt, aspect_ratio: p.aspectRatio, resolution: p.resolution, num_images: p.numImages, output_format: 'png' }
  } else if (endpoint.includes('seedream')) {
    // Palmier's Seedream aspect ids are already fal `image_size` enums (landscape_16_9 …).
    body = { prompt, image_size: p.aspectRatio, num_images: p.numImages }
  } else if (endpoint.startsWith('fal-ai/recraft')) {
    body = { prompt, image_size: falImageSize(p.aspectRatio), num_images: p.numImages }
  } else {
    // Grok Imagine, Ideogram, Reve and other aspect_ratio-style endpoints.
    body = { prompt, aspect_ratio: p.aspectRatio, resolution: p.resolution, num_images: p.numImages }
  }
  if (mode === 'edit') body.image_urls = images
  return { endpoint, body: compact(body) }
}

// ---------- Audio ----------

export function audioModeKey(route: ByokRoute, p: AudioGenerationParams): string {
  const e = route.endpoints
  if (p.videoURL) {
    for (const k of ['v2m', 'v2a']) if (e[k]) return k
  }
  if (p.sourceURL) {
    for (const k of ['cleanup', 'dub']) if (e[k]) return k
  }
  for (const k of ['gen', 'tts', 'music', 't2m', 'sfx']) if (e[k]) return k
  return Object.keys(e)[0] ?? 'gen'
}

function audioRequest(entry: CatalogEntry, route: ByokRoute, p: AudioGenerationParams): FalRequest {
  const mode = audioModeKey(route, p)
  const endpoint = endpointFor(entry, route, mode)
  const prompt = rewritePromptTags(p.prompt, tagStyleFor(route, endpoint))
  let body: Body
  if (endpoint.startsWith('bytedance/seed-audio')) {
    body = { prompt, voice: p.voice, audio_urls: p.referenceAudioURLs, image_url: p.referenceImageURL, multilingual: p.multilingual }
  } else if (endpoint.startsWith('elevenlabs/tts')) {
    body = { text: prompt, voice: p.voice }
  } else if (endpoint.startsWith('google/gemini') && endpoint.includes('tts')) {
    // [U] fal Gemini TTS field names.
    body = { text: prompt, voice: p.voice, style_instructions: p.styleInstructions }
  } else if (endpoint.startsWith('elevenlabs/music')) {
    body = { prompt, music_length_ms: p.durationSeconds != null ? p.durationSeconds * 1000 : undefined, force_instrumental: p.instrumental }
  } else if (endpoint.startsWith('fal-ai/minimax-music')) {
    body = { prompt, lyrics: p.instrumental ? undefined : p.lyrics, is_instrumental: p.instrumental }
  } else if (endpoint.startsWith('fal-ai/lyria')) {
    body = { prompt }
  } else if (endpoint === 'sonilo/v1.1/video-to-music') {
    body = { video_url: p.videoURL, prompt: prompt || undefined, duration: p.durationSeconds, num_samples: 1 }
  } else if (endpoint === 'sonilo/v1.1/text-to-music') {
    body = { prompt, duration: p.durationSeconds }
  } else if (endpoint.startsWith('sonilo/') && endpoint.includes('sound-effects')) {
    body = { video_url: p.videoURL, prompt: prompt || undefined, audio_format: 'wav' }
  } else if (endpoint.startsWith('mirelo-ai/')) {
    const dur = p.durationSeconds != null ? Math.min(10, Math.max(1, p.durationSeconds)) : undefined
    body = { video_url: p.videoURL, text_prompt: prompt || undefined, duration: dur, num_samples: 2, start_offset: 0 }
  } else if (endpoint.includes('sound-effects')) {
    body = { text: prompt, duration_seconds: p.durationSeconds, prompt_influence: 0.3 }
  } else if (endpoint.includes('audio-isolation')) {
    body = { audio_url: p.sourceURL }
  } else if (endpoint.includes('dubbing')) {
    // [U] fal ElevenLabs dubbing field names.
    body = { audio_url: p.sourceURL, target_lang: p.targetLanguage }
  } else {
    body = { prompt, duration: p.durationSeconds, video_url: p.videoURL, audio_url: p.sourceURL }
  }
  return { endpoint, body: compact(body) }
}

// ---------- Upscale ----------

function upscaleRequest(entry: CatalogEntry, route: ByokRoute, p: UpscaleGenerationParams): FalRequest {
  const isVideo = (entry.uiCapabilities as { supportedTypes: string[] }).supportedTypes.includes('video') && !!route.endpoints.video
  const endpoint = endpointFor(entry, route, isVideo ? 'video' : 'image')
  const sel = p.settings.selections
  const nums = p.settings.numbers
  const source = isVideo ? { video_url: p.sourceURL } : { image_url: p.sourceURL }
  const target = sel.targetResolution
  const sourceEdge = Math.max(p.sourceWidth ?? 0, p.sourceHeight ?? 0)
  const factor = () => {
    const edge = target === '1080p' ? 1920 : 3840
    return sourceEdge > 0 ? Math.min(4, Math.max(1, Math.round((edge / sourceEdge) * 100) / 100)) : 2
  }
  let body: Body
  if (endpoint.startsWith('fal-ai/topaz')) {
    body = { ...source, upscale_factor: factor(), model: sel.enhancementModel }
    if (isVideo) {
      if (sel.targetFPS && sel.targetFPS !== 'source') body.target_fps = Number(sel.targetFPS)
      for (const k of ['noise', 'compression', 'halo', 'recover_detail', 'grain']) if (nums[k] !== undefined) body[k] = nums[k]
      body.H264_output = true
    }
  } else if (endpoint.startsWith('fal-ai/bytedance-upscaler')) {
    const fps = sel.targetFPS && sel.targetFPS !== 'source' ? Number(sel.targetFPS) : Math.min(120, Math.max(24, Math.round(p.sourceFPS ?? 30)))
    body = { ...source, target_resolution: target, target_fps: fps, enhancement_preset: sel.enhancementPreset }
  } else if (endpoint.startsWith('fal-ai/seedvr')) {
    body = { ...source, upscale_mode: 'target', target_resolution: target === '1080p' ? '1080p' : '2160p', noise_scale: nums.noise }
    if (isVideo) body.output_format = 'X264 (.mp4)'
  } else {
    body = { ...source, upscale_factor: factor() }
  }
  return { endpoint, body: compact(body) }
}

export function falRequest(entry: CatalogEntry, route: ByokRoute, params: GenerationParams): FalRequest {
  switch (params.kind) {
    case 'video':
      return videoRequest(entry, route, params)
    case 'image':
      return imageRequest(entry, route, params)
    case 'audio':
      return audioRequest(entry, route, params)
    case 'upscale':
      return upscaleRequest(entry, route, params)
    case 'enhance':
      return enhanceRequest(entry, route, params)
  }
}

// ---------- Outputs ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const fileUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:|^data:/.test(v) ? v : isObj(v) && typeof v.url === 'string' ? v.url : null)

/** Result URLs in output order; drafts append their enhance cache (§B9.6: `[video, draft cache]`). */
export function falOutputUrls(json: unknown): string[] {
  if (!isObj(json)) return []
  const urls: string[] = []
  for (const key of ['video', 'images', 'image', 'audio', 'audio_file', 'audio_url', 'output', 'file']) {
    const v = json[key]
    const items = Array.isArray(v) ? v : v === undefined ? [] : [v]
    for (const item of items) {
      const u = fileUrl(item)
      if (u) urls.push(u)
    }
    if (urls.length) break
  }
  if (!urls.length) return []
  const cache = fileUrl(json.draft_cache)
  if (cache) urls.push(cache)
  else if (typeof json.draft_id === 'string' && json.draft_id) urls.push(`${SEEDANCE_DRAFT_PREFIX}${json.draft_id}`)
  return urls
}
