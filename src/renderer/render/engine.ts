/**
 * Preview engine (contract in ./types): WebGL compositing of the active timeline into the editor canvas,
 * pooled media elements for picture, Web Audio for sound, and an AudioContext-driven playback clock.
 */
import type { Doc } from '@core/ops/context'
import { mediaUrl } from '../../shared/api'
import { audioPieces, denoiseRefs, withDenoise } from './audioPlan'
import { Compositor, type Scene } from './compositor'
import { compositionFrames, type MediaMap } from './plan'
import { PreviewAudio } from './previewAudio'
import { PlaybackUrls, PreviewSources } from './previewSources'
import type { CreatePreviewEngine, PreviewEngine, PreviewEngineOptions, SeekOptions, Unsubscribe } from './types'
import type { RenderTarget } from './gl'

const PREROLL_SEC = 0.75
/** PreviewPlaybackRate.allowsAudioMetering is false from 4× up. */
const METER_MAX_RATE = 4

class Engine implements PreviewEngine {
  private readonly comp: Compositor
  private readonly urls: PlaybackUrls
  private readonly sources: PreviewSources
  private readonly audio: PreviewAudio
  private readonly frameCbs = new Set<(frame: number) => void>()
  private readonly playCbs = new Set<(playing: boolean) => void>()
  private readonly offline = new Set<string>()
  private doc: Doc | null = null
  private timelineId = ''
  private scene: Scene | null = null
  private media: MediaMap = {}
  private frame = 0
  private isPlaying = false
  private rate = 1
  private raf = 0
  private ticker: ReturnType<typeof setInterval> | null = null
  private dirty = false
  private emitPending = true
  private disposed = false
  private perfAnchor = { t: 0, frame: 0 }
  private audioKey: unknown[] = []
  private lastPresented: RenderTarget | null = null
  /** Denoise wet file per asset (null = not baked); absent = not resolved yet. */
  private readonly wet = new Map<string, string | null>()
  private readonly wetPending = new Set<string>()
  private readonly unsubWet: Unsubscribe | null

  constructor(private readonly opts: PreviewEngineOptions) {
    this.comp = new Compositor(opts.canvas, {
      readText: async (p) => {
        const r = await fetch(mediaUrl(p))
        if (!r.ok) throw new Error(`LUT ${p}: ${r.status}`)
        return r.text()
      },
      onInvalidate: () => this.requestRender(),
    })
    this.urls = new PlaybackUrls(opts.resolvePlaybackPath, (id, url) => {
      if (!url && !this.offline.has(id)) {
        this.offline.add(id)
        this.rebuildMedia()
      }
      this.audio.update()
      this.requestRender()
    })
    this.sources = new PreviewSources(this.urls, () => this.requestRender())
    this.audio = new PreviewAudio(this.urls)
    this.unsubWet =
      opts.enhancedAudio?.onChange((id) => {
        this.wet.delete(id)
        this.audioKey = []
        this.refreshAudio()
      }) ?? null
  }

  /** Resolves (once) the wet files the pieces want; a resolution re-runs `refreshAudio`. */
  private wetPathOf(id: string): string | null | undefined {
    const ea = this.opts.enhancedAudio
    if (!ea || this.offline.has(id)) return null
    if (this.wet.has(id)) return this.wet.get(id)
    if (!this.wetPending.has(id)) {
      this.wetPending.add(id)
      void ea
        .path(id)
        .catch(() => null)
        .then((p) => {
          this.wetPending.delete(id)
          if (this.disposed) return
          const before = this.wet.get(id)
          this.wet.set(id, p)
          if (p !== before) {
            this.audioKey = []
            this.refreshAudio()
          }
        })
    }
    return undefined
  }

  get playing(): boolean {
    return this.isPlaying
  }

  get currentFrame(): number {
    return this.frame
  }

  private timeline() {
    return this.doc?.file.timelines.find((t) => t.id === this.timelineId)
  }

  private totalFrames(): number {
    const tl = this.timeline()
    return tl ? compositionFrames(tl) : 0
  }

  setDocument(doc: Doc, timelineId: string): void {
    if (this.disposed) return
    const manifestChanged = this.doc?.manifest !== doc.manifest
    if (manifestChanged && this.doc) {
      const before = new Map(this.doc.manifest.entries.map((e) => [e.id, JSON.stringify(e.source)]))
      const changed = doc.manifest.entries.filter((e) => before.get(e.id) !== JSON.stringify(e.source)).map((e) => e.id)
      this.urls.invalidate(changed)
      for (const id of changed) this.offline.delete(id)
    }
    this.doc = doc
    this.timelineId = timelineId
    if (manifestChanged) this.rebuildMedia()
    else this.scene = { doc, timelineId, media: this.media }
    this.refreshAudio()
    this.requestRender()
  }

  private rebuildMedia(): void {
    if (!this.doc) return
    const media: MediaMap = {}
    for (const e of this.doc.manifest.entries) {
      const path = this.offline.has(e.id) ? null : this.opts.resolveOriginalPath(e.id)
      media[e.id] = { path, type: e.type, duration: e.duration, width: e.sourceWidth, height: e.sourceHeight, hasAudio: e.hasAudio }
    }
    this.media = media
    this.scene = { doc: this.doc, timelineId: this.timelineId, media }
    this.refreshAudio()
  }

  private refreshAudio(): void {
    const tl = this.timeline()
    if (!tl || !this.doc) return
    const key = [tl, this.doc.file.timelines, this.media]
    if (key.every((k, i) => k === this.audioKey[i])) return
    this.audioKey = key
    const media = this.media
    const pieces = audioPieces(tl, { fps: tl.fps, timelines: this.doc.file.timelines, media: (id) => media[id] })
    for (const id of denoiseRefs(pieces)) this.wetPathOf(id)
    this.audio.setPieces(withDenoise(pieces, (id) => this.wet.get(id)), tl.fps)
    if (this.isPlaying) this.audio.start(this.clockFrame())
  }

  get playbackRate(): number {
    return this.rate
  }

  seek(frame: number, opts?: SeekOptions): void {
    this.moveTo(frame)
    if (opts?.audible && !this.isPlaying) this.audio.grain(this.frame)
  }

  scrub(frame: number): void {
    this.moveTo(frame)
    if (!this.isPlaying) this.audio.grain(this.frame)
  }

  setOfflineLabel(show: boolean): void {
    if (this.comp.offlineLabel === show) return
    this.comp.offlineLabel = show
    this.requestRender()
  }

  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0 || rate === this.rate) return
    const r = Math.min(16, Math.max(0.1, rate))
    const f = this.isPlaying ? this.clockFrame() : this.frame
    this.rate = r
    this.sources.rate = r
    if (this.isPlaying) this.perfAnchor = { t: performance.now(), frame: f }
    this.audio.setRate(r, f)
    this.requestRender()
  }

  private moveTo(frame: number): void {
    if (!Number.isFinite(frame)) return
    const f = Math.max(0, Math.min(Math.round(frame), Math.max(0, this.totalFrames())))
    this.frame = f
    this.emitPending = true
    if (this.isPlaying) {
      this.perfAnchor = { t: performance.now(), frame: f }
      if (this.audio.running) this.audio.start(f)
    }
    this.requestRender()
  }

  play(): void {
    if (this.isPlaying || this.disposed) return
    const N = this.totalFrames()
    if (N <= 0) return
    if (this.frame >= N - 1) this.frame = 0
    this.isPlaying = true
    this.sources.playing = true
    this.perfAnchor = { t: performance.now(), frame: this.frame }
    void this.audio.resume().then(() => {
      if (this.isPlaying && this.audio.running) this.audio.start(this.clockFrame())
    })
    this.ticker = setInterval(() => this.audio.update(), 50)
    for (const cb of this.playCbs) cb(true)
    this.requestRender()
  }

  pause(): void {
    if (!this.isPlaying) return
    this.isPlaying = false
    this.sources.playing = false
    this.sources.pauseAll()
    this.audio.stop()
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.emitPending = true
    for (const cb of this.playCbs) cb(false)
    this.requestRender()
  }

  /** Playback position from the audio clock (wall clock until the AudioContext runs). */
  private clockFrame(): number {
    const a = this.audio.running ? this.audio.frameNow() : null
    if (a !== null) return a
    const tl = this.timeline()
    return this.perfAnchor.frame + ((performance.now() - this.perfAnchor.t) / 1000) * (tl?.fps ?? 30) * this.rate
  }

  onFrame(cb: (frame: number) => void): Unsubscribe {
    this.frameCbs.add(cb)
    return () => this.frameCbs.delete(cb)
  }

  onPlayStateChange(cb: (playing: boolean) => void): Unsubscribe {
    this.playCbs.add(cb)
    return () => this.playCbs.delete(cb)
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1
    const w = Math.max(1, Math.round((Number.isFinite(width) ? width : 1) * dpr))
    const h = Math.max(1, Math.round((Number.isFinite(height) ? height : 1) * dpr))
    const c = this.opts.canvas
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
      this.comp.gl.trimPool()
    }
    this.requestRender()
  }

  setVolume(linear: number): void {
    this.audio.setVolume(linear)
  }

  meter(): number[] {
    return this.rate >= METER_MAX_RATE ? [0, 0] : this.audio.meter()
  }

  private requestRender(): void {
    if (this.disposed) return
    this.dirty = true
    if (!this.raf) this.raf = requestAnimationFrame(this.loop)
  }

  private readonly loop = () => {
    this.raf = 0
    if (this.disposed) return
    if (this.isPlaying) {
      const N = this.totalFrames()
      const f = Math.floor(this.clockFrame() + 1e-6)
      if (f >= N) {
        this.frame = Math.max(0, N - 1)
        this.pause()
      } else if (f !== this.frame) {
        this.frame = Math.max(0, f)
        this.emitPending = true
        this.dirty = true
      }
      this.audio.update()
      // Redraw only for a new timeline frame or new source pixels (the display may refresh faster).
      if (this.dirty) this.draw()
      if (this.isPlaying) this.raf = requestAnimationFrame(this.loop)
      return
    }
    if (this.dirty) this.draw()
  }

  private lastError = ''

  private draw(): void {
    try {
      this.drawFrame()
    } catch (e) {
      // Keep the loop alive; report each distinct failure once.
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== this.lastError) console.error('Preview render failed:', e)
      this.lastError = msg
    }
  }

  private drawFrame(): void {
    this.dirty = false
    const tl = this.timeline()
    const scene = this.scene
    if (!tl || !scene || !(tl.width > 0 && tl.height > 0)) return
    const canvas = this.opts.canvas
    const bw = canvas.width
    const bh = canvas.height
    const k = Math.min(bw / tl.width, bh / tl.height)
    const vw = Math.max(1, Math.round(tl.width * k))
    const vh = Math.max(1, Math.round(tl.height * k))
    const viewport = { x: Math.floor((bw - vw) / 2), y: Math.floor((bh - vh) / 2), w: vw, h: vh }
    // Render at the on-screen size (never above the timeline size); text and transforms are canvas-relative.
    const rw = Math.min(vw, tl.width)
    const rh = Math.max(1, Math.round((rw * tl.height) / tl.width))
    const planner = this.comp.plannerFor(scene, true)
    const plan = planner.layersAt(tl, this.frame, rw, rh)
    this.sources.sync(plan, this.frame, tl.fps)
    if (this.isPlaying) {
      const ahead = this.frame + Math.round(PREROLL_SEC * tl.fps * this.rate)
      this.sources.preroll(planner.layersAt(tl, ahead, rw, rh), ahead, tl.fps)
    }
    const acc = this.comp.render(scene, this.frame, this.sources, rw, rh, { placeholders: true, reduce: true, out8: true })
    this.comp.present(acc, viewport)
    // Keep the presented frame for readPresentedRegion (chroma key sampler); release the one before it.
    if (this.lastPresented) this.comp.release(this.lastPresented)
    this.lastPresented = acc
    if (this.emitPending) {
      this.emitPending = this.isPlaying ? false : !this.sources.settled(plan)
      for (const cb of this.frameCbs) cb(this.frame)
    }
  }

  /** RGBA8 pixels of a region of the last presented frame; `pick` gets its size and returns the rect (rows from the top). */
  readPresentedRegion(pick: (width: number, height: number) => { x: number; y: number; w: number; h: number } | null): Uint8Array | null {
    const acc = this.lastPresented
    if (!acc || this.disposed) return null
    const r = pick(acc.width, acc.height)
    return r ? this.comp.readRegion(acc, r.x, r.y, r.w, r.h) : null
  }

  dispose(): void {
    if (this.disposed) return
    this.pause()
    this.disposed = true
    if (this.raf) cancelAnimationFrame(this.raf)
    this.sources.dispose()
    this.unsubWet?.()
    this.audio.dispose()
    this.comp.dispose()
    this.frameCbs.clear()
    this.playCbs.clear()
  }
}

export const createPreviewEngine: CreatePreviewEngine = (opts) => new Engine(opts)
