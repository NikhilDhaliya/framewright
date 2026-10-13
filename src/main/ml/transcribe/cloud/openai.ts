/** OpenAI whisper-1 (spec 07 §1.6): word times, no speakers, 25 MB uploads — longer audio is split at silences. */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { normalizedResult, offsetting, type TranscriptionResult } from '../../../../core/captions/transcript'
import { readWav16, writeWav16, type Pcm16 } from '../audio'
import { CloudTranscriptionError, providerError, type CloudRequest, type CloudSpeechProvider } from './types'

/** Stay well under the 25 MB limit (multipart overhead). */
export const OPENAI_MAX_UPLOAD_BYTES = 24 * 1024 * 1024
const CHUNK_SECONDS = 600
const SEARCH_SECONDS = 30
const WINDOW_SECONDS = 0.1

/** Chunk boundaries (sample indices) every ≤ `chunkSeconds`, each moved to the quietest 100 ms in the preceding 30 s. */
export function silenceSplitPoints(pcm: Pcm16, chunkSeconds = CHUNK_SECONDS): number[] {
  const rate = pcm.sampleRate
  const n = pcm.samples.length
  const chunk = Math.floor(chunkSeconds * rate)
  const win = Math.max(1, Math.floor(WINDOW_SECONDS * rate))
  const points: number[] = []
  let start = 0
  while (n - start > chunk) {
    const hardEnd = start + chunk
    const searchFrom = Math.max(start + win, hardEnd - Math.floor(SEARCH_SECONDS * rate))
    let best = hardEnd
    let bestEnergy = Infinity
    for (let w = searchFrom; w + win <= hardEnd; w += win) {
      let e = 0
      for (let i = w; i < w + win; i++) e += pcm.samples[i] * pcm.samples[i]
      if (e < bestEnergy) {
        bestEnergy = e
        best = w + Math.floor(win / 2)
      }
    }
    points.push(best)
    start = best
  }
  return points
}

interface VerboseJson {
  text?: string
  language?: string
  words?: { word?: string; start?: number; end?: number }[]
  segments?: { text?: string; start?: number; end?: number }[]
}

/** whisper-1 reports language names ("english"); map the common ones to ISO codes, else keep the name. */
const LANGUAGE_CODES: Record<string, string> = { english: 'en', spanish: 'es', french: 'fr', german: 'de', italian: 'it', portuguese: 'pt', japanese: 'ja', korean: 'ko', chinese: 'zh', hindi: 'hi', arabic: 'ar', russian: 'ru', dutch: 'nl', polish: 'pl', turkish: 'tr', swedish: 'sv' }

async function transcribeOne(req: CloudRequest, wavPath: string): Promise<TranscriptionResult> {
  const form = new FormData()
  form.set('model', 'whisper-1')
  form.set('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.append('timestamp_granularities[]', 'segment')
  if (req.language) form.set('language', req.language)
  form.set('file', new Blob([await fs.readFile(wavPath)], { type: 'audio/wav' }), path.basename(wavPath))
  const res = await req.fetch(`${req.baseUrl ?? 'https://api.openai.com'}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${req.apiKey}` }, body: form, signal: req.signal })
  if (!res.ok) throw await providerError('OpenAI', res)
  const j = (await res.json().catch(() => null)) as VerboseJson | null
  if (!j || typeof j.text !== 'string') throw new CloudTranscriptionError('OpenAI: unexpected response')
  const words = (j.words ?? []).flatMap((w) => {
    const text = (w.word ?? '').trim()
    return text && typeof w.start === 'number' && typeof w.end === 'number' ? [{ text, start: w.start, end: w.end }] : []
  })
  const segments = (j.segments ?? []).flatMap((s) => {
    const text = (s.text ?? '').trim()
    return text && typeof s.start === 'number' && typeof s.end === 'number' ? [{ text, start: s.start, end: s.end }] : []
  })
  const lang = j.language ? (LANGUAGE_CODES[j.language.toLowerCase()] ?? j.language) : undefined
  return normalizedResult({ text: j.text.trim(), language: lang, words, segments })
}

export const openai: CloudSpeechProvider = {
  id: 'openai',
  label: 'OpenAI',
  async transcribe(req) {
    const size = (await fs.stat(req.wavPath)).size
    if (size <= OPENAI_MAX_UPLOAD_BYTES) return transcribeOne(req, req.wavPath)
    const pcm = await readWav16(req.wavPath)
    const bounds = [0, ...silenceSplitPoints(pcm), pcm.samples.length]
    const parts: TranscriptionResult[] = []
    for (let i = 0; i + 1 < bounds.length; i++) {
      const file = path.join(os.tmpdir(), `framewright-stt-${randomUUID()}.wav`)
      try {
        await writeWav16(file, { sampleRate: pcm.sampleRate, samples: pcm.samples.subarray(bounds[i], bounds[i + 1]) })
        parts.push(offsetting(await transcribeOne(req, file), bounds[i] / pcm.sampleRate))
      } finally {
        await fs.rm(file, { force: true })
      }
    }
    return normalizedResult({
      text: parts.map((p) => p.text).filter(Boolean).join(' '),
      language: parts.find((p) => p.language)?.language,
      words: parts.flatMap((p) => p.words),
      segments: parts.flatMap((p) => p.segments),
    })
  },
}
