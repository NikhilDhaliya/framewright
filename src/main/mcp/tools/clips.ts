/** Clip editing tools: placement, moves, removal, links, splits, ripple cuts, media swap, properties, keyframes. */
import { cropAt, dbToLinear, endFrame, VOLUME_DB } from '../../../core/clip'
import type { Interpolation, Keyframe, KeyframeTrack } from '../../../core/keyframes'
import { BLEND_MODES, CROP_MIN_VISIBLE, defaultTextStyle, isCompatibleType, type BlendMode, type Clip, type Crop } from '../../../core/model'
import {
  adoptClipResolution,
  applyClipSettings,
  applyPropertyChange,
  linkTargets,
  partnerMoves,
  placeAgentClips,
  replaceKeyframeTrack,
  rippleInsertSpecs,
  swapClipMedia,
  timingPropagationPartners,
  unlinkTargets,
  type KeyframeProperty,
  type PlacementSpec,
} from '../../../core/ops/agent'
import { deleteClips, linkClips, moveClips, rippleDeleteRanges, unlinkClips } from '../../../core/ops/clips'
import { activeTimeline, placeableAsset, timelineById, type Doc, type PlaceableAsset } from '../../../core/ops/context'
import type { TextBox } from '../../../core/ops/project'
import { supportsKeyframes } from '../../../core/ops/properties'
import { expandToLinkGroup, findClip, round, splitClips as splitTimelineClips, totalFrames, wouldCreateNestCycle, type FrameRange } from '../../../core/timeline'
import { secondsToFrame } from '../../../core/time'
import { ToolError, decodeArgs, isObj, lenient, opt, validateUnknownKeys, type Obj } from './args'
import { mutate, type ToolEnv, type ToolResult } from './context'
import { mutationResult, snapshot } from './delta'
import { swiftDouble } from './json'
import { measureBoxes } from './text'

// ---------- Shared resolution ----------

/** A media asset, or a nested-timeline stand-in when `id` names a timeline. */
export function clipSource(doc: Doc, id: string, path: string): PlaceableAsset {
  const entry = doc.manifest.entries.find((e) => e.id === id)
  if (entry?.type === 'subtitle') {
    throw new ToolError(`${path}: '${id}' is a subtitle file and can't be placed as a clip. Use add_captions with subtitleMediaRef to place its cues as captions.`)
  }
  if (entry) return placeableAsset(doc, id)!
  const child = timelineById(doc, id)
  if (!child) throw new ToolError(`${path}: media asset or timeline not found: ${id}`)
  if (totalFrames(child) === 0) throw new ToolError(`${path}: "${child.name}" is empty. Add clips before nesting it.`)
  if (wouldCreateNestCycle(doc.file.timelines, id, activeTimeline(doc).id)) throw new ToolError(`${path}: Can't nest "${child.name}" — it would contain itself.`)
  return placeableAsset(doc, id)!
}

/** One length expression per call: `source` seconds (stills unclamped), or an exact frame count. */
function resolvePlacement(asset: PlaceableAsset, fps: number, frames: number | undefined, source: number[] | undefined, path: string, label: string): { trimStart: number; duration: number } {
  if (frames !== undefined && source !== undefined) {
    throw new ToolError(`${path}: set source OR ${label}, not both — source picks a span of the asset, ${label} an exact timeline length.`)
  }
  const still = asset.type === 'image'
  const sourceLen = secondsToFrame(asset.duration, fps)
  if (source) {
    if (source.length !== 2) throw new ToolError(`${path}: source must be [startSeconds, endSeconds] (got ${source.length} element${source.length === 1 ? '' : 's'})`)
    if (!(asset.duration > 0) && !still) throw new ToolError(`${path}: source needs a known source length; this asset has none. Use ${label}.`)
    const start = Math.max(source[0], 0)
    const end = still ? source[1] : Math.min(source[1], asset.duration)
    if (!(end > start)) {
      throw new ToolError(`${path}: source end (${swiftDouble(source[1])}) must be greater than start (${swiftDouble(source[0])})${still ? '' : `; source is ${swiftDouble(asset.duration)}s`}.`)
    }
    const trimStart = secondsToFrame(start, fps)
    return { trimStart, duration: Math.max(1, secondsToFrame(end, fps) - trimStart) }
  }
  if (frames !== undefined) {
    if (frames < 1) throw new ToolError(`${path}: ${label} must span at least 1 frame`)
    if (!still && sourceLen > 0 && frames > sourceLen) throw new ToolError(`${path}: ${label} spans ${frames} frames but the source is only ${sourceLen}.`)
    return { trimStart: 0, duration: frames }
  }
  if (sourceLen <= 0) throw new ToolError(`${path}: ${label} is required for this asset — its source length is unknown.`)
  return { trimStart: 0, duration: sourceLen }
}

const rangeText = (n: number) => `(0..${n - 1})`

function requireClip(doc: Doc, id: string, message = `Clip not found: ${id}`): Clip {
  const c = findClip(activeTimeline(doc), id)?.clip
  if (!c) throw new ToolError(message)
  return c
}

function checkEntryKeys(raw: unknown, allowed: string[], key = 'entries'): void {
  if (!Array.isArray(raw)) return
  raw.forEach((e, i) => isObj(e) && validateUnknownKeys(e, allowed, `${key}[${i}]`))
}

// ---------- add_clips / insert_clips ----------

interface AddEntry {
  mediaRef: string
  trackIndex?: number
  startFrame: number
  endFrame?: number
  source?: number[]
}

export function addClips(env: ToolEnv, args: Obj): ToolResult {
  const entryFields = { mediaRef: 'String', trackIndex: opt('Int'), startFrame: 'Int', endFrame: opt('Int'), source: opt({ arr: 'Double' }) } as const
  const input = decodeArgs<{ entries: AddEntry[] }>(args, 'add_clips', { entries: { arr: { obj: entryFields } } })
  if (!input.entries.length) throw new ToolError("Missing or empty 'entries' array")
  checkEntryKeys(args.entries, Object.keys(entryFields))
  const doc = env.session.doc
  const t = activeTimeline(doc)
  const prepared = input.entries.map((e, i) => {
    const asset = clipSource(doc, e.mediaRef, `entries[${i}]`)
    let trackId: string | undefined
    if (e.trackIndex !== undefined) {
      const track = t.tracks[e.trackIndex]
      if (!track) throw new ToolError(`entries[${i}]: track index ${e.trackIndex} out of range ${rangeText(t.tracks.length)}`)
      if (!isCompatibleType(asset.type, track.type)) throw new ToolError(`entries[${i}]: asset type ${asset.type} is not compatible with ${track.type} track at index ${e.trackIndex}`)
      trackId = track.id
    }
    if (e.startFrame < 0) throw new ToolError(`entries[${i}]: startFrame must be >= 0 (got ${e.startFrame})`)
    return { e, asset, trackId }
  })
  const omitted = prepared.filter((p) => !p.trackId).length
  if (omitted !== 0 && omitted !== prepared.length) {
    throw new ToolError(`Mixed trackIndex: ${omitted} of ${prepared.length} entries omitted trackIndex. Either set it on every entry or omit it on every entry (to auto-create shared tracks).`)
  }
  const specs: PlacementSpec[] = prepared.map(({ e, asset, trackId }, i) => {
    if (e.endFrame !== undefined && e.endFrame <= e.startFrame) throw new ToolError(`entries[${i}]: endFrame (${e.endFrame}) must be greater than startFrame (${e.startFrame})`)
    const place = resolvePlacement(asset, t.fps, e.endFrame !== undefined ? e.endFrame - e.startFrame : undefined, e.source, `entries[${i}]`, 'endFrame')
    return { asset, trackId, startFrame: e.startFrame, durationFrames: place.duration, trimStartFrame: place.trimStart }
  })
  const before = snapshot(doc)
  const note = mutate(env, specs.length === 1 ? 'Add Clip (Agent)' : 'Add Clips (Agent)', (d) => {
    const n = adoptClipResolution(
      d,
      specs.map((s) => s.asset).filter((a) => a.type !== 'sequence'),
    )
    placeAgentClips(d, specs)
    return n
  })
  return mutationResult(env.session.doc, before, { notes: note ? [note] : [] })
}

interface InsertEntry {
  mediaRef: string
  durationFrames?: number
  source?: number[]
}

export function insertClips(env: ToolEnv, args: Obj): ToolResult {
  const entryFields = { mediaRef: 'String', durationFrames: opt('Int'), source: opt({ arr: 'Double' }) } as const
  const input = decodeArgs<{ trackIndex: number; atFrame: number; entries: InsertEntry[] }>(args, 'insert_clips', {
    trackIndex: 'Int',
    atFrame: 'Int',
    entries: { arr: { obj: entryFields } },
  })
  if (!input.entries.length) throw new ToolError("Missing or empty 'entries' array")
  checkEntryKeys(args.entries, Object.keys(entryFields))
  const doc = env.session.doc
  const t = activeTimeline(doc)
  const track = t.tracks[input.trackIndex]
  if (!track) throw new ToolError(`trackIndex ${input.trackIndex} out of range ${rangeText(t.tracks.length)}`)
  if (input.atFrame < 0) throw new ToolError(`atFrame must be >= 0 (got ${input.atFrame})`)
  const assets = input.entries.map((e, i) => {
    const asset = clipSource(doc, e.mediaRef, `entries[${i}]`)
    if (!isCompatibleType(asset.type, track.type)) throw new ToolError(`entries[${i}]: asset type ${asset.type} is not compatible with ${track.type} track at index ${input.trackIndex}`)
    return asset
  })
  const specs = input.entries.map((e, i) => {
    const place = resolvePlacement(assets[i], t.fps, e.durationFrames, e.source, `entries[${i}]`, 'durationFrames')
    return { asset: assets[i], durationFrames: place.duration, trimStartFrame: place.trimStart }
  })
  const before = snapshot(doc)
  const note = mutate(env, specs.length === 1 ? 'Insert Clip (Agent)' : 'Insert Clips (Agent)', (d) => {
    const n = adoptClipResolution(
      d,
      assets.filter((a) => a.type !== 'sequence'),
    )
    if (!rippleInsertSpecs(d, specs, input.trackIndex, input.atFrame).length) throw new ToolError(`Insert failed on track ${input.trackIndex} at frame ${input.atFrame}`)
    return n
  })
  return mutationResult(env.session.doc, before, { notes: note ? [note] : [] })
}

// ---------- move / remove / links ----------

export function moveClipsTool(env: ToolEnv, args: Obj): ToolResult {
  const moveFields = { clipId: 'String', toTrack: opt('Int'), toFrame: opt('Int') } as const
  const input = decodeArgs<{ moves: { clipId: string; toTrack?: number; toFrame?: number }[] }>(args, 'move_clips', { moves: { arr: { obj: moveFields } } })
  if (!input.moves.length) throw new ToolError("Missing or empty 'moves' array")
  checkEntryKeys(args.moves, Object.keys(moveFields), 'moves')
  const t = activeTimeline(env.session.doc)
  const parsed = input.moves.map((m, i) => {
    const path = `moves[${i}]`
    if (m.toTrack === undefined && m.toFrame === undefined) throw new ToolError(`${path}: at least one of 'toTrack' or 'toFrame' is required`)
    const loc = findClip(t, m.clipId)
    if (!loc) throw new ToolError(`${path}: clip not found: ${m.clipId}`)
    let destTrackId: string | undefined
    if (m.toTrack !== undefined) {
      const dest = t.tracks[m.toTrack]
      if (!dest) throw new ToolError(`${path}: toTrack ${m.toTrack} out of range ${rangeText(t.tracks.length)}`)
      if (!isCompatibleType(dest.type, loc.track.type)) throw new ToolError(`${path}: toTrack ${m.toTrack} (${dest.type}) is incompatible with clip's ${loc.track.type} source track`)
      destTrackId = dest.id
    }
    if (m.toFrame !== undefined && m.toFrame < 0) throw new ToolError(`${path}: toFrame must be >= 0 (got ${m.toFrame})`)
    return { clipId: m.clipId, destTrackId, toFrame: m.toFrame }
  })
  const seen = new Set(parsed.map((p) => p.clipId))
  const all = [...parsed]
  for (const p of parsed) {
    if (p.toFrame === undefined) continue
    for (const pm of partnerMoves(t, p.clipId, p.toFrame)) {
      if (seen.has(pm.clipId)) continue
      seen.add(pm.clipId)
      all.push({ clipId: pm.clipId, destTrackId: undefined, toFrame: pm.toFrame })
    }
  }
  const moves = all.flatMap((m) => {
    const loc = findClip(t, m.clipId)
    if (!loc) return []
    const dest = m.destTrackId ? t.tracks.findIndex((x) => x.id === m.destTrackId) : -1
    return [{ clipId: m.clipId, toTrack: dest >= 0 ? dest : loc.trackIndex, toFrame: m.toFrame ?? loc.clip.startFrame }]
  })
  const before = snapshot(env.session.doc)
  mutate(env, parsed.length === 1 ? 'Move Clip (Agent)' : 'Move Clips (Agent)', (d) => moveClips(d, moves))
  return mutationResult(env.session.doc, before, { touched: all.map((m) => m.clipId) })
}

export function removeClipsTool(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['clipIds'], 'remove_clips')
  const ids = lenient.stringArray(args, 'clipIds')
  if (!ids.length) throw new ToolError("Missing or empty 'clipIds' array")
  const t = activeTimeline(env.session.doc)
  for (const id of ids) if (!findClip(t, id)) throw new ToolError(`Clip not found: ${id}`)
  const expanded = expandToLinkGroup(t, ids)
  const before = snapshot(env.session.doc)
  mutate(env, ids.length === 1 ? 'Remove Clip (Agent)' : 'Remove Clips (Agent)', (d) => deleteClips(d, expanded))
  return mutationResult(env.session.doc, before)
}

export function manageClipLinks(env: ToolEnv, args: Obj): ToolResult {
  const input = decodeArgs<{ action: string; clipIds: string[] }>(args, 'manage_clip_links', { action: 'String', clipIds: { arr: 'String' } })
  if (input.action !== 'link' && input.action !== 'unlink') throw new ToolError(`manage_clip_links.action: Cannot initialize Action from invalid String value ${input.action}`)
  if (!input.clipIds.length) throw new ToolError('manage_clip_links.clipIds must be a non-empty array')
  const t = activeTimeline(env.session.doc)
  input.clipIds.forEach((id, i) => {
    if (!id) throw new ToolError(`manage_clip_links.clipIds[${i}] must be a non-empty clip ID`)
    if (!findClip(t, id)) throw new ToolError(`Clip not found: ${id}`)
  })
  let targets: Set<string>
  if (input.action === 'link') {
    const resolved = linkTargets(t, input.clipIds)
    if (!resolved) throw new ToolError('Link requires at least two clips of different media types that are not already one link group')
    targets = resolved
  } else {
    targets = unlinkTargets(t, input.clipIds)
    if (!targets.size) throw new ToolError('None of the provided clips is linked')
  }
  const before = snapshot(env.session.doc)
  if (input.action === 'link') mutate(env, 'Link', (d) => linkClips(d, targets))
  else mutate(env, 'Unlink', (d) => unlinkClips(d, targets))
  return mutationResult(env.session.doc, before, { touched: [...targets] })
}

// ---------- split / ripple ----------

export function splitClipsTool(env: ToolEnv, args: Obj): ToolResult {
  const input = decodeArgs<{ splits?: { clipId: string; atFrame: number }[]; trackIndex?: number; frames?: number[] }>(args, 'split_clips', {
    splits: opt({ arr: { obj: { clipId: 'String', atFrame: 'Int' } } }),
    trackIndex: opt('Int'),
    frames: opt({ arr: 'Int' }),
  })
  const hasSplits = (input.splits ?? []).length > 0
  const hasTrack = input.trackIndex !== undefined || (input.frames ?? []).length > 0
  if (hasSplits === hasTrack) {
    throw new ToolError("Provide exactly one of 'splits' (an array of {clipId, atFrame}) or 'trackIndex'+'frames' (project frames to cut on one track).")
  }
  const t = activeTimeline(env.session.doc)
  const points: { trackIndex: number; atFrame: number }[] = []
  const seen = new Set<string>()
  const addCut = (trackIndex: number, atFrame: number, clip: Clip) => {
    if (!(atFrame > clip.startFrame && atFrame < endFrame(clip))) throw new ToolError(`Frame ${atFrame} is outside clip ${clip.id} range (${clip.startFrame}..${endFrame(clip)})`)
    const key = `${trackIndex}:${atFrame}`
    if (seen.has(key)) return
    seen.add(key)
    points.push({ trackIndex, atFrame })
  }
  if (hasSplits) {
    for (const s of input.splits!) {
      const loc = findClip(t, s.clipId)
      if (!loc) throw new ToolError(`Clip not found: ${s.clipId}`)
      addCut(loc.trackIndex, s.atFrame, loc.clip)
    }
  } else {
    const ti = input.trackIndex
    if (ti === undefined || ti < 0 || ti >= t.tracks.length) throw new ToolError(`trackIndex is required and must be in 0..${t.tracks.length - 1}`)
    if (!input.frames?.length) throw new ToolError("'frames' must be a non-empty array of project frames")
    for (const f of input.frames) {
      const clip = t.tracks[ti].clips.find((c) => f > c.startFrame && f < endFrame(c))
      if (!clip) throw new ToolError(`Frame ${f} is not strictly inside any clip on track ${ti}`)
      addCut(ti, f, clip)
    }
  }
  if (!points.length) throw new ToolError('No valid split points')
  const before = snapshot(env.session.doc)
  mutate(env, points.length === 1 ? 'Split Clip (Agent)' : 'Split Clips (Agent)', (d) => splitTimelineClips(activeTimeline(d), points))
  return mutationResult(env.session.doc, before)
}

/** Swift `clampInt`: NaN/low → lo, high → hi, else rounded half away from zero. */
const clampInt = (v: number, lo: number, hi: number) => (Number.isNaN(v) || v <= lo ? lo : v >= hi ? hi : round(v))

export function rippleDeleteRangesTool(env: ToolEnv, args: Obj): ToolResult {
  const input = decodeArgs<{ clipId?: string; trackIndex?: number; ranges: number[][]; units?: string; ignoreSyncLockedTracks?: number[] }>(args, 'ripple_delete_ranges', {
    clipId: opt('String'),
    trackIndex: opt('Int'),
    ranges: { arr: { arr: 'Double' } },
    units: opt('String'),
    ignoreSyncLockedTracks: opt({ arr: 'Int' }),
  })
  if (!input.ranges.length) throw new ToolError("Missing or empty 'ranges' array")
  const units = input.units ?? 'frames'
  if (units !== 'seconds' && units !== 'frames') throw new ToolError(`units must be 'seconds' or 'frames' (got '${units}')`)
  if ((input.clipId !== undefined) === (input.trackIndex !== undefined)) {
    throw new ToolError(
      "Provide exactly one of 'clipId' (cut within a single clip; allows 'seconds') or 'trackIndex' (cut project-frame ranges spanning a whole track in one call).",
    )
  }
  input.ranges.forEach((r, i) => {
    if (r.length !== 2) throw new ToolError(`ranges[${i}]: expected [start, end] (got ${r.length} element${r.length === 1 ? '' : 's'})`)
    if (!(r[1] > r[0])) throw new ToolError(`ranges[${i}]: end (${swiftDouble(r[1])}) must be greater than start (${swiftDouble(r[0])})`)
  })
  const t = activeTimeline(env.session.doc)
  const ranges: FrameRange[] = []
  let dropped = 0
  let trackIndex: number
  if (input.clipId !== undefined) {
    const loc = findClip(t, input.clipId)
    if (!loc) throw new ToolError(`Clip not found: ${input.clipId}`)
    const c = loc.clip
    const toFrame = (v: number) => (units === 'frames' ? v : c.startFrame + (v * t.fps - c.trimStartFrame) / Math.max(c.speed, 0.0001))
    for (const r of input.ranges) {
      const s = clampInt(toFrame(r[0]), c.startFrame, endFrame(c))
      const e = clampInt(toFrame(r[1]), c.startFrame, endFrame(c))
      if (e > s) ranges.push({ start: s, end: e })
      else dropped++
    }
    if (!ranges.length) {
      throw new ToolError(`No ranges fall within clip ${input.clipId} (frames ${c.startFrame}..${endFrame(c)}). In '${units}' units, ranges must overlap the clip's visible span.`)
    }
    trackIndex = loc.trackIndex
  } else {
    trackIndex = input.trackIndex!
    if (units !== 'frames') throw new ToolError("units 'seconds' requires a clipId for source-media mapping; with trackIndex, ranges are project frames.")
    if (!t.tracks[trackIndex]) throw new ToolError(`Track index out of range: ${trackIndex}`)
    const total = totalFrames(t)
    for (const r of input.ranges) {
      const s = clampInt(r[0], 0, total)
      const e = clampInt(r[1], 0, total)
      if (e > s) ranges.push({ start: s, end: e })
      else dropped++
    }
    if (!ranges.length) throw new ToolError(`No valid project-frame ranges to delete on track ${trackIndex}.`)
  }
  const anchorId = t.tracks[trackIndex].id
  const before = snapshot(env.session.doc)
  const rippleMarkers = env.app.settings().rippleTimelineMarkers
  const report = mutate(env, 'Ripple Delete (Agent)', (d) => rippleDeleteRanges(d, trackIndex, ranges, { rippleMarkers }, new Set(input.ignoreSyncLockedTracks ?? [])))
  const anchor = activeTimeline(env.session.doc).tracks.find((tr) => tr.id === anchorId)
  const extra: Obj = { removedFrames: report.removedFrames }
  if (dropped) extra.rangesIgnored = dropped
  return mutationResult(env.session.doc, before, { touched: anchor?.clips.map((c) => c.id) ?? [], extra })
}

// ---------- swap media ----------

export function swapClipMediaTool(env: ToolEnv, args: Obj): ToolResult {
  validateUnknownKeys(args, ['clipId', 'mediaRef'], 'swap_clip_media')
  const clipId = lenient.requireString(args, 'clipId')
  const mediaRef = lenient.requireString(args, 'mediaRef')
  const doc = env.session.doc
  if (!doc.manifest.entries.some((e) => e.id === mediaRef)) throw new ToolError(`Replacement media not found: ${mediaRef}`)
  const replacement = placeableAsset(doc, mediaRef)!
  const before = snapshot(doc)
  const plan = mutate(env, 'Replace Clip Source', (d) => swapClipMedia(d, clipId, replacement, activeTimeline(d).fps))
  return mutationResult(env.session.doc, before, {
    touched: plan.changed ? plan.affectedClipIds : [],
    extra: { changed: plan.changed, clipId: plan.clipId, oldMediaRef: plan.oldMediaRef, mediaRef: plan.newMediaRef, affectedClipIds: plan.affectedClipIds },
  })
}

// ---------- set_clip_properties ----------

interface PropsInput {
  clipIds?: string[]
  durationFrames?: number
  trimStartFrame?: number
  trimEndFrame?: number
  speed?: number
  volumeDb?: number
  opacity?: number
  fadeInFrames?: number
  fadeOutFrames?: number
  fadeInInterpolation?: string
  fadeOutInterpolation?: string
  edgeRounding?: number
  edgeSoftness?: number
  transform?: { centerX?: number; centerY?: number; width?: number; height?: number; rotation?: number; flipHorizontal?: boolean; flipVertical?: boolean }
  crop?: Partial<Crop>
  blendMode?: string
}

const TRANSFORM_FIELDS = { centerX: opt('Double'), centerY: opt('Double'), width: opt('Double'), height: opt('Double'), rotation: opt('Double'), flipHorizontal: opt('Bool'), flipVertical: opt('Bool') } as const
const CROP_FIELDS = { left: opt('Double'), top: opt('Double'), right: opt('Double'), bottom: opt('Double') } as const

function fadeInterpolation(raw: string | undefined, field: string): Interpolation | undefined {
  if (raw === undefined) return undefined
  if (raw !== 'linear' && raw !== 'smooth') throw new ToolError(`${field} must be 'linear' or 'smooth' (got '${raw}')`)
  return raw
}

const hasAny = (o?: object) => !!o && Object.values(o).some((v) => v !== undefined)

function mergedCrop(base: Crop, patch: Partial<Crop>, path: string): Crop {
  const out = { ...base }
  for (const edge of ['left', 'top', 'right', 'bottom'] as const) {
    const v = patch[edge]
    if (v === undefined) continue
    if (v < 0) throw new ToolError(`${path}.${edge} must be >= 0 (got ${swiftDouble(v)})`)
    out[edge] = v
  }
  const vw = 1 - out.left - out.right
  const vh = 1 - out.top - out.bottom
  if (!(vw >= CROP_MIN_VISIBLE && vh >= CROP_MIN_VISIBLE)) {
    throw new ToolError(`${path} must leave at least ${CROP_MIN_VISIBLE} of the source visible on each axis (got width ${swiftDouble(vw)}, height ${swiftDouble(vh)})`)
  }
  return out
}

export function setClipProperties(env: ToolEnv, args: Obj): ToolResult {
  for (const [key, allowed] of [
    ['transform', TRANSFORM_FIELDS],
    ['crop', CROP_FIELDS],
  ] as const) {
    if (args[key] === undefined) continue
    if (!isObj(args[key])) throw new ToolError(`set_clip_properties.${key}: expected object`)
    validateUnknownKeys(args[key] as Obj, Object.keys(allowed), `set_clip_properties.${key}`)
  }
  const input = decodeArgs<PropsInput>(args, 'set_clip_properties', {
    clipIds: opt({ arr: 'String' }),
    durationFrames: opt('Int'),
    trimStartFrame: opt('Int'),
    trimEndFrame: opt('Int'),
    speed: opt('Double'),
    volumeDb: opt('Double'),
    opacity: opt('Double'),
    fadeInFrames: opt('Int'),
    fadeOutFrames: opt('Int'),
    fadeInInterpolation: opt('String'),
    fadeOutInterpolation: opt('String'),
    edgeRounding: opt('Double'),
    edgeSoftness: opt('Double'),
    transform: opt({ obj: TRANSFORM_FIELDS }),
    crop: opt({ obj: CROP_FIELDS }),
    blendMode: opt('String'),
  })
  const clipIds = input.clipIds ?? []
  if (!clipIds.length) throw new ToolError("Provide a non-empty 'clipIds' array")
  const scalarKeys = ['durationFrames', 'trimStartFrame', 'trimEndFrame', 'speed', 'volumeDb', 'opacity', 'fadeInFrames', 'fadeOutFrames', 'fadeInInterpolation', 'fadeOutInterpolation', 'edgeRounding', 'edgeSoftness', 'blendMode'] as const
  if (!scalarKeys.some((k) => input[k] !== undefined) && !hasAny(input.transform) && !hasAny(input.crop)) throw new ToolError('set_clip_properties needs at least one property to apply')
  if (input.durationFrames !== undefined && input.durationFrames < 1) throw new ToolError(`durationFrames must be >= 1 (got ${input.durationFrames})`)
  if (input.speed !== undefined && input.speed <= 0) throw new ToolError(`speed must be > 0 (got ${swiftDouble(input.speed)})`)
  if (input.volumeDb !== undefined && !(input.volumeDb >= VOLUME_DB.min && input.volumeDb <= VOLUME_DB.max)) {
    throw new ToolError(`volumeDb must be between ${swiftDouble(VOLUME_DB.min)} and +${swiftDouble(VOLUME_DB.max)} dB (got ${swiftDouble(input.volumeDb)})`)
  }
  if (input.opacity !== undefined && !(input.opacity >= 0 && input.opacity <= 1)) throw new ToolError(`opacity must be between 0 and 1 (got ${swiftDouble(input.opacity)})`)
  if (input.fadeInFrames !== undefined && input.fadeInFrames < 0) throw new ToolError(`fadeInFrames must be >= 0 (got ${input.fadeInFrames})`)
  if (input.fadeOutFrames !== undefined && input.fadeOutFrames < 0) throw new ToolError(`fadeOutFrames must be >= 0 (got ${input.fadeOutFrames})`)
  const fadeIn = fadeInterpolation(input.fadeInInterpolation, 'fadeInInterpolation')
  const fadeOut = fadeInterpolation(input.fadeOutInterpolation, 'fadeOutInterpolation')
  for (const [name, v] of [
    ['edgeRounding', input.edgeRounding],
    ['edgeSoftness', input.edgeSoftness],
  ] as const) {
    if (v !== undefined && !(Number.isFinite(v) && v >= 0 && v <= 1)) throw new ToolError(`${name} must be between 0 and 1 (got ${swiftDouble(v)})`)
  }
  if (input.trimStartFrame !== undefined && input.trimStartFrame < 0) throw new ToolError(`trimStartFrame must be >= 0 (got ${input.trimStartFrame})`)
  if (input.trimEndFrame !== undefined && input.trimEndFrame < 0) throw new ToolError(`trimEndFrame must be >= 0 (got ${input.trimEndFrame})`)

  const doc = env.session.doc
  const t = activeTimeline(doc)
  const targets = new Map(clipIds.map((id) => [id, requireClip(doc, id)]))
  const timing = { durationFrames: input.durationFrames, trimStartFrame: input.trimStartFrame, trimEndFrame: input.trimEndFrame, speed: input.speed }
  const timingGiven = Object.values(timing).some((v) => v !== undefined)
  if (timingGiven && clipIds.some((id) => targets.get(id)!.multicamGroupId)) {
    throw new ToolError(
      'Timing fields would slip a multicam clip out of sync — switch angles with change_cam; split/delete and property fields (volumeDb, opacity, edgeRounding, edgeSoftness, transform, crop) stay editable.',
    )
  }
  if (input.fadeInFrames !== undefined || input.fadeOutFrames !== undefined) {
    for (const id of clipIds) {
      const candidate: Clip = JSON.parse(JSON.stringify(targets.get(id)))
      applyPropertyChange(candidate, timing)
      const fi = input.fadeInFrames ?? candidate.fadeInFrames
      const fo = input.fadeOutFrames ?? candidate.fadeOutFrames
      if (!(fi <= candidate.durationFrames && fo <= candidate.durationFrames - fi)) {
        throw new ToolError(`Fades for clip ${id} must fit within its resulting duration of ${candidate.durationFrames} frames (fadeInFrames ${fi} + fadeOutFrames ${fo})`)
      }
    }
  }
  const unsupported = (kinds: string[]) => [...targets].filter(([, c]) => kinds.includes(c.mediaType)).map(([id]) => id).sort()
  let blendMode: BlendMode | null | undefined
  if (input.blendMode !== undefined) {
    const bad = unsupported(['text', 'audio'])
    if (bad.length) throw new ToolError(`blendMode only applies to video/image clips: ${bad.join(', ')}`)
    if (input.blendMode === 'normal') blendMode = null
    else if (!(BLEND_MODES as string[]).includes(input.blendMode)) throw new ToolError(`invalid blendMode '${input.blendMode}'. Valid: ${BLEND_MODES.join(', ')}`)
    else blendMode = input.blendMode as BlendMode
  }
  if (input.edgeRounding !== undefined || input.edgeSoftness !== undefined) {
    const bad = unsupported(['audio', 'text'])
    if (bad.length) throw new ToolError(`edgeRounding and edgeSoftness only apply to non-text visual clips: ${bad.join(', ')}`)
  }
  const crops = new Map<string, Crop>()
  if (hasAny(input.crop)) {
    const bad = unsupported(['audio', 'text'])
    if (bad.length) throw new ToolError(`crop only applies to non-text visual clips: ${bad.join(', ')}`)
    for (const id of clipIds) crops.set(id, mergedCrop(cropAt(targets.get(id)!, env.session.ui.playheadFrame), input.crop!, 'set_clip_properties.crop'))
  }
  const partners = timingGiven ? timingPropagationPartners(t, clipIds) : []
  const notes: string[] = []
  const cleared = clipIds.filter((id) => {
    const c = targets.get(id)!
    return (input.volumeDb !== undefined && c.volumeTrack) || (input.opacity !== undefined && c.opacityTrack) || (input.transform?.rotation !== undefined && c.rotationTrack) || (hasAny(input.crop) && c.cropTrack)
  })
  if (cleared.length) notes.push(`Setting a static value cleared existing keyframes on: ${cleared.join(', ')}.`)
  const watched = [...clipIds, ...partners]
  const beforeClips = new Map(watched.map((id) => [id, JSON.stringify(findClip(t, id)?.clip)]))
  const before = snapshot(doc)
  mutate(env, clipIds.length === 1 ? 'Set Clip Property (Agent)' : 'Set Clip Properties (Agent)', (d) => {
    const dt = activeTimeline(d)
    for (const id of clipIds) {
      const c = findClip(dt, id)!.clip
      const skipped = applyPropertyChange(c, {
        ...timing,
        volume: input.volumeDb !== undefined ? dbToLinear(input.volumeDb) : undefined,
        opacity: input.opacity,
        fadeInFrames: input.fadeInFrames,
        fadeOutFrames: input.fadeOutFrames,
        fadeInInterpolation: fadeIn,
        fadeOutInterpolation: fadeOut,
        edgeRounding: input.edgeRounding,
        edgeSoftness: input.edgeSoftness,
        blendMode,
        transform: input.transform,
        crop: crops.get(id),
      })
      notes.push(...skipped.map((n) => `${id}: ${n}`))
    }
    for (const pid of partners) {
      const c = findClip(dt, pid)?.clip
      if (!c) continue
      const text = c.mediaType === 'text'
      applyPropertyChange(c, { durationFrames: input.durationFrames, ...(text ? {} : { trimStartFrame: input.trimStartFrame, trimEndFrame: input.trimEndFrame, speed: input.speed }) })
    }
  })
  const after = activeTimeline(env.session.doc)
  const changed = watched.some((id) => JSON.stringify(findClip(after, id)?.clip) !== beforeClips.get(id))
  return mutationResult(env.session.doc, before, { touched: watched, extra: { changed }, notes })
}

// ---------- copy_clip_settings ----------

export async function copyClipSettings(env: ToolEnv, args: Obj): Promise<ToolResult> {
  if (args.targetTrack !== undefined) {
    if (!isObj(args.targetTrack)) throw new ToolError('copy_clip_settings.targetTrack: expected object')
    validateUnknownKeys(args.targetTrack, ['trackId', 'range'], 'copy_clip_settings.targetTrack')
  }
  const input = decodeArgs<{ sourceClipId: string; targetClipIds?: string[]; targetTrack?: { trackId: string; range?: number[] } }>(args, 'copy_clip_settings', {
    sourceClipId: 'String',
    targetClipIds: opt({ arr: 'String' }),
    targetTrack: opt({ obj: { trackId: 'String', range: opt({ arr: 'Int' }) } }),
  })
  if ((input.targetClipIds !== undefined) === (input.targetTrack !== undefined)) throw new ToolError("Provide exactly one of 'targetClipIds' or 'targetTrack'")
  const doc = env.session.doc
  const t = activeTimeline(doc)
  const source = requireClip(doc, input.sourceClipId)
  let targetIds: string[]
  const extra: Obj = {}
  if (input.targetClipIds) {
    targetIds = [...new Set(input.targetClipIds)]
    if (!targetIds.length) throw new ToolError("Provide a non-empty 'targetClipIds' array")
  } else {
    const sel = input.targetTrack!
    const track = t.tracks.find((tr) => tr.id === sel.trackId)
    if (!track) throw new ToolError(`Track not found: ${sel.trackId}`)
    let range: FrameRange | null = null
    if (sel.range) {
      if (!(sel.range.length === 2 && sel.range[0] >= 0 && sel.range[1] > sel.range[0])) throw new ToolError('targetTrack.range must be [startFrame, endFrame) with 0 <= startFrame < endFrame')
      range = { start: sel.range[0], end: sel.range[1] }
    }
    const scoped = track.clips.filter((c) => !range || (c.startFrame < range.end && endFrame(c) > range.start))
    targetIds = scoped.filter((c) => c.id !== source.id && c.mediaType === source.mediaType).map((c) => c.id)
    if (!targetIds.length) throw new ToolError(`No ${source.mediaType} clips matched targetTrack ${sel.trackId}`)
    extra.targetTrack = sel.range ? { trackId: sel.trackId, range: sel.range } : { trackId: sel.trackId }
    extra.matchedClipCount = targetIds.length
    extra.incompatibleClipCount = scoped.filter((c) => c.id !== source.id && c.mediaType !== source.mediaType).length
    extra.sourceExcluded = scoped.some((c) => c.id === source.id)
  }
  for (const id of targetIds) {
    const c = requireClip(doc, id)
    if (c.mediaType !== source.mediaType) throw new ToolError(`Clip ${id} is ${c.mediaType}; copied settings require ${source.mediaType} clips.`)
  }
  const boxes = new Map<string, TextBox>()
  if (source.mediaType === 'text') {
    const style = source.textStyle ?? defaultTextStyle()
    const measured = await measureBoxes(env, t, targetIds.map((id) => ({ content: requireClip(doc, id).textContent ?? ' ', style })))
    targetIds.forEach((id, i) => boxes.set(id, measured[i]))
  }
  const before = snapshot(doc)
  const transfer = mutate(env, 'Copy Clip Settings (Agent)', (d) => applyClipSettings(d, source.id, targetIds, boxes))
  Object.assign(extra, { changed: transfer.changed.length > 0, sourceClipId: source.id, mediaType: source.mediaType })
  if (input.targetClipIds) Object.assign(extra, { targetClipIds: targetIds, changedClipIds: transfer.changed, unchangedClipIds: transfer.unchanged })
  else Object.assign(extra, { changedClipCount: transfer.changed.length, unchangedClipCount: transfer.unchanged.length })
  return mutationResult(env.session.doc, before, { touched: input.targetClipIds ? transfer.changed : [], extra })
}

// ---------- set_keyframes ----------

const KEYFRAME_PROPERTIES = ['blur', 'crop', 'opacity', 'position', 'rotation', 'scale', 'volumeDb']

function kfInt(raw: unknown, path: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || Math.abs(raw) >= 2 ** 63) throw new ToolError(`${path}: expected integer`)
  return Math.trunc(raw) + 0
}

function kfDouble(raw: unknown, path: string): number {
  if (typeof raw !== 'number') throw new ToolError(`${path}: expected number`)
  return raw
}

function kfInterp(raw: unknown, path: string): Interpolation {
  if (raw === undefined) return 'smooth'
  if (raw === 'linear' || raw === 'hold' || raw === 'smooth') return raw
  throw new ToolError(`${path}: expected one of 'linear', 'hold', 'smooth' (got ${typeof raw === 'number' ? swiftDouble(raw) : String(raw)})`)
}

function parseRows<V>(rows: unknown[], fields: string[], build: (v: number[]) => V, range?: [number, number]): KeyframeTrack<V> {
  const labels = fields.join(', ')
  const min = fields.length + 1
  const out: Keyframe<V>[] = []
  rows.forEach((raw, i) => {
    const path = `keyframes[${i}]`
    if (!Array.isArray(raw)) throw new ToolError(`${path}: expected array [frame, ${labels}, interp?]`)
    if (raw.length !== min && raw.length !== min + 1) throw new ToolError(`${path}: expected [frame, ${labels}] or [frame, ${labels}, interp] (got ${raw.length} elements)`)
    const frame = kfInt(raw[0], `${path}[0] (frame)`)
    const values = fields.map((f, k) => kfDouble(raw[k + 1], `${path}[${k + 1}] (${f})`))
    if (range && !(values[0] >= range[0] && values[0] <= range[1])) {
      throw new ToolError(`${path}[1] (${fields[0]}): must be between ${swiftDouble(range[0])} and ${swiftDouble(range[1])} (got ${swiftDouble(values[0])})`)
    }
    out.push({ frame, value: build(values), interpolationOut: kfInterp(raw.length > min ? raw[min] : undefined, `${path}[${min}] (interp)`) })
  })
  const sorted = out.map((k, i) => ({ k, i })).sort((a, b) => a.k.frame - b.k.frame || a.i - b.i)
  const deduped: Keyframe<V>[] = []
  for (const { k } of sorted) {
    if (deduped.length && deduped[deduped.length - 1].frame === k.frame) deduped[deduped.length - 1] = k
    else deduped.push(k)
  }
  return { keyframes: deduped }
}

export function setKeyframes(env: ToolEnv, args: Obj): ToolResult {
  const input = decodeArgs<{ clipId: string; property: string }>(args, 'set_keyframes', { clipId: 'String', property: 'String' }, ['keyframes'])
  if (!Array.isArray(args.keyframes)) throw new ToolError("Missing required field 'keyframes' (must be an array)")
  const rows = args.keyframes as unknown[]
  if (!KEYFRAME_PROPERTIES.includes(input.property)) throw new ToolError(`Unknown property '${input.property}'. Expected one of: ${KEYFRAME_PROPERTIES.join(', ')}`)
  const clip = requireClip(env.session.doc, input.clipId)
  if (input.property === 'blur' && !supportsKeyframes(clip, 'blur')) throw new ToolError(`Clip ${input.clipId} does not support blur keyframes.`)
  const scalar = (v: number[]) => v[0]
  const pair = (v: number[]) => ({ a: v[0], b: v[1] })
  const parsers: Record<string, () => KeyframeTrack<unknown>> = {
    volumeDb: () => parseRows(rows, ['decibels'], scalar, [VOLUME_DB.min, VOLUME_DB.max]),
    opacity: () => parseRows(rows, ['value'], scalar, [0, 1]),
    rotation: () => parseRows(rows, ['value'], scalar),
    position: () => parseRows(rows, ['a', 'b'], pair),
    scale: () => parseRows(rows, ['a', 'b'], pair),
    crop: () => parseRows(rows, ['top', 'right', 'bottom', 'left'], (v) => ({ left: v[3], top: v[0], right: v[1], bottom: v[2] })),
    blur: () => parseRows(rows, ['value'], scalar, [0, 100]),
  }
  const track = parsers[input.property]()
  const before = snapshot(env.session.doc)
  mutate(env, 'Set Keyframes (Agent)', (d) => replaceKeyframeTrack(findClip(activeTimeline(d), input.clipId)!.clip, input.property as KeyframeProperty, track as KeyframeTrack<number>))
  return mutationResult(env.session.doc, before, { touched: [input.clipId], notes: rows.length ? [] : [`Cleared ${input.property} keyframes.`] })
}

