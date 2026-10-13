import { swiftRound } from '../keyframes'
import { newId, type Clip, type Effect } from '../model'

export interface CurvePoint {
  x: number
  y: number
}

export interface GradeCurve {
  master: CurvePoint[]
  red: CurvePoint[]
  green: CurvePoint[]
  blue: CurvePoint[]
}

export interface HueCurves {
  hueVsHue: CurvePoint[]
  hueVsSat: CurvePoint[]
  hueVsLum: CurvePoint[]
}

export const GRADE_KNOBS = [
  'exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows', 'blacks', 'whites',
  'shadowsHue', 'shadowsAmount', 'shadowsLum', 'midsHue', 'midsAmount', 'midsGamma', 'highsHue', 'highsAmount', 'highsGain',
] as const
export type GradeKnob = (typeof GRADE_KNOBS)[number]

export type GradeState = Partial<Record<GradeKnob, number>> & {
  curve?: GradeCurve
  hueCurves?: HueCurves
  lutPath?: string
  lutIntensity?: number
}

export interface HueTarget {
  targetHue: number
  hueShift?: number
  satScale?: number
  lumShift?: number
}

export type GradeInput = Partial<Record<GradeKnob, number>> & {
  masterCurve?: number[][]
  redCurve?: number[][]
  greenCurve?: number[][]
  blueCurve?: number[][]
  hueTargets?: HueTarget[]
  lutStrength?: number
}

const NEUTRAL_Y = 0.5
const IDENTITY_POINTS: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
]

const r3 = (v: number) => swiftRound(v * 1000) / 1000
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const samePoints = (a: CurvePoint[], b: CurvePoint[]) => a.length === b.length && a.every((p, i) => p.x === b[i].x && p.y === b[i].y)
const curveIsIdentity = (c: GradeCurve) => [c.master, c.red, c.green, c.blue].every((p) => p.length === 0 || samePoints(p, IDENTITY_POINTS))
const hueNeutral = (pts: CurvePoint[]) => pts.length === 0 || pts.every((p) => Math.abs(p.y - NEUTRAL_Y) < 1e-4)
const hueIsIdentity = (h: HueCurves) => [h.hueVsHue, h.hueVsSat, h.hueVsLum].every(hueNeutral)

function parsePoints(v: unknown): CurvePoint[] | null {
  if (!Array.isArray(v)) return null
  const out: CurvePoint[] = []
  for (const p of v) {
    if (typeof p !== 'object' || p === null || typeof (p as CurvePoint).x !== 'number' || typeof (p as CurvePoint).y !== 'number') return null
    out.push({ x: (p as CurvePoint).x, y: (p as CurvePoint).y })
  }
  return out
}

function decodeCurve(json?: string): GradeCurve | undefined {
  try {
    const o = JSON.parse(json ?? '')
    const [master, red, green, blue] = [o?.master, o?.red, o?.green, o?.blue].map(parsePoints)
    return master && red && green && blue ? { master, red, green, blue } : undefined
  } catch {
    return undefined
  }
}

function decodeHueCurves(json?: string): HueCurves | undefined {
  try {
    const o = JSON.parse(json ?? '')
    const [hueVsHue, hueVsSat, hueVsLum] = [o?.hueVsHue, o?.hueVsSat, o?.hueVsLum].map(parsePoints)
    return hueVsHue && hueVsSat && hueVsLum ? { hueVsHue, hueVsSat, hueVsLum } : undefined
  } catch {
    return undefined
  }
}

function hueAmount(x: number, y: number): [number | undefined, number | undefined] {
  const amount = Math.sqrt(x * x + y * y)
  if (!(amount > 1e-6)) return [undefined, undefined]
  let deg = (Math.atan2(y, x) * 180) / Math.PI
  if (deg < 0) deg += 360
  return [deg, amount]
}

/** Rebuilds the knob state from a clip's color.* effects. */
export function gradeFromEffects(effects: Effect[] | undefined): GradeState {
  const s: GradeState = {}
  for (const e of effects ?? []) {
    const v = (k: string) => e.params[k]?.value
    switch (e.type) {
      case 'color.exposure':
        s.exposure = v('ev')
        break
      case 'color.temperature':
        s.temperature = v('temperature')
        s.tint = v('tint')
        break
      case 'color.contrast':
        s.contrast = v('amount')
        break
      case 'color.highlightsShadows':
        s.highlights = v('highlights')
        s.shadows = v('shadows')
        break
      case 'color.blacksWhites':
        s.blacks = v('blacks')
        s.whites = v('whites')
        break
      case 'color.vibrance':
        s.vibrance = v('amount')
        break
      case 'color.saturation':
        s.saturation = v('amount')
        break
      case 'color.curves':
        s.curve = decodeCurve(e.params.curve?.string)
        break
      case 'color.hueCurves':
        s.hueCurves = decodeHueCurves(e.params.curves?.string)
        break
      case 'color.lut':
        s.lutPath = e.params.path?.string
        s.lutIntensity = v('intensity')
        break
      case 'color.wheels':
        ;[s.shadowsHue, s.shadowsAmount] = hueAmount(v('lift_x') ?? 0, v('lift_y') ?? 0)
        s.shadowsLum = v('lift_m')
        ;[s.midsHue, s.midsAmount] = hueAmount(v('gamma_x') ?? 0, v('gamma_y') ?? 0)
        s.midsGamma = v('gamma_m')
        ;[s.highsHue, s.highsAmount] = hueAmount(v('gain_x') ?? 0, v('gain_y') ?? 0)
        s.highsGain = v('gain_m')
        break
    }
  }
  for (const k of Object.keys(s) as (keyof GradeState)[]) if (s[k] === undefined) delete s[k]
  return s
}

const rowsToPoints = (rows: unknown): CurvePoint[] =>
  Array.isArray(rows)
    ? rows.flatMap((r) => (Array.isArray(r) && r.length >= 2 && typeof r[0] === 'number' && typeof r[1] === 'number' ? [{ x: r[0], y: r[1] }] : []))
    : []

/** Parses a pasted `color` object (the shape `colorObject` emits). */
export function gradeFromColorObject(d: Record<string, unknown>): GradeState {
  const s: GradeState = {}
  for (const k of GRADE_KNOBS) if (typeof d[k] === 'number') s[k] = d[k] as number
  const [master, red, green, blue] = ['masterCurve', 'redCurve', 'greenCurve', 'blueCurve'].map((k) => rowsToPoints(d[k]))
  if (master.length || red.length || green.length || blue.length) s.curve = { master, red, green, blue }
  const raw = d.hueCurvesRaw
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    const hc = { hueVsHue: rowsToPoints(r.hueVsHue), hueVsSat: rowsToPoints(r.hueVsSat), hueVsLum: rowsToPoints(r.hueVsLum) }
    if (!hueIsIdentity(hc)) s.hueCurves = hc
  }
  const lut = d.lut
  if (lut && typeof lut === 'object' && !Array.isArray(lut)) {
    const l = lut as Record<string, unknown>
    if (typeof l.path === 'string') s.lutPath = l.path
    if (typeof l.strength === 'number') s.lutIntensity = l.strength
  }
  return s
}

export function compileHueCurves(targets: HueTarget[]): HueCurves {
  const band = 0.06
  const wrap01 = (v: number) => {
    const m = v % 1
    return m < 0 ? m + 1 : m
  }
  const bump = (pts: CurvePoint[], center: number, y: number) => {
    pts.push({ x: wrap01(center), y }, { x: wrap01(center - band), y: NEUTRAL_Y }, { x: wrap01(center + band), y: NEUTRAL_Y })
  }
  const finalize = (pts: CurvePoint[]): CurvePoint[] => {
    const byX = new Map<number, CurvePoint>()
    for (const p of [...pts].sort((a, b) => Math.abs(a.y - NEUTRAL_Y) - Math.abs(b.y - NEUTRAL_Y))) byX.set(r3(p.x), { x: r3(p.x), y: r3(p.y) })
    return [...byX.values()].sort((a, b) => a.x - b.x)
  }
  const hue: CurvePoint[] = []
  const sat: CurvePoint[] = []
  const lum: CurvePoint[] = []
  for (const t of targets) {
    const center = wrap01(t.targetHue / 360)
    if (t.hueShift !== undefined && Math.abs(t.hueShift) > 1e-6) bump(hue, center, NEUTRAL_Y + clamp(t.hueShift, -30, 30) / 60)
    if (t.satScale !== undefined && Math.abs(t.satScale - 1) > 1e-6) bump(sat, center, NEUTRAL_Y + (clamp(t.satScale, 0, 2) - 1) / 2)
    if (t.lumShift !== undefined && Math.abs(t.lumShift) > 1e-6) bump(lum, center, NEUTRAL_Y + clamp(t.lumShift, -0.5, 0.5))
  }
  return { hueVsHue: finalize(hue), hueVsSat: finalize(sat), hueVsLum: finalize(lum) }
}

/** Overlays agent knobs on a grade state (merge semantics of apply_color). */
export function mergeGradeInput(state: GradeState, input: GradeInput, lutDestPath?: string): GradeState {
  const s: GradeState = { ...state }
  for (const k of GRADE_KNOBS) if (input[k] !== undefined) s[k] = input[k]
  const pts = (rows?: number[][]) => rows?.flatMap((r) => (r.length >= 2 ? [{ x: r3(r[0]), y: r3(r[1]) }] : []))
  if (input.masterCurve || input.redCurve || input.greenCurve || input.blueCurve) {
    const c: GradeCurve = s.curve ? { ...s.curve } : { master: [], red: [], green: [], blue: [] }
    c.master = pts(input.masterCurve) ?? c.master
    c.red = pts(input.redCurve) ?? c.red
    c.green = pts(input.greenCurve) ?? c.green
    c.blue = pts(input.blueCurve) ?? c.blue
    s.curve = c
  }
  if (input.hueTargets?.length) s.hueCurves = compileHueCurves(input.hueTargets)
  if (lutDestPath) {
    s.lutPath = lutDestPath
    s.lutIntensity = input.lutStrength !== undefined ? r3(clamp(input.lutStrength, 0, 1)) : 1
  } else if (input.lutStrength !== undefined) s.lutIntensity = r3(clamp(input.lutStrength, 0, 1))
  return s
}

const effect = (type: string, values: Record<string, number>): Effect => ({
  id: newId(),
  type,
  enabled: true,
  params: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { value: r3(v) }])),
})

function xy(hue?: number, amount?: number): [number, number] {
  const a = ((hue ?? 0) * Math.PI) / 180
  const r = amount ?? 0
  return [r * Math.cos(a), r * Math.sin(a)]
}

const has = (...v: (number | undefined)[]) => v.some((x) => x !== undefined)

/** Emits the color.* stack in canonical order, each effect only when relevant. */
export function buildColorStack(s: GradeState): Effect[] {
  const stack: Effect[] = []
  if (s.exposure !== undefined) stack.push(effect('color.exposure', { ev: s.exposure }))
  if (s.contrast !== undefined) stack.push(effect('color.contrast', { amount: s.contrast }))
  if (has(s.highlights, s.shadows)) stack.push(effect('color.highlightsShadows', { highlights: s.highlights ?? 0, shadows: s.shadows ?? 0 }))
  if (has(s.blacks, s.whites)) stack.push(effect('color.blacksWhites', { blacks: s.blacks ?? 0, whites: s.whites ?? 0 }))
  if (has(s.temperature, s.tint)) stack.push(effect('color.temperature', { temperature: s.temperature ?? 6500, tint: s.tint ?? 0 }))
  if (s.vibrance !== undefined) stack.push(effect('color.vibrance', { amount: s.vibrance }))
  if (s.saturation !== undefined) stack.push(effect('color.saturation', { amount: s.saturation }))
  if (has(s.shadowsHue, s.shadowsAmount, s.shadowsLum, s.midsHue, s.midsAmount, s.midsGamma, s.highsHue, s.highsAmount, s.highsGain)) {
    const [lx, ly] = xy(s.shadowsHue, s.shadowsAmount)
    const [gx, gy] = xy(s.midsHue, s.midsAmount)
    const [hx, hy] = xy(s.highsHue, s.highsAmount)
    stack.push(
      effect('color.wheels', {
        lift_x: lx,
        lift_y: ly,
        lift_m: s.shadowsLum ?? 0,
        gamma_x: gx,
        gamma_y: gy,
        gamma_m: s.midsGamma ?? 1,
        gain_x: hx,
        gain_y: hy,
        gain_m: s.highsGain ?? 1,
      }),
    )
  }
  if (s.curve && !curveIsIdentity(s.curve)) {
    const { master, red, green, blue } = s.curve
    stack.push({ id: newId(), type: 'color.curves', enabled: true, params: { curve: { string: JSON.stringify({ master, red, green, blue }) } } })
  }
  if (s.hueCurves && !hueIsIdentity(s.hueCurves)) {
    const { hueVsHue, hueVsSat, hueVsLum } = s.hueCurves
    stack.push({ id: newId(), type: 'color.hueCurves', enabled: true, params: { curves: { string: JSON.stringify({ hueVsHue, hueVsSat, hueVsLum }) } } })
  }
  if (s.lutPath !== undefined) {
    stack.push({ id: newId(), type: 'color.lut', enabled: true, params: { path: { string: s.lutPath }, intensity: { value: r3(s.lutIntensity ?? 1) } } })
  }
  return stack
}

const isColor = (e: Effect) => e.type.startsWith('color.')

/** Replaces a clip's color.* effects with a pasted stack; non-color effects are untouched. */
export function pasteColorStack(c: Clip, stack: Effect[]): void {
  const next = [...(c.effects ?? []).filter((e) => !isColor(e)), ...stack]
  if (next.length) c.effects = next
  else delete c.effects
}

/** Merges knobs into the clip's grade (or neutral when `reset`), keeping disabled color effect types disabled. */
export function mergeColorGrade(c: Clip, input: GradeInput, reset: boolean, lutDestPath?: string): void {
  const disabled = reset ? new Set<string>() : new Set((c.effects ?? []).filter((e) => isColor(e) && !e.enabled).map((e) => e.type))
  const state = mergeGradeInput(gradeFromEffects(reset ? undefined : c.effects), input, lutDestPath)
  pasteColorStack(
    c,
    buildColorStack(state).map((e) => (disabled.has(e.type) ? { ...e, enabled: false } : e)),
  )
}

const KNOB_NEUTRAL: Partial<Record<GradeKnob, number>> = { shadowsLum: 0, midsGamma: 1, highsGain: 1, shadowsAmount: 0, midsAmount: 0, highsAmount: 0 }

/** The clip's grade in apply_color vocabulary; null when it has no color effects. */
export function colorObject(effects: Effect[] | undefined): Record<string, unknown> | null {
  if (!effects?.some(isColor)) return null
  const s = gradeFromEffects(effects)
  const out: Record<string, unknown> = {}
  for (const k of GRADE_KNOBS) {
    const v = s[k]
    if (v !== undefined && v !== KNOB_NEUTRAL[k]) out[k] = v
  }
  for (const zone of ['shadows', 'mids', 'highs']) if (out[`${zone}Amount`] === undefined) delete out[`${zone}Hue`]
  const rows = (p: CurvePoint[]) => (p.length ? p.map((q) => [q.x, q.y]) : undefined)
  if (s.curve) {
    const entries: [string, CurvePoint[]][] = [['masterCurve', s.curve.master], ['redCurve', s.curve.red], ['greenCurve', s.curve.green], ['blueCurve', s.curve.blue]]
    for (const [k, p] of entries) if (rows(p)) out[k] = rows(p)
  }
  if (s.hueCurves) {
    const raw: Record<string, unknown> = {}
    const entries: [string, CurvePoint[]][] = [['hueVsHue', s.hueCurves.hueVsHue], ['hueVsSat', s.hueCurves.hueVsSat], ['hueVsLum', s.hueCurves.hueVsLum]]
    for (const [k, p] of entries) if (rows(p)) raw[k] = rows(p)
    if (Object.keys(raw).length) out.hueCurvesRaw = raw
  }
  if (s.lutPath !== undefined) out.lut = { path: s.lutPath, strength: s.lutIntensity ?? 1 }
  return Object.keys(out).length ? out : null
}
