/**
 * One REAL local transcription (spec 07 §1.5): downloads the whisper.cpp v1.9.5 binary (10.4 MB) and the 32 MB
 * `tiny-q5_1` model through the model manager into a temp XDG data dir, synthesizes speech offline with FFmpeg's
 * `flite` source filter (system /usr/bin/ffmpeg), transcribes, and checks word timings.
 *
 * Opt-in (network + ~42 MB): PALMIER_REAL_WHISPER=1 npx vitest run tests/ml/realWhisper.test.ts
 * PALMIER_TEST_MODELS_ROOT=<dir> reuses/keeps the downloads.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { TranscriptionProgress } from '../../src/shared/api'
import { ModelManager } from '../../src/main/ml/models'
import { TranscriptCache } from '../../src/main/ml/transcribe/cache'
import { TranscriptionService } from '../../src/main/ml/transcribe/service'

const enabled = process.env.PALMIER_REAL_WHISPER === '1'
const SYSTEM_FFMPEG = '/usr/bin/ffmpeg'
const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-real-whisper-'))
afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

const SENTENCES = 'Hello world. This is a test of the caption system. We are generating subtitles for a video.'

describe.skipIf(!enabled)('real whisper.cpp transcription', () => {
  const root = process.env.PALMIER_TEST_MODELS_ROOT ?? path.join(tmp, 'xdg-data', 'palmier-pro', 'Models')
  const models = new ModelManager({ root })
  const settings = { apiKeys: {}, transcription: { localModel: 'tiny-q5_1' } }
  const service = new TranscriptionService({ models, cache: new TranscriptCache(path.join(tmp, 'Transcripts')), settings: () => settings, systemLanguages: () => ['en-US'], fetch: (u, i) => fetch(u, i) })
  const video = path.join(tmp, 'speech.mp4')

  it('synthesizes speech into a video with an audio track', () => {
    expect(existsSync(SYSTEM_FFMPEG)).toBe(true)
    execFileSync(SYSTEM_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x334455:s=320x180:r=30', '-f', 'lavfi', '-i', `flite=text='${SENTENCES}':voice=slt`, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video])
    expect(existsSync(video)).toBe(true)
  })

  it('downloads the engine on first use and transcribes with sane word timings', async () => {
    const progress: TranscriptionProgress[] = []
    const started = Date.now()
    const r = await service.transcribe({ file: video, isVideo: true, provider: 'local', onProgress: (p) => progress.push(p) })
    const elapsed = Date.now() - started
    console.log(`[real-whisper] ${elapsed} ms, ${r.words.length} words, language=${r.language}: ${r.text}`)
    console.log(`[real-whisper] words: ${r.words.map((w) => `${w.text}@${w.start?.toFixed(2)}-${w.end?.toFixed(2)}`).join(' ')}`)
    expect(models.isInstalled('whisper-cli')).toBe(true)
    expect(models.isInstalled('whisper-tiny-q5_1')).toBe(true)
    expect(r.language).toBe('en-US')
    const text = r.text.toLowerCase()
    for (const w of ['hello', 'world', 'test', 'caption', 'subtitles', 'video']) expect(text).toContain(w)
    expect(r.words.length).toBeGreaterThanOrEqual(15)
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]).toString())
    let prevStart = 0
    for (const w of r.words) {
      expect(w.start).toBeGreaterThanOrEqual(0)
      expect(w.end!).toBeGreaterThan(w.start!)
      expect(w.end! - w.start!).toBeLessThan(2)
      expect(w.start!).toBeGreaterThanOrEqual(prevStart - 0.05)
      expect(w.start!).toBeLessThan(duration + 0.5)
      prevStart = w.start!
    }
    const hello = r.words.find((w) => /hello/i.test(w.text))!
    const video_ = r.words.find((w) => /video/i.test(w.text))!
    expect(hello.start!).toBeLessThan(1)
    expect(video_.start!).toBeGreaterThan(duration * 0.6)
    expect(r.segments.length).toBeGreaterThanOrEqual(1)
    const phases = new Set(progress.map((p) => p.phase))
    expect(phases.has('transcribing')).toBe(true)
    if (!process.env.PALMIER_TEST_MODELS_ROOT) expect(phases.has('downloading')).toBe(true)
  }, 600_000)

  it('serves the second request from the cache, windowed to a range', async () => {
    const started = Date.now()
    const r = await service.transcribe({ file: video, isVideo: true, provider: 'local', range: [2, 4] })
    expect(Date.now() - started).toBeLessThan(500)
    expect(r.words.length).toBeGreaterThan(0)
    expect(r.words.every((w) => w.end! > 2 && w.start! < 4)).toBe(true)
    expect(await service.cachedTranscript(video)).not.toBeNull()
  })

  it('a forced locale bypasses the cache and offsets a ranged transcription to source time', async () => {
    const r = await service.transcribe({ file: video, isVideo: true, provider: 'local', locale: 'en', range: [2, 6] })
    expect(r.language).toBe('en')
    expect(r.words.length).toBeGreaterThan(3)
    expect(r.words.every((w) => w.start! >= 2 - 0.01)).toBe(true)
    // tiny model starting mid-sentence: "generating sub-titles for the video"
    expect(r.text.toLowerCase()).toContain('generating')
  }, 120_000)

  it('censors profanity when asked', async () => {
    const swear = path.join(tmp, 'swear.wav')
    execFileSync(SYSTEM_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `flite=text='Oh shit, that was a bad take.':voice=slt`, '-ar', '16000', '-ac', '1', swear])
    const r = await service.transcribe({ file: swear, provider: 'local', censorProfanity: true })
    console.log(`[real-whisper] censored: ${r.text}`)
    expect(r.text.toLowerCase()).not.toContain('shit')
  }, 120_000)
})
