/** get_transcript speaker relabelling from the session's Identify masks (spec 02 §3.33, 07 §3.5 step 10). */
import '../mcp/env'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { relabelWords, speakerIdAt, speakerName } from '../../src/core/audio/speakers'
import type { TranscriptionResult } from '../../src/core/captions/transcript'
import { SessionSpeakers, type SessionMasks } from '../../src/main/ml/audio/sessionSpeakers'
import type { SpeakerFile, SpeakerService } from '../../src/main/ml/audio/speakers'
import type { TranscriptionService } from '../../src/main/ml/transcribe/service'
import { call, connect, startHarness, videoEntry, type Harness } from '../mcp/harness'

const W = (text: string, start: number, end: number, speaker?: string) => ({ text, start, end, ...(speaker ? { speaker } : {}) })
const SPEECH: TranscriptionResult = {
  text: 'Hello there. How are you? Fine thanks.',
  language: 'en-US',
  words: [W('Hello', 0.5, 0.8), W('there.', 0.9, 1.2), W('How', 2.0, 2.2), W('are', 2.2, 2.4), W('you?', 2.4, 2.7), W('Fine', 4.0, 4.3, 'spk_7'), W('thanks.', 4.3, 4.8, 'spk_7')],
  segments: [],
}
/** 32 ms cells: speaker 1 for 0–1.6 s, speaker 2 for 1.92–3.2 s, nothing after. */
const cells = (s: number) => Math.floor(s / 0.032)
const RUNS: [number, number, number][] = [
  [0, cells(1.6), 1],
  [cells(1.92), cells(3.2), 2],
]

describe('speaker lookups', () => {
  it('finds the id of the cell holding a source time', () => {
    expect(speakerIdAt(RUNS, 0)).toBe(1)
    expect(speakerIdAt(RUNS, 1.7)).toBe(-1)
    expect(speakerIdAt(RUNS, 2.5)).toBe(2)
    expect(speakerIdAt(RUNS, 9)).toBe(-1)
    expect(speakerIdAt([], 1)).toBe(-1)
  })

  it('names from the registry, else "Speaker <id>"', () => {
    const reg = [{ id: 1, name: 'Alice', color: [0, 0, 1, 1], centroid: [] }, { id: 3, name: '', color: [0, 0, 1, 1], centroid: [] }]
    expect(speakerName(1, reg)).toBe('Alice')
    expect(speakerName(2, reg)).toBe('Speaker 2')
    expect(speakerName(3, reg)).toBe('Speaker 3')
    const out = relabelWords(SPEECH.words, RUNS, reg)
    expect(out.map((w) => w.speaker)).toEqual(['Alice', 'Alice', 'Speaker 2', 'Speaker 2', 'Speaker 2', 'spk_7', 'spk_7'])
  })
})

let h: Harness
let client: Client
let identifyCalls: { files: SpeakerFile[]; cacheOnly: boolean }[]
let fallbackMasks: SessionMasks
const video = videoEntry({ name: 'Interview' })

beforeEach(async () => {
  identifyCalls = []
  fallbackMasks = {}
  h = await startHarness([video])
  h.ctx.transcription = { transcribe: async () => SPEECH, cachedTranscript: async () => SPEECH } as unknown as TranscriptionService
  const fakeSpeakers = {
    inFlight: false,
    identify: async (files: SpeakerFile[], _reg: unknown, o: { cacheOnly: boolean }) => {
      identifyCalls.push({ files, cacheOnly: o.cacheOnly })
      return { masks: fallbackMasks, byFileLocal: {}, newEntries: [], errors: [] }
    },
  } as unknown as SpeakerService
  h.ctx.speakers = new SessionSpeakers(fakeSpeakers)
  client = await connect(h.url)
  expect((await call(client, 'add_clips', { entries: [{ mediaRef: video.id, startFrame: 0 }] })).isError).toBe(false)
  h.session.transact('Speakers', (d) => void (d.file.speakers = [{ id: 1, name: 'Alice', color: [0, 0, 1, 1], centroid: [] }]), false)
})

afterEach(async () => {
  await client.close()
  await h.close()
})

describe('get_transcript speakers', () => {
  it('labels words with the identified speakers as run-length turns', async () => {
    h.ctx.speakers!.set(h.session, { [video.id]: { count: 400, runs: RUNS } })
    const r = await call(client, 'get_transcript')
    expect(r.isError).toBe(false)
    expect(r.json.speakers).toEqual([
      [0, 'Alice'],
      [2, 'Speaker 2'],
      [5, 'spk_7'],
    ])
    expect(r.json.speakersNote).toBe('[firstWordIndex, speaker] — each run holds until the next entry.')
    // Segments break on a speaker change.
    const seg = await call(client, 'get_transcript', { granularity: 'segments' })
    expect(seg.json.clips[0].segments.map((s: unknown[]) => s[1])).toEqual(['Hello there.', 'How are you?', 'Fine thanks.'])
    expect(identifyCalls).toEqual([])
  })

  it('drops a removed speaker from the labels', async () => {
    h.ctx.speakers!.set(h.session, { [video.id]: { count: 400, runs: RUNS } })
    h.ctx.speakers!.removeSpeaker(h.session, 2)
    const r = await call(client, 'get_transcript')
    expect(r.json.speakers).toEqual([
      [0, 'Alice'],
      [2, null],
      [5, 'spk_7'],
    ])
  })

  it('falls back to a cache-only clustering when Identify has not run', async () => {
    fallbackMasks = { [video.id]: { count: 400, runs: [[0, cells(3.2), 4]] } }
    const r = await call(client, 'get_transcript')
    expect(identifyCalls).toHaveLength(1)
    expect(identifyCalls[0].cacheOnly).toBe(true)
    expect(identifyCalls[0].files.map((f) => f.mediaRef)).toEqual([video.id])
    expect(r.json.speakers).toEqual([
      [0, 'Speaker 4'],
      [5, 'spk_7'],
    ])
  })

  it('has no speakers when nothing is identified and words carry no labels', async () => {
    h.ctx.transcription = { transcribe: async () => ({ ...SPEECH, words: SPEECH.words.slice(0, 5) }) } as unknown as TranscriptionService
    const r = await call(client, 'get_transcript')
    expect(r.json.speakers).toBeUndefined()
  })
})
