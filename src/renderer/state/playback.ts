import { create } from 'zustand'
import { totalFrames } from '@core/timeline'
import type { PreviewEngine } from '../render/types'
import { getTimeline } from './project'

interface PlayheadState {
  frame: number
  playing: boolean
}

/** High-frequency playhead state; subscribe narrowly (or imperatively) to avoid re-rendering panels. */
export const usePlayhead = create<PlayheadState>(() => ({ frame: 0, playing: false }))

/** Preview playback rate (Playback Speed menu, spec 05 §5.6). */
export const usePlaybackRate = create<{ rate: number }>(() => ({ rate: 1 }))

let engine: PreviewEngine | null = null
let engineSubs: (() => void)[] = []
let fallbackRaf = 0
let reportTimer = 0
let resumeAfterScrub = false

export const playheadFrame = (): number => usePlayhead.getState().frame
export const isPlaying = (): boolean => usePlayhead.getState().playing

function endFrame(): number {
  const t = getTimeline()
  return t ? Math.max(0, totalFrames(t)) : 0
}

const clampFrame = (f: number) => Math.max(0, Math.min(endFrame(), Math.round(f)))

function report(frame: number): void {
  window.clearTimeout(reportTimer)
  reportTimer = window.setTimeout(() => window.palmier.project.setUi({ playheadFrame: frame }), 200)
}

function setFrame(frame: number): void {
  if (usePlayhead.getState().frame !== frame) usePlayhead.setState({ frame })
  report(frame)
}

export function attachEngine(e: PreviewEngine): void {
  detachEngine()
  engine = e
  engineSubs = [
    e.onFrame((f) => setFrame(f)),
    e.onPlayStateChange((playing) => usePlayhead.setState({ playing })),
  ]
  e.setPlaybackRate(usePlaybackRate.getState().rate)
  e.seek(usePlayhead.getState().frame)
}

export function detachEngine(): void {
  for (const u of engineSubs) u()
  engineSubs = []
  engine = null
}

export const previewEngine = (): PreviewEngine | null => engine

/** Committed seek (exact frame). */
export function seek(frame: number, audible = false): void {
  const f = clampFrame(frame)
  setFrame(f)
  engine?.seek(f, { audible })
}

export function setPlaybackRate(rate: number): void {
  usePlaybackRate.setState({ rate })
  engine?.setPlaybackRate(rate)
}

/** Low-latency seek while scrubbing. */
export function scrub(frame: number): void {
  const f = clampFrame(frame)
  setFrame(f)
  engine?.scrub(f)
}

/** Pauses for an interactive scrub; `endScrub` resumes playback if it was running. */
export function beginScrub(): void {
  resumeAfterScrub = isPlaying()
  if (resumeAfterScrub) pause()
}

export function endScrub(): void {
  seek(playheadFrame())
  if (resumeAfterScrub) play()
  resumeAfterScrub = false
}

function runFallbackClock(): void {
  const fps = getTimeline()?.fps ?? 30
  let last = performance.now()
  let acc = playheadFrame()
  const tick = (now: number) => {
    if (!usePlayhead.getState().playing) return
    acc += ((now - last) / 1000) * fps * usePlaybackRate.getState().rate
    last = now
    const end = endFrame()
    if (acc >= end) {
      setFrame(end)
      usePlayhead.setState({ playing: false })
      return
    }
    setFrame(Math.floor(acc))
    fallbackRaf = requestAnimationFrame(tick)
  }
  fallbackRaf = requestAnimationFrame(tick)
}

export function play(): void {
  if (isPlaying()) return
  if (playheadFrame() >= endFrame()) seek(0)
  if (engine) engine.play()
  else {
    usePlayhead.setState({ playing: true })
    runFallbackClock()
  }
}

export function pause(): void {
  if (!isPlaying()) return
  if (engine) engine.pause()
  else {
    cancelAnimationFrame(fallbackRaf)
    usePlayhead.setState({ playing: false })
  }
}

export function togglePlay(): void {
  if (isPlaying()) pause()
  else play()
}

/** Arrow-key step: pauses, then moves by `delta` frames with an audible scrub of the frame. */
export function step(delta: number): void {
  pause()
  seek(playheadFrame() + delta, true)
}
