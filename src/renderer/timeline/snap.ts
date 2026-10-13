import { endFrame } from '@core/clip'
import type { Timeline } from '@core/model'
import { Snap } from '../theme/sizes'
import { beatSnapFrames } from '@core/audio/beats'
import { audioState } from '../audio/store'

export interface SnapTarget {
  frame: number
  kind: 'playhead' | 'clipEdge' | 'marker' | 'beat'
}

export interface SnapResult {
  frame: number
  probeOffset: number
}

/** Sticky snap state, reset at every drag start. */
export class Snapper {
  private snapped: number | null = null
  private probe = 0

  constructor(private readonly targets: SnapTarget[]) {}

  /** §13 findSnap; callers moving an object use `frame - probeOffset` as the new start. */
  find(position: number, probes: number[], ppf: number): SnapResult | null {
    const base = Snap.thresholdPixels / ppf
    if (this.snapped !== null) {
      const p = position + this.probe
      if (Math.abs(p - this.snapped) <= base * Snap.stickyMultiplier && this.targets.some((t) => t.frame === this.snapped)) return { frame: this.snapped, probeOffset: this.probe }
      this.snapped = null
      this.probe = 0
    }
    let best: { o: number; t: SnapTarget; d: number } | null = null
    for (const o of probes) {
      for (const t of this.targets) {
        const thr = t.kind === 'playhead' ? base * Snap.playheadMultiplier : base
        const d = Math.abs(position + o - t.frame)
        if (d <= thr && d < (best?.d ?? Infinity)) best = { o, t, d }
      }
    }
    if (!best) return null
    this.snapped = best.t.frame
    this.probe = best.o
    return { frame: best.t.frame, probeOffset: best.o }
  }
}

export function snapTargets(t: Timeline, opts: { playhead?: number; exclude?: Set<string>; markers?: boolean; excludeMarker?: string }): SnapTarget[] {
  const out: SnapTarget[] = []
  if (opts.playhead !== undefined) out.push({ frame: opts.playhead, kind: 'playhead' })
  if (opts.markers !== false) {
    for (const m of t.markers) {
      if (m.id === opts.excludeMarker) continue
      out.push({ frame: m.startFrame, kind: 'marker' })
      if (m.durationFrames > 0) out.push({ frame: m.startFrame + m.durationFrames, kind: 'marker' })
    }
  }
  for (const tr of t.tracks) {
    for (const c of tr.clips) {
      if (opts.exclude?.has(c.id)) continue
      out.push({ frame: c.startFrame, kind: 'clipEdge' }, { frame: endFrame(c), kind: 'clipEdge' })
      // Beat snap targets (03 §13): only with Mark Beats on, never for nested carriers.
      const beats = audioState().markBeats && c.sourceClipType !== 'sequence' ? audioState().beats[c.mediaRef] : undefined
      if (beats) for (const f of beatSnapFrames(c, beats, t.fps)) out.push({ frame: f, kind: 'beat' })
    }
  }
  return out
}
