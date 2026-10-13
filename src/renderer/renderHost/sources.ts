/** Source frames for the render host: FFmpeg-decoded video (frame-accurate), decoded stills and Lottie (lottie-web). */
import { extensionOf, parseLottie, type LottieJson } from '../../shared/lottie'
import type { FrameProvider, FrameResult, SourceFrame } from '../render/compositor'
import { LottieSources } from '../render/lottieSource'
import { mediaLayers, sourceTimeSec, type LayerPlan, type MediaLayer } from '../render/plan'
import { probeVideo, SequentialDecoder } from './decoder'
import { childProcess, fsp } from './node'

const MAX_IMAGE_SIDE = 4096
/** Restart a reader instead of decoding through a forward jump longer than this (seconds). */
const MAX_SKIP = 2

let bitmapSerial = 1

/** Reads a `.json` Lottie, or the first animation of a `.lottie` archive with its images inlined. */
export async function readLottieFile(path: string): Promise<LottieJson> {
  const bytes = await fsp.readFile(path)
  return parseLottie(extensionOf(path), new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** Lottie instances shared by every capture and export of the host, keyed by file version. */
export const hostLottie = new LottieSources(readLottieFile)

function decodeWithFfmpeg(ffmpeg: string, path: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Uint8Array[] = []
    child.stdout!.on('data', (d: Uint8Array) => chunks.push(d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${path}`))
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const c of chunks) {
        out.set(c, off)
        off += c.length
      }
      resolve(out)
    })
  })
}

export class HostFrames implements FrameProvider {
  private readonly decoders = new Map<string, SequentialDecoder>()
  private readonly images = new Map<string, Promise<{ bitmap: ImageBitmap; serial: number } | null>>()
  private readonly ready = new Map<string, FrameResult>()
  /** Clip id → loaded Lottie file version (rendered on demand in `frame`). */
  private readonly lottieKeys = new Map<string, string>()

  constructor(
    private readonly ffmpeg: string,
    private readonly ffprobe: string,
  ) {}

  frame(layer: MediaLayer, timeSec: number): FrameResult {
    const key = layer.info.type === 'lottie' ? this.lottieKeys.get(layer.clip.id) : undefined
    if (key) return hostLottie.frame(layer, timeSec, key)
    return this.ready.get(layer.clip.id) ?? 'pending'
  }

  /** Decodes every media frame a plan needs at timeline frame `f`; idle readers are closed. */
  async prepare(plan: LayerPlan[], f: number, fps: number): Promise<void> {
    this.ready.clear()
    this.lottieKeys.clear()
    hostLottie.nextFrame()
    const layers = mediaLayers(plan)
    const active = new Set<string>()
    await Promise.all(
      layers.map(async (layer) => {
        const t = sourceTimeSec(layer.clip, f, fps, layer.timing)
        if (t === null || layer.offline || !layer.info.path) return
        active.add(layer.clip.id)
        try {
          if (layer.info.type === 'lottie') return await this.loadLottie(layer, layer.info.path)
          const res = layer.info.type === 'image' ? await this.image(layer.info.path) : layer.info.type === 'video' ? await this.video(layer, layer.info.path, t) : null
          if (res) this.ready.set(layer.clip.id, res)
        } catch (e) {
          console.warn(`Source ${layer.info.path} failed`, e)
          this.ready.set(layer.clip.id, 'offline')
        }
      }),
    )
    for (const [id, d] of this.decoders) {
      if (!active.has(id)) {
        void d.close()
        this.decoders.delete(id)
      }
    }
  }

  /** Loads the file's animation; its frames are drawn when the compositor asks for them. */
  private async loadLottie(layer: MediaLayer, path: string): Promise<void> {
    const st = await fsp.stat(path)
    const key = `${path}|${st.size}|${Math.trunc(st.mtimeMs)}`
    if (await hostLottie.ensure(path, key)) this.lottieKeys.set(layer.clip.id, key)
    else this.ready.set(layer.clip.id, 'offline')
  }

  private async image(path: string): Promise<FrameResult> {
    let p = this.images.get(path)
    if (!p) {
      p = (async () => {
        const bytes = await fsp.readFile(path)
        const blob = new Blob([new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)])
        let bitmap: ImageBitmap
        try {
          bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'default', imageOrientation: 'from-image' })
        } catch {
          // Formats Chromium cannot decode (HEIC, TIFF variants) go through FFmpeg.
          const png = await decodeWithFfmpeg(this.ffmpeg, path)
          bitmap = await createImageBitmap(new Blob([png as BlobPart]), { premultiplyAlpha: 'none', colorSpaceConversion: 'default' })
        }
        const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
        if (k < 1) {
          const resized = await createImageBitmap(bitmap, { resizeWidth: Math.max(2, Math.round(bitmap.width * k)), resizeHeight: Math.max(2, Math.round(bitmap.height * k)), premultiplyAlpha: 'none', resizeQuality: 'high' })
          bitmap.close()
          bitmap = resized
        }
        return { bitmap, serial: bitmapSerial++ }
      })().catch((e) => {
        console.warn(`Image ${path} failed`, e)
        return null
      })
      this.images.set(path, p)
    }
    const img = await p
    return img ? { source: img.bitmap, pixels: null, width: img.bitmap.width, height: img.bitmap.height, version: img.serial } : 'offline'
  }

  private async video(layer: MediaLayer, path: string, t: number): Promise<SourceFrame> {
    const probe = await probeVideo(this.ffprobe, path)
    const w = layer.natW || probe.width
    const h = layer.natH || probe.height
    let d = this.decoders.get(layer.clip.id)
    if (d && (d.path !== path || t < d.lastTime || t > d.lastTime + MAX_SKIP || d.width !== w || d.height !== h)) {
      void d.close()
      d = undefined
    }
    if (!d) {
      d = new SequentialDecoder(this.ffmpeg, path, t, w, h, probe)
      this.decoders.set(layer.clip.id, d)
    }
    const frame = await d.frameAt(t)
    if (!frame) throw new Error(`No frame at ${t.toFixed(3)}s: ${d.error}`)
    return { source: null, pixels: frame.data, width: w, height: h, version: frame.serial }
  }

  /** Stops every reader; resolves once their processes have exited. */
  async close(): Promise<void> {
    const closing = [...this.decoders.values()].map((d) => d.close())
    this.decoders.clear()
    for (const p of this.images.values()) void p.then((img) => img?.bitmap.close())
    this.images.clear()
    this.ready.clear()
    await Promise.all(closing)
  }
}
