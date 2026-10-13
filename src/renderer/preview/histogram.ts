/**
 * Frame histograms behind the inspector's curve editors (05 §7.7; Mac `VideoEngine.histogramYRGB` / `hueHistogram`).
 * Computed from the preview's last presented (composited, graded) frame, downsampled to about 320×180, and refreshed
 * only while playback is stopped — the last histogram stays drawn during playback, as on the Mac.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { previewEngine, usePlayhead } from '../state/playback'
import { useProject } from '../state/project'

export interface YRGBHistogram {
  y: Float32Array
  r: Float32Array
  g: Float32Array
  b: Float32Array
}

/** Pixel stride that brings `w × h` down to roughly the Mac's 320×180 generator size. */
export function sampleStride(w: number, h: number): number {
  return Math.max(1, Math.floor(Math.sqrt((w * h) / (320 * 180))))
}

/** Luma (Rec.709) + per-channel bins of RGBA8 pixels, all normalized by the single largest bin (Mac). */
export function yrgbHistogram(px: Uint8Array, w: number, h: number, count = 256, stride = sampleStride(w, h)): YRGBHistogram | null {
  if (w <= 0 || h <= 0 || px.length < w * h * 4) return null
  const y = new Float32Array(count)
  const r = new Float32Array(count)
  const g = new Float32Array(count)
  const b = new Float32Array(count)
  const bin = (v: number) => Math.min(count - 1, Math.floor((v / 255) * count))
  for (let row = 0; row < h; row += stride) {
    for (let col = 0; col < w; col += stride) {
      const i = (row * w + col) * 4
      const R = px[i]
      const G = px[i + 1]
      const B = px[i + 2]
      r[bin(R)]++
      g[bin(G)]++
      b[bin(B)]++
      y[bin(0.2126 * R + 0.7152 * G + 0.0722 * B)]++
    }
  }
  let max = 0
  for (let i = 0; i < count; i++) max = Math.max(max, y[i], r[i], g[i], b[i])
  if (max > 0)
    for (let i = 0; i < count; i++) {
      y[i] /= max
      r[i] /= max
      g[i] /= max
      b[i] /= max
    }
  return { y, r, g, b }
}

/** Saturation-weighted hue bins (0 = red), sqrt-compressed after normalizing so small humps stay visible (Mac). */
export function hueHistogram(px: Uint8Array, w: number, h: number, count = 96, stride = sampleStride(w, h)): Float32Array | null {
  if (w <= 0 || h <= 0 || px.length < w * h * 4) return null
  const bins = new Float32Array(count)
  for (let row = 0; row < h; row += stride) {
    for (let col = 0; col < w; col += stride) {
      const i = (row * w + col) * 4
      const r = px[i] / 255
      const g = px[i + 1] / 255
      const b = px[i + 2] / 255
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      const d = mx - mn
      if (d <= 1e-4 || mx <= 1e-4) continue
      let hue = mx === r ? (g - b) / d : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
      hue = (hue / 6) % 1
      if (hue < 0) hue += 1
      bins[Math.min(count - 1, Math.floor(hue * count))] += d / mx
    }
  }
  let max = 0
  for (const v of bins) max = Math.max(max, v)
  if (max > 0) for (let j = 0; j < count; j++) bins[j] = Math.sqrt(bins[j] / max)
  return bins
}

interface HistogramState {
  yrgb: YRGBHistogram | null
  hue: Float32Array | null
}

export const useHistograms = create<HistogramState>(() => ({ yrgb: null, hue: null }))

const THROTTLE_MS = 100
let users = 0
let timer: ReturnType<typeof setTimeout> | null = null
let lastRun = 0
let stopWatching: (() => void) | null = null

function compute(): void {
  timer = null
  lastRun = performance.now()
  if (usePlayhead.getState().playing) return
  let size = { w: 0, h: 0 }
  const px = previewEngine()?.readPresentedRegion?.((w, h) => {
    size = { w, h }
    return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null
  })
  if (!px) return
  useHistograms.setState({ yrgb: yrgbHistogram(px, size.w, size.h), hue: hueHistogram(px, size.w, size.h) })
}

/** Coalesces refresh requests: at most one pass per 100 ms, always with a trailing pass. */
function schedule(delay = 0): void {
  if (!users) return
  const wait = Math.max(delay, THROTTLE_MS - (performance.now() - lastRun))
  if (timer) {
    if (delay <= 0) return
    clearTimeout(timer)
  }
  timer = setTimeout(compute, Math.max(0, wait))
}

function watch(): () => void {
  let engine = previewEngine()
  let unsubFrame = engine?.onFrame(() => schedule()) ?? null
  const rebind = () => {
    const e = previewEngine()
    if (e === engine) return
    unsubFrame?.()
    engine = e
    unsubFrame = e?.onFrame(() => schedule()) ?? null
  }
  const unsubPlayhead = usePlayhead.subscribe((s, p) => {
    rebind()
    if (s.playing) return
    if (s.frame !== p.frame || s.playing !== p.playing) schedule()
  })
  // Doc edits re-render the frame without a seek; sample once the new frame (and its sources) has been drawn.
  const unsubDoc = useProject.subscribe((s, p) => {
    if (s.snapshot === p.snapshot && s.preview === p.preview) return
    rebind()
    schedule(120)
  })
  schedule()
  return () => {
    unsubFrame?.()
    unsubPlayhead()
    unsubDoc()
    if (timer) clearTimeout(timer)
    timer = null
  }
}

/** Keeps the shared histograms fresh while at least one curve editor is mounted. */
export function useFrameHistograms(): HistogramState {
  useEffect(() => {
    if (users++ === 0) stopWatching = watch()
    return () => {
      if (--users === 0) {
        stopWatching?.()
        stopWatching = null
      }
    }
  }, [])
  return useHistograms()
}

/** Closed silhouette of `bins` spanning the canvas width, baseline at the bottom (Mac `histogramPath`). */
export function histogramPath(ctx: CanvasRenderingContext2D, bins: ArrayLike<number>, w: number, h: number): void {
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let i = 0; i < bins.length; i++) ctx.lineTo((i / (bins.length - 1)) * w, h - bins[i] * h)
  ctx.lineTo(w, h)
  ctx.closePath()
}

/** Top contour only (Mac `histogramLine`). */
export function histogramLine(ctx: CanvasRenderingContext2D, bins: ArrayLike<number>, w: number, h: number): void {
  ctx.beginPath()
  for (let i = 0; i < bins.length; i++) {
    const x = (i / (bins.length - 1)) * w
    const y = h - bins[i] * h
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
}
