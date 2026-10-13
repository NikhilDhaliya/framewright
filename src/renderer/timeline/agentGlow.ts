/**
 * Draws the agent activity glows (Mac `TimelineView.syncAgentActivityLayers`): a faint fill over the read range,
 * then slate (read), green (added) and orange (mutated) rings with a soft glow around clips. Everything sits
 * below the ruler. The canvas' opacity carries the hold/fade animation (see TimelineView).
 */
import type { Timeline } from '@core/model'
import { Trim } from '../theme/sizes'
import type { AgentActivity } from './agentActivity'
import { clipRect, RULER_H, type TrackLayout } from './geometry'

export const AGENT_COLORS = {
  read: '#64748B',
  readFill: 'rgba(100, 116, 139, 0.08)',
  addedVar: '--pp-system-green',
  mutatedVar: '--pp-system-orange',
}

interface GlowView {
  t: Timeline
  layouts: TrackLayout[]
  ppf: number
  scrollX: number
  scrollY: number
  width: number
  height: number
}

const cssVar = (name: string, fallback: string): string => {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

function withAlpha(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
  return color
}

function ring(ctx: CanvasRenderingContext2D, v: GlowView, ids: ReadonlySet<string>, color: string, lineWidth: number, glowOpacity: number, glowRadius: number): void {
  if (!ids.size) return
  ctx.beginPath()
  let any = false
  for (const l of v.layouts) {
    for (const c of v.t.tracks[l.index].clips) {
      if (!ids.has(c.id)) continue
      const r = clipRect(c, l, v.ppf)
      const x = r.x - v.scrollX + 0.5
      const y = r.y - v.scrollY + 0.5
      const w = r.w - 1
      const h = r.h - 1
      if (w <= 0 || h <= 0 || x > v.width || x + w < 0 || y > v.height || y + h < RULER_H) continue
      ctx.roundRect(x, y, w, h, Trim.clipCornerRadius)
      any = true
    }
  }
  if (!any) return
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  // CALayer shadowRadius is a blur radius; canvas shadowBlur is about twice the Gaussian sigma.
  ctx.shadowColor = withAlpha(color, glowOpacity)
  ctx.shadowBlur = glowRadius * 2
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.shadowColor = 'transparent'
}

export function drawAgentGlows(ctx: CanvasRenderingContext2D, v: GlowView, a: AgentActivity): void {
  ctx.clearRect(0, 0, v.width, v.height)
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, RULER_H, v.width, Math.max(0, v.height - RULER_H))
  ctx.clip()
  if (a.range) {
    const x0 = a.range[0] * v.ppf - v.scrollX
    const x1 = a.range[1] * v.ppf - v.scrollX
    ctx.fillStyle = AGENT_COLORS.readFill
    ctx.fillRect(x0, RULER_H, Math.max(1.5, x1 - x0), v.height - RULER_H)
  }
  ring(ctx, v, a.readClipIds, AGENT_COLORS.read, 1.5, 0.35, 4)
  ring(ctx, v, a.addedClipIds, cssVar(AGENT_COLORS.addedVar, '#32d74b'), 2, 0.8, 8)
  ring(ctx, v, a.mutatedClipIds, cssVar(AGENT_COLORS.mutatedVar, '#ff9f0a'), 2, 0.8, 8)
  ctx.restore()
}
