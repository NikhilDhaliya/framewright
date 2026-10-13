/** FFmpeg argument lists for video/audio export (spec 04 §11.4). Pure. */
import type { ExportFormat, ExportOptions } from '../../shared/api'

export type Quality = NonNullable<ExportOptions['quality']>
export type VideoCodec = 'h264' | 'hevc' | 'prores' | 'vp9' | 'hevc_hdr'

/** Codec ids that select HEVC 10-bit HDR (HLG); QuickTime only, like the Mac (04 §11.1). */
export const isHdrCodec = (codec?: string): boolean => /^hevc[-_ ]?(10[-_ ]?bit[-_ ]?)?hdr$|^hdr$|^hlg$/.test((codec ?? '').toLowerCase())

/** Container / codec a format encodes to (null for non-video formats). */
export function videoCodecFor(format: ExportFormat, codec?: string): VideoCodec | null {
  const c = (codec ?? '').toLowerCase()
  if (isHdrCodec(c)) return format === 'mov' ? 'hevc_hdr' : null
  const hevc = c === 'hevc' || c === 'h265' || c === 'x265'
  switch (format) {
    case 'mp4':
      return hevc ? 'hevc' : 'h264'
    case 'mov':
      return hevc ? 'hevc' : c === 'h264' || c === 'avc' ? 'h264' : 'prores'
    case 'webm':
      return 'vp9'
    default:
      return null
  }
}

/** Full-range RGB → limited BT.709 Y'CbCr, no transfer change (§11.4). */
const SDR_VF = 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int'
const TAGS = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv']

const CRF: Record<VideoCodec, Record<Quality, number>> = {
  h264: { low: 28, medium: 23, high: 18, max: 14 },
  hevc: { low: 30, medium: 26, high: 22, max: 18 },
  vp9: { low: 40, medium: 34, high: 30, max: 24 },
  prores: { low: 0, medium: 0, high: 0, max: 0 },
  hevc_hdr: { low: 30, medium: 26, high: 22, max: 18 },
}

/**
 * SDR composite (full-range RGB, treated as Rec.709) → BT.2100 HLG, 10-bit limited 4:2:0 (04 §11.4; the Mac's
 * Core Image 709 → itur_2100_HLG conversion). 100 % white lands at 10-bit code ≈ 721 (≈ 75 % HLG).
 */
export const HLG_VF = 'format=gbrpf32le,zscale=tin=bt709:pin=bt709:min=gbr:rin=full:t=arib-std-b67:p=bt2020:m=bt2020nc:r=limited:npl=203,format=yuv420p10le'
const HLG_TAGS = ['-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-color_range', 'tv']

export interface VideoEncodeSpec {
  format: ExportFormat
  codec?: string
  width: number
  height: number
  fps: number
  quality?: Quality
  /** 48 kHz stereo mix to mux, or null for no audio stream. */
  audioPath: string | null
  output: string
}

const rawInput = (w: number, h: number, fps: number) => ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${w}x${h}`, '-framerate', String(fps), '-i', 'pipe:0']

export function videoEncoderArgs(s: VideoEncodeSpec): string[] {
  const codec = videoCodecFor(s.format, s.codec)
  if (!codec) throw new Error(`${s.format} is not a video format`)
  const q = s.quality ?? 'high'
  const mp = (s.width * s.height) / 1e6
  const args = ['-hide_banner', '-loglevel', 'error', '-y', ...rawInput(s.width, s.height, s.fps)]
  if (s.audioPath) args.push('-i', s.audioPath, '-map', '0:v:0', '-map', '1:a:0')
  else args.push('-map', '0:v:0')
  args.push('-fps_mode', 'cfr')
  const container = s.format === 'mov' ? 'mov' : s.format === 'webm' ? 'webm' : 'mp4'
  switch (codec) {
    case 'h264': {
      const b = Math.max(1, Math.round(5040 * mp))
      const cap = q === 'max' ? [] : ['-maxrate', `${Math.trunc((b * 3) / 2)}k`, '-bufsize', `${b * 2}k`]
      args.push('-vf', `${SDR_VF},format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-crf', String(CRF.h264[q]), ...cap, '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709')
      break
    }
    case 'hevc': {
      const b = Math.max(1, Math.round(2560 * mp))
      const vbv = q === 'max' ? '' : `vbv-maxrate=${Math.trunc((b * 3) / 2)}:vbv-bufsize=${b * 2}:`
      args.push('-vf', `${SDR_VF},format=yuv420p`, '-c:v', 'libx265', '-preset', 'medium', '-crf', String(CRF.hevc[q]), '-tag:v', 'hvc1', '-x265-params', `${vbv}colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited:log-level=error`)
      break
    }
    case 'hevc_hdr': {
      const b = Math.max(1, Math.round(3600 * mp))
      const vbv = q === 'max' ? '' : `vbv-maxrate=${Math.trunc((b * 3) / 2)}:vbv-bufsize=${b * 2}:`
      args.push('-vf', HLG_VF, '-c:v', 'libx265', '-preset', 'medium', '-profile:v', 'main10', '-crf', String(CRF.hevc_hdr[q]), '-tag:v', 'hvc1', '-x265-params', `${vbv}colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:range=limited:log-level=error`)
      break
    }
    case 'prores':
      args.push('-vf', `${SDR_VF},format=yuv422p10le`, '-c:v', 'prores_ks', '-profile:v', q === 'max' ? '3' : '2', '-vendor', 'apl0')
      break
    case 'vp9':
      args.push('-vf', `${SDR_VF},format=yuv420p`, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(CRF.vp9[q]), '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4')
      break
  }
  args.push(...(codec === 'hevc_hdr' ? HLG_TAGS : TAGS))
  if (s.audioPath) {
    if (codec === 'prores') args.push('-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2')
    else if (codec === 'vp9') args.push('-c:a', 'libopus', '-b:a', '160k', '-ar', '48000', '-ac', '2')
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
  }
  if (container === 'mp4') args.push('-movflags', '+faststart')
  args.push('-f', container, s.output)
  return args
}

/** Lossless intermediate for GIF (palette passes run afterwards). */
export function gifIntermediateArgs(width: number, height: number, fps: number, output: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', ...rawInput(width, height, fps), '-map', '0:v:0', '-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0', '-f', 'matroska', output]
}

export function gifPaletteArgs(intermediate: string, palette: string): string[] {
  return ['-y', '-i', intermediate, '-vf', 'palettegen=stats_mode=diff', '-frames:v', '1', '-update', '1', palette]
}

export function gifEncodeArgs(intermediate: string, palette: string, output: string): string[] {
  return ['-y', '-i', intermediate, '-i', palette, '-lavfi', '[0:v][1:v]paletteuse=dither=sierra2_4a', '-loop', '0', '-f', 'gif', output]
}

/** Even output size (§11.1 `exportRenderSize`, Q17: always encode at the requested size). */
export function outputSize(o: Pick<ExportOptions, 'width' | 'height'>, tlW: number, tlH: number, even = true): { width: number; height: number } {
  const fix = (v: number) => (even ? Math.max(2, Math.trunc(Math.round(v) / 2) * 2) : Math.max(1, Math.round(v)))
  const ok = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v) && v > 0
  if (ok(o.width) && ok(o.height)) return { width: fix(o.width), height: fix(o.height) }
  if (ok(o.width)) return { width: fix(o.width), height: fix((o.width * tlH) / tlW) }
  if (ok(o.height)) return { width: fix((o.height * tlW) / tlH), height: fix(o.height) }
  return { width: fix(tlW), height: fix(tlH) }
}
