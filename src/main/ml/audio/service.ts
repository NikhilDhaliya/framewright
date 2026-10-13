/**
 * Audio analysis service (spec 07 §3): per-file speech activity + quiet mask (VAD, dead air), 2.5 ms envelopes for
 * sync, Beat This beats, and the per-session silence settings. Results are cached on disk under
 * `$XDG_CACHE_HOME/framewright/{AudioAnalysis,BeatAnalysis}/<mediaRef>_<size>_<floor(mtime)>_*.json`; writing a
 * new file removes that ref's stale siblings. In-flight work is de-duplicated per ref.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { beatAnalysis, BEAT_SAMPLE_RATE, predictLogits, type BeatAnalysis } from '../../../core/audio/beats'
import { DEFAULT_SILENCE_SETTINGS, quietNonSpeechMask, type QuietMaskData, type QuietMasks, type SilenceSettings } from '../../../core/audio/deadAir'
import { EnvelopeAccumulator, ENVELOPE_RATE, PeakAccumulator, peakRate } from '../../../core/audio/envelope'
import { binarize, maskRuns, speechMask, VAD_CHUNK_SAMPLES, VAD_SAMPLE_RATE, type SpeechActivity } from '../../../core/audio/vad'
import type { SourceTiming } from '../../../core/interchange/timecode'
import { readSourceTiming } from '../../media/sourceTimecode'
import { Semaphore } from '../jobs'
import { decodeMono, decodeMonoStream, NoAudioError, probeAudio } from './decode'
import { onnxSession, tensor } from './onnx'
import { resourcePath } from './resources'
import { SileroStream } from './silero'

export interface SpeechAnalysis extends SpeechActivity {
  quiet: QuietMaskData
}

const beatModelPath = () => resourcePath('models', 'BeatThis.onnx')

async function fileTag(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file)
    return `${st.size}_${Math.floor(st.mtimeMs / 1000)}`
  } catch {
    return null
  }
}

const safeRef = (ref: string) => ref.replace(/[^A-Za-z0-9._-]/g, '_')

async function writeAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, file)
}

/** Deletes `<ref>_*` files in `dir` that are not of the current tag. */
async function pruneStale(dir: string, ref: string, tag: string): Promise<void> {
  const prefix = `${safeRef(ref)}_`
  const keep = `${prefix}${tag}_`
  const names = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(names.filter((n) => n.startsWith(prefix) && !n.startsWith(keep)).map((n) => fs.rm(path.join(dir, n), { force: true })))
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

export interface AudioAnalysisOptions {
  cacheRoot: string
}

export class AudioAnalysisService {
  readonly dirs: { analysis: string; beats: string }
  /** The Mac's inference gate ("analysis" lane): VAD, speaker, denoise. */
  readonly analysisLane = new Semaphore(1)
  private readonly beatsLane = new Semaphore(1)
  private readonly decodeGate = new Semaphore(4)
  private readonly speechMem = new Map<string, { tag: string; value: SpeechAnalysis }>()
  private readonly beatsMem = new Map<string, { tag: string; value: BeatAnalysis }>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly failed = new Set<string>()
  private readonly silence = new Map<string, SilenceSettings>()
  private vadUnavailable: unknown = null
  private listeners = new Set<(e: { kind: 'speech' | 'beats'; mediaRef: string }) => void>()

  constructor(o: AudioAnalysisOptions) {
    this.dirs = { analysis: path.join(o.cacheRoot, 'AudioAnalysis'), beats: path.join(o.cacheRoot, 'BeatAnalysis') }
  }

  onChange(cb: (e: { kind: 'speech' | 'beats'; mediaRef: string }) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(kind: 'speech' | 'beats', mediaRef: string): void {
    for (const l of this.listeners) l({ kind, mediaRef })
  }

  private dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.inflight.get(key) as Promise<T> | undefined
    if (hit) return hit
    const p = fn().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  get speechInFlight(): number {
    return [...this.inflight.keys()].filter((k) => k.startsWith('vad:')).length
  }

  // ---------- Silence settings (session only) ----------

  silenceSettings(sessionKey: string): SilenceSettings {
    return this.silence.get(sessionKey) ?? DEFAULT_SILENCE_SETTINGS
  }

  setSilenceSettings(sessionKey: string, s: SilenceSettings): void {
    this.silence.set(sessionKey, { ...s })
  }

  // ---------- Speech (VAD + quiet mask) ----------

  private speechFile(ref: string, tag: string) {
    return { vad: path.join(this.dirs.analysis, `${safeRef(ref)}_${tag}_vad.json`), quiet: path.join(this.dirs.analysis, `${safeRef(ref)}_${tag}_quiet.json`) }
  }

  /** Cache-only lookup (memory, then disk). */
  async cachedSpeech(ref: string, file: string): Promise<SpeechAnalysis | null> {
    const tag = await fileTag(file)
    if (!tag) return null
    const mem = this.speechMem.get(ref)
    if (mem?.tag === tag) return mem.value
    const f = this.speechFile(ref, tag)
    const [vad, quiet] = await Promise.all([readJson<SpeechActivity>(f.vad), readJson<QuietMaskData>(f.quiet)])
    if (!vad || !Array.isArray(vad.segments) || !quiet || !Array.isArray(quiet.runs)) return null
    const value = { ...vad, quiet }
    this.speechMem.set(ref, { tag, value })
    return value
  }

  /** Synchronous memory lookup used to assemble masks for edits. */
  memoryQuiet(ref: string): QuietMaskData | undefined {
    return this.speechMem.get(ref)?.value.quiet
  }

  /** VAD + quiet mask for `file` (cached). No audio → `{chunkCount: 0, segments: []}`. */
  speech(ref: string, file: string, signal?: AbortSignal): Promise<SpeechAnalysis> {
    return this.dedupe(`vad:${ref}`, async () => {
      const hit = await this.cachedSpeech(ref, file)
      if (hit) return hit
      const tag = await fileTag(file)
      if (!tag) throw new Error(`Media file not on disk: ${file}`)
      try {
        const value = await this.analysisLane.run(() => this.runSpeech(file, signal), signal)
        const f = this.speechFile(ref, tag)
        const { quiet, ...vad } = value
        await writeAtomic(f.vad, JSON.stringify(vad))
        await writeAtomic(f.quiet, JSON.stringify(quiet))
        await pruneStale(this.dirs.analysis, ref, tag)
        this.speechMem.set(ref, { tag, value })
        this.failed.delete(ref)
        this.emit('speech', ref)
        return value
      } catch (e) {
        if (!signal?.aborted) {
          this.failed.add(ref)
          console.warn(`[audio] speech detection failed for ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`)
        }
        throw e
      }
    })
  }

  private async runSpeech(file: string, signal?: AbortSignal): Promise<SpeechAnalysis> {
    if (this.vadUnavailable) throw this.vadUnavailable
    const info = await probeAudio(file, signal)
    if (!info) return { chunkCount: 0, segments: [], quiet: { count: 0, runs: [] } }
    let vad: SileroStream
    try {
      vad = await SileroStream.open()
    } catch (e) {
      this.vadUnavailable = e
      throw e
    }
    const peaks = new PeakAccumulator(VAD_SAMPLE_RATE, peakRate(info.duration || 1))
    const samples = await decodeMonoStream(file, { rate: VAD_SAMPLE_RATE, channels: info.channels, signal }, (x) => {
      peaks.push(x)
      vad.push(x)
      return vad.drain()
    })
    const probs = await vad.finish()
    const chunkCount = Math.ceil(samples / VAD_CHUNK_SAMPLES)
    const activity: SpeechActivity = { chunkCount, segments: binarize(probs.slice(0, chunkCount)) }
    const quiet = quietNonSpeechMask(speechMask(activity), peaks.finish())
    return { ...activity, quiet: { count: quiet.length, runs: maskRuns(quiet) } }
  }

  /**
   * Quiet masks for `refs` (cache only), resolving files through `resolve`. Missing refs are analysed in the
   * background when `kick` is set, so a retry finds them (the agent's "speech analysis may still be running").
   */
  async quietMasks(refs: Iterable<string>, resolve: (ref: string) => string | null, kick = true): Promise<QuietMasks> {
    const out: Record<string, QuietMaskData> = {}
    await Promise.all(
      [...new Set(refs)].map(async (ref) => {
        const file = resolve(ref)
        if (!file) return
        const hit = await this.cachedSpeech(ref, file)
        if (hit) out[ref] = hit.quiet
        else if (kick && !this.failed.has(ref)) void this.speech(ref, file).catch(() => undefined)
      }),
    )
    return out
  }

  // ---------- Envelopes + timing (sync) ----------

  /** 2.5 ms loudness envelope of `[start, end]` source seconds; null when the file has no readable audio. */
  envelope(file: string, start: number, end: number, signal?: AbortSignal): Promise<Float32Array | null> {
    return this.decodeGate.run(async () => {
      const acc = new EnvelopeAccumulator()
      try {
        await decodeMonoStream(file, { rate: ENVELOPE_RATE, range: [Math.max(0, start), Math.max(start, end)], signal }, (x) => acc.push(x))
      } catch (e) {
        if (signal?.aborted) throw e
        if (e instanceof NoAudioError) return null
        console.warn(`[audio] envelope failed for ${path.basename(file)}: ${e instanceof Error ? e.message : String(e)}`)
        return null
      }
      const env = acc.finish()
      return env.length ? env : null
    }, signal)
  }

  async timing(files: Record<string, string | null>): Promise<Record<string, SourceTiming>> {
    const out: Record<string, SourceTiming> = {}
    await Promise.all(
      Object.entries(files).map(async ([ref, file]) => {
        if (file) out[ref] = await readSourceTiming(file).catch(() => ({}))
      }),
    )
    return out
  }

  // ---------- Beats ----------

  private beatsFile(ref: string, tag: string) {
    return path.join(this.dirs.beats, `${safeRef(ref)}_${tag}_beats.json`)
  }

  async cachedBeats(ref: string, file: string): Promise<BeatAnalysis | null> {
    const tag = await fileTag(file)
    if (!tag) return null
    const mem = this.beatsMem.get(ref)
    if (mem?.tag === tag) return mem.value
    const v = await readJson<BeatAnalysis>(this.beatsFile(ref, tag))
    if (!v || !Array.isArray(v.beats) || !Array.isArray(v.downbeats)) return null
    this.beatsMem.set(ref, { tag, value: v })
    return v
  }

  memoryBeats(ref: string): BeatAnalysis | undefined {
    return this.beatsMem.get(ref)?.value
  }

  /** Detects (or returns cached) beats. `force` re-analyses. */
  beats(ref: string, file: string, force = false, signal?: AbortSignal): Promise<BeatAnalysis> {
    return this.dedupe(`beats:${ref}`, async () => {
      if (!force) {
        const hit = await this.cachedBeats(ref, file)
        if (hit) return hit
      }
      const tag = await fileTag(file)
      if (!tag) throw new Error(`Media file not on disk: ${file}`)
      const value = await this.beatsLane.run(async () => {
        const info = await probeAudio(file, signal)
        if (!info) throw new NoAudioError(file)
        const samples = await decodeMono(file, { rate: BEAT_SAMPLE_RATE, channels: info.channels, signal })
        const session = await onnxSession(beatModelPath())
        const logits = await predictLogits(
          samples,
          async (chunk) => {
            const out = await session.run({ audio: tensor('float32', chunk, [chunk.length]) })
            return { beat: out.beat.data as Float32Array, downbeat: out.downbeat.data as Float32Array }
          },
          () => !!signal?.aborted,
        )
        return beatAnalysis(logits)
      }, signal)
      await writeAtomic(this.beatsFile(ref, tag), JSON.stringify(value))
      await pruneStale(this.dirs.beats, ref, tag)
      this.beatsMem.set(ref, { tag, value })
      this.emit('beats', ref)
      return value
    })
  }

  /** Settings ▸ Storage ▸ Clear cache / relink. */
  invalidate(ref?: string): void {
    if (ref) {
      this.speechMem.delete(ref)
      this.beatsMem.delete(ref)
      this.failed.delete(ref)
    } else {
      this.speechMem.clear()
      this.beatsMem.clear()
      this.failed.clear()
    }
  }
}
