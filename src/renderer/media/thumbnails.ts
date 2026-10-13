import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react'
import { mediaUrl } from '../../shared/api'
import { onAssetSourceChange } from '../state/mediaPaths'

/** Thumbnail URLs per asset id (null = none available). Bounded by the library size. */
const thumbCache = new Map<string, string | null>()
const thumbInflight = new Map<string, Promise<string | null>>()

export function loadThumbnail(assetId: string): Promise<string | null> {
  if (thumbCache.has(assetId)) return Promise.resolve(thumbCache.get(assetId) ?? null)
  let p = thumbInflight.get(assetId)
  if (!p) {
    p = window.palmier.media
      .thumbnail(assetId)
      .then((path) => (path ? mediaUrl(path) : null))
      .catch(() => null)
      .then((url) => {
        thumbCache.set(assetId, url)
        thumbInflight.delete(assetId)
        return url
      })
    thumbInflight.set(assetId, p)
  }
  return p
}

export const cachedThumbnail = (assetId: string): string | null => thumbCache.get(assetId) ?? null

/** Envelope (0–1 peaks, resampled to `WAVE_BARS`) for audio tiles. */
const WAVE_BARS = 128
const waveCache = new Map<string, number[] | null>()
const waveInflight = new Map<string, Promise<number[] | null>>()

export function loadWaveform(assetId: string): Promise<number[] | null> {
  if (waveCache.has(assetId)) return Promise.resolve(waveCache.get(assetId) ?? null)
  let p = waveInflight.get(assetId)
  if (!p) {
    p = window.palmier.media
      .waveform(assetId)
      .catch(() => null)
      .then((data) => {
        const peaks = data?.peaks ?? []
        const bars = peaks.length
          ? Array.from({ length: WAVE_BARS }, (_, i) => {
              const a = Math.floor((i / WAVE_BARS) * peaks.length)
              const b = Math.max(a + 1, Math.floor(((i + 1) / WAVE_BARS) * peaks.length))
              let m = 0
              for (let j = a; j < b; j++) m = Math.max(m, peaks[j])
              return m
            })
          : null
        waveCache.set(assetId, bars)
        waveInflight.delete(assetId)
        return bars
      })
    waveInflight.set(assetId, p)
  }
  return p
}

/** Bumped when relinked assets drop their cached visuals, so mounted tiles reload. */
let revision = 0
const revisionListeners = new Set<() => void>()
onAssetSourceChange((ids) => {
  for (const id of ids) {
    thumbCache.delete(id)
    waveCache.delete(id)
  }
  revision++
  for (const l of revisionListeners) l()
})
const subscribeRevision = (cb: () => void) => {
  revisionListeners.add(cb)
  return () => revisionListeners.delete(cb)
}

const callbacks = new WeakMap<Element, () => void>()
let observer: IntersectionObserver | null = null

function observe(el: Element, onVisible: () => void): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        callbacks.get(e.target)?.()
        callbacks.delete(e.target)
        observer!.unobserve(e.target)
      }
    },
    { rootMargin: '200px' },
  )
  callbacks.set(el, onVisible)
  observer.observe(el)
  return () => {
    callbacks.delete(el)
    observer?.unobserve(el)
  }
}

/** Loads `load(id)` once the element first scrolls into view. */
export function useLazy<T>(ref: RefObject<Element | null>, id: string | null, load: (id: string) => Promise<T | null>, cached: (id: string) => T | null): T | null {
  const [value, setValue] = useState<T | null>(() => (id ? cached(id) : null))
  const rev = useSyncExternalStore(subscribeRevision, () => revision)
  useEffect(() => {
    if (!id) {
      setValue(null)
      return
    }
    const hit = cached(id)
    if (hit) {
      setValue(hit)
      return
    }
    const el = ref.current
    if (!el) return
    let alive = true
    const stop = observe(el, () => {
      void load(id).then((v) => {
        if (alive) setValue(v)
      })
    })
    return () => {
      alive = false
      stop()
    }
  }, [ref, id, load, cached, rev])
  return value
}

export const cachedWaveform = (assetId: string): number[] | null => waveCache.get(assetId) ?? null
