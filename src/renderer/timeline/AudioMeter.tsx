import { useEffect, useRef } from 'react'
import { METER, MeterChannel } from '@core/audio/meter'
import { AudioMeter as M } from '../theme/sizes'
import { previewEngine } from '../state/playback'
import { t } from '../i18n'

const SEGMENT = 2
const REFRESH_MS = 1000 / 30

/**
 * Master L/R meter (05 §6.12, algorithm 07 §3.8 via core/audio/meter.ts): the engine's playback / scrub-grain
 * peaks are ingested at the 30 Hz redraw; level decays 24 dB/s, peak holds 1.5 s then decays 18 dB/s; the
 * clip flag sticks until clicked. Like AudioMeterHub, state is never reset by pause — it just decays.
 */
export function AudioMeter() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const channels = [new MeterChannel(), new MeterChannel()]
    let drawn = ''
    let timer = 0
    const draw = (force = false) => {
      const t = performance.now() / 1000
      const raw = previewEngine()?.meter() ?? []
      channels.forEach((c, ch) => c.ingest(raw[ch] ?? raw[0] ?? 0, t))
      const shown = channels.map((c) => ({ ...c.display(t), clipped: c.clipped }))
      const levels = shown.map((d) => d.level)
      const peaks = shown.map((d) => d.peak)
      const clipped = shown.map((d) => d.clipped)
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      const dpr = window.devicePixelRatio || 1
      // Idle meters (everything at the floor, nothing changed) skip the repaint.
      const key = `${w}x${h}@${dpr}|${levels.map((v) => v.toFixed(1))}|${peaks.map((v) => v.toFixed(1))}|${clipped}`
      if (!force && key === drawn) return
      drawn = key
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      const cs = getComputedStyle(canvas)
      const yFor = (db: number) => ((M.ceilingDb - db) / (M.ceilingDb - M.floorDb)) * h
      for (let ch = 0; ch < 2; ch++) {
        const x = ch * (M.barWidth + 1)
        for (let y = 0; y < h; y += SEGMENT) {
          const db = M.ceilingDb - (y / h) * (M.ceilingDb - M.floorDb)
          const lit = db <= levels[ch] && levels[ch] > METER.floorDb
          ctx.fillStyle = y === 0 && clipped[ch] ? cs.getPropertyValue('--pp-status-error') : !lit ? '#000' : db >= M.redDb ? cs.getPropertyValue('--pp-meter-red') : db >= M.yellowDb ? cs.getPropertyValue('--pp-meter-yellow') : cs.getPropertyValue('--pp-meter-green')
          ctx.fillRect(x, y, M.barWidth, 1)
        }
        if (peaks[ch] > METER.floorDb) {
          ctx.fillStyle = cs.getPropertyValue('--pp-text-primary')
          ctx.fillRect(x, Math.round(yFor(peaks[ch])), M.barWidth, 1)
        }
      }
      ctx.fillStyle = cs.getPropertyValue('--pp-text-muted')
      for (let db = 0; db >= METER.floorDb; db -= 6) ctx.fillRect(2 * M.barWidth + 3, Math.round(yFor(db)), db % 12 === 0 ? 4 : 2, 0.5)
    }
    const loop = () => {
      draw()
      timer = window.setTimeout(loop, REFRESH_MS)
    }
    loop()
    const ro = new ResizeObserver(() => draw(true))
    ro.observe(canvas)
    const reset = () => {
      for (const c of channels) c.clipped = false
      draw(true)
    }
    canvas.addEventListener('click', reset)
    return () => {
      window.clearTimeout(timer)
      ro.disconnect()
      canvas.removeEventListener('click', reset)
    }
  }, [])
  return (
    <div className="pp-tl-meter" data-tip={t('Reset Clipping Indicators')}>
      <canvas ref={ref} />
    </div>
  )
}
