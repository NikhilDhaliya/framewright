/**
 * Clips waiting for an AI-generated replacement (Mac `EditorViewModel.pendingReplacements`,
 * `markPendingReplacement` / `clearPendingReplacement`; spec 06 §B6.2). Transient editor state: a clip is marked,
 * together with linked clips sharing its media, when a replacement is submitted, and unmarked when its
 * placeholders stop being in flight (swap done or failed) or disappear. The timeline draws the generating
 * overlay on marked clips.
 */
import { create } from 'zustand'
import { isInFlight } from '@core/generation/status'
import type { MediaManifestEntry, Timeline } from '@core/model'
import type { Doc } from '@core/ops/context'

/** clipId → placeholder asset ids it waits for. */
export const usePendingReplacements = create<{ byClip: ReadonlyMap<string, readonly string[]> }>(() => ({ byClip: new Map() }))

/** `linkedClipIdsSharingMedia(anchor:)`. */
export function linkedClipIdsSharingMedia(t: Timeline | undefined, anchor: string): string[] {
  const clip = t?.tracks.flatMap((tr) => tr.clips).find((c) => c.id === anchor)
  if (!t || !clip?.linkGroupId) return [anchor]
  const ids = new Set([anchor])
  for (const tr of t.tracks) for (const c of tr.clips) if (c.linkGroupId === clip.linkGroupId && c.mediaRef === clip.mediaRef) ids.add(c.id)
  return [...ids]
}

/** Pure: the map after pruning entries whose placeholders are all settled or gone. */
export function prunePending(byClip: ReadonlyMap<string, readonly string[]>, entries: readonly MediaManifestEntry[]): ReadonlyMap<string, readonly string[]> {
  if (!byClip.size) return byClip
  const byId = new Map(entries.map((e) => [e.id, e]))
  let out: Map<string, readonly string[]> | null = null
  for (const [clip, ids] of byClip) {
    const waiting = ids.some((id) => {
      const e = byId.get(id)
      return !!e && isInFlight(e.generationStatus)
    })
    if (waiting) continue
    out ??= new Map(byClip)
    out.delete(clip)
  }
  return out ?? byClip
}

export function markPendingReplacement(doc: Doc | null, timelineId: string | null | undefined, clipId: string, placeholderIds: string[]): void {
  if (!placeholderIds.length) return
  const t = doc?.file.timelines.find((x) => x.id === (timelineId ?? doc.file.activeTimelineId))
  const next = new Map(usePendingReplacements.getState().byClip)
  for (const id of linkedClipIdsSharingMedia(t, clipId)) next.set(id, placeholderIds)
  usePendingReplacements.setState({ byClip: next })
}

/** Call on every doc update. */
export function syncPendingReplacements(doc: Doc | null): void {
  const cur = usePendingReplacements.getState().byClip
  const next = doc ? prunePending(cur, doc.manifest.entries) : new Map()
  if (next !== cur && (next.size || cur.size)) usePendingReplacements.setState({ byClip: next })
}
