/** Fixture helpers mirroring the Mac test suite's `Fixtures` (Tests/PalmierProTests). */
import { newClip, newTimeline, newTrack, type Clip, type ClipType, type MediaManifestEntry, type Timeline, type Track } from '../../src/core/model'
import type { TranscriptionResult } from '../../src/core/captions/transcript'

export function clip(o: { id?: string; mediaRef?: string; mediaType?: ClipType; start?: number; duration?: number; trimStart?: number; speed?: number } = {}): Clip {
  const c = newClip({ mediaRef: o.mediaRef ?? 'm', startFrame: o.start ?? 0, durationFrames: o.duration ?? 100, mediaType: o.mediaType ?? 'video', sourceClipType: o.mediaType ?? 'video' })
  if (o.id) c.id = o.id
  if (o.trimStart !== undefined) c.trimStartFrame = o.trimStart
  if (o.speed !== undefined) c.speed = o.speed
  return c
}

export const videoTrack = (o: { id?: string; clips?: Clip[] } = {}): Track => newTrack('video', { ...(o.id ? { id: o.id } : {}), clips: o.clips ?? [] })
export const audioTrack = (o: { id?: string; clips?: Clip[] } = {}): Track => newTrack('audio', { ...(o.id ? { id: o.id } : {}), clips: o.clips ?? [] })
export const timeline = (tracks: Track[], partial: Partial<Timeline> = {}): Timeline => newTimeline({ tracks, ...partial })

export function asset(id: string, o: Partial<MediaManifestEntry> = {}): MediaManifestEntry {
  return { id, name: id, type: 'video', source: { external: { absolutePath: `/nonexistent/${id}.mp4` } }, duration: 10, hasAudio: true, ...o }
}

export function result(words: [string, number, number][], segments: [string, number, number][] = [], language = 'en'): TranscriptionResult {
  return {
    text: segments.length ? segments.map((s) => s[0]).join(' ') : words.map((w) => w[0]).join(' '),
    language,
    words: words.map(([text, start, end]) => ({ text, start, end })),
    segments: segments.map(([text, start, end]) => ({ text, start, end })),
  }
}
