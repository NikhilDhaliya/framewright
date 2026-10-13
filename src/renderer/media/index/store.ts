/** Index tab state (spec 07 §1.11): mode, transcript slot, source selection and search. Session only. */
import { create } from 'zustand'
import type { TimelineTranscriptDocument } from '@core/captions/timelineTranscript'
import { timelineOf, useProject } from '../../state/project'

export type IndexMode = 'transcript' | 'markers'
export type TranscriptSource = { kind: 'automatic' } | { kind: 'transcript' } | { kind: 'captions'; groupId: string }

interface IndexState {
  mode: IndexMode
  /** Generated or cache-loaded transcript; cache auto-load only fills an empty slot. */
  transcript: TimelineTranscriptDocument | null
  /** Timeline the transcript belongs to. */
  transcriptTimelineId: string | null
  source: TranscriptSource
  query: string
  searchExpanded: boolean
}

export const useIndex = create<IndexState>(() => ({ mode: 'transcript', transcript: null, transcriptTimelineId: null, source: { kind: 'automatic' }, query: '', searchExpanded: false }))
export const setIndex = (patch: Partial<IndexState>) => useIndex.setState(patch)

/** After captions are generated the media panel shows Index ▸ Transcript with the automatic source (MediaPanelView.swift:60-64). */
export function showGeneratedCaptions(): void {
  setIndex({ mode: 'transcript', source: { kind: 'automatic' }, query: '', searchExpanded: false })
}

// MediaPanelView.swift:84-89: any timeline render change empties the transcript slot (the Index tab refills it from
// the transcript cache); switching the active timeline resets the source to automatic.
let lastTimelineKey = ''
let lastTimelineId: string | null = null
useProject.subscribe((s) => {
  const t = timelineOf(s.snapshot?.doc)
  const key = t ? JSON.stringify([t.id, t.fps, t.width, t.height, t.tracks]) : ''
  if (key === lastTimelineKey) return
  lastTimelineKey = key
  const patch: Partial<IndexState> = {}
  if (useIndex.getState().transcript) Object.assign(patch, { transcript: null, transcriptTimelineId: null })
  if ((t?.id ?? null) !== lastTimelineId) {
    lastTimelineId = t?.id ?? null
    patch.source = { kind: 'automatic' }
  }
  if (Object.keys(patch).length) setIndex(patch)
})

export function publishTranscript(doc: TimelineTranscriptDocument, timelineId: string): void {
  setIndex({ transcript: doc, transcriptTimelineId: timelineId, source: { kind: 'transcript' } })
}
