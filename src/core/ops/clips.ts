import { deepClone } from '../util'
import { endFrame, freshenClipIds, setClipDuration, sourceFramesConsumed, supportsRetiming, clampFadesToDuration, clampKeyframesToDuration, rescaleKeyframes, rescaleWordTimings } from '../clip'
import { fitTransform, isCompatibleType, isVisualType, newClip, newId, type Clip, type Timeline } from '../model'
import {
  EditRefusal,
  allClips,
  applyShifts,
  clearRegion,
  computeRipplePush,
  computeRippleShiftsForRanges,
  expandToLinkGroup,
  findClip,
  firstAudioIndex,
  insertTrack,
  linkedPartnerIds,
  mergeRanges,
  multicamAtomicityViolation,
  multicamManualRippleViolation,
  pruneEmptyTracks,
  removeClips,
  resolveOrCreateAudioTrack,
  rippleMarkersClosing,
  rippleMarkersOpening,
  round,
  sortAllClips,
  sortClips,
  splitClip,
  splitClips,
  totalFrames,
  trackDisplayLabel,
  validateShifts,
  wouldCreateNestCycle,
  type FrameRange,
} from '../timeline'
import { activeTimeline, assetFrames, clipDurationFrames, multicamGroupName, placeableAsset, timelineById, type Doc, type PlaceableAsset, type Segment } from './context'

export interface EditOptions {
  rippleMarkers: boolean
}
const defaultOptions: EditOptions = { rippleMarkers: true }

function applyRippledMarkers(t: Timeline, next: Timeline['markers'], opts: EditOptions): void {
  if (opts.rippleMarkers) t.markers = next
}

// ---------- Placement ----------

export interface PlaceOptions {
  addLinkedAudio?: boolean
  linkedAudioTrackIndex?: number
  segment?: Segment
  trimStartFrame?: number
  trimEndFrame?: number
}

/** Creates a clip (and linked audio for video with sound) without clearing the region. */
export function placeClip(doc: Doc, t: Timeline, asset: PlaceableAsset, trackIndex: number, startFrame: number, durationFrames: number, o: PlaceOptions = {}): string[] {
  const track = t.tracks[trackIndex]
  if (!track) return []
  const fps = t.fps
  const shouldLink = (o.addLinkedAudio ?? true) && track.type === 'video' && asset.hasAudio && (asset.type === 'video' || asset.type === 'sequence')
  const gid = shouldLink ? newId() : undefined
  const segTrimStart = o.segment ? Math.trunc(o.segment.lower * fps) : 0
  const total = assetFrames(asset, fps)
  const applyTrim = (c: Clip) => {
    const consumed = round(durationFrames * c.speed)
    if (o.segment) {
      c.trimStartFrame = segTrimStart
      c.trimEndFrame = Math.max(0, total - segTrimStart - consumed)
    } else {
      const s = Math.max(0, o.trimStartFrame ?? 0)
      c.trimStartFrame = s
      if (total > 0) {
        const tail = Math.max(0, total - s - consumed)
        c.trimEndFrame = Math.min(o.trimEndFrame ?? tail, tail)
      } else if (o.trimEndFrame !== undefined) c.trimEndFrame = o.trimEndFrame
    }
  }
  const visualType = track.type === 'audio' ? 'audio' : asset.type
  const v = newClip({
    mediaRef: asset.id,
    mediaType: visualType,
    sourceClipType: asset.type,
    startFrame,
    durationFrames,
    transform: isVisualType(visualType) ? fitTransform(asset.sourceWidth ?? 0, asset.sourceHeight ?? 0, t.width, t.height) : fitTransform(0, 0, 0, 0),
  })
  if (gid) v.linkGroupId = gid
  applyTrim(v)
  track.clips.push(v)
  sortClips(track)
  const ids = [v.id]
  if (gid) {
    const valid = o.linkedAudioTrackIndex !== undefined && t.tracks[o.linkedAudioTrackIndex]?.type === 'audio'
    const ai = valid ? o.linkedAudioTrackIndex! : resolveOrCreateAudioTrack(t, startFrame, durationFrames)
    const ac = newClip({ mediaRef: asset.id, mediaType: 'audio', sourceClipType: asset.type, startFrame, durationFrames, linkGroupId: gid })
    applyTrim(ac)
    t.tracks[ai].clips.push(ac)
    sortClips(t.tracks[ai])
    ids.push(ac.id)
  }
  return ids
}

function createClips(doc: Doc, t: Timeline, assets: PlaceableAsset[], trackIndex: number, startFrame: number, segments: Record<string, Segment> = {}, linkedAudioTrackIndex?: number): string[] {
  let cursor = startFrame
  const trackId = t.tracks[trackIndex]?.id
  const audioId = linkedAudioTrackIndex !== undefined ? t.tracks[linkedAudioTrackIndex]?.id : undefined
  const out: string[] = []
  for (const a of assets) {
    const ti = t.tracks.findIndex((x) => x.id === trackId)
    if (ti < 0) break
    const ai = audioId ? t.tracks.findIndex((x) => x.id === audioId) : -1
    const d = clipDurationFrames(a, t.fps, segments[a.id])
    out.push(...placeClip(doc, t, a, ti, cursor, d, { segment: segments[a.id], linkedAudioTrackIndex: ai >= 0 ? ai : undefined }))
    cursor += d
  }
  return out
}

function resolveAssets(doc: Doc, ids: string[]): PlaceableAsset[] {
  return ids.map((id) => {
    const a = placeableAsset(doc, id)
    if (!a) throw new EditRefusal(`Media "${id}" doesn't exist.`)
    return a
  })
}

/** Overwrite edit: clears the target region and places assets back to back. */
export function addClips(doc: Doc, assetIds: string[], trackIndex: number, startFrame: number, linkedAudioTrackIndex?: number, segments: Record<string, Segment> = {}): string[] {
  const t = activeTimeline(doc)
  const assets = resolveAssets(doc, assetIds)
  guardNestCycles(doc, t, assets)
  const vId = t.tracks[trackIndex]?.id
  if (!vId) throw new EditRefusal('Track not found.')
  const aId = linkedAudioTrackIndex !== undefined ? t.tracks[linkedAudioTrackIndex]?.id : undefined
  const total = assets.reduce((s, a) => s + clipDurationFrames(a, t.fps, segments[a.id]), 0)
  clearRegion(t, trackIndex, startFrame, startFrame + total)
  if (aId) clearRegion(t, t.tracks.findIndex((x) => x.id === aId), startFrame, startFrame + total)
  const vi = t.tracks.findIndex((x) => x.id === vId)
  const ai = aId ? t.tracks.findIndex((x) => x.id === aId) : undefined
  const ids = vi >= 0 ? createClips(doc, t, assets, vi, startFrame, segments, ai) : []
  pruneEmptyTracks(t)
  return ids
}

function guardNestCycles(doc: Doc, t: Timeline, assets: PlaceableAsset[]): void {
  for (const a of assets) {
    if (a.type !== 'sequence') continue
    const child = timelineById(doc, a.id)!
    if (totalFrames(child) === 0) throw new EditRefusal(`"${child.name}" is empty. Add clips before nesting it.`)
    if (wouldCreateNestCycle(doc.file.timelines, a.id, t.id)) throw new EditRefusal(`Can't nest "${child.name}" — it would contain itself.`)
  }
}

export type DropTarget = { existing: number } | { newAt: number }

export function resolveVisualDropTarget(t: Timeline, cursor: DropTarget): DropTarget {
  const count = t.tracks.length
  const fa = firstAudioIndex(t)
  if (count === 0) return { newAt: 0 }
  if ('existing' in cursor) {
    const i = cursor.existing
    if (i < 0 || i >= count) return { newAt: 0 }
    if (t.tracks[i].type !== 'audio') return { existing: i }
    const mirrored = fa - 1 - (i - fa)
    if (mirrored >= 0 && mirrored < fa) return { existing: mirrored }
    return fa > 0 ? { existing: 0 } : { newAt: 0 }
  }
  const k = cursor.newAt
  return k <= fa ? { newAt: k } : { newAt: Math.max(0, fa - (k - fa)) }
}

export function resolveAudioDropTarget(t: Timeline, cursor: DropTarget): DropTarget {
  const count = t.tracks.length
  const fa = firstAudioIndex(t)
  const audioCount = count - fa
  if (count === 0) return { newAt: 1 }
  if ('newAt' in cursor) {
    const k = cursor.newAt
    return k > fa ? { newAt: k } : { newAt: fa + Math.min(fa - k, audioCount) }
  }
  const i = cursor.existing
  if (audioCount === 0) return { newAt: count }
  if (t.tracks[i]?.type === 'audio') return { existing: i }
  const mirrored = fa + (fa - 1 - i)
  return { existing: mirrored >= fa && mirrored < count ? mirrored : fa }
}

function materialize(t: Timeline, target: DropTarget, type: 'video' | 'audio'): number {
  if ('existing' in target) return target.existing
  return insertTrack(t, target.newAt, type)
}

/** Drop from the media panel: visual assets to a video track, audio-only assets to an audio track. */
export function placeDroppedAssets(doc: Doc, assetIds: string[], cursor: DropTarget, atFrame: number, ripple: boolean, segments: Record<string, Segment> = {}, opts: EditOptions = defaultOptions): string[] {
  const t = activeTimeline(doc)
  const assets = resolveAssets(doc, assetIds).filter((a) => a.type !== 'subtitle')
  guardNestCycles(doc, t, assets)
  const visual = assets.filter((a) => isVisualType(a.type))
  const audioOnly = assets.filter((a) => !isVisualType(a.type) && a.type === 'audio')
  const anyAudio = assets.some((a) => a.type === 'audio' || ((a.type === 'video' || a.type === 'sequence') && a.hasAudio))
  let visualTarget = visual.length ? resolveVisualDropTarget(t, cursor) : null
  let audioTarget = anyAudio ? resolveAudioDropTarget(t, cursor) : null
  let vIdx: number | null = null
  if (visualTarget) vIdx = materialize(t, visualTarget, 'video')
  if (audioTarget && visualTarget && 'newAt' in visualTarget) {
    const v = vIdx!
    if ('existing' in audioTarget && audioTarget.existing >= visualTarget.newAt) audioTarget = { existing: audioTarget.existing + 1 }
    else if ('newAt' in audioTarget && audioTarget.newAt >= visualTarget.newAt) audioTarget = { newAt: audioTarget.newAt + 1 }
    void v
  }
  const aIdx = audioTarget ? materialize(t, audioTarget, 'audio') : null
  const aTrackId = aIdx !== null ? t.tracks[aIdx].id : undefined
  const vTrackId = vIdx !== null ? t.tracks[vIdx].id : undefined
  const ids: string[] = []
  const idx = (id?: string) => (id ? t.tracks.findIndex((x) => x.id === id) : -1)
  if (visual.length && vTrackId) {
    ids.push(...(ripple ? rippleInsertAssets(doc, visual.map((a) => a.id), idx(vTrackId), atFrame, segments, opts, idx(aTrackId)) : addClips(doc, visual.map((a) => a.id), idx(vTrackId), atFrame, idx(aTrackId) >= 0 ? idx(aTrackId) : undefined, segments)))
  }
  if (audioOnly.length && aTrackId && idx(aTrackId) >= 0) {
    ids.push(...(ripple ? rippleInsertAssets(doc, audioOnly.map((a) => a.id), idx(aTrackId), atFrame, segments, opts) : addClips(doc, audioOnly.map((a) => a.id), idx(aTrackId), atFrame, undefined, segments)))
  }
  pruneEmptyTracks(t)
  return ids
}

/** Ripple insert: opens a gap on the target, linked-audio and sync-locked tracks, splitting straddlers. */
export function rippleInsertAssets(doc: Doc, assetIds: string[], trackIndex: number, atFrame: number, segments: Record<string, Segment> = {}, opts: EditOptions = defaultOptions, linkedAudioTrackIndex?: number): string[] {
  const t = activeTimeline(doc)
  const assets = resolveAssets(doc, assetIds)
  guardNestCycles(doc, t, assets)
  const track = t.tracks[trackIndex]
  if (!track) throw new EditRefusal('Track not found.')
  const needsAudio = track.type === 'video' && assets.some((a) => (a.type === 'video' || a.type === 'sequence') && a.hasAudio)
  let audioId: string | undefined
  if (needsAudio) {
    const ai = linkedAudioTrackIndex !== undefined && linkedAudioTrackIndex >= 0 && t.tracks[linkedAudioTrackIndex]?.type === 'audio' ? linkedAudioTrackIndex : firstAudioIndex(t) < t.tracks.length ? firstAudioIndex(t) : insertTrack(t, t.tracks.length, 'audio')
    audioId = t.tracks[ai].id
  }
  const pushIds = new Set(t.tracks.filter((tr, i) => i === trackIndex || tr.id === audioId || tr.syncLocked).map((tr) => tr.id))
  const violation = multicamManualRippleViolation(t, pushIds, atFrame, (id) => multicamGroupName(doc, id))
  if (violation) throw new EditRefusal(violation, true)
  const totalPush = assets.reduce((s, a) => s + clipDurationFrames(a, t.fps, segments[a.id]), 0)
  for (const tr of [...t.tracks]) {
    if (!pushIds.has(tr.id)) continue
    const straddler = tr.clips.find((c) => c.startFrame < atFrame && atFrame < endFrame(c))
    if (straddler) splitClip(t, straddler.id, atFrame)
  }
  for (const tr of t.tracks) if (pushIds.has(tr.id)) applyShifts(t, computeRipplePush(tr.clips, atFrame, totalPush))
  applyRippledMarkers(t, rippleMarkersOpening(t.markers, atFrame, totalPush), opts)
  const ti = t.tracks.findIndex((x) => x.id === track.id)
  const ai = audioId ? t.tracks.findIndex((x) => x.id === audioId) : undefined
  return createClips(doc, t, assets, ti, atFrame, segments, ai)
}

// ---------- Move / duplicate / paste ----------

export interface ClipMove {
  clipId: string
  toTrack: number
  toFrame: number
}

function multicamMoveViolation(doc: Doc, t: Timeline, moves: { clip: Clip; fromTrack: number; toTrack: number; toFrame: number }[]): string | null {
  const horizontal = moves.some((m) => m.clip.startFrame !== m.toFrame)
  const laneChange = moves.some((m) => m.clip.multicamGroupId && m.clip.mediaType !== 'audio' && m.fromTrack !== m.toTrack)
  if (!horizontal && !laneChange) return null
  if (laneChange) return "Can't move a multicam camera clip to another track — the group's program track stays fixed."
  const moving = new Set(moves.map((m) => m.clip.id))
  const groups = new Set(moves.map((m) => m.clip.multicamGroupId).filter((g): g is string => !!g))
  for (const g of groups) {
    if (allClips(t).some((c) => c.multicamGroupId === g && !moving.has(c.id))) return `Can't move part of multicam group "${multicamGroupName(doc, g)}" — its clips stay in sync and move together.`
  }
  return null
}

export function moveClips(doc: Doc, moves: ClipMove[]): void {
  const t = activeTimeline(doc)
  const infos = moves.flatMap((m) => {
    const loc = findClip(t, m.clipId)
    const dst = t.tracks[m.toTrack]
    if (!loc || !dst) return []
    if (!isCompatibleType(dst.type, loc.track.type)) return []
    return [{ clip: loc.clip, fromTrack: loc.trackIndex, toTrack: m.toTrack, toTrackId: dst.id, toFrame: Math.max(0, m.toFrame) }]
  })
  if (!infos.length) throw new EditRefusal('Nothing to move.')
  const violation = multicamMoveViolation(doc, t, infos)
  if (violation) throw new EditRefusal(violation, true)
  const snapshot = infos.map((i) => ({ ...i, clip: deepClone(i.clip) }))
  removeClips(t, snapshot.map((i) => i.clip.id), false)
  for (const i of snapshot) clearRegion(t, t.tracks.findIndex((x) => x.id === i.toTrackId), i.toFrame, i.toFrame + i.clip.durationFrames)
  for (const i of snapshot) {
    const tr = t.tracks.find((x) => x.id === i.toTrackId)
    tr?.clips.push({ ...i.clip, startFrame: i.toFrame })
  }
  sortAllClips(t)
  pruneEmptyTracks(t)
}

export interface ClonePlacement {
  source: Clip
  trackId: string
  dstStart: number
}

export function cloneClipsAt(t: Timeline, placements: ClonePlacement[]): string[] {
  const groupCounts = new Map<string, number>()
  for (const p of placements) if (p.source.linkGroupId) groupCounts.set(p.source.linkGroupId, (groupCounts.get(p.source.linkGroupId) ?? 0) + 1)
  const groups = new Map<string, string>()
  for (const p of placements) clearRegion(t, t.tracks.findIndex((x) => x.id === p.trackId), p.dstStart, p.dstStart + p.source.durationFrames)
  const ids: string[] = []
  for (const p of placements) {
    const clone: Clip = { ...deepClone(p.source), startFrame: p.dstStart }
    freshenClipIds(clone, groups)
    delete clone.multicamGroupId
    if (p.source.linkGroupId && (groupCounts.get(p.source.linkGroupId) ?? 0) <= 1) delete clone.linkGroupId
    const tr = t.tracks.find((x) => x.id === p.trackId)
    if (!tr) continue
    tr.clips.push(clone)
    ids.push(clone.id)
  }
  sortAllClips(t)
  pruneEmptyTracks(t)
  return ids
}

export function duplicateClipsToPositions(doc: Doc, moves: ClipMove[]): string[] {
  const t = activeTimeline(doc)
  const placements = moves.flatMap((m) => {
    const loc = findClip(t, m.clipId)
    const dst = t.tracks[m.toTrack]
    if (!loc || !dst || !isCompatibleType(dst.type, loc.clip.mediaType)) return []
    return [{ source: deepClone(loc.clip), trackId: dst.id, dstStart: Math.max(0, m.toFrame) }]
  })
  if (!placements.length) throw new EditRefusal('Nothing to duplicate.')
  return cloneClipsAt(t, placements)
}

export interface ClipboardEntry {
  clip: Clip
  trackOffset: number
  frameOffset: number
  sourceTrackId: string
  sourceTrackType: string
}

export function copyClips(t: Timeline, ids: Iterable<string>): ClipboardEntry[] {
  const set = new Set(ids)
  const captures = t.tracks.flatMap((tr, ti) => tr.clips.filter((c) => set.has(c.id)).map((c) => ({ clip: deepClone(c), ti, tr })))
  captures.sort((a, b) => a.ti - b.ti || a.clip.startFrame - b.clip.startFrame || (a.clip.id < b.clip.id ? -1 : 1))
  if (!captures.length) return []
  const minTrack = captures[0].ti
  const minStart = Math.min(...captures.map((c) => c.clip.startFrame))
  return captures.map((c) => ({ clip: c.clip, trackOffset: c.ti - minTrack, frameOffset: c.clip.startFrame - minStart, sourceTrackId: c.tr.id, sourceTrackType: c.tr.type }))
}

export function pasteClips(doc: Doc, clipboard: ClipboardEntry[], trackIndex: number | null, frame: number): string[] {
  const t = activeTimeline(doc)
  if (!clipboard.length) throw new EditRefusal('The clipboard is empty.')
  let dest = trackIndex
  if (dest === null) {
    const anchor = clipboard[0]
    const src = t.tracks.findIndex((x) => x.id === anchor.sourceTrackId)
    if (src >= 0 && isCompatibleType(t.tracks[src].type, anchor.clip.mediaType)) dest = src
    else dest = t.tracks.findIndex((x) => isCompatibleType(x.type, anchor.clip.mediaType))
    if (dest < 0) {
      dest = insertTrack(t, isVisualType(anchor.clip.mediaType) ? 0 : t.tracks.length, isVisualType(anchor.clip.mediaType) ? 'video' : 'audio')
    }
  }
  const base = Math.max(0, frame)
  const placements = clipboard.flatMap((e) => {
    let dst = dest! + e.trackOffset
    if (!t.tracks[dst] || !isCompatibleType(t.tracks[dst].type, e.clip.mediaType)) {
      const fallback = t.tracks.findIndex((x) => isCompatibleType(x.type, e.clip.mediaType))
      if (fallback < 0) return []
      dst = fallback
    }
    if (e.clip.sourceClipType === 'sequence' && wouldCreateNestCycle(doc.file.timelines, e.clip.mediaRef, t.id)) return []
    return [{ source: e.clip, trackId: t.tracks[dst].id, dstStart: base + e.frameOffset }]
  })
  if (!placements.length) throw new EditRefusal('No compatible track to paste into.')
  return cloneClipsAt(t, placements)
}

// ---------- Delete / ripple delete ----------

export function deleteClips(doc: Doc, ids: Iterable<string>): number {
  const t = activeTimeline(doc)
  const n = removeClips(t, ids, true)
  if (!n) throw new EditRefusal('No clips to delete.')
  return n
}

export function rippleDeleteClips(doc: Doc, idsIn: Iterable<string>, opts: EditOptions = defaultOptions): void {
  const t = activeTimeline(doc)
  const ids = new Set(idsIn)
  const selected = allClips(t).filter((c) => ids.has(c.id))
  if (!selected.length) throw new EditRefusal('No clips to delete.')
  const global: FrameRange[] = selected.map((c) => ({ start: c.startFrame, end: endFrame(c) }))
  const shifting = new Set(t.tracks.filter((tr) => tr.syncLocked || tr.clips.some((c) => ids.has(c.id))).map((tr) => tr.id))
  for (const r of global) {
    const v = multicamManualRippleViolation(t, shifting, r.end, (id) => multicamGroupName(doc, id))
    if (v) throw new EditRefusal(v, true)
  }
  const shifts: ReturnType<typeof computeRippleShiftsForRanges> = []
  const markerRanges: FrameRange[][] = []
  t.tracks.forEach((tr, ti) => {
    const own = tr.clips.filter((c) => ids.has(c.id))
    if (own.length) {
      const removed = own.map((c) => ({ start: c.startFrame, end: endFrame(c) }))
      shifts.push(...computeRippleShiftsForRanges(tr.clips.filter((c) => !ids.has(c.id)), removed))
      markerRanges.push(removed)
    } else if (tr.syncLocked) {
      const s = computeRippleShiftsForRanges(tr.clips, global)
      const reason = validateShifts(t, ti, s)
      if (reason) throw new EditRefusal(reason, true)
      shifts.push(...s)
      markerRanges.push(global)
    }
  })
  removeClips(t, ids, true)
  applyShifts(t, shifts)
  applyRippledMarkers(t, rippleMarkersClosing(t.markers, markerRanges), opts)
}

export interface Gap {
  trackIndex: number
  start: number
  end: number
}

export function gapAt(t: Timeline, trackIndex: number, frame: number): Gap | null {
  const tr = t.tracks[trackIndex]
  if (!tr || tr.clips.some((c) => c.startFrame <= frame && frame < endFrame(c))) return null
  const next = tr.clips.filter((c) => c.startFrame > frame).map((c) => c.startFrame)
  if (!next.length) return null
  const prev = tr.clips.filter((c) => endFrame(c) <= frame).map((c) => endFrame(c))
  return { trackIndex, start: prev.length ? Math.max(...prev) : 0, end: Math.min(...next) }
}

export function rippleDeleteGapRefusal(doc: Doc, gap: Gap): string | null {
  const t = activeTimeline(doc)
  const shifting = new Set(t.tracks.filter((tr, i) => i === gap.trackIndex || tr.syncLocked).map((tr) => tr.id))
  const v = multicamManualRippleViolation(t, shifting, gap.end, (id) => multicamGroupName(doc, id))
  if (v) return v
  for (let i = 0; i < t.tracks.length; i++) {
    if (i === gap.trackIndex || !t.tracks[i].syncLocked) continue
    const r = validateShifts(t, i, computeRippleShiftsForRanges(t.tracks[i].clips, [{ start: gap.start, end: gap.end }]))
    if (r) return r
  }
  return null
}

export function rippleDeleteGap(doc: Doc, gap: Gap, opts: EditOptions = defaultOptions): void {
  const t = activeTimeline(doc)
  const tr = t.tracks[gap.trackIndex]
  if (!tr || gap.end <= gap.start) throw new EditRefusal('No gap selected.')
  if (tr.clips.some((c) => c.startFrame < gap.end && endFrame(c) > gap.start)) throw new EditRefusal('The gap is no longer empty.')
  const reason = rippleDeleteGapRefusal(doc, gap)
  if (reason) throw new EditRefusal(reason, true)
  const range = { start: gap.start, end: gap.end }
  t.tracks.forEach((x, i) => {
    if (i === gap.trackIndex || x.syncLocked) applyShifts(t, computeRippleShiftsForRanges(x.clips, [range]))
  })
  applyRippledMarkers(t, rippleMarkersClosing(t.markers, [[range]]), opts)
}

/** Extract: clears ranges on the anchor (plus linked and sync-locked tracks) and closes the time. */
export function rippleDeleteRanges(doc: Doc, trackIndex: number, ranges: FrameRange[], opts: EditOptions = defaultOptions, ignoreSyncLock: Set<number> = new Set()) {
  const t = activeTimeline(doc)
  if (!t.tracks[trackIndex]) throw new EditRefusal('Track not found.')
  const merged = mergeRanges(ranges.filter((r) => r.end > r.start))
  if (!merged.length) throw new EditRefusal('No non-empty ranges to delete.')
  const syncIds = new Set(t.tracks.filter((tr, i) => tr.syncLocked && !ignoreSyncLock.has(i)).map((tr) => tr.id))
  const clearIds = new Set([t.tracks[trackIndex].id, ...syncIds])
  let changed = true
  while (changed) {
    changed = false
    for (const tr of t.tracks) {
      if (!clearIds.has(tr.id)) continue
      for (const c of tr.clips) {
        if (!c.linkGroupId || !merged.some((r) => c.startFrame < r.end && endFrame(c) > r.start)) continue
        for (const pid of linkedPartnerIds(t, c.id)) {
          const loc = findClip(t, pid)
          if (loc && !clearIds.has(loc.track.id)) {
            clearIds.add(loc.track.id)
            changed = true
          }
        }
      }
    }
  }
  const shifting = new Set([...clearIds, ...syncIds])
  const v = multicamAtomicityViolation(t, shifting, (id) => multicamGroupName(doc, id))
  if (v) throw new EditRefusal(v, true)
  t.tracks.forEach((tr, i) => {
    if (syncIds.has(tr.id) && !clearIds.has(tr.id)) {
      const r = validateShifts(t, i, computeRippleShiftsForRanges(tr.clips, merged))
      if (r) throw new EditRefusal(r, true)
    }
  })
  const before = new Set(allClips(t).map((c) => c.id))
  for (const tid of clearIds) for (const r of merged) clearRegion(t, t.tracks.findIndex((x) => x.id === tid), r.start, r.end)
  for (const tr of t.tracks) if (shifting.has(tr.id)) applyShifts(t, computeRippleShiftsForRanges(tr.clips, merged))
  applyRippledMarkers(t, rippleMarkersClosing(t.markers, [merged]), opts)
  const after = new Set(allClips(t).map((c) => c.id))
  return {
    removedFrames: merged.reduce((s, r) => s + r.end - r.start, 0),
    removedClipIds: [...before].filter((id) => !after.has(id)),
  }
}

/** Lift: clears a range on every track (or the given ones) without closing the gap. */
export function liftRange(doc: Doc, start: number, end: number, trackIndices?: number[]): void {
  const t = activeTimeline(doc)
  if (end <= start) throw new EditRefusal('The range is empty.')
  const ids = (trackIndices ?? t.tracks.map((_, i) => i)).map((i) => t.tracks[i]?.id).filter(Boolean) as string[]
  for (const id of ids) clearRegion(t, t.tracks.findIndex((x) => x.id === id), start, end)
  pruneEmptyTracks(t)
}

// ---------- Split ----------

export function splitAtFrame(doc: Doc, clipIds: Iterable<string>, frame: number): string[] {
  const t = activeTimeline(doc)
  const out: string[] = []
  for (const id of clipIds) out.push(...splitClip(t, id, frame))
  if (!out.length) throw new EditRefusal('No selected clip spans the playhead.')
  return out
}

export function splitTracksAtFrame(doc: Doc, trackIndices: number[], frame: number): string[] {
  const t = activeTimeline(doc)
  return splitClips(t, trackIndices.map((trackIndex) => ({ trackIndex, atFrame: frame })))
}

// ---------- Trim ----------

export type Edge = 'left' | 'right'

export function trimValues(c: Clip, edge: Edge, delta: number): [number, number] {
  const src = round(delta * c.speed)
  const unbounded = c.mediaType === 'image' || c.mediaType === 'text'
  if (edge === 'left') {
    const ts = c.trimStartFrame + src
    return [unbounded ? ts : Math.max(0, ts), c.trimEndFrame]
  }
  const te = c.trimEndFrame - src
  return [c.trimStartFrame, unbounded ? te : Math.max(0, te)]
}

export function effectiveTrimEnd(doc: Doc, c: Clip): number {
  if (c.sourceClipType === 'sequence') {
    const child = timelineById(doc, c.mediaRef)
    if (child) return Math.max(0, totalFrames(child) - c.trimStartFrame - c.durationFrames)
  }
  return c.trimEndFrame
}

function trimClipInternal(t: Timeline, clipId: string, newTrimStart: number, newTrimEnd: number, protecting: Set<string>): void {
  const loc = findClip(t, clipId)
  if (!loc) return
  const c = loc.clip
  const dSt = round((newTrimStart - c.trimStartFrame) / c.speed)
  const dEt = round((newTrimEnd - c.trimEndFrame) / c.speed)
  const newDuration = Math.max(1, c.durationFrames - dSt - dEt)
  const newStart = Math.max(0, c.startFrame + dSt)
  const newEnd = newStart + newDuration
  const prot = new Set([...protecting, clipId])
  const trackId = loc.track.id
  if (newStart < c.startFrame) clearRegion(t, t.tracks.findIndex((x) => x.id === trackId), newStart, c.startFrame, prot)
  if (newEnd > endFrame(c)) clearRegion(t, t.tracks.findIndex((x) => x.id === trackId), endFrame(c), newEnd, prot)
  const cur = findClip(t, clipId)!.clip
  cur.trimStartFrame = newTrimStart
  cur.trimEndFrame = newTrimEnd
  cur.startFrame = newStart
  setClipDuration(cur, newDuration)
  sortClips(t.tracks.find((x) => x.id === trackId)!)
}

export function trimClips(doc: Doc, edits: { clipId: string; trimStart: number; trimEnd: number }[]): void {
  const t = activeTimeline(doc)
  if (!edits.length) throw new EditRefusal('Nothing to trim.')
  const protecting = new Set(edits.map((e) => e.clipId))
  for (const e of edits) trimClipInternal(t, e.clipId, e.trimStart, e.trimEnd, protecting)
}

/** Trim one edge by a timeline delta; linked partners follow unless `linked` is false. */
export function trimEdge(doc: Doc, clipId: string, edge: Edge, deltaIn: number, linked = true): void {
  const t = activeTimeline(doc)
  const lead = findClip(t, clipId)?.clip
  if (!lead) throw new EditRefusal('Clip not found.')
  let delta = deltaIn
  if (edge === 'left') delta = Math.min(delta, lead.durationFrames - 1)
  else delta = Math.max(delta, -(lead.durationFrames - 1))
  if (edge === 'left' && lead.mediaType !== 'image' && lead.mediaType !== 'text') delta = Math.max(delta, -lead.trimStartFrame)
  if (edge === 'left') delta = Math.max(delta, -lead.startFrame)
  const targets = [lead, ...(linked ? linkedPartnerIds(t, clipId).map((id) => findClip(t, id)!.clip) : [])]
  if (delta === 0) throw new EditRefusal('Nothing to trim.')
  trimClips(
    doc,
    targets.map((c) => {
      const [ts, te] = trimValues(c, edge, delta)
      return { clipId: c.id, trimStart: ts, trimEnd: te }
    }),
  )
}

export function trimToFrame(doc: Doc, clipIds: Iterable<string>, frame: number, edge: Edge): void {
  const t = activeTimeline(doc)
  const edits: { clipId: string; trimStart: number; trimEnd: number }[] = []
  for (const id of clipIds) {
    const c = findClip(t, id)?.clip
    if (!c || !(c.startFrame < frame && frame < endFrame(c))) continue
    if (edge === 'left') edits.push({ clipId: id, trimStart: c.trimStartFrame + round((frame - c.startFrame) * c.speed), trimEnd: c.trimEndFrame })
    else edits.push({ clipId: id, trimStart: c.trimStartFrame, trimEnd: c.trimEndFrame + round((endFrame(c) - frame) * c.speed) })
  }
  if (!edits.length) throw new EditRefusal('No selected clip spans the playhead.')
  trimClips(doc, edits)
}

// ---------- Ripple trim ----------

export function rippleTrim(doc: Doc, clipId: string, edge: Edge, delta: number, linked = true, opts: EditOptions = defaultOptions): void {
  const t = activeTimeline(doc)
  const lead = findClip(t, clipId)?.clip
  if (!lead) throw new EditRefusal('Clip not found.')
  if (delta === 0) throw new EditRefusal('Nothing to trim.')
  const ids = new Set([clipId])
  if (linked) for (const p of linkedPartnerIds(t, clipId)) ids.add(p)
  const targets = allClips(t).filter((c) => ids.has(c.id))
  const shiftingTracks = new Set(t.tracks.filter((tr) => tr.syncLocked || tr.clips.some((c) => ids.has(c.id))).map((tr) => tr.id))
  const refusal = multicamManualRippleViolation(t, shiftingTracks, edge === 'left' ? lead.startFrame : endFrame(lead), (id) => multicamGroupName(doc, id))
  if (refusal) throw new EditRefusal(refusal, true)
  const leadEnd = endFrame(lead)
  const durationDelta = (c: Clip) => {
    const [ts, te] = trimValues(c, edge, delta)
    return -round((ts - c.trimStartFrame + (te - c.trimEndFrame)) / c.speed)
  }
  let dd = targets.map(durationDelta).reduce((best, v) => (Math.abs(v) < Math.abs(best) ? v : best))
  if (dd < 0) {
    dd = Math.max(dd, -Math.min(...targets.map((c) => (c.durationFrames > 1 ? c.durationFrames - 1 : 0))))
    for (const tr of t.tracks) {
      if (!tr.syncLocked || tr.clips.some((c) => ids.has(c.id))) continue
      const after = tr.clips.filter((c) => c.startFrame >= leadEnd)
      if (!after.length) continue
      const first = Math.min(...after.map((c) => c.startFrame))
      const before = tr.clips.filter((c) => c.startFrame < leadEnd).map((c) => endFrame(c))
      const room = Math.max(0, first - (before.length ? Math.max(...before) : 0))
      if (dd < -room) dd = -room
    }
  }
  if (dd === 0) throw new EditRefusal('Nothing to trim.')
  const pushes: { trackId: string; from: number }[] = []
  for (const tr of t.tracks) {
    const target = tr.clips.find((c) => ids.has(c.id))
    if (!target && !tr.syncLocked) continue
    pushes.push({ trackId: tr.id, from: target ? endFrame(target) : leadEnd })
  }
  for (const c of targets) {
    const [ts, te] = trimValues(c, edge, edge === 'right' ? dd : -dd)
    c.trimStartFrame = ts
    c.trimEndFrame = te
    setClipDuration(c, c.durationFrames + dd)
  }
  for (const p of pushes) {
    const tr = t.tracks.find((x) => x.id === p.trackId)!
    applyShifts(t, computeRipplePush(tr.clips, p.from, dd, ids))
  }
  applyRippledMarkers(t, rippleMarkersOpening(t.markers, leadEnd, dd), opts)
}

// ---------- Slip ----------

const isSlipEligible = (c: Clip) => c.mediaType !== 'image' && c.mediaType !== 'text' && !c.multicamGroupId

export function slipClip(doc: Doc, clipId: string, deltaIn: number, linked = true): void {
  const t = activeTimeline(doc)
  const lead = findClip(t, clipId)?.clip
  if (!lead) throw new EditRefusal('Clip not found.')
  if (lead.multicamGroupId) throw new EditRefusal("Can't slip a multicam clip — it would go out of sync with the group.")
  const targets = [lead, ...(linked ? linkedPartnerIds(t, clipId).map((id) => findClip(t, id)!.clip) : [])].filter(isSlipEligible)
  if (!targets.length) throw new EditRefusal("This clip can't be slipped.")
  let delta = deltaIn
  for (const c of targets) {
    const s = Math.max(c.speed, 0.001)
    delta = Math.min(delta, Math.floor(c.trimStartFrame / s))
    delta = Math.max(delta, -Math.floor(effectiveTrimEnd(doc, c) / s))
  }
  if (delta === 0) throw new EditRefusal('No source media left to slip.')
  for (const c of targets) {
    const a = Math.min(Math.max(round(delta * c.speed), -effectiveTrimEnd(doc, c)), c.trimStartFrame)
    c.trimStartFrame -= a
    c.trimEndFrame += a
  }
}

// ---------- Speed ----------

export const SPEED_RANGE = { min: 0.25, max: 4 } as const

export function retimedDurationFrames(dur: number, speed: number, newSpeed: number): number {
  return Math.max(1, round((dur * speed) / newSpeed))
}

function contiguousClipIds(clips: Clip[], fromEnd: number, excludeId: string): string[] {
  const out: string[] = []
  let chainEnd = fromEnd
  for (const c of [...clips].sort((a, b) => a.startFrame - b.startFrame)) {
    if (c.id === excludeId || c.startFrame < fromEnd) continue
    if (c.startFrame !== chainEnd) break
    chainEnd = endFrame(c)
    out.push(c.id)
  }
  return out
}

export function setClipSpeed(doc: Doc, ids: Iterable<string>, newSpeed: number, ripple = true): void {
  if (!Number.isFinite(newSpeed) || newSpeed <= 0) throw new EditRefusal('Speed must be a positive number.')
  const t = activeTimeline(doc)
  const clips = [...ids].map((id) => findClip(t, id)).filter((l): l is NonNullable<typeof l> => !!l)
  if (clips.some((l) => l.clip.multicamGroupId)) throw new EditRefusal("Can't change speed on a multicam clip — it would slip out of sync with the group.")
  let changed = false
  for (const { clip: c, track } of clips) {
    if (!supportsRetiming(c) || c.speed === newSpeed) continue
    const newDur = retimedDurationFrames(c.durationFrames, c.speed, newSpeed)
    const oldDur = c.durationFrames
    const oldEnd = endFrame(c)
    c.speed = newSpeed
    c.durationFrames = newDur
    rescaleWordTimings(c, oldDur)
    rescaleKeyframes(c, newDur / oldDur)
    clampKeyframesToDuration(c)
    clampFadesToDuration(c)
    const rippleDelta = c.startFrame + newDur - oldEnd
    if (ripple && rippleDelta) for (const id of contiguousClipIds(track.clips, oldEnd, c.id)) track.clips.find((x) => x.id === id)!.startFrame += rippleDelta
    sortClips(track)
    changed = true
  }
  if (!changed) throw new EditRefusal('Speed is unchanged.')
}

// ---------- Link ----------

export function linkClips(doc: Doc, idsIn: Iterable<string>): void {
  const t = activeTimeline(doc)
  const ids = expandToLinkGroup(t, idsIn)
  const clips = allClips(t).filter((c) => ids.has(c.id))
  if (clips.length < 2) throw new EditRefusal('Select at least two clips to link.')
  if (new Set(clips.map((c) => c.mediaType)).size < 2) throw new EditRefusal('Linked clips must include different media types.')
  const groups = new Set(clips.map((c) => c.linkGroupId).filter(Boolean))
  if (groups.size === 1 && clips.every((c) => c.linkGroupId)) throw new EditRefusal('These clips are already linked.')
  const gid = newId()
  for (const c of clips) c.linkGroupId = gid
}

export function unlinkClips(doc: Doc, idsIn: Iterable<string>): void {
  const t = activeTimeline(doc)
  const ids = expandToLinkGroup(t, idsIn)
  const clips = allClips(t).filter((c) => ids.has(c.id) && c.linkGroupId)
  if (!clips.length) throw new EditRefusal('No linked clips selected.')
  for (const c of clips) delete c.linkGroupId
}

export function trackOfClip(t: Timeline, clipId: string): number {
  return findClip(t, clipId)?.trackIndex ?? -1
}

export { trackDisplayLabel, sourceFramesConsumed, splitClip }
