/** Messages between main and the search utility process. */
export type WorkerRequest =
  | { id: number; op: 'load'; dir: string; threads?: number }
  | { id: number; op: 'image'; rgba: Uint8Array; width: number; height: number }
  | { id: number; op: 'text'; text: string }

export type WorkerReply = { id: number; ok: true } | { id: number; vector: Float32Array } | { id: number; error: string }
