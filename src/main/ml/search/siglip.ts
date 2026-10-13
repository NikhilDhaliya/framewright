/**
 * SigLIP 2 B/16-256 ONNX towers + Gemma tokenizer (spec 07 §2.7). This module does the actual inference; in the app it
 * runs only inside the "ml" utility process (`worker.ts`), never on the main or renderer threads. Tests may use it
 * directly.
 */
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { InferenceSession } from 'onnxruntime-node'
import { imageToPixelValues, l2Normalize, padTokenIds, SIGLIP_CONTEXT_LENGTH, SIGLIP_IMAGE_SIZE } from '../../../core/search/preprocess'

type Ort = typeof import('onnxruntime-node')

export interface EmbedderSpec {
  model: string
  version: number
  embeddingDim: number
  imageSize: number
  contextLength: number
}

/** Linux ONNX build: model version 101 (spec 07 §2.4) so Mac/Linux origin is explicit. */
export const SIGLIP_SPEC: EmbedderSpec = { model: 'siglip2-base-patch16-256', version: 101, embeddingDim: 768, imageSize: SIGLIP_IMAGE_SIZE, contextLength: SIGLIP_CONTEXT_LENGTH }

export const SIGLIP_FILES = {
  vision: 'onnx/vision_model_quantized.onnx',
  text: 'onnx/text_model_quantized.onnx',
  tokenizer: 'tokenizer.json',
} as const

/** Image + text encoders; both return L2-normalized vectors of `spec.embeddingDim`. */
export interface Embedder {
  readonly spec: EmbedderSpec
  /** RGBA bytes of any size (composited over black, squash-resized here). */
  encodeImage(rgba: Uint8Array, width: number, height: number): Promise<Float32Array>
  encodeText(text: string): Promise<Float32Array>
  dispose(): Promise<void>
}

interface TokenizerLike {
  encode(text: string): { ids: number[] }
}

/**
 * Gemma tokenizer from `tokenizer.json` through `@huggingface/tokenizers`. The tokenizer config is deliberately not
 * passed: `tokenizer_config.json` sets `do_lower_case`, but the Mac (swift-transformers) does not lower-case and its
 * goldens were generated without it (spec 07 §2.7).
 */
export async function loadTokenizer(file: string): Promise<{ tokenize(text: string): number[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Tokenizer } = require('@huggingface/tokenizers') as { Tokenizer: new (json: object, config: object) => TokenizerLike }
  const json = JSON.parse(await readFile(file, 'utf8')) as object
  const tok = new Tokenizer(json, {})
  return { tokenize: (text: string) => padTokenIds(tok.encode(text).ids) }
}

let ortModule: Ort | null = null
function ort(): Ort {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ortModule ??= require('onnxruntime-node') as Ort
  return ortModule
}

async function session(file: string, threads: number): Promise<InferenceSession> {
  return ort().InferenceSession.create(await readFile(file), {
    executionProviders: ['cpu'],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
  })
}

/** Serializes inference: one at a time, like the Mac's `MLXRuntime` gate. */
class Gate {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn)
    this.tail = next.catch(() => undefined)
    return next
  }
}

export async function loadSiglip(dir: string, opts: { threads?: number } = {}): Promise<Embedder> {
  const threads = opts.threads ?? Math.max(1, Math.floor(os.cpus().length / 2))
  const [vision, text, tokenizer] = await Promise.all([
    session(path.join(dir, SIGLIP_FILES.vision), threads),
    session(path.join(dir, SIGLIP_FILES.text), threads),
    loadTokenizer(path.join(dir, SIGLIP_FILES.tokenizer)),
  ])
  const gate = new Gate()
  const { Tensor } = ort()
  const spec = SIGLIP_SPEC
  const pooled = (out: Record<string, { data: unknown }>): Float32Array => {
    const data = out.pooler_output?.data
    if (!(data instanceof Float32Array) || data.length !== spec.embeddingDim) throw new Error('Unexpected SigLIP output')
    return l2Normalize(Float32Array.from(data))
  }
  return {
    spec,
    encodeImage: (rgba, width, height) =>
      gate.run(async () => {
        const px = imageToPixelValues(rgba, width, height, spec.imageSize)
        return pooled(await vision.run({ pixel_values: new Tensor('float32', px, [1, 3, spec.imageSize, spec.imageSize]) }))
      }),
    encodeText: (t) =>
      gate.run(async () => {
        const ids = BigInt64Array.from(tokenizer.tokenize(t).map((x) => BigInt(x)))
        return pooled(await text.run({ input_ids: new Tensor('int64', ids, [1, spec.contextLength]) }))
      }),
    async dispose() {
      await Promise.all([vision.release(), text.release()]).catch(() => undefined)
    },
  }
}
