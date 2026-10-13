/** Google (Gemini Interactions) and ElevenLabs adapters against local fake servers; never the real APIs. */
import '../mcp/env'
import { TEST_ROOT } from '../mcp/env'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { activeRoute, bundledEntries, hasKeyFrom, type ByokRoute, type CatalogEntry } from '../../src/core/generation/catalog'
import { modelSet, setRuntimeVoices } from '../../src/core/generation/models'
import type { AudioGenerationParams, ImageGenerationParams } from '../../src/core/generation/params'
import { emptyManifest, newProjectFile, type MediaManifestEntry } from '../../src/core/model'
import { addMediaEntries } from '../../src/core/ops/project'
import { ffmpeg } from '../../src/main/media/ffmpeg'
import { probeFile } from '../../src/main/media/probe'
import { ElevenLabsAdapter, findVoice } from '../../src/main/generation/providers/elevenlabs'
import { GoogleAdapter, wavFromPcm } from '../../src/main/generation/providers/google'
import { createAdapter } from '../../src/main/generation/providers/index'
import { isInlineRef } from '../../src/main/generation/providers/inline'
import { ProviderError, type Output } from '../../src/main/generation/providers/types'
import { CANCELLED_MESSAGE, GenerationService } from '../../src/main/generation/service'
import { submitAudio, submitImage } from '../../src/main/generation/submissions'
import { installPackageMedia, sourceForPath } from '../../src/main/project/packageIO'
import { ProjectSession } from '../../src/main/project/session'
import type { AppContext } from '../../src/main/services'
import type { AppSettings } from '../../src/shared/api'
import { startFakeProviders, type FakeProviders } from './fakeProviders'

let fake: FakeProviders
beforeAll(async () => {
  fake = await startFakeProviders({ polls: 2 })
})
afterAll(() => fake.close())

const entry = (id: string): CatalogEntry => bundledEntries().find((e) => e.id === id)!
const route = (id: string, provider: string): ByokRoute => entry(id).byok!.routes.find((r) => r.provider === provider)!
const google = () => new GoogleAdapter({ key: 'google-key', base: fake.googleBase })
const eleven = (key = 'eleven-key') => new ElevenLabsAdapter({ key, base: fake.elevenBase })
const last = (provider: 'google' | 'elevenlabs') => fake.requests.filter((r) => r.provider === provider).at(-1)!
const image = (p: Partial<ImageGenerationParams> = {}): ImageGenerationParams => ({ kind: 'image', prompt: 'a red fox', aspectRatio: '16:9', resolution: '2K', numImages: 1, ...p })
const audio = (p: Partial<AudioGenerationParams> = {}): AudioGenerationParams => ({ kind: 'audio', prompt: 'hello there', instrumental: false, ...p })
const bytesOf = (o: Output) => {
  if (!('bytes' in o)) throw new Error('expected bytes')
  return o
}

async function tempFile(ext: string, args: string[]): Promise<{ path: string; size: number }> {
  const p = path.join(TEST_ROOT, `in-${randomUUID().slice(0, 8)}.${ext}`)
  await ffmpeg(['-y', ...args, p])
  return { path: p, size: (await fs.stat(p)).size }
}

describe('routing', () => {
  it('runs Google / ElevenLabs entries on their own keys first (catalog order) and falls back to fal', () => {
    const g = hasKeyFrom({ google: 'k' })
    expect(activeRoute(entry('nano-banana-pro'), g)!.provider).toBe('google')
    expect(activeRoute(entry('nano-banana-pro'), hasKeyFrom({ fal: 'k' }))!.provider).toBe('fal')
    expect(activeRoute(entry('nano-banana-pro'), hasKeyFrom({ fal: 'k', google: 'k' }))!.provider).toBe('google')
    expect(activeRoute(entry('elevenlabs-music'), hasKeyFrom({ elevenlabs: 'k' }))!.provider).toBe('elevenlabs')
    expect(activeRoute(entry('lyria-3-pro'), g)!.endpoints.music).toBe('lyria-3.5')
    // Veo stays on fal (the Gemini API Veo 3.1 previews shut down 2026-10-22).
    expect(activeRoute(entry('veo3.1-fast'), g)).toBeNull()
    const set = modelSet(hasKeyFrom({ google: 'k', elevenlabs: 'k' }))
    expect(set.available('image').map((m) => m.id)).toEqual(['nano-banana-pro', 'nano-banana-2', 'nano-banana-lite'])
    expect(set.available('audio').map((m) => m.id).sort()).toEqual(['elevenlabs-dubbing', 'elevenlabs-music', 'elevenlabs-sfx', 'elevenlabs-v4-tts', 'elevenlabs-voice-isolator', 'gemini-tts', 'lyria-3-pro'])
    expect(set.available('video')).toEqual([])
    expect(modelSet(hasKeyFrom({})).findImage('nano-banana-lite')!.keyProviderName).toBe('Google')
  })

  it('builds adapters from keys and env base URLs', () => {
    expect(createAdapter('google', {})).toBeNull()
    expect(createAdapter('google', { google: 'k' })).toBeInstanceOf(GoogleAdapter)
    expect(createAdapter('elevenlabs', { elevenlabs: 'k' }, { env: { PALMIER_ELEVENLABS_BASE_URL: fake.elevenBase } })).toBeInstanceOf(ElevenLabsAdapter)
    expect(createAdapter('replicate', { replicate: 'k' })).toBeNull()
  })

  it('treats ElevenLabs voices as runtime voices (no placeholder in the list)', () => {
    const m = modelSet(hasKeyFrom({ elevenlabs: 'k' })).findAudio('elevenlabs-v4-tts')!
    expect(m.runtimeVoices).toBe(true)
    expect(m.acceptsVoice).toBe(true)
    setRuntimeVoices(m.id, [])
    expect(m.voices).toBeNull()
    setRuntimeVoices(m.id, ['Rachel'])
    expect(m.voices).toEqual(['Rachel'])
    setRuntimeVoices(m.id, [])
    expect(modelSet(hasKeyFrom({ google: 'k' })).findAudio('gemini-tts')!.voices).toContain('Kore')
  })
})

describe('Google adapter (Interactions API)', () => {
  it('generates images: one call per image, aspect/size in response_format, inline PNG bytes', async () => {
    const a = google()
    const before = fake.requests.length
    const r = await a.submit(entry('nano-banana-pro'), route('nano-banana-pro', 'google'), image({ numImages: 2 }))
    expect('outputs' in r && r.outputs).toHaveLength(2)
    const outs = (r as { outputs: Output[] }).outputs.map(bytesOf)
    expect(outs[0].mime).toBe('image/png')
    expect(outs[0].bytes.subarray(1, 4).toString()).toBe('PNG')
    const calls = fake.requests.slice(before)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/interactions',
      auth: 'google-key',
      body: { model: 'gemini-3-pro-image', input: [{ type: 'text', text: 'a red fox' }], response_format: { type: 'image', mime_type: 'image/png', aspect_ratio: '16:9', image_size: '2K' } },
    })
  })

  it('sends references inline as base64 image content', async () => {
    const a = google()
    const png = await tempFile('png', ['-f', 'lavfi', '-i', 'testsrc2=s=64x64', '-frames:v', '1'])
    const ref = await a.prepareInput({ path: png.path, mime: 'image/png', size: png.size })
    expect(isInlineRef(ref)).toBe(true)
    await a.submit(entry('nano-banana-2'), route('nano-banana-2', 'google'), image({ imageURLs: [ref], resolution: '1K', aspectRatio: '1:4' }))
    const body = last('google').body as { model: string; input: { type: string; mime_type?: string; data?: string }[] }
    expect(body.model).toBe('gemini-3.1-flash-image')
    expect(body.input[1]).toMatchObject({ type: 'image', mime_type: 'image/png' })
    expect(Buffer.from(body.input[1].data!, 'base64').length).toBe(png.size)
  })

  it('speaks with Gemini TTS (voice + style annotation) and wraps raw PCM in a WAV header', async () => {
    const a = google()
    const r = (await a.submit(entry('gemini-tts'), route('gemini-tts', 'google'), audio({ voice: 'Puck', styleInstructions: 'cheerful' }))) as { outputs: Output[] }
    expect(last('google').body).toEqual({
      model: 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hello there', annotations: [{ type: 'speech_metadata', style: 'cheerful' }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Puck' }] },
    })
    expect(bytesOf(r.outputs[0]).mime).toBe('audio/wav')
    const pcm = (await a.submit(entry('gemini-tts'), route('gemini-tts', 'google'), audio({ prompt: 'raw [pcm]', voice: 'Kore' }))) as { outputs: Output[] }
    const out = bytesOf(pcm.outputs[0])
    expect(out.mime).toBe('audio/wav')
    expect(out.bytes.subarray(0, 4).toString()).toBe('RIFF')
    expect(out.bytes.readUInt32LE(24)).toBe(24000)
    expect(wavFromPcm(Buffer.alloc(10)).length).toBe(54)
  })

  it('makes music with Lyria (mp3, lyric text ignored)', async () => {
    const r = (await google().submit(entry('lyria-3-pro'), route('lyria-3-pro', 'google'), audio({ prompt: 'warm piano' }))) as { outputs: Output[] }
    expect(last('google').body).toEqual({ model: 'lyria-3.5', input: 'warm piano' })
    expect(bytesOf(r.outputs[0]).mime).toBe('audio/mpeg')
  })

  it('maps errors: API error message, bad key, text-only refusal', async () => {
    await expect(google().submit(entry('nano-banana-pro'), route('nano-banana-pro', 'google'), image({ prompt: 'x [fail]' }))).rejects.toThrow('The request was blocked by safety filters (fake).')
    await expect(new GoogleAdapter({ key: 'nope', base: fake.googleBase }).submit(entry('nano-banana-pro'), route('nano-banana-pro', 'google'), image())).rejects.toThrow('API key not valid')
    await expect(google().submit(entry('nano-banana-pro'), route('nano-banana-pro', 'google'), image({ prompt: 'x [refuse]' }))).rejects.toThrow('Google returned no image: I can’t create that image (fake refusal).')
  })

  it('turns a background interaction into a resumable handle: poll → succeeded, cancel', async () => {
    const a = google()
    const r = await a.submit(entry('nano-banana-pro'), route('nano-banana-pro', 'google'), image({ prompt: 'slow [bg]' }))
    expect('handle' in r).toBe(true)
    const handle = (r as { handle: import('../../src/core/generation/params').ByokJobHandle }).handle
    expect(handle).toMatchObject({ provider: 'google', endpoint: 'gemini-3-pro-image' })
    expect(await a.poll(handle)).toEqual({ state: 'queued' })
    expect(await a.poll(handle)).toEqual({ state: 'running' })
    const done = await a.poll(handle)
    expect(done.state).toBe('succeeded')
    expect(await a.poll({ ...handle, requestId: 'missing' })).toEqual({ state: 'failed', message: 'Interaction not found.' })
    const r2 = (await a.submit(entry('nano-banana-pro'), route('nano-banana-pro', 'google'), image({ prompt: 'slow [bg]' }))) as { handle: typeof handle }
    await a.cancel(r2.handle)
    expect(fake.cancels).toContain(r2.handle.requestId)
    expect(await a.poll(r2.handle)).toEqual({ state: 'failed', message: 'Generation cancelled' })
  })

  it('aborts a synchronous request when cancelled', async () => {
    const ctl = new AbortController()
    const p = google().submit(entry('nano-banana-pro'), route('nano-banana-pro', 'google'), image({ prompt: 'x [hold]' }), ctl.signal)
    await waitFor(() => fake.requests.some((r) => r.provider === 'google' && JSON.stringify(r.body).includes('x [hold]')))
    ctl.abort()
    await expect(p).rejects.toThrow()
    await waitFor(() => fake.aborted.includes('google:gemini-3-pro-image'))
  })
})

describe('ElevenLabs adapter', () => {
  it('resolves voices by name, "name - description", id, or the first premade one', async () => {
    const voices = await eleven().listVoices()
    expect(voices.map((v) => v.name)).toEqual(['Rachel', 'Adam - deep narrator', 'My Clone'])
    expect(findVoice(voices, 'adam')!.voice_id).toBe('v-adam')
    expect(findVoice(voices, 'v-mine')!.name).toBe('My Clone')
    expect(findVoice(voices, undefined)!.voice_id).toBe('v-rachel')
    expect(findVoice(voices, 'Nobody')).toBeNull()
  })

  it('speaks with v4 TTS through /v1/text-to-speech/{voice_id}', async () => {
    const r = (await eleven().submit(entry('elevenlabs-v4-tts'), route('elevenlabs-v4-tts', 'elevenlabs'), audio({ voice: 'Adam' }))) as { outputs: Output[] }
    expect(last('elevenlabs')).toMatchObject({ method: 'POST', path: '/v1/text-to-speech/v-adam?output_format=mp3_44100_128', body: { text: 'hello there', model_id: 'eleven_v4' }, auth: 'eleven-key' })
    expect(bytesOf(r.outputs[0]).mime).toBe('audio/mpeg')
    await expect(eleven().submit(entry('elevenlabs-v4-tts'), route('elevenlabs-v4-tts', 'elevenlabs'), audio({ voice: 'Nobody' }))).rejects.toThrow("Voice 'Nobody' isn't in your ElevenLabs voice library.")
  })

  it('composes music (stream endpoint) and sound effects with the catalog model ids', async () => {
    await eleven().submit(entry('elevenlabs-music'), route('elevenlabs-music', 'elevenlabs'), audio({ prompt: 'lofi', durationSeconds: 30, instrumental: true }))
    expect(last('elevenlabs')).toMatchObject({ path: '/v1/music/stream?output_format=mp3_44100_128', body: { prompt: 'lofi', model_id: 'music_v2_5', music_length_ms: 30000, force_instrumental: true } })
    await eleven().submit(entry('elevenlabs-sfx'), route('elevenlabs-sfx', 'elevenlabs'), audio({ prompt: 'door slam', durationSeconds: 0.2 }))
    expect(last('elevenlabs')).toMatchObject({ path: '/v1/sound-generation?output_format=mp3_44100_128', body: { text: 'door slam', duration_seconds: 0.5, prompt_influence: 0.3, model_id: 'eleven_text_to_sound_v2' } })
  })

  it('isolates voice from a multipart upload', async () => {
    const a = eleven()
    const mp3 = await tempFile('mp3', ['-f', 'lavfi', '-i', 'sine=f=300:d=1', '-c:a', 'libmp3lame'])
    const ref = await a.prepareInput({ path: mp3.path, mime: 'audio/mpeg', size: mp3.size })
    const r = (await a.submit(entry('elevenlabs-voice-isolator'), route('elevenlabs-voice-isolator', 'elevenlabs'), audio({ prompt: '', sourceURL: ref }))) as { outputs: Output[] }
    const req = last('elevenlabs')
    expect(req.path).toBe('/v1/audio-isolation')
    expect(req.contentType).toMatch(/^multipart\/form-data/)
    expect(req.body.__files).toMatchObject({ audio: { type: 'audio/mpeg', bytes: mp3.size } })
    expect(bytesOf(r.outputs[0]).bytes.length).toBeGreaterThan(0)
  })

  it('dubs: submit → dubbing_id handle → poll → download the target language; failures and cancel', async () => {
    const a = eleven()
    const mp3 = await tempFile('mp3', ['-f', 'lavfi', '-i', 'sine=f=300:d=1', '-c:a', 'libmp3lame'])
    const ref = await a.prepareInput({ path: mp3.path, mime: 'audio/mpeg', size: mp3.size })
    const r = (await a.submit(entry('elevenlabs-dubbing'), route('elevenlabs-dubbing', 'elevenlabs'), audio({ prompt: '', sourceURL: ref, targetLanguage: 'fr' }))) as { handle: import('../../src/core/generation/params').ByokJobHandle }
    expect(last('elevenlabs').body).toMatchObject({ source_lang: 'auto', target_lang: 'fr', __files: { file: { bytes: mp3.size } } })
    expect(r.handle).toMatchObject({ provider: 'elevenlabs', endpoint: 'dubbing/fr' })
    expect(await a.poll(r.handle)).toEqual({ state: 'running' })
    expect(await a.poll(r.handle)).toEqual({ state: 'running' })
    const done = await a.poll(r.handle)
    expect(done.state).toBe('succeeded')
    expect(last('elevenlabs').path).toBe(`/v1/dubbing/${r.handle.requestId}/audio/fr`)
    const bad = (await a.submit(entry('elevenlabs-dubbing'), route('elevenlabs-dubbing', 'elevenlabs'), audio({ prompt: '', sourceURL: ref, targetLanguage: 'xx' }))) as typeof r
    expect(await a.poll(bad.handle)).toEqual({ state: 'failed', message: 'Unsupported target language (fake).' })
    const c = (await a.submit(entry('elevenlabs-dubbing'), route('elevenlabs-dubbing', 'elevenlabs'), audio({ prompt: '', sourceURL: ref, targetLanguage: 'de' }))) as typeof r
    await a.cancel(c.handle)
    expect(fake.cancels).toContain(c.handle.requestId)
    expect(await a.poll(c.handle)).toEqual({ state: 'failed', message: 'Dubbing not found.' })
    await expect(a.submit(entry('elevenlabs-dubbing'), route('elevenlabs-dubbing', 'elevenlabs'), audio({ prompt: '', sourceURL: ref }))).rejects.toThrow('Choose a target language.')
  })

  it('maps errors: detail.message, bad key', async () => {
    await expect(eleven().submit(entry('elevenlabs-sfx'), route('elevenlabs-sfx', 'elevenlabs'), audio({ prompt: 'boom [fail]' }))).rejects.toThrow('This prompt was blocked (fake).')
    const err = await eleven('bad').submit(entry('elevenlabs-sfx'), route('elevenlabs-sfx', 'elevenlabs'), audio({ prompt: 'boom' })).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).message).toBe('Invalid API key')
    expect((err as ProviderError).status).toBe(401)
  })
})

// ---------- Through the generation service ----------

const settings = { apiKeys: { google: 'google-key', elevenlabs: 'eleven-key' } } as AppSettings
let session: ProjectSession
const toasts: string[] = []

function makeApp(): AppContext {
  return {
    sessions: { focused: () => session, all: () => [session], openPath: async () => session, create: async () => session },
    media: { probe: probeFile } as unknown as AppContext['media'],
    render: {} as AppContext['render'],
    exporter: {} as AppContext['exporter'],
    settings: () => settings,
    ui: (_s, cmd) => {
      if (cmd.type === 'toast') toasts.push(cmd.message)
    },
  }
}
const makeService = (app: AppContext) =>
  new GenerationService(app, {
    pollDelay: () => 5,
    uploadCacheFile: path.join(TEST_ROOT, `uploads-${randomUUID()}.json`),
    adapter: (p) => createAdapter(p, settings.apiKeys, { env: { PALMIER_GOOGLE_BASE_URL: fake.googleBase, PALMIER_ELEVENLABS_BASE_URL: fake.elevenBase } }),
  })
const models = () => modelSet(hasKeyFrom(settings.apiKeys))
const media = (id: string): MediaManifestEntry | undefined => session.doc.manifest.entries.find((e) => e.id === id)

async function addAudio(name: string): Promise<MediaManifestEntry> {
  const mp3 = await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=200:d=2', '-c:a', 'libmp3lame', '-f', 'mp3', 'pipe:1'])
  const dest = await installPackageMedia(session.path, `${name}-${randomUUID().slice(0, 8)}.mp3`, mp3)
  const e: MediaManifestEntry = { id: randomUUID().toUpperCase(), name, type: 'audio', source: sourceForPath(dest, session.path), duration: 2, hasAudio: true }
  session.transact('Import Media', (d) => addMediaEntries(d, [e]))
  return e
}

beforeEach(async () => {
  toasts.length = 0
  session = await ProjectSession.create(path.join(TEST_ROOT, `prov-${randomUUID().slice(0, 8)}.palmier`), { file: newProjectFile(), manifest: emptyManifest() })
})
afterEach(async () => {
  if (!session.closed) await session.close()
})

describe('generation service with Google / ElevenLabs', () => {
  it('installs Google images as PNG without storing result URLs', async () => {
    const svc = makeService(makeApp())
    const ids = submitImage(svc, { session, model: models().findImage('nano-banana-pro')!, genInput: { prompt: 'a fox', model: 'nano-banana-pro', duration: 0, aspectRatio: '16:9', resolution: '1K' }, references: [], numImages: 2, undoLabel: 'Generate Image' })
    await svc.idle(session)
    for (const id of ids) {
      expect(media(id)).toMatchObject({ type: 'image', sourceWidth: 320, source: { project: { relativePath: `media/gen-${id.slice(0, 8)}.png` } } })
      expect(media(id)!.generationStatus).toBeUndefined()
      expect(media(id)!.generationInput!.resultURLs).toBeUndefined()
    }
    expect(toasts).toEqual(['2 images are ready in Framewright.'])
  })

  it('installs Gemini TTS as .wav and ElevenLabs music as .mp3', async () => {
    const svc = makeService(makeApp())
    const tts = models().findAudio('gemini-tts')!
    const [a] = submitAudio(svc, { session, model: tts, genInput: { prompt: 'hi', model: tts.id, duration: 0, aspectRatio: '' }, params: audio({ prompt: 'hi', voice: 'Kore' }), references: [], undoLabel: 'Generate Audio' })
    const music = models().findAudio('elevenlabs-music')!
    const [b] = submitAudio(svc, { session, model: music, genInput: { prompt: 'lofi', model: music.id, duration: 0, aspectRatio: '' }, params: audio({ prompt: 'lofi', durationSeconds: 10 }), references: [], undoLabel: 'Generate Audio' })
    await svc.idle(session)
    expect(media(a)).toMatchObject({ type: 'audio', hasAudio: true, source: { project: { relativePath: `media/gen-${a.slice(0, 8)}.wav` } } })
    expect(media(b)).toMatchObject({ type: 'audio', source: { project: { relativePath: `media/gen-${b.slice(0, 8)}.mp3` } } })
    expect(media(a)!.duration).toBeGreaterThan(1.5)
  })

  it('fails with the provider message, and cancels a running synchronous request', async () => {
    const svc = makeService(makeApp())
    const sfx = models().findAudio('elevenlabs-sfx')!
    const [f] = submitAudio(svc, { session, model: sfx, genInput: { prompt: 'x', model: sfx.id, duration: 0, aspectRatio: '' }, params: audio({ prompt: 'boom [fail]' }), references: [], undoLabel: 'Generate Audio' })
    const [h] = submitAudio(svc, { session, model: sfx, genInput: { prompt: 'y', model: sfx.id, duration: 0, aspectRatio: '' }, params: audio({ prompt: 'boom [hold]' }), references: [], undoLabel: 'Generate Audio' })
    await waitFor(() => media(f)!.generationStatus === 'failed: This prompt was blocked (fake).')
    await waitFor(() => fake.requests.some((r) => JSON.stringify(r.body).includes('boom [hold]')))
    expect(await svc.cancel(session, h)).toBe(true)
    expect(media(h)!.generationStatus).toBe(`failed: ${CANCELLED_MESSAGE}`)
    await waitFor(() => fake.aborted.includes('elevenlabs:/v1/sound-generation'))
  })

  it('dubs a source and resumes the dub after the project is reopened', async () => {
    const app = makeApp()
    const svc = new GenerationService(app, {
      pollDelay: () => 60_000,
      uploadCacheFile: path.join(TEST_ROOT, `uploads-${randomUUID()}.json`),
      adapter: (p) => createAdapter(p, settings.apiKeys, { env: { PALMIER_ELEVENLABS_BASE_URL: fake.elevenBase } }),
    })
    const src = await addAudio('Voice')
    const dub = models().findAudio('elevenlabs-dubbing')!
    const [id] = submitAudio(svc, { session, model: dub, genInput: { prompt: '', model: dub.id, duration: 0, aspectRatio: '' }, params: audio({ prompt: '', targetLanguage: 'es' }), references: [src], undoLabel: 'Generate Audio' })
    await waitFor(() => media(id)!.generationStatus === 'generating')
    const handle = media(id)!.generationInput!.byokJob as { provider: string; requestId: string; endpoint: string }
    expect(handle).toMatchObject({ provider: 'elevenlabs', endpoint: 'dubbing/es' })
    // Persisted inputs carry a short inline ref, never the file bytes.
    expect(JSON.stringify(media(id)!.generationInput).length).toBeLessThan(2000)
    const dir = session.path
    await session.close()
    svc.sweepClosed()
    session = await ProjectSession.open(dir)
    const restarted = makeService(app)
    restarted.attach(session)
    await waitFor(() => media(id)?.generationStatus === undefined && 'project' in media(id)!.source)
    await restarted.idle(session)
    expect(media(id)).toMatchObject({ type: 'audio', hasAudio: true })
    expect(fake.requests.some((r) => r.path === `/v1/dubbing/${handle.requestId}/audio/es`)).toBe(true)
  })
})

// ---------- Opt-in real APIs (spend money; only with keys in env) ----------

const realGoogle = process.env.PALMIER_REAL_GOOGLE === '1' && !!process.env.GEMINI_API_KEY
const realEleven = process.env.PALMIER_REAL_ELEVENLABS === '1' && !!process.env.ELEVENLABS_API_KEY

describe.skipIf(!realGoogle)('real Google API (PALMIER_REAL_GOOGLE=1, GEMINI_API_KEY)', () => {
  it('generates one 1K Nano Banana Lite image', { timeout: 180_000 }, async () => {
    const a = new GoogleAdapter({ key: process.env.GEMINI_API_KEY! })
    const r = (await a.submit(entry('nano-banana-lite'), route('nano-banana-lite', 'google'), image({ prompt: 'a small red circle on white', resolution: '1K', aspectRatio: '1:1' }))) as { outputs: Output[] }
    expect(bytesOf(r.outputs[0]).bytes.length).toBeGreaterThan(1000)
  })
  it('speaks a short Gemini TTS line', { timeout: 180_000 }, async () => {
    const a = new GoogleAdapter({ key: process.env.GEMINI_API_KEY! })
    const r = (await a.submit(entry('gemini-tts'), route('gemini-tts', 'google'), audio({ prompt: 'Hello.', voice: 'Kore' }))) as { outputs: Output[] }
    expect(bytesOf(r.outputs[0]).bytes.subarray(0, 4).toString()).toBe('RIFF')
  })
})

describe.skipIf(!realEleven)('real ElevenLabs API (PALMIER_REAL_ELEVENLABS=1, ELEVENLABS_API_KEY)', () => {
  it('lists voices and speaks a short v4 TTS line', { timeout: 180_000 }, async () => {
    const a = new ElevenLabsAdapter({ key: process.env.ELEVENLABS_API_KEY! })
    expect((await a.listVoices()).length).toBeGreaterThan(0)
    const r = (await a.submit(entry('elevenlabs-v4-tts'), route('elevenlabs-v4-tts', 'elevenlabs'), audio({ prompt: 'Hello.' }))) as { outputs: Output[] }
    expect(bytesOf(r.outputs[0]).bytes.length).toBeGreaterThan(1000)
  })
})

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}
