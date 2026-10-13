/** Clips that wait for a generation (spec 06 §B6.2) and AI Edit / AI Transition placements (§B9.3, §B10). */
import { endFrame } from '../clip'
import { isVisualType, type Timeline } from '../model'
import { placeClip } from '../ops/clips'
import { placeableAsset, timelineById, type Doc } from '../ops/context'
import { allClips, EditRefusal, findClip, resolveOrCreateAudioTrack } from '../timeline'
import type { TransitionPlacement } from './edit'

/** `placeGeneratingAudioClip`: a clip for the placeholder at `startFrame`, on the first free audio track or a new one at the bottom. */
export function placeGeneratingAudioClip(doc: Doc, timelineId: string, placeholderId: string, startFrame: number, spanSeconds: number): string {
  const t = timelineById(doc, timelineId)
  if (!t) throw new EditRefusal('Timeline not found.')
  const asset = placeableAsset(doc, placeholderId)
  if (!asset) throw new EditRefusal('Media not found.')
  const duration = Math.max(1, Math.round(spanSeconds * t.fps))
  const start = Math.max(0, Math.trunc(startFrame))
  const ti = resolveOrCreateAudioTrack(t, start, duration)
  const [id] = placeClip(doc, t, { ...asset, duration: Math.max(asset.duration, duration / t.fps) }, ti, start, duration, { addLinkedAudio: false })
  return id
}

/** `finalizeGeneratingClip`: every clip of the finished asset on every timeline spans its real length, trims reset. */
export function finalizeGeneratingClips(doc: Doc, assetId: string, assetSeconds: number): void {
  if (!(assetSeconds > 0)) return
  for (const t of doc.file.timelines) {
    for (const tr of t.tracks) {
      for (const c of tr.clips) {
        if (c.mediaRef !== assetId) continue
        c.durationFrames = Math.max(1, Math.round(assetSeconds * t.fps))
        c.trimStartFrame = 0
        c.trimEndFrame = 0
      }
    }
  }
}

// ---------- AI Transition (§B10) ----------

/** `transitionGapIsEmpty`: no clip on the placement's track overlaps the gap. */
export function transitionGapIsEmpty(t: Timeline | undefined, p: TransitionPlacement): boolean {
  const tr = t?.tracks[p.trackIndex]
  if (!tr) return false
  const end = p.gapStartFrame + p.gapLengthFrames
  return !tr.clips.some((c) => c.startFrame < end && endFrame(c) > p.gapStartFrame)
}

/** `transitionSeedIsCurrent`: still the active timeline and the gap is still empty. */
export function transitionPlacementIsCurrent(doc: Doc, p: TransitionPlacement): boolean {
  return doc.file.activeTimelineId === p.timelineId && transitionGapIsEmpty(timelineById(doc, p.timelineId), p)
}

/** `placeGeneratingTransitionClip`: a clip exactly filling the gap (no linked audio). */
export function placeTransitionClip(doc: Doc, p: TransitionPlacement, placeholderId: string): string | null {
  const t = timelineById(doc, p.timelineId)
  const asset = placeableAsset(doc, placeholderId)
  if (!t || !asset || !transitionGapIsEmpty(t, p)) return null
  const [id] = placeClip(doc, t, { ...asset, duration: Math.max(asset.duration, p.gapLengthFrames / t.fps) }, p.trackIndex, p.gapStartFrame, p.gapLengthFrames, { addLinkedAudio: false })
  return id ?? null
}

/** `finalizeTransitionClip`: the clip keeps filling the gap; the real media is retimed to fit (speed), trims 0. */
export function finalizeTransitionClips(doc: Doc, assetId: string, assetSeconds: number): void {
  if (!(assetSeconds > 0)) return
  for (const t of doc.file.timelines) {
    for (const c of allClips(t)) {
      if (c.mediaRef !== assetId) continue
      const real = Math.max(1, Math.round(assetSeconds * t.fps))
      c.speed = real / Math.max(1, c.durationFrames)
      c.trimStartFrame = 0
      c.trimEndFrame = 0
    }
  }
}

// ---------- Replace clip source (§B6.2) ----------

/**
 * `replaceClipMediaRef`: the clip and its same-media linked partners point at the new asset; speed, volume and
 * transform stay; trims reset when the new media covers only the trimmed span. Returns false when nothing changed.
 */
export function replaceClipSource(doc: Doc, timelineId: string, clipId: string, newAssetId: string, resetTrim: boolean): boolean {
  const t = timelineById(doc, timelineId) ?? doc.file.timelines.find((x) => !!findClip(x, clipId))
  const anchor = t ? findClip(t, clipId)?.clip : undefined
  const asset = placeableAsset(doc, newAssetId)
  if (!t || !anchor || !asset || anchor.mediaRef === newAssetId) return false
  const old = anchor.mediaRef
  const targets = allClips(t).filter((c) => c.id === clipId || (anchor.linkGroupId && c.linkGroupId === anchor.linkGroupId && c.mediaRef === old))
  for (const c of targets) {
    c.mediaRef = newAssetId
    // Create Video turns an image clip into a video clip: keep the clip's kind in step with its new source.
    c.sourceClipType = asset.type
    if (isVisualType(c.mediaType) && isVisualType(asset.type)) c.mediaType = asset.type
    if (resetTrim) {
      c.trimStartFrame = 0
      c.trimEndFrame = 0
    }
  }
  return true
}
