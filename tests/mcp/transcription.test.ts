/** get_transcript, remove_words, add_captions and inspect_media transcripts on a temp ProjectSession (spec 02 §3.33/34/39/10). */
import './env'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { filterToRange, type TranscriptionResult } from '../../src/core/captions/transcript'
import { activeTimeline } from '../../src/core/ops/context'
import { endFrame } from '../../src/core/clip'
import type { TranscribeRequest, TranscriptionService } from '../../src/main/ml/transcribe/service'
import { TEST_ROOT } from './env'
import { audioEntry, call, connect, startHarness, videoEntry, type Harness } from './harness'

const W = (text: string, start: number, end: number) => ({ text, start, end })
const SPEECH: TranscriptionResult = {
  text: 'Um so today we are going to talk about um, the budget. It is uh really important.',
  language: 'en-US',
  words: [
    W('Um', 0.5, 0.8),
    W('so', 1.0, 1.2),
    W('today', 1.2, 1.6),
    W('we', 1.7, 1.8),
    W('are', 1.8, 1.9),
    W('going', 1.9, 2.1),
    W('to', 2.1, 2.2),
    W('talk', 2.2, 2.5),
    W('about', 2.5, 2.8),
    W('um,', 3.2, 3.5),
    W('the', 3.8, 3.9),
    W('budget.', 3.9, 4.4),
    W('It', 5.0, 5.1),
    W('is', 5.1, 5.2),
    W('uh', 5.5, 5.8),
    W('really', 6.0, 6.3),
    W('important.', 6.3, 7.0),
  ],
  segments: [
    { text: 'Um so today we are going to talk about um, the budget.', start: 0.5, end: 4.4 },
    { text: 'It is uh really important.', start: 5.0, end: 7.0 },
  ],
}

let h: Harness
let client: Client
let calls: TranscribeRequest[]
const video = videoEntry({ name: 'Interview' })
const voiceFile = path.join(TEST_ROOT, 'voiceover.wav')
const srtFile = path.join(TEST_ROOT, 'subs.srt')
const voice = audioEntry({ name: 'Voiceover', duration: 10, source: { external: { absolutePath: voiceFile } } })
const subs = audioEntry({ name: 'subs', type: 'subtitle', duration: 4, hasAudio: false, source: { external: { absolutePath: srtFile } } })

function fakeTranscription(): TranscriptionService {
  return {
    async transcribe(req: TranscribeRequest) {
      calls.push(req)
      if (req.locale === 'fr') throw new Error('Transcription failed: boom')
      return req.range ? filterToRange(SPEECH, req.range[0], req.range[1]) : SPEECH
    },
    async cachedTranscript(file: string) {
      return file === voiceFile ? SPEECH : null
    },
  } as unknown as TranscriptionService
}

beforeEach(async () => {
  calls = []
  await fs.writeFile(voiceFile, 'RIFF-not-really')
  await fs.writeFile(srtFile, '1\n00:00:01,000 --> 00:00:02,500\nHello there.\n\n2\n00:00:02,400 --> 00:00:04,000\nGeneral Kenobi!\n')
  h = await startHarness([video, voice, subs])
  h.ctx.transcription = fakeTranscription()
  client = await connect(h.url)
})

afterEach(async () => {
  await client.close()
  await h.close()
})

const timeline = () => activeTimeline(h.session.doc)
const allClips = () => timeline().tracks.flatMap((t) => t.clips)

async function placeVideo() {
  const r = await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })
  expect(r.isError).toBe(false)
}

describe('get_transcript', () => {
  it('returns timeline words in project frames from the linked audio side', async () => {
    await placeVideo()
    const r = await call(client, 'get_transcript')
    expect(r.isError).toBe(false)
    const audio = timeline().tracks[1].clips[0]
    expect(r.json).toMatchObject({ fps: 30, timing: 'projectFrames', transcriptionSource: 'local', wordFormat: ['index', 'text', 'start'] })
    expect(r.json.clips).toHaveLength(1)
    expect(r.json.clips[0]).toMatchObject({ clipId: audio.id.slice(0, 8), trackIndex: 1, startFrame: 0, endFrame: 300 })
    expect(r.json.clips[0].words.slice(0, 3)).toEqual([
      [0, 'Um', 15],
      [1, 'so', 30],
      [2, 'today', 36],
    ])
    expect(r.json.clips[0].words).toHaveLength(17)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ provider: 'local', isVideo: true })
    expect(calls[0].range ?? null).toBeNull()
  })

  it('reads sentence segments and windows', async () => {
    await placeVideo()
    const seg = await call(client, 'get_transcript', { granularity: 'segments' })
    expect(seg.json.segmentFormat).toEqual(['firstWordIndex', 'text', 'start', 'end'])
    expect(seg.json.clips[0].segments).toEqual([
      [0, 'Um so today we are going to talk about um, the budget.', 15, 132],
      [12, 'It is uh really important.', 150, 210],
    ])
    const windowed = await call(client, 'get_transcript', { startFrame: 140, endFrame: 170 })
    expect(windowed.json.clips[0].words.map((w: unknown[]) => w[1])).toEqual(['It', 'is', 'uh'])
  })

  it('validates its arguments and scope', async () => {
    await placeVideo()
    expect((await call(client, 'get_transcript', { granularity: 'lines' })).text).toBe("granularity must be 'words' or 'segments' (got 'lines')")
    const clipId = timeline().tracks[0].clips[0].id
    expect((await call(client, 'get_transcript', { clipId, trackIndex: 0 })).text).toBe('get_transcript: pass either clipId or trackIndex, not both.')
    expect((await call(client, 'get_transcript', { trackIndex: 7 })).text).toBe('get_transcript: trackIndex 7 is out of range (valid range: 0..1).')
    expect((await call(client, 'get_transcript', { trackIndex: 1.5 })).text).toBe('get_transcript: trackIndex must be an integer.')
    expect((await call(client, 'get_transcript', { language: 'xx-YY' })).text).toBe("get_transcript: on-device transcription does not support language 'xx-YY'.")
    expect((await call(client, 'get_transcript', { clipId: 'NOPE' })).text).toBe('Clip NOPE not found.')
    // A video clip resolves to its linked audio partner.
    const byClip = await call(client, 'get_transcript', { clipId })
    expect(byClip.json.clips[0].trackIndex).toBe(1)
    const byTrack = await call(client, 'get_transcript', { trackIndex: 0 })
    expect(byTrack.json.clips[0].trackIndex).toBe(1)
  })

  it('reports failing files in skipped instead of failing', async () => {
    await placeVideo()
    const r = await call(client, 'get_transcript', { language: 'fr' })
    expect(r.isError).toBe(false)
    expect(r.json.clips).toEqual([])
    expect(r.json.skipped[0].reason).toContain('boom')
  })
})

describe('remove_words', () => {
  it('cuts filler tokens by match, rippling linked A/V and closing the gaps', async () => {
    await placeVideo()
    const before = endFrame(timeline().tracks[0].clips.at(-1)!)
    const r = await call(client, 'remove_words', { matches: ['Um', 'uh'] })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ removedWords: 3, cutAggressiveness: 'balanced', transcriptionSource: 'local', removedText: 'Um um, uh' })
    expect(r.json.notes).toContain('Word indices shifted — re-read get_transcript before another remove_words.')
    // balanced = round(0.15·30) = 5 kept frames → 2 on each side of a cut.
    // 'Um' [15,24) at clip start: [0+2, 30-2) = [2, 28); 'um,' [96,105): [84+2, 114-2) = [86,112); 'uh' [165,174): [156+2, 180-2).
    expect(r.json.removedFrames).toBe(26 + 26 + 20)
    const v = timeline().tracks[0].clips
    const a = timeline().tracks[1].clips
    expect(v).toHaveLength(4)
    expect(a).toHaveLength(4)
    expect(endFrame(v.at(-1)!)).toBe(before - 72)
    expect(v.map((c) => [c.startFrame, c.durationFrames])).toEqual(a.map((c) => [c.startFrame, c.durationFrames]))
    expect(v[1].trimStartFrame).toBe(28)
    const after = await call(client, 'get_transcript')
    const texts = after.json.clips.flatMap((c: { words: unknown[][] }) => c.words.map((w) => w[1]))
    expect(texts).toEqual(['so', 'today', 'we', 'are', 'going', 'to', 'talk', 'about', 'the', 'budget.', 'It', 'is', 'really', 'important.'])
  })

  it('cuts by get_transcript indices and refuses stale sessions', async () => {
    await placeVideo()
    await call(client, 'get_transcript')
    const r = await call(client, 'remove_words', { words: [[12, 13], 99], cutAggressiveness: 'tight' })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ removedWords: 2, removedText: 'It is', cutAggressiveness: 'tight', indicesIgnored: [99] })
    const stale = await call(client, 'remove_words', { words: [0] })
    expect(stale.text).toBe('The timeline sources from the previous get_transcript have changed. Call get_transcript again before remove_words.')
    await call(client, 'get_transcript')
    expect((await call(client, 'remove_words', { words: [500] })).text).toBe('None of the requested word indices are in range 0...14. Re-read get_transcript.')
  })

  it('validates arguments', async () => {
    await placeVideo()
    expect((await call(client, 'remove_words', { words: [] })).text).toBe('remove_words: words or matches must not be empty.')
    expect((await call(client, 'remove_words', {})).text).toBe(`Missing 'words' or 'matches'. Pass word indices from get_transcript, e.g. [5, [12, 18]], or exact words like ["um", "uh"].`)
    expect((await call(client, 'remove_words', { words: [1], matches: ['um'] })).text).toBe('remove_words: pass either words or matches, not both.')
    expect((await call(client, 'remove_words', { matches: ['um'], cutAggressiveness: 'extreme' })).text).toBe('cutAggressiveness must be one of: tight, balanced, loose.')
    expect((await call(client, 'remove_words', { matches: ['...'] })).text).toBe('matches[0]: expected a non-empty word.')
    expect((await call(client, 'remove_words', { matches: [3] })).text).toBe('matches[0]: expected a string.')
    expect((await call(client, 'remove_words', { words: ['a'] })).text).toBe('words[0]: expected an integer index or an [start, end] pair.')
    expect((await call(client, 'remove_words', { matches: ['banana'] })).text).toBe('No transcript words matched: banana. Re-read get_transcript or pass exact word indices.')
  })
})

describe('add_captions', () => {
  it('creates a caption group with word timings on a new top track', async () => {
    await placeVideo()
    const r = await call(client, 'add_captions', { animation: 'wordReveal', maxWords: 4 })
    expect(r.isError).toBe(false)
    const t = timeline()
    expect(t.tracks).toHaveLength(3)
    const caps = t.tracks[0].clips
    expect(caps.length).toBeGreaterThanOrEqual(5)
    expect(new Set(caps.map((c) => c.captionGroupId)).size).toBe(1)
    expect(caps.every((c) => c.mediaType === 'text' && c.textStyle?.fontSize === 48 && c.textAnimation?.preset === 'wordReveal')).toBe(true)
    expect(caps.every((c) => (c.textContent ?? '').split(' ').length <= 4)).toBe(true)
    expect(caps.map((c) => c.textContent).join(' ')).toBe(SPEECH.words.map((w) => w.text).join(' '))
    // 12 words, max 4: clause break at "um," then mid-word splits (CaptionBuilder.breakOnce).
    expect(caps.map((c) => c.textContent)).toEqual(['Um so', 'today we are', 'going to', 'talk about um,', 'the budget.', 'It is', 'uh really important.'])
    expect(caps[0]).toMatchObject({ startFrame: 15, textContent: 'Um so' })
    expect(caps[0].wordTimings).toEqual([
      { text: 'Um', startFrame: 0, endFrame: 9 },
      { text: 'so', startFrame: 15, endFrame: 21 },
    ])
    expect(caps[0].transform.centerY).toBeCloseTo(0.9)
    expect(caps[0].transform.centerX).toBeCloseTo(0.5)
    for (let i = 1; i < caps.length; i++) expect(caps[i].startFrame).toBeGreaterThanOrEqual(endFrame(caps[i - 1]))
    expect(r.json.captionGroups[0]).toMatchObject({ clipCount: caps.length, track: 0 })
    expect(r.json.createdTracks[0]).toMatchObject({ index: 0, type: 'video' })
    expect(calls[0].range).toEqual([0, 11])
    // One undo step.
    expect((await call(client, 'undo')).isError).toBe(false)
    expect(timeline().tracks).toHaveLength(2)
  })

  it('closes gaps, applies style, position and censoring options', async () => {
    await placeVideo()
    const r = await call(client, 'add_captions', { style: { fontSize: 60, color: '#FFCC00' }, transform: { x: 0.3, y: 0.2 }, maximumGapSeconds: 0, censorProfanity: true, language: 'en-US' })
    expect(r.isError).toBe(false)
    const caps = timeline().tracks[0].clips
    expect(caps.map((c) => c.textContent)).toEqual(['Um so today we are going to talk about um, the budget.', 'It is uh really important.'])
    expect(caps.map((c) => [c.startFrame, c.durationFrames])).toEqual([
      [15, 117],
      [150, 60],
    ])
    expect(caps[0].textStyle?.fontSize).toBe(60)
    expect(caps[0].transform.centerY).toBeCloseTo(0.2)
    expect(caps[0].transform.centerX).toBeCloseTo(0.3)
    expect(calls[0]).toMatchObject({ censorProfanity: true, locale: 'en-US' })
  })

  it('validates arguments', async () => {
    await placeVideo()
    expect((await call(client, 'add_captions', { maxWords: 0 })).text).toBe('add_captions: maxWords must be an integer >= 1.')
    expect((await call(client, 'add_captions', { maxCharacters: 2.5 })).text).toBe('add_captions: maxCharacters must be an integer >= 1.')
    expect((await call(client, 'add_captions', { maximumGapSeconds: 3 })).text).toBe('add_captions: maximumGapSeconds must be a finite number from 0.0 through 2.0.')
    expect((await call(client, 'add_captions', { subtitleMediaRef: video.id, maxWords: 2 })).text).toBe("add_captions: subtitleMediaRef uses the file's text, timing, and default styling as-is; remove maxWords.")
    expect((await call(client, 'add_captions', { subtitleMediaRef: video.id })).text).toBe(`add_captions: '${video.id.slice(0, 8)}' is video, not a subtitle file. Omit subtitleMediaRef to caption spoken audio.`)
    expect((await call(client, 'add_captions', { animation: 'spin' })).isError).toBe(true)
  })

  it('reports no speech and no source', async () => {
    expect((await call(client, 'add_captions')).text).toBe('No audio clips to caption.')
    h.ctx.transcription = { transcribe: async () => ({ text: '', words: [], segments: [] }) } as unknown as TranscriptionService
    await placeVideo()
    expect((await call(client, 'add_captions')).text).toBe('No speech detected to caption.')
  })

  it('places SRT cues at their timecodes', async () => {
    const r = await call(client, 'add_captions', { subtitleMediaRef: subs.id })
    expect(r.isError).toBe(false)
    const caps = timeline().tracks[0].clips
    expect(caps.map((c) => [c.textContent, c.startFrame, c.durationFrames])).toEqual([
      ['Hello there.', 30, 42],
      ['General Kenobi!', 72, 48],
    ])
  })
})

describe('inspect_media transcription', () => {
  it('returns source-second segments and words for audio, or project frames for a clip', async () => {
    const r = await call(client, 'inspect_media', { mediaRef: voice.id, wordTimestamps: true, startSeconds: 4, endSeconds: 8 })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ timing: 'sourceSeconds', language: 'en-US', timeRange: [4, 8] })
    expect(r.json.segments).toEqual([
      ['Um so today we are going to talk about um, the budget.', 0.5, 4.4],
      ['It is uh really important.', 5, 7],
    ])
    expect(r.json.words[0]).toEqual(['budget.', 3.9, 4.4])
    expect(calls.at(-1)).toMatchObject({ isVideo: false, range: [4, 8] })
    await call(client, 'add_clips', { entries: [{ mediaRef: voice.id, startFrame: 60 }] })
    const clip = allClips().find((c) => c.mediaRef === voice.id)!
    const mapped = await call(client, 'inspect_media', { mediaRef: voice.id, clipId: clip.id })
    expect(mapped.json.timing).toBe('projectFrames')
    expect(mapped.json.segments[1]).toEqual(['It is uh really important.', 210, 270])
    expect(mapped.json.timelineMapping).toMatchObject({ clipStartFrame: 60, fps: 30 })
    expect((await call(client, 'inspect_media', { mediaRef: voice.id, language: 'tlh' })).text).toBe("inspect_media: on-device transcription does not support language 'tlh'.")
  })
})

describe('search_media', () => {
  it('searches cached local transcripts (spoken) and reports visual search as unavailable', async () => {
    const r = await call(client, 'search_media', { query: 'budget,' })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ timelineFps: 30, moments: [], index: { status: 'failed', indexableAssets: 1, indexedAssets: 0, modelDownloadError: "Visual search isn't available on Linux yet." } })
    expect(r.json.spoken).toEqual([{ mediaRef: voice.id.slice(0, 8), name: 'Voiceover', startSeconds: 0.5, endSeconds: 4.4, text: 'Um so today we are going to talk about um, the budget.' }])
    const spokenOnly = await call(client, 'search_media', { query: 'REALLY important', scope: 'spoken', mediaRef: voice.id })
    expect(spokenOnly.json.moments).toBeUndefined()
    expect(spokenOnly.json.spoken.map((h: { text: string }) => h.text)).toEqual(['It is uh really important.'])
    expect((await call(client, 'search_media', { query: 'budget', mediaRef: video.id, scope: 'spoken' })).json.spoken).toEqual([])
    expect((await call(client, 'search_media', { query: '  ' })).text).toBe('search_media: query is empty')
    expect((await call(client, 'search_media', { query: 'x', scope: 'audio' })).text).toBe("search_media: scope must be visual, spoken, or both (got 'audio')")
    expect((await call(client, 'search_media', { query: 'x', mediaRef: 'NOPE' })).text).toBe('Media asset not found: NOPE')
  })
})
