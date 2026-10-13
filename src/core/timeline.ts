import { deepClone } from './util'
import {
  blurKeyframeTrack,
  clampFadesToDuration,
  clampKeyframesToDuration,
  rescaleKeyframes,
  endFrame,
  freshenClipIds,
  lerpCrop,
  pruneUndefined,
  setClipDuration,
  sourceFramesConsumed,
  staticBlurRadius,
  trackEndFrame,
} from './clip'
import { lerpNumber, lerpPair, rebaseTrack, sampleTrack, swiftRound, type KeyframeTrack, type Lerp } from './keyframes'
import { isVisualType, newId, newTrack, type Clip, type ClipType, type Effect, type Timeline, type TimelineMarker, type Track } from './model'

export const round = swiftRound

/** A refused edit: validation failed before any mutation, so no undo step is created. */
export class EditRefusal extends Error {
  constructor(message: string, readonly beep = false) {
    super(message)
  }
}

export interface FrameRange {
  start: number
  end: number
}

export interface ClipLocation {
  trackIndex: number
  clipIndex: number
  track: Track
  clip: Clip
}

export const totalFrames = (t: Timeline): number => t.tracks.reduce((m, tr) => Math.max(m, trackEndFrame(tr)), 0)

export const displayFrames = (t: Timeline): number =>
  t.markers.reduce((r, m) => Math.max(r, m.startFrame + Math.max(1, m.durationFrames)), totalFrames(t))

export const firstAudioIndex = (t: Timeline): number => {
  const i = t.tracks.findIndex((tr) => tr.type === 'audio')
  return i < 0 ? t.tracks.length : i
}

export const hasAudioClips = (t: Timeline): boolean => t.tracks.some((tr) => tr.type === 'audio' && tr.clips.length > 0)

export function findClip(t: Timeline, id: string): ClipLocation | null {
  for (let ti = 0; ti < t.tracks.length; ti++) {
    const track = t.tracks[ti]
    const ci = track.clips.findIndex((c) => c.id === id)
    if (ci >= 0) return { trackIndex: ti, clipIndex: ci, track, clip: track.clips[ci] }
  }
  return null
}

export function allClips(t: Timeline): Clip[] {
  return t.tracks.flatMap((tr) => tr.clips)
}

export function sortClips(track: Track): void {
  track.clips.sort((a, b) => a.startFrame - b.startFrame)
}

export function sortAllClips(t: Timeline): void {
  for (const tr of t.tracks) sortClips(tr)
}

export function pruneEmptyTracks(t: Timeline): void {
  t.tracks = t.tracks.filter((tr) => tr.clips.length > 0)
}

export function linkedPartnerIds(t: Timeline, id: string): string[] {
  const loc = findClip(t, id)
  const gid = loc?.clip.linkGroupId
  if (!gid) return []
  return allClips(t)
    .filter((c) => c.linkGroupId === gid && c.id !== id)
    .map((c) => c.id)
}

export function expandToLinkGroup(t: Timeline, ids: Iterable<string>): Set<string> {
  const out = new Set(ids)
  const groups = new Set<string>()
  for (const c of allClips(t)) if (out.has(c.id) && c.linkGroupId) groups.add(c.linkGroupId)
  if (groups.size) for (const c of allClips(t)) if (c.linkGroupId && groups.has(c.linkGroupId)) out.add(c.id)
  return out
}

// ---------- Tracks ----------

export function partitionedInsertionIndex(t: Timeline, type: ClipType, requested: number): number {
  const bounded = Math.min(Math.max(requested, 0), t.tracks.length)
  const fa = firstAudioIndex(t)
  return type === 'audio' ? Math.max(bounded, fa) : Math.min(bounded, fa)
}

export function insertTrack(t: Timeline, at: number, type: ClipType): number {
  const idx = partitionedInsertionIndex(t, type === 'audio' ? 'audio' : 'video', at)
  t.tracks.splice(idx, 0, newTrack(type === 'audio' ? 'audio' : 'video'))
  return idx
}

export function trackDisplayLabel(t: Timeline, i: number): string {
  const track = t.tracks[i]
  if (!track) return ''
  const prefix =
    { video: 'V', sequence: 'V', audio: 'A', image: 'I', text: 'T', lottie: 'L', subtitle: 'S' }[track.type] ?? 'V'
  if (track.type === 'audio') {
    let n = 0
    for (let j = 0; j <= i; j++) if (t.tracks[j].type === 'audio') n++
    return `${prefix}${n}`
  }
  const fa = firstAudioIndex(t)
  let n = 0
  for (let j = i; j < Math.max(i + 1, fa); j++) if (t.tracks[j].type === track.type) n++
  return `${prefix}${n}`
}

export function resolveOrCreateAudioTrack(t: Timeline, start: number, duration: number): number {
  const end = start + duration
  for (let i = firstAudioIndex(t); i < t.tracks.length; i++) {
    if (!t.tracks[i].clips.some((c) => !(endFrame(c) <= start || c.startFrame >= end))) return i
  }
  return insertTrack(t, t.tracks.length, 'audio')
}

// ---------- Keyframe splitting ----------

function splitKeyframeTrack<V>(track: KeyframeTrack<V> | undefined, off: number, fallback: V, lerp: Lerp<V>): [KeyframeTrack<V> | undefined, KeyframeTrack<V> | undefined] {
  if (!track || track.keyframes.length === 0) return [track, track]
  const boundary = sampleTrack(track, off, fallback, lerp)
  const leftK = track.keyframes.filter((k) => k.frame <= off)
  if (leftK[leftK.length - 1]?.frame !== off) leftK.push({ frame: off, value: boundary, interpolationOut: 'smooth' })
  return [leftK.length ? { keyframes: leftK } : undefined, rebaseTrack(track, off, fallback, lerp)]
}

export function setBlurKeyframeTrack(c: Clip, track: KeyframeTrack<number> | undefined): void {
  const active = track && track.keyframes.length ? track : undefined
  const stack: Effect[] = [...(c.effects ?? [])]
  const idx = stack.findIndex((e) => e.type === 'blur.gaussian')
  if (active) {
    let i = idx
    if (i < 0) {
      i = effectInsertIndex(stack, 'blur.gaussian')
      stack.splice(i, 0, { id: newId(), type: 'blur.gaussian', enabled: true, params: { radius: { value: staticBlurRadius(c) } } })
    }
    const param = { ...(stack[i].params.radius ?? { value: staticBlurRadius(c) }) }
    if (c.mediaType === 'text') delete param.value
    param.track = active
    stack[i] = { ...stack[i], params: { ...stack[i].params, radius: param } }
  } else if (idx >= 0) {
    const param = { ...(stack[idx].params.radius ?? {}) }
    delete param.track
    stack[idx] = { ...stack[idx], params: { ...stack[idx].params, radius: param } }
    if (c.mediaType === 'text' || (param.value ?? 0) === 0) stack.splice(idx, 1)
  }
  if (stack.length) c.effects = stack
  else delete c.effects
}

export const EFFECT_ORDER = [
  'color.exposure', 'color.contrast', 'color.highlightsShadows', 'color.blacksWhites', 'color.temperature',
  'color.vibrance', 'color.saturation', 'color.wheels', 'color.curves', 'color.hueCurves', 'color.lut',
  'detail.clarity', 'key.chroma', 'blur.gaussian', 'blur.sharpen', 'blur.noiseReduction', 'blur.motion',
  'stylize.invert', 'stylize.grain', 'stylize.vignette', 'stylize.glow',
]

export function effectInsertIndex(stack: Effect[], type: string): number {
  const rank = (t: string) => {
    const i = EFFECT_ORDER.indexOf(t)
    return i < 0 ? Infinity : i
  }
  const r = rank(type)
  const i = stack.findIndex((e) => rank(e.type) > r)
  return i < 0 ? stack.length : i
}

// ---------- Split ----------

export function splitValues(c: Clip, atFrame: number): [Clip, Clip] | null {
  if (!(atFrame > c.startFrame && atFrame < endFrame(c))) return null
  const off = atFrame - c.startFrame
  const leftSource = round(off * c.speed)
  const rightSource = round((c.durationFrames - off) * c.speed)
  const left: Clip = deepClone(c)
  left.durationFrames = off
  left.trimEndFrame = c.trimEndFrame + rightSource
  left.fadeOutFrames = 0
  const right: Clip = deepClone(c)
  right.id = newId()
  right.startFrame = atFrame
  right.durationFrames = c.durationFrames - off
  right.trimStartFrame = c.trimStartFrame + leftSource
  right.fadeInFrames = 0
  ;[left.opacityTrack, right.opacityTrack] = splitKeyframeTrack(c.opacityTrack, off, c.opacity, lerpNumber)
  ;[left.volumeTrack, right.volumeTrack] = splitKeyframeTrack(c.volumeTrack, off, 0, lerpNumber)
  ;[left.positionTrack, right.positionTrack] = splitKeyframeTrack(c.positionTrack, off, { a: 0, b: 0 }, lerpPair)
  ;[left.scaleTrack, right.scaleTrack] = splitKeyframeTrack(c.scaleTrack, off, { a: 1, b: 1 }, lerpPair)
  ;[left.rotationTrack, right.rotationTrack] = splitKeyframeTrack(c.rotationTrack, off, 0, lerpNumber)
  ;[left.cropTrack, right.cropTrack] = splitKeyframeTrack(c.cropTrack, off, c.crop, lerpCrop)
  const blur = blurKeyframeTrack(c)
  if (blur) {
    const [lb, rb] = splitKeyframeTrack(blur, off, staticBlurRadius(c), lerpNumber)
    setBlurKeyframeTrack(left, lb)
    setBlurKeyframeTrack(right, rb)
  }
  if (c.wordTimings && c.mediaType === 'text') {
    left.wordTimings = c.wordTimings.filter((w) => w.startFrame < off).map((w) => ({ ...w, endFrame: Math.min(w.endFrame, off) }))
    right.wordTimings = c.wordTimings
      .filter((w) => w.endFrame > off)
      .map((w) => ({ text: w.text, startFrame: Math.max(0, w.startFrame - off), endFrame: w.endFrame - off }))
  }
  clampFadesToDuration(left)
  clampFadesToDuration(right)
  pruneUndefined(left)
  pruneUndefined(right)
  return [left, right]
}

function splitSingleClip(t: Timeline, id: string, atFrame: number): string | null {
  const loc = findClip(t, id)
  if (!loc) return null
  const parts = splitValues(loc.clip, atFrame)
  if (!parts) return null
  loc.track.clips[loc.clipIndex] = parts[0]
  loc.track.clips.push(parts[1])
  sortClips(loc.track)
  return parts[1].id
}

/** Splits the clip straddling each point plus its link partners; right halves form a fresh link group. */
export function splitClips(t: Timeline, points: { trackIndex: number; atFrame: number }[]): string[] {
  const rightIds: string[] = []
  for (const p of points) {
    const track = t.tracks[p.trackIndex]
    const clip = track?.clips.find((c) => c.startFrame < p.atFrame && p.atFrame < endFrame(c))
    if (!clip) continue
    const group = clip.linkGroupId ? [clip.id, ...linkedPartnerIds(t, clip.id)] : [clip.id]
    const rights = group.map((id) => splitSingleClip(t, id, p.atFrame)).filter((x): x is string => !!x)
    if (group.length > 1 && rights.length) {
      const gid = newId()
      for (const rid of rights) findClip(t, rid)!.clip.linkGroupId = gid
    }
    rightIds.push(...rights)
  }
  return rightIds
}

export function splitClip(t: Timeline, clipId: string, atFrame: number): string[] {
  const loc = findClip(t, clipId)
  if (!loc || !(loc.clip.startFrame < atFrame && atFrame < endFrame(loc.clip))) return []
  return splitClips(t, [{ trackIndex: loc.trackIndex, atFrame }])
}

// ---------- Overwrite ----------

export function removeClips(t: Timeline, ids: Iterable<string>, prune = true): number {
  const set = new Set(ids)
  let removed = 0
  for (const tr of t.tracks) {
    const before = tr.clips.length
    tr.clips = tr.clips.filter((c) => !set.has(c.id))
    removed += before - tr.clips.length
  }
  if (prune && removed) pruneEmptyTracks(t)
  return removed
}

/** Clears [start, end) on one track: removes, trims, or splits overlapping clips (overwrite edit). */
export function clearRegion(t: Timeline, trackIndex: number, start: number, end: number, excluding: Set<string> = new Set()): void {
  if (end <= start) return
  const track = t.tracks[trackIndex]
  if (!track) return
  const trackId = track.id
  const candidates = track.clips.filter((c) => !excluding.has(c.id)).map((c) => c.id)
  for (const id of candidates) {
    const ti = t.tracks.findIndex((x) => x.id === trackId)
    const loc = findClip(t, id)
    if (ti < 0 || !loc || loc.trackIndex !== ti) continue
    const c = loc.clip
    const cs = c.startFrame
    const ce = endFrame(c)
    if (ce <= start || cs >= end) continue
    if (cs >= start && ce <= end) {
      removeClips(t, [id], false)
    } else if (cs < start && ce > end) {
      splitClip(t, id, start)
      const right = t.tracks[ti].clips.find((x) => x.startFrame === start && x.id !== id)
      if (right) {
        if (endFrame(right) > end) splitClip(t, right.id, end)
        removeClips(t, [right.id], false)
      }
    } else if (cs < start) {
      const newDuration = start - cs
      c.trimEndFrame += round((c.durationFrames - newDuration) * c.speed)
      setClipDuration(c, newDuration)
    } else {
      const newDuration = ce - end
      c.trimStartFrame = c.trimStartFrame + round((end - cs) * c.speed)
      c.startFrame = end
      setClipDuration(c, newDuration)
    }
  }
  const tr = t.tracks.find((x) => x.id === trackId)
  if (tr) sortClips(tr)
}

// ---------- Ripple engine ----------

export function mergeRanges(ranges: FrameRange[]): FrameRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: FrameRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

export interface ClipShift {
  clipId: string
  newStartFrame: number
}

export function computeRippleShiftsForRanges(clips: Clip[], removed: FrameRange[]): ClipShift[] {
  const merged = mergeRanges(removed)
  if (!merged.length) return []
  return [...clips]
    .sort((a, b) => a.startFrame - b.startFrame)
    .flatMap((c) => {
      const shift = merged.filter((r) => r.end <= c.startFrame).reduce((s, r) => s + (r.end - r.start), 0)
      return shift > 0 ? [{ clipId: c.id, newStartFrame: c.startFrame - shift }] : []
    })
}

export function computeRipplePush(clips: Clip[], insertFrame: number, push: number, exclude: Set<string> = new Set()): ClipShift[] {
  return clips.filter((c) => !exclude.has(c.id) && c.startFrame >= insertFrame).map((c) => ({ clipId: c.id, newStartFrame: c.startFrame + push }))
}

export function applyShifts(t: Timeline, shifts: ClipShift[]): void {
  for (const s of shifts) {
    const loc = findClip(t, s.clipId)
    if (loc) loc.clip.startFrame = s.newStartFrame
  }
  sortAllClips(t)
}

export function validateShifts(t: Timeline, trackIndex: number, shifts: ClipShift[]): string | null {
  if (!shifts.length) return null
  const track = t.tracks[trackIndex]
  const starts = new Map(shifts.map((s) => [s.clipId, s.newStartFrame]))
  const iv = track.clips.map((c) => {
    const s = starts.get(c.id) ?? c.startFrame
    return { s, e: s + c.durationFrames }
  })
  const label = trackDisplayLabel(t, trackIndex)
  if (iv.some((x) => x.s < 0)) return `Sync-locked track "${label}" would move past the timeline start.`
  iv.sort((a, b) => a.s - b.s)
  for (let i = 1; i < iv.length; i++) if (iv[i].s < iv[i - 1].e) return `Sync-locked track "${label}" doesn't have room to ripple.`
  return null
}

const isRange = (m: TimelineMarker) => m.durationFrames > 0
const markerEnd = (m: TimelineMarker) => m.startFrame + m.durationFrames

function mapFrame(f: number, ranges: FrameRange[]): number {
  let m = f
  for (const r of ranges) {
    if (r.end <= f) m -= r.end - r.start
    else if (r.start < f) m -= f - r.start
  }
  return Math.max(0, m)
}

export function rippleMarkersClosing(markers: TimelineMarker[], trackRanges: FrameRange[][]): TimelineMarker[] {
  const tracks = trackRanges.map((rs) => mergeRanges(rs.filter((r) => r.end > r.start))).filter((rs) => rs.length)
  if (!tracks.length) return markers
  return markers.flatMap((mk) => {
    const surviving = tracks.flatMap((rs): [number, number][] => {
      const s = mapFrame(mk.startFrame, rs)
      if (!isRange(mk)) return rs.some((r) => mk.startFrame >= r.start && mk.startFrame < r.end) ? [] : [[s, s]]
      const e = mapFrame(markerEnd(mk), rs)
      return e > s ? [[s, e]] : []
    })
    if (!surviving.length) return []
    const start = Math.min(...surviving.map((x) => x[0]))
    if (!isRange(mk)) return [{ ...mk, startFrame: start }]
    const end = Math.min(...surviving.map((x) => x[1]))
    return end > start ? [{ ...mk, startFrame: start, durationFrames: end - start }] : []
  })
}

export function rippleMarkersOpening(markers: TimelineMarker[], insertFrame: number, push: number): TimelineMarker[] {
  if (push === 0) return markers
  if (push < 0) return rippleMarkersClosing(markers, [[{ start: insertFrame + push, end: insertFrame }]])
  return markers.map((mk) =>
    mk.startFrame >= insertFrame
      ? { ...mk, startFrame: mk.startFrame + push }
      : isRange(mk) && markerEnd(mk) > insertFrame
        ? { ...mk, durationFrames: mk.durationFrames + push }
        : mk,
  )
}

export function sortMarkers(markers: TimelineMarker[]): TimelineMarker[] {
  return [...markers].sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ---------- Multicam guards ----------

export function multicamAtomicityViolation(t: Timeline, shiftingTrackIds: Set<string>, groupName: (id: string) => string): string | null {
  const groups = new Map<string, Set<string>>()
  for (const tr of t.tracks) for (const c of tr.clips) if (c.multicamGroupId) (groups.get(c.multicamGroupId) ?? groups.set(c.multicamGroupId, new Set()).get(c.multicamGroupId)!).add(tr.id)
  for (const [gid, trackIds] of groups) {
    const moving = [...trackIds].filter((id) => shiftingTrackIds.has(id))
    if (moving.length && moving.length !== trackIds.size) {
      const stranded = [...trackIds].filter((id) => !shiftingTrackIds.has(id)).map((id) => trackDisplayLabel(t, t.tracks.findIndex((x) => x.id === id)))
      return `Can't shift part of multicam group "${groupName(gid)}" — ${stranded.join(', ')} would stay behind and desync.`
    }
  }
  return null
}

export function multicamManualRippleViolation(t: Timeline, shiftingTrackIds: Set<string>, frame: number, groupName: (id: string) => string): string | null {
  const atomic = multicamAtomicityViolation(t, shiftingTrackIds, groupName)
  if (atomic) return atomic
  for (const tr of t.tracks) {
    if (!shiftingTrackIds.has(tr.id)) continue
    const c = tr.clips.find((x) => x.multicamGroupId && x.startFrame < frame && frame < endFrame(x))
    if (c) return `Can't ripple through multicam group "${groupName(c.multicamGroupId!)}" — split its clips at the edit point, or remove silence/words to cut time.`
  }
  return null
}

// ---------- Timeline-wide utilities ----------

export function regenerateTimelineIds(t: Timeline): void {
  const groups = new Map<string, string>()
  for (const tr of t.tracks) {
    tr.id = newId()
    for (const c of tr.clips) freshenClipIds(c, groups)
  }
  for (const m of t.markers) m.id = newId()
}

export function rescaleTimelineFrames(t: Timeline, s: number): void {
  t.markers = t.markers.map((m) => {
    const scaledEnd = round(markerEnd(m) * s)
    const start = Math.max(0, round(m.startFrame * s))
    return { ...m, startFrame: start, durationFrames: isRange(m) ? Math.max(1, scaledEnd - start) : 0 }
  })
  for (const tr of t.tracks) {
    sortClips(tr)
    let previousEnd = 0
    for (const c of tr.clips) {
      const scaledStart = round(c.startFrame * s)
      const scaledEnd = round(endFrame(c) * s)
      c.startFrame = Math.max(scaledStart, previousEnd)
      c.durationFrames = Math.max(1, scaledEnd - c.startFrame)
      c.trimStartFrame = round(c.trimStartFrame * s)
      c.trimEndFrame = round(c.trimEndFrame * s)
      c.fadeInFrames = round(c.fadeInFrames * s)
      c.fadeOutFrames = round(c.fadeOutFrames * s)
      rescaleKeyframes(c, s)
      clampKeyframesToDuration(c)
      clampFadesToDuration(c)
      previousEnd = endFrame(c)
    }
  }
}

export function wouldCreateNestCycle(timelines: Timeline[], childId: string, hostId: string): boolean {
  if (childId === hostId) return true
  return reachableTimelineIds(timelines, childId).has(hostId)
}

/** Nested timelines reachable from `rootId`, breadth-first in discovery order; `maxDepth` limits nesting levels expanded. */
export function reachableTimelineIds(timelines: readonly Timeline[], rootId: string, maxDepth = Infinity): Set<string> {
  const byId = new Map(timelines.map((t) => [t.id, t]))
  const seen = new Set<string>([rootId])
  const found = new Set<string>()
  const queue: [string, number][] = [[rootId, 0]]
  while (queue.length) {
    const [id, depth] = queue.shift()!
    const t = byId.get(id)
    if (!t || depth >= maxDepth) continue
    for (const tr of t.tracks)
      for (const c of tr.clips) {
        if (c.sourceClipType !== 'sequence' || seen.has(c.mediaRef)) continue
        seen.add(c.mediaRef)
        if (byId.has(c.mediaRef)) {
          found.add(c.mediaRef)
          queue.push([c.mediaRef, depth + 1])
        }
      }
  }
  return found
}

export const isVisualTrack = (tr: Track): boolean => isVisualType(tr.type)
export { sourceFramesConsumed }
