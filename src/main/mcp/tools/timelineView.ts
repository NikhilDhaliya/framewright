/** The get_timeline read shape: model JSON compacted (defaults stripped, linked audio folded, captions grouped). */
import { linearToDb } from '../../../core/clip'
import { defaultTextStyle, newClip, type Clip, type MulticamMember, type Timeline, type TimelineMarker, type Track } from '../../../core/model'
import { textAnchorX } from '../../../core/ops/agent'
import { activeTimeline, type Doc } from '../../../core/ops/context'
import { colorObject } from '../../../core/ops/grade'
import { sortMarkers, totalFrames, trackDisplayLabel } from '../../../core/timeline'
import { ToolError, hexString, isObj, lenient, type Obj } from './args'
import { jsonString } from './json'

export interface FrameWindow {
  start: number
  end: number
}

export const OPEN_END = Number.MAX_SAFE_INTEGER

/** `frameWindow`: startFrame/endFrame window shared by get_timeline, get_transcript and get_multicam. */
export function frameWindow(args: Obj): FrameWindow | null {
  const start = lenient.int(args, 'startFrame')
  const rawEnd = lenient.int(args, 'endFrame')
  const end = rawEnd === 0 ? undefined : rawEnd
  if (end === undefined && (start === undefined || start === 0)) return null
  const s = start ?? 0
  const e = end ?? OPEN_END
  if (!(s < e)) throw new ToolError(`Invalid window [${s}, ${e === OPEN_END ? '9223372036854775807' : e}): startFrame must be less than endFrame`)
  return { start: s, end: e }
}

export function markerDict(m: TimelineMarker): Obj {
  return {
    markerId: m.id,
    name: m.name,
    startFrame: m.startFrame,
    endFrame: m.startFrame + m.durationFrames,
    durationFrames: m.durationFrames,
    color: hexString(m.color),
    comment: m.comment,
    status: m.status,
  }
}

const markerIntersects = (m: TimelineMarker, w: FrameWindow) =>
  m.durationFrames > 0 ? m.startFrame < w.end && m.startFrame + m.durationFrames > w.start : w.start <= m.startFrame && m.startFrame < w.end

export function timelineEntries(doc: Doc, detailed = false, folderPath?: (id?: string) => string | null): Obj[] {
  return doc.file.timelines.map((t) => {
    const e: Obj = { timelineId: t.id, name: t.name }
    if (t.id === activeTimeline(doc).id) e.active = true
    if (detailed) {
      e.durationSeconds = totalFrames(t) / Math.max(t.fps, 1)
      const folder = folderPath?.(t.folderId)
      if (folder) e.folder = folder
    }
    return e
  })
}

// ---------- Raw (model-shaped) dictionaries ----------

const CLIP_KEYS = [
  'id', 'mediaRef', 'mediaType', 'sourceClipType', 'startFrame', 'durationFrames', 'trimStartFrame', 'trimEndFrame', 'speed',
  'volume', 'fadeInFrames', 'fadeOutFrames', 'fadeInInterpolation', 'fadeOutInterpolation', 'opacity', 'transform', 'crop',
  'edgeRounding', 'edgeSoftness', 'linkGroupId', 'captionGroupId', 'multicamGroupId', 'textContent', 'textStyle', 'textAnimation',
  'wordTimings', 'textFillMode', 'opacityTrack', 'positionTrack', 'scaleTrack', 'rotationTrack', 'cropTrack', 'volumeTrack',
  'effects', 'blendMode',
] as const
const TRANSFORM_KEYS = ['centerX', 'centerY', 'width', 'height', 'rotation', 'rotationX', 'rotationY', 'flipHorizontal', 'flipVertical'] as const

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

export function rawClip(c: Clip): Obj {
  const out: Obj = {}
  for (const k of CLIP_KEYS) if (c[k] !== undefined) out[k] = clone(c[k])
  out.transform = Object.fromEntries(TRANSFORM_KEYS.map((k) => [k, c.transform[k]]))
  return out
}

export function rawTrack(tr: Track, clips: Clip[] = tr.clips): Obj {
  const out: Obj = { id: tr.id, type: tr.type, muted: tr.muted, hidden: tr.hidden, syncLocked: tr.syncLocked, clips: clips.map(rawClip), displayHeight: tr.displayHeight }
  if (tr.name) out.name = tr.name
  return out
}

/** Only the clips (plus link and caption mates) a mutation touched, per track, in model shape. */
export function focusedRawTracks(t: Timeline, clipIds: Set<string>, captionGroupIds: Set<string> = new Set()): Obj[] {
  const links = new Set<string>()
  const captions = new Set(captionGroupIds)
  for (const tr of t.tracks)
    for (const c of tr.clips)
      if (clipIds.has(c.id)) {
        if (c.linkGroupId) links.add(c.linkGroupId)
        if (c.captionGroupId) captions.add(c.captionGroupId)
      }
  return t.tracks.map((tr) => ({
    id: tr.id,
    type: tr.type,
    clips: tr.clips.filter((c) => clipIds.has(c.id) || (c.captionGroupId && captions.has(c.captionGroupId)) || (c.linkGroupId && links.has(c.linkGroupId))).map(rawClip),
  }))
}

// ---------- Compaction ----------

const TRACK_DEFAULTS: Obj = { muted: false, hidden: false, syncLocked: true }

const CLIP_DEFAULTS: Obj = (() => {
  const raw = rawClip(newClip({ mediaRef: '', startFrame: 0, durationFrames: 0, textStyle: defaultTextStyle() }))
  for (const k of ['id', 'mediaRef', 'startFrame', 'durationFrames', 'sourceClipType']) delete raw[k]
  return raw
})()

function stripDefaults(dict: Obj, defaults: Obj): Obj {
  const out = { ...dict }
  for (const [k, def] of Object.entries(defaults)) {
    const v = out[k]
    if (v === undefined) continue
    if (isObj(v) && isObj(def)) {
      const s = stripDefaults(v, def)
      if (Object.keys(s).length) out[k] = s
      else delete out[k]
    } else if (v === def) delete out[k]
  }
  return out
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const nearlyEqual = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.0005)

type Shape = 'scalar' | 'pair' | 'crop'
function shapeValues(shape: Shape, raw: unknown): number[] {
  if (shape === 'scalar') return [num(raw)]
  const v = isObj(raw) ? raw : {}
  return shape === 'pair' ? [num(v.a), num(v.b)] : [num(v.top), num(v.right), num(v.bottom), num(v.left)]
}

function collapseConstant(value: number[], prop: string, clip: Obj, out: Obj): boolean {
  switch (prop) {
    case 'volumeDb':
    case 'opacity': {
      const neutral = prop === 'volumeDb' ? 0 : 1
      if (nearlyEqual(value, [neutral])) return true
      if (clip[prop === 'volumeDb' ? 'volume' : 'opacity'] !== 1) return false
      out[prop] = value[0]
      return true
    }
    case 'rotation':
      return nearlyEqual(value, [0])
    case 'position':
      return nearlyEqual(value, [0, 0])
    case 'scale':
      return nearlyEqual(value, [1, 1])
    case 'crop': {
      if (nearlyEqual(value, [0, 0, 0, 0])) return true
      const staticCrop = isObj(clip.crop) ? clip.crop : {}
      if (!Object.values(staticCrop).every((v) => num(v) === 0)) return false
      out.crop = { top: value[0], right: value[1], bottom: value[2], left: value[3] }
      return true
    }
  }
  return false
}

const KEYFRAME_TRACKS: [string, string, Shape][] = [
  ['volumeTrack', 'volumeDb', 'scalar'],
  ['opacityTrack', 'opacity', 'scalar'],
  ['rotationTrack', 'rotation', 'scalar'],
  ['positionTrack', 'position', 'pair'],
  ['scaleTrack', 'scale', 'pair'],
  ['cropTrack', 'crop', 'crop'],
]

type RawKeyframe = { frame: number; value: unknown; interpolationOut?: string }

function keyframeRow(kf: RawKeyframe, values: number[]): unknown[] {
  const row: unknown[] = [kf.frame, ...values]
  if (kf.interpolationOut && kf.interpolationOut !== 'smooth') row.push(kf.interpolationOut)
  return row
}

function compactKeyframes(clip: Obj): Obj {
  const out: Obj = { ...clip }
  if (typeof clip.volume === 'number') {
    delete out.volume
    const db = linearToDb(clip.volume)
    if (!nearlyEqual([db], [0])) out.volumeDb = db
  }
  const keyframes: Obj = {}
  for (const [trackKey, prop, shape] of KEYFRAME_TRACKS) {
    delete out[trackKey]
    const kfs = (isObj(clip[trackKey]) ? (clip[trackKey] as Obj).keyframes : undefined) as RawKeyframe[] | undefined
    if (!kfs?.length) continue
    const values = kfs.map((kf) => shapeValues(shape, kf.value))
    if (values.every((v) => nearlyEqual(v, values[0])) && collapseConstant(values[0], prop, clip, out)) continue
    keyframes[prop] = kfs.map((kf, i) => keyframeRow(kf, values[i]))
  }
  const blur = (clip.effects as Obj[] | undefined)?.find((e) => e.type === 'blur.gaussian')
  const blurKfs = ((blur?.params as Obj | undefined)?.radius as Obj | undefined)?.track as Obj | undefined
  const rows = blurKfs?.keyframes as RawKeyframe[] | undefined
  if (rows?.length) keyframes.blur = rows.map((kf) => keyframeRow(kf, [num(kf.value)]))
  if (Object.keys(keyframes).length) out.keyframes = keyframes
  return out
}

/** Effect stack in apply_effect shape: no ids, flat params, enabled only when false, color.* excluded. */
function compactEffects(raw: Obj[]): Obj[] {
  return raw.flatMap((e) => {
    if (typeof e.type !== 'string' || e.type.startsWith('color.')) return []
    const out: Obj = { type: e.type }
    if (isObj(e.params)) {
      const flat: Obj = {}
      for (const [k, v] of Object.entries(e.params)) flat[k] = isObj(v) ? (v.value ?? v.string ?? (v.track !== undefined ? 'animated' : undefined) ?? v) : v
      if (Object.keys(flat).length) out.params = flat
    }
    if (e.enabled === false) out.enabled = false
    return [out]
  })
}

interface LinkFold {
  partnerByVisual: Map<string, { clip: Obj; track: number }>
  foldedAudio: Set<string>
  foldedCount: Map<number, number>
}

function linkFoldPlan(tracks: Obj[]): LinkFold {
  const groups = new Map<string, { clip: Obj; track: number }[]>()
  tracks.forEach((tr, ti) => {
    for (const c of (tr.clips as Obj[]) ?? []) if (typeof c.linkGroupId === 'string') groups.set(c.linkGroupId, [...(groups.get(c.linkGroupId) ?? []), { clip: c, track: ti }])
  })
  const plan: LinkFold = { partnerByVisual: new Map(), foldedAudio: new Set(), foldedCount: new Map() }
  for (const members of groups.values()) {
    if (members.length !== 2) continue
    const audio = members.find((m) => m.clip.mediaType === 'audio')
    const visual = members.find((m) => m.clip.mediaType !== 'audio')
    if (!audio || !visual) continue
    plan.partnerByVisual.set(visual.clip.id as string, audio)
    plan.foldedAudio.add(audio.clip.id as string)
    plan.foldedCount.set(audio.track, (plan.foldedCount.get(audio.track) ?? 0) + 1)
  }
  return plan
}

function audioSummary(partner: Obj, track: number, visual: Obj): Obj {
  const out: Obj = { id: partner.id, track }
  const ps = num(partner.startFrame)
  const pd = num(partner.durationFrames)
  if (ps !== num(visual.startFrame) || pd !== num(visual.durationFrames)) out.frames = [ps, ps + pd]
  for (const k of ['trimStartFrame', 'trimEndFrame', 'speed']) if (partner[k] !== visual[k]) out[k] = partner[k]
  const stripped = stripDefaults(compactKeyframes(partner), CLIP_DEFAULTS)
  for (const k of ['volumeDb', 'fadeInFrames', 'fadeOutFrames', 'fadeInInterpolation', 'fadeOutInterpolation', 'keyframes']) if (stripped[k] !== undefined) out[k] = stripped[k]
  if (Array.isArray(stripped.effects)) {
    const fx = compactEffects(stripped.effects as Obj[])
    if (fx.length) out.effects = fx
  }
  return out
}

function compactClip(clip: Obj, fold: LinkFold, grades: Map<string, Obj>): Obj {
  let out = compactKeyframes(clip)
  if (out.sourceClipType === out.mediaType) delete out.sourceClipType
  if (out.mediaType === 'text') {
    delete out.trimStartFrame
    delete out.trimEndFrame
  }
  out = stripDefaults(out, CLIP_DEFAULTS)
  const grade = grades.get(out.id as string)
  if (grade) out.color = grade
  if (Array.isArray(out.effects)) {
    const isText = out.mediaType === 'text'
    const fx = compactEffects(out.effects as Obj[]).filter((e) => !isText || e.type !== 'blur.gaussian')
    if (fx.length) out.effects = fx
    else delete out.effects
  }
  const start = num(out.startFrame)
  out.frames = [start, start + num(out.durationFrames)]
  delete out.startFrame
  delete out.durationFrames
  const partner = fold.partnerByVisual.get(out.id as string)
  if (partner) {
    out.audio = audioSummary(partner.clip, partner.track, clip)
    delete out.linkGroupId
  }
  if (clip.mediaType === 'text' && isObj(clip.transform)) {
    const raw = clip.transform
    const alignment = (isObj(clip.textStyle) ? clip.textStyle.alignment : undefined) as 'left' | 'center' | 'right' | undefined
    const transform: Obj = isObj(out.transform) ? { ...out.transform } : {}
    for (const k of ['centerX', 'centerY', 'width', 'height']) delete transform[k]
    transform.x = textAnchorX(num(raw.centerX), num(raw.width), alignment === 'left' || alignment === 'right' ? alignment : 'center')
    transform.y = num(raw.centerY)
    out.transform = transform
  }
  return out
}

const CAPTION_ROW_LIMIT = 200
const CAPTION_ROW_FORMAT = ['clipId', 'startFrame', 'endFrame', 'text']
const CAPTION_ROW_KEYS = new Set(['id', 'frames', 'textContent', 'captionGroupId', 'wordTimings'])

function truncatePreview(text: string): string {
  const chars = [...text]
  return chars.length > 60 ? chars.slice(0, 60).join('') + '…' : text
}

const firstFrame = (c: Obj) => num((c.frames as number[] | undefined)?.[0])
const lastFrame = (c: Obj) => num((c.frames as number[] | undefined)?.[1])

function captionGroup(gid: string, members: Obj[], window: FrameWindow | null, detail: boolean): { group: Obj; deviants: Obj[] } {
  const counts = new Map<string, number>()
  let modalKey = ''
  let shared: Obj = {}
  const entries = members.map((clip) => {
    const residual: Obj = Object.fromEntries(Object.entries(clip).filter(([k]) => !CAPTION_ROW_KEYS.has(k)))
    if (isObj(residual.transform)) {
      const t = { ...residual.transform }
      delete t.width
      delete t.height
      if (Object.keys(t).length) residual.transform = t
      else delete residual.transform
    }
    const key = jsonString(residual)
    counts.set(key, (counts.get(key) ?? 0) + 1)
    if (counts.get(key)! > (counts.get(modalKey) ?? 0)) {
      modalKey = key
      shared = residual
    }
    return { clip, key }
  })
  let rows: [unknown, number, number, unknown][] = []
  const deviants: Obj[] = []
  let frameMin = Number.MAX_SAFE_INTEGER
  let frameMax = 0
  for (const { clip, key } of entries) {
    const start = firstFrame(clip)
    const end = lastFrame(clip)
    frameMin = Math.min(frameMin, start)
    frameMax = Math.max(frameMax, end)
    if (key === modalKey) rows.push([clip.id ?? '', start, end, clip.textContent ?? ''])
    else deviants.push(clip)
  }
  const total = rows.length
  if (window) rows = rows.filter((r) => r[1] < window.end && r[2] > window.start)
  rows.sort((a, b) => a[1] - b[1])
  const group: Obj = { captionGroupId: gid, clipCount: total, frameRange: [frameMin, frameMax] }
  if (Object.keys(shared).length) group.shared = shared
  if (!detail) {
    const first = rows[0]?.[3]
    const last = rows[rows.length - 1]?.[3]
    if (typeof first === 'string' && typeof last === 'string') group.textPreview = rows.length === 1 ? truncatePreview(first) : `${truncatePreview(first)} … ${truncatePreview(last)}`
    group.clipsNote = `Per-clip rows omitted — re-read with captionDetail:true for ${JSON.stringify(CAPTION_ROW_FORMAT).replace(/,/g, ', ')} rows; get_transcript has the spoken words.`
    return { group, deviants }
  }
  const shown = rows.slice(0, CAPTION_ROW_LIMIT)
  group.clipFormat = CAPTION_ROW_FORMAT
  group.clips = shown
  if (shown.length < total) group.clipsNote = `Showing ${shown.length} of ${total} caption clips. Page with startFrame/endFrame.`
  return { group, deviants }
}

function compactTrack(track: Obj, window: FrameWindow | null, detail: boolean, fold: LinkFold, grades: Map<string, Obj>): Obj {
  const out = stripDefaults(track, TRACK_DEFAULTS)
  const rawClips = (track.clips as Obj[] | undefined) ?? []
  const compacted = rawClips.filter((c) => !fold.foldedAudio.has(c.id as string)).map((c) => compactClip(c, fold, grades))
  const loose: Obj[] = []
  const order: string[] = []
  const grouped = new Map<string, Obj[]>()
  for (const c of compacted) {
    const gid = c.captionGroupId
    if (typeof gid === 'string') {
      if (!grouped.has(gid)) order.push(gid)
      grouped.set(gid, [...(grouped.get(gid) ?? []), c])
    } else loose.push(c)
  }
  const groups: Obj[] = []
  for (const gid of order) {
    const { group, deviants } = captionGroup(gid, grouped.get(gid)!, window, detail)
    groups.push(group)
    loose.push(...deviants)
  }
  loose.sort((a, b) => firstFrame(a) - firstFrame(b))
  const visible = window ? loose.filter((c) => firstFrame(c) < window.end && lastFrame(c) > window.start) : loose
  delete out.clips
  if (visible.length) out.clips = visible
  if (visible.length < loose.length) out.totalClips = loose.length
  if (groups.length) out.captionGroups = groups
  return out
}

function trackGaps(track: Track): number[][] {
  const spans = track.clips
    .filter((c) => !c.captionGroupId)
    .map((c) => [c.startFrame, c.startFrame + c.durationFrames])
    .sort((a, b) => a[0] - b[0])
  const gaps: number[][] = []
  let maxEnd: number | null = null
  for (const [s, e] of spans) {
    if (maxEnd !== null && s > maxEnd) gaps.push([maxEnd, s])
    maxEnd = Math.max(maxEnd ?? e, e)
  }
  return gaps
}

/** Compacts model-shaped tracks of the active timeline (all of them, or a focused subset in index order). */
export function compactTracks(t: Timeline, tracks: Obj[], window: FrameWindow | null, captionDetail: boolean): Obj[] {
  const fold = linkFoldPlan(tracks)
  const grades = new Map<string, Obj>()
  for (const tr of t.tracks)
    for (const c of tr.clips) {
      const grade = colorObject(c.effects)
      if (grade) grades.set(c.id, grade)
    }
  return tracks.map((raw, i) => {
    const track = compactTrack(raw, window, captionDetail, fold, grades)
    track.label = trackDisplayLabel(t, i)
    track.index = i
    track.trackId = track.id
    delete track.id
    delete track.displayHeight
    const folded = fold.foldedCount.get(i)
    if (folded) track.linkedClips = folded
    const gaps = t.tracks[i] ? trackGaps(t.tracks[i]) : []
    if (gaps.length) track.gaps = gaps
    return track
  })
}

const providesVideo = (m: MulticamMember) => m.kind !== 'mic'
const providesAudio = (m: MulticamMember) => m.kind !== 'angle'
export const memberUsable = (m: MulticamMember) => m.sync.confidence > 0 || m.sync.locked

export interface EditorSelection {
  clipIds: string[]
  mediaIds: string[]
  range: [number, number] | null
}

/** Full get_timeline payload (before float rounding). */
export function timelinePayload(doc: Doc, opts: { window: FrameWindow | null; captionDetail: boolean; currentFrame: number; canGenerate: boolean; selection: EditorSelection }): Obj {
  const t = activeTimeline(doc)
  const dict: Obj = { id: t.id, name: t.name, fps: t.fps, width: t.width, height: t.height }
  if (t.folderId) dict.folderId = t.folderId
  dict.tracks = compactTracks(
    t,
    t.tracks.map((tr) => rawTrack(tr)),
    opts.window,
    opts.captionDetail,
  )
  const markers = sortMarkers(t.markers).filter((m) => !opts.window || markerIntersects(m, opts.window))
  if (markers.length) dict.markers = markers.map(markerDict)
  const total = totalFrames(t)
  dict.totalFrames = total
  dict.durationSeconds = total / Math.max(t.fps, 1)
  if (opts.window) dict.window = [opts.window.start, Math.min(opts.window.end, total)]
  dict.currentFrame = opts.currentFrame
  dict.canGenerate = opts.canGenerate
  const referenced = new Set(t.tracks.flatMap((tr) => tr.clips.flatMap((c) => (c.multicamGroupId ? [c.multicamGroupId] : []))))
  const groups = (doc.file.multicamGroups ?? []).filter((g) => referenced.has(g.id))
  if (groups.length) {
    dict.multicamGroups = groups.map((g) => ({
      groupId: g.id,
      name: g.name,
      angles: g.members.filter((m) => providesVideo(m) && memberUsable(m)).map((m) => m.angleLabel),
      mics: g.members.filter((m) => providesAudio(m) && memberUsable(m)).map((m) => m.angleLabel),
    }))
  }
  if (doc.file.timelines.length > 1) dict.timelines = timelineEntries(doc)
  if (opts.selection.clipIds.length) dict.selectedClipIds = opts.selection.clipIds
  if (opts.selection.mediaIds.length) dict.selectedMediaIds = opts.selection.mediaIds
  if (opts.selection.range) dict.range = opts.selection.range
  return dict
}
