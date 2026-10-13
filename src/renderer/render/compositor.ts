/**
 * WebGL2 frame compositor (spec 04 §2–§9): layer plan → per-layer crop → effects → edge rounding →
 * placement → opacity/blend over an opaque black accumulator. Shared by the preview and the render host.
 */
import { blurRadiusAt, cropAt, opacityAt, transformAt } from '@core/clip'
import { BLEND_MODES, isIdentityCrop, type BlendMode, type TextStyle, type Timeline } from '@core/model'
import type { Doc } from '@core/ops/context'
import { changesPixels, edgeRounding, gaussianEffect, hasNonBlurEffects, runEffects, TableCache, type EffectContext } from './effects/run'
import * as S from './effects/shaders'
import { ensureFonts, onFontsLoaded } from './fonts'
import { GL, type Program, type RenderTarget } from './gl'
import { LutCache } from './lut'
import { apply, IDENTITY, invert, mul, rotateAbout, scale, squareToQuad, tiltProject, toGL, translate, type Mat3, type Pt } from './mat3'
import { canvasToSource, Planner, sourceTimeSec, workScale, type GroupLayer, type LayerPlan, type MediaLayer, type MediaMap, type TextLayer } from './plan'
import { textRaster, type Rect, type TextRaster } from './text'
import { planeSpecs, yuvConversion, type YuvPlanes } from './yuv'

/** Decoded source pixels for a media layer (straight alpha, top row first). */
export interface SourceFrame {
  /** Video element, ImageBitmap or canvas; `yuv`, then `pixels` are used when null. */
  source: TexImageSource | null
  pixels: Uint8Array | null
  /** CPU Y'CbCr planes (preview video), converted to RGBA on upload. */
  yuv?: YuvPlanes | null
  width: number
  height: number
  /** Changes whenever the pixels change; NaN re-uploads every render. */
  version: number
}

export type FrameResult = SourceFrame | 'pending' | 'offline'

export interface FrameProvider {
  frame(layer: MediaLayer, timeSec: number): FrameResult
}

export interface Scene {
  doc: Doc
  timelineId: string
  media: MediaMap
}

export interface CompositorOptions {
  /** Reads a LUT (.cube) file. */
  readText(path: string): Promise<string>
  /** Async resources (LUTs, fonts) became ready: the caller should re-render. */
  onInvalidate?(): void
}

export interface RenderOptions {
  /** Preview: draw "Media Offline" / not-ready placeholders instead of dropping layers. */
  placeholders?: boolean
  /** Preview: process media at the size it is displayed (§12) instead of source resolution. */
  reduce?: boolean
  /** The result is only read as clamped 8-bit pixels: the top normal layer may write an RGBA8 target directly. */
  out8?: boolean
}

interface CachedTexture {
  /** Current RGBA texture: `own`, or the YUV conversion target. */
  texture: WebGLTexture
  own: WebGLTexture
  ownSize: string
  yuv: { planes: WebGLTexture[]; sizes: string[]; target: RenderTarget } | null
  width: number
  height: number
  version: number
  used: number
}

/** Layer sampling hits texel centres exactly (unscaled, unrotated, whole-pixel offset). */
const isAligned = (m: Float32Array, origin: readonly [number, number], projective: boolean, layerScale: number) =>
  !projective && layerScale === 1 && m[0] === 1 && m[4] === 1 && m[1] === 0 && m[3] === 0 && Number.isInteger(m[6] - origin[0]) && Number.isInteger(m[7] - origin[1])

const withDefines = (source: string, ...defs: string[]) => source.replace('\n', `\n${defs.filter(Boolean).map((d) => `#define ${d}\n`).join('')}`)

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
const blendIndex = (m: BlendMode | undefined) => Math.max(0, BLEND_MODES.indexOf(m ?? 'normal'))
const DIFFERENCE = BLEND_MODES.indexOf('difference')
const TEXT_CACHE_LIMIT = 64
const TEXT_CACHE_PIXELS = 64 * 1024 * 1024

export class Compositor {
  readonly gl: GL
  private readonly fx: EffectContext
  private readonly sources = new Map<string, CachedTexture>()
  private readonly texts = new Map<string, CachedTexture>()
  private textPixels = 0
  private renderCount = 0
  private planner: { key: unknown[]; planner: Planner } | null = null
  private placeholderTex = new Map<string, CachedTexture>()
  /** Preview: draw the "Media Offline" text on offline placeholders (off while the UI's offline panel covers it). */
  offlineLabel = true
  private readonly matBuf = new Float32Array(9)
  private provider: FrameProvider | null = null
  private readonly packBuffers: { buffer: WebGLBuffer; size: number }[] = []
  /** Accumulator that is logically opaque black but not cleared yet: its first normal layer overwrites it. */
  private blank: RenderTarget | null = null
  /** Top-level accumulator whose next normal layer is the last one and may write the 8-bit output instead. */
  private final: RenderTarget | null = null
  /** Preview: layers are resampled with hardware bilinear filtering (§5.6 allows preview approximations). */
  private fastFilter = false
  private readonly offFonts: () => void

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, private readonly opts: CompositorOptions) {
    this.gl = new GL(canvas)
    this.fx = { gl: this.gl, luts: new LutCache(this.gl.gl, opts.readText, () => opts.onInvalidate?.()), tables: new TableCache(this.gl) }
    this.offFonts = onFontsLoaded(() => {
      this.clearTextCache()
      opts.onInvalidate?.()
    })
  }

  plannerFor(scene: Scene, placeholders: boolean): Planner {
    const key = [scene.doc.file.timelines, scene.media, placeholders]
    const p = this.planner
    if (p && p.key.every((k, i) => k === key[i])) return p.planner
    const tl = scene.doc.file.timelines.find((t) => t.id === scene.timelineId)
    const planner = new Planner({
      fps: tl?.fps ?? 30,
      timelines: scene.doc.file.timelines,
      media: (id) => scene.media[id],
      offlinePlaceholders: placeholders,
    })
    this.planner = { key, planner }
    return planner
  }

  /** Loads LUTs and fonts a document needs so the next render is complete (export, capture). */
  async prepare(doc: Doc): Promise<void> {
    const luts = new Set<string>()
    const styles: TextStyle[] = []
    for (const tl of doc.file.timelines)
      for (const tr of tl.tracks)
        for (const c of tr.clips) {
          for (const e of c.effects ?? []) if (e.type === 'color.lut' && e.params.path?.string) luts.add(e.params.path.string)
          if (c.mediaType === 'text' && c.textStyle) styles.push(c.textStyle)
        }
    await Promise.all([...[...luts].map((p) => this.fx.luts.load(p)), ensureFonts(styles.length ? styles : [{ fontName: 'Inter', isBold: false, isItalic: false }])])
  }

  /** Composites timeline frame `frame` at `W × H`. The caller releases the returned accumulator. */
  render(scene: Scene, frame: number, provider: FrameProvider, W: number, H: number, ro: RenderOptions = {}): RenderTarget {
    this.provider = provider
    this.fastFilter = !!ro.reduce
    try {
      return this.renderFrame(scene, frame, W, H, ro)
    } finally {
      this.provider = null
    }
  }

  private renderFrame(scene: Scene, frame: number, W: number, H: number, ro: RenderOptions): RenderTarget {
    const tl = scene.doc.file.timelines.find((t) => t.id === scene.timelineId)
    this.renderCount++
    const g = this.gl
    const gl = g.gl
    gl.disable(gl.BLEND)
    gl.disable(gl.SCISSOR_TEST)
    const w = Math.max(1, Math.round(W))
    const h = Math.max(1, Math.round(H))
    if (!tl) {
      const acc = g.acquire(w, h)
      g.clear(acc, 0, 0, 0, 1)
      return acc
    }
    const planner = this.plannerFor(scene, !!ro.placeholders)
    const layers = planner.layersAt(tl, frame, w, h)
    const acc = this.composite(layers, frame, w, h, tl, ro, !!ro.out8)
    this.evictSources()
    return acc
  }

  private composite(layers: LayerPlan[], f: number, W: number, H: number, tl: Timeline, ro: RenderOptions, out8 = false): RenderTarget {
    const outer = [this.blank, this.final] as const
    let acc = this.gl.acquire(W, H)
    this.blank = acc
    try {
      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i]
        this.final = out8 && i === layers.length - 1 ? acc : null
        if (layer.kind === 'text') acc = this.drawText(layer, acc, f, W, H)
        else acc = this.drawVisual(layer, acc, f, W, H, tl, ro)
      }
      this.settle(acc)
      return acc
    } finally {
      ;[this.blank, this.final] = outer
    }
  }

  /** Clears a still-blank accumulator before anything reads it or blends into it. */
  private settle(acc: RenderTarget): void {
    if (this.blank !== acc) return
    this.blank = null
    this.gl.clear(acc, 0, 0, 0, 1)
  }

  private drawVisual(layer: MediaLayer | GroupLayer, acc: RenderTarget, f: number, W: number, H: number, tl: Timeline, ro: RenderOptions): RenderTarget {
    const g = this.gl
    const clip = layer.clip
    const alpha = clamp01(opacityAt(clip, f))
    if (alpha <= 0) return acc
    const t = transformAt(clip, f)
    let srcTex: WebGLTexture
    let srcW: number
    let srcH: number
    let natW: number
    let natH: number
    let k = 1
    let owned: RenderTarget | null = null
    if (layer.kind === 'group') {
      natW = layer.canvasW
      natH = layer.canvasH
      if (ro.reduce) k = workScale(t, natW, natH, W, H)
      const [gw, gh] = this.workSize(natW, natH, k)
      owned = this.composite(layer.children, f, gw, gh, tl, ro)
      srcTex = owned.texture
      srcW = owned.width
      srcH = owned.height
    } else {
      // Preview: Y'CbCr frames are converted straight at the work size when the clip's natural size is known.
      const want = ro.reduce && layer.natW > 0 && layer.natH > 0 ? this.workSize(layer.natW, layer.natH, workScale(t, layer.natW, layer.natH, W, H)) : null
      const src = this.mediaTexture(layer, f, tl.fps, !!ro.placeholders, want)
      if (!src) return acc
      srcTex = src.texture
      srcW = src.width
      srcH = src.height
      natW = layer.natW || src.width
      natH = layer.natH || src.height
      if (ro.reduce) k = workScale(t, natW, natH, W, H)
    }
    if (!(natW > 0 && natH > 0)) {
      g.release(owned)
      return acc
    }
    const crop = cropAt(clip, f)
    let cx = 0
    let cy = 0
    let cw = natW
    let ch = natH
    if (!isIdentityCrop(crop)) {
      cx = Math.round(crop.left * natW)
      cy = Math.round(crop.top * natH)
      cw = Math.round(Math.max(1, (1 - crop.left - crop.right) * natW))
      ch = Math.round(Math.max(1, (1 - crop.top - crop.bottom) * natH))
    }
    const m = canvasToSource(t, natW, natH, W, H, this.matBuf)
    const [ww, wh] = this.workSize(natW, natH, k)
    if (srcW === ww && srcH === wh && cw === natW && ch === natH && !changesPixels(clip.effects, clip.edgeRounding, clip.edgeSoftness)) {
      // Nothing to crop or process and the source is already at the work size: place it directly.
      if (m) acc = this.place(acc, { texture: srcTex, width: srcW, height: srcH }, [0, 0], m, false, blendIndex(clip.blendMode), alpha, 1, 1, false, W, H, k)
      g.release(owned)
      return acc
    }
    let work = g.acquire(Math.max(1, Math.round(cw * k)), Math.max(1, Math.round(ch * k)))
    const copy = g.program('cropCopy', S.CROP_COPY)
    g.use(copy)
    g.bindTexture(copy, 'uTex', 0, srcTex)
    g.f2(copy, 'uOrigin', cx, cy)
    g.f2(copy, 'uNat', natW, natH)
    g.f1(copy, 'uScale', k)
    g.draw(work)
    g.release(owned)
    work = runEffects(this.fx, work, clip.effects, f - clip.startFrame, 1, [cx * k, cy * k], false, k)
    work = edgeRounding(this.fx, work, clip.edgeRounding, clip.edgeSoftness)
    if (m) acc = this.place(acc, work, [cx, cy], m, false, blendIndex(clip.blendMode), alpha, 1, 1, false, W, H, k)
    g.release(work)
    return acc
  }

  private workSize(natW: number, natH: number, k: number): [number, number] {
    return [Math.max(1, Math.round(natW * k)), Math.max(1, Math.round(natH * k))]
  }

  /** Source texture for a media layer; without placeholders (export) unavailable sources are absent (§11.5). */
  private mediaTexture(layer: MediaLayer, f: number, fps: number, placeholders: boolean, want: [number, number] | null): CachedTexture | null {
    if (layer.offline) return placeholders ? this.placeholder('offline') : null
    const t = sourceTimeSec(layer.clip, f, fps, layer.timing)
    if (t === null) return null
    const res = this.provider ? this.provider.frame(layer, t) : 'pending'
    if (res === 'offline') return placeholders ? this.placeholder('offline') : null
    if (res === 'pending') {
      if (!placeholders) return null
      // Keep the clip's last good frame on screen while a new one decodes (scrubs, re-seeks).
      const last = this.sources.get(layer.clip.id)
      if (last && last.width > 0) {
        last.used = this.renderCount
        return last
      }
      return this.placeholder('pending')
    }
    return this.upload(this.sources, layer.clip.id, res, want)
  }


  /** Uploads a frame; Y'CbCr frames are converted at `want` (capped at the frame size) when given. */
  private upload(cache: Map<string, CachedTexture>, key: string, frame: SourceFrame, want: [number, number] | null = null): CachedTexture {
    const gl = this.gl.gl
    let c = cache.get(key)
    if (!c) {
      const own = this.gl.createTexture()
      c = { texture: own, own, ownSize: '', yuv: null, width: 0, height: 0, version: NaN, used: 0 }
      cache.set(key, c)
    }
    c.used = this.renderCount
    const scaled = !!frame.yuv && !!want
    const w = scaled ? Math.min(frame.width, want![0]) : frame.width
    const h = scaled ? Math.min(frame.height, want![1]) : frame.height
    if (c.version === frame.version && c.width === w && c.height === h) return c
    if (frame.yuv) this.uploadYuv(c, frame.yuv, w, h)
    else {
      if (c.yuv) this.freeYuv(c)
      gl.bindTexture(gl.TEXTURE_2D, c.own)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      const size = `${frame.width}x${frame.height}`
      const sameSize = c.ownSize === size
      if (frame.source) {
        if (sameSize) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.source)
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame.source)
      } else if (frame.pixels) {
        if (sameSize) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.width, frame.height, gl.RGBA, gl.UNSIGNED_BYTE, frame.pixels)
        else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, frame.width, frame.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame.pixels)
      }
      c.ownSize = size
      c.texture = c.own
    }
    c.width = w
    c.height = h
    c.version = frame.version
    return c
  }

  /** Uploads Y'CbCr planes and converts them into the entry's RGBA8 target of `w × h` (§7.2). */
  private uploadYuv(c: CachedTexture, y: YuvPlanes, w: number, h: number): void {
    const g = this.gl
    const gl = g.gl
    const specs = planeSpecs(y.format, y.width, y.height)
    let st = c.yuv
    if (st && (st.target.width !== w || st.target.height !== h)) {
      g.release(st.target)
      st.target = g.acquire8(w, h)
    }
    if (!st) st = c.yuv = { planes: [], sizes: [], target: g.acquire8(w, h) }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    specs.forEach((p, i) => {
      const t = (st.planes[i] ??= g.createTexture())
      const { offset, stride } = y.layout[i]
      const view = y.data.subarray(offset, offset + stride * (p.height - 1) + p.width * p.channels)
      const format = p.channels === 2 ? gl.RG : gl.RED
      const size = `${p.width}x${p.height}x${p.channels}`
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, stride / p.channels)
      if (st.sizes[i] === size) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.width, p.height, format, gl.UNSIGNED_BYTE, view)
      else gl.texImage2D(gl.TEXTURE_2D, 0, p.channels === 2 ? gl.RG8 : gl.R8, p.width, p.height, 0, format, gl.UNSIGNED_BYTE, view)
      st.sizes[i] = size
    })
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    const conv = yuvConversion(y.matrix, y.fullRange, y.height)
    const reduced = w !== y.width || h !== y.height
    const p = reduced ? (g.cached('yuvToRgb:scaled') ?? g.program('yuvToRgb:scaled', withDefines(S.YUV_TO_RGB, 'SCALED'))) : g.program('yuvToRgb', S.YUV_TO_RGB)
    g.use(p)
    g.bindTexture(p, 'uY', 0, st.planes[0])
    g.bindTexture(p, 'uCb', 1, st.planes[1])
    g.bindTexture(p, 'uCr', 2, st.planes[specs.length > 2 ? 2 : 1])
    g.bindTexture(p, 'uA', 3, st.planes[specs.length > 3 ? 3 : 0])
    g.intUniform(p, 'uInterleaved', y.format === 'NV12' ? 1 : 0)
    g.intUniform(p, 'uAlpha', specs.length > 3 ? 1 : 0)
    g.f2(p, 'uSize', w, h)
    g.mat3(p, 'uM', conv.m)
    g.f3(p, 'uOffset', conv.offset[0], conv.offset[1], conv.offset[2])
    g.draw(st.target)
    c.texture = st.target.texture
  }

  private freeYuv(c: CachedTexture): void {
    if (!c.yuv) return
    this.gl.release(c.yuv.target)
    for (const t of c.yuv.planes) this.gl.gl.deleteTexture(t)
    c.yuv = null
    c.texture = c.own
  }

  private freeCached(c: CachedTexture): void {
    this.freeYuv(c)
    this.gl.gl.deleteTexture(c.own)
  }

  private evictSources(): void {
    for (const [k, c] of this.sources) {
      if (this.renderCount - c.used > 90) {
        this.freeCached(c)
        this.sources.delete(k)
      }
    }
  }

  private placeholder(kind: 'offline' | 'pending'): CachedTexture {
    const key = kind === 'offline' && !this.offlineLabel ? 'offline-bare' : kind
    const hit = this.placeholderTex.get(key)
    if (hit) return hit
    const w = 480
    const h = 270
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')!
    if (kind === 'pending') {
      for (let y = 0; y < h; y += 15) for (let x = 0; x < w; x += 15) {
        ctx.fillStyle = ((x + y) / 15) % 2 === 0 ? '#1c1c1e' : '#26262a'
        ctx.fillRect(x, y, 15, 15)
      }
    } else {
      ctx.fillStyle = '#3a1416'
      ctx.fillRect(0, 0, w, h)
      ctx.fillStyle = '#ffffffcc'
      ctx.font = '600 30px Inter, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      if (key === 'offline') ctx.fillText('Media Offline', w / 2, h / 2)
    }
    const tex = this.upload(this.placeholderTex, key, { source: canvas, pixels: null, width: w, height: h, version: 1 })
    return tex
  }

  private textTexture(r: TextRaster): CachedTexture {
    const hit = this.texts.get(r.key)
    if (hit) {
      this.texts.delete(r.key)
      this.texts.set(r.key, hit)
      hit.used = this.renderCount
      return hit
    }
    const canvas = r.draw()
    const c = this.upload(new Map(), r.key, { source: canvas, pixels: null, width: r.rect.w, height: r.rect.h, version: 1 })
    this.texts.set(r.key, c)
    this.textPixels += c.width * c.height
    while (this.texts.size > TEXT_CACHE_LIMIT || (this.textPixels > TEXT_CACHE_PIXELS && this.texts.size > 1)) {
      const [k, old] = this.texts.entries().next().value as [string, CachedTexture]
      this.freeCached(old)
      this.textPixels -= old.width * old.height
      this.texts.delete(k)
    }
    return c
  }

  private clearTextCache(): void {
    for (const c of this.texts.values()) this.freeCached(c)
    this.texts.clear()
    this.textPixels = 0
  }

  /** Canvas → layer-px sampling map for a text layer: rotation or tilt about the clip centre, entrance undone. */
  private textMap(layerRect: Rect, entrance: Mat3, t: ReturnType<typeof transformAt>, W: number, H: number): { m: Mat3; projective: boolean; origin: [number, number] } | null {
    const P: Pt = { x: t.centerX * W, y: t.centerY * H }
    if (t.rotationX !== 0 || t.rotationY !== 0) {
      const corners = [
        [layerRect.x, layerRect.y],
        [layerRect.x + layerRect.w, layerRect.y],
        [layerRect.x + layerRect.w, layerRect.y + layerRect.h],
        [layerRect.x, layerRect.y + layerRect.h],
      ].map(([x, y]) => {
        const [ex, ey, ew] = apply(entrance, x, y)
        return tiltProject({ x: ex / ew, y: ey / ew }, P, t, W, H)
      }) as [Pt, Pt, Pt, Pt]
      const fwd = mul(squareToQuad(corners), scale(1 / layerRect.w, 1 / layerRect.h))
      const inv = invert(fwd)
      return inv ? { m: inv, projective: true, origin: [0, 0] } : null
    }
    const fwd = mul(rotateAbout(t.rotation, P.x, P.y), entrance)
    const inv = invert(fwd)
    return inv ? { m: inv, projective: false, origin: [layerRect.x, layerRect.y] } : null
  }

  private entranceMatrix(r: TextRaster, H: number): Mat3 {
    const e = r.entrance
    if (!e || (e.scale === 1 && e.dy === 0)) return IDENTITY
    const cx = r.box.x + r.box.w / 2
    const cy = r.box.y + r.box.h / 2
    return [e.scale, 0, cx - e.scale * cx, 0, e.scale, cy - e.scale * cy + e.scale * e.dy * H, 0, 0, 1]
  }

  private drawText(layer: TextLayer, acc: RenderTarget, f: number, W: number, H: number): RenderTarget {
    const clip = layer.clip
    const alpha = clamp01(opacityAt(clip, f))
    if (alpha <= 0) return acc
    if (clip.textFillMode === 'footage') return this.drawFootage(layer, acc, f, W, H, alpha)
    const inverted = clip.textFillMode === 'inverted'
    const raster = textRaster(clip, f, W, H, inverted ? 'inverted' : 'normal')
    if (!raster) return acc
    const tex = this.textTexture(raster)
    const t = transformAt(clip, f)
    const k = raster.entrance ? raster.entrance.opacity : 1
    let entrance = this.entranceMatrix(raster, H)
    const blur = blurRadiusAt(clip, f)
    const spatial = H / 1080
    let layerTex = tex.texture
    let layerRect: Rect = raster.rect
    let mulRgb = k
    let mulA = k
    let work: RenderTarget | null = null
    if (blur > 0 || hasNonBlurEffects(clip.effects)) {
      // Effects run on canvas ∪ (entrance-transformed) raster, in canvas px (§9.10).
      const ext = this.textExtent(raster.rect, entrance, W, H)
      work = this.resample(tex, raster.rect, entrance, ext, k)
      if (Number.isFinite(blur)) work = gaussianEffect(this.fx, work, Math.min(100, Math.max(0, blur)) * spatial)
      work = runEffects(this.fx, work, clip.effects, f - clip.startFrame, spatial, [ext.x, ext.y], true)
      layerTex = work.texture
      layerRect = ext
      entrance = IDENTITY
      mulRgb = 1
      mulA = 1
    }
    const map = this.textMap(layerRect, entrance, t, W, H)
    if (map) {
      toGL(map.m, this.matBuf)
      const mode = inverted ? DIFFERENCE : blendIndex(clip.blendMode)
      acc = this.place(acc, { texture: layerTex, width: layerRect.w, height: layerRect.h }, map.origin, this.matBuf, map.projective, mode, alpha, mulRgb, mulA, inverted, W, H)
    }
    this.gl.release(work)
    return acc
  }

  private textExtent(rect: Rect, entrance: Mat3, W: number, H: number): Rect {
    let x0 = 0
    let y0 = 0
    let x1 = W
    let y1 = H
    for (const [x, y] of [
      [rect.x, rect.y],
      [rect.x + rect.w, rect.y],
      [rect.x, rect.y + rect.h],
      [rect.x + rect.w, rect.y + rect.h],
    ]) {
      const [px, py] = apply(entrance, x, y)
      x0 = Math.min(x0, px)
      y0 = Math.min(y0, py)
      x1 = Math.max(x1, px)
      y1 = Math.max(y1, py)
    }
    x0 = Math.floor(x0)
    y0 = Math.floor(y0)
    return { x: x0, y: y0, w: Math.ceil(x1) - x0, h: Math.ceil(y1) - y0 }
  }

  /** Draws a raster (with its entrance transform and k-scaled colour) into a straight-alpha working image. */
  private resample(tex: CachedTexture, rect: Rect, entrance: Mat3, ext: Rect, k: number): RenderTarget {
    const g = this.gl
    const out = g.acquire(ext.w, ext.h)
    const inv = invert(entrance) ?? IDENTITY
    const p = g.program('resample', S.RESAMPLE)
    g.use(p)
    this.layerUniforms(p, tex.texture, rect.w, rect.h, [rect.x, rect.y], toGL(mul(inv, translate(ext.x, ext.y)), this.matBuf), false, 1, k, k, false)
    g.draw(out)
    return out
  }

  private drawFootage(layer: TextLayer, acc: RenderTarget, f: number, W: number, H: number, alpha: number): RenderTarget {
    const g = this.gl
    const clip = layer.clip
    const raster = textRaster(clip, f, W, H, 'mask')
    if (!raster) return acc
    const tex = this.textTexture(raster)
    const t = transformAt(clip, f)
    const k = raster.entrance ? raster.entrance.opacity : 1
    const map = this.textMap(raster.rect, this.entranceMatrix(raster, H), t, W, H)
    if (!map) return acc
    this.settle(acc)
    let stencil = g.acquire(W, H)
    const p = g.program('footage', S.FOOTAGE_STENCIL)
    g.use(p)
    this.layerUniforms(p, tex.texture, raster.rect.w, raster.rect.h, map.origin, toGL(map.m, this.matBuf), map.projective, 1, k, k, false)
    g.bindTexture(p, 'uBackdrop', 1, acc.texture)
    const c = clip.textStyle?.color ?? { r: 0, g: 0, b: 0, a: 1 }
    g.f4(p, 'uMatte', c.r, c.g, c.b, clamp01(c.a))
    g.draw(stencil)
    const spatial = H / 1080
    const blur = blurRadiusAt(clip, f)
    if (blur > 0 || hasNonBlurEffects(clip.effects)) {
      if (Number.isFinite(blur)) stencil = gaussianEffect(this.fx, stencil, Math.min(100, Math.max(0, blur)) * spatial)
      stencil = runEffects(this.fx, stencil, clip.effects, f - clip.startFrame, spatial, [0, 0], true)
    }
    if (alpha >= 1) {
      g.release(acc)
      return stencil
    }
    const out = g.acquire(W, H)
    const d = g.program('dissolve', S.DISSOLVE)
    g.use(d)
    g.bindTexture(d, 'uA', 0, acc.texture)
    g.bindTexture(d, 'uB', 1, stencil.texture)
    g.f1(d, 'uT', alpha)
    g.draw(out)
    g.release(acc)
    g.release(stencil)
    return out
  }

  private layerUniforms(p: Program, tex: WebGLTexture, w: number, h: number, origin: readonly [number, number], m: Float32Array, projective: boolean, opacity: number, mulRgb: number, mulA: number, alphaAsColor: boolean, layerScale = 1): void {
    const g = this.gl
    g.bindTexture(p, 'uLayer', 0, tex)
    g.f2(p, 'uLayerSize', w, h)
    g.f2(p, 'uCropOrigin', origin[0], origin[1])
    g.mat3(p, 'uCanvasToSource', m)
    g.intUniform(p, 'uProjective', projective ? 1 : 0)
    g.f1(p, 'uOpacity', opacity)
    g.f2(p, 'uMul', mulRgb, mulA)
    g.intUniform(p, 'uAlphaAsColor', alphaAsColor ? 1 : 0)
    g.f1(p, 'uLayerScale', layerScale)
  }

  /**
   * Composites a straight-alpha layer onto the accumulator (§5.5–§6.4). Returns the new accumulator: a still-blank
   * one is overwritten instead of cleared and blended, and the last layer of an `out8` render writes the clamped
   * RGBA8 output. `layerScale` = layer px per source px (reduced preview work, §12).
   */
  private place(acc: RenderTarget, layer: { texture: WebGLTexture; width: number; height: number }, origin: readonly [number, number], m: Float32Array, projective: boolean, mode: number, opacity: number, mulRgb: number, mulA: number, alphaAsColor: boolean, W: number, H: number, layerScale = 1): RenderTarget {
    const g = this.gl
    const gl = g.gl
    const filter = isAligned(m, origin, projective, layerScale) ? 'ALIGNED' : this.fastFilter ? 'HW_FILTER' : ''
    if (mode === 0) {
      const bbox = this.bbox(m, { width: layer.width / layerScale, height: layer.height / layerScale }, origin, projective, W, H)
      if (!bbox) return acc
      if (this.final === acc) {
        const black = this.blank === acc
        this.final = this.blank = null
        const out = g.acquire8(W, H)
        const p = this.placeProgram('placeOut8', S.PLACE_OUT8, filter, black ? 'OVER_BLACK' : '')
        g.use(p)
        this.layerUniforms(p, layer.texture, layer.width, layer.height, origin, m, projective, opacity, mulRgb, mulA, alphaAsColor, layerScale)
        if (!black) g.bindTexture(p, 'uBackdrop', 1, acc.texture)
        g.draw(out)
        g.release(acc)
        return out
      }
      if (this.blank === acc) {
        this.blank = null
        const p = this.placeProgram('placeFirst', S.PLACE_FIRST, filter)
        g.use(p)
        this.layerUniforms(p, layer.texture, layer.width, layer.height, origin, m, projective, opacity, mulRgb, mulA, alphaAsColor, layerScale)
        g.draw(acc)
        return acc
      }
      const p = this.placeProgram('placeNormal', S.PLACE_NORMAL, filter)
      g.use(p)
      this.layerUniforms(p, layer.texture, layer.width, layer.height, origin, m, projective, opacity, mulRgb, mulA, alphaAsColor, layerScale)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.enable(gl.SCISSOR_TEST)
      gl.scissor(bbox[0], bbox[1], bbox[2], bbox[3])
      g.draw(acc)
      gl.disable(gl.SCISSOR_TEST)
      gl.disable(gl.BLEND)
      return acc
    }
    this.settle(acc)
    const out = g.acquire(W, H)
    const p = this.placeProgram('placeBlend', S.PLACE_BLEND, filter)
    g.use(p)
    this.layerUniforms(p, layer.texture, layer.width, layer.height, origin, m, projective, opacity, mulRgb, mulA, alphaAsColor, layerScale)
    g.bindTexture(p, 'uBackdrop', 1, acc.texture)
    g.intUniform(p, 'uMode', mode)
    g.draw(out)
    g.release(acc)
    return out
  }

  /** A place shader compiled with up to two `#define`s (sampling mode; OVER_BLACK for PLACE_OUT8). */
  private placeProgram(key: string, source: string, def1: string, def2 = ''): Program {
    const id = `${key}:${def1}:${def2}`
    return this.gl.cached(id) ?? this.gl.program(id, withDefines(source, def1, def2))
  }

  /** Scissor box (x, y, w, h) covering the placed layer, or null when it misses the canvas. */
  private bbox(m: Float32Array, layer: { width: number; height: number }, origin: readonly [number, number], projective: boolean, W: number, H: number): [number, number, number, number] | null {
    const rowMajor: Mat3 = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]
    const fwd = invert(rowMajor)
    if (!fwd) return null
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [lx, ly] of [
      [0, 0],
      [layer.width, 0],
      [0, layer.height],
      [layer.width, layer.height],
    ]) {
      const [x, y, w] = apply(fwd, lx + origin[0], ly + origin[1])
      if (projective && !(w > 0)) return [0, 0, W, H]
      const px = projective ? x / w : x
      const py = projective ? y / w : y
      x0 = Math.min(x0, px)
      y0 = Math.min(y0, py)
      x1 = Math.max(x1, px)
      y1 = Math.max(y1, py)
    }
    const bx0 = Math.max(0, Math.floor(x0) - 2)
    const by0 = Math.max(0, Math.floor(y0) - 2)
    const bx1 = Math.min(W, Math.ceil(x1) + 2)
    const by1 = Math.min(H, Math.ceil(y1) + 2)
    if (!(bx1 > bx0 && by1 > by0)) return null
    return [bx0, by0, bx1 - bx0, by1 - by0]
  }

  /**
   * Clamped RGBA8 pixels of an accumulator, top row first, read through a pixel-pack buffer and a fence: the
   * event loop keeps running (decoder pipes keep flowing, the next frame can be issued) while the GPU finishes
   * the frame. The accumulator may be released as soon as this is called.
   */
  async readPixelsAsync(acc: RenderTarget, out?: Uint8Array): Promise<Uint8Array> {
    const g = this.gl
    const gl = g.gl
    const size = acc.width * acc.height * 4
    // An 8-bit accumulator (out8) already holds the clamped output.
    const t8 = acc.float ? g.acquire8(acc.width, acc.height) : acc
    if (t8 !== acc) {
      const p = g.program('toRgba8', S.TO_RGBA8)
      g.use(p)
      g.bindTexture(p, 'uSrc', 0, acc.texture)
      g.draw(t8)
    }
    const i = this.packBuffers.findIndex((b) => b.size === size)
    const pbo = i >= 0 ? this.packBuffers.splice(i, 1)[0] : { buffer: gl.createBuffer()!, size }
    if (i < 0) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.buffer)
      gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, t8.framebuffer)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.buffer)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    gl.readPixels(0, 0, acc.width, acc.height, gl.RGBA, gl.UNSIGNED_BYTE, 0)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (t8 !== acc) g.release(t8)
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
    try {
      while (sync) {
        const s = gl.clientWaitSync(sync, 0, 0)
        if (s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED || s === gl.WAIT_FAILED) break
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const buf = out && out.length >= size ? out : new Uint8Array(size)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo.buffer)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, buf, 0, size)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      return buf
    } finally {
      if (sync) gl.deleteSync(sync)
      this.packBuffers.push(pbo)
      while (this.packBuffers.length > 4) gl.deleteBuffer(this.packBuffers.shift()!.buffer)
    }
  }

  /**
   * Synchronous RGBA8 read of a small region of an accumulator (rows counted from the top, like readPixelsAsync).
   * Used by the chroma key sampler on the last presented preview frame (spec 07 §6.6).
   */
  readRegion(acc: RenderTarget, x: number, y: number, w: number, h: number): Uint8Array {
    const g = this.gl
    const gl = g.gl
    const t8 = acc.float ? g.acquire8(acc.width, acc.height) : acc
    if (t8 !== acc) {
      const p = g.program('toRgba8', S.TO_RGBA8)
      g.use(p)
      g.bindTexture(p, 'uSrc', 0, acc.texture)
      g.draw(t8)
    }
    const out = new Uint8Array(w * h * 4)
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
    gl.bindFramebuffer(gl.FRAMEBUFFER, t8.framebuffer)
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1)
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (t8 !== acc) g.release(t8)
    return out
  }

  /** Draws an accumulator into the canvas inside `viewport` (canvas px, y down); the rest is cleared. */
  present(acc: RenderTarget, viewport: Rect): void {
    const g = this.gl
    const gl = g.gl
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.BLEND)
    g.clear(null, 0, 0, 0, 0)
    const p = g.program('present', S.PRESENT)
    g.use(p)
    g.bindTexture(p, 'uSrc', 0, acc.texture)
    g.f4(p, 'uViewport', viewport.x, gl.drawingBufferHeight - viewport.y - viewport.h, viewport.w, viewport.h)
    g.draw(null)
  }

  release(acc: RenderTarget): void {
    this.gl.release(acc)
  }

  dispose(): void {
    this.offFonts()
    for (const c of this.sources.values()) this.freeCached(c)
    for (const c of this.placeholderTex.values()) this.freeCached(c)
    this.sources.clear()
    this.placeholderTex.clear()
    this.clearTextCache()
    for (const b of this.packBuffers) this.gl.gl.deleteBuffer(b.buffer)
    this.packBuffers.length = 0
    this.fx.luts.dispose()
    this.fx.tables.dispose()
    this.gl.dispose()
  }
}
