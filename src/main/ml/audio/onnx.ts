/**
 * onnxruntime-node sessions (spec 07 §3.9) for Silero VAD and Beat This. Sessions are created lazily from the model
 * bytes (works from inside app.asar), cached per file, and a load failure is remembered (the Mac's VAD rule).
 * Inference is async on ORT's own thread pool, so the main thread only marshals tensors.
 */
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import type { InferenceSession, Tensor } from 'onnxruntime-node'

type Ort = typeof import('onnxruntime-node')

let ort: Ort | null = null
function runtime(): Ort {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  ort ??= require('onnxruntime-node') as Ort
  return ort
}

const sessions = new Map<string, Promise<InferenceSession>>()

export function onnxSession(file: string, threads = Math.max(1, Math.floor(os.cpus().length / 2))): Promise<InferenceSession> {
  let s = sessions.get(file)
  if (!s) {
    s = readFile(file).then((bytes) =>
      runtime().InferenceSession.create(bytes, {
        executionProviders: ['cpu'],
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      }),
    )
    sessions.set(file, s)
    s.catch(() => undefined)
  }
  return s
}

export function tensor(type: 'float32', data: Float32Array, dims: number[]): Tensor
export function tensor(type: 'int64', data: BigInt64Array, dims: number[]): Tensor
export function tensor(type: 'float32' | 'int64', data: Float32Array | BigInt64Array, dims: number[]): Tensor {
  return new (runtime().Tensor)(type, data, dims)
}

/** Releases every cached session (tests, shutdown). */
export async function releaseSessions(): Promise<void> {
  const all = [...sessions.values()]
  sessions.clear()
  await Promise.all(all.map((p) => p.then((s) => s.release()).catch(() => undefined)))
}
