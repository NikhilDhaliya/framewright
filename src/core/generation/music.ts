/** Audio ▸ Music section rules (spec 06 §B8, Mac `MusicTab.swift`): source span, summary, duration range, validation note. */
import type { Timeline } from '../model'
import { totalFrames } from '../timeline'
import type { AudioModel } from './models'
import { validateAudioParams, validateAudioSpan } from './validation'

export type MusicMode = 'video' | 'text'

export interface TimelineSpan {
  startFrame: number
  frameCount: number
}

/** `selectedTimelineSpan`: the valid marked range, else the whole timeline; null when the timeline is empty. */
export function musicSourceSpan(t: Timeline, range: { start: number; end: number } | null | undefined): TimelineSpan | null {
  if (range) {
    const start = Math.max(0, Math.min(range.start, range.end))
    const end = Math.max(range.start, range.end)
    if (end > start) return { startFrame: start, frameCount: end - start }
  }
  const total = totalFrames(t)
  return total > 0 ? { startFrame: 0, frameCount: total } : null
}

const clock = (frame: number, fps: number): string => {
  const total = frame / Math.max(1, fps)
  const m = Math.trunc(total / 60)
  const s = Math.trunc(total) % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** `Whole timeline · m:ss – m:ss · 12.3s`, or just the range when one is marked. */
export function musicSourceSummary(span: TimelineSpan, fps: number, ranged: boolean): string {
  const seconds = span.frameCount / Math.max(1, fps)
  const text = `${clock(span.startFrame, fps)} – ${clock(span.startFrame + span.frameCount, fps)} · ${seconds.toFixed(1)}s`
  return ranged ? text : `Whole timeline · ${text}`
}

export function musicTextDurationRange(m: AudioModel | null): { min: number; max: number } {
  const r = m?.durationRange
  return r ? { min: r.minimum, max: r.maximum } : { min: 1, max: 600 }
}

/** `selectModel`: snaps the text duration into the model's range or list. */
export function snapMusicDuration(m: AudioModel, current: number): number {
  const r = m.durationRange
  if (r) return current >= r.minimum && current <= r.maximum ? current : r.defaultValue
  const list = m.durations
  if (list && !list.includes(Math.round(current))) return list[0] ?? 90
  return current
}

/** The red note under the section (`validationNote`), or null when Generate is allowed. */
export function musicValidationNote(m: AudioModel | null, mode: MusicMode, prompt: string, seconds: number, hasSpan: boolean): string | null {
  if (!m) return 'No music models available.'
  if (mode === 'text') {
    const p = prompt.trim()
    if (!p) return 'Describe the music to generate.'
    return validateAudioParams(m, { kind: 'audio', prompt: p, instrumental: false, durationSeconds: Math.round(seconds) })
  }
  if (!hasSpan) return 'Add video to the timeline, then mark a range to score only part of it.'
  return validateAudioSpan(m, seconds)
}
