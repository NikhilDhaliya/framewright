/**
 * Frame-accurate FFmpeg video decoding for capture and export (spec 04 §3.1, §7.2, §11.3).
 * One sequential reader per clip: `-ss` before `-i` (accurate seek with a margin), RGBA frames on stdout and
 * their PTS from `showinfo` on stderr, so the frame shown at source time t is the last one with pts ≤ t.
 */
import type { ChildProcess } from 'node:child_process'
import { childProcess } from './node'

export interface VideoProbe {
  width: number
  height: number
  pixFmt: string
  colorSpace: string
  colorRange: string
  codec: string
  alpha: boolean
}

interface FfprobeStream {
  width?: number
  height?: number
  pix_fmt?: string
  color_space?: string
  color_range?: string
  codec_name?: string
  tags?: Record<string, string>
  side_data_list?: { rotation?: number }[]
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout!.on('data', (d: Uint8Array) => (out += new TextDecoder().decode(d)))
    child.stderr!.on('data', (d: Uint8Array) => (err += new TextDecoder().decode(d)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${bin} exited with ${code}: ${err.slice(-500)}`))))
  })
}

const probeCache = new Map<string, Promise<VideoProbe>>()

export function probeVideo(ffprobe: string, path: string): Promise<VideoProbe> {
  let p = probeCache.get(path)
  if (!p) {
    p = run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-print_format', 'json', path]).then((out) => {
      const s = ((JSON.parse(out) as { streams?: FfprobeStream[] }).streams ?? [])[0]
      if (!s?.width || !s.height) throw new Error('No video stream')
      const rotation = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(s.tags?.rotate ?? 0)
      const swap = Math.abs(rotation) % 180 === 90
      return {
        width: swap ? s.height : s.width,
        height: swap ? s.width : s.height,
        pixFmt: s.pix_fmt ?? '',
        colorSpace: s.color_space ?? '',
        colorRange: s.color_range ?? '',
        codec: s.codec_name ?? '',
        alpha: s.tags?.alpha_mode === '1' || /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/.test(s.pix_fmt ?? ''),
      }
    })
    p.catch(() => probeCache.delete(path))
    probeCache.set(path, p)
  }
  return p
}

/** §7.2: stream matrix/range, no transfer or primaries conversion; untagged HD is BT.709. */
export function colorFilter(p: VideoProbe, w: number, h: number): string {
  const yuv = /^(yuv|yuva|nv|p0|y2|uyvy|yuyv)/.test(p.pixFmt)
  const parts = [`w=${w}`, `h=${h}`]
  if (yuv) {
    const cs = p.colorSpace
    const matrix = cs === 'bt709' ? 'bt709' : cs === 'bt470bg' || cs === 'smpte170m' || cs === 'fcc' ? 'bt601' : cs === 'bt2020nc' || cs === 'bt2020c' ? 'bt2020' : cs === 'smpte240m' ? 'smpte240m' : p.height >= 720 ? 'bt709' : 'bt601'
    parts.push(`in_color_matrix=${matrix}`, `in_range=${p.colorRange === 'pc' ? 'pc' : 'tv'}`, 'out_range=pc')
  }
  parts.push('flags=accurate_rnd+full_chroma_int')
  return `scale=${parts.join(':')},format=rgba`
}

export interface DecodedFrame {
  data: Uint8Array
  /** Source seconds (relative to the file start). */
  pts: number
  /** Unique across all decoders (texture upload version). */
  serial: number
}

let serials = 1
const SEEK_MARGIN = 0.5
const MAX_QUEUE = 4

/** Sequential reader of one source; `frameAt` must be called with non-decreasing times. */
export class SequentialDecoder {
  private readonly child: ChildProcess
  private readonly frameSize: number
  private readonly pool: Uint8Array[] = []
  private readonly queue: { data: Uint8Array; index: number }[] = []
  private readonly pts: number[] = []
  private partial: Uint8Array | null = null
  private filled = 0
  private produced = 0
  private consumed = 0
  private timeBase = 0
  private ended = false
  private stderrTail = ''
  private lineBuf = ''
  private waiter: (() => void) | null = null
  private current: DecodedFrame | null = null
  private readonly exited: Promise<void>
  readonly start: number
  lastTime = -Infinity

  constructor(ffmpeg: string, readonly path: string, at: number, readonly width: number, readonly height: number, probe: VideoProbe) {
    this.frameSize = width * height * 4
    this.start = Math.max(0, at - SEEK_MARGIN)
    const args = ['-hide_banner', '-nostats', '-loglevel', 'info']
    // FFmpeg's native VP9 decoder drops the alpha plane.
    if (probe.codec === 'vp9' && probe.alpha) args.push('-c:v', 'libvpx-vp9')
    args.push('-ss', this.start.toFixed(6), '-i', path, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', `${colorFilter(probe, width, height)},showinfo=checksum=0`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1')
    this.child = childProcess.spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child.stdout!.on('data', (d: Uint8Array) => this.onData(d))
    this.child.stderr!.on('data', (d: Uint8Array) => this.onStderr(new TextDecoder().decode(d)))
    const finish = () => {
      this.ended = true
      this.wake()
    }
    // 'close' (all stdout delivered) marks the end of the stream; 'exit' only means the process is gone.
    this.child.on('close', finish)
    this.child.on('error', finish)
    this.exited = new Promise<void>((resolve) => {
      this.child.on('exit', () => resolve())
      this.child.on('error', () => resolve())
    })
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }

  private onData(d: Uint8Array): void {
    let off = 0
    while (off < d.length) {
      if (!this.partial) {
        this.partial = this.pool.pop() ?? new Uint8Array(this.frameSize)
        this.filled = 0
      }
      const n = Math.min(this.frameSize - this.filled, d.length - off)
      this.partial.set(d.subarray(off, off + n), this.filled)
      this.filled += n
      off += n
      if (this.filled === this.frameSize) {
        this.queue.push({ data: this.partial, index: this.produced++ })
        this.partial = null
      }
    }
    if (this.queue.length >= MAX_QUEUE) this.child.stdout!.pause()
    this.wake()
  }

  private onStderr(text: string): void {
    this.stderrTail = (this.stderrTail + text).slice(-4000)
    this.lineBuf += text
    const lines = this.lineBuf.split(/\r?\n|\r/)
    this.lineBuf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.includes('showinfo')) continue
      const tb = /config in time_base:\s*(\d+)\/(\d+)/.exec(line)
      if (tb) {
        this.timeBase = Number(tb[1]) / Number(tb[2])
        continue
      }
      const m = /\bn:\s*(\d+)\s+pts:\s*(\S+)\s+pts_time:\s*(\S+)/.exec(line)
      if (!m) continue
      const n = Number(m[1])
      const raw = Number(m[2])
      const t = Number.isFinite(raw) && this.timeBase > 0 ? raw * this.timeBase : Number(m[3])
      const prev = this.pts[n - 1]
      this.pts[n] = Number.isFinite(t) ? this.start + t : prev !== undefined ? prev + 1 / 30 : this.start
    }
    this.wake()
  }

  get error(): string {
    return this.stderrTail.split('\n').filter((l) => l && !l.includes('showinfo')).slice(-3).join(' | ')
  }

  /** Next queued frame with a known pts, or null once the stream is exhausted. */
  private async next(): Promise<DecodedFrame | null> {
    for (;;) {
      const q = this.queue[0]
      if (q && this.pts[q.index] !== undefined) {
        this.queue.shift()
        this.consumed++
        if (this.queue.length < MAX_QUEUE) this.child.stdout!.resume()
        return { data: q.data, pts: this.pts[q.index], serial: serials++ }
      }
      if (this.ended && (!q || this.pts[q.index] === undefined)) {
        // Process exited: frames without a parsed pts follow the last known one.
        if (q) {
          this.queue.shift()
          const prev = this.pts[this.pts.length - 1] ?? this.start
          return { data: q.data, pts: prev, serial: serials++ }
        }
        return null
      }
      await new Promise<void>((r) => (this.waiter = r))
    }
  }

  private lookahead: DecodedFrame | null | undefined

  /** The frame shown at source time `t` (last with pts ≤ t + 1e-6; the first frame if none is earlier). */
  async frameAt(t: number): Promise<DecodedFrame | null> {
    this.lastTime = t
    if (!this.current) {
      this.current = await this.next()
      if (!this.current) return null
    }
    for (;;) {
      if (this.lookahead === undefined) this.lookahead = await this.next()
      const la = this.lookahead
      if (!la || la.pts > t + 1e-6) return this.current
      this.recycle(this.current)
      this.current = la
      this.lookahead = undefined
    }
  }

  private recycle(f: DecodedFrame | null): void {
    if (f && f.data.length === this.frameSize && this.pool.length < MAX_QUEUE + 2) this.pool.push(f.data)
  }

  /** Kills the reader; resolves once the process has exited. */
  close(): Promise<void> {
    this.ended = true
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    // A paused stdout never ends on its own; drop it so the process releases its pipe.
    this.child.stdout?.destroy()
    this.wake()
    return this.exited
  }
}
