/** Mention hint text for the model (spec 06 §A5.2; AgentMentionContext.swift). */
import type { Clip } from '../../core/model'
import { activeTimeline, type Doc } from '../../core/ops/context'
import { endFrame } from '../../core/clip'
import type { AgentMention } from '../../shared/agent'
import { sortedJson } from './sse'

export const referencedMentions = (mentions: AgentMention[], text: string): AgentMention[] => mentions.filter((m) => text.includes('@' + m.displayName))

/** clipDisplayLabel: text content (newlines → spaces) or "Text"; generating asset name; nested timeline name; else media name. */
export function clipDisplayLabel(doc: Doc, clip: Clip): string {
  if (clip.mediaType === 'text') {
    const t = (clip.textContent ?? '').replace(/\r\n|\r|\n/g, ' ')
    return t.trim() ? t : 'Text'
  }
  if (clip.sourceClipType === 'sequence' || clip.mediaType === 'sequence') {
    const tl = doc.file.timelines.find((t) => t.id === clip.mediaRef)
    if (tl) return tl.name
  }
  return doc.manifest.entries.find((e) => e.id === clip.mediaRef)?.name ?? ''
}

function clipSummary(clipId: string, doc: Doc | null): Record<string, unknown> {
  if (!doc) return { clipId, error: 'editor unavailable' }
  const t = doc.file.timelines.length ? activeTimeline(doc) : { tracks: [] }
  for (let trackIndex = 0; trackIndex < t.tracks.length; trackIndex++) {
    const track = t.tracks[trackIndex]
    const clip = track.clips.find((c) => c.id === clipId)
    if (!clip) continue
    return {
      clipId: clip.id,
      mediaRef: clip.mediaRef,
      mediaType: clip.mediaType,
      sourceClipType: clip.sourceClipType,
      label: clipDisplayLabel(doc, clip),
      trackIndex,
      trackType: track.type,
      startFrame: clip.startFrame,
      endFrame: endFrame(clip),
      durationFrames: clip.durationFrames,
      trimStartFrame: clip.trimStartFrame,
      trimEndFrame: clip.trimEndFrame,
      speed: clip.speed,
    }
  }
  return { clipId, error: 'clip not found' }
}

export function mentionEntries(mentions: AgentMention[], doc: Doc | null): Record<string, unknown>[] {
  return mentions.map((m) => {
    const entry: Record<string, unknown> = { mention: '@' + m.displayName }
    if (m.timelineRange) {
      const r = m.timelineRange
      entry.kind = 'timelineRange'
      entry.timelineRange = {
        startFrame: r.startFrame,
        endFrame: r.endFrame,
        durationFrames: r.durationFrames,
        fps: r.fps,
        startTimecode: r.startTimecode,
        endTimecode: r.endTimecode,
        durationTimecode: r.durationTimecode,
        rangeSemantics: r.rangeSemantics,
      }
      return entry
    }
    entry.kind = m.clipId === undefined ? 'mediaAsset' : 'timelineClip'
    if (m.mediaRef !== undefined) entry.mediaRef = m.mediaRef
    if (m.type !== undefined) entry.type = m.type
    if (m.clipId !== undefined) {
      entry.clipId = m.clipId
      entry.clip = clipSummary(m.clipId, doc)
    }
    return entry
  })
}

/** `Referenced assets and timeline context in this message: <JSON>.<NOTES>` */
export function mentionHint(mentions: AgentMention[], doc: Doc | null): string {
  const notes: string[] = []
  if (mentions.some((m) => m.clipId !== undefined)) {
    notes.push('Entries with "clipId" refer to timeline clips; use clipId for timeline edits and pass it to inspect_media when inspecting visible source media.')
  }
  if (mentions.some((m) => m.timelineRange !== undefined)) {
    notes.push('Entries with "timelineRange" refer to selected timeline time spans; their frame ranges are half-open: startFrame inclusive, endFrame exclusive.')
  }
  const suffix = notes.length ? ' ' + notes.join(' ') : ''
  return `Referenced assets and timeline context in this message: ${sortedJson(mentionEntries(mentions, doc))}.${suffix}`
}
