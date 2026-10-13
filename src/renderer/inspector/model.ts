import { useEffect, useMemo, useState } from 'react'
import { applyClipPatch, type ClipPropertyPatch } from '@core/ops'
import { activeTimeline } from '@core/ops/context'
import type { Clip, MediaManifestEntry } from '@core/model'
import { findClip } from '@core/timeline'
import { deepClone } from '@core/util'
import { useEditor } from '../state/editor'
import { clearPreview, previewWith, runOp } from '../state/ops'
import { pause, usePlayhead } from '../state/playback'
import { getTimeline, timelineOf, useProject, useTimeline } from '../state/project'

const PLAYING_REFRESH_MS = 100

/** Playhead frame for the inspector: immediate while paused, ≈10 Hz during playback. */
export function useInspectorFrame(): number {
  const [frame, setFrame] = useState(() => usePlayhead.getState().frame)
  useEffect(() => {
    let last = 0
    let timer = 0
    const unsub = usePlayhead.subscribe((s) => {
      window.clearTimeout(timer)
      const now = performance.now()
      if (!s.playing || now - last >= PLAYING_REFRESH_MS) {
        last = now
        setFrame(s.frame)
      } else timer = window.setTimeout(() => setFrame(usePlayhead.getState().frame), PLAYING_REFRESH_MS)
    })
    return () => {
      unsub()
      window.clearTimeout(timer)
    }
  }, [])
  return frame
}

/** Selected clips of the displayed timeline (live preview included), subtitles excluded. */
export function useSelectedClips(): Clip[] {
  const t = useTimeline()
  const ids = useEditor((s) => s.selectedClipIds)
  return useMemo(() => {
    if (!t || !ids.length) return []
    const set = new Set(ids)
    return t.tracks.flatMap((tr) => tr.clips.filter((c) => set.has(c.id) && c.mediaType !== 'subtitle'))
  }, [t, ids])
}

export function useCanvasSize(): { w: number; h: number } {
  const t = useTimeline()
  return { w: t?.width ?? 1920, h: t?.height ?? 1080 }
}

export const useAssets = () => useProject((s) => (s.preview ?? s.snapshot?.doc)?.manifest.entries)

export function assetOf(entries: MediaManifestEntry[] | undefined, c: Clip): MediaManifestEntry | undefined {
  return entries?.find((e) => e.id === c.mediaRef)
}

/** The shared value across clips, or null when they differ (rendered as "—"). */
export function common<T>(clips: Clip[], read: (c: Clip) => T, eq: (a: T, b: T) => boolean = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-6 : a === b)): T | null {
  if (!clips.length) return null
  const first = read(clips[0])
  return clips.every((c) => eq(read(c), first)) ? first : null
}

/** The committed (non-preview) clip, for comparisons and read-modify-write commits. */
export const authoritativeClip = (id: string): Clip | null => {
  const doc = useProject.getState().snapshot?.doc
  return doc ? (findClip(activeTimeline(doc), id)?.clip ?? null) : null
}

export type PatchFor = (c: Clip) => ClipPropertyPatch

/**
 * Live-apply / commit pair for animation-aware clip property writes. Patches may differ per clip
 * (per-clip aspect, text box refit); identical patches commit as one `setClipProperties` step.
 */
export function previewPatch(ids: string[], frame: number, patchFor: PatchFor): void {
  previewWith((d) => {
    const t = activeTimeline(d)
    for (const id of ids) {
      const loc = findClip(t, id)
      if (loc) applyClipPatch(loc.clip, frame, patchFor(loc.clip))
    }
  })
}

export async function commitPatch(ids: string[], frame: number, patchFor: PatchFor, label: string): Promise<void> {
  const clips = ids.map(authoritativeClip).filter((c): c is Clip => !!c)
  const patches = clips.map((c) => patchFor(c))
  try {
    if (patches.every((p) => JSON.stringify(p) === JSON.stringify(patches[0]))) {
      await runOp('setClipProperties', { ids: clips.map((c) => c.id), frame, patch: patches[0], label }, { quiet: true })
    } else {
      for (let i = 0; i < clips.length; i++) await runOp('setClipProperties', { ids: [clips[i].id], frame, patch: patches[i], label }, { quiet: true })
    }
  } finally {
    clearPreview()
  }
}

/** Direct (non-animated) mutations such as resets or tilt: previewed on a draft, committed per clip via replaceClip. */
export function previewMutation(ids: string[], mutate: (c: Clip) => void): void {
  previewWith((d) => {
    const t = activeTimeline(d)
    for (const id of ids) {
      const loc = findClip(t, id)
      if (loc) mutate(loc.clip)
    }
  })
}

export async function commitMutation(ids: string[], mutate: (c: Clip) => void, label: string): Promise<void> {
  try {
    for (const id of ids) {
      const base = authoritativeClip(id)
      if (!base) continue
      const next = deepClone(base)
      mutate(next)
      if (JSON.stringify(next) !== JSON.stringify(base)) await runOp('replaceClip', { clip: next, label }, { quiet: true })
    }
  } finally {
    clearPreview()
  }
}

export const timelineFps = () => getTimeline()?.fps ?? 30
export const useTimelineFps = () => useProject((s) => timelineOf(s.preview ?? s.snapshot?.doc)?.fps ?? 30)

/** Scrub-field wiring for a patch-based property; a drag pauses playback so the write frame stays pinned. */
export function patchHandlers(ids: string[], frame: number, label: string, patchFor: (v: number) => PatchFor) {
  return {
    onChange: (v: number) => previewPatch(ids, frame, patchFor(v)),
    onCommit: (v: number) => void commitPatch(ids, frame, patchFor(v), label),
    onCancel: () => clearPreview(),
    onInteraction: (active: boolean) => active && pause(),
  }
}
