/**
 * Speaker identification: pure clustering/turn maths always; one REAL run (opt-in: PALMIER_REAL_SPEAKERS=1, downloads
 * the 33 MB pyannote + WeSpeaker models into a temp XDG dir, or PALMIER_TEST_MODELS_ROOT) on flite voices.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, describe, expect, it } from 'vitest'
import { assignSpeakers, cosine, fingerprint, fingerprintPieces, mergeTurns, newRegistryEntry, speakerMask, speakerRuns, speechConfirmed } from '../../src/core/audio/speakers'
import { ModelManager } from '../../src/main/ml/models'
import { releaseSessions } from '../../src/main/ml/audio/onnx'
import { AudioAnalysisService } from '../../src/main/ml/audio/service'
import { SpeakerService } from '../../src/main/ml/audio/speakers'

const unit = (i: number, dim = 256) => Array.from({ length: dim }, (_, k) => (k === i ? 1 : 0))
const mix = (a: number[], b: number[], w: number) => a.map((x, i) => x * (1 - w) + b[i] * w)

describe('speaker maths (§3.5)', () => {
  it('merges same-speaker turns with gaps < 1 s and confirms them against VAD', () => {
    const turns = mergeTurns([
      { speaker: 'S0', start: 0, end: 2 },
      { speaker: 'S0', start: 2.5, end: 4 },
      { speaker: 'S1', start: 4.2, end: 6 },
      { speaker: 'S0', start: 7.5, end: 8 },
    ])
    expect(turns).toEqual([
      { speaker: 'S0', start: 0, end: 4 },
      { speaker: 'S1', start: 4.2, end: 6 },
      { speaker: 'S0', start: 7.5, end: 8 },
    ])
    expect(speechConfirmed(turns, [{ start: 5.8, end: 9 }]).map((t) => t.speaker)).toEqual(['S0'])
    expect(speechConfirmed(turns, [])).toEqual([])
  })

  it('fingerprint pieces: 3 longest turns > 1 s, trimmed, capped at 6 s, ∩ VAD', () => {
    const turns = [
      { speaker: 'A', start: 0, end: 10 },
      { speaker: 'A', start: 20, end: 21.2 },
      { speaker: 'A', start: 30, end: 30.9 },
      { speaker: 'B', start: 40, end: 42 },
    ]
    const p = fingerprintPieces(turns, [])
    expect(p.get('A')).toEqual([
      [0.25, 5.75],
      [20.25, 20.95],
    ])
    const v = fingerprintPieces(turns, [{ start: 1, end: 3 }, { start: 3.1, end: 3.3 }])
    expect(v.get('A')).toEqual([[1, 3]])
    expect(v.has('B')).toBe(false)
  })

  it('greedy assignment: threshold 0.45, one cluster per speaker per file, registry centroids fixed', () => {
    const registry = [newRegistryEntry(1, unit(0)), { ...newRegistryEntry(2, [1, 2]), name: 'Mac 2-d' }]
    const a = assignSpeakers(registry, [
      { mediaRef: 'f1', local: 'S0', vector: mix(unit(0), unit(1), 0.3) },
      { mediaRef: 'f1', local: 'S1', vector: mix(unit(0), unit(2), 0.6) }, // also ≥ 0.45 to 1, but 1 is taken in f1
      { mediaRef: 'f2', local: 'S0', vector: unit(2) },
    ])
    expect(a.byFileLocal.f1).toEqual({ S0: 1, S1: 3 })
    expect(a.byFileLocal.f2).toEqual({ S0: 3 })
    expect(a.newEntries.map((e) => e.id)).toEqual([3])
    expect(newRegistryEntry(9, []).color).toEqual([10 / 255, 132 / 255, 1, 1])
    expect(cosine(fingerprint([unit(0), unit(0)]), unit(0))).toBeCloseTo(1, 6)
  })

  it('speaker mask cells and runs', () => {
    const m = speakerMask([{ speaker: 'S0', start: 0.05, end: 0.1 }, { speaker: 'S1', start: 0.2, end: 0.3 }], { S0: 4, S1: 7 }, 12)
    expect(Array.from(m)).toEqual([-1, 4, 4, 4, -1, -1, 7, 7, 7, 7, -1, -1])
    expect(speakerRuns(m)).toEqual([[1, 4, 4], [6, 10, 7]])
  })
})

const SYSTEM_FFMPEG = '/usr/bin/ffmpeg'
const enabled = process.env.PALMIER_REAL_SPEAKERS === '1' && existsSync(SYSTEM_FFMPEG)
const tmp = mkdtempSync(path.join(os.tmpdir(), 'palmier-speakers-'))
afterAll(async () => {
  await releaseSessions()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe.skipIf(!enabled)('real speaker identification', () => {
  it('two flite voices in one file, matched again in a second file', async () => {
    const ff = (args: string[]) => execFileSync(SYSTEM_FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
    const say = (voice: string, t: string) => `flite=text='${t}':voice=${voice},aresample=16000`
    const gap = (d: number) => `anoisesrc=d=${d}:c=pink:r=16000:a=0.0003`
    const a = path.join(tmp, 'dialog.wav')
    const b = path.join(tmp, 'solo.wav')
    ff(['-filter_complex', `${say('slt', 'Good morning and welcome to our weekly program about film editing and sound.')}[a];${gap(1.2)}[b];${say('awb', 'Thank you very much, it is a real pleasure to be here with you again today.')}[c];${gap(1.2)}[d];${say('slt', 'Let us start with the basics of cutting dialogue scenes on a timeline.')}[e];${gap(1.2)}[f];${say('awb', 'Sure, the first rule is that every cut should be motivated by the story.')}[g];[a][b][c][d][e][f][g]concat=n=7:v=0:a=1[out]`, '-map', '[out]', a])
    ff(['-filter_complex', `${say('awb', 'In my experience the best editors listen more than they look at the picture, and they trust their ears.')}[a];${gap(0.8)}[b];[a][b]concat=n=2:v=0:a=1[out]`, '-map', '[out]', b])
    const worker = path.join(tmp, 'speakerWorker.cjs')
    await build({ entryPoints: [path.resolve('src/main/ml/audio/speakerWorker.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', external: ['sherpa-onnx-node'], logLevel: 'error', nodePaths: [path.resolve('node_modules')] })
    process.env.PALMIER_SPEAKER_WORKER = worker
    process.env.NODE_PATH = path.resolve('node_modules')
    const models = new ModelManager({ root: process.env.PALMIER_TEST_MODELS_ROOT ?? path.join(tmp, 'Models') })
    const audio = new AudioAnalysisService({ cacheRoot: path.join(tmp, 'cache') })
    const svc = new SpeakerService(path.join(tmp, 'cache'), models, audio)
    try {
      const r = await svc.identify([{ mediaRef: 'dialog', file: a }], [], { cacheOnly: false })
      expect(r.errors).toEqual([])
      const ids = Object.values(r.byFileLocal.dialog ?? {})
      console.info('[speakers] dialog', JSON.stringify(r.byFileLocal), 'runs', r.masks.dialog?.runs.length)
      expect(ids.length).toBeGreaterThanOrEqual(1)
      expect(r.masks.dialog.runs.length).toBeGreaterThanOrEqual(2)
      const registry = r.newEntries.map((e) => newRegistryEntry(e.id, e.centroid))
      const r2 = await svc.identify([{ mediaRef: 'solo', file: b }], registry, { cacheOnly: false })
      console.info('[speakers] solo', JSON.stringify(r2.byFileLocal), 'new', r2.newEntries.length)
      expect(Object.keys(r2.byFileLocal.solo ?? {}).length).toBe(1)
      // The solo file's voice (awb) is the dialog's second turn speaker.
      const awbId = r.masks.dialog.runs[1][2]
      expect(Object.values(r2.byFileLocal.solo)[0]).toBe(awbId)
      expect(r.masks.dialog.runs.map((x) => x[2])).toEqual([r.masks.dialog.runs[0][2], awbId, r.masks.dialog.runs[0][2], awbId])
      // Cache-only re-run reproduces the first result without the models.
      const again = await svc.identify([{ mediaRef: 'dialog', file: a }], [], { cacheOnly: true })
      expect(again.byFileLocal).toEqual(r.byFileLocal)
    } finally {
      svc.dispose()
    }
  }, 300_000)
})
