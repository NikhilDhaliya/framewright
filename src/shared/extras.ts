/**
 * Media-producing extras (spec 07 §6.3–6.5): menu conditions, matte geometry/naming and the renderer↔main API.
 * Pure — shared by the main process (authoritative checks) and the renderer (menu visibility, Matte sheet).
 */
import type { Clip, MediaManifestEntry, Timeline } from '../core/model'
import { isInFlight } from '../core/generation/status'

// ---------- Save as Media / Save as Audio / Extract Audio (§6.3) ----------

export type IsOffline = (assetId: string) => boolean
const never: IsOffline = () => false

const isGenerating = (e: MediaManifestEntry | undefined): boolean => !!e && isInFlight(e.generationStatus)

function clipFor(t: Timeline, id: string): Clip | undefined {
  for (const tr of t.tracks) {
    const c = tr.clips.find((x) => x.id === id)
    if (c) return c
  }
  return undefined
}

/** `EditorViewModel.canExtractAudio(from:)`: a video with audio that is neither generating nor offline. */
export function canExtractAudio(asset: MediaManifestEntry, offline: IsOffline = never): boolean {
  return asset.type === 'video' && !!asset.hasAudio && !isGenerating(asset) && !offline(asset.id)
}

/** "Save as Media" is offered for video and audio clips (multicam allowed). */
export const canSaveClipAsMedia = (clip: Clip): boolean => clip.mediaType === 'video' || clip.mediaType === 'audio'

/**
 * `audioClipForExtraction(clipId:)`: not nested, not multicam; for a video clip its linked audio partner when it has
 * one (online and not generating), else the video itself when its asset has audio; an audio clip linked to a video.
 */
export function audioClipForExtraction(t: Timeline, entries: MediaManifestEntry[], clipId: string, offline: IsOffline = never): Clip | null {
  const clip = clipFor(t, clipId)
  if (!clip || clip.sourceClipType === 'sequence' || clip.multicamGroupId) return null
  const assetOf = (c: Clip) => entries.find((e) => e.id === c.mediaRef)
  const extractable = (c: Clip) => !offline(c.mediaRef) && !isGenerating(assetOf(c))
  const partners = clip.linkGroupId ? t.tracks.flatMap((tr) => tr.clips).filter((c) => c.id !== clip.id && c.linkGroupId === clip.linkGroupId) : []
  if (clip.mediaType === 'video') {
    const audio = partners.find((c) => c.mediaType === 'audio')
    if (audio) return extractable(audio) ? audio : null
    const asset = assetOf(clip)
    if (!asset || !canExtractAudio(asset, offline)) return null
    return extractable(clip) ? clip : null
  }
  if (clip.mediaType === 'audio' && partners.some((c) => c.mediaType === 'video')) return extractable(clip) ? clip : null
  return null
}

// ---------- Solid mattes (§6.5, `Models/Matte.swift`) ----------

export const MATTE_ASPECTS = ['Project', '16:9', '9:16', '1:1', '4:3', '9:14', '2.4:1'] as const
export type MatteAspect = (typeof MATTE_ASPECTS)[number]

const MATTE_RATIOS: Record<MatteAspect, [number, number] | null> = {
  Project: null,
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
  '4:3': [4, 3],
  '9:14': [9, 14],
  '2.4:1': [24, 10],
}

/** `Matte.even`: integer halves (Swift `Int` division truncates), at least 2 px per edge. */
export function matteEven(w: number, h: number): [number, number] {
  return [Math.max(2, Math.trunc(Math.max(2, w) / 2) * 2), Math.max(2, Math.trunc(Math.max(2, h) / 2) * 2)]
}

/** Swift `Double.rounded()` (half away from zero). */
const swiftRound = (v: number) => Math.sign(v) * Math.round(Math.abs(v))

/** `Matte.fit(short:aspectW:aspectH:)`. */
export function matteFit(shortEdge: number, aw: number, ah: number): [number, number] {
  const e = Math.max(2, Math.trunc(shortEdge))
  return aw >= ah ? matteEven(swiftRound((e * aw) / ah), e) : matteEven(e, swiftRound((e * ah) / aw))
}

/** `MatteAspect.pixelSize(timelineWidth:timelineHeight:)`. */
export function mattePixelSize(aspect: MatteAspect, timelineWidth: number, timelineHeight: number): [number, number] {
  const ratio = MATTE_RATIOS[aspect]
  return ratio ? matteFit(Math.min(timelineWidth, timelineHeight), ratio[0], ratio[1]) : matteEven(timelineWidth, timelineHeight)
}

/** `MatteAspect.parse`: trimmed; "project" in any case; otherwise an exact raw value. */
export function parseMatteAspect(raw: string | undefined | null): MatteAspect | null {
  const s = raw?.trim()
  if (!s) return null
  if (s.toLowerCase() === 'project') return 'Project'
  return (MATTE_ASPECTS as readonly string[]).includes(s) ? (s as MatteAspect) : null
}

/** Default asset name: `Matte · W×H` for Project, else `Matte · <aspect>`. */
export const matteName = (aspect: MatteAspect, width: number, height: number): string => (aspect === 'Project' ? `Matte · ${width}×${height}` : `Matte · ${aspect}`)

/** `Color.matteHex`: sRGB components ×255 **truncated**, `#RRGGBB` upper case. */
export function matteHex(c: { r: number; g: number; b: number }): string {
  const byte = (v: number) => Math.trunc(Math.min(1, Math.max(0, v)) * 255)
  return `#${[c.r, c.g, c.b].map((v) => byte(v).toString(16).toUpperCase().padStart(2, '0')).join('')}`
}

export const MATTE_ERRORS = {
  renderFailed: "Couldn't render matte image.",
  noProject: 'Open a project before creating a matte.',
} as const

// ---------- Capture frame (§6.4) ----------

export type FrameCaptureSource = { kind: 'timeline'; frame: number } | { kind: 'media'; mediaRef: string; sourceSeconds: number }

/** Toast text after a successful UI capture (`captureCurrentFrameToMedia`). */
export function captureToast(name: string, folderRemoved: boolean): { message: string; kind: 'success' | 'warning' } {
  return folderRemoved
    ? { message: `Captured ${name}. The destination folder was removed, so the frame was saved at the top level of Media.`, kind: 'warning' }
    : { message: `Captured ${name}.`, kind: 'success' }
}

// ---------- IPC (`extras:*`) ----------

export type ExtrasResult<T = object> = ({ ok: true } & T) | { ok: false; error: string }

export interface ExtrasApi {
  /** Clip context menu ▸ Save as Media (video/audio clip; trim + speed baked in). */
  saveClipAsMedia(clipId: string): Promise<ExtrasResult>
  /** Clip context menu ▸ Save as Audio. */
  saveClipAsAudio(clipId: string): Promise<ExtrasResult>
  /** Media tab ▸ Extract Audio (each eligible asset, one after another). */
  extractAudio(assetIds: string[]): Promise<ExtrasResult>
  /** Timeline range ▸ Save Range as Media: `[start, end)` frames of the active timeline. */
  saveRangeAsMedia(range: { start: number; end: number }): Promise<ExtrasResult>
  /** Preview transport camera button. */
  captureFrame(source: FrameCaptureSource, folderId: string | null): Promise<ExtrasResult<{ name: string; folderRemoved: boolean }>>
  /** Matte sheet ▸ Create Matte. */
  createMatte(req: { hex: string; aspect: MatteAspect; folderId: string | null }): Promise<ExtrasResult<{ id: string }>>
  /** Index ▸ Markers thumbnail: JPEG of one composited timeline frame at `width` px (null on failure). */
  timelineThumbnail(timelineId: string, frame: number, width: number): Promise<Uint8Array | null>
}
