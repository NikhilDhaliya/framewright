import { describe, expect, it } from 'vitest'
import raw from '../../resources/generation-catalog.json'
import spec from '../../docs/port-spec/06-generation-catalog.json'
import { activeRoute, bundledEntries, CatalogError, hasKeyFrom, parseCatalog, type CatalogEntry } from '../../src/core/generation/catalog'
import { aspectRatioDisplayLabel, resolutionDisplayLabel } from '../../src/core/generation/labels'
import { modelSet, nearestSupportedDuration, type UpscaleModel } from '../../src/core/generation/models'
import { parseStatus, displayStatus, FOREIGN_JOB_MESSAGE } from '../../src/core/generation/status'
import { rewritePromptTags, tagStyleFor } from '../../src/core/generation/tags'
import {
  validateAudioParams,
  validateAudioReferences,
  validateAudioSpan,
  validateImage,
  validateSourceDuration,
  validateVideo,
  validateVideoInputs,
  type RefAsset,
} from '../../src/core/generation/validation'

const fal = hasKeyFrom({ fal: 'k' })
const none = hasKeyFrom({})
const ref = (id: string, type: RefAsset['type'], duration = 5, ext?: string): RefAsset => ({ id, name: id, type, duration, ext })
const noRefs = { frames: [], imageRefs: [], videoRefs: [], audioRefs: [] }

describe('bundled catalog', () => {
  it('ships the spec catalog unchanged and decodes strictly', () => {
    expect(raw).toEqual(spec)
    const entries = bundledEntries()
    expect(entries).toHaveLength(46)
    expect(entries.every((e) => e.byok!.routes.length > 0)).toBe(true)
  })

  it('rejects the whole catalog when one entry misses a required key or has the wrong type', () => {
    const models = (raw as { models: CatalogEntry[] }).models
    const broken = structuredClone(models)
    delete (broken[3].uiCapabilities as unknown as Record<string, unknown>).aspectRatios
    expect(() => parseCatalog({ ...raw, models: broken })).toThrow(new CatalogError("models[3] (seedance-2-fast).uiCapabilities: missing required key 'aspectRatios'"))
    const wrong = structuredClone(models)
    ;(wrong[0] as unknown as Record<string, unknown>).displayName = 7
    expect(() => parseCatalog({ ...raw, models: wrong })).toThrow("'displayName' has the wrong type")
    const dup = structuredClone(models)
    dup[1].aliases = ['minimax-h3']
    expect(() => parseCatalog({ ...raw, models: dup })).toThrow("duplicate model id 'minimax-h3'")
  })
})

describe('availability and routes', () => {
  it('shows nothing without keys and only fal-runnable models with a fal key', () => {
    expect(modelSet(none).canGenerate).toBe(false)
    const set = modelSet(fal)
    expect(set.available('video').map((m) => m.id)).not.toContain('runway-aleph-2')
    expect(set.available('audio').map((m) => m.id)).not.toContain('openai-gpt-4o-mini-tts')
    expect(set.available('image')[0].id).toBe('gpt-image-2')
    expect(set.findImage('gpt-image-2')!.route!.provider).toBe('fal')
    // An OpenAI key alone can't run GPT Image yet (no openai-images adapter this round).
    expect(modelSet(hasKeyFrom({ openai: 'k' })).findImage('gpt-image-2')!.hasKey).toBe(false)
    expect(modelSet(none).findAudio('openai-gpt-4o-mini-tts')!.keyProviderName).toBe('OpenAI')
    expect(modelSet(none).findVideo('minimax-h3')!.keyProviderName).toBe('fal.ai')
  })

  it('skips disabled models and resolves Linux aliases', () => {
    const set = modelSet(fal, ['minimax-h3'])
    expect(set.available('video')[0].id).toBe('hailuo-03-max')
    expect(set.find('hailuo-03')!.id).toBe('hailuo-03-max')
    expect(set.find('seedance-2')!.id).toBe('seedance-2.0')
    expect(set.displayName('gone-model')).toBe('gone-model')
  })

  it('takes the first keyed route and narrows capabilities to its endpoints', () => {
    const grok = bundledEntries().find((e) => e.id === 'grok-imagine-video')!
    expect(activeRoute(grok, fal)!.provider).toBe('fal')
    const m = modelSet(fal).findVideo('grok-imagine-video')!
    expect(m.supportsFirstFrame).toBe(true)
    expect(m.supportsLastFrame).toBe(false)
    expect(m.maxReferenceImages).toBe(7)
    expect(modelSet(none).findVideo('grok-imagine-video')!.supportsLastFrame).toBe(true)
    expect(modelSet(fal).findVideo('flux-3')!.supportsDraft).toBe(true)
    expect(modelSet(fal).findVideo('seedance-2.5')!.supportsDraft).toBe(true)
    expect(modelSet(fal).findVideo('seedance-2.0')!.supportsDraft).toBe(false)
  })
})

describe('derived properties (§B1.2)', () => {
  const set = modelSet(fal)
  it('picks the special-purpose video models by capability', () => {
    expect(set.editModel!.id).toBe('kling-o3-edit')
    expect(set.lipSyncModel!.id).toBe('veed-lipsync-v2')
    expect(set.reframeModel!.id).toBe('minimax-h3')
    expect(set.firstAndLastFrameModel!.id).toBe('minimax-h3')
  })

  it('computes durations, extend and billing like the Mac', () => {
    const flux = set.findVideo('flux-3')!
    expect(flux.supportsSourceVideo).toBe(true)
    expect(flux.usesOutputDuration).toBe(true)
    expect(flux.hasAudioToggle).toBe(true)
    expect(flux.supportedDuration(7)).toBe(8)
    expect(flux.supportedDuration(30)).toBe(20)
    expect(nearestSupportedDuration(7, [5, 6, 8])).toBe(6)
    expect(nearestSupportedDuration(2.4, [])).toBe(2)
    const lip = set.findVideo('veed-lipsync-v2')!
    expect(lip.billingDurationSeconds(9, 3.4)).toBe(3)
    expect(lip.billingDurationSeconds(9, null)).toBeNull()
    expect(set.findVideo('minimax-h3')!.preferredHighResolution).toBe('2K')
    expect(set.findImage('nano-banana-pro')!.maxImages).toBe(4)
    expect(set.findAudio('elevenlabs-dubbing')!.usesSourceURL).toBe(true)
    expect(set.findAudio('sonilo-v1.1-video-to-music')!.acceptsSource('video')).toBe(true)
    expect(set.findAudio('sonilo-v1.1-video-to-music')!.acceptsSource('audio')).toBe(false)
  })

  it('filters upscale options for the source and normalizes to the last available', () => {
    const topaz = set.findUpscale('topaz-video-upscaler') as UpscaleModel
    const fps = topaz.selectSettings.find((s) => s.id === 'targetFPS')!
    expect(topaz.availableOptions(fps, { type: 'video', sourceFPS: 30 }).map((o) => o.value)).toEqual(['source', '60'])
    expect(topaz.availableOptions(fps, { type: 'video', sourceFPS: 90 }).map((o) => o.value)).toEqual(['60'])
    const res = topaz.selectSettings.find((s) => s.id === 'targetResolution')!
    expect(topaz.availableOptions(res, { type: 'video', sourceWidth: 3840, sourceHeight: 2160 }).map((o) => o.value)).toEqual(['4k'])
    expect(topaz.normalizedSettings({ selections: { targetResolution: '1080p' }, numbers: {}, toggles: {} }, { type: 'video', sourceWidth: 3840, sourceHeight: 2160, sourceFPS: 24 }).selections.targetResolution).toBe('4k')
    expect(topaz.supports({ type: 'image' })).toBe(false)
    expect(topaz.defaultSettings).toEqual({ selections: { targetResolution: '4k', targetFPS: 'source', enhancementModel: 'Proteus' }, numbers: {}, toggles: {} })
  })
})

describe('validation messages (§B1.3, verbatim)', () => {
  const set = modelSet(fal)
  const h3 = set.findVideo('minimax-h3')!
  it('video settings', () => {
    expect(validateVideo(h3, 4, '16:9', '768P')).toBe("MiniMax H3 does not support duration '4s'. Valid: 5s, 6s, 7s, 8s, 9s, 10s, 11s, 12s, 13s, 14s, 15s.")
    expect(validateVideo(h3, 5, '2:1', '768P')).toBe("MiniMax H3 does not support aspect ratio '2:1'. Valid: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9.")
    expect(validateVideo(h3, 5, '16:9', '4k')).toBe("MiniMax H3 does not support resolution '4k'. Valid: 768P, 2K.")
    expect(validateVideo(h3, 5, '', null)).toBeNull()
    const edit = set.findVideo('kling-o3-edit')!
    expect(validateSourceDuration(edit, 0)).toBe('Loading video metadata…')
    expect(validateSourceDuration(edit, 16)).toBe('Kling O3 Edit supports source videos up to 15 seconds. Trim the clip to continue.')
    expect(validateSourceDuration(edit, 15)).toBeNull()
  })

  it('video references', () => {
    expect(validateVideoInputs(h3, { ...noRefs, frames: [ref('f', 'image')], imageRefs: [ref('i', 'image')] })).toBe('MiniMax H3 uses frames OR references, not both. Clear one side.')
    expect(validateVideoInputs(h3, { ...noRefs, frames: [ref('a', 'image'), ref('b', 'image'), ref('c', 'image')] })).toBe('MiniMax H3 accepts at most 2 frame references')
    expect(validateVideoInputs(h3, { ...noRefs, videoRefs: [ref('v1', 'video', 10), ref('v2', 'video', 6)] })).toBe('Combined video reference duration exceeds 15s')
    expect(validateVideoInputs(h3, { ...noRefs, imageRefs: [ref('x', 'video')] })).toBe("referenceImageMediaRefs entry 'x' must be a image asset")
    expect(validateVideoInputs(h3, { ...noRefs, imageRefs: Array.from({ length: 10 }, (_, i) => ref(`i${i}`, 'image')) })).toBe('MiniMax H3 accepts at most 9 image references')
    const lip = set.findVideo('veed-lipsync-v2')!
    expect(validateVideoInputs(lip, noRefs)).toBe("Model 'veed-lipsync-v2' requires a source video.")
    expect(validateVideoInputs(lip, { ...noRefs, sourceVideo: ref('s', 'video') })).toBe('VEED Lip Sync v2 requires an audio reference')
    expect(validateVideoInputs(lip, { ...noRefs, sourceVideo: ref('s', 'image') })).toBe('sourceVideoMediaRef must reference a video asset')
    const grok = set.findVideo('grok-imagine-video')!
    expect(validateVideoInputs(grok, { ...noRefs, frames: [ref('a', 'image'), ref('b', 'image')] })).toBe('Grok Imagine Video does not accept a last frame')
  })

  it('image, audio params, spans and audio references', () => {
    const nb = set.findImage('nano-banana-pro')!
    expect(validateImage(nb, '16:9', '8K', null, 0, 1)).toBe("Nano Banana Pro does not support resolution '8K'. Valid: 1K, 2K, 4K.")
    expect(validateImage(nb, '16:9', '1K', null, 0, 5)).toBe('Nano Banana Pro supports 1…4 images per request (got 5).')
    expect(validateImage(set.findImage('grok-imagine')!, '16:9', '1k', null, 1, 1)).toBe('Grok Imagine 2 does not accept reference images.')
    const music = set.findAudio('elevenlabs-music')!
    expect(validateAudioParams(music, { kind: 'audio', prompt: ' ', instrumental: false })).toBe('ElevenLabs Music requires prompt ≥ 1 characters (got 0).')
    expect(validateAudioParams(music, { kind: 'audio', prompt: 'lofi', instrumental: false, durationSeconds: 900 })).toBe('ElevenLabs Music duration must be 3-600 seconds.')
    const dub = set.findAudio('elevenlabs-dubbing')!
    expect(validateAudioParams(dub, { kind: 'audio', prompt: '', instrumental: false })).toBe('Choose a target language.')
    expect(validateAudioParams(dub, { kind: 'audio', prompt: '', instrumental: false, targetLanguage: 'xx' })).toBe(
      "ElevenLabs Dubbing does not support target language 'xx'. Valid: es, fr, de, it, pt, ja, ko, zh, hi, ar, ru, nl, pl, tr, en.",
    )
    const tts = set.findAudio('gemini-tts')!
    expect(validateAudioParams(tts, { kind: 'audio', prompt: 'hi', instrumental: false, voice: 'Nobody' })).toBe(
      "Gemini 3.8 Flash TTS does not support voice 'Nobody'. Valid: Kore, Zephyr, Puck, Charon, Fenrir, Leda, ….",
    )
    const mirelo = set.findAudio('mirelo-sfx-v1.5-video-to-audio')!
    expect(validateAudioSpan(mirelo, 12.4)).toBe('Mirelo SFX v1.5 accepts at most 10s of source media (selection is 12s).')
    expect(validateAudioSpan(mirelo, 0.4)).toBe('Mirelo SFX v1.5 needs at least 1s of source media (selection is 0s).')
    const seed = set.findAudio('seed-audio-1.0')!
    expect(validateAudioReferences(seed, [ref('i', 'image')], [ref('a', 'audio', 3, 'mp3')])).toBe('Seed Audio 1.0 uses either image or audio references, not both.')
    expect(validateAudioReferences(seed, [], [ref('a', 'audio', 40, 'mp3')])).toBe('a must be valid audio no longer than 30 seconds.')
    expect(validateAudioReferences(seed, [], [ref('a', 'audio', 3, 'm4a')])).toBe('a must be a WAV or MP3 file.')
    expect(validateAudioReferences(seed, [], [ref('a', 'audio', 3, 'wav')])).toBeNull()
  })
})

describe('labels, tags and status', () => {
  it('formats resolution and aspect ids like the Mac', () => {
    expect(resolutionDisplayLabel('1080x1920')).toBe('Portrait 1080p')
    expect(resolutionDisplayLabel('1536x1024')).toBe('Landscape')
    expect(resolutionDisplayLabel('2048x2048')).toBe('Square')
    expect(resolutionDisplayLabel('2048x1152')).toBe('Landscape 2048p')
    expect(resolutionDisplayLabel('2K')).toBe('2K')
    expect(aspectRatioDisplayLabel('landscape_16_9')).toBe('Landscape 16:9')
    expect(aspectRatioDisplayLabel('square_hd')).toBe('Square HD')
    expect(aspectRatioDisplayLabel('16:9')).toBe('16:9')
  })

  it('rewrites prompt tags per provider syntax', () => {
    const p = 'Put @Image1 and @Element2 in @Video1 with @Audio1'
    expect(rewritePromptTags(p, 'palmier')).toBe(p)
    expect(rewritePromptTags(p, 'xai')).toBe('Put <IMAGE_0> and <IMAGE_1> in @Video1 with <AUDIO_0>')
    expect(rewritePromptTags(p, 'byteplus')).toBe('Put [Image 1] and [Image 2] in [Video 1] with [Audio 1]')
    expect(rewritePromptTags(p, 'minimax')).toBe('Put Image 1 and Image 2 in reference video 1 with reference audio 1')
    expect(rewritePromptTags(p, 'kling-official')).toBe('Put <<<image_1>>> and <<<image_2>>> in @Video1 with @Audio1')
    const route = { provider: 'fal' as const, protocol: 'fal-queue' as const, endpoints: {} }
    expect(tagStyleFor(route, 'xai/grok-imagine-video/v1.5/reference-to-video')).toBe('xai')
    expect(tagStyleFor(route, 'bytedance/seedance-2.0/reference-to-video')).toBe('palmier')
  })

  it('parses persisted statuses and flags Mac-only jobs', () => {
    expect(parseStatus('failed: Boom')).toEqual({ kind: 'failed', message: 'Boom' })
    expect(parseStatus('generating')).toEqual({ kind: 'generating' })
    expect(parseStatus(undefined)).toEqual({ kind: 'none' })
    const mac = { id: 'a', name: 'a', type: 'video' as const, source: { project: { relativePath: 'media/gen-A.mp4' } }, duration: 5, generationStatus: 'generating', generationInput: { prompt: '', model: 'x', duration: 5, aspectRatio: '', backendJobId: 'jd7abc' } }
    expect(displayStatus(mac)).toEqual({ kind: 'failed', message: FOREIGN_JOB_MESSAGE })
  })
})
