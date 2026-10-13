/**
 * Runs `seededCorrelate` off the main thread (one worker per call, terminated on abort). Falls back to inline
 * execution when the bundled worker is absent (unit tests run from sources).
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { seededCorrelate, type CorrelationResult, type SeededCorrelateArgs } from '../../../core/audio/correlator'

const workerFile = () => path.join(__dirname, 'correlateWorker.cjs')

export function correlateOffThread(args: SeededCorrelateArgs, signal?: AbortSignal): Promise<CorrelationResult | null> {
  const file = workerFile()
  const { isCancelled, ...plain } = args
  if (!existsSync(file)) return Promise.resolve(seededCorrelate({ ...plain, isCancelled: () => !!signal?.aborted || !!isCancelled?.() }))
  return new Promise((resolve, reject) => {
    const w = new Worker(file)
    const done = () => {
      signal?.removeEventListener('abort', onAbort)
      void w.terminate()
    }
    const onAbort = () => {
      done()
      resolve(null)
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    w.once('message', (m: { result?: CorrelationResult | null; error?: string }) => {
      done()
      if (m.error) reject(new Error(m.error))
      else resolve(m.result ?? null)
    })
    w.once('error', (e) => {
      done()
      reject(e)
    })
    w.postMessage({ id: 1, args: { ...plain, reference: Float64Array.from(plain.reference as ArrayLike<number>), target: Float64Array.from(plain.target as ArrayLike<number>) } })
  })
}
