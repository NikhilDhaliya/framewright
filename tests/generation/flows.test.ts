/**
 * Round 2 flows against the fake fal server (never the real API): Music (§B8), AI Edit kinds with their pending
 * context (§B9), FLUX Enhance (§B9.6) and Create AI Transition (§B10). Checks session.doc and undo steps.
 */
import '../mcp/env'
import { TEST_ROOT } from '../mcp/env'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { audioTransformSeed, editSeed, reframeSeed, videoAudioSeed, type PendingContext } from '../../src/core/generation/edit'
import { hasKeyFrom } from '../../src/core/generation/catalog'
import { modelSet } from '../../src/core/generation/models'
import type { AudioRequest, GenerateRequest, ImageRequest, MusicPhase, UpscaleRequest, VideoRequest } from '../../src/core/generation/requests'
import { newClip, newTrack, type Clip, type MediaManifestEntry } from '../../src/core/model'
import { activeTimeline } from '../../src/core/ops/context'
import { firstAudioIndex } from '../../src/core/timeline'
import { ffmpeg } from '../../src/main/media/ffmpeg'
import { captureTransitionFrames, submitMusic } from '../../src/main/generation/music'
import { enhanceDraftAsset, submitPanelRequest } from '../../src/main/generation/panel'
import { GenerationService, setGenerationService } from '../../src/main/generation/service'
import { submitVideo } from '../../src/main/generation/submissions'
import type { ExportJob, UiCommand } from '../../src/shared/api'
import { makePng, startHarness, type Harness } from '../mcp/harness'
import { startFakeFal, type Behavior, type FakeFal } from './fakeFal'

let fake: FakeFal
let h: Harness
let svc: GenerationService
let behavior: (endpoint: string) => Behavior | undefined = () => undefined
let clipFile = ''

beforeAll(async () => {
  fake = await startFakeFal({ polls: 1, behavior: (e) => behavior(e) })
  h = await startHarness()
  h.ctx.settings().apiKeys.fal = 'test-key'
  svc = new GenerationService(h.ctx, { pollDelay: () => 5, falBases: { queueBase: `${fake.url}/queue`, restBase: `${fake.url}/rest` }, uploadCacheFile: path.join(TEST_ROOT, `up-${randomUUID()}.json`) })
  setGenerationService(h.ctx, svc)
  clipFile = path.join(TEST_ROOT, `flow-src-${randomUUID()}.mp4`)
  await ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=3:r=30', '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipFile])
})
afterAll(async () => {
  delete h.ctx.settings().apiKeys.fal
  await h.close()
  await fake.close()
})
beforeEach(() => {
  behavior = () => undefined
  h.ui.length = 0
})

const set = () => modelSet(hasKeyFrom(h.ctx.settings().apiKeys))
const doc = () => h.session.doc
const tl = () => activeTimeline(doc())
const fresh = (id: string) => doc().manifest.entries.find((e) => e.id === id)!
const label = () => h.session.snapshot().undoLabel
const toasts = () => h.ui.flatMap((c: UiCommand) => (c.type === 'toast' ? [c.message] : []))
const clip = (id: string): Clip => tl().tracks.flatMap((t) => t.clips).find((c) => c.id === id)!

async function importFile(file: string, name: string): Promise<MediaManifestEntry> {
  const id = await h.ctx.media.importBytes(h.session, await fs.readFile(file), path.basename(file), { name })
  return fresh(id)
}
const importVideo = (name = 'Shot') => importFile(clipFile, name)
async function importImage(name = 'Still'): Promise<MediaManifestEntry> {
  const id = await h.ctx.media.importBytes(h.session, await makePng(640, 360), 'still.png', { name })
  return fresh(id)
}

/** Places a clip on a fresh track of the active timeline (one undo step). */
function placeOnTrack(asset: MediaManifestEntry, type: 'video' | 'audio', startFrame: number, durationFrames: number, extra: Partial<Clip> = {}): string {
  const c = newClip({ mediaRef: asset.id, mediaType: type === 'audio' ? 'audio' : asset.type, sourceClipType: asset.type, startFrame, durationFrames, ...extra })
  h.session.transact('Add Clip', (d) => {
    const t = activeTimeline(d)
    // Video tracks sit above audio tracks.
    if (type === 'video') t.tracks.splice(firstAudioIndex(t), 0, newTrack(type, { clips: [c] }))
    else t.tracks.push(newTrack(type, { clips: [c] }))
  })
  return c.id
}

const videoReq = (p: Partial<VideoRequest> & { model: string }): VideoRequest => ({
  kind: 'video',
  prompt: '',
  duration: 5,
  aspectRatio: '16:9',
  resolution: null,
  draft: false,
  generateAudio: null,
  mode: 'frames',
  frameIds: [],
  imageRefIds: [],
  videoRefIds: [],
  audioRefIds: [],
  sourceVideoId: null,
  ...p,
})
const audioReq = (p: Partial<AudioRequest> & { model: string }): AudioRequest => ({
  kind: 'audio',
  prompt: '',
  voice: null,
  lyrics: '',
  styleInstructions: '',
  instrumental: false,
  duration: null,
  targetLanguage: null,
  multilingual: false,
  sourceId: null,
  imageRefIds: [],
  audioRefIds: [],
  ...p,
})
const submit = (req: GenerateRequest) => submitPanelRequest(h.ctx, h.session, req)

describe('Audio ▸ Music (§B8)', () => {
  it('text to music: placeholder named after the model, an Add Music clip at the playhead that snaps to the result', async () => {
    const id = await submitMusic(h.ctx, h.session, { mode: 'text', model: 'sonilo-v1.1-video-to-music', prompt: ' calm piano ', timelineId: tl().id, startFrame: 45, frameCount: 300, spanSeconds: 10 })
    expect(label()).toBe('Add Music')
    expect(fresh(id)).toMatchObject({ name: 'Sonilo Music', type: 'audio', duration: 10, generationInput: { prompt: 'calm piano', model: 'sonilo-v1.1-video-to-music', duration: 10, aspectRatio: '', audioInput: 'text' } })
    const placed = tl().tracks.flatMap((t) => t.clips).find((c) => c.mediaRef === id)!
    expect(placed).toMatchObject({ startFrame: 45, durationFrames: 300, mediaType: 'audio' })
    await svc.idle(h.session)
    expect(fake.submissions.at(-1)).toMatchObject({ endpoint: 'sonilo/v1.1/text-to-music', body: { prompt: 'calm piano', duration: 10 } })
    expect(fresh(id).generationStatus).toBeUndefined()
    // The harness probes audio as 4 s → 120 frames; not an undo step.
    expect(clip(placed.id)).toMatchObject({ durationFrames: 120, trimStartFrame: 0 })
    expect(label()).toBe('Add Music')
    await expect(submitMusic(h.ctx, h.session, { mode: 'text', model: 'sonilo-v1.1-video-to-music', prompt: ' ', timelineId: tl().id, startFrame: 0, frameCount: 30, spanSeconds: 1 })).rejects.toThrow('Describe the music to generate.')
  })

  it('video to music: exports the span silently at 240p, uploads it and reports phases', async () => {
    const v = await importVideo('Music source')
    placeOnTrack(v, 'video', 0, 90)
    const seen: ExportJob['options'][] = []
    const original = h.ctx.exporter
    h.ctx.exporter = {
      ...original,
      start: (_s, options) => {
        seen.push(options)
        void fs.copyFile(clipFile, options.outputPath)
        return { id: 'span', options, status: 'running', progress: 0, framesRendered: 0, totalFrames: 0, startedAt: '', outputPath: options.outputPath }
      },
      wait: async (id) => {
        await new Promise((r) => setTimeout(r, 30))
        return { id, options: {} as ExportJob['options'], status: 'completed', progress: 1, framesRendered: 0, totalFrames: 0, startedAt: '', outputPath: '' }
      },
    }
    const phases: MusicPhase[] = []
    try {
      const id = await submitMusic(h.ctx, h.session, { mode: 'video', model: 'sonilo-v1.1-video-to-music', prompt: '', timelineId: tl().id, startFrame: 0, frameCount: 90, spanSeconds: 3 }, (p) => phases.push(p))
      expect(phases).toEqual(['exporting', 'uploading', 'generating'])
      expect(seen[0]).toMatchObject({ format: 'mp4', width: 426, height: 240, quality: 'low', range: { start: 0, end: 90 }, includeAudio: false })
      expect(fresh(id).generationInput).toMatchObject({ audioInput: 'video', duration: 3 })
      await svc.idle(h.session)
      expect(fake.submissions.at(-1)!.endpoint).toBe('sonilo/v1.1/video-to-music')
      expect(String(fake.submissions.at(-1)!.body.video_url)).toMatch(/^(data:|http)/)
    } finally {
      h.ctx.exporter = original
    }
  })
})

describe('AI Edit (§B9) through the panel request with pending context', () => {
  it('Edit on a trimmed clip: sends the trimmed range, then replaces the clip source (trims reset) as one undo step', async () => {
    const v = await importVideo('Edit me')
    const clipId = placeOnTrack(v, 'video', 0, 45, { trimStartFrame: 15, trimEndFrame: 30 })
    const seed = editSeed(set(), v)!
    const pending: PendingContext = { replacementClipId: clipId, replacementTimelineId: tl().id, trim: { timelineId: tl().id, clipId } }
    const [id] = submit(videoReq({ model: seed.model as string, prompt: 'make it snow', mode: 'source', sourceVideoId: v.id, aspectRatio: '', pending }))
    expect(label()).toBe('Generate Video')
    // Placeholder covers the trimmed span (45 frames at 30 fps).
    expect(fresh(id)).toMatchObject({ duration: 1.5, generationInput: { model: 'kling-o3-edit', imageURLAssetIds: [v.id], duration: 2 } })
    await svc.idle(h.session)
    expect(fake.submissions.at(-1)!.endpoint).toMatch(/kling/)
    expect(clip(clipId)).toMatchObject({ mediaRef: id, trimStartFrame: 0, trimEndFrame: 0 })
    expect(label()).toBe('Replace Clip Source')
    h.session.undo()
    expect(clip(clipId)).toMatchObject({ mediaRef: v.id, trimStartFrame: 15, trimEndFrame: 30 })
  })

  it('Reframe seeds a reference-to-video request on the reframe model', async () => {
    const v = await importVideo('Wide')
    const seed = reframeSeed(set(), v)!
    const [id] = submit(videoReq({ model: seed.model as string, prompt: seed.prompt, duration: seed.duration, aspectRatio: seed.aspectRatio, resolution: seed.resolution as string, mode: 'references', videoRefIds: [v.id] }))
    await svc.idle(h.session)
    expect(fresh(id).generationInput).toMatchObject({ model: 'minimax-h3', aspectRatio: '9:16', referenceVideoAssetIds: [v.id] })
    expect(fresh(id).generationStatus).toBeUndefined()
  })

  it('Lip Sync replaces the clip; Upscale on a clip replaces and keeps the asset folder', async () => {
    const v = await importVideo('Talking')
    const voice = await importFile(clipFile.replace(/\.mp4$/, '.mp3'), 'Voice').catch(async () => {
      const mp3 = path.join(TEST_ROOT, `voice-${randomUUID()}.mp3`)
      await ffmpeg(['-y', '-f', 'lavfi', '-i', 'sine=f=220:d=2', '-c:a', 'libmp3lame', mp3])
      return importFile(mp3, 'Voice')
    })
    const lipClip = placeOnTrack(v, 'video', 0, 60)
    const [lip] = submit(videoReq({ model: 'veed-lipsync-v2', mode: 'source', sourceVideoId: v.id, audioRefIds: [voice.id], aspectRatio: '', pending: { replacementClipId: lipClip, replacementTimelineId: tl().id } }))
    await svc.idle(h.session)
    expect(fresh(lip).generationStatus).toBeUndefined()
    expect(clip(lipClip).mediaRef).toBe(lip)

    const still = await importImage('Small')
    const imgClip = placeOnTrack(still, 'video', 0, 60)
    const up: UpscaleRequest = { kind: 'upscale', model: 'topaz-image-upscaler', sourceId: still.id, settings: { selections: { targetResolution: '1080p' }, numbers: {}, toggles: {} }, pending: { replacementClipId: imgClip, replacementTimelineId: tl().id } }
    const [upId] = submit(up)
    expect(fresh(upId).name).toBe('Upscaled Small')
    await svc.idle(h.session)
    expect(clip(imgClip).mediaRef).toBe(upId)
  })

  it('Create Video turns an image clip into a video clip on completion', async () => {
    const still = await importImage('First frame')
    const imgClip = placeOnTrack(still, 'video', 0, 60)
    const [id] = submit(videoReq({ model: 'minimax-h3', prompt: 'the scene comes alive', resolution: '768P', frameIds: [still.id], pending: { replacementClipId: imgClip, replacementTimelineId: tl().id } }))
    await svc.idle(h.session)
    expect(clip(imgClip)).toMatchObject({ mediaRef: id, mediaType: 'video', sourceClipType: 'video' })
  })

  it('Rerun on a clip regenerates with the stored input and replaces the clip', async () => {
    const image: ImageRequest = { kind: 'image', model: 'nano-banana-pro', prompt: 'a fox', aspectRatio: '16:9', resolution: '1K', quality: null, numImages: 1, refIds: [] }
    const [first] = submit(image)
    await svc.idle(h.session)
    const c = placeOnTrack(fresh(first), 'video', 0, 30)
    const [second] = submit({ ...image, pending: { replacementClipId: c, replacementTimelineId: tl().id } })
    await svc.idle(h.session)
    expect(clip(c).mediaRef).toBe(second)
    expect(fresh(second).generationInput).toMatchObject({ prompt: 'a fox', model: 'nano-banana-pro' })
  })

  it('Generate SFX / Clean Up Voice / Dub place a generating clip at the clip start (one named step) that snaps to the result', async () => {
    const v = await importVideo('Scene')
    const c = placeOnTrack(v, 'video', 30, 60, { trimStartFrame: 10 })
    const t = tl()
    const cases = [
      { seed: videoAudioSeed(set(), v, 'sfx')!, action: 'Add Sound Effects', endpoint: /mirelo/, extra: {} },
      { seed: audioTransformSeed(set(), v, 'cleanup', 2)!, action: 'Add Cleaned Voice', endpoint: /audio-isolation/, extra: {} },
      { seed: audioTransformSeed(set(), v, 'dubbing', 2)!, action: 'Add Dubbed Voice', endpoint: /dubbing/, extra: { targetLanguage: 'es' } },
    ]
    for (const k of cases) {
      const pending: PendingContext = { trim: { timelineId: t.id, clipId: c }, audioPlacement: { timelineId: t.id, startFrame: 30, spanSeconds: 2, actionName: k.action } }
      const [id] = submit(audioReq({ model: k.seed.model as string, sourceId: v.id, pending, ...k.extra }))
      expect(label()).toBe(k.action)
      const placed = tl().tracks.filter((x) => x.type === 'audio').flatMap((x) => x.clips).find((x) => x.mediaRef === id)!
      expect(placed).toMatchObject({ startFrame: 30, durationFrames: 60 })
      // Trimmed span: 60 frames → 2 s.
      expect(fresh(id).generationInput).toMatchObject({ duration: 2, referenceVideoAssetIds: [v.id] })
      await svc.idle(h.session)
      expect(fake.submissions.at(-1)!.endpoint).toMatch(k.endpoint)
      expect(fresh(id).generationStatus).toBeUndefined()
      expect(clip(placed.id).durationFrames).toBe(120)
      expect(label()).toBe(k.action)
    }
  })
})

describe('FLUX Enhance (§B9.6)', () => {
  it('re-renders a finished draft at 1080p from its cache and toasts', async () => {
    behavior = (e) => (e.endsWith('/draft') ? { extra: { draft_cache: { url: `${fake.url}/files/cache.bin` } } } : undefined)
    const m = set().findVideo('flux-3')!
    const [draft] = submitVideo(svc, {
      session: h.session,
      model: m,
      genInput: { prompt: 'Fireworks', model: 'flux-3', duration: 5, aspectRatio: '16:9', resolution: '720p', draft: true },
      inputs: { frames: [], imageRefs: [], videoRefs: [], audioRefs: [] },
      placeholderDuration: 5,
      generateAudio: true,
      undoLabel: 'Generate Video',
    })
    await svc.idle(h.session)
    expect(fresh(draft).generationInput!.resultURLs).toHaveLength(2)
    h.ui.length = 0
    const id = enhanceDraftAsset(h.ctx, h.session, draft)
    expect(label()).toBe('FLUX Enhance')
    expect(fresh(id)).toMatchObject({ name: 'Fireworks 1080p', generationInput: { draft: false, resolution: '1080p' } })
    expect(fresh(id).generationInput!.resultURLs).toBeUndefined()
    await svc.idle(h.session)
    expect(fake.submissions.at(-1)).toMatchObject({ endpoint: 'blackforestlabs/flux-3/draft-enhance', body: { draft_cache_url: `${fake.url}/files/cache.bin` } })
    expect(toasts()).toContain('Enhanced with FLUX.3 at 1080p.')
    // The enhanced asset stores one URL, so it cannot be enhanced again.
    expect(() => enhanceDraftAsset(h.ctx, h.session, id)).toThrow('Draft already enhanced or cache unavailable')
  })
})

describe('Create AI Transition (§B10)', () => {
  it('captures both frames, places a clip filling the gap (AI Transition) and retimes it on completion', async () => {
    const v = await importVideo('Gap source')
    // A fresh timeline layout: clips at [0,60) and [120,180) on one video track.
    h.session.transact('Setup', (d) => {
      const t = activeTimeline(d)
      t.tracks = [newTrack('video', { clips: [newClip({ mediaRef: v.id, mediaType: 'video', sourceClipType: 'video', startFrame: 0, durationFrames: 60 }), newClip({ mediaRef: v.id, mediaType: 'video', sourceClipType: 'video', startFrame: 120, durationFrames: 60 })] })]
    })
    const p = { timelineId: tl().id, trackIndex: 0, gapStartFrame: 60, gapLengthFrames: 60 }
    const frames = (await captureTransitionFrames(h.ctx, h.session, p))!
    expect(frames.first).toMatchObject({ name: 'Transition start (frame 59)', type: 'image' })
    expect(frames.last).toMatchObject({ name: 'Transition end (frame 120)', type: 'image' })
    expect('project' in frames.first.source && /^media\/frame-[0-9A-F]{8}\.png$/i.test(frames.first.source.project.relativePath)).toBe(true)
    expect(label()).toBe('Capture Frame')
    const [id] = submit(videoReq({ model: 'minimax-h3', prompt: 'transition', resolution: '768P', frameIds: [frames.first.id, frames.last.id], pending: { transitionPlacement: p } }))
    expect(label()).toBe('AI Transition')
    const placed = tl().tracks[0].clips.find((c) => c.mediaRef === id)!
    expect(placed).toMatchObject({ startFrame: 60, durationFrames: 60 })
    await svc.idle(h.session)
    // Harness probe: 6 s video at 30 fps = 180 frames into a 60-frame gap → speed 3.
    expect(clip(placed.id)).toMatchObject({ startFrame: 60, durationFrames: 60, speed: 3, trimStartFrame: 0, trimEndFrame: 0 })
    expect(label()).toBe('AI Transition')

    // The gap is gone now: a second transition lands in Media with a toast.
    h.ui.length = 0
    const [other] = submit(videoReq({ model: 'minimax-h3', prompt: 'again', resolution: '768P', frameIds: [frames.first.id, frames.last.id], pending: { transitionPlacement: p } }))
    expect(toasts()).toContain('The gap is no longer available, so the transition will land in Media instead.')
    expect(tl().tracks[0].clips.some((c) => c.mediaRef === other)).toBe(false)
    expect(await captureTransitionFrames(h.ctx, h.session, p)).toBeNull()
    await svc.idle(h.session)
  })
})
