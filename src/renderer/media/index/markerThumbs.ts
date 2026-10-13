/**
 * Marker row thumbnails (Mac `MarkerThumbnailView` + `VideoEngine.timelineThumbnail`): one composited timeline frame per
 * marker, rendered by the main-process render host. Requests run one at a time (Mac `frameImageGate`), newest first;
 * results are cached per (timeline, frame, composition generation) as object URLs.
 */
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { timelineOf, useProject } from '../../state/project'

/** Bumps whenever the committed timeline's rendered content changes (Mac `timelineCompositionGeneration`). */
export const useCompositionGeneration = create<{ generation: number }>(() => ({ generation: 0 }))

let lastKey = ''
useProject.subscribe((s, p) => {
  if (s.snapshot === p.snapshot) return
  const doc = s.snapshot?.doc
  const t = timelineOf(doc)
  const key = t && doc ? JSON.stringify([t.id, t.fps, t.width, t.height, t.tracks, doc.file.timelines.length > 1 ? doc.file.timelines : 0, doc.manifest.entries.map((e) => [e.id, e.source, e.generationStatus])]) : ''
  if (key === lastKey) return
  lastKey = key
  useCompositionGeneration.setState((g) => ({ generation: g.generation + 1 }))
})

const MAX_CACHE = 200
const cache = new Map<string, string | null>()
const waiting = new Map<string, Array<(url: string | null) => void>>()
const queue: Array<{ key: string; timelineId: string; frame: number; width: number }> = []
let busy = false

function remember(key: string, url: string | null): void {
  cache.set(key, url)
  while (cache.size > MAX_CACHE) {
    const [oldKey, oldUrl] = cache.entries().next().value as [string, string | null]
    cache.delete(oldKey)
    if (oldUrl) URL.revokeObjectURL(oldUrl)
  }
}

async function pump(): Promise<void> {
  if (busy) return
  busy = true
  try {
    while (queue.length) {
      const job = queue.pop()!
      if (!waiting.has(job.key)) continue
      let url: string | null = null
      try {
        const bytes = await window.palmier.extras.timelineThumbnail(job.timelineId, job.frame, job.width)
        if (bytes) url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/jpeg' }))
      } catch {
        url = null
      }
      remember(job.key, url)
      const cbs = waiting.get(job.key) ?? []
      waiting.delete(job.key)
      for (const cb of cbs) cb(url)
    }
  } finally {
    busy = false
  }
}

function request(key: string, timelineId: string, frame: number, width: number, cb: (url: string | null) => void): () => void {
  const list = waiting.get(key)
  if (list) list.push(cb)
  else {
    waiting.set(key, [cb])
    queue.push({ key, timelineId, frame, width })
    void pump()
  }
  return () => {
    const l = waiting.get(key)
    if (!l) return
    const i = l.indexOf(cb)
    if (i >= 0) l.splice(i, 1)
    if (!l.length) waiting.delete(key)
  }
}

/** `undefined` while loading, `null` when the frame couldn't be rendered. */
export function useMarkerThumbnail(timelineId: string, frame: number, pixelWidth: number): string | null | undefined {
  const generation = useCompositionGeneration((s) => s.generation)
  const key = `${timelineId}|${frame}|${pixelWidth}|${generation}`
  const [state, setState] = useState<{ key: string; url: string | null } | null>(() => (cache.has(key) ? { key, url: cache.get(key)! } : null))
  useEffect(() => {
    if (cache.has(key)) {
      setState({ key, url: cache.get(key)! })
      return
    }
    setState(null)
    return request(key, timelineId, frame, pixelWidth, (url) => setState({ key, url }))
  }, [key, timelineId, frame, pixelWidth])
  return state && state.key === key ? state.url : undefined
}
