import type { AnimPair, Interpolation, Keyframe, KeyframeTrack } from './keyframes'
import {
  BLEND_MODES,
  CLIP_TYPES,
  TEXT_ANIMATION_PRESETS,
  TRACK_HEIGHT,
  DEFAULTS,
  defaultBackground,
  defaultCrop,
  defaultOutline,
  defaultShadow,
  defaultTextStyle,
  defaultTransform,
  inferBold,
  inferItalic,
  newId,
  type BlendMode,
  type Clip,
  type ClipType,
  type Crop,
  type Effect,
  type EffectParam,
  type MediaFolder,
  type MediaManifest,
  type MediaManifestEntry,
  type MediaSource,
  type MulticamSource,
  type ProjectFile,
  type RGBA,
  type SpeakerRegistryEntry,
  type TextAnimation,
  type TextStyle,
  type Timeline,
  type TimelineMarker,
  type TimelineViewState,
  type Track,
  type Transform,
  type WordTiming,
} from './model'

export class DecodeError extends Error {}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => Number.isSafeInteger(v)

const num = (v: unknown, d: number): number => (isNum(v) ? v : d)
const int = (v: unknown, d: number): number => (isInt(v) ? (v as number) : d)
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d)
const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const optNum = (v: unknown): number | undefined => (isNum(v) ? v : undefined)
const optInt = (v: unknown): number | undefined => (isInt(v) ? (v as number) : undefined)
function oneOf<T extends string>(v: unknown, values: readonly T[], d: T): T {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : d
}
function reqInt(v: unknown, what: string): number {
  if (!isInt(v)) throw new DecodeError(`${what} must be an integer`)
  return v as number
}

/** Unknown keys are preserved so files written by newer Mac builds survive a Linux save. */
const extras = (o: Json, known: readonly string[]): Json => {
  const out: Json = {}
  for (const k of Object.keys(o)) if (!known.includes(k)) out[k] = o[k]
  return out
}

const INTERPOLATIONS: Interpolation[] = ['linear', 'hold', 'smooth']

function decodeRGBA(v: unknown, d: RGBA): RGBA {
  if (!isObj(v) || !isNum(v.r) || !isNum(v.g) || !isNum(v.b) || !isNum(v.a)) return { ...d }
  return { r: v.r, g: v.g, b: v.b, a: v.a }
}

function decodeTrack<V>(v: unknown, value: (x: unknown) => V | undefined): KeyframeTrack<V> | undefined {
  if (!isObj(v) || !Array.isArray(v.keyframes)) return undefined
  const kfs: Keyframe<V>[] = []
  for (const k of v.keyframes) {
    if (!isObj(k) || !isInt(k.frame)) return undefined
    const val = value(k.value)
    if (val === undefined) return undefined
    const interp = oneOf<Interpolation>(k.interpolationOut, INTERPOLATIONS, 'smooth')
    kfs.push({ frame: k.frame as number, value: val, interpolationOut: interp })
  }
  kfs.sort((a, b) => a.frame - b.frame)
  const unique = kfs.filter((k, i) => i === kfs.length - 1 || kfs[i + 1].frame !== k.frame)
  return unique.length ? { keyframes: unique } : undefined
}

const numValue = (x: unknown) => (isNum(x) ? x : undefined)
const pairValue = (x: unknown): AnimPair | undefined => (isObj(x) && isNum(x.a) && isNum(x.b) ? { a: x.a, b: x.b } : undefined)
const cropValue = (x: unknown): Crop | undefined =>
  isObj(x) && isNum(x.left) && isNum(x.top) && isNum(x.right) && isNum(x.bottom)
    ? { left: x.left, top: x.top, right: x.right, bottom: x.bottom }
    : undefined

const TRANSFORM_KEYS = ['centerX', 'centerY', 'width', 'height', 'rotation', 'rotationX', 'rotationY', 'flipHorizontal', 'flipVertical', 'x', 'y'] as const

export function decodeTransform(v: unknown): Transform {
  if (!isObj(v)) return defaultTransform()
  const w = num(v.width, 1)
  const h = num(v.height, 1)
  const cx = isNum(v.centerX) ? v.centerX : isNum(v.x) ? v.x + w - 0.5 : 0.5
  const cy = isNum(v.centerY) ? v.centerY : isNum(v.y) ? v.y + h - 0.5 : 0.5
  return {
    ...(extras(v, TRANSFORM_KEYS) as object),
    centerX: cx,
    centerY: cy,
    width: w,
    height: h,
    rotation: num(v.rotation, 0),
    rotationX: num(v.rotationX, 0),
    rotationY: num(v.rotationY, 0),
    flipHorizontal: bool(v.flipHorizontal, false),
    flipVertical: bool(v.flipVertical, false),
  }
}

function decodeEffect(v: unknown): Effect | undefined {
  if (!isObj(v) || typeof v.type !== 'string') return undefined
  const params: Record<string, EffectParam> = {}
  if (isObj(v.params)) {
    for (const [k, p] of Object.entries(v.params)) {
      if (!isObj(p)) continue
      const param: EffectParam = { ...(extras(p, ['value', 'string', 'track']) as object) }
      if (isNum(p.value)) param.value = p.value
      if (typeof p.string === 'string') param.string = p.string
      const track = decodeTrack(p.track, numValue)
      if (track) param.track = track
      params[k] = param
    }
  }
  return {
    ...(extras(v, ['id', 'type', 'enabled', 'params']) as object),
    id: str(v.id, newId()),
    type: v.type,
    enabled: bool(v.enabled, true),
    params,
  }
}

const TEXT_STYLE_KEYS = Object.keys(defaultTextStyle())

export function decodeTextStyle(v: unknown): TextStyle | undefined {
  if (!isObj(v)) return undefined
  const d = defaultTextStyle()
  const fontName = str(v.fontName, d.fontName)
  const sh = isObj(v.shadow) ? v.shadow : undefined
  const shadowValid = sh && typeof sh.enabled === 'boolean' && isObj(sh.color) && isNum(sh.offsetX) && isNum(sh.offsetY) && isNum(sh.blur)
  const bg = isObj(v.background) ? v.background : {}
  const bd = isObj(v.border) ? v.border : {}
  const dbg = defaultBackground()
  const dbd = defaultOutline()
  return {
    ...(extras(v, TEXT_STYLE_KEYS) as object),
    fontName,
    fontSize: num(v.fontSize, d.fontSize),
    fontScale: num(v.fontScale, d.fontScale),
    widthScale: num(v.widthScale, d.widthScale),
    heightScale: num(v.heightScale, d.heightScale),
    tracking: num(v.tracking, d.tracking),
    lineSpacing: num(v.lineSpacing, d.lineSpacing),
    fontCase: oneOf(v.fontCase, ['mixed', 'uppercase', 'lowercase'] as const, 'mixed'),
    isBold: bool(v.isBold, inferBold(fontName)),
    isItalic: bool(v.isItalic, inferItalic(fontName)),
    isUnderlined: bool(v.isUnderlined, false),
    isStruckThrough: bool(v.isStruckThrough, false),
    isOverlined: bool(v.isOverlined, false),
    color: decodeRGBA(v.color, d.color),
    alignment: oneOf(v.alignment, ['left', 'center', 'right'] as const, 'center'),
    blur: num(v.blur, 0),
    shadow: shadowValid
      ? { enabled: sh.enabled as boolean, color: decodeRGBA(sh.color, defaultShadow().color), offsetX: sh.offsetX as number, offsetY: sh.offsetY as number, blur: sh.blur as number }
      : defaultShadow(),
    background: {
      enabled: bool(bg.enabled, dbg.enabled),
      color: decodeRGBA(bg.color, dbg.color),
      paddingX: num(bg.paddingX, 0),
      paddingY: num(bg.paddingY, 0),
      cornerRadius: num(bg.cornerRadius, 0),
      offsetX: num(bg.offsetX, 0),
      offsetY: num(bg.offsetY, 0),
      outlineColor: decodeRGBA(bg.outlineColor, dbg.outlineColor),
      outlineWidth: num(bg.outlineWidth, 0),
    },
    border: { enabled: bool(bd.enabled, dbd.enabled), color: decodeRGBA(bd.color, dbd.color), width: num(bd.width, dbd.width) },
  }
}

function decodeTextAnimation(v: unknown): TextAnimation | undefined {
  if (!isObj(v)) return undefined
  const out: TextAnimation = {
    preset: oneOf(v.preset, TEXT_ANIMATION_PRESETS, 'none'),
    perWordFrames: Math.max(1, int(v.perWordFrames, 6)),
  }
  if (isObj(v.highlight)) out.highlight = decodeRGBA(v.highlight, { r: 1, g: 0.85, b: 0, a: 1 })
  return out
}

function decodeWordTimings(v: unknown): WordTiming[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: WordTiming[] = []
  for (const w of v) {
    if (!isObj(w) || typeof w.text !== 'string' || !isInt(w.startFrame) || !isInt(w.endFrame)) return undefined
    out.push({ text: w.text, startFrame: w.startFrame as number, endFrame: w.endFrame as number })
  }
  return out
}

const CLIP_KEYS = [
  'id', 'mediaRef', 'mediaType', 'sourceClipType', 'startFrame', 'durationFrames', 'trimStartFrame', 'trimEndFrame',
  'speed', 'volume', 'fadeInFrames', 'fadeOutFrames', 'fadeInInterpolation', 'fadeOutInterpolation', 'opacity',
  'transform', 'crop', 'edgeRounding', 'edgeSoftness', 'linkGroupId', 'captionGroupId', 'multicamGroupId',
  'textContent', 'textStyle', 'textAnimation', 'wordTimings', 'textFillMode', 'opacityTrack', 'positionTrack',
  'scaleTrack', 'rotationTrack', 'cropTrack', 'volumeTrack', 'effects', 'blendMode',
] as const

/** Lenient per clip: a bad clip is dropped alone rather than emptying its track as the Mac does. */
export function decodeClip(v: unknown): Clip | undefined {
  if (!isObj(v) || typeof v.mediaRef !== 'string' || !isInt(v.startFrame) || !isInt(v.durationFrames)) return undefined
  const unit = (x: unknown) => (isNum(x) && x >= 0 && x <= 1 ? x : 0)
  const clip: Clip = {
    ...(extras(v, CLIP_KEYS) as object),
    id: str(v.id, newId()),
    mediaRef: v.mediaRef,
    mediaType: oneOf<ClipType>(v.mediaType, CLIP_TYPES, 'video'),
    sourceClipType: oneOf<ClipType>(v.sourceClipType, CLIP_TYPES, 'video'),
    startFrame: v.startFrame as number,
    durationFrames: v.durationFrames as number,
    trimStartFrame: int(v.trimStartFrame, 0),
    trimEndFrame: int(v.trimEndFrame, 0),
    speed: num(v.speed, 1),
    volume: num(v.volume, 1),
    fadeInFrames: int(v.fadeInFrames, 0),
    fadeOutFrames: int(v.fadeOutFrames, 0),
    fadeInInterpolation: oneOf(v.fadeInInterpolation, INTERPOLATIONS, 'linear'),
    fadeOutInterpolation: oneOf(v.fadeOutInterpolation, INTERPOLATIONS, 'linear'),
    opacity: num(v.opacity, 1),
    transform: decodeTransform(v.transform),
    crop: cropValue(v.crop) ?? defaultCrop(),
    edgeRounding: unit(v.edgeRounding),
    edgeSoftness: unit(v.edgeSoftness),
  }
  const assign = <K extends keyof Clip>(k: K, val: Clip[K] | undefined) => {
    if (val !== undefined) clip[k] = val
  }
  assign('linkGroupId', optStr(v.linkGroupId))
  assign('captionGroupId', optStr(v.captionGroupId))
  assign('multicamGroupId', optStr(v.multicamGroupId))
  assign('textContent', optStr(v.textContent))
  assign('textStyle', decodeTextStyle(v.textStyle))
  assign('textAnimation', decodeTextAnimation(v.textAnimation))
  assign('wordTimings', decodeWordTimings(v.wordTimings))
  if (v.textFillMode === 'footage' || v.textFillMode === 'inverted') clip.textFillMode = v.textFillMode
  assign('opacityTrack', decodeTrack(v.opacityTrack, numValue))
  assign('positionTrack', decodeTrack(v.positionTrack, pairValue))
  assign('scaleTrack', decodeTrack(v.scaleTrack, pairValue))
  assign('rotationTrack', decodeTrack(v.rotationTrack, numValue))
  assign('cropTrack', decodeTrack(v.cropTrack, cropValue))
  assign('volumeTrack', decodeTrack(v.volumeTrack, numValue))
  if (Array.isArray(v.effects)) {
    const effects = v.effects.map(decodeEffect).filter((e): e is Effect => !!e)
    if (effects.length) clip.effects = effects
  }
  if (typeof v.blendMode === 'string' && (BLEND_MODES as string[]).includes(v.blendMode)) clip.blendMode = v.blendMode as BlendMode
  return clip
}

export function normalizeTrackName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(raw)) return undefined
  const value = raw.trim()
  if ([...value].length > 80) return undefined
  return value || undefined
}

const TRACK_KEYS = ['id', 'type', 'name', 'muted', 'hidden', 'syncLocked', 'clips', 'displayHeight'] as const

function decodeTrackObj(v: unknown): Track {
  if (!isObj(v)) throw new DecodeError('track must be an object')
  if (typeof v.type !== 'string' || !(CLIP_TYPES as string[]).includes(v.type)) throw new DecodeError('track type is invalid')
  const clips = Array.isArray(v.clips) ? v.clips.map(decodeClip).filter((c): c is Clip => !!c) : []
  clips.sort((a, b) => a.startFrame - b.startFrame)
  const track: Track = {
    ...(extras(v, TRACK_KEYS) as object),
    id: str(v.id, newId()),
    type: v.type as ClipType,
    muted: bool(v.muted, false),
    hidden: bool(v.hidden, false),
    syncLocked: bool(v.syncLocked, true),
    clips,
    displayHeight: isNum(v.displayHeight) ? Math.min(Math.max(v.displayHeight, TRACK_HEIGHT.min), TRACK_HEIGHT.max) : TRACK_HEIGHT.default,
  }
  const name = normalizeTrackName(v.name)
  if (name) track.name = name
  return track
}

function decodeMarker(v: unknown): TimelineMarker | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.name !== 'string' || !isInt(v.startFrame) || !isInt(v.durationFrames)) return undefined
  if (!isObj(v.color) || typeof v.comment !== 'string') return undefined
  return {
    id: v.id,
    name: v.name,
    startFrame: v.startFrame as number,
    durationFrames: v.durationFrames as number,
    color: decodeRGBA(v.color, { r: 0, g: 0.478, b: 1, a: 1 }),
    comment: v.comment,
    status: oneOf(v.status, ['open', 'review', 'resolved'] as const, 'open'),
  }
}

const TIMELINE_KEYS = ['id', 'name', 'fps', 'width', 'height', 'settingsConfigured', 'folderId', 'tracks', 'markers'] as const

export function decodeTimeline(v: unknown): Timeline {
  if (!isObj(v)) throw new DecodeError('timeline must be an object')
  if (!Array.isArray(v.tracks)) throw new DecodeError('timeline.tracks is required')
  const t: Timeline = {
    ...(extras(v, TIMELINE_KEYS) as object),
    id: str(v.id, newId()),
    name: str(v.name, 'Timeline 1'),
    fps: reqInt(v.fps, 'timeline.fps'),
    width: reqInt(v.width, 'timeline.width'),
    height: reqInt(v.height, 'timeline.height'),
    settingsConfigured: bool(v.settingsConfigured, false),
    tracks: v.tracks.map(decodeTrackObj),
    markers: Array.isArray(v.markers) ? v.markers.map(decodeMarker).filter((m): m is TimelineMarker => !!m) : [],
  }
  const folderId = optStr(v.folderId)
  if (folderId) t.folderId = folderId
  return t
}

function decodeViewState(v: unknown): TimelineViewState | undefined {
  if (!isObj(v)) return undefined
  return { playheadFrame: int(v.playheadFrame, 0), zoomScale: num(v.zoomScale, DEFAULTS.pixelsPerFrame), scrollOffsetX: num(v.scrollOffsetX, 0) }
}

function decodeMulticam(v: unknown): MulticamSource | undefined {
  if (!isObj(v) || typeof v.id !== 'string' || !Array.isArray(v.members) || typeof v.masterMemberId !== 'string') return undefined
  return v as unknown as MulticamSource
}

function decodeSpeaker(v: unknown): SpeakerRegistryEntry | undefined {
  if (!isObj(v) || !isInt(v.id) || typeof v.name !== 'string' || !Array.isArray(v.color) || !Array.isArray(v.centroid)) return undefined
  return v as unknown as SpeakerRegistryEntry
}

const PROJECT_FILE_KEYS = ['timelines', 'activeTimelineId', 'openTimelineIds', 'viewStates', 'speakers', 'multicamGroups'] as const

export function decodeProjectFile(text: string): ProjectFile {
  const raw: unknown = JSON.parse(text)
  let firstError: unknown
  try {
    if (!isObj(raw) || !Array.isArray(raw.timelines)) throw new DecodeError('project.json has no timelines')
    const timelines = raw.timelines.map(decodeTimeline)
    if (timelines.length === 0) throw new DecodeError('project has no timelines')
    const file: ProjectFile = { ...(extras(raw, PROJECT_FILE_KEYS) as object), timelines }
    const ids = new Set(timelines.map((t) => t.id))
    const active = optStr(raw.activeTimelineId)
    file.activeTimelineId = active && ids.has(active) ? active : timelines[0].id
    const open = Array.isArray(raw.openTimelineIds) ? raw.openTimelineIds.filter((x): x is string => typeof x === 'string' && ids.has(x)) : []
    if (!open.includes(file.activeTimelineId)) open.push(file.activeTimelineId)
    file.openTimelineIds = [...new Set(open)]
    file.viewStates = {}
    if (isObj(raw.viewStates)) {
      for (const [k, vs] of Object.entries(raw.viewStates)) {
        const d = decodeViewState(vs)
        if (d && ids.has(k)) file.viewStates[k] = d
      }
    }
    if (Array.isArray(raw.speakers)) {
      const speakers = raw.speakers.map(decodeSpeaker).filter((s): s is SpeakerRegistryEntry => !!s)
      if (speakers.length) file.speakers = speakers
    }
    if (Array.isArray(raw.multicamGroups)) {
      const groups = raw.multicamGroups.map(decodeMulticam).filter((g): g is MulticamSource => !!g)
      if (groups.length) file.multicamGroups = groups
    }
    return file
  } catch (e) {
    firstError = e
  }
  try {
    const legacy = decodeTimeline(raw)
    return { timelines: [legacy], activeTimelineId: legacy.id, openTimelineIds: [legacy.id], viewStates: {} }
  } catch {
    throw firstError
  }
}

function decodeSource(v: unknown): MediaSource | undefined {
  if (!isObj(v)) return undefined
  if (isObj(v.external) && typeof v.external.absolutePath === 'string') return { external: { absolutePath: v.external.absolutePath } }
  if (isObj(v.project) && typeof v.project.relativePath === 'string') return { project: { relativePath: v.project.relativePath } }
  return undefined
}

const ENTRY_KEYS = [
  'id', 'name', 'type', 'source', 'duration', 'generationInput', 'sourceWidth', 'sourceHeight', 'sourceFPS', 'hasAudio',
  'folderId', 'cachedRemoteURL', 'cachedRemoteURLExpiresAt', 'generationStatus', 'importInput',
] as const

function decodeEntry(v: unknown): MediaManifestEntry {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.name !== 'string') throw new DecodeError('media entry missing id/name')
  if (typeof v.type !== 'string' || !(CLIP_TYPES as string[]).includes(v.type)) throw new DecodeError('media entry type invalid')
  const source = decodeSource(v.source)
  if (!source) throw new DecodeError('media entry source invalid')
  if (!isNum(v.duration)) throw new DecodeError('media entry duration invalid')
  const e: MediaManifestEntry = {
    ...(extras(v, ENTRY_KEYS) as object),
    id: v.id,
    name: v.name,
    type: v.type as ClipType,
    source,
    duration: v.duration,
    hasAudio: bool(v.hasAudio, false),
  }
  if (isObj(v.generationInput)) e.generationInput = v.generationInput as MediaManifestEntry['generationInput']
  const sw = optInt(v.sourceWidth)
  const sh = optInt(v.sourceHeight)
  const sf = optNum(v.sourceFPS)
  if (sw !== undefined) e.sourceWidth = sw
  if (sh !== undefined) e.sourceHeight = sh
  if (sf !== undefined) e.sourceFPS = sf
  const folderId = optStr(v.folderId)
  if (folderId) e.folderId = folderId
  if (typeof v.cachedRemoteURL === 'string' && isNum(v.cachedRemoteURLExpiresAt)) {
    e.cachedRemoteURL = v.cachedRemoteURL
    e.cachedRemoteURLExpiresAt = v.cachedRemoteURLExpiresAt
  }
  const status = optStr(v.generationStatus)
  if (status) e.generationStatus = status
  if (isObj(v.importInput)) e.importInput = v.importInput as MediaManifestEntry['importInput']
  return e
}

function decodeFolder(v: unknown): MediaFolder {
  if (!isObj(v) || typeof v.id !== 'string' || typeof v.name !== 'string') throw new DecodeError('folder invalid')
  const f: MediaFolder = { id: v.id, name: v.name }
  const parent = optStr(v.parentFolderId)
  if (parent) f.parentFolderId = parent
  return f
}

/** Throws when the manifest is unreadable so the caller can preserve the original bytes. */
export function decodeManifest(text: string): MediaManifest {
  const raw: unknown = JSON.parse(text)
  if (!isObj(raw)) throw new DecodeError('media.json must be an object')
  return {
    ...(extras(raw, ['version', 'entries', 'folders']) as object),
    version: int(raw.version, 1),
    entries: Array.isArray(raw.entries) ? raw.entries.map(decodeEntry) : [],
    folders: Array.isArray(raw.folders) ? raw.folders.map(decodeFolder) : [],
  }
}

// ---------- Encoding (canonical Mac form) ----------

/** Rejects values the Mac decoder cannot read back: non-finite numbers and non-integer Int fields. */
export class EncodeError extends Error {}

const INT_KEYS = new Set([
  'fps', 'width', 'height', 'startFrame', 'durationFrames', 'trimStartFrame', 'trimEndFrame', 'fadeInFrames', 'fadeOutFrames',
  'frame', 'endFrame', 'playheadFrame', 'perWordFrames', 'sourceWidth', 'sourceHeight', 'version', 'numImages', 'outputIndex',
  'costCredits', 'refundedCredits', 'upscaleSourceWidth', 'upscaleSourceHeight',
])
const INT_CONTEXT_EXCLUDE = new Set(['transform', 'border'])

function sanitize(value: unknown, key: string, parentKey: string, path: string): unknown {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new EncodeError(`non-finite number at ${path}`)
    if (INT_KEYS.has(key) && !INT_CONTEXT_EXCLUDE.has(parentKey) && !Number.isInteger(value)) {
      return Math.round(value)
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (Array.isArray(value)) return value.map((v, i) => sanitize(v, key, parentKey, `${path}[${i}]`)).filter((v) => v !== undefined)
  if (typeof value === 'object') {
    const out: Json = {}
    for (const [k, v] of Object.entries(value as Json)) {
      const s = sanitize(v, k, key, `${path}.${k}`)
      if (s !== undefined) out[k] = s
    }
    return out
  }
  return value
}

export function encodeProjectFile(file: ProjectFile): string {
  const ids = new Set(file.timelines.map((t) => t.id))
  const viewStates: Record<string, TimelineViewState> = {}
  for (const [k, v] of Object.entries(file.viewStates ?? {})) if (ids.has(k)) viewStates[k] = v
  const referencedGroups = new Set<string>()
  for (const t of file.timelines) for (const tr of t.tracks) for (const c of tr.clips) if (c.multicamGroupId) referencedGroups.add(c.multicamGroupId)
  const groups = (file.multicamGroups ?? []).filter((g) => referencedGroups.has(g.id))
  const out: ProjectFile = {
    ...file,
    timelines: file.timelines.map(canonicalTimeline),
    activeTimelineId: file.activeTimelineId && ids.has(file.activeTimelineId) ? file.activeTimelineId : file.timelines[0]?.id,
    openTimelineIds: (file.openTimelineIds ?? []).filter((i) => ids.has(i)),
    viewStates,
  }
  if (file.speakers?.length) out.speakers = file.speakers
  else delete out.speakers
  if (groups.length) out.multicamGroups = groups
  else delete out.multicamGroups
  return JSON.stringify(sanitize(out, '', '', 'project'))
}

function canonicalTimeline(t: Timeline): Timeline {
  return {
    ...t,
    tracks: t.tracks.map((tr) => ({
      ...tr,
      clips: [...tr.clips].sort((a, b) => a.startFrame - b.startFrame).map(canonicalClip),
    })),
    markers: [...t.markers].sort((a, b) => a.startFrame - b.startFrame || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

function canonicalClip(c: Clip): Clip {
  const out = { ...c }
  if (out.effects && out.effects.length === 0) delete out.effects
  if (out.textFillMode === 'color') delete out.textFillMode
  for (const k of ['opacityTrack', 'positionTrack', 'scaleTrack', 'rotationTrack', 'cropTrack', 'volumeTrack'] as const) {
    const tr = out[k] as KeyframeTrack<unknown> | undefined
    if (tr && tr.keyframes.length === 0) delete out[k]
  }
  if (out.mediaRef === undefined) out.mediaRef = ''
  return out
}

export function encodeManifest(m: MediaManifest): string {
  return JSON.stringify(sanitize({ ...m, entries: m.entries.map((e) => ({ ...e, hasAudio: e.hasAudio ?? false })) }, '', '', 'manifest'))
}
