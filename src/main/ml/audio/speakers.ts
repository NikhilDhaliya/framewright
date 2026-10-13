/**
 * Speaker identification (spec 07 §3.5, Linux: local diarization). Per file: pyannote-3.0 + WeSpeaker ResNet34-LM
 * diarization in the "speech" process → turns (merged, speech-confirmed against VAD) → WeSpeaker fingerprints →
 * greedy matching against `ProjectFile.speakers`. Turns and fingerprints are cached per file under
 * `$XDG_CACHE_HOME/framewright/SpeakerVoices/`. Cache-only runs never decode, diarize or download.
 */
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assignSpeakers, fingerprint, fingerprintPieces, MIN_FINGERPRINT_SAMPLES, mergeTurns, speakerMask, speakerRuns, speechConfirmed, type Assignment, type SpeakerTurn, type VoiceItem } from '../../../core/audio/speakers'
import { CELL_SECONDS } from '../../../core/audio/vad'
import type { SpeakerRegistryEntry } from '../../../core/model'
import type { ModelManager } from '../models'
import { decodeMono, probeAudio } from './decode'
import type { AudioAnalysisService } from './service'

const VAD_RATE = 16000
const CLUSTER_THRESHOLD = 0.5

export const speakerWorkerPath = () => process.env.PALMIER_SPEAKER_WORKER ?? path.join(__dirname, 'speakerWorker.cjs')

/** The forked sherpa process (lazily started, killed on dispose). */
class SpeechProcess {
  private child: ChildProcess | null = null
  private seq = 0
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  private ensure(): ChildProcess {
    if (this.child && this.child.connected) return this.child
    const file = speakerWorkerPath()
    if (!existsSync(file)) throw new Error('The speaker engine is missing from this build.')
    const child = fork(file, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.on('message', (m: { id: number; result?: unknown; error?: string }) => {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m.result)
    })
    child.on('exit', () => {
      for (const p of this.pending.values()) p.reject(new Error('The speaker engine stopped.'))
      this.pending.clear()
      if (this.child === child) this.child = null
    })
    this.child = child
    return child
  }

  call<T>(msg: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const child = this.ensure()
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(id)
        child.kill('SIGKILL')
        reject(new DOMException('Aborted', 'AbortError'))
      }
      if (signal?.aborted) return onAbort()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(v as T)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      child.send({ id, ...msg })
    })
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
  }
}

export interface SpeakerFile {
  mediaRef: string
  file: string
}

export interface SpeakerResult extends Assignment {
  /** mediaRef → speaker mask runs `[startCell, endCell, globalId]` and its cell count. */
  masks: Record<string, { count: number; runs: [number, number, number][] }>
  errors: string[]
}

async function fileTag(file: string): Promise<string | null> {
  try {
    const st = await fs.stat(file)
    return `${st.size}_${Math.floor(st.mtimeMs / 1000)}`
  } catch {
    return null
  }
}

const safeRef = (ref: string) => ref.replace(/[^A-Za-z0-9._-]/g, '_')

export class SpeakerService {
  readonly dir: string
  private readonly proc = new SpeechProcess()
  private running: Promise<SpeakerResult> | null = null

  constructor(
    cacheRoot: string,
    private readonly models: ModelManager,
    private readonly audio: AudioAnalysisService,
  ) {
    this.dir = path.join(cacheRoot, 'SpeakerVoices')
  }

  get inFlight(): boolean {
    return !!this.running
  }

  private async readJson<T>(file: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as T
    } catch {
      return null
    }
  }

  private async writeJson(file: string, v: unknown): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(v))
    await fs.rename(tmp, file)
  }

  /** `identifySpeakers`: one run at a time; `cacheOnly` = the project-open auto run. */
  identify(files: SpeakerFile[], registry: readonly SpeakerRegistryEntry[], o: { cacheOnly: boolean; signal?: AbortSignal; onPhase?: (p: string) => void }): Promise<SpeakerResult> {
    if (this.running) return this.running
    this.running = this.run(files, registry, o).finally(() => (this.running = null))
    return this.running
  }

  private async run(files: SpeakerFile[], registry: readonly SpeakerRegistryEntry[], o: { cacheOnly: boolean; signal?: AbortSignal; onPhase?: (p: string) => void }): Promise<SpeakerResult> {
    const errors: string[] = []
    let modelDirs: { seg: string; emb: string } | null = null
    const ensureModels = async () => {
      if (modelDirs) return modelDirs
      o.onPhase?.('Downloading speaker models…')
      const [seg, emb] = await Promise.all([this.models.ensure('speaker-pyannote-seg30', { signal: o.signal }), this.models.ensure('speaker-wespeaker-r34lm', { signal: o.signal })])
      modelDirs = { seg: path.join(seg, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'), emb: path.join(emb, 'wespeaker_en_voxceleb_resnet34_LM.onnx') }
      return modelDirs
    }
    const threads = Math.max(1, Math.min(2, Math.floor(os.cpus().length / 2)))
    const items: VoiceItem[] = []
    const perFile = new Map<string, { turns: SpeakerTurn[]; cells: number }>()
    for (const f of files) {
      if (o.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const tag = await fileTag(f.file)
      if (!tag) continue
      const base = path.join(this.dir, `${safeRef(f.mediaRef)}_${tag}`)
      try {
        const vad = o.cacheOnly ? await this.audio.cachedSpeech(f.mediaRef, f.file) : await this.audio.speech(f.mediaRef, f.file, o.signal)
        if (!vad) continue
        let samples: Float32Array | null = null
        const pcm = async () => (samples ??= await decodeMono(f.file, { rate: VAD_RATE, signal: o.signal }))
        let raw = await this.readJson<SpeakerTurn[]>(`${base}_turns.json`)
        if (!raw) {
          if (o.cacheOnly) continue
          const m = await ensureModels()
          o.onPhase?.('Identifying…')
          const x = await pcm()
          const segs = await this.audio.analysisLane.run(() => this.proc.call<{ start: number; end: number; speaker: number }[]>({ op: 'diarize', samples: x, segmentation: m.seg, embedding: m.emb, threshold: CLUSTER_THRESHOLD, threads }, o.signal), o.signal)
          raw = segs.map((s) => ({ speaker: `S${s.speaker}`, start: s.start, end: s.end }))
          await this.writeJson(`${base}_turns.json`, raw)
        }
        const turns = speechConfirmed(mergeTurns(raw), vad.segments)
        const info = vad.chunkCount ? null : await probeAudio(f.file).catch(() => null)
        perFile.set(f.mediaRef, { turns, cells: vad.chunkCount || Math.floor((info?.duration ?? 0) / CELL_SECONDS) + 1 })
        let voices = await this.readJson<Record<string, number[]>>(`${base}_voices.json`)
        if (!voices) {
          if (o.cacheOnly) continue
          const m = await ensureModels()
          const x = await pcm()
          voices = {}
          for (const [label, pieces] of fingerprintPieces(turns, vad.segments)) {
            const vectors: number[][] = []
            const grouped = new Map<number, [number, number][]>()
            // Pieces come per source turn in order; concatenate every piece of one speaker's turn before embedding.
            pieces.forEach((p) => {
              const turnIndex = turns.findIndex((t) => t.speaker === label && p[0] >= t.start && p[1] <= t.end)
              grouped.set(turnIndex, [...(grouped.get(turnIndex) ?? []), p])
            })
            for (const group of grouped.values()) {
              const n = group.reduce((s, [a, b]) => s + Math.max(0, Math.floor(b * VAD_RATE) - Math.floor(a * VAD_RATE)), 0)
              if (n < MIN_FINGERPRINT_SAMPLES) continue
              const cat = new Float32Array(n)
              let off = 0
              for (const [a, b] of group) {
                const part = x.subarray(Math.floor(a * VAD_RATE), Math.min(x.length, Math.floor(b * VAD_RATE)))
                cat.set(part, off)
                off += part.length
              }
              vectors.push(await this.audio.analysisLane.run(() => this.proc.call<number[]>({ op: 'embed', samples: cat.subarray(0, off), embedding: m.emb, threads }, o.signal), o.signal))
            }
            if (vectors.length) voices[label] = fingerprint(vectors)
          }
          if (Object.keys(voices).length) await this.writeJson(`${base}_voices.json`, voices)
        }
        for (const label of Object.keys(voices).sort()) items.push({ mediaRef: f.mediaRef, local: label, vector: voices[label] })
      } catch (e) {
        if (o.signal?.aborted) throw e
        errors.push(`${path.basename(f.file)}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const a = assignSpeakers(registry, items)
    const masks: SpeakerResult['masks'] = {}
    for (const [ref, { turns, cells }] of perFile) {
      const map = a.byFileLocal[ref]
      if (map) masks[ref] = { count: cells, runs: speakerRuns(speakerMask(turns, map, cells)) }
    }
    return { ...a, masks, errors }
  }

  dispose(): void {
    this.proc.dispose()
  }
}
