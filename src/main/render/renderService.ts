/**
 * RenderService backed by a lazily created hidden BrowserWindow (the render host) that runs the same
 * WebGL compositor as the preview, with FFmpeg-decoded sources for frame-accurate output.
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { timelineById } from '../../core/ops/context'
import { HOST_CHANNELS, type ExportVideoParams, type HostProgress, type HostRequest, type HostResponse, type HostResults } from '../../renderer/renderHost/protocol'
import { ffmpegPath, ffprobePath } from '../media/ffmpeg'
import type { ProjectSession } from '../project/session'
import type { CaptureRequest, RenderService, TextMeasureRequest } from '../services'
import { buildMediaMap } from './mediaMap'

type Method = HostRequest['method']
type ParamsOf<M extends Method> = Extract<HostRequest, { method: M }>['params']

interface Pending {
  resolve(v: unknown): void
  reject(e: Error): void
  timer: NodeJS.Timeout | null
  method: Method
}

const READY_TIMEOUT_MS = 30_000
const TIMEOUTS: Record<Method, number> = { capture: 120_000, lottie: 60_000, measure: 30_000, export: 0, cancel: 10_000 }
/** An export that reports no frame for this long is considered hung. */
const EXPORT_STALL_MS = 5 * 60_000

export interface VideoRenderHandle {
  done: Promise<{ frames: number }>
  cancel(): void
}

export interface HostRenderService extends RenderService {
  lottieFrames(file: string, req: { frames: number[]; maxSide: number; background?: string }): Promise<Buffer[]>
  /** Streams composited RGBA frames into an ffmpeg encoder run by the host. */
  renderVideo(params: ExportVideoParams, onProgress: (framesRendered: number) => void): VideoRenderHandle
  dispose(): Promise<void>
}

/**
 * Chromium switches the preview needs; call before `app.whenReady()`. Software-decoded video frames stay in
 * CPU memory so the preview's VideoFrame.copyTo is a plain copy instead of a GPU readback that blocks the
 * renderer behind the compositor (measured 128 ms → <1 ms per 1080p frame under SwiftShader).
 */
export function configureRenderSwitches(): void {
  app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames')
}

export function createRenderService(): HostRenderService {
  let win: BrowserWindow | null = null
  let ready: Promise<BrowserWindow> | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()
  const progress = new Map<string, (n: number) => void>()
  let disposed = false

  const failAll = (reason: string) => {
    for (const [id, p] of pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(reason))
      pending.delete(id)
    }
  }

  const teardown = (reason: string) => {
    const w = win
    win = null
    ready = null
    failAll(reason)
    if (w && !w.isDestroyed()) w.destroy()
  }

  function ensureHost(): Promise<BrowserWindow> {
    if (disposed) return Promise.reject(new Error('Render service disposed'))
    if (ready && win && !win.isDestroyed()) return ready
    const w = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      paintWhenInitiallyHidden: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false, spellcheck: false },
    })
    win = w
    const wc = w.webContents
    wc.ipc.on(HOST_CHANNELS.response, (_e, msg: HostResponse) => {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (p.timer) clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error))
    })
    wc.ipc.on(HOST_CHANNELS.progress, (_e, msg: HostProgress) => progress.get(msg.jobId)?.(msg.framesRendered))
    wc.on('render-process-gone', (_e, details) => {
      if (win === w) teardown(`Render host stopped (${details.reason})`)
    })
    w.on('closed', () => {
      if (win === w) teardown('Render host closed')
    })
    ready = new Promise<BrowserWindow>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Render host did not start'))
        if (win === w) teardown('Render host did not start')
      }, READY_TIMEOUT_MS)
      wc.ipc.once(HOST_CHANNELS.ready, () => {
        clearTimeout(timer)
        resolve(w)
      })
      wc.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer)
        reject(new Error(`Render host failed to load: ${desc} (${code})`))
        if (win === w) teardown('Render host failed to load')
      })
    })
    const query = { ffmpeg: ffmpegPath, ffprobe: ffprobePath }
    const devUrl = process.env.PALMIER_RENDERER_URL
    if (devUrl) void w.loadURL(`${devUrl}render.html?${new URLSearchParams(query).toString()}`)
    else void w.loadFile(path.join(__dirname, '../renderer/render.html'), { query })
    return ready
  }

  async function request<M extends Method>(method: M, params: ParamsOf<M>, timeoutMs = TIMEOUTS[method]): Promise<HostResults[M]> {
    const w = await ensureHost()
    const id = nextId++
    return new Promise<HostResults[M]>((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Render host timed out (${method})`))
      }, timeoutMs) : null
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      try {
        w.webContents.send(HOST_CHANNELS.request, { id, method, params })
      } catch (e) {
        pending.delete(id)
        if (timer) clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  return {
    async captureFrame(session: ProjectSession, req: CaptureRequest): Promise<Buffer> {
      const tl = timelineById(session.doc, req.timelineId)
      if (!tl) throw new Error(`Timeline ${req.timelineId} not found`)
      if (!Number.isFinite(req.frame)) throw new Error('frame must be a finite number')
      const width = req.width !== undefined && Number.isFinite(req.width) && req.width > 0 ? Math.min(8192, Math.round(req.width)) : tl.width
      const height = Math.max(1, Math.round((width * tl.height) / tl.width))
      const quality = req.quality !== undefined && Number.isFinite(req.quality) ? Math.min(1, Math.max(0.01, req.quality > 1 ? req.quality / 100 : req.quality)) : 0.9
      const bytes = await request('capture', {
        doc: session.doc,
        timelineId: tl.id,
        media: await buildMediaMap(session),
        frame: Math.max(0, Math.trunc(req.frame)),
        width,
        height,
        format: req.format === 'jpeg' ? 'jpeg' : 'png',
        quality,
      })
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    },

    async lottieFrames(file, req) {
      if (!req.frames.length) return []
      const pngs = await request('lottie', { path: file, frames: req.frames, maxSide: req.maxSide, background: req.background })
      return pngs.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength))
    },

    async measureText(reqs: TextMeasureRequest[]) {
      if (!reqs.length) return []
      return request('measure', { reqs })
    },

    renderVideo(params, onProgress): VideoRenderHandle {
      let lastProgress = Date.now()
      let stallTimer: NodeJS.Timeout | null = null
      progress.set(params.jobId, (n) => {
        lastProgress = Date.now()
        onProgress(n)
      })
      const done = new Promise<{ frames: number }>((resolve, reject) => {
        stallTimer = setInterval(() => {
          if (Date.now() - lastProgress > EXPORT_STALL_MS) {
            reject(new Error('Render host stopped responding'))
            if (win) teardown('Render host stalled during export')
          }
        }, 10_000)
        request('export', params).then(resolve, reject)
      }).finally(() => {
        if (stallTimer) clearInterval(stallTimer)
        progress.delete(params.jobId)
      })
      return {
        done,
        cancel: () => {
          if (win && !win.isDestroyed()) void request('cancel', { jobId: params.jobId }).catch(() => undefined)
        },
      }
    },

    async dispose() {
      disposed = true
      teardown('Render service disposed')
    },
  }
}
