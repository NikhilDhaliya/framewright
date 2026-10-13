/**
 * Hidden render-host window: frame-accurate captures, text measurement and video export frames,
 * using the same compositor as the preview with FFmpeg-decoded sources.
 */
import type { ChildProcess } from 'node:child_process'
import { Compositor, type Scene } from '../render/compositor'
import { ensureFonts } from '../render/fonts'
import { fontsReady, textMeasurer } from '../render/text'
import { lottieMeta, lottieThumbnailSize } from '../../shared/lottie'
import { canvasPng, LottieInstance } from '../render/lottieSource'
import { HOST_CHANNELS, type CaptureParams, type ExportVideoParams, type HostRequest, type HostResponse, type LottieFramesParams, type MeasureParams } from './protocol'
import { childProcess, electron, fsp } from './node'
import { HostFrames, readLottieFile } from './sources'

const query = new URLSearchParams(location.search)
const ffmpeg = query.get('ffmpeg') || 'ffmpeg'
const ffprobe = query.get('ffprobe') || 'ffprobe'
const { ipcRenderer } = electron

const canvas = document.createElement('canvas')
canvas.width = 16
canvas.height = 16
const compositor = new Compositor(canvas, { readText: (p) => fsp.readFile(p, 'utf8') })

const exports = new Map<string, AbortController>()

function timelineOf(scene: Scene) {
  const tl = scene.doc.file.timelines.find((t) => t.id === scene.timelineId)
  if (!tl) throw new Error(`Timeline ${scene.timelineId} not found`)
  return tl
}

/** Decodes every source frame timeline frame `frame` needs. */
function prepareFrame(scene: Scene, frames: HostFrames, frame: number, W: number, H: number): Promise<void> {
  const tl = timelineOf(scene)
  return frames.prepare(compositor.plannerFor(scene, false).layersAt(tl, frame, W, H), frame, tl.fps)
}

/** Composites a prepared frame; the pixels arrive once the GPU is done, without blocking the event loop. */
function renderPrepared(scene: Scene, frames: HostFrames, frame: number, W: number, H: number, out?: Uint8Array): Promise<Uint8Array> {
  const acc = compositor.render(scene, frame, frames, W, H, { out8: true })
  try {
    return compositor.readPixelsAsync(acc, out)
  } finally {
    compositor.release(acc)
  }
}

async function capture(p: CaptureParams): Promise<Uint8Array> {
  const W = Math.max(1, Math.round(p.width))
  const H = Math.max(1, Math.round(p.height))
  await compositor.prepare(p.doc)
  const frames = new HostFrames(ffmpeg, ffprobe)
  try {
    const frame = Math.max(0, Math.trunc(p.frame))
    await prepareFrame(p, frames, frame, W, H)
    const pixels = await renderPrepared(p, frames, frame, W, H)
    const out = new OffscreenCanvas(W, H)
    const data = new Uint8ClampedArray(W * H * 4)
    data.set(pixels.subarray(0, W * H * 4))
    out.getContext('2d')!.putImageData(new ImageData(data, W, H), 0, 0)
    const blob = await out.convertToBlob(p.format === 'jpeg' ? { type: 'image/jpeg', quality: p.quality } : { type: 'image/png' })
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    await frames.close()
  }
}

/** Lottie frames rendered fit-within `maxSide` (`LottieVideoGenerator.inspect` / `sampleFrames`) as PNGs. */
async function lottieFrames(p: LottieFramesParams): Promise<Uint8Array[]> {
  const data = await readLottieFile(p.path)
  const meta = lottieMeta(data)
  const inst = new LottieInstance(data, lottieThumbnailSize(meta.width, meta.height, p.maxSide))
  try {
    await inst.loaded
    const out: Uint8Array[] = []
    for (const f of p.frames) {
      inst.render(f)
      out.push(await canvasPng(inst.canvas, p.background))
    }
    return out
  } finally {
    inst.destroy()
  }
}

async function measure(p: MeasureParams) {
  await fontsReady
  await ensureFonts(p.reqs.map((r) => r.style))
  return p.reqs.map((r) => textMeasurer.measure(r.content, r.style, r.canvasWidth, r.canvasHeight))
}

/** The partial output is discarded on failure, so the encoder is killed outright; resolves once it has exited. */
async function killEncoder(child: ChildProcess, exited: Promise<unknown>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
}

async function exportVideo(p: ExportVideoParams): Promise<{ frames: number }> {
  const abort = new AbortController()
  exports.set(p.jobId, abort)
  try {
    const tl = timelineOf(p)
    await compositor.prepare(p.doc)
    if (abort.signal.aborted) throw new Error('cancelled')
    return await encode(p, tl.fps, abort.signal)
  } finally {
    exports.delete(p.jobId)
  }
}

/** Renders the frames into an ffmpeg encoder's stdin; on failure or cancel every process is gone when it rejects. */
async function encode(p: ExportVideoParams, fps: number, signal: AbortSignal): Promise<{ frames: number }> {
  const W = p.width
  const H = p.height
  const aborted = new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }))
  const encoder = childProcess.spawn(ffmpeg, p.ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  encoder.stderr!.on('data', (d: Uint8Array) => (stderr = (stderr + new TextDecoder().decode(d)).slice(-4000)))
  const exited = new Promise<number | null>((resolve) => {
    encoder.on('close', (code) => resolve(code))
    encoder.on('error', (e) => {
      stderr += String(e)
      resolve(-1)
    })
  })
  let encoderGone = false
  void exited.then(() => (encoderGone = true))
  encoder.stdin!.on('error', () => undefined)
  const errorTail = () => stderr.trim().split('\n').slice(-3).join(' | ')
  const frames = new HostFrames(ffmpeg, ffprobe)
  // Output buffers: one is reused only after the encoder has consumed it.
  const ring = Array.from({ length: 4 }, () => ({ buf: new Uint8Array(W * H * 4), flushed: Promise.resolve() }))
  let lastReport = 0
  const frameAt = (i: number) => p.startFrame + Math.floor((i * fps) / p.outFps + 1e-9)
  const quiet = <T>(pr: Promise<T>) => (pr.catch(() => undefined), pr)
  let prepared = quiet(prepareFrame(p, frames, frameAt(0), W, H))
  /** Readback of the previous frame, still on the GPU while the next one is issued. */
  let inFlight: Promise<Uint8Array> | null = null
  try {
    // Two frames in flight: frame i is composited while frame i - 1 is read back and encoded, and frame i + 1 decodes.
    for (let i = 0; i <= p.frameCount; i++) {
      if (signal.aborted) throw new Error('cancelled')
      if (encoderGone) throw new Error(`Encoder stopped: ${errorTail()}`)
      let issued: Promise<Uint8Array> | null = null
      if (i < p.frameCount) {
        const slot = ring[i % ring.length]
        await Promise.race([slot.flushed, aborted, exited])
        if (signal.aborted) throw new Error('cancelled')
        await prepared
        issued = quiet(renderPrepared(p, frames, frameAt(i), W, H, slot.buf))
        if (i + 1 < p.frameCount) prepared = quiet(prepareFrame(p, frames, frameAt(i + 1), W, H))
      }
      if (inFlight) {
        const done = i - 1
        const buf = await inFlight
        const slot = ring[done % ring.length]
        // No 'drain' wait: the ring bounds what is queued, so rendering runs ahead of the encoder by up to its size.
        let flushed!: () => void
        slot.flushed = new Promise<void>((resolve) => (flushed = resolve))
        encoder.stdin!.write(buf, () => flushed())
        const now = performance.now()
        if (now - lastReport > 100 || done === p.frameCount - 1) {
          lastReport = now
          ipcRenderer.send(HOST_CHANNELS.progress, { jobId: p.jobId, framesRendered: done + 1 })
        }
      }
      inFlight = issued
    }
    encoder.stdin!.end()
    const code = await Promise.race([exited, aborted])
    if (signal.aborted) throw new Error('cancelled')
    if (code !== 0) throw new Error(`ffmpeg exited with ${code}: ${errorTail()}`)
    return { frames: p.frameCount }
  } catch (e) {
    await killEncoder(encoder, exited)
    throw e
  } finally {
    await frames.close()
  }
}

async function handle(msg: HostRequest): Promise<unknown> {
  switch (msg.method) {
    case 'capture':
      return capture(msg.params)
    case 'measure':
      return measure(msg.params)
    case 'lottie':
      return lottieFrames(msg.params)
    case 'export':
      return exportVideo(msg.params)
    case 'cancel':
      exports.get(msg.params.jobId)?.abort()
      return null
  }
}

ipcRenderer.on(HOST_CHANNELS.request, (_e, msg: HostRequest) => {
  handle(msg).then(
    (result) => ipcRenderer.send(HOST_CHANNELS.response, { id: msg.id, ok: true, result } satisfies HostResponse),
    (err: unknown) => ipcRenderer.send(HOST_CHANNELS.response, { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies HostResponse),
  )
})

void fontsReady.finally(() => ipcRenderer.send(HOST_CHANNELS.ready))
