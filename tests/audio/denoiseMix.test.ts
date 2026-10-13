// Denoise dry/wet blend in the shared audio plan (preview + export) and the export bake step (spec 07 §3.6).
import { TEST_ROOT } from '../interchange/env'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newClip, newTimeline, newTrack, type Clip, type Effect, type Timeline } from '../../src/core/model'
import { buildMixGraph } from '../../src/main/export/audioMix'
import { createExportService, type ExportDenoise } from '../../src/main/export/exportService'
import { ffmpegPath } from '../../src/main/media/ffmpeg'
import { ProjectSession } from '../../src/main/project/session'
import type { HostRenderService } from '../../src/main/render/renderService'
import { audioPieces, denoiseRefs, denoiseStrength, pieceEnvelope, withDenoise } from '../../src/renderer/render/audioPlan'
import type { MediaMap } from '../../src/renderer/render/plan'

const fx = (amount: number | undefined, enabled = true): Effect[] => [{ id: `fx-${Math.random()}`, type: 'audio.denoise', enabled, params: amount === undefined ? {} : { amount: { value: amount } } }]
const ac = (p: Partial<Clip> & Pick<Clip, 'startFrame' | 'durationFrames'>): Clip => newClip({ mediaRef: 'A', mediaType: 'audio', sourceClipType: 'audio', ...p, id: p.id ?? `a${p.startFrame}` })
const media: MediaMap = { A: { path: '/a.wav', type: 'audio', duration: 10, hasAudio: true } }

describe('denoise blend plan', () => {
  it('strength follows hasDenoiseEnabled / denoiseAmount (default 0.6, clamped)', () => {
    expect(denoiseStrength(ac({ startFrame: 0, durationFrames: 10 }))).toBe(0)
    expect(denoiseStrength(ac({ startFrame: 0, durationFrames: 10, effects: fx(undefined) }))).toBe(0.6)
    expect(denoiseStrength(ac({ startFrame: 0, durationFrames: 10, effects: fx(0.8, false) }))).toBe(0)
    expect(denoiseStrength(ac({ startFrame: 0, durationFrames: 10, effects: fx(1.7) }))).toBe(1)
  })

  it('adds a wet twin at strength and drops the dry piece to 1 − strength once baked', () => {
    const tl = newTimeline({ tracks: [newTrack('audio', { clips: [ac({ startFrame: 0, durationFrames: 30, volume: 0.5, effects: fx(0.75) })] })] })
    const dry = audioPieces(tl, { fps: 30, timelines: [tl], media: (id) => media[id] })
    expect(denoiseRefs(dry)).toEqual(['A'])
    // Unbaked: dry only, at unity (CompositionBuilder: no twin, not in blendedClipIds).
    const unbaked = withDenoise(dry, () => null)
    expect(unbaked).toHaveLength(1)
    expect(pieceEnvelope(unbaked[0]).gains).toEqual([0.5, 0.5])
    const baked = withDenoise(dry, () => '/cache/A_wet.wav')
    expect(baked.map((p) => [p.key, p.path, p.denoise])).toEqual([
      [dry[0].key, '/a.wav', { role: 'dry', gain: 0.25 }],
      [`${dry[0].key}#wet`, '/cache/A_wet.wav', { role: 'wet', gain: 0.75 }],
    ])
    expect(pieceEnvelope(baked[0]).gains[0]).toBeCloseTo(0.125)
    expect(pieceEnvelope(baked[1]).gains[0]).toBeCloseTo(0.375)
    // Same source timing: the wet file is sample-aligned with the source.
    expect(baked[1].timing).toEqual(baked[0].timing)
  })

  it('leaves nested clips dry (twins are only inserted for top-level clips)', () => {
    const child = newTimeline({ tracks: [newTrack('audio', { clips: [ac({ id: 'inner', startFrame: 0, durationFrames: 30, effects: fx(1) })] })] })
    const parent = newTimeline({
      tracks: [newTrack('audio', { clips: [newClip({ id: 'nest', mediaRef: child.id, mediaType: 'sequence', sourceClipType: 'sequence', startFrame: 0, durationFrames: 30 })] })],
    })
    const pieces = audioPieces(parent, { fps: 30, timelines: [parent, child], media: (id) => media[id] })
    expect(pieces).toHaveLength(1)
    expect(denoiseRefs(pieces)).toEqual([])
    expect(withDenoise(pieces, () => '/w.wav')).toEqual(pieces)
  })

  it('mixes both inputs with their split gains in the export graph', () => {
    const tl = newTimeline({ tracks: [newTrack('audio', { clips: [ac({ startFrame: 0, durationFrames: 30, trimStartFrame: 15, effects: fx(0.6) })] })] })
    const p = withDenoise(audioPieces(tl, { fps: 30, timelines: [tl], media: (id) => media[id] }), () => '/w.wav')
    const g = buildMixGraph(p, { start: 0, end: 30, fps: 30, durationSec: 1 }, (f) => (f === '/w.wav' ? 1 : 2))!
    expect(g.inputs).toEqual([
      { path: '/a.wav', seekSec: 0.5, durSec: 1 },
      { path: '/w.wav', seekSec: 0.5, durSec: 1 },
    ])
    expect(g.filter).toContain("volume=volume='0.4'")
    expect(g.filter).toContain("volume=volume='0.6'")
    expect(g.filter).toContain('[1:a:0]asetpts=PTS-STARTPTS,pan=stereo|c0=c0|c1=c0')
    expect(g.filter).toContain('amix=inputs=2')
  })
})

// ---------- export bake + mix (real ffmpeg, fake bake) ----------

const root = path.join(TEST_ROOT, 'denoise-export')
const src = path.join(root, 'src.wav')
const wetFile = path.join(root, 'wet.wav')
let session: ProjectSession
let timeline: Timeline

function ff(args: string[]): Buffer {
  const r = spawnSync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(String(r.stderr))
  return r.stdout
}

function rms(file: string): number {
  const b = ff(['-i', file, '-ac', '1', '-f', 'f32le', 'pipe:1'])
  const f = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
  let s = 0
  for (const v of f) s += v * v
  return Math.sqrt(s / f.length)
}

beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true })
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-ac', '2', src])
  // "Wet" stand-in: exact silence, so the mix level is (1 − amount) × dry.
  ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '1', '-c:a', 'pcm_s16le', wetFile])
  timeline = newTimeline({ tracks: [newTrack('audio', { clips: [ac({ id: 'dn', mediaRef: 'SRC', startFrame: 0, durationFrames: 30, effects: fx(0.75) })] })] })
  session = await ProjectSession.create(path.join(root, 'Denoise.palmier'), {
    file: { timelines: [timeline], activeTimelineId: timeline.id, openTimelineIds: [timeline.id] },
    manifest: { version: 2, folders: [], entries: [{ id: 'SRC', name: 'src', type: 'audio', source: { external: { absolutePath: src } }, duration: 1, hasAudio: true }] },
  })
})

afterAll(() => {
  session?.removeAllListeners()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('export denoise', () => {
  const run = async (denoise: ExportDenoise | undefined, name: string) => {
    const service = createExportService({} as HostRenderService, { denoise })
    const out = path.join(root, 'out', name)
    const done = await service.wait(service.start(session, { timelineId: timeline.id, format: 'wav', outputPath: out }).id)
    service.dispose()
    expect(done.status).toBe('completed')
    return rms(out)
  }

  it('bakes before mixing and blends amount·wet + (1 − amount)·dry', async () => {
    const calls: [string, string][] = []
    const dryLevel = await run(undefined, 'dry.wav')
    const blended = await run({ bake: async (ref, file) => (calls.push([ref, file]), wetFile) }, 'blend.wav')
    expect(calls).toEqual([['SRC', src]])
    expect(dryLevel).toBeGreaterThan(0.05)
    expect(blended / dryLevel).toBeCloseTo(0.25, 2)
  })

  it('exports the original audio when the bake fails', async () => {
    const dryLevel = await run(undefined, 'dry2.wav')
    const failed = await run({ bake: async () => Promise.reject(new Error('boom')) }, 'failed.wav')
    expect(failed).toBeCloseTo(dryLevel, 4)
  })

  it('stops waiting for a bake when the export is cancelled', async () => {
    const service = createExportService({} as HostRenderService, { denoise: { bake: () => new Promise<string>(() => undefined) } })
    const job = service.start(session, { timelineId: timeline.id, format: 'wav', outputPath: path.join(root, 'out', 'cancel.wav') })
    setTimeout(() => service.cancel(job.id), 100)
    const done = await service.wait(job.id)
    service.dispose()
    expect(done.status).toBe('cancelled')
  })
})
