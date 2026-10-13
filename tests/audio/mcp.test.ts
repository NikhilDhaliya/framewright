/**
 * Audio agent tools through the real MCP server (02 §3.28/3.29/3.35/3.36/3.43) with the real analysis service,
 * bundled models and synthesized media; results are verified on `session.doc`.
 */
import '../mcp/env'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newClip, newTrack, type MediaManifestEntry } from '../../src/core/model'
import { activeTimeline } from '../../src/core/ops/context'
import { ffmpegPath } from '../../src/main/media/ffmpeg'
import { probeAudio } from '../../src/main/ml/audio/decode'
import { DenoiseService } from '../../src/main/ml/audio/denoise'
import { releaseSessions } from '../../src/main/ml/audio/onnx'
import { AudioAnalysisService } from '../../src/main/ml/audio/service'
import { audioEntry, call, connect, startHarness, videoEntry, type Harness } from '../mcp/harness'

const SYSTEM_FFMPEG = '/usr/bin/ffmpeg'
const hasFlite = (() => {
  try {
    return existsSync(SYSTEM_FFMPEG) && execFileSync(SYSTEM_FFMPEG, ['-hide_banner', '-filters'], { encoding: 'utf8' }).includes('flite')
  } catch {
    return false
  }
})()
const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-audio-mcp-'))
const ff = (bin: string, args: string[]) => execFileSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
const files = { speech: path.join(tmp, 'speech.wav'), camA: path.join(tmp, 'camA.mp4'), camB: path.join(tmp, 'camB.wav'), clicks: path.join(tmp, 'clicks.wav'), noisy: path.join(tmp, 'noisy.wav') }

const entries: Record<string, MediaManifestEntry> = {}
const ext = (p: string) => ({ external: { absolutePath: p } })

beforeAll(async () => {
  if (!hasFlite) return
  const say = (t: string) => `flite=text='${t}':voice=slt,aresample=44100`
  const quiet = (d: number) => `anoisesrc=d=${d}:c=pink:r=44100:a=0.0005`
  ff(SYSTEM_FFMPEG, ['-filter_complex', `${say('Welcome back to the show. Today we talk about editing.')}[a];${quiet(3)}[b];${say('Silence is where the story breathes.')}[c];${quiet(2)}[d];${say('Thanks for watching, see you next time.')}[e];[a][b][c][d][e]concat=n=5:v=0:a=1[out]`, '-map', '[out]', '-c:a', 'pcm_s16le', files.speech])
  ff(SYSTEM_FFMPEG, ['-f', 'lavfi', '-i', 'color=c=0x335577:s=320x180:r=30', '-i', files.speech, '-filter_complex', '[1:a]adelay=4250|4250,apad=pad_dur=1[a]', '-map', '0:v', '-map', '[a]', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', files.camA])
  ff(SYSTEM_FFMPEG, ['-i', files.speech, '-af', 'volume=0.6', '-ar', '48000', files.camB])
  const expr = 'if(lt(mod(t,0.5),0.05),exp(-mod(t,0.5)/0.01)*if(lt(mod(t,2),0.05),0.9*sin(2*PI*1500*t),0.5*sin(2*PI*1000*t)),0)'
  ff(ffmpegPath, ['-f', 'lavfi', '-i', `aevalsrc='${expr}':s=44100:d=12`, '-c:a', 'pcm_s16le', files.clicks])
  ff(SYSTEM_FFMPEG, ['-i', files.speech, '-f', 'lavfi', '-i', 'anoisesrc=c=white:a=0.05:r=44100', '-filter_complex', '[0][1]amix=inputs=2:duration=first', '-t', '4', files.noisy])
  for (const [k, f] of Object.entries(files)) {
    const info = await probeAudio(f)
    entries[k] = k === 'camA' ? videoEntry({ name: 'Cam A', source: ext(f), duration: info!.duration, hasAudio: true, sourceWidth: 320, sourceHeight: 180, sourceFPS: 30 }) : audioEntry({ name: k, source: ext(f), duration: info!.duration })
  }
}, 120_000)

afterAll(async () => {
  await releaseSessions()
  await fs.rm(tmp, { recursive: true, force: true })
})

let h: Harness
let client: Client
let audio: AudioAnalysisService
const timeline = () => activeTimeline(h.session.doc)

beforeEach(async () => {
  if (!hasFlite) return
  h = await startHarness(Object.values(entries))
  audio = new AudioAnalysisService({ cacheRoot: path.join(tmp, 'cache') })
  h.ctx.audio = audio
  h.ctx.denoise = new DenoiseService(path.join(tmp, 'cache'), audio.analysisLane)
  client = await connect(h.url)
})

afterEach(async () => {
  if (!hasFlite) return
  await client.close()
  await h.close()
})

/** Puts `refs` on their own audio tracks at the given starts (frames, 30 fps). */
function placeAudio(items: [MediaManifestEntry, number][]): string[] {
  const ids: string[] = []
  h.session.transact('place', (d) => {
    const t = activeTimeline(d)
    for (const [e, start] of items) {
      const c = newClip({ mediaRef: e.id, startFrame: start, durationFrames: Math.round(e.duration * t.fps), mediaType: 'audio', sourceClipType: 'audio' })
      t.tracks.push(newTrack('audio', { clips: [c] }))
      ids.push(c.id)
    }
  })
  return ids
}

describe.skipIf(!hasFlite)('audio MCP tools', () => {
  it('remove_silence ripple-deletes the two pauses (after background analysis)', async () => {
    const [clipId] = placeAudio([[entries.speech, 0]])
    const durBefore = timeline().tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!.durationFrames
    const first = await call(client, 'remove_silence', {})
    expect(first.isError).toBe(true)
    expect(first.text).toBe('No dead air on the timeline. Speech analysis may still be running, or the audio has no quiet non-speech sections.')
    await audio.speech(entries.speech.id, files.speech)
    const bad = await call(client, 'remove_silence', { minimumPauseSeconds: 5 })
    expect(bad.text).toBe('remove_silence: minimumPauseSeconds must be a finite number from 0.25 through 3.')
    const r = await call(client, 'remove_silence', { speechPaddingSeconds: 0.1 })
    expect(r.isError).toBe(false)
    expect(r.json).toMatchObject({ sectionsRemoved: 2, minimumPauseSeconds: 0.5, speechPaddingSeconds: 0.1 })
    const clips = timeline().tracks.flatMap((t) => t.clips)
    expect(clips).toHaveLength(3)
    const total = clips.reduce((n, c) => n + c.durationFrames, 0)
    expect(durBefore - total).toBe(r.json.removedFrames)
    // 3 s + 2 s pauses (plus flite's own lead-in/out silence) minus 0.1 s padding each side, at 30 fps.
    expect(r.json.removedFrames).toBeGreaterThan(130)
    expect(r.json.removedFrames).toBeLessThan(200)
    expect(clips[1].startFrame).toBe(clips[0].startFrame + clips[0].durationFrames)
  }, 60_000)

  it('detect_beats returns 120 BPM, windowing and validation', async () => {
    const r = await call(client, 'detect_beats', { mediaRef: entries.clicks.id })
    expect(r.json.bpm).toBe(120)
    expect(r.json.units).toBe('source seconds — multiply by fps for frame values')
    expect(r.json.beats.length).toBeGreaterThan(18)
    const w = await call(client, 'detect_beats', { mediaRef: entries.clicks.id, startSeconds: 4, endSeconds: 6 })
    expect(w.json.beats.every((b: number) => b >= 4 && b <= 6)).toBe(true)
    expect((await call(client, 'detect_beats', { mediaRef: entries.clicks.id, startSeconds: 8, endSeconds: 2 })).text).toMatch(/^Invalid time range \[8, 2\]/)
    expect((await call(client, 'detect_beats', { mediaRef: entries.speech.id, startSeconds: 0.01, endSeconds: 0.02 })).json).toEqual({ beats: [], note: expect.stringMatching(/^No beats/) })
  }, 120_000)

  it('sync_clips aligns a second recording by audio', async () => {
    const [ref, tgt] = placeAudio([
      [entries.camB, 60],
      [entries.speech, 600],
    ])
    expect((await call(client, 'sync_clips', { referenceClipId: ref })).text).toBe('sync_clips: provide targetClipId or targetClipIds.')
    const r = await call(client, 'sync_clips', { referenceClipId: ref, targetClipId: tgt, mode: 'audio' })
    expect(r.isError).toBe(false)
    expect(r.json.synced[0]).toMatchObject({ method: 'audio' })
    expect(r.json.synced[0].confidence).toBeGreaterThan(0.9)
    const moved = timeline().tracks.flatMap((t) => t.clips).find((c) => c.id === tgt)!
    expect(moved.startFrame).toBe(60)
    expect((await call(client, 'sync_clips', { referenceClipId: ref, targetClipId: tgt, mode: 'timecode' })).text).toBe('sync_clips: Reference has no source timecode.')
  }, 60_000)

  it('manage_multicam create syncs members by audio; change_cam/get_multicam work on the group', async () => {
    const r = await call(client, 'manage_multicam', { create: { members: [{ mediaRef: entries.camA.id, kind: 'both', angleLabel: 'Cam A' }, { mediaRef: entries.camB.id, kind: 'mic' }], name: 'Podcast' } })
    expect(r.isError).toBe(false)
    const created = r.json.created
    const rows = Object.fromEntries(created.members.map((m: { angleLabel: string }) => [m.angleLabel, m]))
    expect(rows['cam-a']).toMatchObject({ kind: 'both', offsetSeconds: 0 })
    expect(rows.camb).toMatchObject({ kind: 'mic', master: true })
    expect(Math.abs(rows.camb.offsetSeconds - 4.25)).toBeLessThan(0.01)
    expect(rows.camb.confidence).toBeGreaterThan(0.9)
    const g = h.session.doc.file.multicamGroups![0]
    expect(g.name).toBe('Podcast')
    const t = timeline()
    const stamped = t.tracks.flatMap((tr) => tr.clips).filter((c) => c.multicamGroupId === g.id)
    expect(stamped.map((c) => c.mediaType).sort()).toEqual(['audio', 'audio', 'video'])
    const mic = stamped.find((c) => c.mediaRef === entries.camB.id)!
    expect(mic.startFrame).toBe(Math.round(4.25 * 30))
    const read = await call(client, 'get_multicam', { groupId: g.id })
    expect(read.json.program[0][0]).toBe('cam-a')
    const wrong = await call(client, 'change_cam', { groupId: g.id, entries: [{ range: [0, 30], angle: 'camb' }] })
    expect(wrong.isError).toBe(true)
    const err = await call(client, 'manage_multicam', { create: { members: [{ mediaRef: entries.camA.id, kind: 'angle' }, { mediaRef: entries.camA.id, kind: 'mic' }] } })
    expect(err.text).toBe(`create.members[1]: duplicate mediaRef ${entries.camA.id.slice(0, 8)}`)
  }, 60_000)

  it('denoise_audio adds the effect and bakes a wet file aligned with the source', async () => {
    const [clipId] = placeAudio([[entries.noisy, 0]])
    expect((await call(client, 'denoise_audio', { clipIds: [clipId], strength: 2 })).text).toBe('strength must be 0–1 (got 2)')
    const r = await call(client, 'denoise_audio', { clipIds: [clipId], strength: 0.8 })
    expect(r.isError).toBe(false)
    expect(r.text).toContain('Denoise bakes in the background')
    const c = timeline().tracks.flatMap((t) => t.clips).find((x) => x.id === clipId)!
    expect(c.effects?.find((e) => e.type === 'audio.denoise')?.params.amount.value).toBe(0.8)
    const wet = await h.ctx.denoise!.bake(entries.noisy.id, files.noisy)
    expect(h.ctx.denoise!.state(entries.noisy.id)).toBe('baked')
    const info = (await probeAudio(wet))!
    expect(info.sampleRate).toBe(48000)
    expect(Math.abs(info.duration - entries.noisy.duration)).toBeLessThan(0.01)
    const off = await call(client, 'denoise_audio', { clipIds: [clipId], enabled: false })
    expect(off.isError).toBe(false)
    expect(timeline().tracks.flatMap((t) => t.clips).find((x) => x.id === clipId)!.effects ?? []).toEqual([])
  }, 120_000)
})
