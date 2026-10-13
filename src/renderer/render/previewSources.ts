/**
 * Preview frame sources: pooled HTMLVideoElements (picture only, muted) seeked/played to the clip's source
 * time, and decoded stills. Frames that are not ready yet report 'pending' (the compositor draws a checker).
 */
import { mediaUrl } from '../../shared/api'
import { lottieMediaUrl, type LottieJson } from '../../shared/lottie'
import type { FrameProvider, FrameResult } from './compositor'
import { LottieSources } from './lottieSource'
import { mediaLayers, sourceTimeSec, type LayerPlan, type MediaLayer } from './plan'
import { YUV_FORMATS, type YuvFormat, type YuvPlanes } from './yuv'

const MAX_IMAGE_SIDE = 4096
const POOL_LIMIT = 16
/** Display frames a hair after the requested instant so float error never shows the previous frame. */
const SEEK_EPSILON = 0.0005
const PLAY_DRIFT = 0.2
/** Above this preview rate video elements seek frame-to-frame instead of decoding every frame. */
const MAX_PLAYING_RATE = 2

let videoHost: HTMLDivElement | null = null
/**
 * Keeps a pooled element in the page, 1 px and nearly transparent: Chromium renders detached (never composited)
 * videos at its background rate of a few frames per second, so playback showed ~5 new frames/s instead of 30.
 */
function attachVideo(el: HTMLVideoElement): void {
  if (!videoHost) {
    videoHost = document.createElement('div')
    videoHost.setAttribute('aria-hidden', 'true')
    videoHost.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:2147483647'
    document.body.appendChild(videoHost)
  }
  el.style.cssText = 'display:block;width:1px;height:1px'
  videoHost.appendChild(el)
}

/** Asset id → playable media URL, resolved once and shared by picture and audio. */
export class PlaybackUrls {
  private readonly resolved = new Map<string, string | null>()
  private readonly pending = new Set<string>()

  constructor(
    private readonly resolvePlaybackPath: (assetId: string) => Promise<string | null>,
    private readonly onResolved: (assetId: string, url: string | null) => void,
  ) {}

  /** URL, null when offline, undefined while resolving. */
  get(assetId: string): string | null | undefined {
    if (this.resolved.has(assetId)) return this.resolved.get(assetId)
    if (!this.pending.has(assetId)) {
      this.pending.add(assetId)
      void this.resolvePlaybackPath(assetId)
        .catch(() => null)
        .then((path) => {
          this.pending.delete(assetId)
          const url = path ? mediaUrl(path) : null
          this.resolved.set(assetId, url)
          this.onResolved(assetId, url)
        })
    }
    return undefined
  }

  invalidate(assetIds: Iterable<string>): void {
    for (const id of assetIds) this.resolved.delete(id)
  }
}

interface Slot {
  el: HTMLVideoElement
  url: string
  clipId: string | null
  /** Clip whose frame the element currently displays (it lags `clipId` until a reassigned slot has seeked). */
  shows: string | null
  target: number
  used: number
  /** Serial of the frame the element presents (requestVideoFrameCallback / seeks); the upload version. */
  presented: number
  /** Y'CbCr planes copied from the element's frame `planesFor`, for clip `planesClip`. */
  planes: YuvPlanes | null
  planesFor: number
  planesClip: string | null
  copying: boolean
  /** Double buffer for plane copies (the frame being uploaded is never overwritten). */
  buffers: Uint8Array[]
  /** Frames are not CPU Y'CbCr (GPU-backed, high bit depth, rotated…): upload the element itself. */
  elementOnly: boolean
}

let frameSerial = 1

/** Animation JSON from the main process (dotLottie archives are unzipped there), spec 07 §4.2. */
async function fetchLottie(path: string): Promise<LottieJson> {
  const r = await fetch(lottieMediaUrl(path), { cache: 'no-cache' })
  if (!r.ok) throw new Error(`Lottie ${path}: ${r.status}`)
  return (await r.json()) as LottieJson
}

export class PreviewSources implements FrameProvider {
  private readonly slots: Slot[] = []
  private readonly images = new Map<string, { bitmap: ImageBitmap | null; failed: boolean; serial: number }>()
  private readonly lottie: LottieSources
  private tick = 0
  private imageSerial = 1
  playing = false
  /** Preview playback rate. */
  rate = 1

  constructor(
    private readonly urls: PlaybackUrls,
    private readonly onReady: () => void,
  ) {
    this.lottie = new LottieSources(fetchLottie, onReady)
  }

  private url(assetId: string): string | null | undefined {
    return this.urls.get(assetId)
  }

  /** Seeks / plays the elements a plan needs; call before rendering it. */
  sync(plan: LayerPlan[], f: number, fps: number): void {
    this.tick++
    this.lottie.nextFrame()
    for (const layer of mediaLayers(plan)) {
      if (layer.offline || layer.info.type !== 'video') continue
      const t = sourceTimeSec(layer.clip, f, fps, layer.timing)
      if (t === null) continue
      const url = this.url(layer.sourceId)
      if (!url) continue
      const slot = this.slotFor(layer.clip.id, url)
      slot.used = this.tick
      this.drive(slot, t, layer.timing.rate)
    }
    for (const s of this.slots) {
      if (s.used !== this.tick && !s.el.paused) s.el.pause()
    }
  }

  /** Pre-rolls elements for clips that start soon (paused at their first frame). */
  preroll(plan: LayerPlan[], f: number, fps: number): void {
    for (const layer of mediaLayers(plan)) {
      if (layer.offline || layer.info.type !== 'video') continue
      if (this.slots.some((s) => s.clipId === layer.clip.id)) continue
      const t = sourceTimeSec(layer.clip, Math.max(f, layer.clip.startFrame), fps, layer.timing)
      const url = t === null ? null : this.url(layer.sourceId)
      if (!url || t === null) continue
      const slot = this.slotFor(layer.clip.id, url)
      slot.used = this.tick
      this.seek(slot, t)
    }
  }

  private slotFor(clipId: string, url: string): Slot {
    let s = this.slots.find((x) => x.clipId === clipId)
    if (s && s.url !== url) {
      s.url = url
      s.el.src = url
      s.shows = null
      s.planes = null
      s.elementOnly = typeof VideoFrame === 'undefined'
      s.target = NaN
    }
    if (s) return s
    s = this.slots.find((x) => x.url === url && x.used < this.tick - 1) ?? this.slots.find((x) => x.used < this.tick - 1)
    if (!s && this.slots.length >= POOL_LIMIT) s = this.slots.reduce((a, b) => (a.used <= b.used ? a : b))
    if (!s) {
      const el = document.createElement('video')
      el.crossOrigin = 'anonymous'
      el.muted = true
      el.playsInline = true
      el.preload = 'auto'
      el.disableRemotePlayback = true
      attachVideo(el)
      const slot: Slot = { el, url: '', clipId: null, shows: null, target: NaN, used: 0, presented: 0, planes: null, planesFor: -1, planesClip: null, copying: false, buffers: [], elementOnly: typeof VideoFrame === 'undefined' }
      const ready = () => {
        slot.shows = slot.clipId
        slot.presented = frameSerial++
        this.onReady()
      }
      el.addEventListener('seeked', ready)
      el.addEventListener('loadeddata', ready)
      el.addEventListener('error', () => this.onReady())
      const presented = () => {
        slot.presented = frameSerial++
        this.onReady()
        el.requestVideoFrameCallback(presented)
      }
      el.requestVideoFrameCallback(presented)
      this.slots.push(slot)
      s = slot
    }
    if (s.url !== url) {
      s.url = url
      s.el.src = url
      s.shows = null
      s.planes = null
      s.elementOnly = typeof VideoFrame === 'undefined'
    }
    if (s.clipId !== clipId) s.target = NaN
    s.clipId = clipId
    return s
  }

  private seek(s: Slot, t: number): void {
    const target = t + SEEK_EPSILON
    if (s.target === target) return
    s.target = target
    if (!s.el.paused) s.el.pause()
    s.el.currentTime = target
  }

  private drive(s: Slot, t: number, clipRate: number): void {
    const rate = clipRate * this.rate
    if (!this.playing) {
      this.seek(s, t)
      return
    }
    if (this.rate > MAX_PLAYING_RATE || rate > 16) {
      // Fast preview: show whichever frame the last seek landed on, then seek to the playhead again.
      if (!s.el.paused) s.el.pause()
      if (!s.el.seeking) this.seek(s, t)
      return
    }
    if (s.el.playbackRate !== rate) s.el.playbackRate = rate
    const claim = s.shows !== s.clipId && !s.el.seeking
    if (claim || Math.abs(s.el.currentTime - t) > PLAY_DRIFT * Math.max(1, rate) || s.el.ended) {
      s.target = t
      s.el.currentTime = t
    }
    if (s.el.paused) void s.el.play().catch(() => undefined)
  }

  frame(layer: MediaLayer, timeSec: number): FrameResult {
    if (layer.info.type === 'image') return this.image(layer)
    if (layer.info.type === 'lottie') return this.lottie.frame(layer, timeSec)
    const s = this.slots.find((x) => x.clipId === layer.clip.id)
    const url = this.urls.get(layer.sourceId)
    if (url === null) return 'offline'
    if (!s || s.el.readyState < 2 || !s.el.videoWidth || s.shows !== layer.clip.id) return 'pending'
    if (s.el.error) return 'offline'
    if (!s.elementOnly) {
      if (s.planesFor !== s.presented && !s.copying) this.copyPlanes(s)
      const p = s.planes
      if (p && s.planesClip === layer.clip.id) return { source: null, pixels: null, yuv: p, width: p.width, height: p.height, version: s.planesFor }
      if (!s.elementOnly) return 'pending'
    }
    // Upload only when the element presented a new frame (it re-renders at the display rate).
    return { source: s.el, pixels: null, width: s.el.videoWidth, height: s.el.videoHeight, version: s.presented }
  }

  /**
   * Copies the element's current frame as raw Y'CbCr planes (off the main thread); the compositor converts
   * them with the stream's matrix (§7.2). Uploading the element itself costs a synchronous conversion.
   */
  private copyPlanes(s: Slot): void {
    let vf: VideoFrame
    try {
      vf = new VideoFrame(s.el)
    } catch {
      s.elementOnly = true
      return
    }
    const rect = vf.visibleRect
    const rotated = (vf as VideoFrame & { rotation?: number }).rotation
    if (!vf.format || !YUV_FORMATS.has(vf.format) || !rect || rotated || vf.displayWidth !== rect.width || vf.displayHeight !== rect.height) {
      vf.close()
      s.elementOnly = true
      this.onReady()
      return
    }
    const size = vf.allocationSize()
    const i = s.planes?.data === s.buffers[0] ? 1 : 0
    if (s.buffers[i]?.length !== size) s.buffers[i] = new Uint8Array(size)
    const data = s.buffers[i]
    const want = s.presented
    const clip = s.clipId
    const format = vf.format as YuvFormat
    const { matrix, fullRange } = vf.colorSpace
    s.copying = true
    vf.copyTo(data)
      .then(
        (layout) => {
          if (s.clipId !== clip) return
          s.planes = { format, width: rect.width, height: rect.height, data, layout, matrix: matrix ?? null, fullRange: fullRange ?? null }
          s.planesFor = want
          s.planesClip = clip
        },
        () => {
          s.elementOnly = true
        },
      )
      .finally(() => {
        vf.close()
        s.copying = false
        this.onReady()
      })
  }

  private image(layer: MediaLayer): FrameResult {
    const url = this.url(layer.sourceId)
    if (url === null) return 'offline'
    if (url === undefined) return 'pending'
    const hit = this.images.get(url)
    if (hit) return hit.failed ? 'offline' : hit.bitmap ? { source: hit.bitmap, pixels: null, width: hit.bitmap.width, height: hit.bitmap.height, version: hit.serial } : 'pending'
    const entry = { bitmap: null as ImageBitmap | null, failed: false, serial: this.imageSerial++ }
    this.images.set(url, entry)
    void (async () => {
      try {
        const blob = await (await fetch(url)).blob()
        let bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default', imageOrientation: 'from-image' })
        const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bmp.width, bmp.height))
        if (k < 1) {
          const r = await createImageBitmap(bmp, { resizeWidth: Math.max(2, Math.round(bmp.width * k)), resizeHeight: Math.max(2, Math.round(bmp.height * k)), premultiplyAlpha: 'none', resizeQuality: 'high' })
          bmp.close()
          bmp = r
        }
        entry.bitmap = bmp
      } catch {
        entry.failed = true
      }
      this.onReady()
    })()
    return 'pending'
  }

  /** Whether every video layer in the plan shows its exact requested frame (committed seeks). */
  settled(plan: LayerPlan[]): boolean {
    for (const layer of mediaLayers(plan)) {
      if (!layer.offline && layer.info.type === 'lottie' && layer.info.path && this.lottie.get(layer.info.path) === 'pending') return false
      if (layer.offline || layer.info.type !== 'video') continue
      const s = this.slots.find((x) => x.clipId === layer.clip.id)
      if (!s || s.el.seeking || s.el.readyState < 2) return false
    }
    return true
  }

  pauseAll(): void {
    for (const s of this.slots) if (!s.el.paused) s.el.pause()
  }

  dispose(): void {
    for (const s of this.slots) {
      s.el.pause()
      s.el.removeAttribute('src')
      s.el.load()
      s.el.remove()
    }
    this.slots.length = 0
    for (const i of this.images.values()) i.bitmap?.close()
    this.images.clear()
    this.lottie.dispose()
  }
}
