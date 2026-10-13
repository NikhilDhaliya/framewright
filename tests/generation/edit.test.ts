import { describe, expect, it } from 'vitest'
import { hasKeyFrom } from '../../src/core/generation/catalog'
import {
  actionAvailability,
  audioTileState,
  audioTransformAvailability,
  audioTransformSeed,
  createVideoSeed,
  editSeed,
  lipSyncSeed,
  menuActions,
  menuAudioTransforms,
  REFRAME_PROMPT,
  reframeSeed,
  tileState,
  TRANSITION_PROMPT,
  transitionAvailability,
  transitionSeed,
  upscaleModelFor,
  upscaleSeed,
  videoAudioSeed,
  videoToAudioModel,
} from '../../src/core/generation/edit'
import { modelSet } from '../../src/core/generation/models'
import { musicSourceSpan, musicSourceSummary, musicValidationNote, snapMusicDuration } from '../../src/core/generation/music'
import { finalizeTransitionClips, placeTransitionClip, replaceClipSource, transitionGapIsEmpty, transitionPlacementIsCurrent } from '../../src/core/generation/placement'
import { emptyManifest, newClip, newProjectFile, newTrack, type MediaManifestEntry } from '../../src/core/model'
import type { Doc } from '../../src/core/ops/context'

const keyed = modelSet(hasKeyFrom({ fal: 'k' }))
const keyless = modelSet(hasKeyFrom({}))

const video = (p: Partial<MediaManifestEntry> = {}): MediaManifestEntry => ({
  id: 'V1',
  name: 'Clip',
  type: 'video',
  source: { project: { relativePath: 'media/v.mp4' } },
  duration: 6,
  hasAudio: true,
  sourceWidth: 1920,
  sourceHeight: 1080,
  sourceFPS: 30,
  ...p,
})
const image = (p: Partial<MediaManifestEntry> = {}): MediaManifestEntry => ({ ...video({ id: 'I1', type: 'image', duration: 5, hasAudio: false, sourceFPS: undefined }), ...p })
const audio = (p: Partial<MediaManifestEntry> = {}): MediaManifestEntry => ({ ...video({ id: 'A1', type: 'audio', duration: 4, sourceWidth: undefined, sourceHeight: undefined, sourceFPS: undefined }), ...p })
const reason = (a: ReturnType<typeof actionAvailability>) => (a.ok ? null : a.reason)

describe('AI Edit availability (§B9.1)', () => {
  it('uses the Mac reasons verbatim', () => {
    expect(reason(actionAvailability(keyed, 'upscale', audio()))).toBe('Upscale only works on video or images')
    expect(reason(actionAvailability(keyed, 'upscale', video({ generationStatus: 'generating' })))).toBe('Generation in progress')
    expect(reason(actionAvailability(keyed, 'edit', video({ duration: 12.4 })))).toBe('Edit supports up to 10s (this is 12s)')
    expect(reason(actionAvailability(keyed, 'edit', video({ duration: 0 })))).toBe('Loading video metadata…')
    expect(reason(actionAvailability(keyed, 'edit', audio()))).toBe("Edit doesn't support audio")
    expect(reason(actionAvailability(keyed, 'edit', video({ type: 'text' })))).toBe("Edit doesn't support text")
    expect(reason(actionAvailability(keyed, 'edit', image()))).toBeNull()
    // A trimmed clip under 10 s qualifies even when the source is longer.
    expect(reason(actionAvailability(keyed, 'edit', video({ duration: 30 }), 8))).toBeNull()
    expect(reason(actionAvailability(keyed, 'rerun', video()))).toBe('Only available for AI-generated media')
    expect(reason(actionAvailability(keyed, 'rerun', video({ generationInput: { prompt: '', model: 'gone-model', duration: 0, aspectRatio: '' } })))).toBe('Model no longer available')
    expect(reason(actionAvailability(keyed, 'lipSync', image()))).toBe('Lip Sync only works on video')
    expect(reason(actionAvailability(keyed, 'reframe', image()))).toBe('Reframe only works on video')
    expect(reason(actionAvailability(keyed, 'reframe', video({ duration: 20 })))).toBe('MiniMax Hailuo 03 supports source videos up to 15 seconds. Trim the clip to continue.'.replace('MiniMax Hailuo 03', keyed.findVideo('minimax-h3')!.displayName))
    expect(reason(actionAvailability(keyed, 'generateMusic', image()))).toBe('Generate Music only works on video')
    expect(reason(actionAvailability(keyed, 'generateSFX', video({ duration: 11 })))).toBe('Mirelo SFX accepts at most 10s of source media (selection is 11s).'.replace('Mirelo SFX', videoToAudioModel(keyed, 'sfx')!.displayName))
    expect(reason(actionAvailability(keyed, 'createVideo', video()))).toBe('Create Video only works on images')
    expect(reason(actionAvailability(keyed, 'enhanceDraft', video()))).toBe('Draft already enhanced or cache unavailable')
  })

  it('enables FLUX Enhance only for finished drafts with a stored cache', () => {
    const job = { provider: 'fal', endpoint: 'blackforestlabs/flux-3/text-to-video/draft', requestId: 'r', submittedAt: '2026-10-13T00:00:00Z' }
    const draft = video({ generationInput: { prompt: 'x', model: 'flux-3', duration: 5, aspectRatio: '16:9', draft: true, byokJob: job, resultURLs: ['v', 'c'] } })
    expect(actionAvailability(keyed, 'enhanceDraft', draft).ok).toBe(true)
    expect(actionAvailability(keyed, 'enhanceDraft', { ...draft, generationInput: { ...draft.generationInput!, resultURLs: ['v'] } }).ok).toBe(false)
    expect(actionAvailability(keyed, 'enhanceDraft', { ...draft, generationStatus: 'downloading' }).ok).toBe(false)
  })

  it('audio transforms need audio, a key and a model that accepts the media', () => {
    const r = (a: ReturnType<typeof audioTransformAvailability>) => (a.ok ? null : a.reason)
    expect(r(audioTransformAvailability(keyed, 'cleanup', image()))).toBe('Voice Cleanup requires audio or video')
    expect(r(audioTransformAvailability(keyed, 'dubbing', image()))).toBe('Dubbing requires audio or video')
    expect(r(audioTransformAvailability(keyed, 'cleanup', video({ hasAudio: false })))).toBe('Video has no audio track')
    expect(r(audioTransformAvailability(keyed, 'dubbing', audio({ duration: 0 })))).toBe('Loading media metadata…')
    expect(r(audioTransformAvailability(keyed, 'cleanup', audio()))).toBeNull()
  })

  it('menus list available actions in candidate order; without a key nothing shows and tiles name the provider', () => {
    expect(menuActions(keyed, video())).toEqual(['upscale', 'edit', 'lipSync', 'reframe', 'generateMusic', 'generateSFX'])
    expect(menuActions(keyed, image())).toEqual(['upscale', 'edit', 'createVideo'])
    expect(menuAudioTransforms(keyed, video())).toEqual(['cleanup', 'dubbing'])
    expect(menuActions(keyless, video())).toEqual([])
    expect(tileState(keyless, 'edit', video())).toEqual({ enabled: false, reason: 'Add a fal.ai API key to use this' })
    // Availability reasons still win when the action itself is unavailable.
    expect(tileState(keyless, 'edit', audio()).reason).toBe("Edit doesn't support audio")
    expect(audioTileState(keyless, 'cleanup', audio()).reason).toMatch(/^Add a .+ API key to use this$/)
  })
})

describe('AI Edit seeds (§B9.2)', () => {
  it('edit / lip sync / create video / music / cleanup', () => {
    expect(editSeed(keyed, video())).toEqual({ prompt: '', model: 'kling-o3-edit', duration: 0, aspectRatio: '', imageURLAssetIds: ['V1'] })
    expect(editSeed(keyed, image())).toMatchObject({ model: 'nano-banana-pro', imageURLAssetIds: ['I1'] })
    expect(lipSyncSeed(keyed, video())).toMatchObject({ model: 'veed-lipsync-v2', imageURLAssetIds: ['V1'] })
    expect(createVideoSeed(keyed, image(), false)).toMatchObject({ model: 'minimax-h3', imageURLAssetIds: ['I1'] })
    expect(createVideoSeed(keyed, image(), true)).toMatchObject({ model: 'minimax-h3', referenceImageAssetIds: ['I1'] })
    expect(videoAudioSeed(keyed, video({ duration: 6.6 }), 'music')).toEqual({ prompt: '', model: 'sonilo-v1.1-video-to-music', duration: 7, aspectRatio: '', referenceVideoAssetIds: ['V1'] })
    expect(videoAudioSeed(keyed, video(), 'sfx')!.model).toBe('mirelo-sfx-v1.5-video-to-audio')
    expect(audioTransformSeed(keyed, audio(), 'cleanup', 2.4)).toEqual({ prompt: '', model: 'elevenlabs-voice-isolator', duration: 2, aspectRatio: '', referenceAudioAssetIds: ['A1'] })
    expect(audioTransformSeed(keyed, video(), 'dubbing')).toMatchObject({ model: 'elevenlabs-dubbing', duration: 6, referenceVideoAssetIds: ['V1'] })
  })

  it('reframe flips orientation, covers the (trimmed) duration and picks the high resolution', () => {
    expect(reframeSeed(keyed, video())).toEqual({ prompt: REFRAME_PROMPT, model: 'minimax-h3', duration: 6, aspectRatio: '9:16', resolution: '2K', referenceVideoAssetIds: ['V1'] })
    expect(reframeSeed(keyed, video({ sourceWidth: 1080, sourceHeight: 1920 }), 7.2)).toMatchObject({ aspectRatio: '16:9', duration: 8 })
  })

  it('upscale uses the trimmed seconds and the model defaults', () => {
    const m = upscaleModelFor(keyed, video(), true)!
    expect(m.id).toBe('topaz-video-upscaler')
    expect(upscaleSeed(video(), m, 2.4)).toMatchObject({ model: m.id, duration: 2, upscaleSettings: m.defaultSettings, imageURLAssetIds: ['V1'], upscaleSourceWidth: 1920, upscaleSourceFPS: 30 })
  })
})

describe('Create AI Transition (§B10)', () => {
  const gap = { trackIndex: 0, start: 30, end: 90 }
  it('availability and refusals', () => {
    expect(transitionAvailability(keyed, 'audio', gap, 30)).toBeNull()
    expect(transitionAvailability(keyed, 'video', { ...gap, start: 0 }, 30)).toBeNull()
    expect(transitionAvailability(keyed, 'video', { trackIndex: 0, start: 30, end: 30 + 16 * 30 }, 30)).toEqual({ model: null, refusal: 'Transitions are limited to 15 seconds. This gap is 16.0 seconds.' })
    expect(transitionAvailability(keyless, 'video', gap, 30)).toEqual({ model: null, refusal: 'Add an API key for a video model that supports first and last frames.' })
    expect(transitionAvailability(keyed, 'video', gap, 30)!.model!.id).toBe('minimax-h3')
  })
  it('seeds the first+last-frame model with the nearest supported duration', () => {
    const m = keyed.findVideo('minimax-h3')!
    expect(transitionSeed(m, 'S', 'E', 2)).toEqual({ prompt: TRANSITION_PROMPT, model: 'minimax-h3', duration: 5, aspectRatio: '', imageURLAssetIds: ['S', 'E'] })
  })
})

describe('Music section rules (§B8)', () => {
  const m = keyed.findAudio('sonilo-v1.1-video-to-music')!
  it('span, summary and notes', () => {
    const file = newProjectFile()
    const t = file.timelines[0]
    expect(musicSourceSpan(t, null)).toBeNull()
    t.tracks.push(newTrack('video', { clips: [newClip({ mediaRef: 'V1', mediaType: 'video', sourceClipType: 'video', startFrame: 0, durationFrames: 369 })] }))
    expect(musicSourceSpan(t, null)).toEqual({ startFrame: 0, frameCount: 369 })
    expect(musicSourceSpan(t, { start: 90, end: 30 })).toEqual({ startFrame: 30, frameCount: 60 })
    expect(musicSourceSummary({ startFrame: 0, frameCount: 369 }, 30, false)).toBe('Whole timeline · 0:00 – 0:12 · 12.3s')
    expect(musicSourceSummary({ startFrame: 1800, frameCount: 60 }, 30, true)).toBe('1:00 – 1:02 · 2.0s')
    expect(musicValidationNote(null, 'video', '', 0, false)).toBe('No music models available.')
    expect(musicValidationNote(m, 'text', '  ', 90, true)).toBe('Describe the music to generate.')
    expect(musicValidationNote(m, 'video', '', 0, false)).toBe('Add video to the timeline, then mark a range to score only part of it.')
    expect(musicValidationNote(m, 'video', '', 12, true)).toBeNull()
    expect(snapMusicDuration(m, 900)).toBe(90)
    expect(snapMusicDuration(m, 30)).toBe(30)
  })
})

describe('placements (§B6.2, §B10)', () => {
  function docWith(): Doc {
    const file = newProjectFile()
    const t = file.timelines[0]
    const manifest = emptyManifest()
    manifest.entries.push(video(), video({ id: 'NEW', name: 'Edited' }), image())
    t.tracks.push(
      newTrack('video', {
        clips: [
          newClip({ id: 'C1', mediaRef: 'V1', mediaType: 'video', sourceClipType: 'video', startFrame: 0, durationFrames: 60, trimStartFrame: 15, trimEndFrame: 30, linkGroupId: 'G' }),
          newClip({ id: 'C2', mediaRef: 'V1', mediaType: 'video', sourceClipType: 'video', startFrame: 150, durationFrames: 60 }),
          newClip({ id: 'IMG', mediaRef: 'I1', mediaType: 'image', sourceClipType: 'image', startFrame: 300, durationFrames: 60 }),
        ],
      }),
      newTrack('audio', { clips: [newClip({ id: 'C1A', mediaRef: 'V1', mediaType: 'audio', sourceClipType: 'video', startFrame: 0, durationFrames: 60, trimStartFrame: 15, trimEndFrame: 30, linkGroupId: 'G' })] }),
    )
    return { file, manifest } as Doc
  }

  it('replaces a clip and its same-media linked partners, resetting trims when asked', () => {
    const d = docWith()
    const t = d.file.timelines[0]
    expect(replaceClipSource(d, t.id, 'C1', 'NEW', true)).toBe(true)
    expect(t.tracks[0].clips[0]).toMatchObject({ mediaRef: 'NEW', trimStartFrame: 0, trimEndFrame: 0 })
    expect(t.tracks[1].clips[0]).toMatchObject({ mediaRef: 'NEW', trimStartFrame: 0, trimEndFrame: 0 })
    expect(t.tracks[0].clips[1].mediaRef).toBe('V1')
    // Create Video: the image clip becomes a video clip.
    expect(replaceClipSource(d, t.id, 'IMG', 'NEW', false)).toBe(true)
    expect(t.tracks[0].clips[2]).toMatchObject({ mediaRef: 'NEW', mediaType: 'video', sourceClipType: 'video' })
  })

  it('fills a gap exactly and retimes the finished media to fit', () => {
    const d = docWith()
    const t = d.file.timelines[0]
    const p = { timelineId: t.id, trackIndex: 0, gapStartFrame: 60, gapLengthFrames: 90 }
    expect(transitionGapIsEmpty(t, p)).toBe(true)
    expect(transitionPlacementIsCurrent(d, p)).toBe(true)
    const id = placeTransitionClip(d, p, 'NEW')!
    const clip = t.tracks[0].clips.find((c) => c.id === id)!
    expect(clip).toMatchObject({ startFrame: 60, durationFrames: 90, mediaRef: 'NEW' })
    expect(t.tracks[1].clips).toHaveLength(1)
    expect(transitionGapIsEmpty(t, p)).toBe(false)
    finalizeTransitionClips(d, 'NEW', 6)
    expect(clip).toMatchObject({ speed: 2, trimStartFrame: 0, trimEndFrame: 0, durationFrames: 90 })
  })
})
