/**
 * Entry of the "ml" utility process for visual search (spec 07 §0.3, §2.7): owns the SigLIP ONNX sessions so inference
 * never runs on the main or renderer threads. Built to `out/main/searchWorker.cjs`.
 */
import { loadSiglip, type Embedder } from './siglip'
import type { WorkerReply, WorkerRequest } from './protocol'

interface ParentPort {
  on(event: 'message', cb: (e: { data: WorkerRequest }) => void): void
  postMessage(msg: WorkerReply): void
}

const port = (process as unknown as { parentPort?: ParentPort }).parentPort
let embedder: Embedder | null = null
let loading: Promise<Embedder> | null = null

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

port?.on('message', ({ data: msg }) => {
  void (async () => {
    try {
      switch (msg.op) {
        case 'load': {
          loading ??= loadSiglip(msg.dir, { threads: msg.threads })
          embedder = await loading
          // Warm-up encode, as the Mac does before reporting ready.
          await embedder.encodeText('warm up')
          return port.postMessage({ id: msg.id, ok: true })
        }
        case 'image': {
          if (!embedder) throw new Error('Search model is not loaded')
          const vector = await embedder.encodeImage(msg.rgba, msg.width, msg.height)
          return port.postMessage({ id: msg.id, vector })
        }
        case 'text': {
          if (!embedder) throw new Error('Search model is not loaded')
          const vector = await embedder.encodeText(msg.text)
          return port.postMessage({ id: msg.id, vector })
        }
      }
    } catch (e) {
      loading = embedder ? loading : null
      port.postMessage({ id: msg.id, error: errorMessage(e) })
    }
  })()
})
