import type { MediaManifestEntry } from '@core/model'
import { mediaUrl } from '../../shared/api'
import { onAssetSourceChange } from '../state/mediaPaths'

/** Lazily loaded timeline visuals (filmstrips, stills, waveforms), keyed by asset id. */
export interface Filmstrip {
  frames: (HTMLImageElement | null)[]
  duration: number
  aspect: number
}

export interface Waveform {
  /** Normalized peak level per bucket (−50…0 dB → 0…1). */
  amp: Float32Array
  samplesPerSecond: number
}

const FILMSTRIP_HEIGHT = 68
const strips = new Map<string, Filmstrip | null>()
const stills = new Map<string, HTMLImageElement | null>()
const waves = new Map<string, Waveform | null>()
const listeners = new Set<() => void>()
let notifyRaf = 0

function notify(): void {
  if (notifyRaf) return
  notifyRaf = requestAnimationFrame(() => {
    notifyRaf = 0
    for (const l of listeners) l()
  })
}

onAssetSourceChange((ids) => {
  for (const id of ids) {
    strips.delete(id)
    stills.delete(id)
    waves.delete(id)
  }
  notify()
})

export function onMediaCacheChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function loadImage(path: string, onLoad: (img: HTMLImageElement) => void): void {
  const img = new Image()
  img.decoding = 'async'
  img.onload = () => onLoad(img)
  img.src = mediaUrl(path)
}

/** One thumbnail per second under 10 s, else every 2 s (§6.5). */
export function filmstrip(asset: MediaManifestEntry): Filmstrip | null {
  if (strips.has(asset.id)) return strips.get(asset.id) ?? null
  strips.set(asset.id, null)
  const count = Math.max(1, Math.ceil(asset.duration < 10 ? asset.duration : asset.duration / 2))
  void window.palmier.media.filmstrip(asset.id, count, FILMSTRIP_HEIGHT).then((paths) => {
    if (!paths.length) return
    const strip: Filmstrip = { frames: paths.map(() => null), duration: asset.duration, aspect: (asset.sourceWidth ?? 16) / (asset.sourceHeight ?? 9) }
    strips.set(asset.id, strip)
    paths.forEach((p, i) =>
      loadImage(p, (img) => {
        strip.frames[i] = img
        if (img.naturalHeight) strip.aspect = img.naturalWidth / img.naturalHeight
        notify()
      }),
    )
  })
  return null
}

export function stillImage(assetId: string): HTMLImageElement | null {
  if (stills.has(assetId)) return stills.get(assetId) ?? null
  stills.set(assetId, null)
  void window.palmier.media.thumbnail(assetId).then((p) => {
    if (p)
      loadImage(p, (img) => {
        stills.set(assetId, img)
        notify()
      })
  })
  return null
}

export function waveform(assetId: string): Waveform | null {
  if (waves.has(assetId)) return waves.get(assetId) ?? null
  waves.set(assetId, null)
  void window.palmier.media.waveform(assetId).then((w) => {
    if (!w) return
    const amp = new Float32Array(w.peaks.length)
    for (let i = 0; i < w.peaks.length; i++) {
      const p = w.peaks[i]
      amp[i] = p <= 0 ? 0 : Math.min(1, Math.max(0, (20 * Math.log10(p) + 50) / 50))
    }
    waves.set(assetId, { amp, samplesPerSecond: w.samplesPerSecond })
    notify()
  })
  return null
}
