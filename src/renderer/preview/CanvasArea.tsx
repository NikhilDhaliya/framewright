import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { fitRect, type Size } from './geometry'
import { setPreviewZoom, usePreviewView } from './view'

interface CanvasAreaProps {
  aspect: number
  /** Renders the canvas content at the fitted (zoomed) size. */
  children: (size: Size, box: () => DOMRect) => ReactNode
  background?: string
  onBackgroundPointerDown?: () => void
}

/** Fits a canvas of the given aspect into the area, with Ctrl+wheel zoom toward the cursor (§5.3). */
export function CanvasArea({ aspect, children, background, onBackgroundPointerDown }: CanvasAreaProps) {
  const areaRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState<Size>({ w: 0, h: 0 })
  const zoom = usePreviewView((s) => s.zoom)
  const offset = usePreviewView((s) => s.offset)

  useLayoutEffect(() => {
    const el = areaRef.current!
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const precise = e.deltaMode === 0 && Math.abs(e.deltaY) < 50
      const factor = Math.exp(-e.deltaY * (precise ? 0.005 : 0.0015))
      setPreviewZoom(usePreviewView.getState().zoom * factor, { point: { x: e.clientX - r.left, y: e.clientY - r.top }, area: { w: r.width, h: r.height } })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }, [])

  const fit = fitRect(area, aspect)
  const size = { w: Math.round(fit.w * zoom), h: Math.round(fit.h * zoom) }
  return (
    <div ref={areaRef} className="pp-canvas-area" onPointerDown={(e) => e.target === e.currentTarget && onBackgroundPointerDown?.()}>
      {size.w > 0 && (
        <div
          ref={boxRef}
          className={`pp-canvas-box${zoom < 1 ? ' outlined' : ''}`}
          style={{ width: size.w, height: size.h, left: (area.w - size.w) / 2 + offset.x, top: (area.h - size.h) / 2 + offset.y, background }}
        >
          {children(size, () => boxRef.current!.getBoundingClientRect())}
        </div>
      )}
    </div>
  )
}
