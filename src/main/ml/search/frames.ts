/**
 * FFmpeg frame decoding for the visual indexer (spec 07 §2.3 "Linux"): one ffmpeg run per candidate time, keyframe
 * seek without accurate seeking (the Mac's ±tolerance nearest-sync-frame behaviour), frames fit within 512×512 without
 * upscaling, display-oriented (ffmpeg autorotates), RGBA via PAM so alpha sources can be composited over black.
 */
import { spawn } from 'node:child_process'
import { ffmpegPath, ffprobePath, run } from '../../media/ffmpeg'
import { candidateTimes, DEFAULT_SAMPLER_OPTIONS, lumaGrid, samplerInterval, samplerTolerance, ShotDetector, type SamplerOptions } from '../../../core/search/sampler'

export interface RgbaFrame {
  rgba: Uint8Array
  width: number
  height: number
}

export interface DecodedFrame extends RgbaFrame {
  /** Actual presentation time of the decoded frame, in asset seconds. */
  time: number
}

export interface SampledFrame extends DecodedFrame {
  isNewShot: boolean
}

const abortError = () => new DOMException('Aborted', 'AbortError')

/** Parses one PAM (P7) image; null when the bytes are not a complete RGB_ALPHA/RGB image. */
export function parsePam(buf: Buffer): RgbaFrame | null {
  const end = buf.indexOf('ENDHDR\n')
  if (end < 0 || buf.subarray(0, 3).toString() !== 'P7\n') return null
  const fields: Record<string, string> = {}
  for (const line of buf.subarray(3, end).toString('latin1').split('\n')) {
    const [k, v] = line.trim().split(/\s+/, 2)
    if (k) fields[k] = v
  }
  const width = Number(fields.WIDTH)
  const height = Number(fields.HEIGHT)
  const depth = Number(fields.DEPTH)
  if (!(width > 0 && height > 0) || (depth !== 4 && depth !== 3) || Number(fields.MAXVAL) !== 255) return null
  const data = buf.subarray(end + 7)
  if (data.length < width * height * depth) return null
  if (depth === 4) return { rgba: new Uint8Array(data.buffer, data.byteOffset, width * height * 4).slice(), width, height }
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, j = 0; i < width * height; i++, j += 3) {
    rgba[i * 4] = data[j]
    rgba[i * 4 + 1] = data[j + 1]
    rgba[i * 4 + 2] = data[j + 2]
    rgba[i * 4 + 3] = 255
  }
  return { rgba, width, height }
}

const fitFilter = (max: number) => `scale=w='min(${max},iw)':h='min(${max},ih)':force_original_aspect_ratio=decrease`

export interface VideoProbe {
  width: number
  height: number
  /** Container start time; frame times are reported relative to it. */
  startTime: number
}

export async function probeVideo(file: string, signal?: AbortSignal): Promise<VideoProbe | null> {
  try {
    const out = await run(ffprobePath, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,start_time:format=start_time', '-of', 'json', file], { signal })
    const j = JSON.parse(out.toString()) as { streams?: { width?: number; height?: number; start_time?: string }[]; format?: { start_time?: string } }
    const s = j.streams?.[0]
    if (!s || !s.width || !s.height) return null
    const start = Number(j.format?.start_time ?? s.start_time ?? 0)
    return { width: s.width, height: s.height, startTime: Number.isFinite(start) ? start : 0 }
  } catch {
    if (signal?.aborted) throw abortError()
    return null
  }
}

/** One frame near `t` (keyframe seek unless `accurate`), fit within `maxSize`. Null when nothing decodes there. */
export async function decodeFrameAt(file: string, t: number, opts: { maxSize?: number; accurate?: boolean; startTime?: number; signal?: AbortSignal } = {}): Promise<DecodedFrame | null> {
  const start = opts.startTime ?? 0
  const args = ['-nostdin', '-v', 'info', ...(opts.accurate ? [] : ['-noaccurate_seek']), '-ss', String(Math.max(0, t)), '-i', file, '-copyts', '-map', '0:v:0', '-frames:v', '1', '-an', '-sn', '-vf', `${fitFilter(opts.maxSize ?? DEFAULT_SAMPLER_OPTIONS.maxSize)},showinfo`, '-pix_fmt', 'rgba', '-c:v', 'pam', '-f', 'image2pipe', 'pipe:1']
  let out: Buffer
  let stderr = ''
  try {
    out = await runWithStderr(args, opts.signal, (s) => (stderr = s))
  } catch {
    if (opts.signal?.aborted) throw abortError()
    return null
  }
  const img = parsePam(out)
  if (!img) return null
  const m = /pts_time:\s*(-?[0-9.]+)/.exec(stderr)
  const pts = m ? Number(m[1]) : t + start
  return { ...img, time: Math.max(0, pts - start) }
}

function runWithStderr(args: string[], signal: AbortSignal | undefined, onStderr: (s: string) => void): Promise<Buffer> {
  // `run` keeps stderr only for errors; showinfo writes the PTS there.
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString()
      if (err.length > 64_000) err = err.slice(-32_000)
    })
    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      onStderr(err)
      if (signal?.aborted) return reject(abortError())
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}`))
      resolve(Buffer.concat(chunks))
    })
  })
}

/**
 * Streams visually distinct frames (spec 07 §2.3): luma scene changes start new shots; a coverage floor keeps long
 * static shots represented. A keyframe farther than the tolerance before the candidate is re-decoded accurately.
 */
export async function* sampleFrames(file: string, duration: number, opts: { options?: SamplerOptions; signal?: AbortSignal } = {}): AsyncGenerator<SampledFrame> {
  const o = opts.options ?? DEFAULT_SAMPLER_OPTIONS
  if (!(duration > 0)) return
  const probe = await probeVideo(file, opts.signal)
  if (!probe) return
  const interval = samplerInterval(probe.width, probe.height, o)
  const tolerance = samplerTolerance(interval)
  const detector = new ShotDetector(o)
  for (const t of candidateTimes(duration, interval)) {
    if (opts.signal?.aborted) throw abortError()
    let frame = await decodeFrameAt(file, t, { maxSize: o.maxSize, startTime: probe.startTime, signal: opts.signal })
    if (!frame || Math.abs(frame.time - t) > tolerance) {
      frame = await decodeFrameAt(file, t, { maxSize: o.maxSize, startTime: probe.startTime, accurate: true, signal: opts.signal })
    }
    if (!frame) continue
    const decision = detector.accept(frame.time, lumaGrid(frame.rgba, frame.width, frame.height))
    if (!decision?.keep) continue
    yield { ...frame, isNewShot: decision.isNewShot }
  }
}

/** A still image fit within `maxSize` (first frame; ffmpeg applies no EXIF rotation to stills — see report). */
export async function decodeStill(file: string, opts: { maxSize?: number; signal?: AbortSignal } = {}): Promise<RgbaFrame | null> {
  const args = ['-nostdin', '-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', fitFilter(opts.maxSize ?? DEFAULT_SAMPLER_OPTIONS.maxSize), '-pix_fmt', 'rgba', '-c:v', 'pam', '-f', 'image2pipe', 'pipe:1']
  try {
    return parsePam(await run(ffmpegPath, args, { signal: opts.signal }))
  } catch {
    if (opts.signal?.aborted) throw abortError()
    return null
  }
}
