/**
 * Denoise bakes (spec 07 §3.6): the bundled `deep-filter` 0.5.6 CLI + DeepFilterNet3 ONNX archive. One bake at a time
 * on the analysis lane; output = fully wet 48 kHz WAV (pcm_s16le), atomically moved to
 * `$XDG_CACHE_HOME/framewright/EnhancedAudio/<mediaRef>_<size>_<floor(mtime)>_wet.wav` (stale siblings deleted).
 * The dry/wet blend (`audio.denoise.amount`) is applied by the mixer, not here.
 *
 * Preview/export integration: call `enhancedAudioPath(mediaRef, file)` — the wet file when baked, else null
 * (play the original). Mix `amount·wet + (1 − amount)·dry`; the wet file is sample-aligned with the source at 48 kHz.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { denoiseTargets } from '../../../core/audio/denoise'
import type { Doc } from '../../../core/ops/context'
import { ffmpegPath, run } from '../../media/ffmpeg'
import type { Semaphore } from '../jobs'
import { probeAudio } from './decode'
import { resourcePath } from './resources'

export type DenoiseState = 'idle' | 'baking' | 'baked' | 'failed'

export const deepFilterPath = () => process.env.PALMIER_DEEP_FILTER ?? resourcePath('bin', 'deep-filter')
export const deepFilterModelPath = () => resourcePath('models', 'DeepFilterNet3_onnx.tar.gz')

/** STFT + lookahead delay trimmed by `-D`: 960 − 480 + 2·480 samples at 48 kHz. */
const DF_DELAY_SAMPLES = 1440

async function fileTag(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file)
    return `${st.size}_${Math.floor(st.mtimeMs / 1000)}`
  } catch {
    return null
  }
}

const safeRef = (ref: string) => ref.replace(/[^A-Za-z0-9._-]/g, '_')

export class DenoiseService {
  readonly dir: string
  private readonly states = new Map<string, DenoiseState>()
  private readonly inflight = new Map<string, { promise: Promise<string>; abort: AbortController }>()
  private readonly listeners = new Set<(mediaRef: string, state: DenoiseState) => void>()

  constructor(
    cacheRoot: string,
    private readonly lane: Semaphore,
  ) {
    this.dir = path.join(cacheRoot, 'EnhancedAudio')
  }

  onState(cb: (mediaRef: string, state: DenoiseState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private set(ref: string, s: DenoiseState): void {
    this.states.set(ref, s)
    for (const l of this.listeners) l(ref, s)
  }

  state(ref: string): DenoiseState {
    return this.states.get(ref) ?? 'idle'
  }

  private async target(ref: string, file: string): Promise<{ tag: string; out: string } | null> {
    const tag = await fileTag(file)
    return tag ? { tag, out: path.join(this.dir, `${safeRef(ref)}_${tag}_wet.wav`) } : null
  }

  /** The baked wet file for `file`, or null when not baked (yet). */
  async enhancedAudioPath(ref: string, file: string): Promise<string | null> {
    const t = await this.target(ref, file)
    if (t && existsSync(t.out)) {
      if (this.state(ref) !== 'baked') this.set(ref, 'baked')
      return t.out
    }
    return null
  }

  /** Re-enabling / adjusting Strength clears a failure so the next schedule retries. */
  clearFailure(ref: string): void {
    if (this.state(ref) === 'failed') this.set(ref, 'idle')
  }

  /** `enhanceAudioIfNeeded` for one file: cached → baked; otherwise bake in the background. */
  bake(ref: string, file: string): Promise<string> {
    const running = this.inflight.get(ref)
    if (running) return running.promise
    const abort = new AbortController()
    const promise = (async () => {
      const cached = await this.enhancedAudioPath(ref, file)
      if (cached) return cached
      this.set(ref, 'baking')
      try {
        const out = await this.lane.run(() => this.runBake(ref, file, abort.signal), abort.signal)
        this.set(ref, 'baked')
        return out
      } catch (e) {
        this.set(ref, abort.signal.aborted ? 'idle' : 'failed')
        if (!abort.signal.aborted) console.warn(`[audio] denoise failed for ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`)
        throw e
      }
    })().finally(() => this.inflight.delete(ref))
    this.inflight.set(ref, { promise, abort })
    promise.catch(() => undefined)
    return promise
  }

  private async runBake(ref: string, file: string, signal: AbortSignal): Promise<string> {
    const t = await this.target(ref, file)
    if (!t) throw new Error(`Media file not on disk: ${file}`)
    const info = await probeAudio(file, signal)
    if (!info) throw new Error('No audio track.')
    const work = await fs.mkdtemp(path.join(os.tmpdir(), 'framewright-denoise-'))
    try {
      const input = path.join(work, 'in.wav')
      await run(ffmpegPath, ['-nostdin', '-v', 'error', '-y', '-i', file, '-map', '0:a:0', '-vn', '-ac', String(Math.min(2, info.channels)), '-af', `aresample=48000,apad=pad_len=${DF_DELAY_SAMPLES}`, '-c:a', 'pcm_f32le', input], { signal })
      const outDir = path.join(work, 'out')
      await fs.mkdir(outDir)
      await run(deepFilterPath(), ['-m', deepFilterModelPath(), '-D', '-a', '100', '-o', outDir, input], { signal })
      await fs.mkdir(this.dir, { recursive: true })
      const tmp = `${t.out}.writing-${randomUUID()}`
      await fs.copyFile(path.join(outDir, 'in.wav'), tmp)
      await fs.rename(tmp, t.out)
      const prefix = `${safeRef(ref)}_`
      for (const n of await fs.readdir(this.dir)) if (n.startsWith(prefix) && !n.startsWith(`${prefix}${t.tag}_`)) await fs.rm(path.join(this.dir, n), { force: true })
      return t.out
    } finally {
      await fs.rm(work, { recursive: true, force: true })
    }
  }

  /** `enhancePendingDenoises`: bakes every ref with an enabled denoise (amount > 0) that isn't baked/in-flight/failed. */
  schedule(doc: Doc, resolve: (ref: string) => string | null): string[] {
    const started: string[] = []
    for (const ref of denoiseTargets(doc)) {
      const s = this.state(ref)
      if (s === 'baking' || s === 'failed' || s === 'baked') continue
      const file = resolve(ref)
      if (!file) continue
      void this.bake(ref, file).catch(() => undefined)
      started.push(ref)
    }
    return started
  }

  /** Project close / quit: kill running bakes (partial output lives in the temp dir and is removed). */
  cancelAll(): void {
    for (const { abort } of this.inflight.values()) abort.abort()
  }
}
