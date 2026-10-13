// Fixture builders mirroring the Mac test target's `Fixtures` + `MediaResolver` setup.
import { exportFCPXML, exportXMEML, type FCPXMLOptions, type SourceTimecode } from '../../src/core/interchange'
import type { AnimPair, Interpolation, Keyframe, KeyframeTrack } from '../../src/core/keyframes'
import {
  defaultTransform,
  newClip,
  newTimeline,
  newTrack,
  type Clip,
  type ClipType,
  type MediaManifestEntry,
  type Timeline,
  type Track,
  type Transform,
} from '../../src/core/model'
import { totalFrames } from '../../src/core/timeline'

export const TMP = '/tmp/palmier-interchange-tests'

export function clip(o: {
  id?: string
  mediaRef?: string
  mediaType?: ClipType
  start: number
  duration: number
  trimStart?: number
  trimEnd?: number
  speed?: number
  volume?: number
}): Clip {
  const mediaType = o.mediaType ?? 'video'
  return newClip({
    ...(o.id ? { id: o.id } : {}),
    mediaRef: o.mediaRef ?? 'media-1',
    mediaType,
    sourceClipType: mediaType,
    startFrame: o.start,
    durationFrames: o.duration,
    trimStartFrame: o.trimStart ?? 0,
    trimEndFrame: o.trimEnd ?? 0,
    speed: o.speed ?? 1,
    volume: o.volume ?? 1,
  })
}

export const videoTrack = (clips: Clip[] = []): Track => newTrack('video', { clips })
export const audioTrack = (clips: Clip[] = []): Track => newTrack('audio', { clips })
export const timeline = (o: { fps?: number; tracks?: Track[]; name?: string; width?: number; height?: number } = {}): Timeline =>
  newTimeline({ fps: o.fps ?? 30, tracks: o.tracks ?? [], ...(o.name ? { name: o.name } : {}), ...(o.width ? { width: o.width } : {}), ...(o.height ? { height: o.height } : {}) })

export const tf = (p: Partial<Transform> = {}): Transform => ({ ...defaultTransform(), ...p })
export const kf = <V>(frame: number, value: V, interpolationOut: Interpolation = 'smooth'): Keyframe<V> => ({ frame, value, interpolationOut })
export const track = <V>(...keyframes: Keyframe<V>[]): KeyframeTrack<V> => ({ keyframes })
export const pair = (a: number, b: number): AnimPair => ({ a, b })

export function entry(o: Partial<MediaManifestEntry> & { id: string; type: ClipType; path: string }): MediaManifestEntry {
  const { path, ...rest } = o
  return { name: o.id, duration: 1, ...rest, source: { external: { absolutePath: path } } }
}

/** Mac `videoManifestEntry(id:in:)` / `audioManifestEntry(id:in:)`: 1 s, no dimensions. */
export const videoManifestEntry = (id: string, dir = TMP) => entry({ id, type: 'video', path: `${dir}/${id}.mp4`, duration: 1 })
export const audioManifestEntry = (id: string, dir = TMP) => entry({ id, type: 'audio', path: `${dir}/${id}.m4a`, duration: 1 })

/** Carrier clip for a nested timeline (Mac `carrier(for:start:duration:trimStart:)`). */
export function carrier(child: Timeline, start: number, o: { duration?: number; trimStart?: number } = {}): Clip {
  return newClip({ mediaRef: child.id, mediaType: 'sequence', sourceClipType: 'sequence', startFrame: start, durationFrames: o.duration ?? totalFrames(child), trimStartFrame: o.trimStart ?? 0 })
}

export interface Fixture {
  entries?: MediaManifestEntry[]
  timelines?: Timeline[]
  timecodes?: Record<string, SourceTimecode>
  /** Entries whose file is absent (MediaResolver.resolveURL → nil). */
  missing?: string[]
}

/** Every external entry resolves (the Mac tests create an empty file at each path). */
export function mediaPaths(fx: Fixture): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of fx.entries ?? []) if ('external' in e.source && !fx.missing?.includes(e.id)) out[e.id] = e.source.external.absolutePath
  return out
}

export const xmeml = (t: Timeline, fx: Fixture = {}): string =>
  exportXMEML({ timeline: t, timelines: fx.timelines, manifest: { entries: fx.entries ?? [] }, mediaPaths: mediaPaths(fx), timecodes: fx.timecodes })

export const fcpxml = (t: Timeline, fx: Fixture = {}, options: FCPXMLOptions = {}): string =>
  exportFCPXML({ timeline: t, timelines: fx.timelines, manifest: { entries: fx.entries ?? [] }, mediaPaths: mediaPaths(fx), timecodes: fx.timecodes }, options)

/** `s.components(separatedBy: sep).count - 1`. */
export const count = (s: string, sep: string): number => s.split(sep).length - 1

/** Swift `components(separatedBy:).dropFirst().first?.components(separatedBy: end).first ?? ""`. */
export function between(s: string, start: string, end: string): string {
  const parts = s.split(start)
  if (parts.length < 2) return ''
  return parts[1].split(end)[0]
}
