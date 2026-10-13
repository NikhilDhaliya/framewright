import fs from 'node:fs/promises'
import path from 'node:path'
import { clipTypeForExtension, DEFAULTS, type ClipType } from '../../core/model'
import type { ProbeResult } from '../../shared/api'
import { parseSubtitleBytes } from '../../core/captions/subtitleFileParser'
import { ffprobePath, run } from './ffmpeg'
import { lottieFileMeta } from './lottie'

interface FfStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  r_frame_rate?: string
  pix_fmt?: string
  duration?: string
  tags?: Record<string, string>
  side_data_list?: { rotation?: number }[]
  disposition?: { attached_pic?: number }
}

interface FfFormat {
  duration?: string
  format_name?: string
}

const parseRate = (r?: string): number | undefined => {
  if (!r) return undefined
  const [n, d] = r.split('/').map(Number)
  const v = d ? n / d : n
  return Number.isFinite(v) && v > 0 ? v : undefined
}

const ALPHA_FORMATS = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya)/

export async function ffprobeJson(file: string, signal?: AbortSignal): Promise<{ streams: FfStream[]; format: FfFormat }> {
  const out = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { signal })
  return JSON.parse(out.toString('utf8'))
}

/** Subtitle metadata (spec 07 §1.8, `MediaAsset.swift:247-253`): duration = the last cue end, or 0 if parsing fails. */
async function subtitleDuration(file: string, ext: string): Promise<number> {
  try {
    const cues = parseSubtitleBytes(await fs.readFile(file), ext)
    return Math.max(0, ...cues.map((c) => c.endSeconds))
  } catch {
    return 0
  }
}

export async function probeFile(file: string, signal?: AbortSignal): Promise<ProbeResult> {
  const ext = path.extname(file).slice(1).toLowerCase()
  const declared: ClipType | null = clipTypeForExtension(ext)
  if (declared === 'subtitle') return { type: 'subtitle', duration: await subtitleDuration(file, ext), hasAudio: false, hasVideo: false }
  if (declared === 'lottie') return probeLottie(file)
  const info = await ffprobeJson(file, signal)
  const video = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = info.streams.find((s) => s.codec_type === 'audio')
  const duration = Number(info.format.duration ?? video?.duration ?? audio?.duration ?? 0)
  const imageCodecs = new Set(['png', 'mjpeg', 'jpeg2000', 'webp', 'tiff', 'bmp', 'gif', 'hevc'])
  const isImage = declared === 'image' || (!!video && !audio && (info.format.format_name?.includes('image2') || info.format.format_name?.endsWith('_pipe')) && imageCodecs.has(video.codec_name ?? ''))
  const rotation = video?.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation ?? (video?.tags?.rotate ? Number(video.tags.rotate) : 0)
  const swap = Math.abs(rotation) % 180 === 90
  const width = video ? (swap ? video.height : video.width) : undefined
  const height = video ? (swap ? video.width : video.height) : undefined
  let type: ClipType
  if (isImage) type = 'image'
  else if (video) type = 'video'
  else if (audio) type = 'audio'
  else throw new Error('No audio or video streams.')
  return {
    type,
    duration: type === 'image' ? DEFAULTS.imageDurationSeconds : Number.isFinite(duration) ? duration : 0,
    width,
    height,
    fps: type === 'video' ? parseRate(video?.avg_frame_rate) ?? parseRate(video?.r_frame_rate) : undefined,
    hasAudio: !!audio,
    hasVideo: !!video,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    rotation,
    hasAlpha: !!video?.pix_fmt && ALPHA_FORMATS.test(video.pix_fmt),
  }
}

const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora'])
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8'])
const PLAYABLE_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus'])

/** Whether Chromium can play the file directly; otherwise preview uses a transcoded proxy. */
export function isChromiumPlayable(file: string, p: ProbeResult): boolean {
  if (p.type === 'image') return true
  if (!PLAYABLE_CONTAINERS.has(path.extname(file).toLowerCase())) return false
  if (p.hasVideo && p.type === 'video' && !PLAYABLE_VIDEO.has(p.videoCodec ?? '')) return false
  if (p.hasVideo && p.type === 'video' && p.videoCodec === 'h264' && p.hasAlpha) return false
  if (p.hasAudio && !PLAYABLE_AUDIO.has(p.audioCodec ?? '')) return false
  return true
}

/** Lottie metadata (spec 07 §4.2): comp size, `fr`, and `(op − ip)/fr` seconds; dotLottie reads its first animation. */
async function probeLottie(file: string): Promise<ProbeResult> {
  const m = await lottieFileMeta(file)
  return { type: 'lottie', duration: m.duration, width: Math.trunc(m.width), height: Math.trunc(m.height), fps: m.fps, hasAudio: false, hasVideo: true }
}
