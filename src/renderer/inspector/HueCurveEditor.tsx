import { useCallback, useState } from 'react'
import type { Clip } from '@core/model'
import type { CurvePoint, HueCurves } from '@core/ops/grade'
import { clearPreview, commitOp, previewOp } from '../state/ops'
import { Segmented } from '../ui/controls'
import { CurveCanvas, type CssVar } from './CurveCanvas'
import { effectOf } from './effectEdits'
import { authoritativeClip } from './model'
import { histogramLine, histogramPath, useFrameHistograms } from '../preview/histogram'
import { t } from '../i18n'

type Channel = keyof HueCurves

const TYPE = 'color.hueCurves'
const NEUTRAL_Y = 0.5
const DEFAULT_POINTS: CurvePoint[] = Array.from({ length: 6 }, (_, k) => ({ x: k / 6, y: NEUTRAL_Y }))
const SPECTRUM = ['#FF3B30', '#F2D933', '#4DD959', '#33CCD9', '#4080F2', '#CC59E6', '#FF3B30']

const CHANNELS: { value: Channel; label: string }[] = [
  { value: 'hueVsHue', label: t('Hue') },
  { value: 'hueVsSat', label: t('Sat') },
  { value: 'hueVsLum', label: t('Luma') },
]

const isNeutral = (pts: CurvePoint[]) => pts.length === 0 || pts.every((p) => Math.abs(p.y - NEUTRAL_Y) < 1e-4)

function parseHueCurves(c: Clip | null | undefined): HueCurves {
  const empty: HueCurves = { hueVsHue: [], hueVsSat: [], hueVsLum: [] }
  const raw = c ? effectOf(c, TYPE)?.params.curves?.string : undefined
  if (!raw) return empty
  try {
    const v = JSON.parse(raw) as Partial<HueCurves>
    return { hueVsHue: v.hueVsHue ?? [], hueVsSat: v.hueVsSat ?? [], hueVsLum: v.hueVsLum ?? [] }
  } catch {
    return empty
  }
}

const lerp = (a: CurvePoint, b: CurvePoint, x: number) => a.y + (b.x === a.x ? 0 : ((b.y - a.y) * (x - a.x)) / (b.x - a.x))

/** Cyclic piecewise-linear evaluation that wraps across the hue seam. */
function evaluate(pts: CurvePoint[], x: number): number {
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (x < first.x) return lerp({ x: last.x - 1, y: last.y }, first, x)
  for (let i = 1; i < pts.length; i++) if (x <= pts[i].x) return lerp(pts[i - 1], pts[i], x)
  return lerp(last, { x: first.x + 1, y: first.y }, x)
}

function background(ctx: CanvasRenderingContext2D, w: number, h: number, v: CssVar, hist: Float32Array | null) {
  const g = ctx.createLinearGradient(0, 0, w, 0)
  SPECTRUM.forEach((c, i) => g.addColorStop(i / (SPECTRUM.length - 1), c))
  ctx.fillStyle = v('--pp-bg-base')
  ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = 0.35
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)
  if (hist && hist.length > 1) {
    // Hue histogram: white @ 0.15 fill, white @ 0.8 top line, 1 px (Mac HueCurveEditorView).
    ctx.globalAlpha = 0.15
    ctx.fillStyle = '#fff'
    histogramPath(ctx, hist, w, h)
    ctx.fill()
    ctx.globalAlpha = 0.8
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    histogramLine(ctx, hist, w, h)
    ctx.stroke()
    ctx.globalAlpha = 0.35
  }
  ctx.strokeStyle = v('--pp-border-subtle')
  ctx.lineWidth = 0.5
  ctx.beginPath()
  for (let k = 1; k < 6; k++) {
    ctx.moveTo((w * k) / 6, 0)
    ctx.lineTo((w * k) / 6, h)
  }
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()
  ctx.setLineDash([])
}

function edits(curves: HueCurves) {
  const out: HueCurves = { hueVsHue: [], hueVsSat: [], hueVsLum: [] }
  for (const k of Object.keys(out) as Channel[]) out[k] = isNeutral(curves[k]) ? [] : curves[k]
  const identity = (Object.keys(out) as Channel[]).every((k) => out[k].length === 0)
  return [identity ? { type: TYPE, remove: true } : { type: TYPE, strings: { curves: JSON.stringify(out) } }]
}

/** HueCurveEditorView (§7.7): hue-vs-hue/sat/luma curves on a spectrum background. */
export function HueCurveEditor({ clips }: { clips: Clip[] }) {
  const [channel, setChannel] = useState<Channel>('hueVsHue')
  const ids = clips.map((c) => c.id)
  const stored = parseHueCurves(clips[0])[channel]
  const withChannel = (pts: CurvePoint[]): HueCurves => ({ ...parseHueCurves(authoritativeClip(ids[0])), [channel]: pts })
  const hist = useFrameHistograms().hue
  const drawBackground = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number, v: CssVar) => background(ctx, w, h, v, hist), [hist])
  return (
    <div className="pp-insp-curves">
      <Segmented options={CHANNELS} value={channel} onChange={setChannel} className="pp-insp-hue-modes" />
      <CurveCanvas
        points={stored.length ? [...stored].sort((a, b) => a.x - b.x) : DEFAULT_POINTS}
        color="--pp-text-primary"
        evaluate={evaluate}
        step={0.01}
        background={drawBackground}
        onChange={(pts) => {
          if (!previewOp('editEffects', { ids, edits: edits(withChannel(pts)) })) clearPreview()
        }}
        onCommit={(pts) => void commitOp('editEffects', { ids, edits: edits(withChannel(pts)), label: 'Adjust Hue Curves' }, { quiet: true })}
        onCancel={clearPreview}
      />
      <span className="pp-insp-hint">{t('Drag to add or shape a point · double-click to remove')}</span>
    </div>
  )
}
