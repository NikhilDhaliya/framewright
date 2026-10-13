import { useCallback, useState } from 'react'
import type { Clip } from '@core/model'
import type { CurvePoint, GradeCurve } from '@core/ops/grade'
import { clearPreview, commitOp, previewOp } from '../state/ops'
import { Segmented } from '../ui/controls'
import { CurveCanvas, type CssVar } from './CurveCanvas'
import { effectOf } from './effectEdits'
import { authoritativeClip } from './model'
import { histogramPath, useFrameHistograms, type YRGBHistogram } from '../preview/histogram'
import { t } from '../i18n'

type Channel = keyof GradeCurve

const CHANNELS: { value: Channel; label: string; color: string }[] = [
  { value: 'master', label: 'Y', color: '--pp-text-secondary' },
  { value: 'red', label: 'R', color: '--pp-curve-red' },
  { value: 'green', label: 'G', color: '--pp-curve-green' },
  { value: 'blue', label: 'B', color: '--pp-curve-blue' },
]

const IDENTITY: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
]

const isIdentity = (pts: CurvePoint[]) =>
  pts.length === 0 || (pts.length === 2 && Math.abs(pts[0].x) < 1e-4 && Math.abs(pts[0].y) < 1e-4 && Math.abs(pts[1].x - 1) < 1e-4 && Math.abs(pts[1].y - 1) < 1e-4)

function parseCurve(c: Clip | null | undefined): GradeCurve {
  const raw = c ? effectOf(c, 'color.curves')?.params.curve?.string : undefined
  const empty: GradeCurve = { master: [], red: [], green: [], blue: [] }
  if (!raw) return empty
  try {
    const v = JSON.parse(raw) as Partial<GradeCurve>
    return { master: v.master ?? [], red: v.red ?? [], green: v.green ?? [], blue: v.blue ?? [] }
  } catch {
    return empty
  }
}

/** Piecewise-linear evaluation, flat outside the first/last point. */
function evaluate(pts: CurvePoint[], x: number): number {
  if (x <= pts[0].x) return pts[0].y
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    if (x <= b.x) return a.y + ((b.y - a.y) * (x - a.x)) / Math.max(1e-6, b.x - a.x)
  }
  return pts[pts.length - 1].y
}

function background(ctx: CanvasRenderingContext2D, w: number, h: number, v: CssVar, hist: YRGBHistogram | null) {
  ctx.fillStyle = v('--pp-bg-base')
  ctx.fillRect(0, 0, w, h)
  if (hist) {
    // Luma silhouette behind, then the RGB parade additively on top (Mac CurveEditorView).
    ctx.globalAlpha = 0.35
    ctx.fillStyle = v('--pp-text-primary')
    histogramPath(ctx, hist.y, w, h)
    ctx.fill()
    ctx.globalCompositeOperation = 'lighter'
    for (const [bins, color] of [
      [hist.r, '--pp-curve-red'],
      [hist.g, '--pp-curve-green'],
      [hist.b, '--pp-curve-blue'],
    ] as const) {
      ctx.fillStyle = v(color)
      histogramPath(ctx, bins, w, h)
      ctx.fill()
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
  }
  ctx.strokeStyle = v('--pp-border-subtle')
  ctx.lineWidth = 0.5
  ctx.globalAlpha = 0.35
  ctx.beginPath()
  for (let i = 1; i < 4; i++) {
    ctx.moveTo((w * i) / 4, 0)
    ctx.lineTo((w * i) / 4, h)
    ctx.moveTo(0, (h * i) / 4)
    ctx.lineTo(w, (h * i) / 4)
  }
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(0, h)
  ctx.lineTo(w, 0)
  ctx.stroke()
  ctx.setLineDash([])
}

function edits(curve: GradeCurve) {
  const normalized: GradeCurve = { master: [], red: [], green: [], blue: [] }
  for (const k of Object.keys(normalized) as Channel[]) normalized[k] = isIdentity(curve[k]) ? [] : curve[k]
  const identity = (Object.keys(normalized) as Channel[]).every((k) => normalized[k].length === 0)
  return [identity ? { type: 'color.curves', remove: true } : { type: 'color.curves', strings: { curve: JSON.stringify(normalized) } }]
}

/** CurveEditorView (§7.7): Y/R/G/B tone curves stored as one `color.curves` effect; identity is `[]`. */
export function CurveEditor({ clips }: { clips: Clip[] }) {
  const [channel, setChannel] = useState<Channel>('master')
  const ids = clips.map((c) => c.id)
  const stored = parseCurve(clips[0])[channel]
  const withChannel = (pts: CurvePoint[]): GradeCurve => ({ ...parseCurve(authoritativeClip(ids[0])), [channel]: pts })
  const hist = useFrameHistograms().yrgb
  const drawBackground = useCallback((ctx: CanvasRenderingContext2D, w: number, h: number, v: CssVar) => background(ctx, w, h, v, hist), [hist])
  return (
    <div className="pp-insp-curves">
      <Segmented full options={CHANNELS.map((c) => ({ value: c.value, label: c.label }))} value={channel} onChange={setChannel} />
      <CurveCanvas
        points={stored.length ? stored : IDENTITY}
        color={CHANNELS.find((c) => c.value === channel)!.color}
        evaluate={evaluate}
        step={0.02}
        background={drawBackground}
        onChange={(pts) => {
          if (!previewOp('editEffects', { ids, edits: edits(withChannel(pts)) })) clearPreview()
        }}
        onCommit={(pts) => void commitOp('editEffects', { ids, edits: edits(withChannel(pts)), label: 'Adjust Curves' }, { quiet: true })}
        onCancel={clearPreview}
      />
      <span className="pp-insp-hint">{t('Drag to add or shape a point · double-click to remove')}</span>
    </div>
  )
}
