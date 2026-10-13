/** BYOK cloud speech-to-text (spec 07 §1.6): the Linux replacement for Palmier Cloud transcription. */
import type { TranscriptionResult, TranscriptionSegment, TranscriptionWord } from '../../../../core/captions/transcript'

export type CloudProviderId = 'elevenlabs' | 'openai' | 'deepgram'

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>

export interface CloudRequest {
  /** 16 kHz mono 16-bit WAV. */
  wavPath: string
  /** Provider language code; omitted = auto-detect. */
  language?: string
  apiKey: string
  signal?: AbortSignal
  fetch: HttpFetch
  /** Test override of the provider's API origin. */
  baseUrl?: string
}

/** Adapters return source-relative seconds of the WAV; the caller applies `offsetting`. */
export interface CloudSpeechProvider {
  id: CloudProviderId
  label: string
  transcribe(req: CloudRequest): Promise<TranscriptionResult>
}

export class CloudTranscriptionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CloudTranscriptionError'
  }
}

/** Reads a provider error body (`{detail:{message}}`, `{error:{message}}`, …) into one line. */
export async function providerError(provider: string, res: Response): Promise<CloudTranscriptionError> {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const j = JSON.parse(text) as Record<string, unknown>
      const pick = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' ? pick((v as Record<string, unknown>).message ?? (v as Record<string, unknown>).msg ?? '') : '')
      detail = pick(j.detail) || pick(j.error) || pick(j.message) || pick(j.err_msg)
    } catch {
      detail = text.slice(0, 200)
    }
  } catch {
    // No body.
  }
  const reason = res.status === 401 ? 'the API key was rejected' : detail || `HTTP ${res.status}`
  return new CloudTranscriptionError(`${provider}: ${reason}`, res.status)
}

/**
 * Segments for word-only providers: a new segment starts on a speaker change, after a word ending in `.`, `?` or `!`,
 * or at a gap ≥ 1.5 s. Text = the words joined with spaces.
 */
export function groupWordsIntoSegments(words: TranscriptionWord[]): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = []
  let cur: TranscriptionWord[] = []
  const flush = () => {
    const timed = cur.filter((w) => w.start !== undefined && w.end !== undefined)
    if (timed.length) {
      const seg: TranscriptionSegment = { text: cur.map((w) => w.text).join(' '), start: timed[0].start!, end: timed[timed.length - 1].end! }
      if (cur[0].speaker !== undefined) seg.speaker = cur[0].speaker
      segments.push(seg)
    }
    cur = []
  }
  for (const w of words) {
    const prev = cur[cur.length - 1]
    if (prev) {
      const speakerChange = w.speaker !== prev.speaker
      const sentenceEnd = /[.?!]["'”’)\]]*$/.test(prev.text)
      const gap = w.start !== undefined && prev.end !== undefined && w.start - prev.end >= 1.5
      if (speakerChange || sentenceEnd || gap) flush()
    }
    cur.push(w)
  }
  flush()
  return segments
}
