/**
 * REAL model runs on synthesized audio (spec 07 §3): bundled Silero VAD v5.1.2 and Beat This small0 ONNX through
 * onnxruntime-node, the shared decoders, the disk caches, and envelope-based sync on offset copies of one file.
 * Speech comes from the system FFmpeg's `flite` filter (skipped when unavailable); clicks come from `aevalsrc`.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { maxLagHops, seededCorrelate } from '../../src/core/audio/correlator'
import { maskFromRuns } from '../../src/core/audio/vad'
import { removableMask, DEFAULT_SILENCE_SETTINGS } from '../../src/core/audio/deadAir'
import { ffmpegPath } from '../../src/main/media/ffmpeg'
import { AudioAnalysisService } from '../../src/main/ml/audio/service'
import { releaseSessions } from '../../src/main/ml/audio/onnx'

const SYSTEM_FFMPEG = '/usr/bin/ffmpeg'
const hasFlite = (() => {
  try {
    return existsSync(SYSTEM_FFMPEG) && execFileSync(SYSTEM_FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' }).includes('flite')
  } catch {
    return false
  }
})()
const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-audio-models-'))
afterAll(async () => {
  await releaseSessions()
  await fs.rm(tmp, { recursive: true, force: true })
})

const ff = (bin: string, args: string[]) => execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args])

/** speech (≈2.5 s) · 3 s near-silence · speech · 2 s near-silence · speech, 16-bit 44.1 kHz stereo. */
function speechFixture(file: string): void {
  const say = (t: string) => `flite=text='${t}':voice=slt,aresample=44100,pan=stereo|c0=c0|c1=c0`
  const quiet = (d: number) => `anoisesrc=d=${d}:c=pink:r=44100:a=0.0005,pan=stereo|c0=c0|c1=c0`
  const g = [
    `${say('Welcome back to the show. Today we talk about editing.')}[a]`,
    `${quiet(3)}[b]`,
    `${say('Silence is where the story breathes.')}[c]`,
    `${quiet(2)}[d]`,
    `${say('Thanks for watching, see you next time.')}[e]`,
    '[a][b][c][d][e]concat=n=5:v=0:a=1[out]',
  ].join(';')
  ff(SYSTEM_FFMPEG, ['-filter_complex', g, '-map', '[out]', '-c:a', 'pcm_s16le', file])
}

describe.skipIf(!hasFlite)('real audio models', () => {
  const service = new AudioAnalysisService({ cacheRoot: path.join(tmp, 'cache') })
  const speech = path.join(tmp, 'speech.wav')

  it('Silero VAD finds the three spoken phrases; dead air covers the two pauses', async () => {
    speechFixture(speech)
    const t0 = Date.now()
    const a = await service.speech('ref1', speech)
    const elapsed = Date.now() - t0
    expect(a.segments.length).toBeGreaterThanOrEqual(3)
    expect(a.chunkCount).toBeGreaterThan(200)
    const quiet = maskFromRuns(a.quiet.runs, a.quiet.count)
    const removable = removableMask(quiet, DEFAULT_SILENCE_SETTINGS)
    const runs: [number, number][] = []
    for (let i = 0; i < removable.length; ) {
      if (!removable[i]) {
        i++
        continue
      }
      let j = i
      while (j < removable.length && removable[j]) j++
      runs.push([i * 0.032, j * 0.032])
      i = j
    }
    expect(runs.length).toBe(2)
    // Pauses are 3 s and 2 s minus 2 × 0.15 s padding (± a VAD cell or two).
    expect(runs[0][1] - runs[0][0]).toBeGreaterThan(2.3)
    expect(runs[1][1] - runs[1][0]).toBeGreaterThan(1.3)
    // Cache files written with the Mac naming; a second call is a cache hit.
    const names = await fs.readdir(service.dirs.analysis)
    expect(names.some((n) => /^ref1_\d+_\d+_vad\.json$/.test(n))).toBe(true)
    const fresh = new AudioAnalysisService({ cacheRoot: path.join(tmp, 'cache') })
    expect(await fresh.cachedSpeech('ref1', speech)).toEqual(a)
    console.info(`[audio] VAD over ${(a.chunkCount * 0.032).toFixed(1)} s took ${elapsed} ms`)
  }, 60_000)

  it('no audio track → empty activity', async () => {
    const silentVideo = path.join(tmp, 'novideo.mp4')
    ff(ffmpegPath, ['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=10:d=1', '-c:v', 'mpeg4', silentVideo])
    const a = await service.speech('ref-nv', silentVideo)
    expect(a).toEqual({ chunkCount: 0, segments: [], quiet: { count: 0, runs: [] } })
  })

  it('Beat This finds 120 BPM in a click track (accented downbeats)', async () => {
    const clicks = path.join(tmp, 'clicks.wav')
    // 20 s at 120 BPM: 1 kHz clicks, every 4th at 1.5 kHz and louder.
    const expr = "if(lt(mod(t,0.5),0.05),exp(-mod(t,0.5)/0.01)*if(lt(mod(t,2),0.05),0.9*sin(2*PI*1500*t),0.5*sin(2*PI*1000*t)),0)"
    ff(ffmpegPath, ['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=20`, '-c:a', 'pcm_s16le', clicks])
    const a = await service.beats('clicks', clicks)
    expect(Math.round(a.bpm)).toBe(120)
    expect(a.beats.length).toBeGreaterThanOrEqual(36)
    expect(a.beats.length).toBeLessThanOrEqual(41)
    for (const b of a.beats.slice(1, -1)) expect(Math.abs(b * 2 - Math.round(b * 2))).toBeLessThan(0.05)
    expect(a.downbeats.length).toBeGreaterThan(0)
    expect(await service.cachedBeats('clicks', clicks)).toEqual(a)
  }, 120_000)

  it('envelope sync recovers a 4.25 s offset between two cuts of the same recording', async () => {
    const a = path.join(tmp, 'camA.wav')
    const b = path.join(tmp, 'camB.wav')
    ff(SYSTEM_FFMPEG, ['-i', speech, '-af', 'adelay=4250|4250,apad=pad_dur=1', a])
    ff(SYSTEM_FFMPEG, ['-i', speech, '-af', 'volume=0.6', '-ac', '1', '-ar', '48000', b])
    const ea = (await service.envelope(a, 0, 540))!
    const eb = (await service.envelope(b, 0, 540))!
    const r = seededCorrelate({ reference: ea, target: eb, seedHops: null, seedWindowHops: 1200, maxLagHops: maxLagHops(240, 0.0025, ea.length, eb.length), minOverlapHops: 1200, minConfidence: 0.5 })!
    expect(r).not.toBeNull()
    expect(Math.abs(r.lagHops * 0.0025 - 4.25)).toBeLessThan(0.01)
    expect(r.confidence).toBeGreaterThan(0.9)
  }, 60_000)
})
