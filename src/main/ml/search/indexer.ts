/** Indexes one asset: sampled frames → embeddings → store (spec 07 §2.4, Mac `VisualIndexer.swift`). */
import { SAMPLER_VERSION, shotRows, type IndexedFrame, type SamplerOptions } from '../../../core/search/sampler'
import { decodeStill, sampleFrames, type RgbaFrame, type SampledFrame } from './frames'
import type { Embedder, EmbedderSpec } from './siglip'
import type { EmbeddingStore, IndexSpec } from './store'

export const indexSpecOf = (spec: EmbedderSpec): IndexSpec => ({ model: spec.model, modelVersion: spec.version, samplerVersion: SAMPLER_VERSION })

export interface IndexDeps {
  store: EmbeddingStore
  embedder: Embedder
  signal?: AbortSignal
  /** Resolves once no export is running (polled every 2 s by the coordinator). */
  waitWhileExportActive?: (signal?: AbortSignal) => Promise<void>
  /** Test seams. */
  frames?: (file: string, duration: number, signal?: AbortSignal) => AsyncIterable<SampledFrame>
  still?: (file: string, signal?: AbortSignal) => Promise<RgbaFrame | null>
  samplerOptions?: SamplerOptions
}

const abortError = () => new DOMException('Aborted', 'AbortError')
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) throw abortError()
}

async function save(d: IndexDeps, key: string, rows: { time: number; shotStart: number; shotEnd: number }[], vectors: Float32Array[]): Promise<void> {
  const spec = d.embedder.spec
  const flat = new Float32Array(rows.length * spec.embeddingDim)
  vectors.forEach((v, i) => flat.set(v, i * spec.embeddingDim))
  const s = indexSpecOf(spec)
  await d.store.save({ model: s.model, modelVersion: s.modelVersion, samplerVersion: s.samplerVersion, dim: spec.embeddingDim, count: rows.length }, rows, flat, key)
}

/** Video: undecodable files store an empty index so they are not retried. A cancelled run writes nothing. */
export async function indexVideo(file: string, duration: number, d: IndexDeps, onProgress?: (fraction: number) => void): Promise<void> {
  const key = d.store.key(file)
  if (!key || !(await d.store.needsIndex(file, indexSpecOf(d.embedder.spec)))) return
  const kept: IndexedFrame[] = []
  const vectors: Float32Array[] = []
  const frames = d.frames ? d.frames(file, duration, d.signal) : sampleFrames(file, duration, { options: d.samplerOptions, signal: d.signal })
  for await (const frame of frames) {
    check(d.signal)
    await d.waitWhileExportActive?.(d.signal)
    vectors.push(await d.embedder.encodeImage(frame.rgba, frame.width, frame.height))
    kept.push({ time: frame.time, isNewShot: frame.isNewShot })
    if (duration > 0) onProgress?.(Math.min(frame.time / duration, 1))
  }
  check(d.signal)
  await save(d, key, shotRows(kept, duration), vectors)
}

/** Stills: one embedding with a zero-length shot; an undecodable image stores an empty index. */
export async function indexImage(file: string, d: IndexDeps): Promise<void> {
  const key = d.store.key(file)
  if (!key || !(await d.store.needsIndex(file, indexSpecOf(d.embedder.spec)))) return
  await d.waitWhileExportActive?.(d.signal)
  const img = d.still ? await d.still(file, d.signal) : await decodeStill(file, { signal: d.signal })
  const vectors = img ? [await d.embedder.encodeImage(img.rgba, img.width, img.height)] : []
  check(d.signal)
  await save(d, key, img ? [{ time: 0, shotStart: 0, shotEnd: 0 }] : [], vectors)
}
