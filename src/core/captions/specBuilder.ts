/** `CaptionSpecBuilder.swift` — caption specs for a set of transcribed clips or subtitle cues, with gap closing and overlap resolution. */
import { defaultTextStyle, newId, type Clip, type TextAnimation, type TextStyle, type Transform } from '../model'
import { swiftRound } from '../keyframes'
import { phraseSpecs, type CaptionClipSpec, type Fits } from './captionBuilder'
import { clipPhrases } from './transcriptMapper'
import type { TranscriptionResult } from './transcript'
import type { SubtitleCue } from './subtitleFileParser'

export const CAPTION_DEFAULT_FONT_SIZE = 48
export const CAPTION_CENTER_SNAP_VALUE = 0.5
export const CAPTION_CENTER_SNAP_THRESHOLD = 0.02
export const CAPTION_DEFAULT_CENTER = { x: CAPTION_CENTER_SNAP_VALUE, y: 0.9 } as const
/** `captionPreviewMaxTextWidthRatio`: one caption line is at most 90 % of the canvas width. */
export const CAPTION_MAX_TEXT_WIDTH_RATIO = 0.9
export const CAPTION_GAP_RANGE = [0, 2] as const
export const CAPTION_DEFAULT_GAP_SECONDS = 0.5

/** `TextStyle.caption` = the default style at 48 pt. */
export const captionTextStyle = (): TextStyle => ({ ...defaultTextStyle(), fontSize: CAPTION_DEFAULT_FONT_SIZE })

/** Values within 0.02 of 0.5 snap to 0.5 (`CaptionPreviewPlacement.snappedCoordinate`). */
export const snappedCoordinate = (v: number): number => (Math.abs(v - CAPTION_CENTER_SNAP_VALUE) < CAPTION_CENTER_SNAP_THRESHOLD ? CAPTION_CENTER_SNAP_VALUE : v)

export type CaptionCase = 'auto' | 'upper' | 'lower'
export const applyCaptionCase = (c: CaptionCase, s: string): string => (c === 'upper' ? s.toUpperCase() : c === 'lower' ? s.toLowerCase() : s)

/** `CaptionGapSettings(maximumGapSeconds:)`: null unless finite and within [0, 2]. */
export function validGapSeconds(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= CAPTION_GAP_RANGE[0] && v <= CAPTION_GAP_RANGE[1] ? v : null
}

export const maximumGapFrames = (seconds: number, fps: number): number => (fps > 0 && seconds > 0 ? Math.floor(seconds * fps) : 0)

/** Natural box size in canvas pixels (`TextLayout.naturalSize`); `maxWidth` Infinity = unwrapped. */
export type NaturalSize = (text: string, maxWidth: number) => { width: number; height: number }

export interface CaptionLayout {
  canvasWidth: number
  canvasHeight: number
  /** Unwrapped width ≤ 90 % of the canvas width. */
  fits: Fits
  /** Natural size wrapped at 90 % of the canvas width, normalized to the canvas. */
  box: (text: string) => { width: number; height: number }
}

/** Centre-based transform sized to the caption's natural box (`CaptionSpecBuilder.transform`). */
export function captionTransform(box: { width: number; height: number }, center: { x: number; y: number }): Transform {
  return { centerX: center.x, centerY: center.y, width: box.width, height: box.height, rotation: 0, rotationX: 0, rotationY: 0, flipHorizontal: false, flipVertical: false }
}

export interface CaptionTarget {
  clip: Clip
  result: TranscriptionResult
}

export interface CaptionBuildInput {
  targets: CaptionTarget[]
  fps: number
  timelineEndFrame: number
  style: TextStyle
  center: { x: number; y: number }
  textCase: CaptionCase
  maxWords?: number
  maxCharacters?: number
  maximumGapSeconds: number
  animation?: TextAnimation
  layout: CaptionLayout
  captionGroupId?: string
}

export function buildCaptionSpecs(input: CaptionBuildInput): CaptionClipSpec[] {
  const groupId = input.captionGroupId ?? newId()
  const specs: CaptionClipSpec[] = []
  for (const target of input.targets) {
    const phrases = clipPhrases(target.clip, target.result, input.fps, input.layout.fits, { maxWords: input.maxWords, maxCharacters: input.maxCharacters })
    if (!phrases.length) continue
    const cased = phrases.map((p) => ({ ...p, text: applyCaptionCase(input.textCase, p.text) }))
    specs.push(
      ...phraseSpecs(cased, target.clip, input.fps, {
        style: input.style,
        captionGroupId: groupId,
        animation: input.animation,
        transformFor: (text) => captionTransform(input.layout.box(text), input.center),
      }),
    )
  }
  return adjustedCaptionTiming(specs, input.maximumGapSeconds, input.fps, input.timelineEndFrame)
}

/** Specs for subtitle cues: the file's timing is honoured — overlaps are resolved, gaps never closed. */
export function buildCueSpecs(cues: SubtitleCue[], fps: number, style: TextStyle, center: { x: number; y: number }, box: (text: string) => { width: number; height: number }, captionGroupId = newId()): CaptionClipSpec[] {
  const specs = cues.map((cue): CaptionClipSpec => {
    const startFrame = swiftRound(cue.startSeconds * fps)
    const end = swiftRound(cue.endSeconds * fps)
    return { trackIndex: 0, startFrame, durationFrames: Math.max(1, end - startFrame), content: cue.text, style, transform: captionTransform(box(cue.text), center), captionGroupId }
  })
  return adjustedCaptionTiming(specs, 0, fps, 0)
}

interface Timed {
  spec: CaptionClipSpec
  originalDuration: number
}

const specEnd = (s: CaptionClipSpec) => s.startFrame + s.durationFrames
const positiveDistance = (from: number, to: number): number | null => (to - from > 0 ? to - from : null)

/** Resolves collisions, then extends captions across gaps ≤ maximumGap and holds the last one (`adjustedCaptionTiming`). */
export function adjustedCaptionTiming(specs: CaptionClipSpec[], maximumGapSeconds: number, fps: number, timelineEndFrame: number): CaptionClipSpec[] {
  const order = specs.map((_, i) => i).sort((a, b) => specs[a].startFrame - specs[b].startFrame || a - b)
  const captions: Timed[] = order.map((i) => ({ spec: specs[i], originalDuration: specs[i].durationFrames }))
  const maxGap = maximumGapFrames(maximumGapSeconds, fps)
  for (let n = 1; n < captions.length; n++) {
    resolveOverlap(captions[n - 1], captions[n])
    const prev = captions[n - 1]
    const gap = positiveDistance(specEnd(prev.spec), captions[n].spec.startFrame)
    if (maxGap > 0 && gap !== null && gap <= maxGap) {
      const duration = positiveDistance(prev.spec.startFrame, captions[n].spec.startFrame)
      if (duration !== null) prev.spec = resized(prev.spec, duration)
    }
  }
  const last = captions[captions.length - 1]
  if (maxGap > 0 && last) {
    const hold = Math.min(maxGap, Math.max(0, timelineEndFrame - specEnd(last.spec)))
    if (hold > 0) last.spec = resized(last.spec, last.spec.durationFrames + hold)
  }
  return captions.map((c) => c.spec)
}

function resolveOverlap(prev: Timed, next: Timed): void {
  const prevEnd = specEnd(prev.spec)
  if (!(next.spec.startFrame < prevEnd)) return
  if (next.spec.startFrame <= prev.spec.startFrame) {
    // Preserve transcript order when starts quantize to the same frame.
    prev.spec = resized(prev.spec, 1)
    next.spec = shiftStartPreservingEnd(next.spec, specEnd(prev.spec))
    return
  }
  const overlap = positiveDistance(next.spec.startFrame, prevEnd)
  if (overlap === 1 && prev.originalDuration < next.originalDuration) {
    // The shorter caption owns a one-frame rounding collision.
    next.spec = shiftStartPreservingEnd(next.spec, prevEnd)
    return
  }
  const duration = positiveDistance(prev.spec.startFrame, next.spec.startFrame)
  if (duration !== null) prev.spec = resized(prev.spec, duration)
}

function shiftStartPreservingEnd(spec: CaptionClipSpec, startFrame: number): CaptionClipSpec {
  const offset = positiveDistance(spec.startFrame, startFrame) ?? 0
  const end = specEnd(spec)
  return resized({ ...spec, startFrame }, positiveDistance(startFrame, end) ?? 1, offset)
}

function resized(spec: CaptionClipSpec, durationFrames: number, wordOffset = 0): CaptionClipSpec {
  const out: CaptionClipSpec = { ...spec, durationFrames }
  if (!spec.words) return out
  const words = spec.words.flatMap((w) => {
    const start = Math.min(Math.max(0, w.startFrame - wordOffset), durationFrames)
    const end = Math.min(Math.max(start, w.endFrame - wordOffset), durationFrames)
    return end > start ? [{ text: w.text, startFrame: start, endFrame: end }] : []
  })
  if (words.length) out.words = words
  else delete out.words
  return out
}
