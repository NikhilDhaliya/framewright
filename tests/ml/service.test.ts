/**
 * TranscriptionService (spec 07 §1.3–1.6) with a fake `whisper-cli` script and pre-installed model dirs: cache
 * semantics, locale resolution, ranged offsets, censoring, extraction errors, install errors, cancellation, and the
 * BYOK cloud path against a local fake server. No network, no real keys.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { TranscriptionError } from '../../src/core/captions/transcript'
import { ffmpegPath } from '../../src/main/media/ffmpeg'
import { MANIFESTS } from '../../src/main/ml/manifests'
import { ModelManager } from '../../src/main/ml/models'
import { TranscriptCache } from '../../src/main/ml/transcribe/cache'
import { TranscriptionService } from '../../src/main/ml/transcribe/service'
import type { TranscriptionSettings } from '../../src/shared/api'

const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-stt-service-'))
const root = path.join(tmp, 'Models')
const log = path.join(tmp, 'whisper.log')
const speech = path.join(tmp, 'speech.wav')
const silentVideo = path.join(tmp, 'silent.mp4')
let server: http.Server
let base = ''
let cloudCalls = 0

const tok = (text: string, from: number, to: number) => ({ text, offsets: { from, to } })
const WHISPER_JSON = {
  result: { language: 'en' },
  transcription: [
    { text: ' Oh shit, hello there. How are you?', offsets: { from: 0, to: 3000 }, tokens: [tok(' Oh', 200, 400), tok(' shit', 400, 700), tok(',', 700, 750), tok(' hello', 900, 1200), tok(' there', 1200, 1500), tok('.', 1500, 1550), tok(' How', 2000, 2200), tok(' are', 2200, 2400), tok(' you', 2400, 2700), tok('?', 2700, 2750)] },
  ],
}

function install(id: keyof typeof MANIFESTS) {
  const m = MANIFESTS[id]
  const dir = path.join(root, m.dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ id, files: m.files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })) }))
  return dir
}

beforeAll(async () => {
  const binDir = install('whisper-cli')
  install('whisper-tiny-q5_1')
  const cli = path.join(binDir, 'whisper-bin-ubuntu-x64', 'whisper-cli')
  mkdirSync(path.dirname(cli), { recursive: true })
  writeFileSync(path.join(tmp, 'out.json'), JSON.stringify(WHISPER_JSON))
  writeFileSync(
    cli,
    `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -of) OF="$2"; shift;; -l) L="$2"; shift;; -f) F="$2"; shift;; esac; shift; done
echo "whisper_print_progress_callback: progress = 50%" >&2
echo "$L $(basename "$F")" >> "${log}"
if [ -n "$FAKE_WHISPER_SLEEP" ]; then sleep "$FAKE_WHISPER_SLEEP"; fi
if [ -n "$FAKE_WHISPER_FAIL" ]; then echo "error: failed to load model" >&2; exit 3; fi
cat "${path.join(tmp, 'out.json')}" > "$OF.json"
`,
    { mode: 0o755 },
  )
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '16000', '-ac', '1', speech])
  execFileSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silentVideo])
  server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      cloudCalls++
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ language_code: 'en', text: 'Cloud words.', words: [{ text: 'Cloud', start: 0.1, end: 0.4, type: 'word', speaker_id: 'speaker_0' }, { text: 'words.', start: 0.5, end: 0.9, type: 'word', speaker_id: 'speaker_0' }] }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise((r) => server.close(r))
  await fs.rm(tmp, { recursive: true, force: true })
})

let settings: { apiKeys: Record<string, string | undefined>; transcription?: TranscriptionSettings }
let system: string[]
let service: TranscriptionService

beforeEach(async () => {
  await fs.rm(log, { force: true })
  delete process.env.FAKE_WHISPER_SLEEP
  delete process.env.FAKE_WHISPER_FAIL
  settings = { apiKeys: {}, transcription: { localModel: 'tiny-q5_1' } }
  system = ['en-US']
  service = new TranscriptionService({
    models: new ModelManager({ root, retries: 0 }),
    cache: new TranscriptCache(path.join(tmp, `Transcripts-${Math.random()}`)),
    settings: () => settings,
    systemLanguages: () => system,
    fetch: (u, i) => fetch(u, i),
    cloudBaseUrl: base,
  })
})

const runs = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
const wordTexts = (r: { words: { text: string }[] }) => r.words.map((w) => w.text)

describe('TranscriptionService (local)', () => {
  it('transcribes the full file once, then serves windowed ranges from the cache', async () => {
    const progress: string[] = []
    const r = await service.transcribe({ file: speech, provider: 'local', onProgress: (p) => progress.push(`${p.phase}:${p.fraction}`) })
    expect(r.language).toBe('en-US')
    expect(wordTexts(r)).toEqual(['Oh', 'shit,', 'hello', 'there.', 'How', 'are', 'you?'])
    expect(r.segments.map((s) => s.text)).toEqual(['Oh shit, hello there.', 'How are you?'])
    expect(progress).toContain('transcribing:0.5')
    const windowed = await service.transcribe({ file: speech, provider: 'local', range: [1.9, 3] })
    expect(wordTexts(windowed)).toEqual(['How', 'are', 'you?'])
    expect(runs()).toHaveLength(1)
    expect(runs()[0]).toMatch(/^en framewright-stt-.*\.wav$/)
    expect(await service.cachedTranscript(speech)).not.toBeNull()
    expect(await service.hasCachedOnDisk(speech)).toBe(true)
  })

  it('a forced locale bypasses the cache and offsets a ranged run to source time', async () => {
    const r = await service.transcribe({ file: speech, provider: 'local', locale: 'de-AT', range: [1, 3] })
    expect(r.language).toBe('de-AT')
    expect(r.words[0]).toEqual({ text: 'Oh', start: 1.2, end: 1.4 })
    expect(runs()).toEqual([expect.stringMatching(/^de /)])
    expect(await service.cachedTranscript(speech)).toBeNull()
  })

  it('censors without caching', async () => {
    const r = await service.transcribe({ file: speech, provider: 'local', censorProfanity: true })
    expect(wordTexts(r)[1]).toBe('s***,')
    expect(r.text).toContain('s***,')
    expect(await service.cachedTranscript(speech)).toBeNull()
  })

  it('resolves Auto from the system languages, or detects with localAutoDetect', async () => {
    system = ['tlh', 'fr-CA']
    expect(service.resolveLocalLanguage()).toEqual({ code: 'fr', tag: 'fr-CA' })
    system = []
    expect(() => service.resolveLocalLanguage()).toThrow('On-device transcription is not available for und.')
    expect(() => service.resolveLocalLanguage('xx-YY')).toThrow(new TranscriptionError('unsupportedLocale', 'xx-YY'))
    settings.transcription = { localModel: 'tiny-q5_1', localAutoDetect: true }
    const r = await service.transcribe({ file: speech, provider: 'local' })
    expect(runs()[0]).toMatch(/^auto /)
    expect(r.language).toBe('en')
  })

  it('maps extraction, engine and install failures to the Mac errors', async () => {
    await expect(service.transcribe({ file: silentVideo, isVideo: true, provider: 'local' })).rejects.toThrow('Audio extraction failed: No audio track in silent.mp4')
    process.env.FAKE_WHISPER_FAIL = '1'
    await expect(service.transcribe({ file: speech, provider: 'local', locale: 'en' })).rejects.toThrow('Transcription failed: error: failed to load model')
    settings.transcription = { localModel: 'base' }
    const offline = new TranscriptionService({ models: new ModelManager({ root, retries: 0, manifests: { 'whisper-base': { ...MANIFESTS['whisper-base'], files: [{ ...MANIFESTS['whisper-base'].files[0], url: `${base}/missing` }] } }, fetch: () => Promise.resolve(new Response('nope', { status: 404 })) }), cache: new TranscriptCache(path.join(tmp, 'T2')), settings: () => settings, systemLanguages: () => system, fetch: (u, i) => fetch(u, i) })
    await expect(offline.transcribe({ file: speech, provider: 'local' })).rejects.toThrow('Could not install the on-device speech model: HTTP 404 downloading ggml-base.bin')
  })

  it('cancellation kills whisper and caches nothing', async () => {
    process.env.FAKE_WHISPER_SLEEP = '5'
    const ac = new AbortController()
    const started = Date.now()
    const p = service.transcribe({ file: speech, provider: 'local', signal: ac.signal })
    setTimeout(() => ac.abort(), 300)
    await expect(p).rejects.toThrow(/Abort/)
    expect(Date.now() - started).toBeLessThan(4000)
    expect(await service.cachedTranscript(speech)).toBeNull()
  })
})

describe('TranscriptionService (cloud)', () => {
  it('refuses without a key, then caches exactly the requested range under the cloud key', async () => {
    await expect(service.transcribe({ file: speech, provider: 'cloud' })).rejects.toThrow('Add a speech-to-text API key in Settings to use Cloud.')
    expect(service.cloudAvailable()).toBe(false)
    settings.apiKeys = { elevenlabs: 'test-key' }
    expect(service.cloudAvailable()).toBe(true)
    cloudCalls = 0
    const r = await service.transcribe({ file: speech, provider: 'cloud', range: [1, 3] })
    expect(r.words[0]).toEqual({ text: 'Cloud', start: 1.1, end: 1.4, speaker: 'speaker_0' })
    expect(r.segments[0].speaker).toBe('speaker_0')
    await service.transcribe({ file: speech, provider: 'cloud', range: [1, 3] })
    expect(cloudCalls).toBe(1)
    expect(await service.cachedCloudTranscript(speech, [1, 3], null)).toEqual(r)
    expect(await service.cachedCloudTranscript(speech, [1, 3], 'de')).toBeNull()
    expect(await service.cachedTranscript(speech)).toBeNull()
  })
})
