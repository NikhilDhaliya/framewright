/** Reference preprocessing with ffmpeg (spec 06 §B4.6, §B4.3): trims, downscales, transcodes, audio extraction. */
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { hasTrim, type TrimmedSource } from '../../core/generation/validation'
import { ffmpeg } from '../media/ffmpeg'
import { ffprobeJson } from '../media/probe'

export const tempPath = (prefix: string, ext: string): string => path.join(os.tmpdir(), `${prefix}-${randomUUID()}.${ext}`)

/** Output fps for trimmed extracts: the source's nominal rate when 24…60, else 30. */
export function extractFps(sourceFps: number | undefined): number {
  const r = Math.round(sourceFps ?? 0)
  return r >= 24 && r <= 60 ? r : 30
}

async function videoFps(file: string, signal?: AbortSignal): Promise<number | undefined> {
  try {
    const p = await ffprobeJson(file, signal)
    const v = p.streams.find((s) => s.codec_type === 'video')
    const [n, d] = String(v?.avg_frame_rate ?? v?.r_frame_rate ?? '').split('/').map(Number)
    return n > 0 && d > 0 ? n / d : undefined
  } catch {
    return undefined
  }
}

/** The clip's visible range as an H.264/AAC mp4 (`trim-<uuid>.mp4`). */
export async function extractTrimmedRange(trim: TrimmedSource, signal?: AbortSignal): Promise<string> {
  const out = tempPath('trim', 'mp4')
  const start = trim.trimStartFrame / trim.fps
  const dur = trim.sourceFramesConsumed / trim.fps
  const fps = extractFps(await videoFps(trim.sourcePath, signal))
  await ffmpeg(
    ['-y', '-ss', start.toFixed(6), '-t', dur.toFixed(6), '-i', trim.sourcePath, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', out],
    { signal },
  )
  return out
}

interface VideoInfo {
  width: number
  height: number
  codec: string
}

async function videoInfo(file: string, signal?: AbortSignal): Promise<VideoInfo | null> {
  const p = await ffprobeJson(file, signal)
  const vids = p.streams.filter((s) => s.codec_type === 'video')
  const v = vids[0]
  if (!v) return null
  const allH264 = vids.every((s) => s.codec_name === 'h264')
  return { width: Number(v.width) || 0, height: Number(v.height) || 0, codec: allH264 ? 'h264' : String(v.codec_name ?? '') }
}

/** Text-to-video reference videos: long side > 1100 px → scaled to 1100 (even dims). Null when no change is needed. */
export async function downscaleReferenceVideo(file: string, signal?: AbortSignal): Promise<string | null> {
  const info = await videoInfo(file, signal)
  if (!info || Math.max(info.width, info.height) <= 1100) return null
  const out = tempPath('refscale', 'mp4')
  await ffmpeg(['-y', '-i', file, '-vf', "scale='if(gt(iw,ih),1100,-2)':'if(gt(iw,ih),-2,1100)'", '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], { signal })
  return out
}

const RESOLUTION_LIMITS: Record<string, [number, number]> = { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] }

/** Edit-model sources: downscale over `maxResolution`, re-encode when H.264 MP4 is required. Null when unchanged. */
export async function transcodeSourceIfNeeded(file: string, maxResolution: string | null | undefined, requiredEncoding: string | null | undefined, signal?: AbortSignal): Promise<string | null> {
  const info = await videoInfo(file, signal)
  if (!info) return null
  const limit = maxResolution ? RESOLUTION_LIMITS[maxResolution] : undefined
  const long = Math.max(info.width, info.height)
  const short = Math.min(info.width, info.height)
  const tooBig = !!limit && (long > limit[0] || short > limit[1])
  const needsH264 = requiredEncoding === 'h264-mp4' && !(path.extname(file).toLowerCase() === '.mp4' && info.codec === 'h264')
  if (!tooBig && !needsH264) return null
  const out = tempPath('source', 'mp4')
  const args = ['-y', '-i', file]
  if (tooBig && limit) {
    const scale = Math.min(limit[0] / long, limit[1] / short)
    const w = Math.max(2, Math.floor((info.width * scale) / 2) * 2)
    const h = Math.max(2, Math.floor((info.height * scale) / 2) * 2)
    args.push('-vf', `scale=${w}:${h}`)
  }
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', out)
  await ffmpeg(args, { signal })
  return out
}

/** HEIC/HEIF/TIFF references → full-resolution JPEG (q ≈ 0.92). */
export async function convertImageToJpeg(file: string, signal?: AbortSignal): Promise<string> {
  const out = tempPath('ref', 'jpg')
  await ffmpeg(['-y', '-i', file, '-frames:v', '1', '-q:v', '2', out], { signal })
  return out
}

/** Audio track as AAC m4a, trimmed when a trim is pending (§B4.3). */
export async function extractAudioTrack(file: string, trim: TrimmedSource | null | undefined, signal?: AbortSignal): Promise<string> {
  const p = await ffprobeJson(file, signal).catch(() => null)
  if (p && !p.streams.some((s) => s.codec_type === 'audio')) throw new Error('Audio extraction failed: source has no audio track')
  const out = tempPath('audio', 'm4a')
  const args = ['-y']
  if (hasTrim(trim)) args.push('-ss', (trim.trimStartFrame / trim.fps).toFixed(6), '-t', (trim.sourceFramesConsumed / trim.fps).toFixed(6))
  args.push('-i', file, '-vn', '-c:a', 'aac', out)
  await ffmpeg(args, { signal })
  return out
}
