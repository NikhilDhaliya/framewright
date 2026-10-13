/**
 * On-canvas crop drag math (Mac `CropOverlayView.swift` pannedCrop / resizedCrop / resizedCropLocked) and the crop
 * aspect lock helpers (`CropAspectLock`, `CropAspectRatio`). Pure; all values are clip-normalized (0…1).
 */
import { CROP_MIN_VISIBLE, type Crop } from '@core/model'
import type { CropAspectLock } from '../state/editor'
import { t } from '../i18n'

export type Corner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight'

export interface Delta {
  dx: number
  dy: number
}

/** Moves the crop window; it keeps its size and stays inside the source. */
export function pannedCrop(start: Crop, { dx, dy }: Delta): Crop {
  const visW = 1 - start.left - start.right
  const visH = 1 - start.top - start.bottom
  const L = Math.max(0, Math.min(start.left + dx, 1 - visW))
  const T = Math.max(0, Math.min(start.top + dy, 1 - visH))
  return { left: L, top: T, right: 1 - visW - L, bottom: 1 - visH - T }
}

/**
 * Corner resize. `aspectN` = locked pixel aspect ÷ source pixel aspect (the visible width/height ratio in normalized
 * units); null = free. With a lock, the axis moved further (in width-equivalent units) drives the size.
 */
export function resizedCrop(start: Crop, corner: Corner, { dx, dy }: Delta, aspectN: number | null, minVis = CROP_MIN_VISIBLE): Crop {
  if (aspectN !== null && Number.isFinite(aspectN) && aspectN > 0) return resizedCropLocked(start, corner, { dx, dy }, aspectN, minVis)
  let L = start.left
  let T = start.top
  let R = start.right
  let B = start.bottom
  if (corner === 'topLeft' || corner === 'bottomLeft') L += dx
  else R -= dx
  if (corner === 'topLeft' || corner === 'topRight') T += dy
  else B -= dy
  L = Math.max(0, Math.min(L, 1 - minVis - R))
  R = Math.max(0, Math.min(R, 1 - minVis - L))
  T = Math.max(0, Math.min(T, 1 - minVis - B))
  B = Math.max(0, Math.min(B, 1 - minVis - T))
  return { left: L, top: T, right: R, bottom: B }
}

function resizedCropLocked(start: Crop, corner: Corner, { dx, dy }: Delta, aspectN: number, minVis: number): Crop {
  const { left: L, top: T, right: R, bottom: B } = start
  const startVisW = 1 - L - R
  const startVisH = 1 - T - B
  const leftEdge = corner === 'topLeft' || corner === 'bottomLeft'
  const topEdge = corner === 'topLeft' || corner === 'topRight'
  const widthDelta = leftEdge ? -dx : dx
  const heightDelta = topEdge ? -dy : dy
  const sFromW = startVisW + widthDelta
  const sFromH = aspectN * (startVisH + heightDelta)
  let s = Math.abs(widthDelta) > Math.abs(heightDelta * aspectN) ? sFromW : sFromH
  const sMaxFromX = leftEdge ? 1 - R : 1 - L
  const sMaxFromY = topEdge ? aspectN * (1 - B) : aspectN * (1 - T)
  const sMax = Math.min(sMaxFromX, sMaxFromY)
  const sMin = Math.max(minVis, minVis * aspectN)
  if (sMax < sMin) return start
  s = Math.min(Math.max(s, sMin), sMax)
  const visW = s
  const visH = s / aspectN
  const out = { ...start }
  if (leftEdge) out.left = 1 - R - visW
  else out.right = 1 - L - visW
  if (topEdge) out.top = 1 - B - visH
  else out.bottom = 1 - T - visH
  return out
}

/** Normalized aspect for a lock on a source of the given pixel aspect, or null when the lock is not a fixed ratio. */
export function lockedAspectNormalized(lock: CropAspectLock, sourcePixelAspect: number | null): number | null {
  if (lock.kind !== 'fixed' || !sourcePixelAspect || !(sourcePixelAspect > 0)) return null
  return lock.ratio / sourcePixelAspect
}

/** Inspector crop presets (Mac `CropAspectLock.presets` after Freeform and Original). */
export const CROP_RATIO_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '16:9', w: 16, h: 9 },
  { label: '9:16', w: 9, h: 16 },
  { label: '1:1', w: 1, h: 1 },
  { label: '4:3', w: 4, h: 3 },
  { label: '3:4', w: 3, h: 4 },
  { label: '21:9', w: 21, h: 9 },
]

/** `String(format: "%.6g")` for the magnitudes a crop ratio can have. */
const g6 = (v: number) => String(Number(v.toPrecision(6)))

/** `CropAspectLock.locked(to:)`: a preset when the ratio matches one (1e-9), else a custom fixed lock labelled W:H. */
export function lockForRatio(w: number, h: number): CropAspectLock {
  const ratio = w / h
  const preset = CROP_RATIO_PRESETS.find((p) => Math.abs(p.w / p.h - ratio) < 1e-9)
  if (preset) return { kind: 'fixed', ratio: preset.w / preset.h, label: preset.label }
  return { kind: 'fixed', ratio, label: `${g6(w)}:${g6(h)}` }
}

export function lockLabel(lock: CropAspectLock): string {
  return lock.kind === 'free' ? t('Freeform') : lock.kind === 'original' ? t('Original') : lock.label
}

export function sameLock(a: CropAspectLock, b: CropAspectLock): boolean {
  if (a.kind !== b.kind) return false
  return a.kind !== 'fixed' || Math.abs(a.ratio - (b as { ratio: number }).ratio) < 1e-9
}
