import { defaultCrop, defaultTransform, type Crop, type Transform } from '../model'

export interface LayoutRect {
  x: number
  y: number
  w: number
  h: number
}

export interface LayoutSlot {
  id: string
  rect: LayoutRect
  z: number
}

export const VIDEO_LAYOUTS = [
  'full',
  'side_by_side',
  'top_bottom',
  'pip_bottom_right',
  'pip_bottom_left',
  'pip_top_right',
  'pip_top_left',
  'grid_2x2',
  'grid_3x3',
  'grid_4x4',
  'main_sidebar',
  'three_up',
  'three_stack',
] as const
export type VideoLayout = (typeof VIDEO_LAYOUTS)[number]

export const isVideoLayout = (v: string): v is VideoLayout => (VIDEO_LAYOUTS as readonly string[]).includes(v)

const PIP_INSET = 0.28
const PIP_MARGIN = 0.035

const slot = (id: string, x: number, y: number, w: number, h: number, z = 0): LayoutSlot => ({ id, rect: { x, y, w, h }, z })

function grid(n: number): LayoutSlot[] {
  const size = 1 / n
  const out: LayoutSlot[] = []
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) out.push(slot(`r${row + 1}c${col + 1}`, col * size, row * size, size, size))
  return out
}

const pip = (x: number, y: number): LayoutSlot[] => [slot('main', 0, 0, 1, 1, 0), slot('inset', x, y, PIP_INSET, PIP_INSET, 1)]

export function layoutSlots(layout: VideoLayout): LayoutSlot[] {
  const far = 1 - PIP_MARGIN - PIP_INSET
  const third = 1 / 3
  switch (layout) {
    case 'full':
      return [slot('main', 0, 0, 1, 1)]
    case 'side_by_side':
      return [slot('left', 0, 0, 0.5, 1), slot('right', 0.5, 0, 0.5, 1)]
    case 'top_bottom':
      return [slot('top', 0, 0, 1, 0.5), slot('bottom', 0, 0.5, 1, 0.5)]
    case 'pip_bottom_right':
      return pip(far, far)
    case 'pip_bottom_left':
      return pip(PIP_MARGIN, far)
    case 'pip_top_right':
      return pip(far, PIP_MARGIN)
    case 'pip_top_left':
      return pip(PIP_MARGIN, PIP_MARGIN)
    case 'grid_2x2':
      return grid(2)
    case 'grid_3x3':
      return grid(3)
    case 'grid_4x4':
      return grid(4)
    case 'main_sidebar':
      return [slot('main', 0, 0, 0.7, 1), slot('sidebar', 0.7, 0, 0.3, 1)]
    case 'three_up':
      return [slot('left', 0, 0, third, 1), slot('center', third, 0, third, 1), slot('right', third * 2, 0, third, 1)]
    case 'three_stack':
      return [slot('top', 0, 0, 1, third), slot('middle', 0, third, 1, third), slot('bottom', 0, third * 2, 1, third)]
  }
}

export type LayoutFit = 'fill' | 'fit'

export interface PixelSize {
  width: number
  height: number
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function transformAt(x: number, y: number, w: number, h: number): Transform {
  return { ...defaultTransform(), centerX: x + w / 2, centerY: y + h / 2, width: w, height: h }
}

/** Crop insets that make the visible source match `target` pixel aspect, biased by the anchor. */
export function cropFittingAspect(source: PixelSize | null, target: number, anchorX = 0.5, anchorY = 0.5): Crop {
  if (!source || !(source.width > 0 && source.height > 0) || !(target > 0)) return defaultCrop()
  const sourceAspect = source.width / source.height
  if (Math.abs(sourceAspect - target) < 0.0001) return defaultCrop()
  if (sourceAspect > target) {
    const total = 1 - target / sourceAspect
    const left = total * clamp01(anchorX)
    return { left, top: 0, right: total - left, bottom: 0 }
  }
  const total = 1 - sourceAspect / target
  const top = total * clamp01(anchorY)
  return { left: 0, top, right: 0, bottom: total - top }
}

/** Transform + crop framing a source into a canvas-normalized slot (cover or letterbox). */
export function layoutPlacement(
  source: PixelSize | null,
  canvas: PixelSize,
  rect: LayoutRect,
  fit: LayoutFit,
  anchorX = 0.5,
  anchorY = 0.5,
): { transform: Transform; crop: Crop } {
  const canvasAspect = canvas.width / Math.max(1, canvas.height)
  if (fit === 'fill') {
    const slotPixelAspect = rect.h > 0 ? (rect.w / rect.h) * canvasAspect : canvasAspect
    const crop = cropFittingAspect(source, slotPixelAspect, anchorX, anchorY)
    const vw = 1 - crop.left - crop.right
    const vh = 1 - crop.top - crop.bottom
    if (!(vw > 0 && vh > 0)) return { transform: transformAt(rect.x, rect.y, rect.w, rect.h), crop }
    const w = rect.w / vw
    const h = rect.h / vh
    return { transform: transformAt(rect.x - crop.left * w, rect.y - crop.top * h, w, h), crop }
  }
  const rel = source && source.width > 0 && source.height > 0 && canvas.width > 0 && canvas.height > 0 ? source.width / source.height / (canvas.width / canvas.height) : null
  if (!rel || !(rel > 0)) return { transform: transformAt(rect.x, rect.y, rect.w, rect.h), crop: defaultCrop() }
  const [drawW, drawH] = rel * rect.h <= rect.w ? [rel * rect.h, rect.h] : [rect.w, rect.w / rel]
  const x = rect.x + (rect.w - drawW) * clamp01(anchorX)
  const y = rect.y + (rect.h - drawH) * clamp01(anchorY)
  return { transform: transformAt(x, y, drawW, drawH), crop: defaultCrop() }
}
