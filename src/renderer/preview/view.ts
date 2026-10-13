import { create } from 'zustand'
import { PreviewZoom } from '../theme/sizes'
import type { Point } from './geometry'

/** Canvas zoom (1 = Fit) and pan offset; local view state. */
export const usePreviewView = create<{ zoom: number; offset: Point }>(() => ({ zoom: 1, offset: { x: 0, y: 0 } }))

export function setPreviewZoom(zoom: number, anchor?: { point: Point; area: { w: number; h: number } }): void {
  const s = usePreviewView.getState()
  const z = Math.min(PreviewZoom.max, Math.max(PreviewZoom.min, zoom))
  if (z <= 1 || !anchor) {
    usePreviewView.setState({ zoom: z, offset: z <= 1 ? { x: 0, y: 0 } : s.offset })
    return
  }
  const k = z / s.zoom
  const cx = anchor.area.w / 2
  const cy = anchor.area.h / 2
  const px = anchor.point.x - cx
  const py = anchor.point.y - cy
  usePreviewView.setState({ zoom: z, offset: { x: px - (px - s.offset.x) * k, y: py - (py - s.offset.y) * k } })
}
