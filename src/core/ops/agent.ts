/**
 * Domain operations the agent tools need beyond the UI op registry. Pure functions over a `Doc`
 * draft (or a clip within it); refusals throw `EditRefusal` so the caller's transaction rolls back.
 */
import { endFrame, setClipDuration, sourceFramesConsumed, supportsRetiming } from '../clip'
import type { AnimPair, Interpolation, KeyframeTrack } from '../keyframes'
import {
  defaultTextStyle,
  newClip,
  type BlendMode,
  type Clip,
  type Crop,
  type RGBA,
  type TextAnimation,
  type TextFillMode,
  type TextStyle,
  type Timeline,
  type Transform,
  type WordTiming,
} from '../model'
import {
  EditRefusal,
  allClips,
  applyShifts,
  clearRegion,
  computeRipplePush,
  findClip,
  insertTrack,
  linkedPartnerIds,
  multicamManualRippleViolation,
  rippleMarkersOpening,
  round,
  setBlurKeyframeTrack,
  sortClips,
  splitClip,
} from '../timeline'
import { placeClip } from './clips'
import { activeTimeline, multicamGroupName, placeableAsset, type Doc, type PlaceableAsset } from './context'
import { layoutPlacement, type LayoutFit, type LayoutRect, type PixelSize } from './layout'
import { applyTimelineSettings, fitTextBox, type TextBox } from './project'

// ---------- Linked partners ----------

/** Linked partners of a single-clip frame move, shifted by the same delta (keeps J/L-cut offsets). */
export function partnerMoves(t: Timeline, clipId: string, toFrame: number): { clipId: string; toFrame: number }[] {
  const lead = findClip(t, clipId)
  if (!lead) return []
  const delta = toFrame - lead.clip.startFrame
  if (delta === 0) return []
  return linkedPartnerIds(t, clipId).flatMap((pid) => {
    const p = findClip(t, pid)
    return p ? [{ clipId: pid, toFrame: Math.max(0, p.clip.startFrame + delta) }] : []
  })
}

/** Partners (outside `ids`) that receive a timing change applied to `ids`. */
export function timingPropagationPartners(t: Timeline, ids: Iterable<string>): string[] {
  const set = new Set(ids)
  const out = new Set<string>()
  for (const id of set) for (const pid of linkedPartnerIds(t, id)) if (!set.has(pid)) out.add(pid)
  return [...out]
}

function expandLinks(t: Timeline, ids: Iterable<string>): Set<string> {
  const out = new Set(ids)
  const groups = new Set(allClips(t).filter((c) => out.has(c.id) && c.linkGroupId).map((c) => c.linkGroupId!))
  for (const c of allClips(t)) if (c.linkGroupId && groups.has(c.linkGroupId)) out.add(c.id)
  return out
}

/** The complete set a link would merge, or null when linking is not meaningful. */
export function linkTargets(t: Timeline, ids: Iterable<string>): Set<string> | null {
  const expanded = expandLinks(t, ids)
  if (expanded.size < 2) return null
  const clips = allClips(t).filter((c) => expanded.has(c.id))
  if (clips.length !== expanded.size || new Set(clips.map((c) => c.mediaType)).size < 2) return null
  const grouped = clips.filter((c) => c.linkGroupId)
  if (new Set(grouped.map((c) => c.linkGroupId)).size === 1 && grouped.length === clips.length) return null
  return expanded
}

export function unlinkTargets(t: Timeline, ids: Iterable<string>): Set<string> {
  const expanded = expandLinks(t, ids)
  return new Set(allClips(t).filter((c) => expanded.has(c.id) && c.linkGroupId).map((c) => c.id))
}

// ---------- Settings adoption ----------

const validDimension = (v: number | undefined): v is number => v !== undefined && Number.isSafeInteger(v) && v >= 2 && v <= 8192

/** Agent variant of the settings check: resolution may follow the first video, fps never does. */
export function adoptClipResolution(doc: Doc, assets: PlaceableAsset[]): string | null {
  const t = activeTimeline(doc)
  const notes: string[] = []
  const v = assets.find((a) => a.type === 'video')
  if (v) {
    const w = v.sourceWidth ?? t.width
    const h = v.sourceHeight ?? t.height
    const apply = (note: string) => {
      if (!validDimension(w) || !validDimension(h)) return
      const changed = w !== t.width || h !== t.height
      applyTimelineSettings(doc, t.fps, w, h)
      if (changed) notes.push(note)
    }
    if (!t.settingsConfigured) apply(`Set timeline to ${w}×${h} to match clip.`)
    else if (!allClips(t).length && ((v.sourceWidth !== undefined && v.sourceWidth !== t.width) || (v.sourceHeight !== undefined && v.sourceHeight !== t.height))) {
      apply(`Matched timeline resolution to clip: ${w}×${h}.`)
    }
  }
  const fps = v?.sourceFPS !== undefined ? round(v.sourceFPS) : undefined
  const tl = activeTimeline(doc)
  if (fps !== undefined && fps !== tl.fps) {
    notes.push(
      `Clip is ${fps}fps but project is ${tl.fps}fps; clips placed at ${tl.fps}fps and frame counts are interpreted at ${tl.fps}fps. To conform, call set_project_settings then re-read get_timeline.`,
    )
  }
  return notes.length ? notes.join(' ') : null
}

// ---------- Placement ----------

export interface PlacementSpec {
  asset: PlaceableAsset
  trackId?: string
  startFrame: number
  durationFrames: number
  trimStartFrame: number
}

/** Overwrite placement of a batch (audio first, then by track/start); auto tracks when no spec names one. */
export function placeAgentClips(doc: Doc, specsIn: PlacementSpec[]): string[] {
  const t = activeTimeline(doc)
  const specs = specsIn.map((s) => ({ ...s }))
  if (specs.every((s) => !s.trackId)) {
    const videoId = specs.some((s) => s.asset.type !== 'audio') ? t.tracks[insertTrack(t, 0, 'video')].id : undefined
    const audioId = specs.some((s) => s.asset.type === 'audio') ? t.tracks[insertTrack(t, t.tracks.length, 'audio')].id : undefined
    for (const s of specs) s.trackId = s.asset.type === 'audio' ? audioId : videoId
  }
  const nonEmptyBefore = new Set(t.tracks.filter((tr) => tr.clips.length).map((tr) => tr.id))
  const order = specs
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const aa = a.s.asset.type === 'audio' ? 0 : 1
      const bb = b.s.asset.type === 'audio' ? 0 : 1
      if (aa !== bb) return aa - bb
      if (a.s.trackId !== b.s.trackId) return a.s.trackId! < b.s.trackId! ? -1 : 1
      return a.s.startFrame - b.s.startFrame
    })
  const added: string[] = []
  for (const { s, i } of order) {
    const ti = t.tracks.findIndex((x) => x.id === s.trackId)
    if (ti < 0) throw new EditRefusal(`entries[${i}]: destination track no longer exists`)
    clearRegion(t, ti, s.startFrame, s.startFrame + s.durationFrames)
    const ids = placeClip(doc, t, s.asset, ti, s.startFrame, s.durationFrames, { trimStartFrame: s.trimStartFrame })
    if (!ids.length) throw new EditRefusal(`entries[${i}]: failed to place clip on track ${ti} at frame ${s.startFrame}`)
    added.push(...ids)
  }
  t.tracks = t.tracks.filter((tr) => tr.clips.length || !nonEmptyBefore.has(tr.id))
  return added
}

export interface InsertSpec {
  asset: PlaceableAsset
  durationFrames: number
  trimStartFrame: number
}

/**
 * Agent ripple insert: pins the linked-audio track, splits straddlers on every pushed track, pushes the
 * target, sync-locked and linked-audio tracks, then lays the specs end to end. Returns [] when refused.
 */
export function rippleInsertSpecs(doc: Doc, specs: InsertSpec[], trackIndex: number, atFrame: number): string[] {
  const t = activeTimeline(doc)
  if (!t.tracks[trackIndex] || !specs.length) return []
  const shifting = new Set(t.tracks.filter((tr, i) => i === trackIndex || tr.syncLocked).map((tr) => tr.id))
  if (multicamManualRippleViolation(t, shifting, atFrame, (id) => multicamGroupName(doc, id))) return []
  const totalPush = specs.reduce((s, x) => s + x.durationFrames, 0)
  const targetId = t.tracks[trackIndex].id
  const needsAudio = t.tracks[trackIndex].type === 'video' && specs.some((s) => s.asset.hasAudio && (s.asset.type === 'video' || s.asset.type === 'sequence'))
  let audioId: string | undefined
  if (needsAudio) {
    const first = t.tracks.findIndex((tr) => tr.type === 'audio')
    audioId = t.tracks[first >= 0 ? first : insertTrack(t, t.tracks.length, 'audio')].id
  }
  const pushIds = t.tracks.filter((tr) => tr.id === targetId || tr.id === audioId || tr.syncLocked).map((tr) => tr.id)
  for (const id of pushIds) {
    const straddler = t.tracks.find((tr) => tr.id === id)?.clips.find((c) => c.startFrame < atFrame && atFrame < endFrame(c))
    if (straddler) splitClip(t, straddler.id, atFrame)
  }
  for (const id of pushIds) {
    const tr = t.tracks.find((x) => x.id === id)
    if (tr) applyShifts(t, computeRipplePush(tr.clips, atFrame, totalPush))
  }
  t.markers = rippleMarkersOpening(t.markers, atFrame, totalPush)
  const created: string[] = []
  let cursor = atFrame
  for (const s of specs) {
    const ti = t.tracks.findIndex((x) => x.id === targetId)
    const ai = audioId ? t.tracks.findIndex((x) => x.id === audioId) : -1
    created.push(...placeClip(doc, t, s.asset, ti, cursor, s.durationFrames, { trimStartFrame: s.trimStartFrame, linkedAudioTrackIndex: ai >= 0 ? ai : undefined }))
    cursor += s.durationFrames
  }
  return created
}

// ---------- Clip properties ----------

export interface TimingChange {
  durationFrames?: number
  trimStartFrame?: number
  trimEndFrame?: number
  speed?: number
}

/** Applies timing fields in the agent's order; returns notes for skipped fields. */
export function applyTimingChange(c: Clip, t: TimingChange): string[] {
  const notes: string[] = []
  if (t.durationFrames !== undefined) setClipDuration(c, t.durationFrames)
  if (t.trimStartFrame !== undefined) c.trimStartFrame = t.trimStartFrame
  if (t.trimEndFrame !== undefined) c.trimEndFrame = t.trimEndFrame
  if (t.speed !== undefined) {
    if (!supportsRetiming(c)) notes.push("speed skipped (nested timelines don't support retiming)")
    else {
      if (t.durationFrames === undefined && t.speed > 0) setClipDuration(c, Math.max(1, round((c.durationFrames * c.speed) / t.speed)))
      c.speed = t.speed
    }
  }
  return notes
}

export interface PropertyChange extends TimingChange {
  volume?: number
  opacity?: number
  fadeInFrames?: number
  fadeOutFrames?: number
  fadeInInterpolation?: Interpolation
  fadeOutInterpolation?: Interpolation
  edgeRounding?: number
  edgeSoftness?: number
  blendMode?: BlendMode | null
  transform?: Partial<Pick<Transform, 'centerX' | 'centerY' | 'width' | 'height' | 'rotation' | 'flipHorizontal' | 'flipVertical'>>
  crop?: Crop
}

/** set_clip_properties semantics: static values clear their keyframe tracks; fades clamp to the duration. */
export function applyPropertyChange(c: Clip, p: PropertyChange): string[] {
  const notes = applyTimingChange(c, p)
  if (p.volume !== undefined) {
    c.volume = p.volume
    delete c.volumeTrack
  }
  if (p.opacity !== undefined) {
    c.opacity = p.opacity
    delete c.opacityTrack
  }
  if (p.fadeInFrames !== undefined) setFadeFrames(c, 'in', p.fadeInFrames)
  if (p.fadeOutFrames !== undefined) setFadeFrames(c, 'out', p.fadeOutFrames)
  if (p.fadeInInterpolation) c.fadeInInterpolation = p.fadeInInterpolation
  if (p.fadeOutInterpolation) c.fadeOutInterpolation = p.fadeOutInterpolation
  if (p.edgeRounding !== undefined) c.edgeRounding = p.edgeRounding
  if (p.edgeSoftness !== undefined) c.edgeSoftness = p.edgeSoftness
  if (p.blendMode !== undefined) {
    if (p.blendMode && p.blendMode !== 'normal') c.blendMode = p.blendMode
    else delete c.blendMode
  }
  if (p.transform) {
    const t = p.transform
    for (const k of ['centerX', 'centerY', 'width', 'height', 'flipHorizontal', 'flipVertical'] as const) if (t[k] !== undefined) (c.transform[k] as number | boolean) = t[k]!
    if (t.rotation !== undefined) {
      c.transform.rotation = t.rotation
      delete c.rotationTrack
    }
  }
  if (p.crop) {
    c.crop = p.crop
    delete c.cropTrack
  }
  return notes
}

function setFadeFrames(c: Clip, edge: 'in' | 'out', frames: number): void {
  if (edge === 'in') c.fadeInFrames = Math.max(0, frames)
  else c.fadeOutFrames = Math.max(0, frames)
  c.fadeInFrames = Math.max(0, Math.min(c.fadeInFrames, c.durationFrames))
  c.fadeOutFrames = Math.max(0, Math.min(c.fadeOutFrames, c.durationFrames - c.fadeInFrames))
}

export type KeyframeProperty = 'volumeDb' | 'opacity' | 'rotation' | 'position' | 'scale' | 'crop' | 'blur'

/** Replaces one property's keyframe track; an empty track clears it. */
export function replaceKeyframeTrack(c: Clip, property: KeyframeProperty, track: KeyframeTrack<number> | KeyframeTrack<AnimPair> | KeyframeTrack<Crop>): void {
  const active = track.keyframes.length ? track : undefined
  const key = ({ volumeDb: 'volumeTrack', opacity: 'opacityTrack', rotation: 'rotationTrack', position: 'positionTrack', scale: 'scaleTrack', crop: 'cropTrack' } as const)[property as Exclude<KeyframeProperty, 'blur'>]
  if (property === 'blur') return setBlurKeyframeTrack(c, active as KeyframeTrack<number> | undefined)
  if (active) (c as unknown as Record<string, unknown>)[key] = active
  else delete c[key]
}

// ---------- Media swap ----------

export interface SwapPlan {
  clipId: string
  oldMediaRef: string
  newMediaRef: string
  affectedClipIds: string[]
  changed: boolean
}

function linkedClipIdsSharingMedia(t: Timeline, anchorId: string): string[] {
  const anchor = findClip(t, anchorId)?.clip
  const ids = new Set([anchorId])
  if (anchor?.linkGroupId) for (const c of allClips(t)) if (c.linkGroupId === anchor.linkGroupId && c.mediaRef === anchor.mediaRef) ids.add(c.id)
  return [...ids].sort()
}

/** Replaces a clip's (and its same-source linked partners') media, keeping edit, framing, effects and keyframes. */
export function swapClipMedia(doc: Doc, clipId: string, replacement: PlaceableAsset, fps: number): SwapPlan {
  const t = activeTimeline(doc)
  const anchor = findClip(t, clipId)?.clip
  if (!anchor) throw new EditRefusal(`Clip not found: ${clipId}`)
  if (anchor.mediaType === 'text' || anchor.sourceClipType === 'text' || anchor.sourceClipType === 'sequence') {
    throw new EditRefusal('This clip does not support media source swapping.')
  }
  const ids = linkedClipIdsSharingMedia(t, clipId)
  if (ids.some((id) => findClip(t, id)?.clip.multicamGroupId)) throw new EditRefusal('Use change_cam for multicam clips.')
  const targets = ids.map((id) => findClip(t, id)?.clip)
  if (targets.some((c) => !c)) throw new EditRefusal('Linked clip not found.')
  const clips = targets as Clip[]
  if (!clips.every((c) => c.sourceClipType === replacement.type)) throw new EditRefusal("Replacement must match the clip's source type.")
  const plan: SwapPlan = { clipId, oldMediaRef: anchor.mediaRef, newMediaRef: replacement.id, affectedClipIds: ids, changed: anchor.mediaRef !== replacement.id }
  if (!plan.changed) return plan
  if (replacement.type === 'video' && !replacement.hasAudio && clips.some((c) => c.mediaType === 'audio')) {
    throw new EditRefusal('Replacement video has no audio for the linked clip.')
  }
  const trimEnds = new Map<string, number>()
  if (replacement.type !== 'image') {
    const available = Math.floor(replacement.duration * fps)
    if (!Number.isSafeInteger(available) || available <= 0) throw new EditRefusal('Replacement media has no valid duration.')
    for (const c of clips) {
      const consumed = sourceFramesConsumed(c)
      if (!Number.isSafeInteger(consumed) || consumed < 0) throw new EditRefusal('Clip has invalid source timing.')
      const required = c.trimStartFrame + consumed
      if (required < 0 || required > available) throw new EditRefusal("Replacement media is too short for the clip's source range.")
      trimEnds.set(c.id, available - required)
    }
  }
  for (const c of clips) {
    c.mediaRef = replacement.id
    const te = trimEnds.get(c.id)
    if (te !== undefined) c.trimEndFrame = te
  }
  return plan
}

// ---------- Clip settings transfer ----------

/** Copies one clip's static settings onto `target` (same media type). Text refits to `box` when given. */
export function copyStaticSettings(source: Clip, target: Clip, box?: TextBox): Clip {
  const result: Clip = JSON.parse(JSON.stringify(target))
  const blur = target.effects?.find((e) => e.type === 'blur.gaussian')?.params.radius?.track
  const effects = source.effects
    ?.filter((e) => !(source.mediaType === 'text' && e.type === 'blur.gaussian'))
    .map((e) => ({ ...e, params: Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, (({ track: _t, ...rest }) => rest)(v)])) }))
  if (effects?.length) result.effects = JSON.parse(JSON.stringify(effects))
  else delete result.effects
  switch (source.mediaType) {
    case 'audio':
      result.volume = source.volume
      break
    case 'text': {
      result.opacity = source.opacity
      copyOptional(result, source, 'textStyle')
      copyOptional(result, source, 'textAnimation')
      copyOptional(result, source, 'textFillMode')
      if (box) fitTextClip(result, box)
      const { centerX, centerY, rotation, flipHorizontal, flipVertical } = source.transform
      Object.assign(result.transform, { centerX, centerY, rotation, flipHorizontal, flipVertical })
      break
    }
    case 'subtitle':
      break
    default:
      result.opacity = source.opacity
      result.transform = { ...source.transform }
      result.crop = { ...source.crop }
      result.edgeRounding = source.edgeRounding
      result.edgeSoftness = source.edgeSoftness
      copyOptional(result, source, 'blendMode')
  }
  if (blur) setBlurKeyframeTrack(result, blur)
  return result
}

function copyOptional<K extends keyof Clip>(dst: Clip, src: Clip, key: K): void {
  if (src[key] === undefined) delete dst[key]
  else dst[key] = JSON.parse(JSON.stringify(src[key]))
}

/** Applies settings to every target; returns which targets actually changed. */
export function applyClipSettings(doc: Doc, sourceId: string, targetIds: string[], boxes: Map<string, TextBox>): { changed: string[]; unchanged: string[] } {
  const source = findClip(activeTimeline(doc), sourceId)?.clip
  if (!source) throw new EditRefusal(`Clip not found: ${sourceId}`)
  return applyClipSettingsFrom(doc, source, targetIds, boxes)
}

/**
 * Paste Settings (03 §4.15): copies a clipboard clip's static settings onto `targetIds`. Validates every
 * target first (exists, same mediaType); a target with the source's id is left untouched.
 */
export function applyClipSettingsFrom(doc: Doc, source: Clip, targetIds: string[], boxes: Map<string, TextBox>): { changed: string[]; unchanged: string[] } {
  const t = activeTimeline(doc)
  for (const id of targetIds) {
    const c = findClip(t, id)?.clip
    if (!c) throw new EditRefusal(`Clip not found: ${id}`)
    if (c.mediaType !== source.mediaType) throw new EditRefusal(`Clip ${id} is ${c.mediaType}; copied settings require ${source.mediaType} clips.`)
  }
  const sourceId = source.id
  const sourceCopy: Clip = JSON.parse(JSON.stringify(source))
  const changed: string[] = []
  const unchanged: string[] = []
  for (const id of targetIds) {
    const loc = findClip(t, id)
    if (!loc) throw new EditRefusal(`Clip not found: ${id}`)
    if (loc.clip.mediaType !== sourceCopy.mediaType) throw new EditRefusal(`Clip ${id} is ${loc.clip.mediaType}; copied settings require ${sourceCopy.mediaType} clips.`)
    const next = id === sourceId ? loc.clip : copyStaticSettings(sourceCopy, loc.clip, boxes.get(id))
    if (JSON.stringify(next) === JSON.stringify(loc.clip)) unchanged.push(id)
    else {
      loc.track.clips[loc.clipIndex] = next
      changed.push(id)
    }
  }
  return { changed, unchanged }
}

// ---------- Text ----------

export const textAnchorX = (centerX: number, width: number, alignment: TextStyle['alignment']): number =>
  alignment === 'left' ? centerX - width / 2 : alignment === 'right' ? centerX + width / 2 : centerX

export const textCenterX = (anchorX: number, width: number, alignment: TextStyle['alignment']): number =>
  alignment === 'left' ? anchorX + width / 2 : alignment === 'right' ? anchorX - width / 2 : anchorX

/** Resizes a text box to `box` (anchored by alignment); false when it already fits within 1e-4. */
export function fitTextClip(c: Clip, box: TextBox): boolean {
  if (c.mediaType !== 'text') return false
  if (Math.abs(box.width - c.transform.width) < 0.0001 && Math.abs(box.height - c.transform.height) < 0.0001) return false
  fitTextBox(c, box)
  return true
}

export const DEFAULT_FOOTAGE_MATTE: RGBA = { r: 0, g: 0, b: 0, a: 1 }

export function setTextFillMode(c: Clip, mode: TextFillMode, footageMatteColor?: RGBA): void {
  if (mode === 'footage' && c.textFillMode !== 'footage') c.textStyle = { ...(c.textStyle ?? defaultTextStyle()), color: footageMatteColor ?? DEFAULT_FOOTAGE_MATTE }
  if (mode === 'color') delete c.textFillMode
  else c.textFillMode = mode
}

export interface ColorPatch {
  value: RGBA
  includesOpacity: boolean
}

export interface TextStylePatch {
  fontName?: string
  fontSize?: number
  widthScale?: number
  heightScale?: number
  isBold?: boolean
  isItalic?: boolean
  isUnderlined?: boolean
  isStruckThrough?: boolean
  isOverlined?: boolean
  tracking?: number
  lineSpacing?: number
  fontCase?: TextStyle['fontCase']
  color?: RGBA
  alignment?: TextStyle['alignment']
  blur?: number
  outline?: { enabled?: boolean; color?: RGBA; width?: number }
  shadow?: { enabled?: boolean; color?: ColorPatch; opacity?: number; offsetX?: number; offsetY?: number; blur?: number }
  background?: {
    enabled?: boolean
    color?: ColorPatch
    opacity?: number
    paddingX?: number
    paddingY?: number
    offsetX?: number
    offsetY?: number
    cornerRadius?: number
    outlineColor?: RGBA
    outlineWidth?: number
  }
}

const defined = (o: object | undefined) => !!o && Object.values(o).some((v) => v !== undefined)

export const stylePatchHasAny = (p: TextStylePatch): boolean =>
  Object.entries(p).some(([k, v]) => (k === 'outline' || k === 'shadow' || k === 'background' ? defined(v as object) : v !== undefined))

export const stylePatchAffectsLayout = (p: TextStylePatch): boolean =>
  [p.fontName, p.fontSize, p.widthScale, p.heightScale, p.isBold, p.isItalic, p.tracking, p.lineSpacing, p.fontCase].some((v) => v !== undefined) ||
  p.outline?.enabled !== undefined ||
  p.outline?.width !== undefined ||
  [p.shadow?.enabled, p.shadow?.offsetX, p.shadow?.offsetY, p.shadow?.blur].some((v) => v !== undefined) ||
  [p.background?.enabled, p.background?.paddingX, p.background?.paddingY].some((v) => v !== undefined)

const mergeColor = (cur: RGBA, patch: ColorPatch): RGBA => (patch.includesOpacity ? { ...patch.value } : { ...patch.value, a: cur.a })

export function applyStylePatch(base: TextStyle, p: TextStylePatch): TextStyle {
  const s: TextStyle = JSON.parse(JSON.stringify(base))
  const scalar = ['fontName', 'fontSize', 'widthScale', 'heightScale', 'isBold', 'isItalic', 'isUnderlined', 'isStruckThrough', 'isOverlined', 'tracking', 'lineSpacing', 'fontCase', 'color', 'alignment', 'blur'] as const
  for (const k of scalar) if (p[k] !== undefined) (s as unknown as Record<string, unknown>)[k] = p[k]
  if (p.outline) {
    if (p.outline.enabled !== undefined) s.border.enabled = p.outline.enabled
    if (p.outline.color) s.border.color = p.outline.color
    if (p.outline.width !== undefined) s.border.width = p.outline.width
  }
  if (p.shadow) {
    const sh = p.shadow
    if (sh.enabled !== undefined) s.shadow.enabled = sh.enabled
    if (sh.color) s.shadow.color = mergeColor(s.shadow.color, sh.color)
    if (sh.opacity !== undefined) s.shadow.color.a = sh.opacity
    if (sh.offsetX !== undefined) s.shadow.offsetX = sh.offsetX
    if (sh.offsetY !== undefined) s.shadow.offsetY = sh.offsetY
    if (sh.blur !== undefined) s.shadow.blur = sh.blur
  }
  if (p.background) {
    const bg = p.background
    if (bg.enabled !== undefined) s.background.enabled = bg.enabled
    if (bg.color) s.background.color = mergeColor(s.background.color, bg.color)
    if (bg.opacity !== undefined) s.background.color.a = bg.opacity
    for (const k of ['paddingX', 'paddingY', 'offsetX', 'offsetY', 'cornerRadius', 'outlineWidth'] as const) if (bg[k] !== undefined) s.background[k] = bg[k]!
    if (bg.outlineColor) s.background.outlineColor = bg.outlineColor
  }
  return s
}

export interface TextClipSpec {
  trackIndex: number
  startFrame: number
  durationFrames: number
  content: string
  style: TextStyle
  /** Natural normalized box of `content` in `style`. */
  box: TextBox
  transform?: Transform
  animation?: TextAnimation
  fillMode?: TextFillMode
  captionGroupId?: string
  words?: WordTiming[]
}

/** Places text clips (overwriting their regions); without a transform the box is centered on the canvas. */
export function placeTextClips(doc: Doc, specs: TextClipSpec[]): string[] {
  const t = activeTimeline(doc)
  const ids: (string | null)[] = specs.map(() => null)
  const byTrack = new Map<number, number[]>()
  specs.forEach((s, i) => byTrack.set(s.trackIndex, [...(byTrack.get(s.trackIndex) ?? []), i]))
  const order = [...byTrack.values()].flatMap((idx) => idx.sort((a, b) => specs[a].startFrame - specs[b].startFrame))
  for (const i of order) {
    const s = specs[i]
    const track = t.tracks[s.trackIndex]
    if (!track) continue
    const start = Math.max(0, s.startFrame)
    const duration = Math.max(1, s.durationFrames)
    clearRegion(t, s.trackIndex, start, start + duration)
    const transform: Transform = s.transform ?? { ...newClip({ mediaRef: '', startFrame: 0, durationFrames: 0 }).transform, width: s.box.width, height: s.box.height }
    const clip = newClip({ mediaRef: '', mediaType: 'text', sourceClipType: 'text', startFrame: start, durationFrames: duration, transform, textContent: s.content, textStyle: s.style })
    if (s.captionGroupId) clip.captionGroupId = s.captionGroupId
    if (s.words) clip.wordTimings = s.words
    if (s.animation) clip.textAnimation = s.animation
    if (s.fillMode) setTextFillMode(clip, s.fillMode, s.style.color)
    t.tracks[s.trackIndex].clips.push(clip)
    ids[i] = clip.id
  }
  for (const ti of byTrack.keys()) if (t.tracks[ti]) sortClips(t.tracks[ti])
  return ids.filter((x): x is string => !!x)
}

export interface TextUpdate {
  content?: string
  style?: TextStylePatch
  /** Natural box for the updated content/style; present when the box must refit. */
  box?: TextBox
  x?: number
  y?: number
  rotation?: number
  rotationX?: number
  rotationY?: number
  /** undefined: untouched; null: animation off; otherwise the preset and optional highlight. */
  animation?: { preset: TextAnimation['preset']; highlight?: RGBA } | null
  highlightOnly?: RGBA
  fillMode?: TextFillMode
}

/** update_text per clip: content, style, refit anchored at the alignment edge, transform, animation, fill. */
export function updateTextClip(c: Clip, u: TextUpdate): void {
  const originalStyle = c.textStyle ?? defaultTextStyle()
  const originalAnchor = textAnchorX(c.transform.centerX, c.transform.width, originalStyle.alignment)
  if (u.content !== undefined) {
    if (c.textContent !== u.content) delete c.wordTimings
    c.textContent = u.content
  }
  if (u.style && stylePatchHasAny(u.style)) {
    c.textStyle = applyStylePatch(c.textStyle ?? defaultTextStyle(), u.style)
    if (u.style.blur !== undefined) setBlurKeyframeTrack(c, undefined)
  }
  if (u.box) fitTextClip(c, u.box)
  const style = c.textStyle ?? defaultTextStyle()
  if (u.box || u.style?.alignment !== undefined || u.x !== undefined) c.transform.centerX = textCenterX(u.x ?? originalAnchor, c.transform.width, style.alignment)
  if (u.y !== undefined) c.transform.centerY = u.y
  if (u.rotation !== undefined) {
    c.transform.rotation = u.rotation
    delete c.rotationTrack
  }
  if (u.rotationX !== undefined) c.transform.rotationX = u.rotationX
  if (u.rotationY !== undefined) c.transform.rotationY = u.rotationY
  if (u.animation === null) delete c.textAnimation
  else if (u.animation) {
    const current: TextAnimation = c.textAnimation ? { ...c.textAnimation } : { preset: 'none', perWordFrames: 6 }
    current.preset = u.animation.preset
    if (u.animation.highlight) current.highlight = u.animation.highlight
    c.textAnimation = current
  }
  if (u.highlightOnly) c.textAnimation = { ...(c.textAnimation ?? { preset: 'none', perWordFrames: 6 }), highlight: u.highlightOnly }
  if (u.fillMode) setTextFillMode(c, u.fillMode, u.style?.color)
}

// ---------- Layout ----------

export function sourcePixelSize(doc: Doc, c: Clip): PixelSize | null {
  const a = placeableAsset(doc, c.mediaRef)
  return a?.sourceWidth && a.sourceHeight ? { width: a.sourceWidth, height: a.sourceHeight } : null
}

export interface LayoutSlotRequest {
  slotId: string
  rect: LayoutRect
  z: number
  anchorX: number
  anchorY: number
  clipIds?: string[]
  asset?: PlaceableAsset
}

/** Frames clips into slots (placing new stacked tracks for assets); clears motion and crop keyframes. */
export function applyLayout(doc: Doc, slots: LayoutSlotRequest[], fit: LayoutFit, startFrame: number, duration: number): Record<string, string[]> {
  const t = activeTimeline(doc)
  const clipsBySlot: Record<string, string[]> = {}
  if (slots.some((s) => s.asset)) {
    const trackBySlot = new Map<string, string>()
    for (const s of [...slots].sort((a, b) => a.z - b.z)) trackBySlot.set(s.slotId, t.tracks[insertTrack(t, 0, 'video')].id)
    for (const s of slots) {
      const ti = t.tracks.findIndex((x) => x.id === trackBySlot.get(s.slotId))
      if (ti < 0 || !s.asset) continue
      const [primary] = placeClip(doc, t, s.asset, ti, startFrame, duration)
      if (primary) clipsBySlot[s.slotId] = [primary]
    }
  } else for (const s of slots) clipsBySlot[s.slotId] = s.clipIds ?? []
  for (const s of slots) {
    for (const id of clipsBySlot[s.slotId] ?? []) {
      const c = findClip(t, id)?.clip
      if (!c) continue
      const p = layoutPlacement(sourcePixelSize(doc, c), { width: t.width, height: t.height }, s.rect, fit, s.anchorX, s.anchorY)
      c.transform = p.transform
      c.crop = p.crop
      delete c.positionTrack
      delete c.scaleTrack
      delete c.rotationTrack
      delete c.cropTrack
    }
  }
  return clipsBySlot
}

