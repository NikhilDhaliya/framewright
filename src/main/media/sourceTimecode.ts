/**
 * Source timecode and capture-date readers (spec 07 §6.0; Mac `Utilities/SourceTimecode.swift`): QuickTime/MP4
 * `tmcd` tracks, Sony XAVC `rtmd` metadata tracks and BWF `bext.TimeReference`, with ffprobe fallbacks. Only the
 * needed boxes/chunks are read with positional reads — camera files can be tens of GB.
 */
import fs from 'node:fs/promises'
import { displayToFrames, parseTimecodeString, type SourceTimecode, type SourceTiming } from '../../core/interchange/timecode'
import { ffprobePath, run } from './ffmpeg'

export type { SourceTimecode, SourceTiming }

/** Random-access bytes; `read` may return fewer bytes at the end of the source. */
export interface ByteSource {
  size: number
  read(offset: number, length: number): Promise<Buffer>
}

export function bufferSource(buf: Buffer): ByteSource {
  return { size: buf.length, read: async (offset, length) => buf.subarray(Math.max(0, offset), Math.max(0, Math.min(buf.length, offset + length))) }
}

export async function withFileSource<T>(path: string, fn: (src: ByteSource) => Promise<T>): Promise<T> {
  const fh = await fs.open(path, 'r')
  try {
    const { size } = await fh.stat()
    return await fn({
      size,
      read: async (offset, length) => {
        if (offset < 0 || offset >= size || length <= 0) return Buffer.alloc(0)
        const buf = Buffer.alloc(Math.min(length, size - offset))
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
        return buf.subarray(0, bytesRead)
      },
    })
  } finally {
    await fh.close()
  }
}

// ---------- Byte helpers (undefined when out of range, like the Mac's optional readers) ----------

async function bytes(src: ByteSource, offset: number, count: number): Promise<Buffer | undefined> {
  if (offset < 0 || offset + count > src.size) return undefined
  const b = await src.read(offset, count)
  return b.length === count ? b : undefined
}

async function be(src: ByteSource, offset: number, count: 1 | 4 | 8): Promise<number | undefined> {
  const b = await bytes(src, offset, count)
  if (!b) return undefined
  if (count === 1) return b[0]
  if (count === 4) return b.readUInt32BE(0)
  const v = b.readBigUInt64BE(0)
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined
}

async function fourcc(src: ByteSource, offset: number): Promise<string | undefined> {
  const b = await bytes(src, offset, 4)
  if (!b || b.some((c) => c > 127)) return undefined
  return b.toString('latin1')
}

// ---------- ISO-BMFF box walker ----------

interface Box {
  type: string
  /** Body range [start, end). */
  start: number
  end: number
}

/** Child boxes in [start, end): size 1 = 64-bit size after the type; size 0 = to the end of the parent. */
async function mp4Children(src: ByteSource, start: number, end: number): Promise<Box[]> {
  const out: Box[] = []
  let pos = start
  while (pos + 8 <= end) {
    const header = await bytes(src, pos, Math.min(16, end - pos))
    if (!header || header.length < 8) break
    const size32 = header.readUInt32BE(0)
    if (header.subarray(4, 8).some((c) => c > 127)) break
    const type = header.subarray(4, 8).toString('latin1')
    let body = pos + 8
    let size = size32
    if (size32 === 1) {
      if (header.length < 16) break
      const large = header.readBigUInt64BE(8)
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) break
      size = Number(large)
      body = pos + 16
    } else if (size32 === 0) {
      size = end - pos
    }
    if (size < body - pos || pos + size > end) break
    out.push({ type, start: body, end: pos + size })
    pos += size
  }
  return out
}

async function mp4Child(src: ByteSource, type: string, parent: Box): Promise<Box | undefined> {
  return (await mp4Children(src, parent.start, parent.end)).find((b) => b.type === type)
}

interface SampleTrack {
  stsd: Box
  mdhd: Box
  stbl: Box
}

/** Every `trak` with its sample description, media header and sample table. */
async function sampleTracks(src: ByteSource): Promise<{ moov: boolean; tracks: SampleTrack[] }> {
  const moov = (await mp4Children(src, 0, src.size)).find((b) => b.type === 'moov')
  if (!moov) return { moov: false, tracks: [] }
  const tracks: SampleTrack[] = []
  for (const trak of await mp4Children(src, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue
    const mdia = await mp4Child(src, 'mdia', trak)
    const minf = mdia && (await mp4Child(src, 'minf', mdia))
    const stbl = minf && (await mp4Child(src, 'stbl', minf))
    const stsd = stbl && (await mp4Child(src, 'stsd', stbl))
    const mdhd = mdia && (await mp4Child(src, 'mdhd', mdia))
    if (stbl && stsd && mdhd) tracks.push({ stsd, mdhd, stbl })
  }
  return { moov: true, tracks }
}

/** File offset of the first sample: the first chunk offset from `stco` (32-bit) or `co64` (64-bit). */
async function firstSampleOffset(src: ByteSource, stbl: Box): Promise<number | undefined> {
  const stco = await mp4Child(src, 'stco', stbl)
  if (stco) {
    const n = await be(src, stco.start + 4, 4)
    if (n !== undefined && n > 0) return be(src, stco.start + 8, 4)
  }
  const co64 = await mp4Child(src, 'co64', stbl)
  if (co64) {
    const n = await be(src, co64.start + 4, 4)
    if (n !== undefined && n > 0) return be(src, co64.start + 8, 8)
  }
  return undefined
}

/** QuickTime/MP4 timecode track: quanta, drop-frame flag and frame duration from `stsd`, start frame from sample 0. */
async function tmcdFromTrack(src: ByteSource, t: SampleTrack): Promise<SourceTimecode | undefined> {
  const flags = await be(src, t.stsd.start + 28, 4)
  const timescale = await be(src, t.stsd.start + 32, 4)
  const frameDuration = await be(src, t.stsd.start + 36, 4)
  const quanta = await be(src, t.stsd.start + 40, 1)
  if (flags === undefined || timescale === undefined || frameDuration === undefined || !quanta) return undefined
  const offset = await firstSampleOffset(src, t.stbl)
  const frame = offset === undefined ? undefined : await be(src, offset, 4)
  if (frame === undefined) return undefined
  const tick = frameDuration > 0 && timescale > 0 ? { num: frameDuration, den: timescale } : undefined
  return { frame, quanta, dropFrame: (flags & 1) !== 0, ...(tick ? { tick } : {}) }
}

/** Sony XAVC `rtmd`: the first sample's bytes 13–17 are hh mm ss dropFlag ff. */
async function rtmdFromTrack(src: ByteSource, t: SampleTrack): Promise<SourceTimecode | undefined> {
  const version = await be(src, t.mdhd.start, 1)
  if (version === undefined) return undefined
  const timescale = await be(src, t.mdhd.start + (version === 1 ? 20 : 12), 4)
  const stts = await mp4Child(src, 'stts', t.stbl)
  const delta = stts && (await be(src, stts.start + 12, 4))
  if (!timescale || !delta) return undefined
  const offset = await firstSampleOffset(src, t.stbl)
  const fields = offset === undefined ? undefined : await bytes(src, offset + 13, 5)
  if (!fields) return undefined
  const [hh, mm, ss, drop, ff] = fields
  const quanta = Math.round(timescale / delta)
  if (!(quanta > 0) || hh >= 24 || mm >= 60 || ss >= 60 || ff >= quanta) return undefined
  // Sony time-of-day timecode at 29.97/59.94 is drop-frame whatever the flag byte says; Resolve conforms on that reading.
  const ntsc = delta === 1001 && timescale % 30000 === 0
  const dropFrame = drop !== 0 || (ntsc && quanta % 30 === 0)
  return { frame: displayToFrames(hh, mm, ss, ff, quanta, dropFrame), quanta, dropFrame, tick: { num: delta, den: timescale } }
}

async function stsdType(src: ByteSource, t: SampleTrack): Promise<string | undefined> {
  return fourcc(src, t.stsd.start + 12)
}

/** First `tmcd` track's start timecode (Mac: AVFoundation's first timecode track). */
export async function tmcdTimecode(src: ByteSource): Promise<SourceTimecode | undefined> {
  for (const t of (await sampleTracks(src)).tracks) if ((await stsdType(src, t)) === 'tmcd') return tmcdFromTrack(src, t)
  return undefined
}

export async function rtmdTimecode(src: ByteSource): Promise<SourceTimecode | undefined> {
  for (const t of (await sampleTracks(src)).tracks) {
    if ((await stsdType(src, t)) !== 'rtmd') continue
    const tc = await rtmdFromTrack(src, t)
    if (tc) return tc
  }
  return undefined
}

// ---------- BWF ----------

/** BWF `bext.TimeReference` (samples since midnight) as a sample-based timecode (`quanta` = sample rate). */
export async function bwfTimecode(src: ByteSource): Promise<SourceTimecode | undefined> {
  const magic = await fourcc(src, 0)
  if ((magic !== 'RIFF' && magic !== 'RF64') || (await fourcc(src, 8)) !== 'WAVE') return undefined
  let pos = 12
  let sampleRate = 0
  let timeReference: bigint | undefined
  while (pos + 8 <= src.size) {
    const header = await bytes(src, pos, 8)
    if (!header || header.subarray(0, 4).some((c) => c > 127)) break
    const type = header.subarray(0, 4).toString('latin1')
    const size32 = header.readUInt32LE(4)
    // RF64 jumbo data chunk; fmt/bext precede it.
    if (size32 === 0xffffffff) break
    if (type === 'fmt ') sampleRate = (await bytes(src, pos + 12, 4))?.readUInt32LE(0) ?? 0
    if (type === 'bext' && size32 >= 346) timeReference = (await bytes(src, pos + 8 + 338, 8))?.readBigUInt64LE(0)
    if (sampleRate > 0 && timeReference !== undefined) break
    pos += 8 + size32 + (size32 & 1)
  }
  if (timeReference === undefined || timeReference <= 0n || sampleRate <= 0 || timeReference > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return { frame: Number(timeReference), quanta: sampleRate, dropFrame: false }
}

// ---------- ffprobe fallbacks ----------

export type ProbeRunner = (args: string[]) => Promise<string>

const defaultProbe: ProbeRunner = async (args) => (await run(ffprobePath, args)).toString('utf8')

interface ProbeStream {
  codec_type?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  tags?: Record<string, string>
}

const parseRate = (r?: string): { num: number; den: number } | undefined => {
  const m = r ? /^(\d+)\/(\d+)$/.exec(r) : null
  if (!m) return undefined
  const num = Number(m[1])
  const den = Number(m[2])
  return num > 0 && den > 0 ? { num, den } : undefined
}

/** Timecode string from ffprobe (timecode track, else the video stream / container tag) at the video rate. */
export async function probeTimecode(path: string, probe: ProbeRunner = defaultProbe): Promise<SourceTimecode | undefined> {
  const out = await probe(['-v', 'error', '-print_format', 'json', '-show_entries', 'stream=codec_type,r_frame_rate,avg_frame_rate:stream_tags=timecode:format_tags=timecode', path])
  const info = JSON.parse(out) as { streams?: ProbeStream[]; format?: { tags?: Record<string, string> } }
  const streams = info.streams ?? []
  const data = streams.find((s) => s.codec_type === 'data' && s.tags?.timecode)
  const video = streams.find((s) => s.codec_type === 'video')
  const value = data?.tags?.timecode ?? video?.tags?.timecode ?? info.format?.tags?.timecode
  const rate = parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate) ?? parseRate(data?.avg_frame_rate) ?? parseRate(data?.r_frame_rate)
  if (!value || !rate) return undefined
  const quanta = Math.round(rate.num / rate.den)
  const tc = parseTimecodeString(value, quanta)
  if (!tc) return undefined
  const ntsc = Math.abs(rate.num / rate.den - (quanta * 1000) / 1001) < Math.abs(rate.num / rate.den - quanta)
  return ntsc ? { ...tc, tick: { num: 1001, den: quanta * 1000 } } : tc
}

/** QuickTime `com.apple.quicktime.creationdate`: ISO-8601, or `yyyy-MM-dd'T'HH:mm:ssZZZ`. */
export function parseQuickTimeDate(value: string): Date | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:?\d{2})$/.exec(value.trim())
  if (!m) return undefined
  const zone = m[7] === 'Z' ? 'Z' : `${m[7].slice(0, 3)}:${m[7].slice(-2)}`
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export async function probeCaptureDate(path: string, probe: ProbeRunner = defaultProbe): Promise<Date | undefined> {
  const out = await probe(['-v', 'error', '-print_format', 'json', '-show_entries', 'format_tags=com.apple.quicktime.creationdate', path])
  const value = (JSON.parse(out) as { format?: { tags?: Record<string, string> } }).format?.tags?.['com.apple.quicktime.creationdate']
  return value ? parseQuickTimeDate(value) : undefined
}

// ---------- Public readers ----------

export interface ReadOptions {
  probe?: ProbeRunner
}

/** Embedded start timecode: tmcd ?? rtmd ?? BWF, then ffprobe for tmcd tracks the parser can't decode and non-MP4/WAV containers. */
export async function readSourceTimecode(path: string, options: ReadOptions = {}): Promise<SourceTimecode | undefined> {
  let fallback = false
  try {
    const parsed = await withFileSource(path, async (src) => {
      const { moov, tracks } = await sampleTracks(src)
      let sawTmcd = false
      for (const t of tracks) {
        if ((await stsdType(src, t)) !== 'tmcd') continue
        sawTmcd = true
        const tc = await tmcdFromTrack(src, t)
        if (tc) return tc
        break
      }
      for (const t of tracks) {
        if ((await stsdType(src, t)) !== 'rtmd') continue
        const tc = await rtmdFromTrack(src, t)
        if (tc) return tc
      }
      const bwf = await bwfTimecode(src)
      if (bwf) return bwf
      const isWav = (await fourcc(src, 8)) === 'WAVE'
      fallback = sawTmcd || (!moov && !isWav)
      return undefined
    })
    if (parsed) return parsed
  } catch {
    return undefined
  }
  if (!fallback) return undefined
  try {
    return await probeTimecode(path, options.probe)
  } catch {
    return undefined
  }
}

export async function readCaptureDate(path: string, options: ReadOptions = {}): Promise<Date | undefined> {
  try {
    return await probeCaptureDate(path, options.probe)
  } catch {
    return undefined
  }
}

export async function readSourceTiming(path: string, options: ReadOptions = {}): Promise<SourceTiming> {
  const [timecode, captureDate] = await Promise.all([readSourceTimecode(path, options), readCaptureDate(path, options)])
  return { ...(timecode ? { timecode } : {}), ...(captureDate ? { captureDate } : {}) }
}

/** Start timecodes for media refs (refs without a readable timecode are omitted), bounded concurrency. */
export async function readSourceTimecodes(
  paths: Readonly<Record<string, string>>,
  options: ReadOptions & { concurrency?: number; signal?: AbortSignal } = {},
): Promise<Record<string, SourceTimecode>> {
  const refs = Object.keys(paths)
  const out: Record<string, SourceTimecode> = {}
  let next = 0
  const worker = async () => {
    while (next < refs.length) {
      options.signal?.throwIfAborted()
      const ref = refs[next++]
      const tc = await readSourceTimecode(paths[ref], options)
      if (tc) out[ref] = tc
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 4, refs.length) }, worker))
  options.signal?.throwIfAborted()
  return out
}
