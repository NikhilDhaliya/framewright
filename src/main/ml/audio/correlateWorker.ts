/** Worker-thread entry for the sync correlator (spec 07 §3.7 "Run it in a worker thread"). */
import { parentPort } from 'node:worker_threads'
import { seededCorrelate, type SeededCorrelateArgs } from '../../../core/audio/correlator'

parentPort?.on('message', (msg: { id: number; args: Omit<SeededCorrelateArgs, 'isCancelled'> }) => {
  try {
    parentPort!.postMessage({ id: msg.id, result: seededCorrelate(msg.args) })
  } catch (e) {
    parentPort!.postMessage({ id: msg.id, error: e instanceof Error ? e.message : String(e) })
  }
})
