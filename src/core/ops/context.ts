import type { MediaManifest, MediaManifestEntry, ProjectFile, Timeline } from '../model'
import { EditRefusal, totalFrames } from '../timeline'
import { secondsToFrame } from '../time'

/** The whole persisted document. Ops mutate an immer draft of it. */
export interface Doc {
  file: ProjectFile
  manifest: MediaManifest
}

export function activeTimeline(doc: Doc): Timeline {
  const id = doc.file.activeTimelineId
  const t = doc.file.timelines.find((x) => x.id === id) ?? doc.file.timelines[0]
  if (!t) throw new EditRefusal('The project has no timelines.')
  return t
}

export function timelineById(doc: Doc, id: string): Timeline | undefined {
  return doc.file.timelines.find((t) => t.id === id)
}

/** A placeable source: a library asset or a nested timeline treated as media. */
export interface PlaceableAsset {
  id: string
  type: MediaManifestEntry['type']
  duration: number
  hasAudio: boolean
  sourceWidth?: number
  sourceHeight?: number
  sourceFPS?: number
  name: string
}

export function placeableAsset(doc: Doc, id: string): PlaceableAsset | null {
  const e = doc.manifest.entries.find((x) => x.id === id)
  if (e) {
    return {
      id: e.id,
      type: e.type,
      duration: e.duration,
      hasAudio: e.hasAudio ?? false,
      sourceWidth: e.sourceWidth,
      sourceHeight: e.sourceHeight,
      sourceFPS: e.sourceFPS,
      name: e.name,
    }
  }
  const t = timelineById(doc, id)
  if (t) {
    return {
      id: t.id,
      type: 'sequence',
      duration: totalFrames(t) / t.fps,
      hasAudio: t.tracks.some((tr) => tr.type === 'audio' && tr.clips.length > 0),
      sourceWidth: t.width,
      sourceHeight: t.height,
      sourceFPS: t.fps,
      name: t.name,
    }
  }
  return null
}

export function assetFrames(asset: PlaceableAsset, fps: number): number {
  return secondsToFrame(asset.duration, fps)
}

export interface Segment {
  lower: number
  upper: number
}

export function clipDurationFrames(asset: PlaceableAsset, fps: number, segment?: Segment): number {
  return Math.max(1, secondsToFrame(segment ? segment.upper - segment.lower : asset.duration, fps))
}

export function multicamGroupName(doc: Doc, id: string): string {
  return doc.file.multicamGroups?.find((g) => g.id === id)?.name ?? 'Multicam'
}
