/** Pure rules for the media panel's swap mode and offline states (unit-tested; no stores, no DOM). */
import { produce } from 'immer'
import { opacityAt } from '@core/clip'
import { isInFlight } from '@core/generation/status'
import type { Clip, MediaManifestEntry, Timeline } from '@core/model'
import { swapClipMedia } from '@core/ops/agent'
import { activeTimeline, placeableAsset, type Doc } from '@core/ops/context'
import { findClip } from '@core/timeline'

/** `mediaSwapTargetClipIds` validity: not text / nested, and no multicam clip among its same-source link partners. */
export function canSwapClip(doc: Doc, clipId: string): boolean {
  const clip = findClip(activeTimeline(doc), clipId)?.clip
  if (!clip) return false
  try {
    // A replacement equal to the current source runs every target check and returns before mutating.
    produce(doc, (d) => void swapClipMedia(d, clipId, { id: clip.mediaRef, type: clip.sourceClipType, duration: 0, hasAudio: false, name: '' }, 1))
    return true
  } catch {
    return false
  }
}

/** `isAssetCompatibleWithPendingSwap` for every asset: the swap's own validation without committing. */
export function compatibleAssets(doc: Doc, clipId: string): Set<string> {
  const out = new Set<string>()
  const fps = activeTimeline(doc).fps
  for (const e of doc.manifest.entries) {
    try {
      produce(doc, (d) => {
        const asset = placeableAsset(d, e.id)
        if (!asset) throw new Error('missing')
        swapClipMedia(d, clipId, asset, fps)
      })
      out.add(e.id)
    } catch {
      // incompatible
    }
  }
  return out
}

/** Tile "Media Offline" state: generating / failed assets keep their own states (`AssetThumbnailView.isMissing`). */
export const tileOffline = (e: MediaManifestEntry, offline: ReadonlySet<string>): boolean =>
  (!e.generationStatus || e.generationStatus === 'none') && offline.has(e.id)

/** `isClipMediaOffline` for media clips (nested clips are handled by the caller: offline when the timeline is gone). */
export const clipMediaOffline = (c: Clip, offline: ReadonlySet<string>): boolean => c.mediaType !== 'text' && c.sourceClipType !== 'sequence' && offline.has(c.mediaRef)

/**
 * `PreviewContainerView.timelineFrameState`: walking visible non-audio tracks top-down, a ready clip covers the frame
 * (no panel); otherwise the first offline clip's asset is shown. A generating clip leaves the frame to its own overlay.
 */
export function offlineAssetAt(t: Timeline, frame: number, entries: ReadonlyMap<string, MediaManifestEntry>, offline: ReadonlySet<string>): string | null {
  if (!offline.size) return null
  let found: string | null = null
  let generating = false
  for (const tr of t.tracks) {
    if (tr.type === 'audio' || tr.hidden) continue
    for (const c of tr.clips) {
      if (c.mediaType === 'text' || frame < c.startFrame || frame >= c.startFrame + c.durationFrames || opacityAt(c, frame) <= 0.01) continue
      if (isInFlight(entries.get(c.mediaRef)?.generationStatus)) generating = true
      else if (c.sourceClipType !== 'sequence' && offline.has(c.mediaRef)) found ??= c.mediaRef
      else return null
    }
  }
  return generating ? null : found
}
