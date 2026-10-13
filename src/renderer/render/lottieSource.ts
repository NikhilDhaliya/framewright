/**
 * Lottie frame source (spec 07 §4.2): lottie-web's canvas renderer drawing straight into a canvas that the
 * compositor uploads as the layer texture. Shared by the preview, the render host (captures, export, thumbnails,
 * inspect_media frames) and the media preview tab.
 *
 * The light canvas build has no expression engine, like lottie-ios (and needs no `eval`).
 */
import type { AnimationConfigWithData, AnimationItem } from 'lottie-web'
import lottie from 'lottie-web/build/player/lottie_light_canvas'
import { lottieFrameIndex, lottieMeta, lottieRenderSize, type LottieJson, type LottieMeta } from '../../shared/lottie'
import type { FrameResult } from './compositor'
import type { MediaLayer } from './plan'

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas

/** Loading gives up after this long (fonts wait at most 5 s inside lottie-web). */
const LOAD_TIMEOUT_MS = 20_000
/** Frame versions: `instance serial · FRAME_SPAN + index`, unique per instance and frame. */
const FRAME_SPAN = 2 ** 24

let instanceSerial = 1

/**
 * Copy of the animation that lottie-web may mutate, with remote font URLs dropped: lottie-ios never downloads
 * fonts, and the editor must not reach the network for a media file. Embedded (data:) fonts are kept.
 */
function playable(data: LottieJson): LottieJson {
  const anim = structuredClone(data)
  const fonts = (anim.fonts as { list?: { fPath?: unknown }[] } | undefined)?.list
  if (Array.isArray(fonts)) for (const f of fonts) if (f && typeof f.fPath === 'string' && !f.fPath.startsWith('data:')) delete f.fPath
  if (!Array.isArray(anim.assets)) anim.assets = []
  return anim
}

/** One lottie-web animation rendering into its own canvas. */
export class LottieInstance {
  readonly meta: LottieMeta
  readonly width: number
  readonly height: number
  readonly canvas: AnyCanvas
  /** Resolves once images and fonts are ready and frames can be rendered; rejects on a broken animation. */
  readonly loaded: Promise<void>
  private readonly anim: AnimationItem
  private readonly serial = instanceSerial++
  /** Relative frame index currently drawn into the canvas (-1: none yet). */
  private shown = -1
  private destroyed = false

  /**
   * `size` defaults to the native comp size clamped to 4096 and made even (`lottieRenderSize`); the animation is
   * stretched to it (`preserveAspectRatio: 'none'`, the Mac's `.scaleToFill`). `canvas` defaults to an OffscreenCanvas.
   */
  constructor(data: LottieJson, size?: { width: number; height: number }, canvas?: HTMLCanvasElement) {
    this.meta = lottieMeta(data)
    const s = size ?? lottieRenderSize(this.meta.width, this.meta.height)
    this.width = s.width
    this.height = s.height
    this.canvas = canvas ?? new OffscreenCanvas(s.width, s.height)
    this.canvas.width = s.width
    this.canvas.height = s.height
    const context = this.canvas.getContext('2d') as CanvasRenderingContext2D | null
    if (!context) throw new Error('Lottie: no 2D canvas context')
    // No container: lottie-web draws into `context` only (the typings insist on a container element).
    const config = {
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      animationData: playable(data),
      rendererSettings: { context, clearCanvas: true, preserveAspectRatio: 'none' },
    } as unknown as AnimationConfigWithData<'canvas'>
    this.anim = lottie.loadAnimation(config)
    this.anim.setSubframe(false)
    this.loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Lottie: animation did not load')), LOAD_TIMEOUT_MS)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      if (this.anim.isLoaded) return done()
      this.anim.addEventListener('DOMLoaded', done)
      this.anim.addEventListener('error', () => {
        // Render-time errors leave the animation usable; only a failure before loading is fatal.
        if (this.anim.isLoaded) return
        clearTimeout(timer)
        reject(new Error('Lottie: invalid animation'))
      })
    })
    this.loaded.catch(() => undefined)
  }

  get isLoaded(): boolean {
    return !this.destroyed && this.anim.isLoaded
  }

  /** Relative frame index (0 = `ip`) shown at source second `srcSec`; the last frame holds forever. */
  index(srcSec: number): number {
    return lottieFrameIndex(srcSec, this.meta.fps, this.meta.frameCount)
  }

  /**
   * Draws relative frame `i` (clamped to the animation) unless it is already in the canvas; returns the version
   * identifying those pixels. lottie-web's `goToAndStop(i, true)` renders `firstFrame + i`, so `ip` is not added.
   */
  render(i: number): number {
    const idx = Math.min(this.meta.frameCount - 1, Math.max(0, Math.trunc(Number.isFinite(i) ? i : 0)))
    if (idx !== this.shown && this.isLoaded) {
      this.anim.goToAndStop(idx, true)
      this.shown = idx
    }
    return this.serial * FRAME_SPAN + idx
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.anim.destroy()
  }
}

/** Encodes a canvas as PNG, optionally composited over an opaque colour first. */
export async function canvasPng(src: AnyCanvas, background?: string | null): Promise<Uint8Array> {
  let canvas: OffscreenCanvas
  if (src instanceof OffscreenCanvas && !background) canvas = src
  else {
    canvas = new OffscreenCanvas(src.width, src.height)
    const ctx = canvas.getContext('2d')!
    if (background) {
      ctx.fillStyle = background
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    ctx.drawImage(src, 0, 0)
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

interface Entry {
  key: string
  state: 'loading' | 'ready' | 'failed'
  inst: LottieInstance | null
  promise: Promise<LottieInstance | null>
  used: number
}

/** Loads the animation JSON of a `.json` / `.lottie` file (dotLottie: first animation, images inlined). */
export type LottieLoader = (path: string) => Promise<LottieJson>

/**
 * One `LottieInstance` per media file (the canvas is re-rendered per clip at upload time, so clips sharing a file
 * at different frames still upload their own pixels). Bounded: instances not used by the current frame are
 * destroyed once more than `maxEntries` files or `maxPixels` canvas pixels are held.
 */
export class LottieSources {
  private readonly entries = new Map<string, Entry>()
  private tick = 0

  constructor(
    private readonly load: LottieLoader,
    private readonly onReady: () => void = () => undefined,
    private readonly maxEntries = 12,
    private readonly maxPixels = 48 * 1024 * 1024,
  ) {}

  /** Marks the start of a new frame: entries touched after this are kept by eviction. */
  nextFrame(): void {
    this.tick++
  }

  private entry(path: string, key: string): Entry {
    let e = this.entries.get(path)
    if (e && e.key !== key) {
      e.inst?.destroy()
      this.entries.delete(path)
      e = undefined
    }
    if (e) {
      e.used = this.tick
      return e
    }
    const created: Entry = { key, state: 'loading', inst: null, promise: Promise.resolve(null), used: this.tick }
    created.promise = (async () => {
      let inst: LottieInstance | null = null
      try {
        inst = new LottieInstance(await this.load(path))
        await inst.loaded
        if (this.entries.get(path) !== created) {
          inst.destroy()
          return null
        }
        created.inst = inst
        created.state = 'ready'
        return inst
      } catch (err) {
        inst?.destroy()
        console.warn(`Lottie ${path} failed`, err)
        created.state = 'failed'
        return null
      } finally {
        this.onReady()
      }
    })()
    this.entries.set(path, created)
    this.evict()
    return created
  }

  /** Loads (once) and resolves to the ready instance, or null when the file is missing or not a usable Lottie. */
  ensure(path: string, key = path): Promise<LottieInstance | null> {
    return this.entry(path, key).promise
  }

  get(path: string, key = path): LottieInstance | 'pending' | 'offline' {
    const e = this.entry(path, key)
    return e.state === 'ready' && e.inst ? e.inst : e.state === 'failed' ? 'offline' : 'pending'
  }

  /** Compositor frame for a Lottie layer at source second `t`. */
  frame(layer: MediaLayer, t: number, key?: string): FrameResult {
    const path = layer.info.path
    if (!path) return 'offline'
    const inst = this.get(path, key ?? path)
    if (typeof inst === 'string') return inst
    const version = inst.render(inst.index(t))
    return { source: inst.canvas, pixels: null, width: inst.width, height: inst.height, version }
  }

  private evict(): void {
    let pixels = 0
    for (const e of this.entries.values()) if (e.inst) pixels += e.inst.width * e.inst.height
    for (const [path, e] of [...this.entries].sort((a, b) => a[1].used - b[1].used)) {
      if (this.entries.size <= this.maxEntries && pixels <= this.maxPixels) break
      if (e.used >= this.tick || e.state === 'loading') continue
      if (e.inst) pixels -= e.inst.width * e.inst.height
      e.inst?.destroy()
      this.entries.delete(path)
    }
  }

  dispose(): void {
    for (const e of this.entries.values()) e.inst?.destroy()
    this.entries.clear()
  }
}
