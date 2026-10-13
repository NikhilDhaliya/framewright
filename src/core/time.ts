const twoDigit = (v: number): string => (v >= 0 && v < 10 ? `0${v}` : `${v}`)

export function formatTimecode(frame: number, fps: number): string {
  if (fps <= 0) return '00:00:00:00'
  const abs = Math.abs(frame)
  const totalSeconds = Math.floor(abs / fps)
  const ff = abs % fps
  const ss = totalSeconds % 60
  const mm = Math.floor(totalSeconds / 60) % 60
  const hh = Math.floor(totalSeconds / 3600)
  return `${frame < 0 ? '-' : ''}${twoDigit(hh)}:${twoDigit(mm)}:${twoDigit(ss)}:${twoDigit(ff)}`
}

export function parseTimecode(value: string, fps: number): number | null {
  const fields = value.split(':')
  if (fps < 1 || fps > 1000 || fields.length !== 4) return null
  const nums = fields.map((f) => (/^-?\d+$/.test(f) ? Number(f) : NaN))
  const [h, m, s, f] = nums
  if (nums.some(Number.isNaN)) return null
  if (h < 0 || h >= 1000 || m < 0 || m >= 60 || s < 0 || s >= 60 || f < 0 || f >= fps) return null
  return (h * 3600 + m * 60 + s) * fps + f
}

export const secondsToFrame = (seconds: number, fps: number): number => Math.trunc(seconds * fps)
export const frameToSeconds = (frame: number, fps: number): number => frame / fps

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${m}:${twoDigit(s % 60)}`
}
