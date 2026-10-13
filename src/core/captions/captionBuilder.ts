/** `CaptionBuilder.swift` — splits transcript segments into caption-sized phrases and maps them to text clip specs. */
import type { Clip, TextAnimation, TextStyle, Transform, WordTiming } from '../model'
import { endFrame } from '../clip'
import { swiftRound } from '../keyframes'
import type { TranscriptionSegment, TranscriptionWord } from './transcript'
import { alphanumericCount, characterCount, graphemes, trimWhitespace, trimWhitespaceAndNewlines, wordCount } from './text'

export interface WordSpan {
  text: string
  start: number
  end: number
}

export interface Phrase {
  text: string
  start: number
  end: number
  /** Member words with their own timings (seconds); empty when word timing is unavailable. */
  words: WordSpan[]
}

/** Text-clip spec shared by the caption builders and placement (`EditorViewModel.TextClipSpec`). */
export interface CaptionClipSpec {
  trackIndex: number
  startFrame: number
  durationFrames: number
  content: string
  style: TextStyle
  transform?: Transform
  captionGroupId?: string
  words?: WordTiming[]
  animation?: TextAnimation
}

export type Fits = (text: string) => boolean

export interface PhraseLimits {
  maxWords?: number
  maxCharacters?: number
}

/** Splits one segment into caption chunks; visual, word and character limits must all accept a phrase. */
export function phrasesForSegment(segment: TranscriptionSegment, words: TranscriptionWord[], fits: Fits, limits: PhraseLimits = {}): Phrase[] {
  const wordCap = limits.maxWords !== undefined ? Math.max(1, limits.maxWords) : undefined
  const charCap = limits.maxCharacters !== undefined ? Math.max(1, limits.maxCharacters) : undefined
  const accept = (text: string) => fits(text) && (wordCap === undefined || wordCount(text) <= wordCap) && (charCap === undefined || characterCount(text) <= charCap)
  return time(split(segment.text, accept), segment, words)
}

export function phrasesFromTimedWords(words: TranscriptionWord[], fits: Fits, limits: PhraseLimits = {}): Phrase[] {
  const timed = words.filter((w) => w.start !== undefined && w.end !== undefined)
  const first = timed[0]
  const last = timed[timed.length - 1]
  if (!first || !last) return []
  const start = first.start!
  const end = last.end!
  if (!(end > start)) return []
  const text = trimWhitespaceAndNewlines(timed.map((w) => w.text).join(' '))
  if (!text) return []
  return phrasesForSegment({ text, start, end, ...(first.speaker !== undefined ? { speaker: first.speaker } : {}) }, timed, fits, limits)
}

function split(text: string, accept: (t: string) => boolean): string[] {
  const t = trimWhitespace(text)
  if (!t) return []
  if (accept(t)) return [t]
  const parts = breakOnce(t)
  if (parts.length <= 1) return [t] // a single over-long word: keep it
  return parts.flatMap((p) => split(p, accept))
}

/** Break once at the best boundary present: sentence, then clause, then midpoint word. */
function breakOnce(text: string): string[] {
  return breakOn(text, '.!?') ?? breakOn(text, ',;:') ?? breakAtMidWord(text)
}

/** Split after delimiters followed by a space (or the end), so "U.S." and "3.14" stay intact. */
function breakOn(text: string, delimiters: string): string[] | null {
  const chars = graphemes(text)
  const pieces: string[] = []
  let current = ''
  chars.forEach((c, i) => {
    current += c
    const nextIsBreak = i + 1 >= chars.length || chars[i + 1] === ' '
    if (delimiters.includes(c) && nextIsBreak) {
      const piece = trimWhitespace(current)
      if (piece) pieces.push(piece)
      current = ''
    }
  })
  const tail = trimWhitespace(current)
  if (tail) pieces.push(tail)
  return pieces.length > 1 ? pieces : null
}

function breakAtMidWord(text: string): string[] {
  const words = text.split(' ').filter((w) => w.length > 0)
  if (words.length < 2) return [text]
  const mid = Math.floor(words.length / 2)
  return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')]
}

/** Times pieces from word runs by matching shared letters/digits, so contractions and punctuation runs keep timing. */
function time(texts: string[], segment: TranscriptionSegment, words: TranscriptionWord[]): Phrase[] {
  const timed = words.flatMap((w) => {
    if (w.start === undefined || w.end === undefined) return []
    const count = alphanumericCount(w.text)
    return count > 0 ? [{ text: w.text, count, start: w.start, end: w.end }] : []
  })
  if (!timed.length) return distribute(texts, segment.start, segment.end)
  const phrases: Phrase[] = []
  let idx = 0
  for (const text of texts) {
    const want = alphanumericCount(text)
    let got = 0
    let first: { start: number; end: number } | null = null
    let last: { start: number; end: number } | null = null
    const spans: WordSpan[] = []
    while (idx < timed.length && got < want) {
      const run = timed[idx]
      if (!first) first = { start: run.start, end: run.end }
      last = { start: run.start, end: run.end }
      spans.push({ text: trimWhitespace(run.text), start: run.start, end: run.end })
      got += run.count
      idx++
    }
    if (!first || !last) break
    phrases.push({ text, start: first.start, end: last.end, words: spans })
  }
  return phrases.length === texts.length ? phrases : distribute(texts, segment.start, segment.end)
}

/** Shares the segment's time across pieces by character count, back to back. */
function distribute(texts: string[], start: number, end: number): Phrase[] {
  if (!texts.length) return []
  const total = texts.reduce((n, t) => n + Math.max(characterCount(t), 1), 0)
  const span = Math.max(end - start, 0)
  const out: Phrase[] = []
  let t = start
  for (const text of texts) {
    const dur = (span * Math.max(characterCount(text), 1)) / total
    out.push({ text, start: t, end: t + dur, words: [] })
    t += dur
  }
  return out
}

const SPEED_FLOOR = 0.0001

/** `Clip.timelineFrame(sourceSeconds:fps:)` (`Models/Timeline.swift:371-378`): nil before the trim or outside [start, end). */
export function timelineFrameForSource(clip: Clip, sourceSeconds: number, fps: number): number | null {
  const sourceFrame = sourceSeconds * fps
  if (sourceFrame < clip.trimStartFrame) return null
  const frame = swiftRound(clip.startFrame + (sourceFrame - clip.trimStartFrame) / Math.max(clip.speed, SPEED_FLOOR))
  return frame >= clip.startFrame && frame < endFrame(clip) ? frame : null
}

export interface SpecOptions {
  trackIndex?: number
  style: TextStyle
  captionGroupId?: string
  animation?: TextAnimation
  transformFor?: (text: string) => Transform | undefined
  minDurationFrames?: number
}

/** Phrases (source seconds) → text clip specs in timeline frames for one source clip (`CaptionBuilder.specs`). */
export function phraseSpecs(phrases: Phrase[], sourceClip: Clip, fps: number, opts: SpecOptions): CaptionClipSpec[] {
  const speed = Math.max(sourceClip.speed, SPEED_FLOOR)
  const visibleStartSource = sourceClip.trimStartFrame
  const visibleEndSource = visibleStartSource + sourceClip.durationFrames * speed
  const clipEnd = endFrame(sourceClip)
  const clamped = (sec: number) => Math.min(Math.max(swiftRound(sourceClip.startFrame + (sec * fps - visibleStartSource) / speed), sourceClip.startFrame), clipEnd)
  const out: CaptionClipSpec[] = []
  for (const p of phrases) {
    if (!(p.end * fps > visibleStartSource && p.start * fps < visibleEndSource)) continue
    const s = timelineFrameForSource(sourceClip, p.start, fps) ?? sourceClip.startFrame
    const e = timelineFrameForSource(sourceClip, p.end, fps) ?? clipEnd
    const duration = Math.max(opts.minDurationFrames ?? 1, Math.min(clipEnd, e) - Math.max(sourceClip.startFrame, s))
    const words: WordTiming[] = []
    for (const w of p.words) {
      if (!(w.end * fps > visibleStartSource && w.start * fps < visibleEndSource)) continue
      const rs = Math.min(Math.max(0, clamped(w.start) - s), duration)
      const re = Math.min(Math.max(rs, clamped(w.end) - s), duration)
      if (re > rs) words.push({ text: w.text, startFrame: rs, endFrame: re })
    }
    const spec: CaptionClipSpec = { trackIndex: opts.trackIndex ?? 0, startFrame: s, durationFrames: duration, content: p.text, style: opts.style }
    const transform = opts.transformFor?.(p.text)
    if (transform) spec.transform = transform
    if (opts.captionGroupId) spec.captionGroupId = opts.captionGroupId
    if (words.length) spec.words = words
    if (opts.animation) spec.animation = opts.animation
    out.push(spec)
  }
  return out
}
