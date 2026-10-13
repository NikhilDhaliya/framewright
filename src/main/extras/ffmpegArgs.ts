/**
 * FFmpeg argument builders for Save as Media / Save as Audio / Extract Audio (spec 07 §6.3). Pure, unit-tested.
 * The Mac (`exportClipRange`) inserts the source range `[trimStart, +sourceFramesConsumed]` (fps timescale) and, for
 * speed ≠ 1, scales it to `durationFrames` (audio pitch not preserved). FFmpeg mimics that with `setpts` and a
 * pitch-shifting `asetrate` + `aresample`.
 */

export interface ClipRangeSpec {
  source: string
  output: string
  fps: number
  trimStartFrame: number
  sourceFramesConsumed: number
  durationFrames: number
  speed: number
  mediaType: 'video' | 'audio'
  /** Sample rate of the source's first audio stream (needed for speed changes); 0/undefined = no audio. */
  sampleRate?: number
  /** Whether the source has an audio stream (video exports map it when present). */
  hasAudio: boolean
}

/** Decimal seconds without float noise (FFmpeg accepts plain decimals). */
export function seconds(v: number): string {
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6)
  return s.replace(/\.?0+$/, '') || '0'
}

const ratio = (v: number): string => (Math.round(v * 1e9) / 1e9).toString()

const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
const AAC = ['-c:a', 'aac', '-b:a', '256k']

/** The time-stretch factor timeline/source (`scaleTimeRange([0, sourceFrames] → durationFrames)`); 1 at speed 1. */
export function stretchFactor(s: Pick<ClipRangeSpec, 'speed' | 'sourceFramesConsumed' | 'durationFrames'>): number {
  if (s.speed === 1) return 1
  return Math.max(1, s.durationFrames) / Math.max(1, s.sourceFramesConsumed)
}

export function clipRangeArgs(s: ClipRangeSpec): string[] {
  const fps = Math.max(1, s.fps)
  const sourceFrames = Math.max(1, s.sourceFramesConsumed)
  const k = stretchFactor(s)
  const args = ['-y', '-ss', seconds(s.trimStartFrame / fps), '-t', seconds(sourceFrames / fps), '-i', s.source]
  const audioFilter = k !== 1 && s.sampleRate ? ['-af', `asetrate=${Math.round(s.sampleRate / k)},aresample=${s.sampleRate}`] : []
  if (s.mediaType === 'video') {
    args.push('-map', '0:v:0', '-map', '0:a:0?')
    // libx264 4:2:0 needs even dimensions; a no-op for the usual sizes.
    args.push('-vf', [...(k !== 1 ? [`setpts=PTS*${ratio(k)}`] : []), EVEN].join(','))
    if (s.hasAudio) args.push(...audioFilter)
    args.push('-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', ...AAC, '-movflags', '+faststart', s.output)
  } else {
    args.push('-map', '0:a:0', '-vn', ...audioFilter, ...AAC, s.output)
  }
  return args
}

/** Whole-file first audio track → `.m4a`; AAC sources are stream-copied. */
export function extractAudioArgs(source: string, output: string, audioCodec: string | undefined): string[] {
  return ['-y', '-i', source, '-map', '0:a:0', '-vn', ...(audioCodec === 'aac' ? ['-c:a', 'copy'] : AAC), output]
}
