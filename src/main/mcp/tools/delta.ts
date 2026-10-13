/** Mutation receipts: the before/after difference of the active timeline in get_timeline vocabulary. */
import type { TimelineMarker } from '../../../core/model'
import { activeTimeline, type Doc } from '../../../core/ops/context'
import { trackDisplayLabel } from '../../../core/timeline'
import type { Obj } from './args'
import { ok, type ToolResult } from './context'
import { jsonString, roundFloats } from './json'
import { compactTracks, focusedRawTracks, markerDict } from './timelineView'

interface Placement {
  trackId: string
  index: number
  start: number
  duration: number
}

export interface TimelineSnapshot {
  placements: Map<string, Placement>
  trackIds: string[]
  markers: Map<string, string>
}

const CLIP_LIMIT = 30
const SHIFT_GROUP_MINIMUM = 3

export function snapshot(doc: Doc): TimelineSnapshot {
  const t = activeTimeline(doc)
  const placements = new Map<string, Placement>()
  t.tracks.forEach((tr, index) => {
    for (const c of tr.clips) placements.set(c.id, { trackId: tr.id, index, start: c.startFrame, duration: c.durationFrames })
  })
  return { placements, trackIds: t.tracks.map((tr) => tr.id), markers: new Map(t.markers.map((m: TimelineMarker) => [m.id, JSON.stringify(m)])) }
}

export interface DeltaOptions {
  touched?: string[]
  extra?: Obj
  notes?: string[]
}

function collapseCaptionGroups(doc: Doc, changed: Set<string>): Obj[] {
  const t = activeTimeline(doc)
  const gidByMember = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const tr of t.tracks)
    for (const c of tr.clips)
      if (changed.has(c.id) && c.captionGroupId) {
        gidByMember.set(c.id, c.captionGroupId)
        counts.set(c.captionGroupId, (counts.get(c.captionGroupId) ?? 0) + 1)
      }
  const collapsed = new Set([...counts].filter(([, n]) => n >= SHIFT_GROUP_MINIMUM).map(([g]) => g))
  if (!collapsed.size) return []
  for (const [id, gid] of gidByMember) if (collapsed.has(gid)) changed.delete(id)
  const out: Obj[] = []
  for (const track of compactTracks(t, focusedRawTracks(t, new Set(), collapsed), null, false)) {
    for (const group of (track.captionGroups as Obj[] | undefined) ?? []) {
      if (collapsed.has(group.captionGroupId as string)) out.push({ ...group, track: track.index ?? 0 })
    }
  }
  return out
}

function readShapedClips(doc: Doc, ids: Set<string>): Obj[] {
  if (!ids.size) return []
  const t = activeTimeline(doc)
  const byId = new Map<string, Obj>()
  for (const track of compactTracks(t, focusedRawTracks(t, ids), null, true)) {
    const index = track.index as number
    for (const raw of (track.clips as Obj[] | undefined) ?? []) {
      const clip: Obj = { ...raw, track: index }
      byId.set(clip.id as string, clip)
      const audio = clip.audio as Obj | undefined
      if (typeof audio?.id === 'string') byId.set(audio.id, clip)
    }
    for (const group of (track.captionGroups as Obj[] | undefined) ?? []) {
      for (const row of (group.clips as unknown[][] | undefined) ?? []) {
        if (row.length < 4 || typeof row[0] !== 'string') continue
        byId.set(row[0], { id: row[0], track: index, frames: [row[1], row[2]], textContent: row[3], captionGroupId: group.captionGroupId ?? '' })
      }
    }
  }
  t.tracks.forEach((tr, index) => {
    for (const c of tr.clips) {
      if (!ids.has(c.id) || byId.has(c.id)) continue
      const entry: Obj = { id: c.id, track: index, frames: [c.startFrame, c.startFrame + c.durationFrames] }
      if (c.textContent !== undefined) entry.textContent = c.textContent
      if (c.captionGroupId) entry.captionGroupId = c.captionGroupId
      byId.set(c.id, entry)
    }
  })
  const seen = new Set<string>()
  const key = (c: Obj): [number, number] => [(c.track as number) ?? 0, ((c.frames as number[] | undefined) ?? [0])[0]]
  return [...ids]
    .flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    .filter((c) => {
      const id = c.id as string
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1])
}

/** `mutationResult`: changed clips, shift rules, removals, marker changes, created tracks and notes. */
export function mutationPayload(doc: Doc, before: TimelineSnapshot, o: DeltaOptions = {}): Obj {
  const after = snapshot(doc)
  const t = activeTimeline(doc)
  const notes = [...(o.notes ?? [])]
  const changed = new Set((o.touched ?? []).filter((id) => after.placements.has(id)))
  for (const id of after.placements.keys()) if (!before.placements.has(id)) changed.add(id)
  const pureShifts = new Map<string, { from: number; delta: number }>()
  for (const [id, p] of after.placements) {
    const b = before.placements.get(id)
    if (!b || changed.has(id) || (b.trackId === p.trackId && b.start === p.start && b.duration === p.duration)) continue
    if (b.trackId === p.trackId && b.duration === p.duration) pureShifts.set(id, { from: b.start, delta: p.start - b.start })
    else changed.add(id)
  }
  const grouped = new Map<string, string[]>()
  for (const [id, s] of pureShifts) {
    const k = `${after.placements.get(id)!.index}|${s.delta}`
    grouped.set(k, [...(grouped.get(k) ?? []), id])
  }
  const shifts: { track: number; fromFrame: number; by: number; count: number }[] = []
  for (const ids of grouped.values()) {
    if (ids.length >= SHIFT_GROUP_MINIMUM) {
      shifts.push({
        track: after.placements.get(ids[0])!.index,
        fromFrame: Math.min(...ids.map((id) => pureShifts.get(id)!.from)),
        by: pureShifts.get(ids[0])!.delta,
        count: ids.length,
      })
    } else for (const id of ids) changed.add(id)
  }
  shifts.sort((a, b) => a.track - b.track || a.fromFrame - b.fromFrame)

  const payload: Obj = { ...(o.extra ?? {}) }
  const captionGroups = collapseCaptionGroups(doc, changed)
  if (captionGroups.length) payload.captionGroups = captionGroups
  let clips = readShapedClips(doc, changed)
  if (clips.length > CLIP_LIMIT) {
    payload.clipsNote = `Showing ${CLIP_LIMIT} of ${clips.length} changed clips — re-read get_timeline for the rest.`
    clips = clips.slice(0, CLIP_LIMIT)
  }
  if (clips.length) payload.clips = clips
  if (shifts.length) payload.shifted = shifts
  const removed = [...before.placements.keys()].filter((id) => !after.placements.has(id)).sort()
  if (removed.length) payload.removedClipIds = removed
  const changedMarkers = t.markers.filter((m) => before.markers.get(m.id) !== JSON.stringify(m))
  if (changedMarkers.length) payload.markers = changedMarkers.map(markerDict)
  const remainingMarkers = new Set(t.markers.map((m) => m.id))
  const removedMarkers = [...before.markers.keys()].filter((id) => !remainingMarkers.has(id)).sort()
  if (removedMarkers.length) payload.removedMarkerIds = removedMarkers
  const created = after.trackIds.flatMap((id, i) => (before.trackIds.includes(id) ? [] : [{ index: i, label: trackDisplayLabel(t, i), type: t.tracks[i].type }]))
  if (created.length) payload.createdTracks = created
  const afterIds = new Set(after.trackIds)
  const shiftedTracks = before.trackIds.some((id) => !afterIds.has(id)) || after.trackIds.some((id, i) => before.trackIds.includes(id) && before.trackIds.indexOf(id) !== i)
  if (shiftedTracks && payload.tracks === undefined) notes.push('Track indices shifted — re-read get_timeline before the next index-based call.')
  if (notes.length) payload.notes = notes
  return payload
}

export function mutationResult(doc: Doc, before: TimelineSnapshot, o: DeltaOptions = {}): ToolResult {
  return ok(jsonString(roundFloats(mutationPayload(doc, before, o))))
}
