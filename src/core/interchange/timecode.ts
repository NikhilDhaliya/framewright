/**
 * Source timecode values and SMPTE arithmetic (spec 07 §6.0; Mac `Utilities/SourceTimecode.swift`,
 * `XMLExporter.timecodeTags` / `formatTimecode`).
 */
import { swiftRound } from '../keyframes'
import { pad2 } from './printf'

/** A source's start timecode: `frame` counted at `quanta` frames per second (samples per second for BWF). */
export interface SourceTimecode {
  frame: number
  quanta: number
  dropFrame: boolean
  /** Exact seconds per timecode frame (1001/30000 for NTSC); absent = 1/quanta. */
  tick?: { num: number; den: number }
}

/** Per-file sync signals: embedded SMPTE timecode and/or the recording-start capture date. */
export interface SourceTiming {
  timecode?: SourceTimecode
  captureDate?: Date
}

/** Start time as exact rational seconds (num/den), using the NTSC tick when present. */
export function rationalSeconds(tc: SourceTimecode): { num: number; den: number } {
  if (tc.quanta <= 0) return { num: 0, den: 1 }
  if (tc.tick && tc.tick.num > 0 && tc.tick.den > 0) return { num: tc.frame * tc.tick.num, den: tc.tick.den }
  return { num: tc.frame, den: tc.quanta }
}

export function timecodeSeconds(tc: SourceTimecode): number {
  const r = rationalSeconds(tc)
  return r.num / r.den
}

/** Start timecode in `fps`-frame units. */
export function timecodeFramesAt(tc: SourceTimecode, fps: number): number {
  if (tc.quanta <= 0) return 0
  return swiftRound((tc.frame / tc.quanta) * fps)
}

/** Frame numbers drop-frame timecode skips per minute (2 at 30, 4 at 60). */
export const dropFrameCount = (fps: number): number => swiftRound(fps * 0.066666)

/** Displayed HH:MM:SS:FF fields → raw frame count, removing the frame numbers drop-frame skips. */
export function displayToFrames(hh: number, mm: number, ss: number, ff: number, quanta: number, dropFrame: boolean): number {
  let frame = (hh * 3600 + mm * 60 + ss) * quanta + ff
  if (dropFrame) {
    const mins = hh * 60 + mm
    frame -= dropFrameCount(quanta) * (mins - Math.trunc(mins / 10))
  }
  return frame
}

/** Frame count → SMPTE string; drop-frame uses `;` separators and skips the dropped frame numbers. */
export function formatSmpteTimecode(frame: number, fps: number, dropFrame: boolean): string {
  if (fps <= 0) return '00:00:00:00'
  let f = frame
  if (dropFrame) {
    const drop = dropFrameCount(fps)
    const perMinute = fps * 60 - drop
    const per10 = perMinute * 10 + drop
    const d = Math.trunc(f / per10)
    const m = f % per10
    f += drop * 9 * d + (m > drop ? drop * Math.trunc((m - drop) / perMinute) : 0)
  }
  const sep = dropFrame ? ';' : ':'
  const ff = f % fps
  const ss = Math.trunc(f / fps) % 60
  const mm = Math.trunc(f / (fps * 60)) % 60
  const hh = Math.trunc(f / (fps * 3600))
  return [hh, mm, ss, ff].map(pad2).join(sep)
}

/** FCP7 `<rate>` fields for a real frame rate: `ntsc` when the rate is closer to `timebase·1000/1001`. */
export function rateTags(rawFps: number): { timebase: number; ntsc: boolean } {
  const timebase = Math.max(1, swiftRound(rawFps))
  const ntscRate = (timebase * 1000) / 1001
  return { timebase, ntsc: Math.abs(rawFps - ntscRate) < Math.abs(rawFps - timebase) }
}

export interface TimecodeTags {
  base: number
  ntsc: boolean
  frame: number
  dropFrame: boolean
  string: string
}

/** XMEML `<file><timecode>` fields from the embedded timecode, else 00:00:00:00 at the video rate. */
export function timecodeTags(source: SourceTimecode | undefined, videoTimebase: number, videoNtsc: boolean): TimecodeTags {
  if (source && source.quanta > 240) {
    // BWF time references count samples; rescale to the video rate.
    const effectiveFps = videoNtsc ? (videoTimebase * 1000) / 1001 : videoTimebase
    const dropFrame = videoNtsc && videoTimebase % 30 === 0
    const frame = swiftRound(timecodeSeconds(source) * effectiveFps)
    return { base: videoTimebase, ntsc: videoNtsc, frame, dropFrame, string: formatSmpteTimecode(frame, videoTimebase, dropFrame) }
  }
  const base = source?.quanta ?? videoTimebase
  const dropFrame = source?.dropFrame ?? (videoNtsc && videoTimebase % 30 === 0)
  const ntsc = dropFrame ? true : videoNtsc
  const frame = source?.frame ?? 0
  return { base, ntsc, frame, dropFrame, string: formatSmpteTimecode(frame, base, dropFrame) }
}

/** Parses an `HH:MM:SS:FF` timecode string (`;` before the frames = drop-frame) at `quanta` fps. */
export function parseTimecodeString(value: string, quanta: number): SourceTimecode | undefined {
  const m = /^(\d{1,2})[:;](\d{2})[:;](\d{2})([:;])(\d{1,3})$/.exec(value.trim())
  if (!m || !(quanta > 0)) return undefined
  const [hh, mm, ss, ff] = [m[1], m[2], m[3], m[5]].map(Number)
  if (hh >= 24 || mm >= 60 || ss >= 60 || ff >= quanta) return undefined
  const dropFrame = m[4] === ';'
  return { frame: displayToFrames(hh, mm, ss, ff, quanta, dropFrame), quanta, dropFrame }
}
