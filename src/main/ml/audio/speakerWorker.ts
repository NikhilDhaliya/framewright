/**
 * "speech" process (spec 07 §3.9): sherpa-onnx-node 1.13.8 (its own ORT 1.28.2, so never in the same process as
 * onnxruntime-node). Forked with IPC (advanced serialization); one request at a time.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
type Sherpa = {
  OfflineSpeakerDiarization: new (c: unknown) => { process(x: Float32Array): { start: number; end: number; speaker: number }[] }
  SpeakerEmbeddingExtractor: new (c: unknown) => {
    createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void; inputFinished(): void }
    compute(s: unknown, ext?: boolean): Float32Array
  }
}

let sherpa: Sherpa | null = null
const diarizers = new Map<string, InstanceType<Sherpa['OfflineSpeakerDiarization']>>()
const extractors = new Map<string, InstanceType<Sherpa['SpeakerEmbeddingExtractor']>>()

type Req =
  | { id: number; op: 'diarize'; samples: Float32Array; segmentation: string; embedding: string; threshold: number; threads: number }
  | { id: number; op: 'embed'; samples: Float32Array; embedding: string; threads: number }

process.on('message', (m: Req) => {
  try {
    sherpa ??= require('sherpa-onnx-node') as Sherpa
    if (m.op === 'diarize') {
      const key = `${m.segmentation}|${m.embedding}|${m.threshold}`
      let d = diarizers.get(key)
      if (!d) {
        d = new sherpa.OfflineSpeakerDiarization({
          segmentation: { pyannote: { model: m.segmentation }, numThreads: m.threads },
          embedding: { model: m.embedding, numThreads: m.threads },
          clustering: { numClusters: -1, threshold: m.threshold },
          minDurationOn: 0.3,
          minDurationOff: 0.5,
        })
        diarizers.set(key, d)
      }
      process.send!({ id: m.id, result: d.process(m.samples) })
    } else {
      let x = extractors.get(m.embedding)
      if (!x) {
        x = new sherpa.SpeakerEmbeddingExtractor({ model: m.embedding, numThreads: m.threads })
        extractors.set(m.embedding, x)
      }
      const s = x.createStream()
      s.acceptWaveform({ sampleRate: 16000, samples: m.samples })
      s.inputFinished()
      process.send!({ id: m.id, result: Array.from(x.compute(s, false)) })
    }
  } catch (e) {
    process.send!({ id: m.id, error: e instanceof Error ? e.message : String(e) })
  }
})
