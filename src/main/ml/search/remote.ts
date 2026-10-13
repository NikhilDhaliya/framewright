/**
 * Main-process handle on the search utility process (spec 07 §0.3 "ml"). Loading forks the process, loads both towers
 * and runs the warm-up encode; a crash rejects pending calls and the next load forks a fresh process.
 */
import { existsSync } from 'node:fs'
import { APP_NAME } from '../../../shared/brand'
import path from 'node:path'
import { SIGLIP_SPEC, type Embedder } from './siglip'
import type { WorkerReply, WorkerRequest } from './protocol'

type Pending = { resolve: (r: WorkerReply) => void; reject: (e: Error) => void }

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export const searchWorkerFile = (): string => path.join(__dirname, 'searchWorker.cjs')

export async function loadRemoteSiglip(dir: string): Promise<Embedder> {
  const file = searchWorkerFile()
  if (!existsSync(file)) throw new Error(`Search worker is missing (${file})`)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { utilityProcess } = require('electron') as typeof import('electron')
  const child = utilityProcess.fork(file, [], { serviceName: `${APP_NAME} ML (search)`, stdio: 'inherit' })
  const pending = new Map<number, Pending>()
  let nextId = 1
  let dead: Error | null = null
  child.on('message', (msg: WorkerReply) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if ('error' in msg) p.reject(new Error(msg.error))
    else p.resolve(msg)
  })
  child.on('exit', (code) => {
    dead = new Error(`The search model process exited (${code}).`)
    for (const p of pending.values()) p.reject(dead)
    pending.clear()
  })
  const call = (req: DistributiveOmit<WorkerRequest, 'id'>): Promise<WorkerReply> => {
    if (dead) return Promise.reject(dead)
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.postMessage({ ...req, id })
    })
  }
  const vector = (r: WorkerReply): Float32Array => {
    if (!('vector' in r)) throw new Error('Unexpected reply from the search model process')
    return r.vector instanceof Float32Array ? r.vector : Float32Array.from(r.vector as ArrayLike<number>)
  }
  try {
    await call({ op: 'load', dir })
  } catch (e) {
    child.kill()
    throw e
  }
  return {
    spec: SIGLIP_SPEC,
    encodeImage: async (rgba, width, height) => vector(await call({ op: 'image', rgba, width, height })),
    encodeText: async (text) => vector(await call({ op: 'text', text })),
    async dispose() {
      child.kill()
    },
    get alive() {
      return !dead
    },
  } as Embedder
}
