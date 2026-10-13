/** Host-side colour math for effects (spec 04 §8.6, §8.10–§8.12). Pure. */

type M3 = number[][]
type V3 = [number, number, number]

const mul = (a: M3, b: M3): M3 => a.map((row) => b[0].map((_, j) => row[0] * b[0][j] + row[1] * b[1][j] + row[2] * b[2][j]))
const mulV = (a: M3, v: number[]): V3 => [a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2], a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2], a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2]]

function inv(m: M3): M3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ]
}

/** Kim et al. 2002 Planckian locus, valid 1667–25000 K. */
export function cctToXy(T: number): [number, number] {
  T = Math.min(25000, Math.max(1667, T))
  const t = 1000 / T
  const t2 = t * t
  const t3 = t2 * t
  const x = T <= 4000 ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.17991 : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.24039
  const x2 = x * x
  const x3 = x2 * x
  const y =
    T <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483
  return [x, y]
}

const xyToUv = ([x, y]: number[]): [number, number] => {
  const d = -2 * x + 12 * y + 3
  return [(4 * x) / d, (6 * y) / d]
}
const uvToXy = ([u, v]: number[]): [number, number] => {
  const d = 2 * u - 8 * v + 4
  return [(3 * u) / d, (2 * v) / d]
}

// [APPROX] calibrate against macOS (§13): ±100 tint ≈ ±0.033 Δuv.
const TINT_UV_PER_UNIT = 1 / 3000

function whiteXYZ(T: number, tint: number): V3 {
  const uv = xyToUv(cctToXy(T))
  const uv2 = xyToUv(cctToXy(T + 50))
  let nx = -(uv2[1] - uv[1])
  let ny = uv2[0] - uv[0]
  const len = Math.hypot(nx, ny)
  nx /= len
  ny /= len
  if (ny < 0) {
    nx = -nx
    ny = -ny
  }
  const [x, y] = uvToXy([uv[0] + tint * TINT_UV_PER_UNIT * nx, uv[1] + tint * TINT_UV_PER_UNIT * ny])
  return [x / y, 1, (1 - x - y) / y]
}

const BRADFORD: M3 = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
]
const RGB2XYZ: M3 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
]

/** [APPROX] CITemperatureAndTint as a Bradford adaptation from (T, tint) to (6500, 0); column-major for GLSL. */
export function temperatureMatrix(T: number, tint: number): Float32Array {
  const src = mulV(BRADFORD, whiteXYZ(T, tint))
  const dst = mulV(BRADFORD, whiteXYZ(6500, 0))
  const D: M3 = [
    [dst[0] / src[0], 0, 0],
    [0, dst[1] / src[1], 0],
    [0, 0, dst[2] / src[2]],
  ]
  const m = mul(inv(RGB2XYZ), mul(inv(BRADFORD), mul(D, mul(BRADFORD, RGB2XYZ))))
  return new Float32Array([m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2]])
}

const CHROMA_LIFT = 0.2
const CHROMA_GAIN = 0.35
const CHROMA_GAMMA = 0.35

function hueRGB(h: number): V3 {
  const x = (h - Math.floor(h)) * 6
  const f = x - Math.floor(x)
  switch (Math.trunc(x) % 6) {
    case 0:
      return [1, f, 0]
    case 1:
      return [1 - f, 1, 0]
    case 2:
      return [0, 1, f]
    case 3:
      return [0, 1 - f, 1]
    case 4:
      return [f, 0, 1]
    default:
      return [1, 0, 1 - f]
  }
}

function chromaOffset(x: number, y: number): V3 {
  const r = Math.min(1, Math.hypot(x, y))
  if (r <= 1e-6) return [0, 0, 0]
  const [cr, cg, cb] = hueRGB(Math.atan2(y, x) / (2 * Math.PI))
  const m = (cr + cg + cb) / 3
  return [(cr - m) * r, (cg - m) * r, (cb - m) * r]
}

export interface WheelCoefficients {
  lift: V3
  gain: V3
  invGamma: V3
}

export function wheelCoefficients(v: Record<string, number>): WheelCoefficients {
  const L = chromaOffset(v.lift_x, v.lift_y)
  const G = chromaOffset(v.gamma_x, v.gamma_y)
  const K = chromaOffset(v.gain_x, v.gain_y)
  return {
    lift: L.map((c) => v.lift_m + c * CHROMA_LIFT) as V3,
    gain: K.map((c) => v.gain_m * (1 + c * CHROMA_GAIN)) as V3,
    invGamma: G.map((c) => 1 / Math.max(0.01, v.gamma_m * (1 + c * CHROMA_GAMMA))) as V3,
  }
}

export const wheelsNeutral = (v: Record<string, number>): boolean =>
  v.lift_x === 0 && v.lift_y === 0 && v.lift_m === 0 && v.gamma_x === 0 && v.gamma_y === 0 && v.gamma_m === 1 && v.gain_x === 0 && v.gain_y === 0 && v.gain_m === 1

export interface CurvePoint {
  x: number
  y: number
}

/** Synthesized Codable: every curve key is required (missing → the whole payload is ignored). */
function points(v: unknown): CurvePoint[] | null {
  if (!Array.isArray(v)) return null
  const out: CurvePoint[] = []
  for (const p of v) {
    if (!p || typeof p !== 'object') return null
    const { x, y } = p as Record<string, unknown>
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
    out.push({ x, y })
  }
  return out
}

export interface GradeCurve {
  master: CurvePoint[]
  red: CurvePoint[]
  green: CurvePoint[]
  blue: CurvePoint[]
}

export function parseGradeCurve(json: string): GradeCurve | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    if (!o || typeof o !== 'object') return null
    const master = points(o.master)
    const red = points(o.red)
    const green = points(o.green)
    const blue = points(o.blue)
    if (!master || !red || !green || !blue) return null
    return { master, red, green, blue }
  } catch {
    return null
  }
}

const isIdentityCurve = (p: CurvePoint[]) => p.length === 0 || (p.length === 2 && p[0].x === 0 && p[0].y === 0 && p[1].x === 1 && p[1].y === 1)
export const gradeCurveIsIdentity = (c: GradeCurve): boolean => [c.master, c.red, c.green, c.blue].every(isIdentityCurve)

export function evalCurve(pts: CurvePoint[], x: number): number {
  const p = (pts.length ? pts : [{ x: 0, y: 0 }, { x: 1, y: 1 }]).slice().sort((a, b) => a.x - b.x)
  if (x <= p[0].x) return p[0].y
  if (x >= p[p.length - 1].x) return p[p.length - 1].y
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i].x) {
      const a = p[i - 1]
      const b = p[i]
      const t = b.x - a.x === 0 ? 0 : (x - a.x) / (b.x - a.x)
      return a.y + (b.y - a.y) * t
    }
  }
  return x
}

/** Two 256×1 RGBA tables: per-channel curves and the master (luma) curve. */
export function gradeCurveTables(c: GradeCurve): { channels: Float32Array; master: Float32Array } {
  const channels = new Float32Array(256 * 4)
  const master = new Float32Array(256 * 4)
  const cl = (v: number) => Math.min(1, Math.max(0, v))
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    channels.set([cl(evalCurve(c.red, t)), cl(evalCurve(c.green, t)), cl(evalCurve(c.blue, t)), 1], i * 4)
    const m = cl(evalCurve(c.master, t))
    master.set([m, m, m, 1], i * 4)
  }
  return { channels, master }
}

export interface HueCurves {
  hueVsHue: CurvePoint[]
  hueVsSat: CurvePoint[]
  hueVsLum: CurvePoint[]
}

export function parseHueCurves(json: string): HueCurves | null {
  try {
    const o = JSON.parse(json) as Record<string, unknown>
    if (!o || typeof o !== 'object') return null
    const hueVsHue = points(o.hueVsHue)
    const hueVsSat = points(o.hueVsSat)
    const hueVsLum = points(o.hueVsLum)
    if (!hueVsHue || !hueVsSat || !hueVsLum) return null
    return { hueVsHue, hueVsSat, hueVsLum }
  } catch {
    return null
  }
}

export const hueCurvesIsIdentity = (c: HueCurves): boolean => [c.hueVsHue, c.hueVsSat, c.hueVsLum].every((p) => p.every((q) => Math.abs(q.y - 0.5) < 1e-4))

export function evalHue(pts: CurvePoint[], x: number): number {
  const p = (pts.length ? pts : [0, 1, 2, 3, 4, 5].map((i) => ({ x: i / 6, y: 0.5 }))).slice().sort((a, b) => a.x - b.x)
  const lerp = (a: CurvePoint, b: CurvePoint) => {
    const t = b.x - a.x === 0 ? 0 : (x - a.x) / (b.x - a.x)
    return a.y + (b.y - a.y) * t
  }
  const first = p[0]
  const last = p[p.length - 1]
  if (x < first.x) return lerp({ x: last.x - 1, y: last.y }, first)
  for (let i = 1; i < p.length; i++) if (x <= p[i].x) return lerp(p[i - 1], p[i])
  return lerp(last, { x: first.x + 1, y: first.y })
}

/** 256×1 RGBA table: Δhue (±30°), saturation scale delta, Δvalue (±0.5). */
export function hueCurveTable(c: HueCurves): Float32Array {
  const lut = new Float32Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const hue = (i + 0.5) / 256
    lut.set([(evalHue(c.hueVsHue, hue) - 0.5) * 2 * (1 / 12), (evalHue(c.hueVsSat, hue) - 0.5) * 2, (evalHue(c.hueVsLum, hue) - 0.5) * 2 * 0.5, 1], i * 4)
  }
  return lut
}
