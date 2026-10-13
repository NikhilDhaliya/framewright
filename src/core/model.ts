import type { AnimPair, Interpolation, KeyframeTrack } from './keyframes'

export type Id = string

export type ClipType = 'video' | 'audio' | 'image' | 'text' | 'lottie' | 'sequence' | 'subtitle'
export const CLIP_TYPES: ClipType[] = ['video', 'audio', 'image', 'text', 'lottie', 'sequence', 'subtitle']

export const isVisualType = (t: ClipType): boolean => t !== 'audio' && t !== 'subtitle'
export const isCompatibleType = (a: ClipType, b: ClipType): boolean => a === b || (isVisualType(a) && isVisualType(b))

export function clipTypeForExtension(ext: string): ClipType | null {
  switch (ext.toLowerCase()) {
    case 'mov':
    case 'mp4':
    case 'm4v':
    case 'mkv':
    case 'webm':
    case 'avi':
      return 'video'
    case 'mp3':
    case 'wav':
    case 'aac':
    case 'm4a':
    case 'aiff':
    case 'aif':
    case 'aifc':
    case 'caf':
    case 'flac':
    case 'ogg':
    case 'opus':
      return 'audio'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'tiff':
    case 'heic':
    case 'webp':
    case 'gif':
    case 'bmp':
      return 'image'
    case 'json':
    case 'lottie':
      return 'lottie'
    case 'srt':
    case 'vtt':
      return 'subtitle'
    default:
      return null
  }
}

export interface Transform {
  centerX: number
  centerY: number
  width: number
  height: number
  rotation: number
  rotationX: number
  rotationY: number
  flipHorizontal: boolean
  flipVertical: boolean
}

export const defaultTransform = (): Transform => ({
  centerX: 0.5,
  centerY: 0.5,
  width: 1,
  height: 1,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  flipHorizontal: false,
  flipVertical: false,
})

export interface Crop {
  left: number
  top: number
  right: number
  bottom: number
}

export const defaultCrop = (): Crop => ({ left: 0, top: 0, right: 0, bottom: 0 })
export const CROP_MIN_VISIBLE = 0.05
export const isIdentityCrop = (c: Crop): boolean => c.left === 0 && c.top === 0 && c.right === 0 && c.bottom === 0

export interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

export interface EffectParam {
  value?: number
  string?: string
  track?: KeyframeTrack<number>
}

export interface Effect {
  id: Id
  type: string
  enabled: boolean
  params: Record<string, EffectParam>
}

export type BlendMode =
  | 'normal'
  | 'darken'
  | 'multiply'
  | 'colorBurn'
  | 'lighten'
  | 'screen'
  | 'colorDodge'
  | 'overlay'
  | 'softLight'
  | 'hardLight'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

export const BLEND_MODES: BlendMode[] = [
  'normal',
  'darken',
  'multiply',
  'colorBurn',
  'lighten',
  'screen',
  'colorDodge',
  'overlay',
  'softLight',
  'hardLight',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
]

export interface TextShadow {
  enabled: boolean
  color: RGBA
  offsetX: number
  offsetY: number
  blur: number
}

export interface TextOutline {
  enabled: boolean
  color: RGBA
  width: number
}

export interface TextBackground {
  enabled: boolean
  color: RGBA
  paddingX: number
  paddingY: number
  cornerRadius: number
  offsetX: number
  offsetY: number
  outlineColor: RGBA
  outlineWidth: number
}

export type FontCase = 'mixed' | 'uppercase' | 'lowercase'
export type TextAlignment = 'left' | 'center' | 'right'

export interface TextStyle {
  fontName: string
  fontSize: number
  fontScale: number
  widthScale: number
  heightScale: number
  tracking: number
  lineSpacing: number
  fontCase: FontCase
  isBold: boolean
  isItalic: boolean
  isUnderlined: boolean
  isStruckThrough: boolean
  isOverlined: boolean
  color: RGBA
  alignment: TextAlignment
  blur: number
  shadow: TextShadow
  background: TextBackground
  border: TextOutline
}

export const defaultShadow = (): TextShadow => ({ enabled: false, color: { r: 0, g: 0, b: 0, a: 0.6 }, offsetX: 0, offsetY: -2, blur: 6 })
export const defaultOutline = (): TextOutline => ({ enabled: false, color: { r: 0, g: 0, b: 0, a: 1 }, width: 4 })
export const defaultBackground = (): TextBackground => ({
  enabled: false,
  color: { r: 0, g: 0, b: 0, a: 0.6 },
  paddingX: 0,
  paddingY: 0,
  cornerRadius: 0,
  offsetX: 0,
  offsetY: 0,
  outlineColor: { r: 0, g: 0, b: 0, a: 1 },
  outlineWidth: 0,
})

export function inferBold(fontName: string): boolean {
  return /(bold|black|heavy|semibold|demibold|extrabold|ultrabold)/i.test(fontName)
}
export function inferItalic(fontName: string): boolean {
  return /(italic|oblique)/i.test(fontName)
}

export const defaultTextStyle = (): TextStyle => ({
  fontName: 'Helvetica',
  fontSize: 96,
  fontScale: 1,
  widthScale: 1,
  heightScale: 1,
  tracking: 0,
  lineSpacing: 0,
  fontCase: 'mixed',
  isBold: false,
  isItalic: false,
  isUnderlined: false,
  isStruckThrough: false,
  isOverlined: false,
  color: { r: 1, g: 1, b: 1, a: 1 },
  alignment: 'center',
  blur: 0,
  shadow: defaultShadow(),
  background: defaultBackground(),
  border: defaultOutline(),
})

export type TextAnimationPreset = 'none' | 'popIn' | 'slideUp' | 'typewriter' | 'wordReveal' | 'wordSlide' | 'highlightPop' | 'highlightBlock'
export const TEXT_ANIMATION_PRESETS: TextAnimationPreset[] = [
  'none',
  'popIn',
  'slideUp',
  'typewriter',
  'wordReveal',
  'wordSlide',
  'highlightPop',
  'highlightBlock',
]

export interface TextAnimation {
  preset: TextAnimationPreset
  perWordFrames: number
  highlight?: RGBA
}

export interface WordTiming {
  text: string
  startFrame: number
  endFrame: number
}

export type TextFillMode = 'color' | 'footage' | 'inverted'

export interface Clip {
  id: Id
  mediaRef: string
  mediaType: ClipType
  sourceClipType: ClipType
  startFrame: number
  durationFrames: number
  trimStartFrame: number
  trimEndFrame: number
  speed: number
  volume: number
  fadeInFrames: number
  fadeOutFrames: number
  fadeInInterpolation: Interpolation
  fadeOutInterpolation: Interpolation
  opacity: number
  transform: Transform
  crop: Crop
  edgeRounding: number
  edgeSoftness: number
  linkGroupId?: Id
  captionGroupId?: Id
  multicamGroupId?: Id
  textContent?: string
  textStyle?: TextStyle
  textAnimation?: TextAnimation
  wordTimings?: WordTiming[]
  textFillMode?: TextFillMode
  opacityTrack?: KeyframeTrack<number>
  positionTrack?: KeyframeTrack<AnimPair>
  scaleTrack?: KeyframeTrack<AnimPair>
  rotationTrack?: KeyframeTrack<number>
  cropTrack?: KeyframeTrack<Crop>
  volumeTrack?: KeyframeTrack<number>
  effects?: Effect[]
  blendMode?: BlendMode
}

export interface Track {
  id: Id
  type: ClipType
  name?: string
  muted: boolean
  hidden: boolean
  syncLocked: boolean
  clips: Clip[]
  displayHeight: number
}

export type MarkerStatus = 'open' | 'review' | 'resolved'

export interface TimelineMarker {
  id: Id
  name: string
  startFrame: number
  durationFrames: number
  color: RGBA
  comment: string
  status: MarkerStatus
}

export const DEFAULT_MARKER_COLOR: RGBA = { r: 0, g: 0.478, b: 1, a: 1 }

export interface Timeline {
  id: Id
  name: string
  fps: number
  width: number
  height: number
  settingsConfigured: boolean
  folderId?: Id
  tracks: Track[]
  markers: TimelineMarker[]
}

export interface TimelineViewState {
  playheadFrame: number
  zoomScale: number
  scrollOffsetX: number
}

export interface SyncMap {
  offsetSeconds: number
  confidence: number
  locked: boolean
}

export interface MulticamMember {
  id: Id
  mediaRef: Id
  kind: 'angle' | 'mic' | 'both'
  angleLabel: string
  sync: SyncMap
}

export interface MulticamSource {
  id: Id
  name: string
  members: MulticamMember[]
  masterMemberId: Id
}

export interface SpeakerRegistryEntry {
  id: number
  name: string
  color: number[]
  centroid: number[]
}

export interface ProjectFile {
  timelines: Timeline[]
  activeTimelineId?: Id
  openTimelineIds?: Id[]
  viewStates?: Record<Id, TimelineViewState>
  speakers?: SpeakerRegistryEntry[]
  multicamGroups?: MulticamSource[]
}

export type MediaSource = { external: { absolutePath: string } } | { project: { relativePath: string } }

export interface MediaFolder {
  id: Id
  name: string
  parentFolderId?: Id
}

/** Opaque passthrough of the Mac's generation metadata; only read for display. */
export type GenerationInput = Record<string, unknown> & { prompt: string; model: string; duration: number; aspectRatio: string }

export interface MediaImportInput {
  sourceURL?: string
  sourcePath?: string
  createdAt?: number
}

export interface MediaManifestEntry {
  id: Id
  name: string
  type: ClipType
  source: MediaSource
  duration: number
  generationInput?: GenerationInput
  sourceWidth?: number
  sourceHeight?: number
  sourceFPS?: number
  hasAudio?: boolean
  folderId?: Id
  cachedRemoteURL?: string
  cachedRemoteURLExpiresAt?: number
  generationStatus?: string
  importInput?: MediaImportInput
}

export interface MediaManifest {
  version: number
  entries: MediaManifestEntry[]
  folders: MediaFolder[]
}

/** Whole open document: persisted files plus the package location they resolve against. */
export interface ProjectDocument {
  file: ProjectFile
  manifest: MediaManifest
}

export const TRACK_HEIGHT = { default: 44, min: 32, max: 200 } as const
export const DEFAULTS = {
  pixelsPerFrame: 4,
  imageDurationSeconds: 5,
  textDurationSeconds: 3,
  aspectTolerance: 0.02,
} as const

export const PROJECT = {
  fileExtension: 'palmier',
  timelineFilename: 'project.json',
  manifestFilename: 'media.json',
  thumbnailFilename: 'thumbnail.jpg',
  mediaDirectoryName: 'media',
  chatDirectoryName: 'chat',
  registryFilename: 'project-registry.json',
  defaultProjectName: 'Untitled Project',
} as const

export function newId(): Id {
  return crypto.randomUUID().toUpperCase()
}

export function newTimeline(partial: Partial<Timeline> = {}): Timeline {
  return {
    id: newId(),
    name: 'Timeline 1',
    fps: 30,
    width: 1920,
    height: 1080,
    settingsConfigured: false,
    tracks: [],
    markers: [],
    ...partial,
  }
}

export function newTrack(type: ClipType, partial: Partial<Track> = {}): Track {
  return {
    id: newId(),
    type,
    muted: false,
    hidden: false,
    syncLocked: true,
    clips: [],
    displayHeight: TRACK_HEIGHT.default,
    ...partial,
  }
}

export function newClip(partial: Partial<Clip> & Pick<Clip, 'mediaRef' | 'startFrame' | 'durationFrames'>): Clip {
  return {
    id: newId(),
    mediaType: 'video',
    sourceClipType: 'video',
    trimStartFrame: 0,
    trimEndFrame: 0,
    speed: 1,
    volume: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    fadeInInterpolation: 'linear',
    fadeOutInterpolation: 'linear',
    opacity: 1,
    transform: defaultTransform(),
    crop: defaultCrop(),
    edgeRounding: 0,
    edgeSoftness: 0,
    ...partial,
  }
}

export function newProjectFile(): ProjectFile {
  const t = newTimeline()
  return {
    timelines: [t],
    activeTimelineId: t.id,
    openTimelineIds: [t.id],
    viewStates: { [t.id]: { playheadFrame: 0, zoomScale: DEFAULTS.pixelsPerFrame, scrollOffsetX: 0 } },
  }
}

export function emptyManifest(): MediaManifest {
  return { version: 2, entries: [], folders: [] }
}

export function fitTransform(srcW: number, srcH: number, canvasW: number, canvasH: number): Transform {
  if (!(srcW > 0 && srcH > 0 && canvasW > 0 && canvasH > 0)) return defaultTransform()
  const canvasAspect = canvasW / canvasH
  const relative = srcW / srcH / canvasAspect
  if (Math.abs(canvasAspect - relative * canvasAspect) < DEFAULTS.aspectTolerance) return defaultTransform()
  return relative > 1 ? { ...defaultTransform(), width: 1, height: 1 / relative } : { ...defaultTransform(), width: relative, height: 1 }
}
