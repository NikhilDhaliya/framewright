import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundledEntries, type ByokRoute } from '../../src/core/generation/catalog'
import type { GenerationParams } from '../../src/core/generation/params'
import { FalAdapter, falErrorMessage } from '../../src/main/generation/providers/fal'
import { falOutputUrls, falRequest, klingTier } from '../../src/main/generation/providers/falModels'
import { startFakeFal, type FakeFal } from './fakeFal'

const entry = (id: string) => bundledEntries().find((e) => e.id === id)!
const falRoute = (id: string): ByokRoute => entry(id).byok!.routes.find((r) => r.provider === 'fal')!
const req = (id: string, p: GenerationParams) => falRequest(entry(id), falRoute(id), p)
const video = (p: Partial<Extract<GenerationParams, { kind: 'video' }>>) => ({ kind: 'video' as const, prompt: 'a fox', duration: 5, aspectRatio: '16:9', resolution: '1080p', generateAudio: true, ...p })

describe('fal request building per model', () => {
  it('Veo 3.1 Fast: string durations, mode endpoints, 8 s reference runs', () => {
    expect(req('veo3.1-fast', video({ duration: 6 }))).toEqual({
      endpoint: 'fal-ai/veo3.1/fast',
      body: { prompt: 'a fox', aspect_ratio: '16:9', duration: '6s', resolution: '1080p', generate_audio: true },
    })
    expect(req('veo3.1-fast', video({ startFrameURL: 'u1', endFrameURL: 'u2' }))).toMatchObject({ endpoint: 'fal-ai/veo3.1/fast/first-last-frame-to-video', body: { first_frame_url: 'u1', last_frame_url: 'u2' } })
    expect(req('veo3.1-fast', video({ referenceImageURLs: ['r1'] }))).toMatchObject({ endpoint: 'fal-ai/veo3.1/fast/reference-to-video', body: { duration: '8s', image_urls: ['r1'] } })
  })

  it('Seedance: reference-to-video carries all pools and keeps @tags; 2.5 drafts ask for draft:true', () => {
    const r = req('seedance-2.0', video({ prompt: '@Image1 meets @Video1', referenceImageURLs: ['i'], referenceVideoURLs: ['v'], referenceAudioURLs: ['a'], resolution: '720p' }))
    expect(r).toEqual({
      endpoint: 'bytedance/seedance-2.0/reference-to-video',
      body: { prompt: '@Image1 meets @Video1', duration: '5', aspect_ratio: '16:9', resolution: '720p', generate_audio: true, image_urls: ['i'], video_urls: ['v'], audio_urls: ['a'] },
    })
    expect(req('seedance-2.5', video({ draft: true, resolution: '720p' })).body.draft).toBe(true)
    expect(req('seedance-2.0', video({ startFrameURL: 's', endFrameURL: 'e' }))).toMatchObject({ endpoint: 'bytedance/seedance-2.0/image-to-video', body: { image_url: 's', end_image_url: 'e' } })
  })

  it('MiniMax H3: integer durations and reference_* pools', () => {
    expect(req('minimax-h3', video({ resolution: '768P', referenceVideoURLs: ['v'] }))).toEqual({
      endpoint: 'minimax/h3/reference-to-video',
      body: { prompt: 'a fox', duration: 5, resolution: '768P', aspect_ratio: '16:9', reference_video_urls: ['v'] },
    })
  })

  it('Grok on fal rewrites tags to <IMAGE_n>', () => {
    expect(req('grok-imagine-video', video({ prompt: 'make @Image2 dance', referenceImageURLs: ['a', 'b'], resolution: '720p' }))).toMatchObject({
      endpoint: 'xai/grok-imagine-video/v1.5/reference-to-video',
      body: { prompt: 'make <IMAGE_1> dance', image_urls: ['a', 'b'] },
    })
  })

  it('FLUX.3: draft suffix without resolution, extend, enhance from the draft cache', () => {
    expect(req('flux-3', video({ draft: true, resolution: '720p', startFrameURL: 's' }))).toEqual({
      endpoint: 'blackforestlabs/flux-3/image-to-video/draft',
      body: { prompt: 'a fox', duration: 5, aspect_ratio: '16:9', generate_audio: true, image_url: 's' },
    })
    expect(req('flux-3', video({ sourceVideoURL: 'src', duration: 8 }))).toMatchObject({ endpoint: 'blackforestlabs/flux-3/extend-video', body: { video_url: 'src', duration: 8 } })
    expect(req('flux-3', { kind: 'enhance', resultURLs: ['v', 'cache.bin'] })).toEqual({ endpoint: 'blackforestlabs/flux-3/draft-enhance', body: { draft_cache_url: 'cache.bin' } })
    expect(req('seedance-2.5', { kind: 'enhance', resultURLs: ['v', 'seedance-draft:d1'] })).toEqual({ endpoint: 'bytedance/seedance-2.5/draft/complete', body: { draft_id: 'd1' } })
  })

  it('Kling: tier from resolution, V3 elements, O3 image_urls, edit and motion control', () => {
    expect(klingTier('720p')).toBe('standard')
    expect(klingTier('4k')).toBe('4k')
    expect(req('kling-v3', video({ resolution: '720p', referenceImageURLs: ['e1'] }))).toEqual({
      endpoint: 'fal-ai/kling-video/v3/standard/text-to-video',
      body: { prompt: 'a fox', duration: '5', aspect_ratio: '16:9', generate_audio: true, elements: [{ frontal_image_url: 'e1', reference_image_urls: ['e1'] }] },
    })
    expect(req('kling-o3', video({ referenceImageURLs: ['i'] }))).toMatchObject({ endpoint: 'fal-ai/kling-video/o3/pro/reference-to-video', body: { image_urls: ['i'] } })
    expect(req('kling-o3-edit', video({ sourceVideoURL: 'src', referenceImageURLs: ['i'], duration: 7 }))).toEqual({
      endpoint: 'fal-ai/kling-video/o3/pro/video-to-video/edit',
      body: { prompt: 'a fox', video_url: 'src', image_urls: ['i'], keep_audio: true },
    })
    expect(req('kling-v3-motion-control', video({ sourceVideoURL: 'src', referenceImageURLs: ['face'] })).body).toMatchObject({ video_url: 'src', image_url: 'face', character_orientation: 'video' })
    expect(req('veed-lipsync-v2', video({ prompt: '', sourceVideoURL: 'v', referenceAudioURLs: ['a'] }))).toEqual({ endpoint: 'veed/lipsync/v2', body: { video_url: 'v', audio_url: 'a' } })
  })

  it('images: GPT Image sizes, Nano Banana edit, Seedream enums', () => {
    const img = { kind: 'image' as const, prompt: 'p', aspectRatio: '', numImages: 2 }
    expect(req('gpt-image-2', { ...img, resolution: '1024x1536', quality: 'high' })).toEqual({
      endpoint: 'openai/gpt-image-2',
      body: { prompt: 'p', image_size: { width: 1024, height: 1536 }, quality: 'high', num_images: 2, output_format: 'png' },
    })
    expect(req('nano-banana-pro', { ...img, aspectRatio: '16:9', resolution: '2K', imageURLs: ['r'] })).toEqual({
      endpoint: 'fal-ai/nano-banana-pro/edit',
      body: { prompt: 'p', aspect_ratio: '16:9', resolution: '2K', num_images: 2, output_format: 'png', image_urls: ['r'] },
    })
    expect(req('seedream-v5-pro', { ...img, aspectRatio: 'landscape_16_9' }).body).toEqual({ prompt: 'p', image_size: 'landscape_16_9', num_images: 2 })
  })

  it('audio: per-category endpoints and fields', () => {
    const a = { kind: 'audio' as const, prompt: 'calm piano', instrumental: true }
    expect(req('elevenlabs-music', { ...a, durationSeconds: 30 })).toEqual({ endpoint: 'elevenlabs/music/v2.5', body: { prompt: 'calm piano', music_length_ms: 30000, force_instrumental: true } })
    expect(req('sonilo-v1.1-video-to-music', { ...a, videoURL: 'v', durationSeconds: 12 })).toEqual({
      endpoint: 'sonilo/v1.1/video-to-music',
      body: { video_url: 'v', prompt: 'calm piano', duration: 12, num_samples: 1 },
    })
    expect(req('sonilo-v1.1-video-to-music', { ...a, durationSeconds: 90 }).endpoint).toBe('sonilo/v1.1/text-to-music')
    expect(req('mirelo-sfx-v1.5-video-to-audio', { ...a, prompt: '', videoURL: 'v', durationSeconds: 14 }).body).toEqual({ video_url: 'v', duration: 10, num_samples: 2, start_offset: 0 })
    expect(req('elevenlabs-voice-isolator', { ...a, prompt: '', sourceURL: 's' })).toEqual({ endpoint: 'fal-ai/elevenlabs/audio-isolation', body: { audio_url: 's' } })
    expect(req('seed-audio-1.0', { ...a, prompt: 'say hi like @Audio1', referenceAudioURLs: ['r'], multilingual: false }).body).toEqual({ prompt: 'say hi like @Audio1', audio_urls: ['r'], multilingual: false })
  })

  it('upscale: settings → provider fields', () => {
    const settings = { selections: { targetResolution: '4k', targetFPS: 'source', enhancementModel: 'Proteus' }, numbers: { noise: 0.2 }, toggles: {} }
    expect(req('topaz-video-upscaler', { kind: 'upscale', sourceURL: 'v', durationSeconds: 5, sourceWidth: 1920, sourceHeight: 1080, sourceFPS: 30, settings })).toEqual({
      endpoint: 'fal-ai/topaz/upscale/video',
      body: { video_url: 'v', upscale_factor: 2, model: 'Proteus', noise: 0.2, H264_output: true },
    })
    const bd = { selections: { targetResolution: '1080p', targetFPS: 'source', enhancementPreset: 'general' }, numbers: {}, toggles: {} }
    expect(req('bytedance-upscaler', { kind: 'upscale', sourceURL: 'v', durationSeconds: 5, sourceWidth: 1280, sourceHeight: 720, sourceFPS: 23.976, settings: bd }).body).toEqual({
      video_url: 'v',
      target_resolution: '1080p',
      target_fps: 24,
      enhancement_preset: 'general',
    })
    expect(req('seedvr-image-upscaler', { kind: 'upscale', sourceURL: 'i', durationSeconds: 1, settings: { selections: { targetResolution: '4k' }, numbers: {}, toggles: {} } }).body).toEqual({
      image_url: 'i',
      upscale_mode: 'target',
      target_resolution: '2160p',
    })
  })

  it('reads output URLs, draft caches and error bodies', () => {
    expect(falOutputUrls({ video: { url: 'v' }, draft_cache: { url: 'c' } })).toEqual(['v', 'c'])
    expect(falOutputUrls({ video: { url: 'v' }, draft_id: 'd' })).toEqual(['v', 'seedance-draft:d'])
    expect(falOutputUrls({ images: [{ url: 'a' }, { url: 'b' }] })).toEqual(['a', 'b'])
    expect(falOutputUrls({ audio: [{ url: 'x' }, { url: 'y' }] })).toEqual(['x', 'y'])
    expect(falOutputUrls({ audio_url: 'https://x/a.mp3' })).toEqual(['https://x/a.mp3'])
    expect(falErrorMessage(422, JSON.stringify({ detail: [{ loc: ['body'], msg: 'Prompt was flagged', type: 'content_policy_violation' }] }))).toBe('Prompt was flagged')
    expect(falErrorMessage(504, JSON.stringify({ detail: 'Request timed out', error_type: 'request_timeout' }))).toBe('Request timed out')
    expect(falErrorMessage(401, '')).toBe('fal.ai rejected the API key (HTTP 401).')
  })
})

describe('FalAdapter against the fake fal server', () => {
  let fake: FakeFal
  let dir: string
  beforeAll(async () => {
    fake = await startFakeFal({ polls: 2 })
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fal-adapter-'))
  })
  afterAll(async () => {
    await fake.close()
    await fs.rm(dir, { recursive: true, force: true })
  })
  const adapter = (o: Partial<ConstructorParameters<typeof FalAdapter>[0]> = {}) => new FalAdapter({ key: 'test-key', queueBase: `${fake.url}/queue`, restBase: `${fake.url}/rest`, ...o })

  it('submits, polls through IN_QUEUE/IN_PROGRESS and returns the result URLs', async () => {
    const a = adapter()
    const { handle } = await a.submit(entry('minimax-h3'), falRoute('minimax-h3'), video({ resolution: '768P' }))
    expect(handle).toMatchObject({ provider: 'fal', endpoint: 'minimax/h3/text-to-video' })
    expect(handle.statusUrl).toBe(`${fake.url}/queue/minimax/h3/requests/${handle.requestId}/status`)
    expect(fake.submissions.at(-1)!.auth).toBe('Key test-key')
    expect(await a.poll(handle)).toEqual({ state: 'queued' })
    expect(await a.poll(handle)).toEqual({ state: 'running' })
    const done = await a.poll(handle)
    expect(done).toEqual({ state: 'succeeded', outputs: [{ url: `${fake.url}/files/${handle.requestId}-0.mp4` }] })
  })

  it('rejects a bad key on submit with fal’s message', async () => {
    await expect(adapter({ key: 'nope' }).submit(entry('minimax-h3'), falRoute('minimax-h3'), video({}))).rejects.toThrow('Unauthorized')
  })

  it('sends small files inline and larger ones through the CDN (single and multipart)', async () => {
    const small = path.join(dir, 'small.png')
    const big = path.join(dir, 'big.mp4')
    await fs.writeFile(small, Buffer.alloc(100, 1))
    await fs.writeFile(big, Buffer.alloc(5000, 2))
    const a = adapter({ inlineMaxBytes: 1000, multipartThreshold: 3000, partSize: 2048 })
    expect(await a.prepareInput({ path: small, mime: 'image/png', size: 100 })).toMatch(/^data:image\/png;base64,/)
    const url = await a.prepareInput({ path: big, mime: 'video/mp4', size: 5000 })
    expect(url).toMatch(new RegExp(`^${fake.url}/cdn/.+/big\\.mp4$`))
    expect(fake.uploads.at(-1)).toEqual({ name: 'big.mp4', contentType: 'video/mp4', bytes: 5000, multipart: true })
    const single = await adapter({ inlineMaxBytes: 10 }).prepareInput({ path: small, mime: 'image/png', size: 100 })
    expect(single).toMatch(/\/small\.png$/)
    expect(fake.uploads.at(-1)).toEqual({ name: 'small.png', contentType: 'image/png', bytes: 100, multipart: false })
  })

  it('cancels with the stored cancel URL', async () => {
    const a = adapter()
    const { handle } = await a.submit(entry('flux-3'), falRoute('flux-3'), video({}))
    await a.cancel(handle)
    expect(fake.cancels).toContain(handle.requestId)
    await a.poll(handle)
    expect(await a.poll(handle)).toEqual({ state: 'failed', message: 'Request was cancelled' })
  })
})
