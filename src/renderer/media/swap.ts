/**
 * Swap Media (EditorViewModel+MediaSwap.swift, 03 §10.6): the clip menu arms a swap for a clip, the Media tab shows
 * a banner and dims assets that can't replace it, and clicking a compatible asset swaps the clip's source.
 * Escape, the banner's Cancel, or any timeline change disarms it.
 */
import { create } from 'zustand'
import type { Clip, Timeline } from '@core/model'
import { activeTimeline, type Doc } from '@core/ops/context'
import { findClip } from '@core/timeline'
import { showPanelFitting } from '../editor/panelFit'
import { getBaseDoc, timelineOf, useProject } from '../state/project'
import { toast } from '../ui/toast'
import { canSwapClip } from './mediaRules'
import { setMediaView } from './model'
import { t } from '../i18n'

interface SwapStore {
  /** `pendingSwapClipId`. */
  clipId: string | null
}

export const useSwap = create<SwapStore>(() => ({ clipId: null }))

/** Fingerprint of the active timeline when the swap was armed; any change cancels the swap. */
let armedTimeline: { id: string; json: string } | null = null

const fingerprint = (t: Timeline) => ({ id: t.id, json: JSON.stringify(t.tracks) })

/** The armed clip, if it still exists. */
export function pendingSwapClip(doc: Doc | null, clipId: string | null): Clip | null {
  if (!doc || !clipId) return null
  return findClip(activeTimeline(doc), clipId)?.clip ?? null
}

/** `beginMediaSwap`: arms the swap and shows the Media tab. */
export function beginMediaSwap(clipId: string): void {
  const doc = getBaseDoc()
  const t = timelineOf(doc)
  if (!doc || !t || !canSwapClip(doc, clipId)) return
  armedTimeline = fingerprint(t)
  useSwap.setState({ clipId })
  setMediaView({ section: 'media' })
  showPanelFitting('media')
}

/** `cancelMediaSwap`; returns whether a swap was armed (Esc runs this first). */
export function cancelMediaSwap(): boolean {
  armedTimeline = null
  if (!useSwap.getState().clipId) return false
  useSwap.setState({ clipId: null })
  return true
}

/** `completeMediaSwap(with:)`: swaps, or keeps the swap armed with a toast when the source can't be used. */
export async function completeMediaSwap(assetId: string): Promise<void> {
  const clipId = useSwap.getState().clipId
  if (!clipId || !pendingSwapClip(getBaseDoc(), clipId)) {
    cancelMediaSwap()
    return
  }
  const out = await window.palmier.project.op('swapClipMedia', { clipId, assetId })
  if (!out.ok) {
    toast(t('This source can’t replace the clip.'), 'warning')
    return
  }
  cancelMediaSwap()
}

// Any change to the active timeline (or switching timelines) disarms the swap, like the Mac's `timeline.didSet`.
useProject.subscribe((s, p) => {
  if (!armedTimeline || s.snapshot === p.snapshot) return
  const t = timelineOf(s.snapshot?.doc)
  if (!t || t.id !== armedTimeline.id || JSON.stringify(t.tracks) !== armedTimeline.json) cancelMediaSwap()
})
