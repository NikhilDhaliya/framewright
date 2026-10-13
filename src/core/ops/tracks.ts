import { normalizeTrackName } from '../codec'
import { TRACK_HEIGHT, type ClipType, type TimelineMarker, type RGBA, newId } from '../model'
import { EditRefusal, firstAudioIndex, insertTrack, sortMarkers } from '../timeline'
import { activeTimeline, multicamGroupName, type Doc } from './context'

export function addTrack(doc: Doc, at: number, type: ClipType): number {
  return insertTrack(activeTimeline(doc), at, type)
}

export function removeTracks(doc: Doc, ids: string[]): void {
  const t = activeTimeline(doc)
  const set = new Set(ids)
  const before = t.tracks.length
  t.tracks = t.tracks.filter((tr) => !set.has(tr.id))
  if (t.tracks.length === before) throw new EditRefusal('No matching tracks.')
}

/** Moves a track within its zone (visual above audio). */
export function reorderTrack(doc: Doc, id: string, targetIndex: number): void {
  const t = activeTimeline(doc)
  const from = t.tracks.findIndex((tr) => tr.id === id)
  if (from < 0) throw new EditRefusal('Track not found.')
  const isAudio = t.tracks[from].type === 'audio'
  const fa = firstAudioIndex(t)
  const lower = isAudio ? fa : 0
  const upper = isAudio ? t.tracks.length - 1 : fa - 1
  const dest = Math.min(Math.max(targetIndex, lower), upper)
  if (dest === from) throw new EditRefusal('Track is already there.')
  const [tr] = t.tracks.splice(from, 1)
  t.tracks.splice(dest, 0, tr)
}

export type TrackFlag = 'muted' | 'hidden' | 'syncLocked'

export function setTrackFlag(doc: Doc, trackIndex: number, flag: TrackFlag, value: boolean): void {
  const t = activeTimeline(doc)
  const tr = t.tracks[trackIndex]
  if (!tr) throw new EditRefusal('Track not found.')
  if (tr[flag] === value) throw new EditRefusal('Unchanged.')
  if (flag === 'syncLocked' && !value) {
    const mc = tr.clips.find((c) => c.multicamGroupId)
    if (mc) throw new EditRefusal(`Can't unlock sync on a multicam track — "${multicamGroupName(doc, mc.multicamGroupId!)}" stays aligned through it.`, true)
  }
  tr[flag] = value
}

export function setTrackHeight(doc: Doc, trackIndex: number, height: number): void {
  const tr = activeTimeline(doc).tracks[trackIndex]
  if (!tr) throw new EditRefusal('Track not found.')
  const h = Math.min(Math.max(height, TRACK_HEIGHT.min), TRACK_HEIGHT.max)
  if (h === tr.displayHeight) throw new EditRefusal('Unchanged.')
  tr.displayHeight = h
}

export function renameTrack(doc: Doc, trackId: string, raw: string): void {
  const tr = activeTimeline(doc).tracks.find((x) => x.id === trackId)
  if (!tr) throw new EditRefusal('Track not found.')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw) || raw.trim().length > 80) throw new EditRefusal('Track names must be one line of at most 80 characters.')
  const name = normalizeTrackName(raw)
  if (name === tr.name) throw new EditRefusal('Unchanged.')
  if (name) tr.name = name
  else delete tr.name
}

// ---------- Markers ----------

export interface MarkerDraft {
  id?: string
  name: string
  startFrame: number
  durationFrames?: number
  color?: RGBA
  comment?: string
  status?: TimelineMarker['status']
}

export function validateMarker(m: TimelineMarker): TimelineMarker {
  const name = m.name.trim()
  // eslint-disable-next-line no-control-regex
  if (!name || [...name].length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new EditRefusal('Marker names must be 1–120 characters on one line.')
  if (m.comment.length > 4000) throw new EditRefusal('Marker comments are limited to 4000 characters.')
  if (!Number.isSafeInteger(m.startFrame) || !Number.isSafeInteger(m.durationFrames) || m.startFrame < 0 || m.durationFrames < 0) throw new EditRefusal('Marker range is invalid.')
  for (const v of [m.color.r, m.color.g, m.color.b, m.color.a]) if (!Number.isFinite(v) || v < 0 || v > 1) throw new EditRefusal('Marker color is invalid.')
  return { ...m, name }
}

export function nextMarkerName(markers: TimelineMarker[]): string {
  const used = new Set(markers.map((m) => m.name))
  let n = 1
  while (used.has(`Marker ${n}`)) n++
  return `Marker ${n}`
}

export interface MarkerChange {
  creates?: MarkerDraft[]
  updates?: TimelineMarker[]
  deleteIds?: string[]
}

export function changeMarkers(doc: Doc, change: MarkerChange): { created: TimelineMarker[]; updated: TimelineMarker[]; deletedIds: string[] } {
  const t = activeTimeline(doc)
  const deleteIds = change.deleteIds ?? []
  const deleteSet = new Set(deleteIds)
  if (deleteSet.size !== deleteIds.length) throw new EditRefusal('Duplicate marker ids.')
  let next = [...t.markers]
  for (const id of deleteSet) if (!next.some((m) => m.id === id)) throw new EditRefusal(`Marker ${id} not found.`)
  const updated: TimelineMarker[] = []
  for (const raw of change.updates ?? []) {
    const m = validateMarker(raw)
    if (deleteSet.has(m.id)) throw new EditRefusal('Cannot update and delete the same marker.')
    const i = next.findIndex((x) => x.id === m.id)
    if (i < 0) throw new EditRefusal(`Marker ${m.id} not found.`)
    if (JSON.stringify(next[i]) !== JSON.stringify(m)) {
      next[i] = m
      updated.push(m)
    }
  }
  next = next.filter((m) => !deleteSet.has(m.id))
  const created = (change.creates ?? []).map((d) =>
    validateMarker({
      id: d.id ?? newId(),
      name: d.name,
      startFrame: d.startFrame,
      durationFrames: d.durationFrames ?? 0,
      color: d.color ?? { r: 0, g: 0.478, b: 1, a: 1 },
      comment: d.comment ?? '',
      status: d.status ?? 'open',
    }),
  )
  next.push(...created)
  if (!created.length && !updated.length && !deleteSet.size) throw new EditRefusal('No marker changes.')
  t.markers = sortMarkers(next)
  return { created, updated, deletedIds: [...deleteSet] }
}
