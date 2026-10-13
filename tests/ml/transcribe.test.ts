/** whisper JSON parser, cache keys/cache, profanity mask, cloud adapters (local fake HTTP server — never real keys). */
import { createHash } from 'node:crypto'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cacheKey, cloudCacheKey, fileIdentity, localCacheKey, TranscriptCache } from '../../src/main/ml/transcribe/cache'
import { resolveCloudProvider } from '../../src/main/ml/transcribe/cloud'
import { elevenlabs } from '../../src/main/ml/transcribe/cloud/elevenlabs'
import { openai, silenceSplitPoints } from '../../src/main/ml/transcribe/cloud/openai'
import { groupWordsIntoSegments } from '../../src/main/ml/transcribe/cloud/types'
import { readWav16, writeWav16 } from '../../src/main/ml/transcribe/audio'
import { censorTranscript } from '../../src/main/ml/transcribe/profanity'
import { fromWhisper, parseWhisperProgress } from '../../src/main/ml/transcribe/whisperParse'
import { Semaphore, JobRegistry } from '../../src/main/ml/jobs'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-stt-test-'))
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

const tok = (text: string, from?: number, to?: number) => (from === undefined ? { text } : { text, offsets: { from, to } })

describe('fromWhisper', () => {
  // Observed with tiny.en on jfk.wav (spec 07 §1.5) and with tiny-q5_1 on flite speech in this repo.
  const jfk = {
    result: { language: 'en' },
    transcription: [
      {
        text: ' And so my fellow Americans, ask not',
        offsets: { from: 0, to: 7960 },
        tokens: [tok('[_BEG_]', 0, 0), tok(' And', 320, 400), tok(' so', 400, 520), tok(' my', 690, 940), tok(' fellow', 940, 1750), tok(' Americans', 1750, 2200), tok(',', 2200, 2300), tok(' ask', 3000, 3200), tok(' not', 3200, 3500), tok('[_TT_398]', 7960, 7960)],
      },
      { text: ' what your country can do for you.', offsets: { from: 7960, to: 10760 }, tokens: [tok(' what', 8000, 8200), tok(' your', 8200, 8400), tok(' country', 8400, 8900), tok(' can', 8900, 9100), tok(' do', 9100, 9300), tok(' for', 9300, 9500), tok(' you', 9500, 9800), tok('.', 9800, 10000)] },
    ],
  }
  it('maps tokens to words, filtering specials and attaching punctuation', () => {
    const r = fromWhisper(jfk)
    expect(r.language).toBe('en')
    expect(r.text).toBe('And so my fellow Americans, ask not what your country can do for you.')
    expect(r.segments).toEqual([
      { text: 'And so my fellow Americans, ask not', start: 0, end: 7.96 },
      { text: 'what your country can do for you.', start: 7.96, end: 10.76 },
    ])
    expect(r.words.slice(0, 5)).toEqual([
      { text: 'And', start: 0.32, end: 0.4 },
      { text: 'so', start: 0.4, end: 0.52 },
      { text: 'my', start: 0.69, end: 0.94 },
      { text: 'fellow', start: 0.94, end: 1.75 },
      { text: 'Americans,', start: 1.75, end: 2.3 },
    ])
    expect(r.words.at(-1)).toEqual({ text: 'you.', start: 9.5, end: 10 })
    expect(r.words).toHaveLength(14)
  })
  it('prefers the chosen BCP-47 tag over the detected code', () => {
    expect(fromWhisper(jfk, 'en-GB').language).toBe('en-GB')
  })
  it('inherits the previous end for tokens without offsets, clamps to the segment and enforces 10 ms', () => {
    const r = fromWhisper({ transcription: [{ text: ' Hi there', offsets: { from: 1000, to: 2000 }, tokens: [tok(' Hi', 900, 1200), tok(' the'), tok('re', 1500, 2600), tok(' x', 1700, 1700)] }] })
    expect(r.words).toEqual([
      { text: 'Hi', start: 1, end: 1.2 },
      { text: 'there', start: 1.2, end: 2 },
      { text: 'x', start: 1.7, end: 1.71 },
    ])
  })
  it('starts a word at every token for unspaced languages', () => {
    const r = fromWhisper({ result: { language: 'ja' }, transcription: [{ text: 'こんにちは世界', offsets: { from: 0, to: 1000 }, tokens: [tok('こんにちは', 0, 600), tok('世界', 600, 1000)] }] })
    expect(r.words.map((w) => w.text)).toEqual(['こんにちは', '世界'])
  })
  it('splits a decoding window into sentence-level segments', () => {
    const r = fromWhisper({
      transcription: [
        { text: ' Hello world! This is a test. Bye', offsets: { from: 0, to: 7000 }, tokens: [tok(' Hello', 250, 350), tok(' world', 350, 700), tok('!', 700, 910), tok(' This', 910, 1190), tok(' is', 1190, 1320), tok(' a', 1330, 1400), tok(' test', 1400, 1680), tok('.', 1680, 1780), tok(' Bye', 3000, 3300)] },
      ],
    })
    expect(r.segments).toEqual([
      { text: 'Hello world!', start: 0, end: 0.91 },
      { text: 'This is a test.', start: 0.91, end: 1.78 },
      { text: 'Bye', start: 3, end: 7 },
    ])
    expect(r.text).toBe('Hello world! This is a test. Bye')
  })
  it('drops whole-segment non-speech annotations', () => {
    const r = fromWhisper({ transcription: [{ text: ' [BLANK_AUDIO]', offsets: { from: 0, to: 1000 }, tokens: [tok(' [', 0, 100), tok('BL', 100, 200), tok('ANK_AUDIO]', 200, 300)] }] })
    expect(r).toEqual({ text: '', words: [], segments: [] })
  })
  it('rejects malformed JSON as decodeFailed', () => {
    expect(() => fromWhisper({})).toThrow('Could not parse transcription result.')
  })
  it('parses progress lines', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =  45%')).toBe(0.45)
    expect(parseWhisperProgress('output_json: saving')).toBeNull()
  })
})

describe('transcript cache', () => {
  it('keys follow the Mac identity format (+ model id for local)', () => {
    const f = path.join(tmp, 'clip.wav')
    writeFileSync(f, 'abc')
    utimesSync(f, 1_700_000_000, 1_700_000_000)
    expect(fileIdentity(f)).toBe(`${f}|1700000000.0|3`)
    const sha32 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32)
    expect(localCacheKey(f, 'whisper-base')).toBe(sha32(`local|whisper-base|${f}|1700000000.0|3`))
    expect(localCacheKey(f, 'whisper-small')).not.toBe(localCacheKey(f, 'whisper-base'))
    expect(cloudCacheKey(f, null, null)).toBe(sha32(`cloud|auto|full|${f}|1700000000.0|3`))
    expect(cloudCacheKey(f, [1, 2.5], 'en')).toBe(sha32(`cloud|en|1.000...2.500|${f}|1700000000.0|3`))
    expect(cacheKey('x')).toHaveLength(32)
    expect(localCacheKey(path.join(tmp, 'missing.wav'), 'm')).toBeNull()
    utimesSync(f, 1_700_000_000.5, 1_700_000_000.5)
    expect(fileIdentity(f)).toBe(`${f}|1700000000.5|3`)
  })
  it('reads and writes JSON atomically with a 4-entry memory that clears when full', async () => {
    const dir = path.join(tmp, 'Transcripts')
    const cache = new TranscriptCache(dir)
    const r = (t: string) => ({ text: t, words: [], segments: [] })
    for (const k of ['a', 'b', 'c', 'd', 'e']) await cache.write(k, r(k))
    expect((await fs.readdir(dir)).sort()).toEqual(['a.json', 'b.json', 'c.json', 'd.json', 'e.json'])
    expect(JSON.parse(await fs.readFile(path.join(dir, 'a.json'), 'utf8'))).toEqual({ text: 'a', words: [], segments: [] })
    await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify(r('changed on disk')))
    expect((await cache.read('a'))?.text).toBe('changed on disk')
    expect(await cache.read('zzz')).toBeNull()
    expect(await cache.has('e')).toBe(true)
    await fs.writeFile(path.join(dir, 'bad.json'), '{oops')
    expect(await cache.read('bad')).toBeNull()
    await cache.clear()
    expect(await cache.has('e')).toBe(false)
  })
})

describe('censor profanity', () => {
  it('masks listed words keeping the first letter and punctuation', () => {
    const r = censorTranscript({ text: 'Well, shit happens. Bullshit!', language: 'en-US', words: [{ text: 'shit', start: 0, end: 1 }, { text: 'Bullshit!' }], segments: [{ text: 'Well, shit happens.', start: 0, end: 1 }] })
    expect(r.text).toBe('Well, s*** happens. B*******!')
    expect(r.words.map((w) => w.text)).toEqual(['s***', 'B*******!'])
    expect(r.segments[0].text).toBe('Well, s*** happens.')
    const ja = { text: 'shit', language: 'ja', words: [], segments: [] }
    expect(censorTranscript(ja)).toBe(ja)
  })
})

describe('jobs', () => {
  it('semaphore limits concurrency and lets queued waiters abort', async () => {
    const gate = new Semaphore(1)
    const order: string[] = []
    let release!: () => void
    const first = gate.run(() => new Promise<void>((r) => (release = () => (order.push('first'), r()))))
    const ac = new AbortController()
    const aborted = gate.run(async () => order.push('aborted'), ac.signal)
    const second = gate.run(async () => order.push('second'))
    ac.abort()
    await expect(aborted).rejects.toThrow(/Abort/)
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first', 'second'])
  })
  it('registry cancels by id and refuses jobs after shutdown', async () => {
    const jobs = new JobRegistry()
    const p = jobs.run('j1', (signal) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))))
    jobs.cancel('j1')
    await expect(p).rejects.toThrow(/Abort/)
    await jobs.shutdown(10)
    await expect(jobs.run('j2', async () => 1)).rejects.toThrow('quitting')
  })
})

// ---------- Cloud adapters against a fake server ----------

let server: http.Server
let base = ''
const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = []
let openaiCalls = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1')
      seen.push({ url: req.url ?? '', headers: req.headers, body })
      res.setHeader('content-type', 'application/json')
      if (req.headers['xi-api-key'] === 'bad' || req.headers.authorization === 'Bearer bad') {
        res.statusCode = 401
        return res.end(JSON.stringify({ detail: { message: 'Invalid API key' } }))
      }
      if (req.url === '/v1/speech-to-text') {
        return res.end(
          JSON.stringify({
            language_code: 'en',
            text: 'Hello there. How are you?',
            words: [
              { text: 'Hello', start: 0.1, end: 0.4, type: 'word', speaker_id: 'speaker_0' },
              { text: ' ', start: 0.4, end: 0.5, type: 'spacing', speaker_id: 'speaker_0' },
              { text: 'there.', start: 0.5, end: 0.9, type: 'word', speaker_id: 'speaker_0' },
              { text: '(laughs)', start: 0.9, end: 1.2, type: 'audio_event', speaker_id: 'speaker_0' },
              { text: 'How', start: 1.3, end: 1.5, type: 'word', speaker_id: 'speaker_1' },
              { text: 'are', start: 1.5, end: 1.6, type: 'word', speaker_id: 'speaker_1' },
              { text: 'you?', start: 1.6, end: 1.9, type: 'word', speaker_id: 'speaker_1' },
            ],
          }),
        )
      }
      if (req.url === '/v1/audio/transcriptions') {
        openaiCalls++
        return res.end(
          JSON.stringify({
            language: 'english',
            text: ` part ${openaiCalls}`,
            words: [{ word: `part${openaiCalls}`, start: 0.5, end: 1 }],
            segments: [{ text: ` part ${openaiCalls}`, start: 0.5, end: 1 }],
          }),
        )
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise((r) => server.close(r)))

async function wav(seconds: number, name = 'a.wav'): Promise<string> {
  const rate = 16000
  const samples = new Int16Array(seconds * rate)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8000 * Math.sin(i / 10))
  const f = path.join(tmp, name)
  await writeWav16(f, { sampleRate: rate, samples })
  return f
}

describe('cloud adapters', () => {
  it('ElevenLabs Scribe: multipart fields, words, speakers and grouped segments', async () => {
    const f = await wav(1)
    seen.length = 0
    const r = await elevenlabs.transcribe({ wavPath: f, apiKey: 'k-test', fetch: (u, i) => fetch(u, i), baseUrl: base })
    expect(seen[0].headers['xi-api-key']).toBe('k-test')
    for (const field of ['model_id', 'diarize', 'timestamps_granularity', 'tag_audio_events', 'file']) expect(seen[0].body).toContain(`name="${field}"`)
    expect(seen[0].body).toContain('scribe_v2')
    expect(seen[0].body).not.toContain('name="language_code"')
    expect(r.language).toBe('en')
    expect(r.words).toEqual([
      { text: 'Hello', start: 0.1, end: 0.4, speaker: 'speaker_0' },
      { text: 'there.', start: 0.5, end: 0.9, speaker: 'speaker_0' },
      { text: 'How', start: 1.3, end: 1.5, speaker: 'speaker_1' },
      { text: 'are', start: 1.5, end: 1.6, speaker: 'speaker_1' },
      { text: 'you?', start: 1.6, end: 1.9, speaker: 'speaker_1' },
    ])
    expect(r.segments).toEqual([
      { text: 'Hello there.', start: 0.1, end: 0.9, speaker: 'speaker_0' },
      { text: 'How are you?', start: 1.3, end: 1.9, speaker: 'speaker_1' },
    ])
    await elevenlabs.transcribe({ wavPath: f, apiKey: 'k', language: 'de', fetch: (u, i) => fetch(u, i), baseUrl: base })
    expect(seen[1].body).toMatch(/name="language_code"\r\n\r\nde/)
  })
  it('reports a rejected key', async () => {
    const f = await wav(1)
    await expect(elevenlabs.transcribe({ wavPath: f, apiKey: 'bad', fetch: (u, i) => fetch(u, i), baseUrl: base })).rejects.toThrow('ElevenLabs: the API key was rejected')
    await expect(openai.transcribe({ wavPath: f, apiKey: 'bad', fetch: (u, i) => fetch(u, i), baseUrl: base })).rejects.toThrow('OpenAI: the API key was rejected')
  })
  it('OpenAI whisper-1: verbose_json with word and segment granularities', async () => {
    const f = await wav(1)
    seen.length = 0
    openaiCalls = 0
    const r = await openai.transcribe({ wavPath: f, apiKey: 'sk-test', fetch: (u, i) => fetch(u, i), baseUrl: base })
    expect(seen[0].headers.authorization).toBe('Bearer sk-test')
    expect(seen[0].body).toContain('whisper-1')
    expect(seen[0].body).toContain('verbose_json')
    expect(seen[0].body.match(/timestamp_granularities\[\]/g)).toHaveLength(2)
    expect(r).toEqual({ text: 'part 1', language: 'en', words: [{ text: 'part1', start: 0.5, end: 1 }], segments: [{ text: 'part 1', start: 0.5, end: 1 }] })
  })
  it('OpenAI splits audio over 25 MB at silences and offsets each part', async () => {
    const rate = 16000
    const seconds = 900
    const samples = new Int16Array(seconds * rate)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(8000 * Math.sin(i / 7))
    // A silent stretch at 590–590.5 s is the best split point before the 600 s hard limit.
    samples.fill(0, 590 * rate, 590.5 * rate)
    const f = path.join(tmp, 'long.wav')
    await writeWav16(f, { sampleRate: rate, samples })
    const pcm = await readWav16(f)
    const points = silenceSplitPoints(pcm)
    expect(points).toHaveLength(1)
    expect(points[0] / rate).toBeGreaterThanOrEqual(590)
    expect(points[0] / rate).toBeLessThanOrEqual(590.5)
    openaiCalls = 0
    const r = await openai.transcribe({ wavPath: f, apiKey: 'sk', fetch: (u, i) => fetch(u, i), baseUrl: base })
    expect(openaiCalls).toBe(2)
    expect(r.text).toBe('part 1 part 2')
    expect(r.words[0].start).toBe(0.5)
    expect(r.words[1].start).toBeCloseTo(points[0] / rate + 0.5, 3)
  }, 30_000)
  it('groups words on speaker changes, sentence ends and 1.5 s gaps', () => {
    const segs = groupWordsIntoSegments([
      { text: 'a', start: 0, end: 0.2, speaker: 's0' },
      { text: 'b', start: 2, end: 2.2, speaker: 's0' },
      { text: 'c.', start: 2.3, end: 2.5, speaker: 's0' },
      { text: 'd', start: 2.6, end: 2.8, speaker: 's0' },
      { text: 'e', start: 2.9, end: 3, speaker: 's1' },
    ])
    expect(segs.map((s) => s.text)).toEqual(['a', 'b c.', 'd', 'e'])
  })
  it('resolves the provider from configured keys, preferring the chosen one', () => {
    expect(resolveCloudProvider({ apiKeys: {} })).toBeNull()
    expect(resolveCloudProvider({ apiKeys: { openai: 'x' } })?.provider.id).toBe('openai')
    expect(resolveCloudProvider({ apiKeys: { openai: 'x', elevenlabs: 'y' } })?.provider.id).toBe('elevenlabs')
    expect(resolveCloudProvider({ apiKeys: { openai: 'x', elevenlabs: 'y' }, transcription: { cloudProvider: 'openai' } })?.provider.id).toBe('openai')
  })
})
