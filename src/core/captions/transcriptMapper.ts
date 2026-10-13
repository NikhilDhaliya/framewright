/** `CaptionTranscriptMapper.swift` — which transcript words/segments of a source clip fragment become caption phrases. */
import type { Clip } from '../model'
import { phrasesForSegment, phrasesFromTimedWords, type Fits, type Phrase, type PhraseLimits } from './captionBuilder'
import type { TranscriptionResult, TranscriptionSegment, TranscriptionWord } from './transcript'

const SPEED_FLOOR = 0.0001

/** The clip's visible span in source frames: [trimStart, trimStart + duration·speed]. */
export function sourceSpan(clip: Pick<Clip, 'trimStartFrame' | 'durationFrames' | 'speed'>): { start: number; end: number } {
  const start = clip.trimStartFrame
  return { start, end: start + clip.durationFrames * Math.max(clip.speed, SPEED_FLOOR) }
}

/** Union of the visible source spans of `clips` using `mediaRef`, in seconds, padded on both sides (lower bound ≥ 0). */
export function sourceUnion(mediaRef: string, clips: Clip[], fps: number, paddingSeconds = 1.0): [number, number] | null {
  const spans = clips.filter((c) => c.mediaRef === mediaRef).map(sourceSpan)
  if (!(fps > 0) || !spans.length) return null
  const lo = Math.min(...spans.map((s) => s.start))
  const hi = Math.max(...spans.map((s) => s.end))
  if (!(hi > lo)) return null
  return [Math.max(lo / fps - paddingSeconds, 0), hi / fps + paddingSeconds]
}

/** Transcript words whose midpoint lies in the clip's visible source span. */
export function spokenWordCount(clip: Clip, result: TranscriptionResult, fps: number): number {
  const visible = sourceSpan(clip)
  let count = 0
  for (const w of result.words) {
    if (w.start === undefined || w.end === undefined) continue
    const mid = ((w.start + w.end) / 2) * fps
    if (visible.start <= mid && mid < visible.end) count++
  }
  return count
}

export function clipPhrases(clip: Clip, result: TranscriptionResult, fps: number, fits: Fits, limits: PhraseLimits = {}): Phrase[] {
  if (!(fps > 0)) return []
  const source = sourceSpan(clip)
  const visibleStart = source.start / fps
  const visibleEnd = source.end / fps
  if (!(visibleEnd > visibleStart)) return []
  if (result.words.some((w) => w.start !== undefined && w.end !== undefined)) return phrasesWithWordTimings(visibleStart, visibleEnd, result, fits, limits)
  return result.segments.flatMap((segment) => {
    const start = Math.max(segment.start, visibleStart)
    const end = Math.min(segment.end, visibleEnd)
    if (!(end > start)) return []
    return phrasesForSegment({ ...segment, start, end }, [], fits, limits)
  })
}

function phrasesWithWordTimings(visibleStart: number, visibleEnd: number, result: TranscriptionResult, fits: Fits, limits: PhraseLimits): Phrase[] {
  const segments = result.segments.length ? result.segments : [fallbackSegment(result)]
  const words = result.words
  const phrases: Phrase[] = []
  let wordIndex = 0
  for (const segment of segments) {
    while (wordIndex < words.length) {
      const w = words[wordIndex]
      if (w.start === undefined || w.end === undefined || (w.start + w.end) / 2 < segment.start) {
        wordIndex++
        continue
      }
      break
    }
    const segmentWords: TranscriptionWord[] = []
    for (let i = wordIndex; i < words.length; i++) {
      const w = words[i]
      if (w.start === undefined || w.end === undefined) continue
      const mid = (w.start + w.end) / 2
      if (mid >= segment.end) break
      if (mid >= segment.start && mid >= visibleStart && mid < visibleEnd) segmentWords.push(w)
    }
    if (!segmentWords.length) continue
    phrases.push(...phrasesFromTimedWords(segmentWords, fits, limits))
  }
  return phrases
}

function fallbackSegment(result: TranscriptionResult): TranscriptionSegment {
  const timed = result.words.filter((w) => w.start !== undefined && w.end !== undefined)
  const start = timed.length ? Math.min(...timed.map((w) => w.start!)) : 0
  const end = timed.length ? Math.max(...timed.map((w) => w.end!)) : start
  return { text: result.text, start, end }
}
