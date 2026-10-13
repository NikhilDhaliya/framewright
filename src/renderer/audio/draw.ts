/** Audio-clip overlays (05 §6.5 items 5 and 19): the dead-air wash and beat/downbeat ticks. */
import { beatTicks } from '@core/audio/beats'
import { rgbaCss } from '@core/audio/speakers'
import { fadeMultiplier, linearToDb, rawVolumeAt } from '@core/clip'
import { waveform } from '../timeline/mediaCache'
import type { Clip } from '@core/model'
import { getDoc } from '../state/project'
import { audioState, autoIdentifySpeakers, beatsFor, deadAirResolver, quietMaskFor } from './store'

interface Body {
  x: number
  y: number
  w: number
  h: number
}

interface SceneLike {
  t: { fps: number }
  ppf: number
  width: number
}

function rgba(color: string, a: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const n = parseInt(color.slice(1), 16)
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
  }
  const m = /rgba?\(([^)]+)\)/.exec(color)
  if (!m) return color
  const [r, g, b] = m[1].split(',').map((x) => x.trim())
  return `rgba(${r},${g},${b},${a})`
}

/** `--pp-status-error` @ 0.35 over every pixel column whose span lies in dead air (drawn under the waveform). */
export function drawDeadAirWash(ctx: CanvasRenderingContext2D, c: Clip, body: Body, clipX: number, s: SceneLike, errorColor: string): void {
  if (!audioState().markDeadAir || c.mediaType !== 'audio') return
  const q = quietMaskFor(c.mediaRef)
  const doc = getDoc()
  if (!q || !doc) return
  const ranges = deadAirResolver(doc).ranges(c, s.t.fps)
  if (!ranges.length) return
  ctx.fillStyle = rgba(errorColor || '#ff453a', 0.35)
  for (const r of ranges) {
    const x0 = Math.max(body.x, Math.floor(clipX + (r.start - c.startFrame) * s.ppf))
    const x1 = Math.min(body.x + body.w, Math.ceil(clipX + (r.end - c.startFrame) * s.ppf), s.width)
    if (x1 > x0) ctx.fillRect(x0, body.y, x1 - x0, body.h)
  }
}

const ORANGE = '#FF9F0A'

/** Beat ticks from the body top: downbeats 1×14 solid, beats 1×7 @ 0.7, each on a black @ 0.55 backing. */
export function drawBeatTicks(ctx: CanvasRenderingContext2D, c: Clip, body: Body, clipX: number, s: SceneLike): void {
  if (!audioState().markBeats || c.mediaType !== 'audio' || body.h <= 28) return
  const a = beatsFor(c.mediaRef)
  if (!a) return
  const fps = s.t.fps
  const end = c.startFrame + c.durationFrames
  let lastX = -Infinity
  for (const tick of beatTicks(a)) {
    const src = tick.t * fps - c.trimStartFrame
    if (src < 0) continue
    const f = c.startFrame + src / Math.max(c.speed, 1e-4)
    if (f < c.startFrame || f >= end) continue
    const x = Math.round(clipX + (f - c.startFrame) * s.ppf)
    if (x < body.x || x >= body.x + body.w || x >= s.width) continue
    if (!tick.down && x - lastX < 4) continue
    const h = tick.down ? 14 : 7
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(x - 1, body.y, 3, h + 1)
    ctx.fillStyle = tick.down ? ORANGE : rgba(ORANGE, 0.7)
    ctx.fillRect(x, body.y, 1, h)
    lastX = x
  }
}

/**
 * Speaker tint (05 §6.5 item 5): re-draws the waveform bars of columns whose source cell has a speaker in that
 * speaker's colour @ 0.80 (same bar maths as the timeline waveform).
 */
export function drawSpeakerTint(ctx: CanvasRenderingContext2D, c: Clip, body: Body, clipX: number, s: SceneLike): void {
  const st = audioState()
  autoIdentifySpeakers()
  if (!st.markSpeakers || c.mediaType !== 'audio' || body.h <= 4) return
  const mask = st.speakerMasks[c.mediaRef]
  const doc = getDoc()
  const w = waveform(c.mediaRef)
  if (!mask?.runs.length || !doc || !w) return
  const colors = new Map((doc.file.speakers ?? []).map((sp) => [sp.id, rgbaCss(sp.color, 0.8)]))
  const fps = s.t.fps
  const maxH = body.h - 2
  const x0 = Math.max(Math.floor(body.x), 0)
  const x1 = Math.min(Math.ceil(body.x + body.w), s.width)
  let run = 0
  for (let x = x0; x < x1; x++) {
    const f0 = (x - clipX) / s.ppf
    const srcSec = (c.trimStartFrame + f0 * c.speed) / fps
    const cell = Math.floor(srcSec / 0.032)
    while (run < mask.runs.length && mask.runs[run][1] <= cell) run++
    const r = mask.runs[run]
    if (!r || cell < r[0]) continue
    const color = colors.get(r[2])
    if (!color) continue
    const f1 = (x + 1 - clipX) / s.ppf
    const i0 = Math.floor(srcSec * w.samplesPerSecond)
    const i1 = Math.max(i0 + 1, Math.floor(((c.trimStartFrame + f1 * c.speed) / fps) * w.samplesPerSecond))
    let peak = 0
    for (let i = Math.max(0, i0); i < Math.min(w.amp.length, i1); i++) if (w.amp[i] > peak) peak = w.amp[i]
    const frame = c.startFrame + f0
    const gain = rawVolumeAt(c, frame) * fadeMultiplier(c, frame)
    const amp = Math.min(1, Math.max(0, peak + linearToDb(gain) / 50))
    const h = Math.max(1, amp * maxH)
    ctx.fillStyle = color
    ctx.fillRect(x, body.y + body.h - 1 - h, 1, h)
  }
}
