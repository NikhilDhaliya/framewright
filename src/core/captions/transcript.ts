/** Transcript data model (spec 07 §1.1) — the Mac's `Transcription.swift` structs, cached as JSON with nil optionals omitted. */

export type TranscriptionProvider = 'local' | 'cloud'

export interface TranscriptionWord {
  /** Trimmed, never empty. */
  text: string
  /** Seconds in source media time (may be absent). */
  start?: number
  /** Seconds, exclusive. */
  end?: number
  /** File-local diarization label (cloud only). */
  speaker?: string
}

export interface TranscriptionSegment {
  text: string
  start: number
  end: number
  speaker?: string
}

export interface TranscriptionResult {
  text: string
  /** BCP-47 of the locale used (local) or the provider's code (cloud). */
  language?: string
  words: TranscriptionWord[]
  segments: TranscriptionSegment[]
}

/** Drops undefined keys so JSON matches Swift's `JSONEncoder` (nil optionals omitted, keys in declaration order). */
export function normalizedResult(r: TranscriptionResult): TranscriptionResult {
  const word = (w: TranscriptionWord): TranscriptionWord => {
    const o: TranscriptionWord = { text: w.text }
    if (w.start !== undefined) o.start = w.start
    if (w.end !== undefined) o.end = w.end
    if (w.speaker !== undefined) o.speaker = w.speaker
    return o
  }
  const segment = (s: TranscriptionSegment): TranscriptionSegment => {
    const o: TranscriptionSegment = { text: s.text, start: s.start, end: s.end }
    if (s.speaker !== undefined) o.speaker = s.speaker
    return o
  }
  const out: TranscriptionResult = { text: r.text } as TranscriptionResult
  if (r.language !== undefined) out.language = r.language
  out.words = r.words.map(word)
  out.segments = r.segments.map(segment)
  return out
}

/** Shifts a result transcribed from an extracted range back to source time (`Transcription.swift:52-69`). */
export function offsetting(r: TranscriptionResult, offset: number): TranscriptionResult {
  if (offset === 0) return r
  return normalizedResult({
    text: r.text,
    language: r.language,
    words: r.words.map((w) => ({ ...w, start: w.start === undefined ? undefined : w.start + offset, end: w.end === undefined ? undefined : w.end + offset })),
    segments: r.segments.map((s) => ({ ...s, start: s.start + offset, end: s.end + offset })),
  })
}

/** Windows a full transcript to the closed source range [lo, hi] (`TranscriptCache.swift:58-70`). */
export function filterToRange(r: TranscriptionResult, lo: number, hi: number): TranscriptionResult {
  const segments = r.segments.filter((s) => s.end > lo && s.start < hi)
  const words = r.words.filter((w) => w.start !== undefined && w.end !== undefined && w.end > lo && w.start < hi)
  return normalizedResult({ text: segments.map((s) => s.text).join(' '), language: r.language, words, segments })
}

export type TranscriptionErrorKind = 'unsupportedLocale' | 'modelInstallFailed' | 'decodeFailed' | 'audioExtractionFailed' | 'analysisFailed'

/** `TranscriptionError` with the Mac's user-facing strings (`Transcription.swift:72-93`). */
export class TranscriptionError extends Error {
  constructor(
    readonly kind: TranscriptionErrorKind,
    readonly detail = '',
  ) {
    super(TranscriptionError.describe(kind, detail))
    this.name = 'TranscriptionError'
  }

  static describe(kind: TranscriptionErrorKind, detail: string): string {
    switch (kind) {
      case 'unsupportedLocale':
        return `On-device transcription is not available for ${detail}.`
      case 'modelInstallFailed':
        return `Could not install the on-device speech model: ${detail}`
      case 'decodeFailed':
        return 'Could not parse transcription result.'
      case 'audioExtractionFailed':
        return `Audio extraction failed: ${detail}`
      case 'analysisFailed':
        return `Transcription failed: ${detail}`
    }
  }
}

/** Thrown when a job is cancelled; never converted into a TranscriptionError (`failurePreservingCancellation`). */
export class CancellationError extends Error {
  constructor(message = 'Cancelled') {
    super(message)
    this.name = 'CancellationError'
  }
}

export const isCancellation = (e: unknown): boolean => e instanceof CancellationError || (e instanceof Error && e.name === 'AbortError')
