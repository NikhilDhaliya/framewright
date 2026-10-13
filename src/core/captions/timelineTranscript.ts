/** Timeline-frame transcripts: Index ▸ Transcript documents (spec 07 §1.11) and the agent word mapping (02 §3.33). Pure. */
import type { Clip, Timeline } from '../model'
import { endFrame } from '../clip'
import { swiftRound } from '../keyframes'
import { phraseSpecs } from './captionBuilder'
import { captionTextStyle } from './specBuilder'
import type { CaptionTarget } from './targets'
import { clipPhrases, sourceSpan } from './transcriptMapper'
import type { TranscriptionResult } from './transcript'

export interface TimelineTranscriptRow {
  id: string
  clipId: string
  text: string
  startFrame: number
  endFrame: number
}

export interface TimelineTranscriptDocument {
  fps: number
  rows: TimelineTranscriptRow[]
  sourceTrackId?: string
  sourceCaptionGroupId?: string
}

/** One row per transcript sentence piece (no fit/word/char limits), sorted by (start, id). */
export function makeTimelineTranscriptDocument(targets: CaptionTarget[], results: Map<string, TranscriptionResult>, fps: number): TimelineTranscriptDocument {
  const style = captionTextStyle()
  const rows = targets.flatMap((target) => {
    const result = results.get(target.clip.mediaRef)
    if (!result) return []
    const phrases = clipPhrases(target.clip, result, fps, () => true)
    return phraseSpecs(phrases, target.clip, fps, { style }).map(
      (spec, index): TimelineTranscriptRow => ({
        id: `${target.clip.id}:${index}:${spec.startFrame}`,
        clipId: target.clip.id,
        text: spec.content,
        startFrame: spec.startFrame,
        endFrame: spec.startFrame + spec.durationFrames,
      }),
    )
  })
  rows.sort(byStartThenId)
  return { fps, rows }
}

const byStartThenId = (a: { startFrame: number; id: string }, b: { startFrame: number; id: string }) =>
  a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** One document per caption group per track, visible tracks first (`TranscriptBrowserNavigation.captionFallbacks`). */
export function captionFallbacks(t: Timeline): TimelineTranscriptDocument[] {
  const tracks = [...t.tracks.filter((x) => !x.hidden), ...t.tracks.filter((x) => x.hidden)]
  const docs: TimelineTranscriptDocument[] = []
  for (const track of tracks) {
    const groupIds = [...new Set(track.clips.map((c) => c.captionGroupId).filter((g): g is string => !!g))]
    for (const groupId of groupIds) {
      const rows = track.clips
        .filter((c) => c.mediaType === 'text' && c.captionGroupId === groupId)
        .map((c) => ({ id: c.id, clipId: c.id, text: c.textContent ?? '', startFrame: c.startFrame, endFrame: endFrame(c) }))
        .sort(byStartThenId)
      docs.push({ fps: t.fps, rows, sourceTrackId: track.id, sourceCaptionGroupId: groupId })
    }
  }
  return docs
}

/** `localizedCaseInsensitiveContains` over trimmed queries; an empty query keeps every row. */
export function rowsMatching(rows: TimelineTranscriptRow[], query: string): TimelineTranscriptRow[] {
  const q = query.trim().toLocaleLowerCase()
  if (!q) return rows
  return rows.filter((r) => r.text.toLocaleLowerCase().includes(q))
}

/** `TranscriptBrowserTimelineIndex`: the row under the playhead, falling back to the longest-running earlier row. */
export class TranscriptTimelineIndex {
  private readonly longest: number[] = []

  constructor(private readonly rows: TimelineTranscriptRow[]) {
    let li = 0
    rows.forEach((r, i) => {
      if (r.endFrame >= rows[li].endFrame) li = i
      this.longest.push(li)
    })
  }

  currentRow(frame: number): TimelineTranscriptRow | null {
    let lo = 0
    let hi = this.rows.length
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2)
      if (this.rows[mid].startFrame <= frame) lo = mid + 1
      else hi = mid
    }
    if (lo === 0) return null
    const latest = this.rows[lo - 1]
    if (frame < latest.endFrame) return latest
    if (lo - 1 === 0) return null
    const fallback = this.rows[this.longest[lo - 2]]
    return frame < fallback.endFrame ? fallback : null
  }
}

const SPEED_FLOOR = 0.0001

/** A source-seconds span clamped to the clip's visible span and mapped to project frames, or null when outside. */
export function spanFrames(start: number, end: number, clip: Clip, fps: number): { start: number; end: number } | null {
  const visible = sourceSpan(clip)
  const s = Math.max(start * fps, visible.start)
  const e = Math.min(end * fps, visible.end)
  if (!(e > s)) return null
  const toTimeline = (src: number) => swiftRound(clip.startFrame + (src - visible.start) / Math.max(clip.speed, SPEED_FLOOR))
  const mapped = toTimeline(s)
  return { start: mapped, end: Math.max(mapped, toTimeline(e)) }
}

export interface ClipWordRow {
  start: number
  end: number
  text: string
  speaker?: string
}

/** Words whose midpoint falls in the clip's visible span, mapped to project frames, sorted by (start, end). */
export function clipWordRows(transcript: TranscriptionResult, clip: Clip, fps: number): ClipWordRow[] {
  const visible = sourceSpan(clip)
  const rows: ClipWordRow[] = []
  for (const w of transcript.words) {
    if (w.start === undefined || w.end === undefined) continue
    const mid = ((w.start + w.end) / 2) * fps
    if (!(mid >= visible.start && mid < visible.end)) continue
    const f = spanFrames(w.start, w.end, clip, fps)
    if (!f) continue
    rows.push({ start: f.start, end: f.end, text: w.text, ...(w.speaker !== undefined ? { speaker: w.speaker } : {}) })
  }
  return rows.sort((a, b) => a.start - b.start || a.end - b.end)
}
