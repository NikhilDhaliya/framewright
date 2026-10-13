// Port of the Mac Tests/PalmierProTests/SourceTimecodeReaderTests.swift (synthetic rtmd/BWF containers), plus tmcd,
// 64-bit/sparse-file, ffprobe-fallback and real ffmpeg-authored files.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { formatSmpteTimecode, timecodeSeconds, timecodeTags } from '../../src/core/interchange'
import {
  bufferSource,
  bwfTimecode,
  parseQuickTimeDate,
  probeTimecode,
  readCaptureDate,
  readSourceTimecode,
  readSourceTimecodes,
  rtmdTimecode,
  tmcdTimecode,
  withFileSource,
} from '../../src/main/media/sourceTimecode'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'palmier-tc-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const u32 = (v: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v)
  return b
}
const u32le = (v: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v)
  return b
}
const box = (type: string, body: Buffer) => Buffer.concat([u32(8 + body.length), Buffer.from(type, 'ascii'), body])
const zeros = (n: number) => Buffer.alloc(n)

/** Mac `rtmdFile`: moov(trak(mdia(mdhd + minf(stbl(stsd rtmd, stts, stco))))) + mdat with one rtmd sample. */
function rtmdFile(timescale: number, delta: number, hh: number, mm: number, ss: number, drop: number, ff: number): Buffer {
  const mdhd = Buffer.concat([zeros(4), u32(0), u32(0), u32(timescale), u32(0), zeros(4)])
  const stsd = box('stsd', Buffer.concat([u32(0), u32(1), box('rtmd', zeros(8))]))
  const stts = box('stts', Buffer.concat([u32(0), u32(1), u32(1), u32(delta)]))
  const sample = Buffer.concat([zeros(13), Buffer.from([hh, mm, ss, drop, ff])])
  const fixedPrefix = 8 + 8 + 8 + 8 + mdhd.length + 8 + 8 + stsd.length + stts.length + 8 + 12 + 8
  const stco = box('stco', Buffer.concat([u32(0), u32(1), u32(fixedPrefix)]))
  const stbl = box('stbl', Buffer.concat([stsd, stts, stco]))
  const moov = box('moov', box('trak', box('mdia', Buffer.concat([box('mdhd', mdhd), box('minf', stbl)]))))
  return Buffer.concat([moov, box('mdat', sample)])
}

/** tmcd track: stsd entry (reserved, flags, timescale, frameDuration, numberOfFrames) + one BE32 frame sample. */
function tmcdFile(o: { flags: number; timescale: number; frameDuration: number; quanta: number; frame: number }): Buffer {
  const entry = Buffer.concat([zeros(6), Buffer.from([0, 1]), zeros(4), u32(o.flags), u32(o.timescale), u32(o.frameDuration), Buffer.from([o.quanta, 0])])
  const stsd = box('stsd', Buffer.concat([u32(0), u32(1), box('tmcd', entry)]))
  const mdhd = box('mdhd', Buffer.concat([zeros(4), u32(0), u32(0), u32(o.timescale), u32(0), zeros(4)]))
  const build = (offset: number) => {
    const stbl = box('stbl', Buffer.concat([stsd, box('stco', Buffer.concat([u32(0), u32(1), u32(offset)]))]))
    return box('moov', box('trak', box('mdia', Buffer.concat([mdhd, box('minf', stbl)]))))
  }
  const moovLen = build(0).length
  return Buffer.concat([build(moovLen + 8), box('mdat', u32(o.frame))])
}

const chunk = (type: string, body: Buffer) => Buffer.concat([Buffer.from(type, 'ascii'), u32le(body.length), body, body.length % 2 ? zeros(1) : zeros(0)])

function bwfFile(sampleRate: number, timeReference: bigint, magic = 'RIFF'): Buffer {
  const fmt = Buffer.concat([Buffer.from([1, 0, 2, 0]), u32le(sampleRate), zeros(8)])
  const ref = Buffer.alloc(8)
  ref.writeBigUInt64LE(timeReference)
  const bext = Buffer.concat([zeros(338), ref, zeros(260)])
  return chunk(magic, Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('bext', bext), chunk('data', zeros(16))]))
}

describe('SourceTimingReader containers (Mac SourceTimecodeReaderTests)', () => {
  const rtmd = (b: Buffer) => rtmdTimecode(bufferSource(b))
  const bwf = (b: Buffer) => bwfTimecode(bufferSource(b))

  it('mac: ntscRtmdIsDropFrameDespiteClearFlag', async () => {
    const raw = (14 * 60 + 44) * 60 - 4 * (14 - 1)
    expect(await rtmd(rtmdFile(60000, 1001, 0, 14, 44, 0, 0))).toEqual({ frame: raw, quanta: 60, dropFrame: true, tick: { num: 1001, den: 60000 } })
  })

  it('mac: integerRateRtmdHonorsClearDropFlag', async () => {
    expect(await rtmd(rtmdFile(60000, 1000, 1, 2, 3, 0, 4))).toEqual({ frame: (3600 + 120 + 3) * 60 + 4, quanta: 60, dropFrame: false, tick: { num: 1000, den: 60000 } })
  })

  it('mac: rtmdDropFrameConvertsDisplayToRawFrames', async () => {
    const tc = await rtmd(rtmdFile(60000, 1001, 14, 34, 12, 1, 58))
    expect(tc).toBeDefined()
    expect(tc!.quanta).toBe(60)
    expect(tc!.dropFrame).toBe(true)
    expect(formatSmpteTimecode(tc!.frame, 60, true)).toBe('14;34;12;58')
  })

  it('mac: rtmdRejectsInvalidFields', async () => {
    expect(await rtmd(rtmdFile(30000, 1001, 0, 0, 1, 0, 77))).toBeUndefined()
  })

  it('mac: fileWithoutRtmdTrackReturnsNil', async () => {
    const moov = box('moov', box('trak', box('mdia', zeros(0))))
    expect(await rtmd(Buffer.concat([moov, box('mdat', zeros(0))]))).toBeUndefined()
    expect(await rtmd(Buffer.from('RIFFxxxxWAVE'))).toBeUndefined()
    expect(await rtmd(zeros(0))).toBeUndefined()
  })

  it('mac: bwfTimeReferenceBecomesSampleTimecode', async () => {
    const tc = await bwf(bwfFile(48000, 172_800_000n))
    expect(tc).toEqual({ frame: 172_800_000, quanta: 48000, dropFrame: false })
    expect(timecodeSeconds(tc!)).toBe(3600)
  })

  it('mac: rf64MagicIsAccepted', async () => {
    const tc = await bwf(bwfFile(48000, 2_529_397_698n, 'RF64'))
    expect(timecodeSeconds(tc!)).toBe(2_529_397_698 / 48000)
  })

  it('mac: zeroTimeReferenceAndNonWavReturnNil', async () => {
    expect(await bwf(bwfFile(48000, 0n))).toBeUndefined()
    expect(await bwf(Buffer.from('RIFFxxxxAVI '))).toBeUndefined()
    expect(await bwf(zeros(0))).toBeUndefined()
  })

  it('mac: wavWithoutBextReturnsNil', async () => {
    const fmt = Buffer.concat([Buffer.from([1, 0, 2, 0]), u32le(48000), zeros(8)])
    expect(await bwf(chunk('RIFF', Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', zeros(16))])))).toBeUndefined()
  })

  it('mac: sampleBasedTimecodeRescalesToVideoRate', () => {
    const tc = timecodeTags({ frame: 172_800_000, quanta: 48000, dropFrame: false }, 25, false)
    expect(tc.base).toBe(25)
    expect(tc.frame).toBe(90000)
    expect(tc.string).toBe('01:00:00:00')
  })

  it('mac: sampleBasedTimecodeAgainstNtscRate', () => {
    const tc = timecodeTags({ frame: 172_800_000, quanta: 48000, dropFrame: false }, 30, true)
    expect(tc.base).toBe(30)
    expect(tc.dropFrame).toBe(true)
    expect(tc.frame).toBe(107892)
    expect(tc.string).toBe('01;00;00;00')
  })
})

describe('tmcd reader', () => {
  it('reads quanta, drop-frame flag, NTSC tick and the first sample frame', async () => {
    const tc = await tmcdTimecode(bufferSource(tmcdFile({ flags: 1, timescale: 30000, frameDuration: 1001, quanta: 30, frame: 107892 })))
    expect(tc).toEqual({ frame: 107892, quanta: 30, dropFrame: true, tick: { num: 1001, den: 30000 } })
  })

  it('reads a 64-bit mdat and co64 offset beyond 4 GiB with positional reads (sparse file)', async () => {
    const file = path.join(dir, 'huge.mov')
    const mdatSize = 2 ** 32 + 4096
    const mdatHeader = Buffer.concat([u32(1), Buffer.from('mdat'), Buffer.alloc(8)])
    mdatHeader.writeBigUInt64BE(BigInt(mdatSize), 8)
    const sampleOffset = mdatSize - 8
    const entry = Buffer.concat([zeros(6), Buffer.from([0, 1]), zeros(4), u32(0), u32(25), u32(1), Buffer.from([25, 0])])
    const co64 = Buffer.alloc(16)
    co64.writeUInt32BE(1, 4)
    co64.writeBigUInt64BE(BigInt(sampleOffset), 8)
    const stbl = box('stbl', Buffer.concat([box('stsd', Buffer.concat([u32(0), u32(1), box('tmcd', entry)])), box('co64', co64)]))
    const moov = box('moov', box('trak', box('mdia', Buffer.concat([box('mdhd', Buffer.concat([zeros(4), u32(0), u32(0), u32(25), u32(0), zeros(4)])), box('minf', stbl)]))))
    const fd = fs.openSync(file, 'w')
    fs.writeSync(fd, mdatHeader, 0, mdatHeader.length, 0)
    fs.writeSync(fd, u32(90000), 0, 4, sampleOffset)
    fs.writeSync(fd, moov, 0, moov.length, mdatSize)
    fs.closeSync(fd)
    expect(fs.statSync(file).size).toBeGreaterThan(2 ** 32)
    expect(await withFileSource(file, tmcdTimecode)).toEqual({ frame: 90000, quanta: 25, dropFrame: false, tick: { num: 1, den: 25 } })
    expect(await readSourceTimecode(file)).toEqual({ frame: 90000, quanta: 25, dropFrame: false, tick: { num: 1, den: 25 } })
  })

  it('reads every container type through readSourceTimecode and skips files without timecode', async () => {
    const files = {
      t: ['t.mov', tmcdFile({ flags: 0, timescale: 24, frameDuration: 1, quanta: 24, frame: 86400 })],
      r: ['r.mp4', rtmdFile(30000, 1001, 1, 0, 0, 0, 0)],
      w: ['w.wav', bwfFile(48000, 172_800_000n)],
      n: ['n.mp4', Buffer.concat([box('moov', box('trak', box('mdia', zeros(0)))), box('mdat', zeros(4))])],
    } as const
    const paths: Record<string, string> = {}
    for (const [ref, [name, data]] of Object.entries(files)) {
      paths[ref] = path.join(dir, name)
      fs.writeFileSync(paths[ref], data)
    }
    paths.gone = path.join(dir, 'missing.mov')
    const probe = async () => {
      throw new Error('ffprobe must not run for MP4/WAV files without timecode')
    }
    const tcs = await readSourceTimecodes(paths, { probe })
    expect(Object.keys(tcs).sort()).toEqual(['r', 't', 'w'])
    expect(tcs.t).toEqual({ frame: 86400, quanta: 24, dropFrame: false, tick: { num: 1, den: 24 } })
    expect(tcs.r).toEqual({ frame: 107892, quanta: 30, dropFrame: true, tick: { num: 1001, den: 30000 } })
    expect(tcs.w.quanta).toBe(48000)
  })
})

describe('ffprobe fallbacks', () => {
  it('parses a timecode track string at the video rate (drop-frame, NTSC tick)', async () => {
    const probe = async () =>
      JSON.stringify({ streams: [{ codec_type: 'video', avg_frame_rate: '30000/1001', r_frame_rate: '30000/1001' }, { codec_type: 'data', r_frame_rate: '0/0', tags: { timecode: '01:00:00;00' } }], format: {} })
    expect(await probeTimecode('/x.mxf', probe)).toEqual({ frame: 107892, quanta: 30, dropFrame: true, tick: { num: 1001, den: 30000 } })
  })

  it('uses the ffprobe fallback for containers the box walker does not read', async () => {
    const file = path.join(dir, 'clip.mkv')
    fs.writeFileSync(file, Buffer.from('\x1aE\xdf\xa3 not mp4'))
    const probe = async () => JSON.stringify({ streams: [{ codec_type: 'video', avg_frame_rate: '25/1' }], format: { tags: { timecode: '10:00:00:00' } } })
    expect(await readSourceTimecode(file, { probe })).toEqual({ frame: 900000, quanta: 25, dropFrame: false })
  })

  it('parses QuickTime creation dates (ISO-8601 and ±HHMM offsets)', async () => {
    expect(parseQuickTimeDate('2024-05-01T12:34:56Z')?.toISOString()).toBe('2024-05-01T12:34:56.000Z')
    expect(parseQuickTimeDate('2024-05-01T12:34:56+0200')?.toISOString()).toBe('2024-05-01T10:34:56.000Z')
    expect(parseQuickTimeDate('2024-05-01T12:34:56-05:00')?.toISOString()).toBe('2024-05-01T17:34:56.000Z')
    expect(parseQuickTimeDate('yesterday')).toBeUndefined()
    const probe = async () => JSON.stringify({ format: { tags: { 'com.apple.quicktime.creationdate': '2023-01-02T03:04:05+0000' } } })
    expect((await readCaptureDate('/x.mov', { probe }))?.toISOString()).toBe('2023-01-02T03:04:05.000Z')
  })
})

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!hasFfmpeg)('ffmpeg-authored media', () => {
  const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' })

  it('reads a drop-frame tmcd track written by ffmpeg -timecode (29.97 MOV)', async () => {
    const file = path.join(dir, 'df.mov')
    ff('-f', 'lavfi', '-i', 'testsrc=d=0.5:r=30000/1001:s=64x36', '-timecode', '01:00:00;00', '-c:v', 'mpeg4', file)
    const tc = await readSourceTimecode(file)
    expect(tc).toMatchObject({ frame: 107892, quanta: 30, dropFrame: true })
    expect(timecodeTags(tc, 30, true).string).toBe('01;00;00;00')
    expect(await probeTimecode(file)).toMatchObject({ frame: 107892, quanta: 30, dropFrame: true })
  })

  it('reads a non-drop tmcd track at 25 fps', async () => {
    const file = path.join(dir, 'ndf.mov')
    ff('-f', 'lavfi', '-i', 'testsrc=d=0.5:r=25:s=64x36', '-timecode', '10:11:12:13', '-c:v', 'mpeg4', file)
    const tc = await readSourceTimecode(file)
    expect(tc).toMatchObject({ frame: (10 * 3600 + 11 * 60 + 12) * 25 + 13, quanta: 25, dropFrame: false })
    // The tick is the track's raw frameDuration/timescale (ffmpeg writes 512/12800), as CoreMedia reports it.
    expect(tc!.tick!.num / tc!.tick!.den).toBe(1 / 25)
  })

  it('reads the bext time reference of a BWF written by ffmpeg', async () => {
    const file = path.join(dir, 'bwf.wav')
    ff('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '0.2', '-write_bext', '1', '-metadata', 'time_reference=172800000', file)
    expect(await readSourceTimecode(file)).toEqual({ frame: 172_800_000, quanta: 48000, dropFrame: false })
  })

  it('reads the QuickTime creation date through ffprobe', async () => {
    const file = path.join(dir, 'dated.mov')
    ff('-f', 'lavfi', '-i', 'testsrc=d=0.2:r=25:s=64x36', '-metadata', 'com.apple.quicktime.creationdate=2022-03-04T05:06:07+0000', '-movflags', 'use_metadata_tags', '-c:v', 'mpeg4', file)
    expect((await readCaptureDate(file))?.toISOString()).toBe('2022-03-04T05:06:07.000Z')
  })

  it('returns nothing for media without timecode', async () => {
    const file = path.join(dir, 'plain.mp4')
    ff('-f', 'lavfi', '-i', 'testsrc=d=0.2:r=25:s=64x36', '-c:v', 'mpeg4', file)
    expect(await readSourceTimecode(file)).toBeUndefined()
  })
})
