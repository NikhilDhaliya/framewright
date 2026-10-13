/**
 * Silero VAD v5.1.2 (spec 07 §3.2) over onnxruntime-node: 512-sample chunks at 16 kHz with the previous chunk's last
 * 64 samples prepended (speech-swift's contract), LSTM state reset per file, last partial chunk zero-padded.
 */
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { VAD_CHUNK_SAMPLES, VAD_CONTEXT_SAMPLES, VAD_SAMPLE_RATE } from '../../../core/audio/vad'
import { onnxSession, tensor } from './onnx'
import { resourcePath } from './resources'

export const sileroModelPath = () => resourcePath('models', 'silero_vad.onnx')

const WINDOW = VAD_CONTEXT_SAMPLES + VAD_CHUNK_SAMPLES

/** Push-based streaming VAD: feed any-size sample blocks, collect one probability per 32 ms chunk. */
export class SileroStream {
  readonly probs: number[] = []
  private readonly pending = new Float32Array(VAD_CHUNK_SAMPLES)
  private fill = 0
  private context = new Float32Array(VAD_CONTEXT_SAMPLES)
  private state: Tensor
  private readonly sr = tensor('int64', BigInt64Array.from([BigInt(VAD_SAMPLE_RATE)]), [])
  private chain: Promise<void> = Promise.resolve()
  private failure: unknown = null
  private queued = 0

  constructor(private readonly session: InferenceSession) {
    this.state = tensor('float32', new Float32Array(2 * 128), [2, 1, 128])
  }

  static async open(): Promise<SileroStream> {
    return new SileroStream(await onnxSession(sileroModelPath(), 1))
  }

  /** Queues samples; inference is chained so callers can push while earlier chunks run. */
  push(x: Float32Array): void {
    let i = 0
    while (i < x.length) {
      const n = Math.min(VAD_CHUNK_SAMPLES - this.fill, x.length - i)
      this.pending.set(x.subarray(i, i + n), this.fill)
      this.fill += n
      i += n
      if (this.fill === VAD_CHUNK_SAMPLES) this.enqueue()
    }
  }

  private enqueue(): void {
    const input = new Float32Array(WINDOW)
    input.set(this.context, 0)
    input.set(this.pending, VAD_CONTEXT_SAMPLES)
    this.context = input.slice(WINDOW - VAD_CONTEXT_SAMPLES)
    this.pending.fill(0)
    this.fill = 0
    this.queued++
    this.chain = this.chain.then(async () => {
      this.queued--
      if (this.failure) return
      try {
        const out = await this.session.run({ input: tensor('float32', input, [1, WINDOW]), state: this.state, sr: this.sr })
        this.state = out.stateN
        this.probs.push((out.output.data as Float32Array)[0])
      } catch (e) {
        this.failure = e
      }
    })
  }

  /** Back-pressure for the decoder: a promise while more than `limit` chunks wait for inference. */
  drain(limit = 256): Promise<void> | undefined {
    return this.queued > limit ? this.chain : undefined
  }

  /** Flushes the zero-padded tail and resolves with every chunk probability. */
  async finish(): Promise<number[]> {
    if (this.fill > 0) this.enqueue()
    await this.chain
    if (this.failure) throw this.failure
    return this.probs
  }
}
