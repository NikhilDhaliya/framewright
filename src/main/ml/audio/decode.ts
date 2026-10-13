/**
 * Shared decoders (spec 07 §3.1): first audio stream → Float32 mono PCM at a fixed rate through an FFmpeg pipe,
 * streamed in chunks. Mono is an explicit channel mean (`pan=mono|c0=1/n*c0+…`, §3.4 "Mono downmix") for every decode.
 */
import { spawn } from 'node:child_process'
import { ffmpegPath, ffprobePath, run } from '../../media/ffmpeg'

export interface AudioStreamInfo {
  channels: number
  sampleRate: number
  duration: number
}

/** First audio stream's layout, or null when the file has none. Throws "damaged" for unreadable input. */
export async function probeAudio(file: string, signal?: AbortSignal): Promise<AudioStreamInfo | null> {
  let out: string
  try {
    out = (await run(ffprobePath, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels,sample_rate:format=duration', '-of', 'json', file], { signal })).toString('utf8')
  } catch (e) {
    if (signal?.aborted) throw e
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(/Invalid data found/i.test(msg) ? `Damaged media: ${file}` : msg)
  }
  const info = JSON.parse(out) as { streams?: { channels?: number; sample_rate?: string }[]; format?: { duration?: string } }
  const s = info.streams?.[0]
  if (!s) return null
  return { channels: Math.max(1, s.channels ?? 1), sampleRate: Number(s.sample_rate) || 48000, duration: Number(info.format?.duration) || 0 }
}

/** `pan` filter averaging `n` channels into one. */
export function meanDownmix(channels: number): string {
  if (channels <= 1) return 'anull'
  const w = (1 / channels).toPrecision(8)
  return `pan=mono|c0=${Array.from({ length: channels }, (_, i) => `${w}*c${i}`).join('+')}`
}

export interface DecodeOptions {
  rate: number
  /** Source seconds `[start, end)`. */
  range?: [number, number]
  signal?: AbortSignal
  /** Channel count of the first audio stream (probed when omitted). */
  channels?: number
}

/**
 * Streams mono Float32 chunks to `onChunk`; resolves with the sample count. Rejects when the file has no audio.
 * When `onChunk` returns a promise, the pipe is paused until it settles (back-pressure for slow consumers).
 */
export async function decodeMonoStream(file: string, o: DecodeOptions, onChunk: (x: Float32Array) => void | Promise<void>): Promise<number> {
  const channels = o.channels ?? (await probeAudio(file, o.signal))?.channels
  if (!channels) throw new NoAudioError(file)
  const args = ['-hide_banner', '-nostdin', '-v', 'error']
  if (o.range) args.push('-ss', Math.max(0, o.range[0]).toFixed(4))
  args.push('-i', file)
  if (o.range) args.push('-t', Math.max(0.001, o.range[1] - o.range[0]).toFixed(4))
  args.push('-map', '0:a:0', '-vn', '-af', `${meanDownmix(channels)},aresample=${o.rate}`, '-ac', '1', '-ar', String(o.rate), '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1')
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let total = 0
    let carry: Buffer | null = null
    let err = ''
    const onAbort = () => child.kill('SIGKILL')
    o.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      let buf = carry ? Buffer.concat([carry, d]) : d
      const usable = buf.length - (buf.length % 4)
      carry = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null
      buf = buf.subarray(0, usable)
      if (!usable) return
      const copy = new Float32Array(usable / 4)
      new Uint8Array(copy.buffer).set(buf)
      total += copy.length
      const wait = onChunk(copy)
      if (wait) {
        child.stdout.pause()
        void wait.finally(() => child.stdout.resume())
      }
    })
    child.stderr.on('data', (d: Buffer) => {
      err = (err + d.toString()).slice(-8000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      o.signal?.removeEventListener('abort', onAbort)
      if (o.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
      if (code === 0) return resolve(total)
      reject(new Error(/Invalid data found/i.test(err) ? `Damaged media: ${file}` : `ffmpeg exited with ${code}: ${err.trim().split('\n').slice(-2).join(' | ')}`))
    })
  })
}

/** Whole decode into one array (`AudioTrackReader.readMonoFloats`). */
export async function decodeMono(file: string, o: DecodeOptions): Promise<Float32Array> {
  const parts: Float32Array[] = []
  const n = await decodeMonoStream(file, o, (x) => {
    parts.push(x)
  })
  const out = new Float32Array(n)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

export class NoAudioError extends Error {
  constructor(readonly file: string) {
    super(`No audio track in ${file.split('/').pop()}`)
  }
}
