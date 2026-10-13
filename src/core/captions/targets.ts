/** Caption/transcription source clips (`EditorViewModel+Captions.swift:117-191, 533-540`). Pure. */
import type { Clip, MediaManifestEntry, MulticamSource, Timeline } from '../model'
import { linkedPartnerIds } from '../timeline'
import { spokenWordCount } from './transcriptMapper'
import type { TranscriptionResult } from './transcript'

export interface TargetContext {
  timeline: Timeline
  assets: MediaManifestEntry[]
  multicamGroups: MulticamSource[]
}

export interface CaptionTarget {
  clip: Clip
  trackId: string
  trackIndex: number
}

export function captionCanTranscribe(ctx: TargetContext, clip: Clip): boolean {
  if (clip.mediaType !== 'video' && clip.mediaType !== 'audio') return false
  const asset = ctx.assets.find((a) => a.id === clip.mediaRef)
  if (!asset) return true
  return asset.type === 'audio' || (asset.type === 'video' && asset.hasAudio === true)
}

/** Audio for the clip is extracted from a video container (asset video, or unknown asset on a video clip). */
export function captionUsesVideoAudio(ctx: TargetContext, clip: Clip): boolean {
  const type = ctx.assets.find((a) => a.id === clip.mediaRef)?.type
  return type === 'video' || (type === undefined && clip.mediaType === 'video')
}

const allClips = (t: Timeline) => t.tracks.flatMap((tr) => tr.clips)
const linkGroupsWithAudio = (clips: Clip[]) => new Set(clips.filter((c) => c.mediaType === 'audio' && c.linkGroupId).map((c) => c.linkGroupId!))

function masterMediaRef(group: MulticamSource): string | undefined {
  return group.members.find((m) => m.id === group.masterMemberId)?.mediaRef
}

function filterTargets(ctx: TargetContext, pool: Clip[], withAudio: Set<string>, anyMic: boolean): Clip[] {
  return pool
    .filter((clip) => {
      if (!captionCanTranscribe(ctx, clip)) return false
      const group = clip.multicamGroupId ? ctx.multicamGroups.find((g) => g.id === clip.multicamGroupId) : undefined
      if (group) return clip.mediaType === 'audio' && (anyMic || clip.mediaRef === masterMediaRef(group))
      if (clip.mediaType !== 'video' || !clip.linkGroupId) return true
      return !withAudio.has(clip.linkGroupId)
    })
    .sort((a, b) => a.startFrame - b.startFrame)
}

/** `captionTargets(ids:)`: all timeline clips when `ids` is empty (automatic), else the selected clips. */
export function captionTargetsForIds(ctx: TargetContext, ids: string[]): Clip[] {
  const clips = allClips(ctx.timeline)
  const pool = ids.length ? clips.filter((c) => ids.includes(c.id)) : clips
  return filterTargets(ctx, pool, linkGroupsWithAudio(pool), ids.length > 0)
}

/** `transcriptionTargets(clipIds:)`: an agent-named clip scope; linked video is skipped when its audio exists anywhere. */
export function transcriptionTargetsForClips(ctx: TargetContext, ids: string[]): Clip[] {
  const clips = allClips(ctx.timeline)
  return filterTargets(ctx, clips.filter((c) => ids.includes(c.id)), linkGroupsWithAudio(clips), true)
}

export function captionTargetsForTracks(ctx: TargetContext, trackIds: string[]): Clip[] {
  if (!trackIds.length) return []
  const pool = ctx.timeline.tracks.filter((t) => trackIds.includes(t.id)).flatMap((t) => t.clips)
  return filterTargets(ctx, pool, linkGroupsWithAudio(allClips(ctx.timeline)), true)
}

/** Locates target clips on the timeline (track id/index); clips no longer present are dropped. */
export function locateTargets(t: Timeline, clips: Clip[]): CaptionTarget[] {
  return clips.flatMap((c) => {
    const trackIndex = t.tracks.findIndex((tr) => tr.clips.some((x) => x.id === c.id))
    if (trackIndex < 0) return []
    const clip = t.tracks[trackIndex].clips.find((x) => x.id === c.id)!
    return [{ clip, trackId: t.tracks[trackIndex].id, trackIndex }]
  })
}

/** The track with the most spoken words in its clips' visible spans (> 0), or null. */
export function dominantSpeechTrack(targets: CaptionTarget[], results: Map<string, TranscriptionResult>, fps: number): string | null {
  const words = new Map<string, number>()
  for (const t of targets) {
    const r = results.get(t.clip.mediaRef)
    if (!r) continue
    words.set(t.trackId, (words.get(t.trackId) ?? 0) + spokenWordCount(t.clip, r, fps))
  }
  let best: string | null = null
  let most = 0
  for (const [id, n] of words) {
    if (n > most) {
      best = id
      most = n
    }
  }
  return best
}

/** Linked partners' transcribable clips, used when a clip or track has no audio of its own. */
export function linkedPartnerClipIds(t: Timeline, clipIds: string[]): string[] {
  return clipIds.flatMap((id) => linkedPartnerIds(t, id))
}
