import '../mcp/env'
import { TEST_ROOT } from '../mcp/env'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { MediaManifestEntry } from '../../src/core/model'
import { activeTimeline } from '../../src/core/ops/context'
import { ffmpeg } from '../../src/main/media/ffmpeg'
import { GenerationService, setGenerationService } from '../../src/main/generation/service'
import type { ExportJob } from '../../src/shared/api'
import { call, connect, makePng, startHarness, type Harness } from '../mcp/harness'
import { startFakeFal, type Behavior, type FakeFal } from './fakeFal'

let fake: FakeFal
let behavior: (endpoint: string) => Behavior | undefined = () => undefined
let h: Harness
let client: Client
let svc: GenerationService

beforeAll(async () => {
  fake = await startFakeFal({ polls: 1, behavior: (e) => behavior(e) })
})
afterAll(() => fake.close())

beforeEach(async () => {
  behavior = () => undefined
  h = await startHarness()
  h.ctx.settings().apiKeys.fal = 'test-key'
  svc = new GenerationService(h.ctx, { pollDelay: () => 5, falBases: { queueBase: `${fake.url}/queue`, restBase: `${fake.url}/rest` }, uploadCacheFile: path.join(TEST_ROOT, `up-${randomUUID()}.json`) })
  setGenerationService(h.ctx, svc)
  client = await connect(h.url)
})
afterEach(async () => {
  delete h.ctx.settings().apiKeys.fal
  delete h.ctx.settings().disabledModelIds
  await client.close()
  await h.close()
})

const doc = () => h.session.doc
/** Resolves the (shortened) placeholder id in a tool result to the full entry. */
function placeholderFrom(text: string): MediaManifestEntry {
  const short = /Placeholder asset ID: ([0-9A-F-]+)/.exec(text)?.[1]
  expect(short, text).toBeTruthy()
  const e = doc().manifest.entries.find((x) => x.id.startsWith(short!))
  expect(e, text).toBeTruthy()
  return e!
}
const fresh = (id: string) => doc().manifest.entries.find((e) => e.id === id)!

async function importBytes(data: Buffer, filename: string): Promise<MediaManifestEntry> {
  const id = await h.ctx.media.importBytes(h.session, data, filename, { name: path.basename(filename, path.extname(filename)) })
  return fresh(id)
}

describe('list_models (§3.44 + §B13)', () => {
  it('lists only models runnable with the configured keys, and nothing without keys', async () => {
    const all = (await call(client, 'list_models')).json
    expect(all.loaded).toBe(true)
    const ids = all.models.map((m: { id: string }) => m.id)
    expect(ids[0]).toBe('minimax-h3')
    expect(ids).not.toContain('runway-aleph-2')
    expect(ids).not.toContain('openai-gpt-4o-mini-tts')
    const h3 = all.models[0]
    expect(h3).toEqual({
      type: 'video',
      id: 'minimax-h3',
      displayName: 'MiniMax H3',
      durations: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      resolutions: ['768P', '2K'],
      supportsFirstFrame: true,
      supportsLastFrame: true,
      supportsReferences: true,
      supportsPrompt: true,
      maxReferenceImages: 9,
      maxReferenceVideos: 3,
      maxReferenceAudios: 3,
      maxTotalReferences: 12,
      maxCombinedVideoRefSeconds: 15,
      maxCombinedAudioRefSeconds: 15,
      framesAndReferencesExclusive: true,
      referenceTagNoun: 'Image',
    })
    const flux = all.models.find((m: { id: string }) => m.id === 'flux-3')
    expect(flux).toMatchObject({ supportsDraft: true, draftResolution: '720p', supportsSourceVideo: true, usesOutputDuration: true, maxSourceVideoSeconds: 15 })
    const up = (await call(client, 'list_models', { type: 'upscale' })).json.models[0]
    expect(up.settings[0]).toEqual({ id: 'targetResolution', label: 'Resolution', type: 'select', default: '4k', options: [{ value: '1080p', label: '1080p' }, { value: '4k', label: '4K' }] })
    h.ctx.settings().disabledModelIds = ['minimax-h3']
    expect((await call(client, 'list_models', { type: 'video' })).json.models[0].id).toBe('hailuo-03-max')
    delete h.ctx.settings().apiKeys.fal
    expect((await call(client, 'list_models')).json).toEqual({ models: [], loaded: true })
    expect((await call(client, 'get_timeline')).json.canGenerate).toBe(false)
  })
})

describe('generate_video / generate_image through the MCP server', () => {
  it('turns a placeholder into a finished asset in session.doc', async () => {
    const r = await call(client, 'generate_video', { prompt: 'Waves crashing at golden hour', duration: 6, aspectRatio: '9:16' })
    expect(r.isError).toBe(false)
    expect(r.text).toMatch(/^Generation started\. Placeholder asset ID: [0-9A-F]{8}\. Model: MiniMax H3, duration: 6s, aspect: 9:16$/)
    const p = placeholderFrom(r.text)
    expect(p).toMatchObject({ name: 'Waves crashing at golden hour', type: 'video', duration: 6, generationStatus: 'preparing', generationInput: { prompt: 'Waves crashing at golden hour', model: 'minimax-h3', duration: 6, aspectRatio: '9:16', resolution: '768P' } })
    expect(h.session.snapshot().undoLabel).toBe('Generate Video (Agent)')
    const pending = (await call(client, 'get_media', { pending: true })).json.assets
    expect(pending.map((a: { id: string }) => a.id)).toEqual([p.id.slice(0, 8)])
    await svc.idle(h.session)
    const done = fresh(p.id)
    expect(done.generationStatus).toBeUndefined()
    expect(done).toMatchObject({ source: { project: { relativePath: `media/gen-${p.id.slice(0, 8)}.mp4` } }, duration: 6, sourceWidth: 1280, sourceHeight: 720 })
    expect(fake.submissions.at(-1)).toMatchObject({ endpoint: 'minimax/h3/text-to-video', body: { prompt: 'Waves crashing at golden hour', duration: 6, aspect_ratio: '9:16', resolution: '768P' } })
    expect((await fs.stat(path.join(h.session.path, 'media', `gen-${p.id.slice(0, 8)}.mp4`))).size).toBeGreaterThan(0)
    expect((await call(client, 'get_media', { pending: true })).json.assets).toEqual([])
    const placed = await call(client, 'add_clips', { entries: [{ mediaRef: p.id.slice(0, 8), startFrame: 0 }] })
    expect(placed.isError, placed.text).toBe(false)
    expect(activeTimeline(doc()).tracks[0].clips[0].mediaRef).toBe(p.id)
    expect(h.ui).toContainEqual({ type: 'toast', message: 'Waves crashing at golden hour is ready.' })
  })

  it('sends frames as uploads, uses the reference folder and reports refs', async () => {
    const still = await importBytes(await makePng(64, 64), 'still.png')
    const r = await call(client, 'generate_video', { prompt: 'Animate @Image1', model: 'seedance-2.0', referenceImageMediaRefs: [still.id], resolution: '720p', duration: 4 })
    expect(r.text).toMatch(/Model: Seedance 2, duration: 4s, aspect: 16:9, refs: 1img\/0vid\/0aud$/)
    const p = placeholderFrom(r.text)
    await svc.idle(h.session)
    const sub = fake.submissions.at(-1)!
    expect(sub.endpoint).toBe('bytedance/seedance-2.0/reference-to-video')
    expect(sub.body).toMatchObject({ prompt: 'Animate @Image1', duration: '4', generate_audio: true })
    expect((sub.body.image_urls as string[])[0]).toMatch(/^data:image\/png;base64,/)
    expect(fresh(p.id).generationInput).toMatchObject({ referenceImageAssetIds: [still.id] })
  })

  it('keeps the exact refusal messages', async () => {
    const text = async (args: Record<string, unknown>, tool = 'generate_video') => (await call(client, tool, args)).text
    expect(await text({ prompt: 'x', duration: 3 })).toBe("MiniMax H3 does not support duration '3s'. Valid: 5s, 6s, 7s, 8s, 9s, 10s, 11s, 12s, 13s, 14s, 15s.")
    expect(await text({ prompt: 'x', model: 'sora' })).toMatch(/^Unknown model 'sora'\. Available: minimax-h3, hailuo-03-max, seedance-2\.0, /)
    expect(await text({ prompt: 'x', model: 'runway-aleph-2' })).toBe("Model 'runway-aleph-2' needs a Runway API key. Tell the user to add one in Settings ▸ Models & API Keys.")
    expect(await text({ prompt: '' })).toBe('Empty prompt')
    expect(await text({ prompt: 'x', draft: true })).toBe("Model 'minimax-h3' does not support draft generation.")
    expect(await text({ prompt: 'x', sourceVideoMediaRef: 'ABC' })).toBe("Model 'minimax-h3' does not accept a source video.")
    expect(await text({ prompt: 'x', startFrameMediaRef: 'NOPE' })).toBe('Start frame not found: NOPE')
    expect(await text({ model: 'kling-o3-edit', prompt: 'x' })).toBe("Model 'kling-o3-edit' requires 'sourceVideoMediaRef' pointing to a video asset.")
    expect(await text({ enhanceDraftMediaRef: 'NOPE' })).toBe('Draft not found: NOPE')
    expect(await text({ prompt: 'x', model: 'dall-e' }, 'generate_image')).toMatch(/^Unknown model 'dall-e'\. Available: gpt-image-2, /)
    expect(await text({ prompt: 'x', model: 'nano-banana-pro', resolution: '8K' }, 'generate_image')).toBe("Nano Banana Pro does not support resolution '8K'. Valid: 1K, 2K, 4K.")
    expect(await text({ prompt: 5 }, 'generate_image')).toBe('Missing required argument: prompt')
    delete h.ctx.settings().apiKeys.fal
    expect(await text({ prompt: 'x' })).toBe('Generation requires an API key. Tell the user to add one in Settings ▸ Models & API Keys.')
    expect(fake.submissions.filter((s) => s.body.prompt === 'x')).toEqual([])
  })

  it('generate_image puts the placeholder in the requested folder and fails visibly on provider errors', async () => {
    behavior = () => ({ error: 'NSFW content detected' })
    const r = await call(client, 'generate_image', { prompt: 'A neon city', model: 'nano-banana-pro', folder: 'AI/Stills' })
    expect(r.text).toMatch(/Model: Nano Banana Pro, aspect: 16:9$/)
    const p = placeholderFrom(r.text)
    const folder = doc().manifest.folders.find((f) => f.id === p.folderId)
    expect(folder?.name).toBe('Stills')
    await svc.idle(h.session)
    expect(fresh(p.id).generationStatus).toBe('failed: NSFW content detected')
    const media = (await call(client, 'get_media', { ids: [p.id.slice(0, 8)] })).json.assets[0]
    expect(media.generationStatus).toBe('failed: NSFW content detected')
  })

  it('enhances a completed FLUX.3 draft from its cached result', async () => {
    behavior = (e) => (e.endsWith('/draft') ? { extra: { draft_cache: { url: `${fake.url}/files/cache.bin` } } } : undefined)
    const draft = placeholderFrom((await call(client, 'generate_video', { prompt: 'Fireworks', model: 'flux-3', draft: true })).text)
    await svc.idle(h.session)
    expect(fake.submissions.at(-1)!.endpoint).toBe('blackforestlabs/flux-3/text-to-video/draft')
    expect(fresh(draft.id).generationInput!.resultURLs).toHaveLength(2)
    const r = await call(client, 'generate_video', { enhanceDraftMediaRef: draft.id })
    const p = placeholderFrom(r.text)
    expect(r.text).toBe(`Draft enhancement started. Placeholder asset ID: ${p.id.slice(0, 8)}`)
    expect(p.name).toBe('Fireworks 1080p')
    await svc.idle(h.session)
    expect(fake.submissions.at(-1)).toMatchObject({ endpoint: 'blackforestlabs/flux-3/draft-enhance', body: { draft_cache_url: `${fake.url}/files/cache.bin` } })
    expect(fresh(p.id).generationStatus).toBeUndefined()
    expect(fresh(p.id).generationInput).toMatchObject({ draft: false, resolution: '1080p' })
  })
})

describe('generate_audio / upscale_media through the MCP server', () => {
  it('generates speech and transforms source media', async () => {
    const r = await call(client, 'generate_audio', { prompt: 'Welcome to the show' })
    expect(r.text).toMatch(/Model: Seed Audio 1\.0, General\. Place it with add_clips\.$/)
    const tts = placeholderFrom(r.text)
    expect(tts).toMatchObject({ type: 'audio', duration: 10, generationInput: { audioInput: 'text', multilingual: false } })
    const mp3 = await ffmpeg(['-f', 'lavfi', '-i', 'sine=d=2', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'])
    const voice = await importBytes(mp3, 'voice.mp3')
    const iso = await call(client, 'generate_audio', { model: 'elevenlabs-voice-isolator', sourceMediaRef: voice.id })
    expect(iso.text).toMatch(/Model: ElevenLabs Voice Isolator, Voice Cleanup \(from source media\)\. Place it with add_clips\.$/)
    const cleaned = placeholderFrom(iso.text)
    expect(cleaned.generationInput).toMatchObject({ referenceAudioAssetIds: [voice.id], audioInput: 'audio' })
    await svc.idle(h.session)
    expect(fresh(tts.id).generationStatus).toBeUndefined()
    expect(fresh(cleaned.id).generationStatus).toBeUndefined()
    expect(fake.submissions.at(-1)).toMatchObject({ endpoint: 'fal-ai/elevenlabs/audio-isolation' })
    expect((await call(client, 'generate_audio', { model: 'elevenlabs-dubbing', sourceMediaRef: voice.id })).text).toBe('Choose a target language.')
    expect((await call(client, 'generate_audio', { model: 'mirelo-sfx-v1.5-video-to-audio' })).text).toBe("Model 'mirelo-sfx-v1.5-video-to-audio' needs source media. Provide sourceMediaRef.")
  })

  it('scores a timeline span and places a generating clip that snaps to the result length', async () => {
    const clipFile = path.join(TEST_ROOT, `span-src-${randomUUID()}.mp4`)
    await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipFile])
    const exportsSeen: string[] = []
    let copying: Promise<void> = Promise.resolve()
    h.ctx.exporter = {
      ...h.ctx.exporter,
      start: (_s, options) => {
        exportsSeen.push(JSON.stringify(options.range))
        copying = fs.copyFile(clipFile, options.outputPath)
        return { id: 'span', options, status: 'running', progress: 0, framesRendered: 0, totalFrames: 0, startedAt: new Date().toISOString(), outputPath: options.outputPath }
      },
      wait: async (id) => {
        await copying
        return { id, options: {} as ExportJob['options'], status: 'completed', progress: 1, framesRendered: 0, totalFrames: 0, startedAt: '', outputPath: '' }
      },
    }
    const r = await call(client, 'generate_audio', { model: 'sonilo-v1.1-video-to-music', prompt: 'warm strings', videoSourceStartFrame: 30, videoSourceEndFrame: 90 })
    expect(r.text).toMatch(/^Generation started and placed on the timeline at frame 30\. Placeholder asset ID: [0-9A-F]{8}\. Model: Sonilo Music, Music \(scored from video\)\.$/)
    expect(exportsSeen).toEqual(['{"start":30,"end":90}'])
    const p = placeholderFrom(r.text)
    expect(h.session.snapshot().undoLabel).toBe('Add Music (Agent)')
    const track = activeTimeline(doc()).tracks.find((t) => t.type === 'audio')!
    expect(track.clips[0]).toMatchObject({ mediaRef: p.id, startFrame: 30, durationFrames: 60 })
    await svc.idle(h.session)
    expect(fake.submissions.at(-1)).toMatchObject({ endpoint: 'sonilo/v1.1/video-to-music', body: { prompt: 'warm strings', duration: 2, num_samples: 1 } })
    // The harness probe reports 4 s for audio → the clip is retimed to 120 frames, not an undo step.
    expect(activeTimeline(doc()).tracks.find((t) => t.type === 'audio')!.clips[0]).toMatchObject({ durationFrames: 120, trimStartFrame: 0, trimEndFrame: 0 })
    expect(h.session.snapshot().undoLabel).toBe('Add Music (Agent)')
  })

  it('upscales an image with validated settings', async () => {
    const still = await importBytes(await makePng(640, 360), 'still.png')
    const missing = await call(client, 'upscale_media', { mediaRef: still.id, settings: { sharpen: 1 } })
    expect(missing.text).toBe("Unknown upscale setting 'sharpen'. Available: targetResolution, enhancementModel")
    expect((await call(client, 'upscale_media', { mediaRef: still.id, settings: { targetResolution: '8k' } })).text).toBe('Unsupported targetResolution. Available: 1080p')
    const r = await call(client, 'upscale_media', { mediaRef: still.id, settings: { targetResolution: '1080p' } })
    expect(r.text).toMatch(/^Upscale started\. Placeholder asset ID: [0-9A-F]{8}\. Model: Topaz Upscale \(Image\), source: still$/)
    const p = placeholderFrom(r.text)
    expect(p).toMatchObject({ name: 'Upscaled still', type: 'image', generationInput: { model: 'topaz-image-upscaler', imageURLAssetIds: [still.id], upscaleSettings: { selections: { targetResolution: '1080p', enhancementModel: 'Standard V2' } } } })
    await svc.idle(h.session)
    expect(fake.submissions.at(-1)).toMatchObject({ endpoint: 'fal-ai/topaz/upscale/image', body: { upscale_factor: 3, model: 'Standard V2' } })
    expect(fresh(p.id).generationStatus).toBeUndefined()
  })
})
