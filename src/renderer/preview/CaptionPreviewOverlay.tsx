/**
 * Caption preview overlay (spec 07 §1.10; Mac `CaptionPreviewOverlay.swift`, `CaptionPreviewRender.swift`): an
 * animated sample caption drawn with the compositor's own text rasterizer, draggable to set the caption centre.
 */
import { useEffect, useRef } from 'react'
import { defaultTransform, newClip, type TextAnimationPreset } from '@core/model'
import { snappedCoordinate } from '@core/captions/specBuilder'
import { textMeasurer, textRaster } from '../render/text'
import { renderMode } from '../render/textAnim'
import { PREVIEW_TEXT, setCaptionForm, useCaptionForm, useCaptionsVisible } from '../media/captions/store'
import { useTimeline } from '../state/project'
import { Icon } from '../ui/Icon'
import type { Size } from './geometry'
import { t } from '../i18n'

/** `loopFrames`: 28 for entrance presets (popIn, slideUp), else 54. */
export const loopFrames = (preset: TextAnimationPreset): number => (renderMode(preset) === 'entrance' ? 28 : 54)

/** Shown when the Captions tab is visible and its Preview switch is on. */
export function useCaptionPreviewShown(): boolean {
  const visible = useCaptionsVisible((s) => s.visible)
  const enabled = useCaptionForm((s) => s.previewEnabled)
  return visible && enabled
}

export function CaptionPreviewOverlay({ size }: { size: Size }) {
  const tl = useTimeline()
  const style = useCaptionForm((s) => s.style)
  const center = useCaptionForm((s) => s.center)
  const preset = useCaptionForm((s) => s.preset)
  const highlight = useCaptionForm((s) => s.highlight)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const canvasW = tl?.width ?? 1920
  const canvasH = tl?.height ?? 1080
  const natural = textMeasurer.measure(PREVIEW_TEXT, style, canvasW, canvasH)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.w < 1 || size.h < 1) return
    const dpr = window.devicePixelRatio || 1
    const W = Math.max(1, Math.round(size.w * dpr))
    const H = Math.max(1, Math.round(size.h * dpr))
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')!
    const loop = loopFrames(preset)
    const clip = newClip({ mediaRef: '', mediaType: 'text', sourceClipType: 'text', startFrame: 0, durationFrames: loop, textContent: PREVIEW_TEXT, textStyle: style, transform: { ...defaultTransform(), width: natural.width, height: natural.height } })
    clip.id = 'caption-preview'
    if (preset !== 'none') clip.textAnimation = { preset, perWordFrames: 6, highlight }
    const dx = (center.x - 0.5) * W
    const dy = (center.y - 0.5) * H
    const started = performance.now()
    let lastKey = ''
    let raf = 0
    const draw = () => {
      const frame = preset === 'none' ? 0 : Math.floor(((performance.now() - started) / 1000) * 30) % loop
      const raster = textRaster(clip, frame, W, H)
      const key = raster ? `${raster.key}|${JSON.stringify(raster.entrance)}` : ''
      if (key !== lastKey) {
        lastKey = key
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, W, H)
        if (raster) {
          const bitmap = raster.draw()
          const e = raster.entrance
          const cx = raster.box.x + raster.box.w / 2 + dx
          const cy = raster.box.y + raster.box.h / 2 + dy
          ctx.globalAlpha = e ? e.opacity : 1
          ctx.translate(cx, cy + (e ? e.scale * e.dy * H : 0))
          if (e) ctx.scale(e.scale, e.scale)
          ctx.translate(-cx, -cy)
          if (style.blur > 0) ctx.filter = `blur(${(style.blur * H) / 1080}px)`
          ctx.drawImage(bitmap, raster.rect.x + dx, raster.rect.y + dy)
          ctx.filter = 'none'
          ctx.globalAlpha = 1
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [size.w, size.h, style, center.x, center.y, preset, highlight, natural.width, natural.height])

  // Drag target: max(30, natural size in view px) per axis, centred on the caption.
  const dragW = Math.max(30, natural.width * size.w)
  const dragH = Math.max(30, natural.height * size.h)
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY, cx: center.x, cy: center.y }
    const move = (ev: PointerEvent) => {
      setCaptionForm({ center: { x: snappedCoordinate(start.cx + (ev.clientX - start.x) / size.w), y: snappedCoordinate(start.cy + (ev.clientY - start.y) / size.h) } })
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div className="pp-cap-preview">
      <canvas ref={canvasRef} />
      {center.x === 0.5 && <div className="pp-cap-preview-guide" style={{ left: '50%', top: 0, bottom: 0, width: 0.5 }} />}
      {center.y === 0.5 && <div className="pp-cap-preview-guide" style={{ top: '50%', left: 0, right: 0, height: 0.5 }} />}
      <div className="pp-cap-preview-drag" style={{ left: center.x * size.w - dragW / 2, top: center.y * size.h - dragH / 2, width: dragW, height: dragH }} onPointerDown={onPointerDown} />
      <span className="pp-cap-preview-tag">
        <Icon sf="captions.bubble" size={10} />
        {t('Preview')}
      </span>
    </div>
  )
}
